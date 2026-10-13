import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { businesses, purchaseReceipts } from "../drizzle/schema";
import { ledgerAccounts } from "../drizzle/ledgerV3.schema";
import { ledgerSupplierDocuments, ledgerSuppliers, ledgerWorkshopBatches, ledgerWorkshopEvents } from "../drizzle/ledgerPhases.schema";
import { divideRounded, fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { businessDateKey } from "../shared/businessTime";
import { LEDGER_SUPPLIER_ACCOUNTS, SYSTEM_POSTED_CODES } from "../shared/ledgerDailyAccounts";
import { LedgerError, type LedgerActor } from "../shared/ledgerV3Core";
import { tablesPresent } from "./ledgerCarrierOps.service";
import { ledgerKindsSupported } from "./ledgerKindsMigration.service";
import { createLedgerAccount, getLedgerStatus, grantLedgerAccountBusiness, postLedgerTransaction, rawRows, resolveDb, reverseLedgerTransaction, type LedgerDb } from "./ledgerV3.service";

/**
 * المرحلة 6 — الموردون والورشة في Ledger V3 (بعد 0046 + 0049). هوية مورد ثابتة بكود؛ كل مستند وحدث بقيد واحد بمفتاح دائم؛
 * الإلغاء بالعكس فقط؛ والمستحق لكل مورد يُحسب من قيود الدفتر نفسها (قيود مستنداته وأحداث ورشته وعكسها) — لا رصيد مخزّن.
 *
 *  • فاتورة: مدين مخزون (بضاعة/خامات/تغليف) أو مصروف تشغيلي / دائن «موردون». مربوطة اختياريًا بإيصال استلام V2 معتمد من نفس
 *    النشاط، بمبلغه نفسه، وفاتورة واحدة لكل إيصال (فهرس فريد). الشراء النقدي بلا مورد يبقى في «شراء» اليومي.
 *  • دفعة ≤ المستحق؛ دفعة مقدمة = أصل؛ تطبيق المقدّم ≤ المتبقي منه وحتى المستحق؛ إشعار مرتجع ≤ المستحق (يعيد قيمة المخزون).
 *    الحدود تُفحص داخل transaction القيد بعد قفل صف المورد — المتزامن لا يتجاوزها.
 *  • الورشة مورد isWorkshop: إرسال خامات = عهدة بالكمية والقيمة؛ استلام جزئي بمتوسط قيمة القطعة الباقية في العهدة (آخر قطعة تأخذ
 *    الباقي بالضبط) + أجر القطعة المتفق عليه (من تكلفة البضاعة، مستحق للورشة)؛ العجز بنفس المتوسط على الورشة أو كخسارة
 *    (اختيار صريح لكل حدث، بلا افتراضي)؛ التصليح مصروف مستحق للورشة. المُستلم + العجز ≤ المُرسل (CHECK).
 */
export const SUPPLIER_TABLES = ["ledger_suppliers", "ledger_supplier_documents", "ledger_workshop_batches", "ledger_workshop_events"] as const;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const OP_RE = /^[A-Za-z0-9_:-]{8,80}$/;
const today = () => businessDateKey(new Date(), "Africa/Cairo");
const insertId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? 0);
const affected = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
const employeeOf = (actor: LedgerActor) => { if (actor.type !== "employee") throw new LedgerError("actorEmployee"); return actor.employeeId; };
const PURCHASABLE = (code: string, kind: string) => kind === "inventory" && !SYSTEM_POSTED_CODES.has(code);
const MONEY = new Set(["cash", "bank", "wallet"]);

export async function supplierAvailability(d: LedgerDb) {
  const kinds = await ledgerKindsSupported({ query: (q: string) => d.execute(sql.raw(q)) as any });
  const tables = await tablesPresent(d, SUPPLIER_TABLES);
  return { kinds, tables, ok: kinds && tables };
}
async function requireReady(d: LedgerDb, tenantId: number) {
  const a = await supplierAvailability(d);
  if (!a.ok) throw new LedgerError("unavailable", !a.kinds ? "أنواع الحسابات (0046) غير مطبّقة" : "جداول الموردين (0049) غير مطبّقة");
  const s = await getLedgerStatus(tenantId, d);
  if (!s.enabled || !s.goLiveDate) throw new LedgerError("disabled");
  return { goLiveDate: s.goLiveDate };
}
function checkDate(date: string, goLiveDate: string) {
  if (!DATE_RE.test(date) || date < goLiveDate || date > today()) throw new LedgerError("date", date);
}
async function accounts(d: LedgerDb, tenantId: number) {
  const rows = await d.select({ id: ledgerAccounts.id, code: ledgerAccounts.code, kind: ledgerAccounts.kind, isActive: ledgerAccounts.isActive }).from(ledgerAccounts).where(eq(ledgerAccounts.tenantId, tenantId));
  const byCode = new Map(rows.filter(r => r.isActive === 1).map(r => [r.code, r]));
  const need = (code: string) => { const a = byCode.get(code); if (!a) throw new LedgerError("account", `${code} — جهّز حسابات الموردين`); return a; };
  return { byCode, need };
}

