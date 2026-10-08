import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { businesses, employees } from "../drizzle/schema";
import {
  ledgerAccounts, ledgerAccountBusinesses, ledgerEntries, ledgerPeriodEvents, ledgerPeriods, ledgerTenantFlags, ledgerTransactions,
  type LedgerAccount, type LedgerTransaction,
} from "../drizzle/ledgerV3.schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import {
  LEDGER_KINDS, LedgerError, applyToBalance, assertActorShape, assertCurrency, assertEffectiveDate, canonicalPayloadHash, normalizeDescription, postingPeriodOf,
  reconcileAccount, validateEntries, type LedgerActor, type LedgerEntryInput, type LedgerKind, type LedgerReconLine, type ValidatedEntry,
} from "../shared/ledgerV3Core";
import { getDb, withDeadlockRetry } from "./db";
import { isOwnerRole } from "./permissions";

/**
 * Accounting Ledger V3 — خدمة داخلية فقط (لا Router عام في هذه المرحلة) خلف Feature Flag لكل tenant.
 *
 * نقطة ترحيل واحدة `postLedgerTransaction` داخل `db.transaction` واحدة مع إعادة المحاولة عند الـdeadlock:
 *   1) العلم (FOR SHARE) → 2) النشاط والفاعل fail-closed → 3) الفترة من التاريخ (إنشاء open عند الغياب
 *   بأمان من السباق) ثم **FOR SHARE** ورفض locked (الترحيلات في الشهر نفسه تتوازى؛ القفل/الفتح يأخذان
 *   FOR UPDATE فينتظران الحركات المفتوحة ثم يمنعان الجديدة) → 4) **حجز idempotencyKey بالإدراج نفسه** (القيد الفريد
 *   هو القفل؛ Duplicate → قراءة مقفولة للموجود → replay أو CONFLICT بالـpayloadHash المحفوظ) →
 *   5) قفل الحسابات FOR UPDATE بترتيب id → 6) tenant/نشطة/عملة/صلاحية النشاط → 7) الأرصدة حسب
 *   normalSide ومنع السالب → 8) إدراج القيود وتحديث currentBalance. أي فشل = rollback كامل، فلا توجد
 *   حركة بلا قيود أبدًا.
 *
 * ممنوع من العميل: tenantId (من السياق الموثوق فقط)، payloadHash (يُحسب هنا)، postingPeriod (من
 * التاريخ)، balanceAfter/currentBalance. الجداول غير موجودة → خطأ واضح، ولا سقوط على V2.
 */
export type LedgerDb = NonNullable<Awaited<ReturnType<typeof getDb>>>;

export type PostLedgerTransactionInput = {
  tenantId: number;
  sourceBusinessId?: number | null;
  kind: Exclude<LedgerKind, "reversal" | "opening_balance">;
  idempotencyKey: string;
  effectiveDate: string; // YYYY-MM-DD
  currency: string;
  actor: LedgerActor;
  entries: LedgerEntryInput[];
  description: string;
  sourceType?: string | null;
  sourceReference?: string | null;
};
export type PostResult = { transactionId: number; replay: boolean; postingPeriod: string; entries: { accountId: number; side: "debit" | "credit"; amount: string; balanceAfter: string }[] };

type Tx = any;
const isMysqlError = (err: unknown, code: string, needle?: string): boolean => {
  for (let e: any = err, depth = 0; e && depth < 6; e = e.cause, depth++) {
    if (e.code === code && (!needle || String(e.sqlMessage ?? e.message ?? "").includes(needle))) return true;
  }
  return false;
};
const isNoSuchTable = (err: unknown) => isMysqlError(err, "ER_NO_SUCH_TABLE");
const insertId = (r: any): number => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? 0);

async function resolveDb(db?: LedgerDb): Promise<LedgerDb> {
  const d = db ?? (await getDb());
  if (!d) throw new Error("قاعدة البيانات غير متاحة");
  return d;
}

/** تشغيل داخل transaction مع إعادة المحاولة عند الـdeadlock وترجمة غياب الجداول إلى خطأ واضح. */
async function ledgerTransaction<T>(db: LedgerDb, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withDeadlockRetry(() => db.transaction(fn));
  } catch (err) {
    if (isNoSuchTable(err)) throw new LedgerError("unavailable");
    throw err;
  }
}

async function assertEnabled(tx: Tx, tenantId: number): Promise<void> {
  const [flag] = await tx.select().from(ledgerTenantFlags).where(eq(ledgerTenantFlags.tenantId, tenantId)).for("share");
  if (!flag || flag.ledgerV3Enabled !== 1) throw new LedgerError("disabled");
}

async function assertBusinessInTenant(tx: Tx, tenantId: number, businessId: number): Promise<void> {
  const [row] = await tx.select({ id: businesses.id }).from(businesses)
    .where(and(eq(businesses.id, businessId), eq(businesses.tenantId, tenantId))).limit(1).for("share");
  if (!row) throw new LedgerError("business", `#${businessId}`);
}

/** الفاعل fail-closed: موظف فعّال من نفس الشركة، أو نظام/webhook بلا موظف. يرجع المعرّف المخزَّن. */
async function resolveActor(tx: Tx, tenantId: number, actor: LedgerActor): Promise<{ actorType: LedgerActor["type"]; actorEmployeeId: number | null; role: string | null }> {
  assertActorShape(actor);
  if (actor.type !== "employee") return { actorType: actor.type, actorEmployeeId: null, role: null };
  const [emp] = await tx.select({ id: employees.id, role: employees.role, isActive: employees.isActive, tenantId: employees.tenantId })
    .from(employees).where(and(eq(employees.id, actor.employeeId), eq(employees.tenantId, tenantId))).limit(1).for("share");
  if (!emp || !emp.isActive) throw new LedgerError("actorEmployee");
  return { actorType: "employee", actorEmployeeId: emp.id, role: emp.role };
}

