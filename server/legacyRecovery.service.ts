import { ClientSafeError } from "./logSafety";
import { sql } from "drizzle-orm";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { postFinancialTransactionInTransaction } from "./accountingV2.service";
import { addTreasuryTransactionInTransaction } from "./db";
import { canonicalJson, figuresHash } from "./ledgerClose.service";
import { rawRows, resolveDb, type LedgerDb } from "./ledgerV3.service";
import { isOwnerRole } from "./permissions";
import { tenantAccessEnforcementEnabled } from "./tenantAccess";

/**
 * خطة الرجوع «توقف ومطابقة» (بعد 0051) — طريقة واحدة: **إدخال أرصدة التوقف** في V1/V2 (لا إعادة حركات V3، فلا يتكرر الأثر).
 *
 * الشروط المشتركة (داخل transaction واحدة، بعد قفل صف العلم FOR UPDATE — يتسلسل مع التفعيل/الإطفاء/أي استعادة أخرى، ويمنع ترحيل
 * V3 لأن الترحيل يقرأ العلم FOR SHARE):
 *   • الشركة فُعّل لها V3 يومًا (enabledAt) و**V3 مطفأ الآن**؛ الشركة `suspended` (FOR SHARE) و`TENANT_ACCESS_ENFORCEMENT_ENABLED=true`
 *     في بيئة التشغيل — فلا تشغيل عادي أثناء الإدخال؛ الفاعل **مالك فعّال من نفس الشركة** (الدور، لا مجرد FK).
 *
 * `takeStopSnapshot`: صورة أرصدة كل حسابات V3 (ومعها آخر حركة ولحظة التفعيل) ببصمة sha256 لصيغة JSON قانونية — حدث stop_snapshot
 *   دائم. نفس الأرقام لنفس التفعيل = replay.
 *
 * `recoverLegacyFromSnapshot` (كل شيء أو لا شيء):
 *   1. replay: حدث recovery لنفس الصورة موجود ⇒ يُعاد بلا أي كتابة.
 *   2. الصورة لنفس الشركة ولنفس التفعيل الحالي، ولا إعادة تفعيل بعدها، ولا رفع سابق لهذا التفعيل؛ البصمة المخزنة = بصمة JSON المخزن =
 *      البصمة الممرّرة = بصمة أرقام V3 الآن (لا حركة V3 منذ الصورة).
 *   3. خريطة صريحة: كل حساب نقدي/بنكي/محفظة بقيمة غير صفرية ← هدف قديم واحد (خزنة V1 لنشاط، أو حساب V2)؛ باقي الحسابات غير الصفرية
 *      تُذكر صراحةً في acknowledgedNonCash (تُتابَع خارج V1/V2)؛ كل هدف قديم نقدي برصيد غير صفري خارج الخريطة يجب أن يُذكر في
 *      zeroTargets — فلا يبقى رصيد قديم «مجمّد» بجانب رصيد التوقف. التصفير **ليس** لمجرد غياب مقابل في V3: لكل هدف تفسير موثّق
 *      ومرجع مطابقة والرصيد الذي طُوبق (= الرصيد الحالي بالضبط) واعتماد صريح من مالك فعّال لنفس الشركة؛ أي هدف غير محسوم
 *      (ناقص أو غير مطابق) يمنع التنفيذ كله. هدف مكرر مرفوض؛ V1 بأكثر من منزلتين مرفوض.
 *   4. **معالجة الأرصدة القائمة في V1/V2**: لا يُدخل رصيد التوقف فوقها (يتضاعف)؛ يُقرأ الرصيد الحالي ويُرحَّل **الفرق فقط**
 *      (تسوية V1 من نوع adjustment، أو حركة V2 من نوع recovery_adjustment بمرجع الصورة) — بلا حذف أو تعديل أي تاريخ.
 *   5. حدث lift ثم الترحيل ثم إعادة القراءة: كل هدف = رصيد الصورة بالضبط وإلا يُلغى كل شيء؛ ثم حدث recovery بالنتيجة وبصمتها.
 *   أي فشل ⇒ rollback كامل: لا lift، لا ترحيل، الحظر قائم، والشركة تبقى متوقفة. رفع الإيقاف خطوة لاحقة منفصلة لمدير المنصة.
 */