export async function ensureSupplierAccounts(input: { tenantId: number; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  const biz = await d.select({ id: businesses.id }).from(businesses).where(eq(businesses.tenantId, input.tenantId));
  const created: string[] = [];
  for (const spec of LEDGER_SUPPLIER_ACCOUNTS) {
    const r = await createLedgerAccount({ tenantId: input.tenantId, code: spec.code, name: spec.name, kind: spec.kind as any, normalSide: spec.normalSide, actor: input.actor }, d);
    if (!r.replay) created.push(spec.code);
    for (const b of biz) await grantLedgerAccountBusiness({ tenantId: input.tenantId, accountId: r.id, businessId: b.id, actor: input.actor }, d);
  }
  return { created };
}

// ───────────── الموردون ─────────────

export async function createSupplier(input: { tenantId: number; code: string; name: string; phone?: string | null; isWorkshop: boolean; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  const by = employeeOf(input.actor);
  const code = input.code.trim().toUpperCase(), name = input.name.trim();
  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) throw new LedgerError("account", "الكود: حروف لاتينية/أرقام/-_ (2–40)");
  if (name.length < 2) throw new LedgerError("account", "اسم المورد");
  try {
    return { supplierId: insertId(await d.insert(ledgerSuppliers).values({ tenantId: input.tenantId, code, name, phone: input.phone?.trim() || null, isWorkshop: input.isWorkshop ? 1 : 0, createdByEmployeeId: by })), replay: false };
  } catch (e) {
    const [same] = await d.select().from(ledgerSuppliers).where(and(eq(ledgerSuppliers.tenantId, input.tenantId), eq(ledgerSuppliers.code, code))).limit(1);
    if (same && same.name === name && same.isWorkshop === (input.isWorkshop ? 1 : 0)) return { supplierId: same.id, replay: true };
    throw new LedgerError("conflict", "كود المورد أو اسمه مستخدم لمورد آخر — لا مورد مكرر");
  }
}

export async function setSupplierActive(input: { tenantId: number; supplierId: number; isActive: boolean }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  if (affected(await d.update(ledgerSuppliers).set({ isActive: input.isActive ? 1 : 0 }).where(and(eq(ledgerSuppliers.id, input.supplierId), eq(ledgerSuppliers.tenantId, input.tenantId)))) !== 1)
    throw new LedgerError("transaction", "المورد غير موجود");
}

async function supplierOf(d: LedgerDb, tenantId: number, supplierId: number) {
  const [s] = await d.select().from(ledgerSuppliers).where(and(eq(ledgerSuppliers.id, supplierId), eq(ledgerSuppliers.tenantId, tenantId))).limit(1);
  if (!s) throw new LedgerError("transaction", "المورد غير موجود في هذه الشركة");
  return s;
}

/** قيود المورد الأصلية (مستنداته + أحداث ورشته) — المستحق والمقدّم يُحسبان منها ومن عكسها. */
async function supplierTxIds(exec: { execute: (q: any) => Promise<any> }, tenantId: number, supplierId: number): Promise<number[]> {
  const rows = rawRows(await exec.execute(sql`SELECT transactionId AS t FROM ledger_supplier_documents WHERE tenantId = ${tenantId} AND supplierId = ${supplierId}
    UNION SELECT ev.transactionId FROM ledger_workshop_events ev JOIN ledger_workshop_batches b ON b.id = ev.batchId WHERE b.tenantId = ${tenantId} AND b.supplierId = ${supplierId} AND ev.transactionId IS NOT NULL`));
  return [...new Set(rows.map((r: any) => Number(r.t)).filter(Boolean))];
}
/** رصيد حساب لمورد من قيوده وعكسها (normalSide للحساب): موجب = مستحق له (موردون) أو مقدّم له (دفعات مقدمة). */
async function supplierBalance(exec: { execute: (q: any) => Promise<any> }, tenantId: number, supplierId: number, accountId: number, normal: "debit" | "credit", lock = false): Promise<bigint> {
  const ids = await supplierTxIds(exec, tenantId, supplierId);
  if (ids.length === 0) return 0n;
  const list = sql.join(ids.map(i => sql`${i}`), sql`, `);
  const [r] = rawRows(await exec.execute(sql`SELECT COALESCE(SUM(CASE WHEN e.side = ${normal} THEN e.amount ELSE -e.amount END), 0) AS b FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transactionId
    WHERE t.tenantId = ${tenantId} AND e.accountId = ${accountId} AND (t.id IN (${list}) OR t.reversalOfTransactionId IN (${list}))${lock ? sql` FOR SHARE` : sql``}`));
  const v = String(r?.b ?? "0");
  return v.startsWith("-") ? -toMinorUnits(v.slice(1)) : toMinorUnits(v);
}
/** المتبقي من دفعة مقدمة (مبلغها − تطبيقاتها غير المعكوسة). */
async function advanceRemaining(exec: { execute: (q: any) => Promise<any> }, advanceDocId: number): Promise<bigint> {
  const [r] = rawRows(await exec.execute(sql`SELECT a.amount - COALESCE((SELECT SUM(x.amount) FROM ledger_supplier_documents x WHERE x.appliesToDocumentId = a.id AND x.docType = 'advance_application' AND x.reversalTransactionId IS NULL), 0) AS rem
    FROM ledger_supplier_documents a WHERE a.id = ${advanceDocId} AND a.docType = 'advance' AND a.reversalTransactionId IS NULL`));
  return r ? toMinorUnits(String(r.rem)) : 0n;
}

export type SupplierDocInput = {
  tenantId: number; supplierId: number; docType: "invoice" | "payment" | "advance" | "advance_application" | "return_credit"; docNo: string; docDate: string;
  dueDate?: string | null; amount: string; businessId?: number | null; purchaseReceiptId?: number | null;
  /** فاتورة: حساب المدين (مخزون قابل للشراء أو مصروف تشغيلي)؛ مرتجع: حساب المخزون الدائن. */ itemAccountCode?: string;
  /** دفعة/دفعة مقدمة: الخزنة/البنك/المحفظة. */ cashAccountCode?: string;
  /** تطبيق مقدّم: مستند الدفعة المقدمة. */ appliesToDocumentId?: number | null;
  actor: LedgerActor;
};

export async function postSupplierDocument(input: SupplierDocInput, db?: LedgerDb) {
  const d = await resolveDb(db);
  const { goLiveDate } = await requireReady(d, input.tenantId);
  const by = employeeOf(input.actor);
  const sup = await supplierOf(d, input.tenantId, input.supplierId);
  if (sup.isActive !== 1) throw new LedgerError("conflict", "المورد موقوف");
  const docNo = input.docNo.trim();
  if (docNo.length < 1 || docNo.length > 80) throw new LedgerError("conflict", "رقم المستند");
  checkDate(input.docDate, goLiveDate);
  if (input.dueDate != null && (!DATE_RE.test(input.dueDate) || input.dueDate < input.docDate)) throw new LedgerError("date", "الاستحقاق لا يسبق تاريخ المستند");
  const amount = toMinorUnits(input.amount);
  if (amount <= 0n) throw new LedgerError("amount", input.amount);
  const businessId = input.businessId ?? null;
  if (businessId != null) {
    const [b] = await d.select({ id: businesses.id }).from(businesses).where(and(eq(businesses.id, businessId), eq(businesses.tenantId, input.tenantId))).limit(1);
    if (!b) throw new LedgerError("business", `#${businessId}`);
  }
  const acc = await accounts(d, input.tenantId);
  const payable = acc.need("SUPPLIER_PAYABLE"), advances = acc.need("SUPPLIER_ADVANCES");
  const money = () => { const c = acc.byCode.get(input.cashAccountCode ?? ""); if (!c || !MONEY.has(c.kind)) throw new LedgerError("account", "خزنة أو بنك أو محفظة"); return c; };
  const amt = fromMinorUnits(amount);
  type E = { accountId: number; side: "debit" | "credit"; amount: string; businessId: number | null };
  let entries: E[]; let kind: string; let check: ((tx: any) => Promise<void>) | null = null;
  switch (input.docType) {
    case "invoice": {
      if (businessId == null) throw new LedgerError("business", "الفاتورة لنشاط محدد");
      const item = acc.byCode.get(input.itemAccountCode ?? "");
      if (!item || !(PURCHASABLE(item.code, item.kind) || (item.kind === "expense" && !SYSTEM_POSTED_CODES.has(item.code)))) throw new LedgerError("account", "الفاتورة على مخزون (بضاعة/خامات/تغليف) أو مصروف تشغيلي");
      if (input.purchaseReceiptId != null) {
        const [rc] = await d.select({ id: purchaseReceipts.id, businessId: purchaseReceipts.businessId, status: purchaseReceipts.status, total: purchaseReceipts.totalAmount }).from(purchaseReceipts).where(eq(purchaseReceipts.id, input.purchaseReceiptId)).limit(1);
        if (!rc || rc.businessId !== businessId) throw new LedgerError("transaction", "إيصال الاستلام ليس لهذا النشاط");
        if (rc.status !== "approved") throw new LedgerError("conflict", "إيصال الاستلام غير معتمد");
        if (toMinorUnits(String(rc.total)) !== amount) throw new LedgerError("conflict", `مبلغ الفاتورة ≠ إجمالي الإيصال ${fromMinorUnits(toMinorUnits(String(rc.total)))}`);
      }
      kind = "supplier_invoice";
      entries = [{ accountId: item.id, side: "debit", amount: amt, businessId }, { accountId: payable.id, side: "credit", amount: amt, businessId }];
      break;
    }
    case "payment": {
      const c = money(); kind = "supplier_payment";
      entries = [{ accountId: payable.id, side: "debit", amount: amt, businessId }, { accountId: c.id, side: "credit", amount: amt, businessId }];
      check = async tx => { const due = await supplierBalance(tx, input.tenantId, sup.id, payable.id, "credit", true); if (amount > due) throw new LedgerError("conflict", `الدفعة ${amt} أكبر من المستحق ${fromMinorUnits(due)} — الزيادة تُسجَّل دفعة مقدمة`); };
      break;
    }
    case "advance": {
      const c = money(); kind = "supplier_advance";
      entries = [{ accountId: advances.id, side: "debit", amount: amt, businessId }, { accountId: c.id, side: "credit", amount: amt, businessId }];
      break;
    }
    case "advance_application": {
      if (input.appliesToDocumentId == null) throw new LedgerError("transaction", "حدد الدفعة المقدمة");
      const [adv] = await d.select().from(ledgerSupplierDocuments).where(and(eq(ledgerSupplierDocuments.id, input.appliesToDocumentId), eq(ledgerSupplierDocuments.tenantId, input.tenantId), eq(ledgerSupplierDocuments.supplierId, sup.id), eq(ledgerSupplierDocuments.docType, "advance"))).limit(1);
      if (!adv) throw new LedgerError("transaction", "الدفعة المقدمة ليست لهذا المورد");
      kind = "supplier_advance_apply";
      entries = [{ accountId: payable.id, side: "debit", amount: amt, businessId }, { accountId: advances.id, side: "credit", amount: amt, businessId }];
      check = async tx => {
        const due = await supplierBalance(tx, input.tenantId, sup.id, payable.id, "credit", true);
        const rem = await advanceRemaining(tx, adv.id);
        if (amount > rem) throw new LedgerError("conflict", `المتبقي من الدفعة المقدمة ${fromMinorUnits(rem)}`);
        if (amount > due) throw new LedgerError("conflict", `المستحق للمورد ${fromMinorUnits(due)}`);
      };
      break;
    }
    case "return_credit": {
      const item = acc.byCode.get(input.itemAccountCode ?? "");
      if (!item || !PURCHASABLE(item.code, item.kind)) throw new LedgerError("account", "المرتجع للمورد يخرج من مخزون (بضاعة/خامات/تغليف)");
      if (businessId == null) throw new LedgerError("business", "المرتجع لنشاط محدد");
      kind = "supplier_return";
      entries = [{ accountId: payable.id, side: "debit", amount: amt, businessId }, { accountId: item.id, side: "credit", amount: amt, businessId }];
      check = async tx => { const due = await supplierBalance(tx, input.tenantId, sup.id, payable.id, "credit", true); if (amount > due) throw new LedgerError("conflict", `المرتجع ${amt} أكبر من المستحق ${fromMinorUnits(due)}`); };
      break;
    }
  }
  const key = `supplier-doc:${sup.id}:${input.docType}:${docNo}`.slice(0, 191);
  let docId = 0;
  try {
    const r = await postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: businessId, kind: kind as any, idempotencyKey: key, effectiveDate: input.docDate, currency: "EGP", actor: input.actor, entries,
      description: `${sup.name} — ${input.docType} ${docNo}`, sourceType: "supplier_doc", sourceReference: `${sup.id}:${docNo}`,
      guard: async (tx: any, { transactionId }: { transactionId: number }) => {
        await tx.execute(sql`SELECT id FROM ledger_suppliers WHERE id = ${sup.id} FOR UPDATE`); // تسلسل مستندات نفس المورد
        if (check) await check(tx);
        docId = insertId(await tx.insert(ledgerSupplierDocuments).values({ tenantId: input.tenantId, supplierId: sup.id, businessId, docType: input.docType, docNo, docDate: input.docDate, dueDate: input.dueDate ?? null,
          amount: amt, purchaseReceiptId: input.purchaseReceiptId ?? null, appliesToDocumentId: input.appliesToDocumentId ?? null, transactionId, createdByEmployeeId: by }));
      } } as any, d);
    if (!docId) {
      const [row] = await d.select({ id: ledgerSupplierDocuments.id }).from(ledgerSupplierDocuments).where(eq(ledgerSupplierDocuments.transactionId, r.transactionId)).limit(1);
      docId = row?.id ?? 0;
    }
    return { documentId: docId, transactionId: r.transactionId, replay: r.replay };
  } catch (e: any) {
    for (let x: any = e, i = 0; x && i < 6; x = x.cause, i++)
      if (x.code === "ER_DUP_ENTRY" && String(x.sqlMessage ?? "").includes("receipt_invoice")) throw new LedgerError("conflict", "لهذا الإيصال فاتورة بالفعل — لا فاتورتين لإيصال واحد");
    // تعارض مفتاح الدفتر نفسه (نفس رقم المستند ببيانات مختلفة) — رسالة الدفتر بلا تفاصيل؛ رسائل الحدود تحمل تفاصيلها
    if (e instanceof LedgerError && e.code === "conflict" && e.message === new LedgerError("conflict").message)
      throw new LedgerError("conflict", `رقم المستند ${docNo} مستخدم لهذا المورد بقيمة/بيانات مختلفة`);
    throw e;
  }
}