/**
 * الفترة بتاريخ الحركة: تُنشأ open عند الغياب (السباق: Duplicate → إعادة القراءة)، ثم تُقرأ **FOR SHARE**
 * وتُرفض لو locked. القفل المشترك يسمح بتوازي الترحيلات في الشهر الواحد، ويُجبر `lock/reopen` (FOR UPDATE)
 * على انتظار كل ترحيل مفتوح قبل تغيير الحالة — فلا ترحيل بعد القفل.
 */
async function lockPeriodForPosting(tx: Tx, tenantId: number, period: string): Promise<{ id: number }> {
  const read = async () => (await tx.select().from(ledgerPeriods).where(and(eq(ledgerPeriods.tenantId, tenantId), eq(ledgerPeriods.period, period))).limit(1).for("share"))[0];
  let row = await read();
  if (!row) {
    try { await tx.insert(ledgerPeriods).values({ tenantId, period, status: "open" }); }
    catch (err) { if (!isMysqlError(err, "ER_DUP_ENTRY")) throw err; }
    row = await read();
    if (!row) throw new LedgerError("periodNotFound", period);
  }
  if (row.status === "locked") throw new LedgerError("periodLocked", period);
  return { id: row.id };
}

type InternalPost = {
  tenantId: number; sourceBusinessId: number | null; kind: LedgerKind; idempotencyKey: string; effectiveDate: string; currency: string;
  actor: LedgerActor; entries: LedgerEntryInput[]; description: string; sourceType: string | null; sourceReference: string | null;
  reversalOfTransactionId: number | null;
};

async function loadResult(tx: Tx, transaction: LedgerTransaction, replay: boolean): Promise<PostResult> {
  const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, transaction.id)).orderBy(asc(ledgerEntries.id));
  return {
    transactionId: transaction.id, replay, postingPeriod: transaction.postingPeriod,
    entries: rows.map((e: any) => ({ accountId: e.accountId, side: e.side, amount: e.amount, balanceAfter: e.balanceAfter })),
  };
}

async function postInternal(tx: Tx, input: InternalPost): Promise<PostResult> {
  if (!(LEDGER_KINDS as readonly string[]).includes(input.kind)) throw new LedgerError("kind", String(input.kind));
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length < 8 || input.idempotencyKey.length > 191) throw new LedgerError("conflict", "idempotencyKey");
  assertCurrency(input.currency);
  const postingPeriod = postingPeriodOf(input.effectiveDate);
  const entries: ValidatedEntry[] = validateEntries(input.entries, input.sourceBusinessId ?? null);

  // 1) العلم  2) النشاط/الفاعل  3) الفترة
  await assertEnabled(tx, input.tenantId);
  if (input.sourceBusinessId != null) await assertBusinessInTenant(tx, input.tenantId, input.sourceBusinessId);
  for (const b of new Set(entries.map(e => e.businessId).filter((x): x is number => x != null)))
    if (b !== input.sourceBusinessId) await assertBusinessInTenant(tx, input.tenantId, b);
  const actor = await resolveActor(tx, input.tenantId, input.actor);
  await lockPeriodForPosting(tx, input.tenantId, postingPeriod);
  // الهاش القانوني بعد حلّ الفاعل (يشمل الوصف المطبَّع ونوع الفاعل ومعرّفه)
  const payloadHash = canonicalPayloadHash({
    kind: input.kind, sourceBusinessId: input.sourceBusinessId, effectiveDate: input.effectiveDate, currency: input.currency,
    entries, reversalOfTransactionId: input.reversalOfTransactionId, sourceType: input.sourceType, sourceReference: input.sourceReference,
    description: input.description, actorType: actor.actorType, actorEmployeeId: actor.actorEmployeeId,
  });

  // 4) حجز المفتاح بالإدراج — القيد الفريد هو القفل
  let transactionId: number;
  try {
    const r = await tx.insert(ledgerTransactions).values({
      tenantId: input.tenantId, sourceBusinessId: input.sourceBusinessId, kind: input.kind, idempotencyKey: input.idempotencyKey, payloadHash,
      currency: input.currency, effectiveDate: input.effectiveDate, postingPeriod, reversalOfTransactionId: input.reversalOfTransactionId,
      sourceType: input.sourceType, sourceReference: input.sourceReference, description: normalizeDescription(input.description),
      actorType: actor.actorType, actorEmployeeId: actor.actorEmployeeId,
    });
    transactionId = insertId(r);
  } catch (err) {
    if (isMysqlError(err, "ER_DUP_ENTRY", "ledger_transactions_tenant_idem_unique")) {
      // قراءة **مقفولة** (ترى آخر التزام لا لقطة قديمة) للحركة الموجودة بنفس المفتاح
      const [existing] = await tx.select().from(ledgerTransactions)
        .where(and(eq(ledgerTransactions.tenantId, input.tenantId), eq(ledgerTransactions.idempotencyKey, input.idempotencyKey))).limit(1).for("share");
      if (!existing) throw err;
      if (existing.payloadHash !== payloadHash) throw new LedgerError("conflict");
      return loadResult(tx, existing, true);
    }
    if (isMysqlError(err, "ER_DUP_ENTRY", "ledger_transactions_reversal_once_unique")) throw new LedgerError("reversedAlready");
    throw err;
  }
  if (!transactionId) throw new Error("تعذر إدراج الحركة");

  // 5) قفل الحسابات بترتيب id ثابت  6) الإثباتات
  const accountIds = [...new Set(entries.map(e => e.accountId))].sort((a, b) => a - b);
  const accounts: LedgerAccount[] = await tx.select().from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.tenantId, input.tenantId), inArray(ledgerAccounts.id, accountIds))).orderBy(asc(ledgerAccounts.id)).for("update");
  if (accounts.length !== accountIds.length) throw new LedgerError("account");
  const byId = new Map(accounts.map(a => [a.id, a]));
  for (const a of accounts) {
    if (a.isActive !== 1) throw new LedgerError("accountInactive", a.code);
    if (a.currency !== input.currency) throw new LedgerError("currency", `${a.code}:${a.currency}`);
  }
  const pairs = [...new Set(entries.filter(e => e.businessId != null).map(e => `${e.accountId}:${e.businessId}`))];
  if (pairs.length > 0) {
    const grants = await tx.select().from(ledgerAccountBusinesses).where(and(
      eq(ledgerAccountBusinesses.tenantId, input.tenantId), inArray(ledgerAccountBusinesses.accountId, accountIds),
    ));
    const granted = new Set(grants.filter((g: any) => g.canPost === 1).map((g: any) => `${g.accountId}:${g.businessId}`));
    for (const p of pairs) if (!granted.has(p)) throw new LedgerError("grant", `حساب ${byId.get(Number(p.split(":")[0]))?.code} / نشاط ${p.split(":")[1]}`);
  }

  // 7) الأرصدة  8) القيود + currentBalance
  const running = new Map<number, bigint>(accounts.map(a => [a.id, toMinorUnits(a.currentBalance)]));
  const result: PostResult["entries"] = [];
  for (const e of entries) {
    const a = byId.get(e.accountId)!;
    const next = applyToBalance(running.get(a.id)!, a.normalSide, e.side, e.amountMinor);
    if (next < 0n && a.allowNegative !== 1) throw new LedgerError("negative", a.code);
    running.set(a.id, next);
    await tx.insert(ledgerEntries).values({
      tenantId: input.tenantId, transactionId, accountId: a.id, businessId: e.businessId, side: e.side, amount: e.amount, balanceAfter: fromMinorUnits(next),
    });
    result.push({ accountId: a.id, side: e.side, amount: e.amount, balanceAfter: fromMinorUnits(next) });
  }
  for (const [accountId, balance] of running)
    await tx.update(ledgerAccounts).set({ currentBalance: fromMinorUnits(balance) }).where(eq(ledgerAccounts.id, accountId));
  return { transactionId, replay: false, postingPeriod, entries: result };
}