export class LegacyRecoveryError extends ClientSafeError {
  constructor(readonly code: string, message: string) { super(message); this.name = "LegacyRecoveryError"; }
}
/** عبارة تأكيد السكربت (apply) — باسم الشركة والقاعدة. */
export const recoveryConfirmPhrase = (mode: "snapshot" | "recover", tenantId: number, database: string) => `${mode === "snapshot" ? "SNAPSHOT" : "RECOVER"} LEGACY TENANT ${tenantId} ON ${database}`;
const fail = (code: string, message: string): never => { throw new LegacyRecoveryError(code, message); };

export type LegacyTarget = { kind: "v1_treasury"; businessId: number } | { kind: "v2_account"; accountId: number };
export type RecoveryPlan = {
  snapshotEventId: number;
  figuresHash: string;
  cash: { code: string; target: LegacyTarget }[];
  acknowledgedNonCash: string[];
  zeroTargets: ZeroTarget[];
};
/** تصفير هدف قديم بلا مقابل في V3 — محسوم فقط بتفسير ومطابقة واعتماد صريح داخل ملف الاستعادة. */
export type ZeroTarget = {
  target: LegacyTarget;
  /** الرصيد الذي طُوبق فعليًا — يجب أن يساوي الرصيد القديم الحالي بالضبط. */
  reconciledBalance: string;
  /** لماذا لا مقابل له في V3 (10 أحرف على الأقل). */
  explanation: string;
  /** مرجع مستند المطابقة (كشف/محضر). */
  evidenceRef: string;
  /** مالك فعّال من نفس الشركة يعتمد التصفير صراحةً. */
  approvedByEmployeeId: number;
};
export const MIN_ZERO_EXPLANATION = 10;
export type SnapshotFigures = { tenantId: number; activationAtMs: number; lastTransactionId: number; balances: { code: string; kind: string; currency: string; balance: string }[] };

/** أنواع لا تُستعاد إلا بهدف قديم صريح (لا تُقبل في acknowledgedNonCash). */
export const MUST_MAP_KINDS = new Set(["cash", "bank", "wallet"]);
const targetKey = (t: LegacyTarget) => (t.kind === "v1_treasury" ? `v1:${t.businessId}` : `v2:${t.accountId}`);
const noTable = (e: unknown) => { for (let x: any = e, i = 0; x && i < 6; x = x.cause, i++) if (x.code === "ER_NO_SUCH_TABLE") return true; return false; };
const money = (v: unknown) => fromMinorUnits(toMinorUnits(String(v ?? "0")));
type Tx = any;

async function lockStopConditions(tx: Tx, tenantId: number, actorEmployeeId: number) {
  let flag: any;
  try {
    [flag] = rawRows(await tx.execute(sql`SELECT ledgerV3Enabled AS enabled, UNIX_TIMESTAMP(enabledAt) * 1000 AS ms FROM ledger_tenant_flags WHERE tenantId = ${tenantId} FOR UPDATE`));
    await tx.execute(sql`SELECT 1 FROM ledger_legacy_archive_events WHERE tenantId = ${tenantId} LIMIT 1 FOR SHARE`);
  } catch (e) {
    if (noTable(e)) fail("tableMissing", "جداول Ledger V3 أو سجل الأرشيف (0051) غير موجودة — لا رفع للحظر");
    throw e;
  }
  if (!flag || flag.ms == null) fail("neverActivated", "الشركة لم تُفعِّل Ledger V3 قط — لا حظر لرفعه");
  const [emp] = rawRows(await tx.execute(sql`SELECT id, name, role, isActive FROM employees WHERE id = ${actorEmployeeId} AND tenantId = ${tenantId} LIMIT 1 FOR SHARE`));
  if (!emp || !Number(emp.isActive) || !isOwnerRole(String(emp.role))) fail("actor", "الإجراء للمالك الفعّال من نفس الشركة وحده");
  return { activationAtMs: Math.round(Number(flag.ms)), v3Enabled: Number(flag.enabled) === 1, actor: { id: Number(emp.id), name: String(emp.name) } };
}