/**
 * رصيد افتتاحي لمورد (المالك فقط) من مستند مطابقة فعلي يوم Go-live — لكل فاتورة قائمة أو دفعة مقدمة قائمة سطر بمستندها الأصلي:
 *  • مستحق له: مدين «الرصيد الافتتاحي» / دائن «موردون» — لا مخزون ولا مصروف جديد (البضاعة/المصروف سُجّلا قبل Go-live).
 *  • دفعة مقدمة له: مدين «دفعات مقدمة لموردين» / دائن «الرصيد الافتتاحي».
 * التاريخ المحاسبي = يوم Go-live دائمًا (شهر Go-live مفتوح وإلا يرفض الدفتر)، وتاريخ المستند الأصلي واستحقاقه للأعمار.
 * مرجع المطابقة إلزامي (كشف حساب/إقرار المورد). مرة واحدة لكل (مورد، نوع، رقم المستند الأصلي) — نفس الفهرس الفريد يمنع
 * لاحقًا تسجيل نفس الفاتورة الأصلية كفاتورة جديدة (لا عدّ مزدوج).
 */
export async function postSupplierOpening(input: {
  tenantId: number; supplierId: number; side: "payable" | "advance"; originalDocNo: string; originalDate: string; dueDate?: string | null;
  amount: string; businessId?: number | null; evidenceRef: string; actor: LedgerActor;
}, db?: LedgerDb) {
  const d = await resolveDb(db);
  const { goLiveDate } = await requireReady(d, input.tenantId);
  const by = employeeOf(input.actor);
  const sup = await supplierOf(d, input.tenantId, input.supplierId);
  const docNo = input.originalDocNo.trim();
  if (docNo.length < 1 || docNo.length > 80) throw new LedgerError("invalid", "رقم المستند الأصلي");
  if (!DATE_RE.test(input.originalDate) || input.originalDate > goLiveDate) throw new LedgerError("date", `المستند الأصلي يسبق Go-live (${goLiveDate}) أو في يومه`);
  if (input.dueDate != null && (!DATE_RE.test(input.dueDate) || input.dueDate < input.originalDate)) throw new LedgerError("date", "الاستحقاق لا يسبق تاريخ المستند");
  const evidence = input.evidenceRef.trim();
  if (evidence.length < 5) throw new LedgerError("invalid", "مرجع مستند المطابقة (كشف حساب أو إقرار المورد) إلزامي");
  const amount = toMinorUnits(input.amount);
  if (amount <= 0n) throw new LedgerError("amount", input.amount);
  const businessId = input.businessId ?? null;
  if (businessId != null) {
    const [b] = await d.select({ id: businesses.id }).from(businesses).where(and(eq(businesses.id, businessId), eq(businesses.tenantId, input.tenantId))).limit(1);
    if (!b) throw new LedgerError("business", `#${businessId}`);
  }
  const acc = await accounts(d, input.tenantId);
  const equity = acc.need("OPENING_EQUITY"), payable = acc.need("SUPPLIER_PAYABLE"), advances = acc.need("SUPPLIER_ADVANCES");
  const amt = fromMinorUnits(amount);
  const docType = input.side === "payable" ? "invoice" as const : "advance" as const;
  const entries = input.side === "payable"
    ? [{ accountId: equity.id, side: "debit" as const, amount: amt, businessId: null }, { accountId: payable.id, side: "credit" as const, amount: amt, businessId }]
    : [{ accountId: advances.id, side: "debit" as const, amount: amt, businessId }, { accountId: equity.id, side: "credit" as const, amount: amt, businessId: null }];
  const key = `supplier-doc:${sup.id}:${docType}:${docNo}`.slice(0, 191);
  let docId = 0;
  try {
    const r = await postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: businessId, kind: "adjustment", idempotencyKey: key, effectiveDate: goLiveDate, currency: "EGP", actor: input.actor, entries,
      description: `رصيد افتتاحي — ${sup.name} — ${input.side === "payable" ? "مستحق له" : "دفعة مقدمة له"} ${docNo} — مطابقة: ${evidence}`,
      sourceType: "supplier_opening", sourceReference: `${sup.id}:${docNo}`,
      guard: async (tx: any, { transactionId }: { transactionId: number }) => {
        docId = insertId(await tx.insert(ledgerSupplierDocuments).values({ tenantId: input.tenantId, supplierId: sup.id, businessId, docType, docNo, docDate: input.originalDate,
          dueDate: input.side === "payable" ? input.dueDate ?? null : null, amount: amt, transactionId, createdByEmployeeId: by }));
      } } as any, d);
    if (!docId) {
      const [row] = await d.select({ id: ledgerSupplierDocuments.id }).from(ledgerSupplierDocuments).where(eq(ledgerSupplierDocuments.transactionId, r.transactionId)).limit(1);
      docId = row?.id ?? 0;
    }
    return { documentId: docId, transactionId: r.transactionId, replay: r.replay };
  } catch (e) {
    if (e instanceof LedgerError && e.code === "conflict" && e.message === new LedgerError("conflict").message)
      throw new LedgerError("conflict", `المستند ${docNo} مسجّل لهذا المورد بالفعل (افتتاحيًا أو كمستند عادي) — لا عدّ مزدوج`);
    throw e;
  }
}