export async function postLedgerTransaction(input: PostLedgerTransactionInput, db?: LedgerDb): Promise<PostResult> {
  if (input.kind === ("reversal" as any) || input.kind === ("opening_balance" as any)) throw new LedgerError("kind", input.kind);
  const d = await resolveDb(db);
  return ledgerTransaction(d, tx => postInternal(tx, {
    tenantId: input.tenantId, sourceBusinessId: input.sourceBusinessId ?? null, kind: input.kind, idempotencyKey: input.idempotencyKey,
    effectiveDate: input.effectiveDate, currency: input.currency, actor: input.actor, entries: input.entries,
    description: input.description ?? "", sourceType: input.sourceType ?? null, sourceReference: input.sourceReference ?? null, reversalOfTransactionId: null,
  }));
}

/** عكس حركة: حركة جديدة بقيود معكوسة في فترة مفتوحة بتاريخ جديد؛ الأصل لا يُمس؛ مرة واحدة فقط. */
export async function reverseLedgerTransaction(input: {
  tenantId: number; transactionId: number; idempotencyKey: string; effectiveDate: string; actor: LedgerActor; reason: string;
}, db?: LedgerDb): Promise<PostResult> {
  if (!input.reason || !input.reason.trim()) throw new LedgerError("reason");
  const d = await resolveDb(db);
  return ledgerTransaction(d, async tx => {
    const [original] = await tx.select().from(ledgerTransactions)
      .where(and(eq(ledgerTransactions.tenantId, input.tenantId), eq(ledgerTransactions.id, input.transactionId))).limit(1).for("share");
    if (!original) throw new LedgerError("transaction", `#${input.transactionId}`);
    const [already] = await tx.select({ id: ledgerTransactions.id, idempotencyKey: ledgerTransactions.idempotencyKey }).from(ledgerTransactions)
      .where(and(eq(ledgerTransactions.tenantId, input.tenantId), eq(ledgerTransactions.reversalOfTransactionId, original.id))).limit(1).for("share");
    if (already && already.idempotencyKey !== input.idempotencyKey) throw new LedgerError("reversedAlready");
    const rows = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, original.id)).orderBy(asc(ledgerEntries.id));
    return postInternal(tx, {
      tenantId: input.tenantId, sourceBusinessId: original.sourceBusinessId, kind: "reversal", idempotencyKey: input.idempotencyKey,
      effectiveDate: input.effectiveDate, currency: original.currency, actor: input.actor,
      entries: rows.map((e: any) => ({ accountId: e.accountId, side: e.side === "debit" ? "credit" : "debit", amount: e.amount, businessId: e.businessId })),
      description: `عكس الحركة #${original.id}: ${input.reason.trim()}`, sourceType: "reversal", sourceReference: String(original.id),
      reversalOfTransactionId: original.id,
    });
  });
}

export async function lockLedgerPeriod(input: { tenantId: number; period: string; actor: LedgerActor; reason?: string }, db?: LedgerDb): Promise<{ periodId: number; status: "locked"; replay: boolean }> {
  const d = await resolveDb(db);
  return ledgerTransaction(d, async tx => {
    await assertEnabled(tx, input.tenantId);
    const actor = await resolveActor(tx, input.tenantId, input.actor);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period)) throw new LedgerError("periodNotFound", input.period);
    const read = async () => (await tx.select().from(ledgerPeriods).where(and(eq(ledgerPeriods.tenantId, input.tenantId), eq(ledgerPeriods.period, input.period))).limit(1).for("update"))[0];
    let row = await read();
    if (!row) { try { await tx.insert(ledgerPeriods).values({ tenantId: input.tenantId, period: input.period, status: "open" }); } catch (e) { if (!isMysqlError(e, "ER_DUP_ENTRY")) throw e; } row = await read(); }
    if (row.status === "locked") return { periodId: row.id, status: "locked" as const, replay: true };
    await tx.update(ledgerPeriods).set({ status: "locked" }).where(eq(ledgerPeriods.id, row.id));
    await tx.insert(ledgerPeriodEvents).values({ tenantId: input.tenantId, periodId: row.id, action: "lock", actorType: actor.actorType, actorEmployeeId: actor.actorEmployeeId, reason: input.reason?.trim() || "إقفال الفترة" });
    return { periodId: row.id, status: "locked" as const, replay: false };
  });
}