async function assertStopped(tx: Tx, tenantId: number, v3Enabled: boolean) {
  if (v3Enabled) fail("v3Enabled", "Ledger V3 ما زال مفعّلًا — أطفئه أولًا (الإطفاء لا يرفع الحظر)");
  const [t] = rawRows(await tx.execute(sql`SELECT status FROM tenants WHERE id = ${tenantId} FOR SHARE`));
  if (String(t?.status ?? "") !== "suspended") fail("notSuspended", "الشركة غير متوقفة (tenants.status ≠ suspended) — أوقفها أولًا");
  if (!tenantAccessEnforcementEnabled()) fail("enforcement", "TENANT_ACCESS_ENFORCEMENT_ENABLED ليس true في هذه البيئة — الإيقاف غير مُطبَّق فعليًا");
}

/** أرقام V3 الحالية للشركة: رصيد كل حساب (بجهة طبيعته) وآخر حركة ولحظة التفعيل. */
export async function currentV3Figures(tx: Tx, tenantId: number, activationAtMs: number): Promise<SnapshotFigures> {
  const balances = rawRows(await tx.execute(sql`SELECT a.code, a.kind, a.currency, COALESCE(SUM(CASE WHEN e.side = a.normalSide THEN e.amount ELSE -e.amount END), 0) AS balance
    FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.accountId = a.id WHERE a.tenantId = ${tenantId} GROUP BY a.id, a.code, a.kind, a.currency ORDER BY a.code`))
    .map((r: any) => ({ code: String(r.code), kind: String(r.kind), currency: String(r.currency), balance: money(r.balance) }));
  const [last] = rawRows(await tx.execute(sql`SELECT COALESCE(MAX(id), 0) AS id FROM ledger_transactions WHERE tenantId = ${tenantId}`));
  return { tenantId, activationAtMs, lastTransactionId: Number(last?.id ?? 0), balances };
}

export async function takeStopSnapshot(input: { tenantId: number; actorEmployeeId: number; reason: string; apply: boolean }, db?: LedgerDb) {
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3) fail("input", "السبب إلزامي (3 أحرف على الأقل)");
  const d = await resolveDb(db);
  return d.transaction(async (tx: Tx) => {
    const c = await lockStopConditions(tx, input.tenantId, input.actorEmployeeId);
    await assertStopped(tx, input.tenantId, c.v3Enabled);
    const figures = await currentV3Figures(tx, input.tenantId, c.activationAtMs);
    const hash = figuresHash(figures);
    const dedupeKey = `snapshot:${c.activationAtMs}:${hash}`;
    const [existing] = rawRows(await tx.execute(sql`SELECT id FROM ledger_legacy_archive_events WHERE tenantId = ${input.tenantId} AND dedupeKey = ${dedupeKey} FOR SHARE`));
    if (existing) return { applied: true, replay: true, snapshotEventId: Number(existing.id), figuresHash: hash, figures };
    if (!input.apply) return { applied: false, replay: false, snapshotEventId: null, figuresHash: hash, figures };
    const r = await tx.execute(sql`INSERT INTO ledger_legacy_archive_events (tenantId, action, activationAt, dedupeKey, figuresJson, figuresHash, reason, actorEmployeeId)
      SELECT tenantId, 'stop_snapshot', enabledAt, ${dedupeKey}, ${canonicalJson(figures)}, ${hash}, ${reason}, ${c.actor.id} FROM ledger_tenant_flags WHERE tenantId = ${input.tenantId}`);
    return { applied: true, replay: false, snapshotEventId: Number((Array.isArray(r) ? r[0] : r)?.insertId), figuresHash: hash, figures };
  });
}

type LegacyRow = { key: string; target: LegacyTarget; balance: bigint; currency: string | null; cash: boolean };