/** إلغاء مستند بالعكس بسبب — يُرفض إن ترك المورد بمستحق سالب أو دفعة مقدمة سالبة (ألغِ ما بُني عليه أولًا). */
export async function cancelSupplierDocument(input: { tenantId: number; documentId: number; reason: string; actor: LedgerActor; isOwner?: boolean }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  if (!input.reason || input.reason.trim().length < 3) throw new LedgerError("reason");
  const [doc] = await d.select().from(ledgerSupplierDocuments).where(and(eq(ledgerSupplierDocuments.id, input.documentId), eq(ledgerSupplierDocuments.tenantId, input.tenantId))).limit(1);
  if (!doc) throw new LedgerError("transaction", "المستند غير موجود");
  if (doc.reversalTransactionId) return { replay: true };
  const [src] = rawRows(await d.execute(sql`SELECT sourceType AS s FROM ledger_transactions WHERE id = ${doc.transactionId}`));
  if (src?.s === "supplier_opening" && !input.isOwner) throw new LedgerError("ownerOnly", "إلغاء رصيد افتتاحي");
  const acc = await accounts(d, input.tenantId);
  const payable = acc.need("SUPPLIER_PAYABLE"), advances = acc.need("SUPPLIER_ADVANCES");
  const r = await reverseLedgerTransaction({ tenantId: input.tenantId, transactionId: doc.transactionId, idempotencyKey: `supplier-doc:${doc.id}:cancel`, effectiveDate: today(), reason: input.reason.trim(), actor: input.actor,
    guard: async (tx: any, { transactionId }: { transactionId: number }) => {
      await tx.execute(sql`SELECT id FROM ledger_suppliers WHERE id = ${doc.supplierId} FOR UPDATE`);
      if (doc.docType === "advance") {
        const [used] = rawRows(await tx.execute(sql`SELECT COUNT(*) AS n FROM ledger_supplier_documents WHERE appliesToDocumentId = ${doc.id} AND reversalTransactionId IS NULL`));
        if (Number(used?.n ?? 0) > 0) throw new LedgerError("conflict", "طُبّق من الدفعة المقدمة — ألغِ التطبيق أولًا");
      }
      if (affected(await tx.update(ledgerSupplierDocuments).set({ reversalTransactionId: transactionId }).where(and(eq(ledgerSupplierDocuments.id, doc.id), sql`${ledgerSupplierDocuments.reversalTransactionId} IS NULL`))) !== 1)
        throw new LedgerError("conflict", "المستند أُلغي بالفعل");
      // الـguard يعمل قبل إدراج قيود العكس ⇒ الرصيد المقروء قبل الإلغاء؛ أثر الإلغاء = عكس أثر المستند نفسه
      const amount = toMinorUnits(String(doc.amount));
      const payableEffect = doc.docType === "invoice" ? -amount : doc.docType === "payment" || doc.docType === "advance_application" || doc.docType === "return_credit" ? amount : 0n;
      const advanceEffect = doc.docType === "advance" ? -amount : doc.docType === "advance_application" ? amount : 0n;
      if ((await supplierBalance(tx, input.tenantId, doc.supplierId, payable.id, "credit", true)) + payableEffect < 0n) throw new LedgerError("conflict", "إلغاء الفاتورة يجعل المدفوع أكبر من المستحق — ألغِ الدفعة أولًا");
      if ((await supplierBalance(tx, input.tenantId, doc.supplierId, advances.id, "debit", true)) + advanceEffect < 0n) throw new LedgerError("conflict", "رصيد الدفعات المقدمة يصبح سالبًا");
    } }, d);
  return { replay: r.replay, transactionId: r.transactionId };
}