export async function reopenLedgerPeriod(input: { tenantId: number; period: string; actor: LedgerActor; reason: string }, db?: LedgerDb): Promise<{ periodId: number; status: "open"; replay: boolean }> {
  if (!input.reason || !input.reason.trim()) throw new LedgerError("reason");
  const d = await resolveDb(db);
  return ledgerTransaction(d, async tx => {
    await assertEnabled(tx, input.tenantId);
    // الصلاحية (ledger.period.reopen) تُفحص على السيرفر قبل الوصول هنا؛ الخدمة تشترط فاعلًا موظفًا
    // فعّالًا من نفس الشركة (للـaudit) — لا فاعل نظام/webhook ولا دور مُسمّى.
    const actor = await resolveActor(tx, input.tenantId, input.actor);
    if (actor.actorType !== "employee") throw new LedgerError("reopenRole");
    const [row] = await tx.select().from(ledgerPeriods).where(and(eq(ledgerPeriods.tenantId, input.tenantId), eq(ledgerPeriods.period, input.period))).limit(1).for("update");
    if (!row) throw new LedgerError("periodNotFound", input.period);
    if (row.status === "open") return { periodId: row.id, status: "open" as const, replay: true };
    await tx.update(ledgerPeriods).set({ status: "open" }).where(eq(ledgerPeriods.id, row.id));
    await tx.insert(ledgerPeriodEvents).values({ tenantId: input.tenantId, periodId: row.id, action: "reopen", actorType: "employee", actorEmployeeId: actor.actorEmployeeId, reason: input.reason.trim() });
    return { periodId: row.id, status: "open" as const, replay: false };
  });
}

/** مطابقة V3 — قراءة فقط: currentBalance مقابل المحسوب من القيود حسب normalSide. */
export async function reconcileLedgerV3(tenantId: number, db?: LedgerDb): Promise<{ lines: LedgerReconLine[]; ok: boolean }> {
  const d = await resolveDb(db);
  try {
    const accounts = await d.select().from(ledgerAccounts).where(eq(ledgerAccounts.tenantId, tenantId)).orderBy(asc(ledgerAccounts.code));
    const entries = accounts.length === 0 ? [] : await d.select({ accountId: ledgerEntries.accountId, side: ledgerEntries.side, amount: ledgerEntries.amount, createdAt: ledgerEntries.createdAt })
      .from(ledgerEntries).where(eq(ledgerEntries.tenantId, tenantId));
    const lines = accounts.map(a => reconcileAccount(a, entries.filter(e => e.accountId === a.id)));
    return { lines, ok: lines.every(l => l.ok) };
  } catch (err) {
    if (isNoSuchTable(err)) throw new LedgerError("unavailable");
    throw err;
  }
}

/** الحسابات الأساسية عند التفعيل. */
export const LEDGER_BASE_ACCOUNTS = [
  { code: "OFFICE_CASH", name: "خزنة المكتب", kind: "cash", normalSide: "debit", money: true },
  { code: "BANK_MAIN", name: "البنك", kind: "bank", normalSide: "debit", money: true },
  { code: "COD_BOSTA", name: "مستحقات بوسطة", kind: "carrier_receivable", normalSide: "debit", money: true },
  { code: "VF_CASH", name: "فودافون كاش", kind: "wallet", normalSide: "debit", money: true },
  { code: "INSTAPAY", name: "إنستا باي", kind: "wallet", normalSide: "debit", money: true },
  { code: "REVENUE", name: "إيرادات المبيعات", kind: "revenue", normalSide: "credit", money: false },
  { code: "EXPENSE", name: "مصروفات عامة", kind: "expense", normalSide: "debit", money: false },
  { code: "OPENING_EQUITY", name: "الرصيد الافتتاحي", kind: "equity", normalSide: "credit", money: false },
  { code: "SUSPENSE", name: "حساب معلّق", kind: "suspense", normalSide: "debit", money: false },
] as const;

export type ActivateLedgerV3Input = {
  tenantId: number;
  goLiveDate: string;
  currency: string;
  actor: LedgerActor;
  /** اعتماد تقرير المطابقة القديم — صريح وإلزامي. */
  reconciliation: { reportGeneratedAt: string; approvedByEmployeeId: number; approvedAt: string };
  /** الأرصدة الافتتاحية الصريحة للحسابات النقدية (كود → مبلغ عشري ≥ 0). */
  openingBalances: Record<string, string>;
  /** الأنشطة المفعَّلة (تُمنح الحسابات غير النقدية كلها) */
  businessIds: number[];
  /** الخزن: أي الأنشطة تستخدم كل خزنة (كود → أنشطة). غير المذكورة لا تُربط. */
  safeGrants: Record<string, number[]>;
};