/**
 * الأهداف القديمة للشركة وأرصدتها الحالية (V1: آخر balanceAfter لكل نشاط؛ V2: currentBalance مقفول FOR UPDATE). كتابات V1/V2 الأخرى
 * محظورة طوال الـtransaction (الرفع غير ملتزم بعد)، والترحيل نفسه يقفل آخر صف V1 قبل حسابه.
 */
async function legacyBalances(tx: Tx, tenantId: number): Promise<Map<string, LegacyRow>> {
  const out = new Map<string, LegacyRow>();
  try {
    const rows = rawRows(await tx.execute(sql`SELECT b.id AS businessId,
        (SELECT t.balanceAfter FROM treasury_transactions t WHERE t.businessId = b.id ORDER BY t.id DESC LIMIT 1) AS bal
      FROM businesses b WHERE b.tenantId = ${tenantId}`));
    for (const r of rows) { const t: LegacyTarget = { kind: "v1_treasury", businessId: Number(r.businessId) }; out.set(targetKey(t), { key: targetKey(t), target: t, balance: toMinorUnits(String(r.bal ?? "0")), currency: null, cash: true }); }
  } catch (e) { if (!noTable(e)) throw e; }
  try {
    const rows = rawRows(await tx.execute(sql`SELECT fa.id, fa.currencyCode AS currency, fa.currentBalance AS bal, fa.isCashEquivalent AS cash
      FROM financial_accounts fa JOIN businesses b ON b.id = fa.businessId WHERE b.tenantId = ${tenantId} ORDER BY fa.id FOR UPDATE`));
    for (const r of rows) { const t: LegacyTarget = { kind: "v2_account", accountId: Number(r.id) }; out.set(targetKey(t), { key: targetKey(t), target: t, balance: toMinorUnits(String(r.bal ?? "0")), currency: String(r.currency), cash: Number(r.cash) === 1 }); }
  } catch (e) { if (!noTable(e)) throw e; }
  return out;
}

export type RecoveryLine = { code: string | null; target: string; before: string; after: string; delta: string };