/** كشف المورد: الحركات بترتيبها، المستحق، المقدّم، والأعمار (FIFO على الاستحقاق). */
export async function supplierStatement(input: { tenantId: number; supplierId: number; asOf?: string }, db?: LedgerDb) {
  const d = await resolveDb(db);
  const sup = await supplierOf(d, input.tenantId, input.supplierId);
  const acc = await accounts(d, input.tenantId);
  const payable = acc.need("SUPPLIER_PAYABLE"), advances = acc.need("SUPPLIER_ADVANCES");
  const asOf = input.asOf ?? today();
  const ids = await supplierTxIds(d, input.tenantId, sup.id);
  const rows = ids.length === 0 ? [] : rawRows(await d.execute(sql`SELECT t.id, t.kind, t.sourceType AS src, t.description, DATE_FORMAT(t.effectiveDate, '%Y-%m-%d') AS date, t.reversalOfTransactionId AS rev,
      SUM(CASE WHEN e.accountId = ${payable.id} THEN (CASE WHEN e.side = 'credit' THEN e.amount ELSE -e.amount END) ELSE 0 END) AS payableDelta,
      SUM(CASE WHEN e.accountId = ${advances.id} THEN (CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END) ELSE 0 END) AS advanceDelta
    FROM ledger_transactions t JOIN ledger_entries e ON e.transactionId = t.id
    WHERE t.tenantId = ${input.tenantId} AND (t.id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)}) OR t.reversalOfTransactionId IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)}))
    GROUP BY t.id, t.kind, t.sourceType, t.description, t.effectiveDate, t.reversalOfTransactionId ORDER BY t.effectiveDate, t.id`));
  const signed = (v: unknown) => { const s = String(v ?? "0"); return s.startsWith("-") ? -toMinorUnits(s.slice(1)) : toMinorUnits(s); };
  let runPay = 0n, runAdv = 0n;
  const lines = rows.map((r: any) => {
    runPay += signed(r.payableDelta); runAdv += signed(r.advanceDelta);
    return { transactionId: Number(r.id), date: String(r.date), kind: String(r.kind), description: String(r.description), reversal: r.rev != null,
      payableDelta: fromMinorUnits(signed(r.payableDelta)), advanceDelta: fromMinorUnits(signed(r.advanceDelta)), payableBalance: fromMinorUnits(runPay), advanceBalance: fromMinorUnits(runAdv) };
  });
  // الأعمار: الزيادات (فاتورة/أجر/تصليح) بتاريخ استحقاقها، تُخصم منها النواقص (دفعة/مرتجع/تطبيق/عجز على الورشة) الأقدم أولًا
  const docs = await d.select().from(ledgerSupplierDocuments).where(and(eq(ledgerSupplierDocuments.tenantId, input.tenantId), eq(ledgerSupplierDocuments.supplierId, sup.id)));
  const dueOf = new Map(docs.filter(x => x.docType === "invoice").map(x => [x.transactionId, x.dueDate ?? x.docDate]));
  const reversed = new Set(rows.filter((r: any) => r.rev != null).map((r: any) => Number(r.rev)));
  const items: { due: string; amount: bigint }[] = []; let credits = 0n;
  for (const r of rows) {
    if (r.rev != null || reversed.has(Number(r.id))) continue;
    const delta = signed(r.payableDelta);
    if (delta > 0n) items.push({ due: dueOf.get(Number(r.id)) ?? String(r.date), amount: delta }); else credits += -delta;
  }
  items.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
  const buckets = { notDue: 0n, d1_30: 0n, d31_60: 0n, d61_90: 0n, d90plus: 0n };
  const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
  for (const it of items) {
    const take = credits >= it.amount ? it.amount : credits; credits -= take;
    const open = it.amount - take; if (open <= 0n) continue;
    const late = dayDiff(asOf, it.due);
    const k = late <= 0 ? "notDue" : late <= 30 ? "d1_30" : late <= 60 ? "d31_60" : late <= 90 ? "d61_90" : "d90plus";
    buckets[k] += open;
  }
  const openingTx = new Set(rows.filter((r: any) => r.src === "supplier_opening").map((r: any) => Number(r.id)));
  const advDocs = docs.filter(x => x.docType === "advance" && !x.reversalTransactionId);
  const advRem = await Promise.all(advDocs.map(async a => ({ documentId: a.id, docNo: a.docNo, remaining: fromMinorUnits(await advanceRemaining(d, a.id)) })));
  return {
    supplier: { id: sup.id, code: sup.code, name: sup.name, isWorkshop: sup.isWorkshop === 1, isActive: sup.isActive === 1 },
    payable: fromMinorUnits(runPay), advance: fromMinorUnits(runAdv), lines,
    aging: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, fromMinorUnits(v)])),
    documents: docs.sort((a, b) => b.id - a.id).map(x => ({ id: x.id, docType: x.docType, docNo: x.docNo, docDate: x.docDate, dueDate: x.dueDate, amount: String(x.amount), cancelled: x.reversalTransactionId != null, appliesToDocumentId: x.appliesToDocumentId, opening: openingTx.has(x.transactionId) })),
    advancesOpen: advRem.filter(a => toMinorUnits(a.remaining) > 0n),
  };
}