export async function activateLedgerV3(input: ActivateLedgerV3Input, db?: LedgerDb): Promise<{ enabled: true; replay: boolean; openingTransactionId: number | null; accounts: Record<string, number> }> {
  const d = await resolveDb(db);
  assertCurrency(input.currency);
  postingPeriodOf(input.goLiveDate);
  const r = input.reconciliation;
  if (!r || !r.reportGeneratedAt || !r.approvedAt || !Number.isInteger(r.approvedByEmployeeId) || !input.openingBalances || typeof input.openingBalances !== "object")
    throw new LedgerError("activationInput");
  if (!Array.isArray(input.businessIds) || input.businessIds.length === 0) throw new LedgerError("activationInput", "businessIds");
  const openingKey = `opening:${input.tenantId}:${input.goLiveDate}`;

  return ledgerTransaction(d, async tx => {
    const actor = await resolveActor(tx, input.tenantId, input.actor);
    // المعتمِد مالك فعّال من نفس الشركة
    const [approver] = await tx.select({ id: employees.id, role: employees.role, isActive: employees.isActive }).from(employees)
      .where(and(eq(employees.id, r.approvedByEmployeeId), eq(employees.tenantId, input.tenantId))).limit(1).for("share");
    if (!approver || !approver.isActive || !isOwnerRole(approver.role)) throw new LedgerError("activationInput", "approvedByEmployeeId");
    for (const b of input.businessIds) await assertBusinessInTenant(tx, input.tenantId, b);

    // العلم FOR UPDATE — التفعيل المتزامن يتسلسل
    const [flag] = await tx.select().from(ledgerTenantFlags).where(eq(ledgerTenantFlags.tenantId, input.tenantId)).limit(1).for("update");
    if (flag?.ledgerV3Enabled === 1) {
      if (flag.goLiveDate === input.goLiveDate) {
        const accounts = await tx.select({ id: ledgerAccounts.id, code: ledgerAccounts.code }).from(ledgerAccounts).where(eq(ledgerAccounts.tenantId, input.tenantId));
        return { enabled: true as const, replay: true, openingTransactionId: flag.openingTransactionId ?? null, accounts: Object.fromEntries(accounts.map((a: any) => [a.code, a.id])) };
      }
      throw new LedgerError("alreadyEnabled");
    }
    // نطاق التفعيل = الشركة كلها: كل نشاط فعّال (FOR SHARE تحت قفل العلم — نشاط أُضيف بعد إعداد الخطة يُكتشف هنا)
    // يجب أن يكون في businessIds؛ المستبعد الوحيد المسموح هو النشاط غير النشط.
    const activeNow = await tx.select({ id: businesses.id, name: businesses.name }).from(businesses)
      .where(and(eq(businesses.tenantId, input.tenantId), eq(businesses.isActive, true))).for("share");
    const outside = (activeNow as { id: number; name: string }[]).filter(b => !input.businessIds.includes(b.id));
    if (outside.length > 0) throw new LedgerError("activationScope", `النشاط ${outside.map(b => `${b.name} (#${b.id})`).join("، ")} غير موجود في خطة التفعيل`);
    if (!flag) {
      try { await tx.insert(ledgerTenantFlags).values({ tenantId: input.tenantId, ledgerV3Enabled: 0 }); } catch (e) { if (!isMysqlError(e, "ER_DUP_ENTRY")) throw e; }
      await tx.select().from(ledgerTenantFlags).where(eq(ledgerTenantFlags.tenantId, input.tenantId)).limit(1).for("update");
    }

    // الحسابات الأساسية (أو الموجودة من محاولة سابقة لم تُفعَّل — نفس الأكواد)
    const accountIds: Record<string, number> = {};
    for (const a of LEDGER_BASE_ACCOUNTS) {
      const [existing] = await tx.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, input.tenantId), eq(ledgerAccounts.code, a.code))).limit(1).for("update");
      if (existing) { accountIds[a.code] = existing.id; continue; }
      const ins = await tx.insert(ledgerAccounts).values({
        tenantId: input.tenantId, code: a.code, name: a.name, kind: a.kind, normalSide: a.normalSide, currency: input.currency,
        actorType: actor.actorType, actorEmployeeId: actor.actorEmployeeId,
      });
      accountIds[a.code] = insertId(ins);
    }
    // الربط: الخزن حسب safeGrants، وغير النقدية لكل الأنشطة
    for (const a of LEDGER_BASE_ACCOUNTS) {
      const targets = a.money ? (input.safeGrants[a.code] ?? []) : input.businessIds;
      for (const b of targets) {
        if (!input.businessIds.includes(b)) throw new LedgerError("business", `#${b}`);
        const [has] = await tx.select({ accountId: ledgerAccountBusinesses.accountId }).from(ledgerAccountBusinesses)
          .where(and(eq(ledgerAccountBusinesses.accountId, accountIds[a.code]), eq(ledgerAccountBusinesses.businessId, b))).limit(1);
        if (!has) await tx.insert(ledgerAccountBusinesses).values({ tenantId: input.tenantId, accountId: accountIds[a.code], businessId: b, canPost: 1, actorType: actor.actorType, actorEmployeeId: actor.actorEmployeeId });
      }
    }
    // القيد الافتتاحي الواحد المتوازن: مدين النقديات، دائن رأس المال الافتتاحي
    const entries: LedgerEntryInput[] = [];
    let total = 0n;
    for (const [code, amount] of Object.entries(input.openingBalances)) {
      const spec = LEDGER_BASE_ACCOUNTS.find(a => a.code === code && a.money);
      if (!spec) throw new LedgerError("activationInput", `opening:${code}`);
      if (!/^\d{1,14}(\.\d{1,4})?$/.test(amount)) throw new LedgerError("amount", amount);
      const minor = toMinorUnits(amount);
      if (minor === 0n) continue;
      entries.push({ accountId: accountIds[code], side: "debit", amount: fromMinorUnits(minor), businessId: null });
      total += minor;
    }
    let openingTransactionId: number | null = null;
    // العلم يجب أن يكون مفعّلًا لحظة الترحيل (postInternal يفحصه) — نفعّله هنا داخل نفس الـtransaction؛ أي فشل لاحق يرجع كل شيء.
    await tx.update(ledgerTenantFlags).set({ ledgerV3Enabled: 1, goLiveDate: input.goLiveDate, actorType: actor.actorType, actorEmployeeId: actor.actorEmployeeId, enabledAt: sql`now()`, disabledAt: null, disabledReason: null })
      .where(eq(ledgerTenantFlags.tenantId, input.tenantId));
    if (total > 0n) {
      entries.push({ accountId: accountIds.OPENING_EQUITY, side: "credit", amount: fromMinorUnits(total), businessId: null });
      const posted = await postInternal(tx, {
        tenantId: input.tenantId, sourceBusinessId: null, kind: "opening_balance", idempotencyKey: openingKey, effectiveDate: input.goLiveDate,
        currency: input.currency, actor: input.actor, entries, description: `رصيد افتتاحي بتاريخ ${input.goLiveDate} (تقرير مطابقة ${r.reportGeneratedAt} معتمد في ${r.approvedAt})`,
        sourceType: "reconciliation", sourceReference: r.reportGeneratedAt, reversalOfTransactionId: null,
      });
      openingTransactionId = posted.transactionId;
      await tx.update(ledgerTenantFlags).set({ openingTransactionId }).where(eq(ledgerTenantFlags.tenantId, input.tenantId));
    }
    return { enabled: true as const, replay: false, openingTransactionId, accounts: accountIds };
  });
}