export async function recoverLegacyFromSnapshot(input: {
  tenantId: number; actorEmployeeId: number; reason: string; plan: RecoveryPlan; apply: boolean;
  /** اختبارات فقط: يُستدعى بعد الترحيل وقبل التحقق — أي رمي يُثبت أن الـrollback كامل. */
  __afterPostingForTests?: (tx: Tx) => Promise<void>;
}, db?: LedgerDb) {
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3) fail("input", "السبب إلزامي (3 أحرف على الأقل)");
  const p = input.plan;
  if (!p || !Number.isInteger(p.snapshotEventId) || !/^[0-9a-f]{64}$/.test(String(p.figuresHash)) || !Array.isArray(p.cash) || !Array.isArray(p.acknowledgedNonCash) || !Array.isArray(p.zeroTargets))
    fail("input", "خطة الاستعادة غير صالحة: snapshotEventId وfiguresHash وcash وacknowledgedNonCash وzeroTargets إلزامية");
  const d = await resolveDb(db);
  return d.transaction(async (tx: Tx) => {
    const c = await lockStopConditions(tx, input.tenantId, input.actorEmployeeId);
    const recoveryKey = `recovery:${p.snapshotEventId}`;
    const [done] = rawRows(await tx.execute(sql`SELECT id, figuresJson AS j FROM ledger_legacy_archive_events WHERE tenantId = ${input.tenantId} AND dedupeKey = ${recoveryKey} FOR SHARE`));
    if (done) return { applied: true, replay: true, recoveryEventId: Number(done.id), lines: (typeof done.j === "string" ? JSON.parse(done.j) : done.j).lines as RecoveryLine[] };
    await assertStopped(tx, input.tenantId, c.v3Enabled);

    // الصورة: لنفس الشركة، stop_snapshot، لنفس التفعيل الحالي، وبصمتها سليمة ومطابقة للممرّرة
    const [snap] = rawRows(await tx.execute(sql`SELECT e.id, e.action, e.figuresJson AS j, e.figuresHash AS h, (e.activationAt = f.enabledAt) AS same
      FROM ledger_legacy_archive_events e JOIN ledger_tenant_flags f ON f.tenantId = e.tenantId WHERE e.id = ${p.snapshotEventId} AND e.tenantId = ${input.tenantId} FOR SHARE`));
    if (!snap || snap.action !== "stop_snapshot") fail("snapshotNotFound", `صورة التوقف #${p.snapshotEventId} غير موجودة لهذه الشركة`);
    if (Number(snap.same) !== 1) fail("snapshotStale", "الصورة لتفعيل سابق — خذ صورة جديدة للتفعيل الحالي");
    const stored: SnapshotFigures = typeof snap.j === "string" ? JSON.parse(snap.j) : snap.j;
    if (figuresHash(stored) !== String(snap.h) || String(snap.h) !== p.figuresHash) fail("hashMismatch", "بصمة الصورة لا تطابق (المخزنة/المحسوبة/الممرّرة)");
    const [last] = rawRows(await tx.execute(sql`SELECT id, action FROM ledger_legacy_archive_events WHERE tenantId = ${input.tenantId} AND action IN ('lift', 'reapply') ORDER BY id DESC LIMIT 1 FOR SHARE`));
    if (last?.action === "reapply" && Number(last.id) > p.snapshotEventId) fail("snapshotStale", "أُعيد تفعيل V3 بعد الصورة — خذ صورة جديدة");
    if (last?.action === "lift") {
      const [same] = rawRows(await tx.execute(sql`SELECT (e.activationAt = f.enabledAt) AS same FROM ledger_legacy_archive_events e JOIN ledger_tenant_flags f ON f.tenantId = e.tenantId WHERE e.id = ${last.id}`));
      if (Number(same?.same) === 1) fail("alreadyLifted", "الحظر مرفوع بالفعل لهذا التفعيل بصورة أخرى — لا استعادة ثانية");
    }
    const now = await currentV3Figures(tx, input.tenantId, c.activationAtMs);
    if (figuresHash(now) !== p.figuresHash) fail("v3Moved", "أرقام V3 تغيّرت منذ الصورة — لا استعادة (خذ صورة جديدة بعد التحقيق)");

    // الخريطة
    const byCode = new Map(stored.balances.map(b => [b.code, b]));
    const legacy = await legacyBalances(tx, input.tenantId);
    const mappedCodes = new Set<string>(); const usedTargets = new Set<string>();
    const desired = new Map<string, { code: string | null; target: LegacyRow; amount: bigint }>();
    for (const m of p.cash) {
      const acc = byCode.get(String(m?.code));
      if (!acc) fail("mapping", `الحساب ${m?.code} غير موجود في الصورة`);
      if (mappedCodes.has(acc!.code)) fail("mapping", `الحساب ${acc!.code} مكرر في الخريطة`);
      const key = m?.target ? targetKey(m.target) : "";
      const t = legacy.get(key);
      if (!t) fail("mapping", `الهدف ${key || "؟"} ليس خزنة V1 أو حساب V2 لأنشطة هذه الشركة`);
      if (usedTargets.has(key)) fail("mapping", `الهدف ${key} مستخدم لأكثر من حساب`);
      const amount = toMinorUnits(acc!.balance);
      if (t!.target.kind === "v1_treasury") {
        if (acc!.currency !== "EGP") fail("mapping", `خزنة V1 بالجنيه فقط — ${acc!.code} بعملة ${acc!.currency}`);
        if (amount % 100n !== 0n) fail("mapping", `رصيد ${acc!.code} (${acc!.balance}) بأكثر من منزلتين — لا يُدخل في خزنة V1 بلا تقريب`);
        if (amount >= 10_000_000_000n * 100n || amount <= -10_000_000_000n * 100n) fail("mapping", `رصيد ${acc!.code} خارج سعة خزنة V1`);
      } else if (t!.currency !== acc!.currency) fail("mapping", `عملة ${key} (${t!.currency}) ≠ عملة ${acc!.code} (${acc!.currency})`);
      if (!t!.cash) fail("mapping", `${key} ليس حسابًا نقديًا في V2`);
      mappedCodes.add(acc!.code); usedTargets.add(key);
      desired.set(key, { code: acc!.code, target: t!, amount });
    }
    const zeroed: (ZeroTarget & { key: string; approvedBy: string })[] = [];
    for (const z of p.zeroTargets) {
      const key = z?.target ? targetKey(z.target) : "";
      const t = legacy.get(key);
      if (!t) fail("mapping", `هدف التصفير ${key || "؟"} غير موجود لهذه الشركة`);
      if (usedTargets.has(key)) fail("mapping", `الهدف ${key} مكرر`);
      // غير محسوم = يمنع التنفيذ: تفسير + مرجع مطابقة + رصيد مطابق للحالي + اعتماد مالك نفس الشركة
      if (String(z.explanation ?? "").trim().length < MIN_ZERO_EXPLANATION) fail("unresolved", `تصفير ${key}: التفسير الموثّق إلزامي (${MIN_ZERO_EXPLANATION} أحرف على الأقل)`);
      if (String(z.evidenceRef ?? "").trim().length < 3) fail("unresolved", `تصفير ${key}: مرجع مستند المطابقة إلزامي`);
      if (!/^-?\d{1,14}(\.\d{1,4})?$/.test(String(z.reconciledBalance ?? "")) || toMinorUnits(String(z.reconciledBalance)) !== t!.balance)
        fail("unresolved", `تصفير ${key}: الرصيد المطابَق (${z.reconciledBalance ?? "—"}) ≠ الرصيد الحالي ${fromMinorUnits(t!.balance)} — أعد المطابقة`);
      const [ap] = rawRows(await tx.execute(sql`SELECT id, name, role, isActive FROM employees WHERE id = ${Number(z.approvedByEmployeeId) || 0} AND tenantId = ${input.tenantId} LIMIT 1 FOR SHARE`));
      if (!ap || !Number(ap.isActive) || !isOwnerRole(String(ap.role))) fail("unresolved", `تصفير ${key}: الاعتماد الصريح لمالك فعّال من نفس الشركة إلزامي`);
      usedTargets.add(key); desired.set(key, { code: null, target: t!, amount: 0n });
      zeroed.push({ ...z, key, explanation: String(z.explanation).trim(), evidenceRef: String(z.evidenceRef).trim(), approvedBy: String(ap.name) });
    }
    const ack = new Set(p.acknowledgedNonCash.map(String));
    for (const b of stored.balances) {
      const nonzero = toMinorUnits(b.balance) !== 0n;
      if (ack.has(b.code)) {
        if (MUST_MAP_KINDS.has(b.kind)) fail("mapping", `${b.code} (${b.kind}) نقدي — يجب ربطه بهدف قديم لا الإقرار به`);
        if (mappedCodes.has(b.code)) fail("mapping", `${b.code} مربوط ومُقرّ به معًا`);
        if (!nonzero) fail("mapping", `${b.code} صفري — لا داعي للإقرار به`);
      } else if (nonzero && !mappedCodes.has(b.code)) {
        fail("mapping", MUST_MAP_KINDS.has(b.kind) ? `الحساب النقدي ${b.code} (${b.balance}) بلا هدف قديم` : `${b.code} (${b.balance}) غير مربوط وغير مُقرّ به في acknowledgedNonCash`);
      }
    }
    for (const a of ack) if (!byCode.has(a)) fail("mapping", `${a} غير موجود في الصورة`);
    for (const t of legacy.values()) if (t.cash && t.balance !== 0n && !usedTargets.has(t.key)) fail("unresolved", `الهدف القديم ${t.key} برصيد ${fromMinorUnits(t.balance)} غير محسوم — اربطه بحساب V3 أو صفّره بتفسير ومطابقة واعتماد في zeroTargets`);

    const lines: RecoveryLine[] = [...desired.entries()].map(([key, x]) => ({ code: x.code, target: key, before: fromMinorUnits(x.target.balance), after: fromMinorUnits(x.amount), delta: fromMinorUnits(x.amount - x.target.balance) }));
    if (!input.apply) return { applied: false, replay: false, recoveryEventId: null, lines };

    // الرفع أولًا داخل نفس الـtransaction (لا يراه غيرها قبل الالتزام) — ثم الفروق فقط
    await tx.execute(sql`INSERT INTO ledger_legacy_archive_events (tenantId, action, activationAt, dedupeKey, snapshotEventId, figuresHash, reason, actorEmployeeId)
      SELECT tenantId, 'lift', enabledAt, ${`lift:${p.snapshotEventId}`}, ${p.snapshotEventId}, ${p.figuresHash}, ${reason}, ${c.actor.id} FROM ledger_tenant_flags WHERE tenantId = ${input.tenantId}`);
    const ref = `ledger-v3-recovery:snapshot:${p.snapshotEventId}`;
    for (const x of desired.values()) {
      const delta = x.amount - x.target.balance;
      if (delta === 0n) continue;
      const abs = fromMinorUnits(delta < 0n ? -delta : delta);
      const description = `استعادة رصيد التوقف من Ledger V3${x.code ? ` (${x.code})` : " (تصفير)"} — صورة #${p.snapshotEventId}`;
      if (x.target.target.kind === "v1_treasury") {
        await addTreasuryTransactionInTransaction(tx, { businessId: x.target.target.businessId, type: "adjustment", direction: delta > 0n ? "in" : "out", amount: abs,
          description, notes: ref, referenceType: "manual", performedBy: c.actor.id, performedByName: c.actor.name } as any);
      } else {
        const [acc] = rawRows(await tx.execute(sql`SELECT businessId FROM financial_accounts WHERE id = ${x.target.target.accountId}`));
        await postFinancialTransactionInTransaction(tx, { businessId: Number(acc.businessId), transactionType: "recovery_adjustment",
          ...(delta > 0n ? { targetAccountId: x.target.target.accountId } : { sourceAccountId: x.target.target.accountId }),
          amount: abs, currencyCode: x.target.currency!, description, evidenceUrl: ref, occurredAt: new Date(), actor: c.actor });
      }
    }
    if (input.__afterPostingForTests) await input.__afterPostingForTests(tx);
    // التحقق: كل هدف = رصيد الصورة بالضبط
    const after = await legacyBalances(tx, input.tenantId);
    for (const [key, x] of desired) {
      const got = after.get(key)?.balance;
      if (got !== x.amount) fail("verify", `بعد الإدخال: ${key} = ${got == null ? "؟" : fromMinorUnits(got)} ≠ ${fromMinorUnits(x.amount)} — أُلغي كل شيء`);
    }
    const result = { snapshotEventId: p.snapshotEventId, snapshotHash: p.figuresHash, lines, acknowledgedNonCash: stored.balances.filter(b => ack.has(b.code)),
      zeroed: zeroed.map(z => ({ target: z.key, reconciledBalance: fromMinorUnits(toMinorUnits(z.reconciledBalance)), explanation: z.explanation, evidenceRef: z.evidenceRef, approvedByEmployeeId: Number(z.approvedByEmployeeId), approvedBy: z.approvedBy })) };
    const r = await tx.execute(sql`INSERT INTO ledger_legacy_archive_events (tenantId, action, activationAt, dedupeKey, snapshotEventId, figuresJson, figuresHash, reason, actorEmployeeId)
      SELECT tenantId, 'recovery', enabledAt, ${recoveryKey}, ${p.snapshotEventId}, ${canonicalJson(result)}, ${figuresHash(result)}, ${reason}, ${c.actor.id} FROM ledger_tenant_flags WHERE tenantId = ${input.tenantId}`);
    return { applied: true, replay: false, recoveryEventId: Number((Array.isArray(r) ? r[0] : r)?.insertId), lines };
  });
}