export async function listSuppliers(tenantId: number, db?: LedgerDb) {
  const d = await resolveDb(db);
  const a = await supplierAvailability(d);
  if (!a.ok) return { available: false as const, reason: !a.kinds ? "0046" : "0049", suppliers: [] };
  const sups = await d.select().from(ledgerSuppliers).where(eq(ledgerSuppliers.tenantId, tenantId)).orderBy(asc(ledgerSuppliers.name));
  const acc = await accounts(d, tenantId);
  const payable = acc.byCode.get("SUPPLIER_PAYABLE"), advances = acc.byCode.get("SUPPLIER_ADVANCES");
  const out = [];
  for (const s of sups) out.push({ id: s.id, code: s.code, name: s.name, phone: s.phone, isWorkshop: s.isWorkshop === 1, isActive: s.isActive === 1,
    payable: payable ? fromMinorUnits(await supplierBalance(d, tenantId, s.id, payable.id, "credit")) : null,
    advance: advances ? fromMinorUnits(await supplierBalance(d, tenantId, s.id, advances.id, "debit")) : null });
  return { available: true as const, accountsReady: Boolean(payable && advances), suppliers: out };
}

// ───────────── الورشة ─────────────

export async function createWorkshopBatch(input: { tenantId: number; supplierId: number; businessId: number; reference: string; pieceWage: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  const by = employeeOf(input.actor);
  const sup = await supplierOf(d, input.tenantId, input.supplierId);
  if (sup.isWorkshop !== 1) throw new LedgerError("conflict", "الدفعة لمورد مسجّل كورشة فقط");
  const [b] = await d.select({ id: businesses.id }).from(businesses).where(and(eq(businesses.id, input.businessId), eq(businesses.tenantId, input.tenantId))).limit(1);
  if (!b) throw new LedgerError("business", `#${input.businessId}`);
  const ref = input.reference.trim();
  if (ref.length < 2) throw new LedgerError("conflict", "مرجع الدفعة");
  const wage = toMinorUnits(input.pieceWage);
  if (wage < 0n) throw new LedgerError("amount", input.pieceWage);
  try {
    return { batchId: insertId(await d.insert(ledgerWorkshopBatches).values({ tenantId: input.tenantId, supplierId: sup.id, businessId: input.businessId, reference: ref, pieceWage: fromMinorUnits(wage), createdByEmployeeId: by })), replay: false };
  } catch {
    const [same] = await d.select().from(ledgerWorkshopBatches).where(and(eq(ledgerWorkshopBatches.tenantId, input.tenantId), eq(ledgerWorkshopBatches.reference, ref))).limit(1);
    if (same && same.supplierId === sup.id && same.businessId === input.businessId && toMinorUnits(String(same.pieceWage)) === wage) return { batchId: same.id, replay: true };
    throw new LedgerError("conflict", "مرجع الدفعة مستخدم");
  }
}

type BatchRow = typeof ledgerWorkshopBatches.$inferSelect;
const remainingOf = (b: BatchRow) => ({
  qty: b.sentQuantity - b.receivedQuantity - b.shortageQuantity,
  value: toMinorUnits(String(b.sentValue)) - toMinorUnits(String(b.receivedValue)) - toMinorUnits(String(b.shortageValue)),
});
/** قيمة q قطعة من العهدة بمتوسط الباقي؛ إن كانت q كل الباقي تأخذ القيمة الباقية بالضبط (لا فروق تقريب عالقة). */
const custodyValue = (b: BatchRow, q: number) => { const r = remainingOf(b); return q === r.qty ? r.value : divideRounded(r.value * BigInt(q), BigInt(r.qty)); };

/**
 * حدث ورشة بقيد واحد ومفتاح دائم (`workshop:<batch>:<op>`)؛ الحالة تُحدَّث داخل transaction القيد بعد قفل الدفعة، مع تحقق أن
 * الدفعة لم تتغير منذ حساب القيمة (المتزامن يُرفض ويُعاد).
 */
export async function recordWorkshopEvent(input: {
  tenantId: number; batchId: number; eventType: "send" | "receive" | "shortage" | "repair_cost"; quantity?: number; value?: string; chargeTo?: "workshop" | "loss";
  date: string; operationId: string; note?: string; actor: LedgerActor;
}, db?: LedgerDb) {
  const d = await resolveDb(db);
  const { goLiveDate } = await requireReady(d, input.tenantId);
  const by = employeeOf(input.actor);
  if (!OP_RE.test(input.operationId)) throw new LedgerError("conflict", "معرّف العملية");
  checkDate(input.date, goLiveDate);
  const [batch] = await d.select().from(ledgerWorkshopBatches).where(and(eq(ledgerWorkshopBatches.id, input.batchId), eq(ledgerWorkshopBatches.tenantId, input.tenantId))).limit(1);
  if (!batch) throw new LedgerError("transaction", "دفعة الورشة غير موجودة");
  const key = `workshop:${batch.id}:${input.operationId}`;
  const [done] = await d.select().from(ledgerWorkshopEvents).where(and(eq(ledgerWorkshopEvents.tenantId, input.tenantId), eq(ledgerWorkshopEvents.idempotencyKey, key))).limit(1);
  if (done) return { replay: true, transactionId: done.transactionId };
  const acc = await accounts(d, input.tenantId);
  const custody = acc.need("WORKSHOP_CUSTODY"), payable = acc.need("SUPPLIER_PAYABLE");
  const q = input.quantity ?? 0;
  const biz = batch.businessId;
  type E = { accountId: number; side: "debit" | "credit"; amount: string; businessId: number };
  const entries: E[] = []; const events: { eventType: "send" | "receive" | "shortage" | "repair_cost" | "wage"; quantity: number; value: bigint }[] = [];
  let next: Partial<BatchRow> = {};
  const rem = remainingOf(batch);
  if (input.eventType === "send") {
    if (batch.status === "closed") throw new LedgerError("conflict", "الدفعة مغلقة — افتح دفعة جديدة");
    const v = toMinorUnits(input.value ?? "0");
    if (!Number.isInteger(q) || q <= 0 || v <= 0n) throw new LedgerError("amount", "الكمية والقيمة موجبتان (القيمة من سجل المخزون)");
    const raw = acc.need("INV_RAW");
    entries.push({ accountId: custody.id, side: "debit", amount: fromMinorUnits(v), businessId: biz }, { accountId: raw.id, side: "credit", amount: fromMinorUnits(v), businessId: biz });
    events.push({ eventType: "send", quantity: q, value: v });
    next = { sentQuantity: batch.sentQuantity + q, sentValue: fromMinorUnits(toMinorUnits(String(batch.sentValue)) + v) };
  } else if (input.eventType === "receive" || input.eventType === "shortage") {
    if (!Number.isInteger(q) || q <= 0) throw new LedgerError("amount", "الكمية");
    if (q > rem.qty) throw new LedgerError("conflict", `الباقي لدى الورشة ${rem.qty} قطعة فقط`);
    const v = custodyValue(batch, q);
    if (input.eventType === "receive") {
      const goods = acc.need("INV_GOODS");
      const wage = toMinorUnits(String(batch.pieceWage)) * BigInt(q);
      entries.push({ accountId: goods.id, side: "debit", amount: fromMinorUnits(v), businessId: biz }, { accountId: custody.id, side: "credit", amount: fromMinorUnits(v), businessId: biz });
      if (wage > 0n) entries.push({ accountId: goods.id, side: "debit", amount: fromMinorUnits(wage), businessId: biz }, { accountId: payable.id, side: "credit", amount: fromMinorUnits(wage), businessId: biz });
      events.push({ eventType: "receive", quantity: q, value: v });
      if (wage > 0n) events.push({ eventType: "wage", quantity: q, value: wage });
      next = { receivedQuantity: batch.receivedQuantity + q, receivedValue: fromMinorUnits(toMinorUnits(String(batch.receivedValue)) + v) };
    } else {
      if (input.chargeTo !== "workshop" && input.chargeTo !== "loss") throw new LedgerError("invalid", "حدد: العجز على الورشة أم خسارة");
      const debit = input.chargeTo === "workshop" ? payable.id : acc.need("EXP_WORKSHOP_SHORTAGE").id;
      entries.push({ accountId: debit, side: "debit", amount: fromMinorUnits(v), businessId: biz }, { accountId: custody.id, side: "credit", amount: fromMinorUnits(v), businessId: biz });
      events.push({ eventType: "shortage", quantity: q, value: v });
      next = { shortageQuantity: batch.shortageQuantity + q, shortageValue: fromMinorUnits(toMinorUnits(String(batch.shortageValue)) + v) };
    }
  } else {
    const v = toMinorUnits(input.value ?? "0");
    if (v <= 0n) throw new LedgerError("amount", "قيمة التصليح");
    if (!input.note || input.note.trim().length < 3) throw new LedgerError("reason", "وصف التصليح");
    entries.push({ accountId: acc.need("EXP_REPAIRS").id, side: "debit", amount: fromMinorUnits(v), businessId: biz }, { accountId: payable.id, side: "credit", amount: fromMinorUnits(v), businessId: biz });
    events.push({ eventType: "repair_cost", quantity: 0, value: v });
  }
  const after = { ...batch, ...next } as BatchRow;
  const r2 = remainingOf(after);
  const status = after.sentQuantity > 0 && r2.qty === 0 ? "closed" : after.receivedQuantity + after.shortageQuantity > 0 ? "partially_received" : "open";
  const label = { send: "إرسال خامات", receive: "استلام من الورشة", shortage: "عجز لدى الورشة", repair_cost: "تصليح لدى الورشة" }[input.eventType];
  try {
    const r = await postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: biz, kind: "workshop", idempotencyKey: key, effectiveDate: input.date, currency: "EGP", actor: input.actor, entries,
      description: `${label} — دفعة ${batch.reference}${input.note ? `: ${input.note.trim()}` : ""}`, sourceType: "workshop", sourceReference: String(batch.id),
      guard: async (tx: any, { transactionId }: { transactionId: number }) => {
        const [now] = await tx.select().from(ledgerWorkshopBatches).where(eq(ledgerWorkshopBatches.id, batch.id)).for("update");
        if (!now || now.sentQuantity !== batch.sentQuantity || now.receivedQuantity !== batch.receivedQuantity || now.shortageQuantity !== batch.shortageQuantity
          || String(now.sentValue) !== String(batch.sentValue) || String(now.receivedValue) !== String(batch.receivedValue) || String(now.shortageValue) !== String(batch.shortageValue))
          throw new LedgerError("conflict", "الدفعة تغيّرت أثناء التسجيل — أعد المحاولة");
        if (input.eventType === "shortage" && input.chargeTo === "workshop") {
          // الـguard قبل إدراج قيود الحدث ⇒ المستحق المقروء قبل العجز
          const due = await supplierBalance(tx, input.tenantId, batch.supplierId, payable.id, "credit", true);
          if (due < toMinorUnits(entries[0].amount)) throw new LedgerError("conflict", "لا مستحق للورشة يغطي العجز — سجّله خسارة أو بعد استحقاق أجورها");
        }
        if (Object.keys(next).length || status !== batch.status) await tx.update(ledgerWorkshopBatches).set({ ...next, status }).where(eq(ledgerWorkshopBatches.id, batch.id));
        for (const [i, ev] of events.entries())
          await tx.insert(ledgerWorkshopEvents).values({ tenantId: input.tenantId, batchId: batch.id, eventType: ev.eventType, quantity: ev.quantity, value: fromMinorUnits(ev.value), transactionId,
            idempotencyKey: i === 0 ? key : `${key}:${ev.eventType}`.slice(0, 191), actorEmployeeId: by, note: input.note?.trim().slice(0, 500) || null });
      } } as any, d);
    return { replay: r.replay, transactionId: r.transactionId };
  } catch (e) {
    const [again] = await d.select().from(ledgerWorkshopEvents).where(and(eq(ledgerWorkshopEvents.tenantId, input.tenantId), eq(ledgerWorkshopEvents.idempotencyKey, key))).limit(1);
    if (again) return { replay: true, transactionId: again.transactionId };
    throw e;
  }
}