/** تعطيل آمن للكتابات مع إبقاء السجل — لا DROP ولا حذف. */
export async function disableLedgerV3(input: { tenantId: number; actor: LedgerActor; reason: string }, db?: LedgerDb): Promise<void> {
  if (!input.reason?.trim()) throw new LedgerError("reason");
  const d = await resolveDb(db);
  await ledgerTransaction(d, async tx => {
    const actor = await resolveActor(tx, input.tenantId, input.actor);
    // التعطيل للمالك (super_admin) وحده — ويُسجَّل الفاعل والسبب والتوقيت في صف العلم
    if (actor.actorType !== "employee" || !isOwnerRole(actor.role)) throw new LedgerError("reopenRole");
    await tx.update(ledgerTenantFlags)
      .set({ ledgerV3Enabled: 0, disabledAt: sql`now()`, disabledReason: input.reason.trim(), actorType: actor.actorType, actorEmployeeId: actor.actorEmployeeId })
      .where(eq(ledgerTenantFlags.tenantId, input.tenantId));
  });
}



// ═══════════════════════════ قراءات وإدارة الحسابات (للـRouters) ═══════════════════════════

export type LedgerStatus = { tablesPresent: boolean; enabled: boolean; goLiveDate: string | null; openingTransactionId: number | null; enabledAt: Date | null; disabledAt: Date | null; disabledReason: string | null };

export async function getLedgerStatus(tenantId: number, db?: LedgerDb): Promise<LedgerStatus> {
  const d = await resolveDb(db);
  try {
    const [flag] = await d.select().from(ledgerTenantFlags).where(eq(ledgerTenantFlags.tenantId, tenantId)).limit(1);
    return {
      tablesPresent: true, enabled: flag?.ledgerV3Enabled === 1, goLiveDate: flag?.goLiveDate ?? null, openingTransactionId: flag?.openingTransactionId ?? null,
      enabledAt: flag?.enabledAt ?? null, disabledAt: flag?.disabledAt ?? null, disabledReason: flag?.disabledReason ?? null,
    };
  } catch (err) {
    if (isNoSuchTable(err)) return { tablesPresent: false, enabled: false, goLiveDate: null, openingTransactionId: null, enabledAt: null, disabledAt: null, disabledReason: null };
    throw err;
  }
}

const guardNoTable = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (err) { if (isNoSuchTable(err)) throw new LedgerError("unavailable"); throw err; } };

/**
 * الأنشطة التي تراها واجهة الدفتر: أنشطة الشركة النشطة **المسموح بها للجلسة فقط** (`allowedIds` من
 * `sessionBusinessIds`: المالك = كل أنشطة شركته، الموظف = نشاطه). `null` (تعذّر التحديد) = لا شيء —
 * fail-closed. لا تعتمد على BusinessContext الذي يشترط جلسة مالك، فالمحاسب موظف غير إداري.
 */
export async function listLedgerBusinesses(tenantId: number, allowedIds: number[] | null, db?: LedgerDb): Promise<{ id: number; name: string }[]> {
  if (!allowedIds || allowedIds.length === 0) return [];
  const d = await resolveDb(db);
  const rows = await d.select({ id: businesses.id, name: businesses.name }).from(businesses)
    .where(and(eq(businesses.tenantId, tenantId), eq(businesses.isActive, true), inArray(businesses.id, allowedIds)))
    .orderBy(asc(businesses.name));
  return rows.map(r => ({ id: r.id, name: r.name }));
}

export async function listLedgerAccounts(tenantId: number, db?: LedgerDb) {
  const d = await resolveDb(db);
  return guardNoTable(async () => {
    const accounts = await d.select().from(ledgerAccounts).where(eq(ledgerAccounts.tenantId, tenantId)).orderBy(asc(ledgerAccounts.code));
    const grants = await d.select().from(ledgerAccountBusinesses).where(eq(ledgerAccountBusinesses.tenantId, tenantId));
    const baseCodes = new Set<string>(LEDGER_BASE_ACCOUNTS.map(a => a.code));
    return accounts.map(a => ({
      ...a, isSystem: baseCodes.has(a.code),
      businesses: grants.filter(g => g.accountId === a.id).map(g => ({ businessId: g.businessId, canPost: g.canPost === 1 })),
    }));
  });
}

export type LedgerTransactionFilters = { page: number; limit: number; from?: string; to?: string; businessId?: number | null; accountId?: number; kind?: LedgerKind };
export type LedgerTransactionRow = LedgerTransaction & {
  entries: { id: number; transactionId: number; accountId: number; businessId: number | null; side: "debit" | "credit"; amount: string; code: string; name: string; kind: string }[];
  actorName: string | null;
  reversedByTransactionId: number | null;
};

export async function listLedgerTransactions(tenantId: number, f: LedgerTransactionFilters, db?: LedgerDb) {
  const d = await resolveDb(db);
  return guardNoTable(async () => {
    const conds = [eq(ledgerTransactions.tenantId, tenantId)];
    if (f.from) { assertEffectiveDate(f.from); conds.push(sql`${ledgerTransactions.effectiveDate} >= ${f.from}`); }
    if (f.to) { assertEffectiveDate(f.to); conds.push(sql`${ledgerTransactions.effectiveDate} <= ${f.to}`); }
    if (f.businessId != null) conds.push(eq(ledgerTransactions.sourceBusinessId, f.businessId));
    if (f.kind) conds.push(eq(ledgerTransactions.kind, f.kind));
    if (f.accountId != null) conds.push(sql`${ledgerTransactions.id} IN (SELECT transactionId FROM ledger_entries WHERE tenantId = ${tenantId} AND accountId = ${f.accountId})`);
    const where = and(...conds);
    const [{ total }] = await d.select({ total: sql<number>`COUNT(*)` }).from(ledgerTransactions).where(where);
    const rows = await d.select().from(ledgerTransactions).where(where).orderBy(sql`${ledgerTransactions.effectiveDate} DESC`, sql`${ledgerTransactions.id} DESC`)
      .limit(f.limit).offset((f.page - 1) * f.limit);
    if (rows.length === 0) return { rows: [] as LedgerTransactionRow[], total: Number(total), page: f.page, limit: f.limit };
    const ids = rows.map(r => r.id);
    const entries = await d.select({
      id: ledgerEntries.id, transactionId: ledgerEntries.transactionId, accountId: ledgerEntries.accountId, businessId: ledgerEntries.businessId,
      side: ledgerEntries.side, amount: ledgerEntries.amount, code: ledgerAccounts.code, name: ledgerAccounts.name, kind: ledgerAccounts.kind,
    }).from(ledgerEntries).innerJoin(ledgerAccounts, eq(ledgerAccounts.id, ledgerEntries.accountId))
      .where(inArray(ledgerEntries.transactionId, ids)).orderBy(asc(ledgerEntries.id));
    const reversals = await d.select({ id: ledgerTransactions.id, of: ledgerTransactions.reversalOfTransactionId }).from(ledgerTransactions)
      .where(and(eq(ledgerTransactions.tenantId, tenantId), inArray(ledgerTransactions.reversalOfTransactionId, ids)));
    const actorIds = [...new Set(rows.map(r => r.actorEmployeeId).filter((x): x is number => x != null))];
    const actors = actorIds.length === 0 ? [] : await d.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, actorIds));
    const actorName = new Map(actors.map(a => [a.id, a.name]));
    const reversedBy = new Map(reversals.map(r => [r.of as number, r.id]));
    const enriched: LedgerTransactionRow[] = rows.map(r => ({
      ...r,
      entries: entries.filter(e => e.transactionId === r.id),
      actorName: r.actorEmployeeId != null ? actorName.get(r.actorEmployeeId) ?? null : null,
      reversedByTransactionId: reversedBy.get(r.id) ?? null,
    }));
    return { rows: enriched, total: Number(total), page: f.page, limit: f.limit };
  });
}

export async function getLedgerTransaction(tenantId: number, transactionId: number, db?: LedgerDb) {
  const d = await resolveDb(db);
  return guardNoTable(async () => {
    const [tx] = await d.select().from(ledgerTransactions).where(and(eq(ledgerTransactions.tenantId, tenantId), eq(ledgerTransactions.id, transactionId))).limit(1);
    if (!tx) throw new LedgerError("transaction", `#${transactionId}`);
    const entries = await d.select().from(ledgerEntries).where(eq(ledgerEntries.transactionId, tx.id)).orderBy(asc(ledgerEntries.id));
    const [reversal] = await d.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(and(eq(ledgerTransactions.tenantId, tenantId), eq(ledgerTransactions.reversalOfTransactionId, tx.id))).limit(1);
    return { ...tx, entries, reversedByTransactionId: reversal?.id ?? null };
  });
}

export async function listLedgerPeriods(tenantId: number, db?: LedgerDb) {
  const d = await resolveDb(db);
  return guardNoTable(async () => {
    const periods = await d.select().from(ledgerPeriods).where(eq(ledgerPeriods.tenantId, tenantId)).orderBy(sql`${ledgerPeriods.period} DESC`);
    const events = periods.length === 0 ? [] : await d.select().from(ledgerPeriodEvents).where(eq(ledgerPeriodEvents.tenantId, tenantId)).orderBy(asc(ledgerPeriodEvents.id));
    return periods.map(p => ({ ...p, events: events.filter(e => e.periodId === p.id) }));
  });
}

const CODE_RE = /^[A-Z][A-Z0-9_]{1,49}$/;
const IMMUTABLE_BASE = new Set<string>(LEDGER_BASE_ACCOUNTS.map(a => a.code));