/**
 * تصحيح حدث ورشة بالعكس (قيد عكسي لقيد الحدث كله — الاستلام مع أجره)، بسبب مكتوب وفاعل، مرة واحدة (عكس الحركة فريد في الدفتر):
 *  • أحداث الكمية (إرسال/استلام/عجز) من الأحدث للأقدم داخل الدفعة: حدث كمية بعده أحداث كمية غير معكوسة يُرفض مع ذكرها — قيمة
 *    الاستلامات/العجز اللاحقة حُسبت بمتوسط الباقي بعده؛ العكس بالترتيب يعيد الكميات والقيمة لما قبل الحدث بالضبط.
 *  • التصليح لا يغيّر العهدة ⇒ يُعكس في أي وقت.
 *  • ما يُنقص مستحق الورشة (أجر استلام، تصليح) يُرفض إن جعله سالبًا (سُدد بالفعل) — تُعكس الدفعة أولًا.
 *  • عداد الدفعة وحالتها يُحدَّثان داخل transaction القيد بعد قفل الدفعة؛ التزامن المتغيّر يُرفض ويُعاد.
 */
export async function reverseWorkshopEvent(input: { tenantId: number; eventId: number; reason: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await requireReady(d, input.tenantId);
  employeeOf(input.actor);
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 3) throw new LedgerError("reason");
  const [ev] = await d.select().from(ledgerWorkshopEvents).where(and(eq(ledgerWorkshopEvents.id, input.eventId), eq(ledgerWorkshopEvents.tenantId, input.tenantId))).limit(1);
  if (!ev || !ev.transactionId) throw new LedgerError("transaction", "حدث الورشة غير موجود");
  const txEvents = await d.select().from(ledgerWorkshopEvents).where(and(eq(ledgerWorkshopEvents.tenantId, input.tenantId), eq(ledgerWorkshopEvents.transactionId, ev.transactionId)));
  const main = txEvents.find(e => e.eventType !== "wage") ?? ev;
  const [already] = rawRows(await d.execute(sql`SELECT id FROM ledger_transactions WHERE tenantId = ${input.tenantId} AND reversalOfTransactionId = ${ev.transactionId}`));
  if (already) return { replay: true, transactionId: Number(already.id) };
  const [batch] = await d.select().from(ledgerWorkshopBatches).where(eq(ledgerWorkshopBatches.id, main.batchId)).limit(1);
  const acc = await accounts(d, input.tenantId);
  const payable = acc.need("SUPPLIER_PAYABLE");
  const quantityTypes = ["send", "receive", "shortage"];
  const isQty = quantityTypes.includes(main.eventType);
  const q = main.quantity, v = toMinorUnits(String(main.value));
  const wage = txEvents.filter(e => e.eventType === "wage").reduce((s2, e) => s2 + toMinorUnits(String(e.value)), 0n);
  const payableDrop = main.eventType === "receive" ? wage : main.eventType === "repair_cost" ? v : 0n;
  const next: Partial<BatchRow> = main.eventType === "send" ? { sentQuantity: batch.sentQuantity - q, sentValue: fromMinorUnits(toMinorUnits(String(batch.sentValue)) - v) }
    : main.eventType === "receive" ? { receivedQuantity: batch.receivedQuantity - q, receivedValue: fromMinorUnits(toMinorUnits(String(batch.receivedValue)) - v) }
    : main.eventType === "shortage" ? { shortageQuantity: batch.shortageQuantity - q, shortageValue: fromMinorUnits(toMinorUnits(String(batch.shortageValue)) - v) } : {};
  const after = { ...batch, ...next } as BatchRow;
  const r2 = remainingOf(after);
  const status = after.sentQuantity > 0 && r2.qty === 0 ? "closed" : after.receivedQuantity + after.shortageQuantity > 0 ? "partially_received" : "open";
  const r = await reverseLedgerTransaction({ tenantId: input.tenantId, transactionId: ev.transactionId, idempotencyKey: `workshop-reverse:${ev.transactionId}`, effectiveDate: today(),
    reason: `تصحيح حدث ورشة (${main.eventType}) — دفعة ${batch.reference}: ${reason}`, actor: input.actor,
    guard: async (tx: any) => {
      const [now] = await tx.select().from(ledgerWorkshopBatches).where(eq(ledgerWorkshopBatches.id, batch.id)).for("update");
      if (!now || now.sentQuantity !== batch.sentQuantity || now.receivedQuantity !== batch.receivedQuantity || now.shortageQuantity !== batch.shortageQuantity
        || String(now.sentValue) !== String(batch.sentValue) || String(now.receivedValue) !== String(batch.receivedValue) || String(now.shortageValue) !== String(batch.shortageValue))
        throw new LedgerError("conflict", "الدفعة تغيّرت أثناء التصحيح — أعد المحاولة");
      if (isQty) {
        // أحداث كمية لاحقة غير معكوسة تعتمد على هذا الحدث
        const later = rawRows(await tx.execute(sql`SELECT ev.id, ev.eventType AS t FROM ledger_workshop_events ev
          WHERE ev.tenantId = ${input.tenantId} AND ev.batchId = ${batch.id} AND ev.id > ${main.id} AND ev.eventType IN ('send','receive','shortage') AND ev.transactionId <> ${ev.transactionId}
            AND NOT EXISTS (SELECT 1 FROM ledger_transactions r WHERE r.tenantId = ev.tenantId AND r.reversalOfTransactionId = ev.transactionId)`));
        if (later.length) throw new LedgerError("conflict", `أحداث لاحقة تعتمد على هذا الحدث: ${later.map((x: any) => `#${x.id} (${x.t})`).join("، ")} — تُعكس من الأحدث للأقدم`);
        if (r2.qty < 0 || r2.value < 0n) throw new LedgerError("conflict", "العكس يجعل العهدة سالبة");
      }
      if (payableDrop > 0n) {
        const due = await supplierBalance(tx, input.tenantId, batch.supplierId, payable.id, "credit", true);
        if (due < payableDrop) throw new LedgerError("conflict", `مستحق الورشة ${fromMinorUnits(due)} أقل من ${fromMinorUnits(payableDrop)} (سُدد) — اعكس الدفعة للورشة أولًا`);
      }
      if (Object.keys(next).length || status !== batch.status) await tx.update(ledgerWorkshopBatches).set({ ...next, status }).where(eq(ledgerWorkshopBatches.id, batch.id));
    } }, d);
  return { replay: r.replay, transactionId: r.transactionId };
}

export async function listWorkshopBatches(tenantId: number, supplierId: number, db?: LedgerDb) {
  const d = await resolveDb(db);
  await supplierOf(d, tenantId, supplierId);
  const batches = await d.select().from(ledgerWorkshopBatches).where(and(eq(ledgerWorkshopBatches.tenantId, tenantId), eq(ledgerWorkshopBatches.supplierId, supplierId))).orderBy(desc(ledgerWorkshopBatches.id));
  const ids = batches.map(b => b.id);
  const events = ids.length ? await d.select().from(ledgerWorkshopEvents).where(and(eq(ledgerWorkshopEvents.tenantId, tenantId), inArray(ledgerWorkshopEvents.batchId, ids))).orderBy(asc(ledgerWorkshopEvents.id)) : [];
  const txIds = events.map(e => e.transactionId).filter((x): x is number => x != null);
  const revs = txIds.length ? rawRows(await d.execute(sql`SELECT r.reversalOfTransactionId AS o, r.id, r.description, r.actorEmployeeId AS a, DATE_FORMAT(r.effectiveDate, '%Y-%m-%d') AS date
    FROM ledger_transactions r WHERE r.tenantId = ${tenantId} AND r.reversalOfTransactionId IN (${sql.join(txIds.map(i => sql`${i}`), sql`, `)})`)) : [];
  const revBy = new Map(revs.map((x: any) => [Number(x.o), { transactionId: Number(x.id), description: String(x.description), actorEmployeeId: x.a == null ? null : Number(x.a), date: String(x.date) }]));
  return batches.map(b => { const r = remainingOf(b); return { ...b, remainingQuantity: r.qty, remainingValue: fromMinorUnits(r.value),
    events: events.filter(e => e.batchId === b.id).map(e => ({ ...e, reversal: e.transactionId ? revBy.get(e.transactionId) ?? null : null })) }; });
}