/** حساب إضافي (مثل تصنيف مصروف) — كود مستقل، لا يمس حسابات النظام. */
export async function createLedgerAccount(input: {
  tenantId: number; code: string; name: string; kind: (typeof LEDGER_BASE_ACCOUNTS)[number]["kind"] | "cogs" | "inventory" | "employee_receivable" | "supplier_payable" | "customer_advance" | "owner_current";
  normalSide: "debit" | "credit"; allowNegative?: boolean; actor: LedgerActor;
}, db?: LedgerDb): Promise<{ id: number; replay: boolean }> {
  const d = await resolveDb(db);
  if (!CODE_RE.test(input.code)) throw new LedgerError("account", "الكود: حروف لاتينية كبيرة وأرقام و_ (2–50)");
  if (!input.name?.trim()) throw new LedgerError("account", "الاسم مطلوب");
  if (IMMUTABLE_BASE.has(input.code)) throw new LedgerError("account", "كود محجوز لحساب النظام");
  return ledgerTransaction(d, async tx => {
    await assertEnabled(tx, input.tenantId);
    const actor = await resolveActor(tx, input.tenantId, input.actor);
    const [flag] = await tx.select({ currency: sql<string>`(SELECT currency FROM ledger_accounts WHERE tenantId = ${input.tenantId} LIMIT 1)` }).from(ledgerTenantFlags).where(eq(ledgerTenantFlags.tenantId, input.tenantId)).limit(1);
    const currency = flag?.currency ?? "EGP";
    try {
      const r = await tx.insert(ledgerAccounts).values({
        tenantId: input.tenantId, code: input.code, name: input.name.trim(), kind: input.kind, normalSide: input.normalSide, currency,
        allowNegative: input.allowNegative ? 1 : 0, actorType: actor.actorType, actorEmployeeId: actor.actorEmployeeId,
      });
      return { id: insertId(r), replay: false };
    } catch (err) {
      if (!isMysqlError(err, "ER_DUP_ENTRY")) throw err;
      const [existing] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, input.tenantId), eq(ledgerAccounts.code, input.code))).limit(1).for("share");
      if (existing && existing.kind === input.kind && existing.normalSide === input.normalSide) return { id: existing.id, replay: true };
      throw new LedgerError("conflict", `الكود ${input.code} مستخدم بنوع مختلف`);
    }
  });
}

async function loadOwnedAccount(tx: Tx, tenantId: number, accountId: number): Promise<LedgerAccount> {
  const [a] = await tx.select().from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.id, accountId))).limit(1).for("update");
  if (!a) throw new LedgerError("account", `#${accountId}`);
  return a;
}

/** تغيير الاسم فقط — لا يمس الكود/النوع/الجانب/العملة ولا أي قيد. */
export async function renameLedgerAccount(input: { tenantId: number; accountId: number; name: string; actor: LedgerActor }, db?: LedgerDb): Promise<void> {
  if (!input.name?.trim()) throw new LedgerError("account", "الاسم مطلوب");
  const d = await resolveDb(db);
  await ledgerTransaction(d, async tx => {
    await assertEnabled(tx, input.tenantId); await resolveActor(tx, input.tenantId, input.actor);
    await loadOwnedAccount(tx, input.tenantId, input.accountId);
    await tx.update(ledgerAccounts).set({ name: input.name.trim() }).where(and(eq(ledgerAccounts.tenantId, input.tenantId), eq(ledgerAccounts.id, input.accountId)));
  });
}

export const isSystemLedgerAccountCode = (code: string): boolean => IMMUTABLE_BASE.has(code);

/**
 * تعطيل/تفعيل: التعطيل يمنع القيود الجديدة فقط — التاريخ والرصيد يبقيان كما هما (يظهر في التقارير).
 * حسابات النظام التسعة لا تُعطَّل ولا تتغير خصائصها الجوهرية (code/kind/normalSide/currency) — الاسم فقط.
 */
export async function setLedgerAccountActive(input: { tenantId: number; accountId: number; isActive: boolean; actor: LedgerActor }, db?: LedgerDb): Promise<void> {
  const d = await resolveDb(db);
  await ledgerTransaction(d, async tx => {
    await assertEnabled(tx, input.tenantId); await resolveActor(tx, input.tenantId, input.actor);
    const account = await loadOwnedAccount(tx, input.tenantId, input.accountId);
    if (isSystemLedgerAccountCode(account.code) && !input.isActive) throw new LedgerError("account", `حساب النظام ${account.code} لا يُعطَّل`);
    await tx.update(ledgerAccounts).set({ isActive: input.isActive ? 1 : 0 }).where(and(eq(ledgerAccounts.tenantId, input.tenantId), eq(ledgerAccounts.id, input.accountId)));
  });
}

/** منح نشاط صلاحية الترحيل على حساب (canPost=1) — النشاط والحساب من نفس الشركة. */
export async function grantLedgerAccountBusiness(input: { tenantId: number; accountId: number; businessId: number; actor: LedgerActor }, db?: LedgerDb): Promise<void> {
  const d = await resolveDb(db);
  await ledgerTransaction(d, async tx => {
    await assertEnabled(tx, input.tenantId);
    const actor = await resolveActor(tx, input.tenantId, input.actor);
    await loadOwnedAccount(tx, input.tenantId, input.accountId);
    await assertBusinessInTenant(tx, input.tenantId, input.businessId);
    const [has] = await tx.select().from(ledgerAccountBusinesses).where(and(eq(ledgerAccountBusinesses.accountId, input.accountId), eq(ledgerAccountBusinesses.businessId, input.businessId))).limit(1).for("update");
    if (has) { if (has.canPost !== 1) await tx.update(ledgerAccountBusinesses).set({ canPost: 1 }).where(and(eq(ledgerAccountBusinesses.accountId, input.accountId), eq(ledgerAccountBusinesses.businessId, input.businessId))); return; }
    await tx.insert(ledgerAccountBusinesses).values({ tenantId: input.tenantId, accountId: input.accountId, businessId: input.businessId, canPost: 1, actorType: actor.actorType, actorEmployeeId: actor.actorEmployeeId });
  });
}

/** سحب الصلاحية = canPost=0 (الصف يبقى؛ التاريخ لا يُخفى). */
export async function revokeLedgerAccountBusiness(input: { tenantId: number; accountId: number; businessId: number; actor: LedgerActor }, db?: LedgerDb): Promise<void> {
  const d = await resolveDb(db);
  await ledgerTransaction(d, async tx => {
    await assertEnabled(tx, input.tenantId); await resolveActor(tx, input.tenantId, input.actor);
    await loadOwnedAccount(tx, input.tenantId, input.accountId);
    await tx.update(ledgerAccountBusinesses).set({ canPost: 0 }).where(and(eq(ledgerAccountBusinesses.tenantId, input.tenantId), eq(ledgerAccountBusinesses.accountId, input.accountId), eq(ledgerAccountBusinesses.businessId, input.businessId)));
  });
}
