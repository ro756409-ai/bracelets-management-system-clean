import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { LedgerError, type LedgerActor } from "../shared/ledgerV3Core";
import { monthBounds } from "./attendanceSummary.service";
import { tablesPresent } from "./ledgerCarrierOps.service";
import { closeChecklist, incomeStatement } from "./ledgerReports.service";
import { lockLedgerPeriod, rawRows, resolveDb, type LedgerDb } from "./ledgerV3.service";

/**
 * المرحلة 7 — الإقفال الشهري (بعد 0050 للصورة الثابتة):
 *  • الإقفال فقط عندما تكتمل قائمة الفحص (الشهر السابق مقفل = ترتيب الشهور، التسليمات مقيّدة، لا مراجعات دفتر مفتوحة،
 *    الأرصدة مطابقة، لا كتابات مالية قديمة في الشهر) — وبملاحظة مراجعة إلزامية كما في المرحلة 1.
 *  • الصورة الثابتة تُحسب **داخل transaction القفل** بعد قفل الفترة FOR UPDATE (لا ترحيل متزامن): قائمة الدخل للشهر، أرصدة كل
 *    حساب حتى آخر الشهر، ونتيجة قائمة الفحص؛ وبصمة sha256 لصيغة JSON قانونية (مفاتيح مرتبة). إصدار متزايد لكل شهر.
 *  • إعادة الفتح تبقى للمالك وحده بسبب إلزامي (المرحلة 1) ولا تحذف أي صورة؛ الإقفال التالي ينشئ إصدارًا جديدًا، ويظهر إن تغيّرت
 *    الأرقام عن الإصدار السابق.
 */
export const SNAPSHOT_TABLES = ["ledger_period_snapshots"] as const;

/** JSON قانوني: مفاتيح الكائنات مرتبة، المصفوفات بترتيبها — نفس الأرقام = نفس البصمة دائمًا. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((v as any)[k])}`).join(",")}}`;
}
export const figuresHash = (figures: unknown) => createHash("sha256").update(canonicalJson(figures)).digest("hex");

/** أرقام الشهر: قائمة الدخل للشهر (الشركة كلها) وأرصدة كل حساب حتى آخر يوم فيه. */
export async function periodFigures(d: LedgerDb, tenantId: number, period: string) {
  const { from, to } = monthBounds(period);
  const income = await incomeStatement({ tenantId, from, to, scope: null }, d);
  const balances = rawRows(await d.execute(sql`SELECT a.code, a.kind, a.normalSide AS normalSide,
      COALESCE(SUM(CASE WHEN e.side = a.normalSide THEN e.amount ELSE -e.amount END), 0) AS balance
    FROM ledger_accounts a LEFT JOIN ledger_entries e ON e.accountId = a.id
      AND e.transactionId IN (SELECT t.id FROM ledger_transactions t WHERE t.tenantId = ${tenantId} AND t.effectiveDate <= ${to})
    WHERE a.tenantId = ${tenantId} GROUP BY a.id, a.code, a.kind, a.normalSide ORDER BY a.code`)).map((r: any) => ({ code: String(r.code), kind: String(r.kind), balance: String(r.balance) }));
  return { period, income, balances };
}

export async function closeLedgerPeriod(input: { tenantId: number; period: string; reason: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  if (input.actor.type !== "employee") throw new LedgerError("actorEmployee");
  const employeeId = input.actor.employeeId;
  const withSnapshot = await tablesPresent(d, SNAPSHOT_TABLES);
  let snapshot: { version: number; figuresHash: string } | null = null;
  let checklist: Awaited<ReturnType<typeof closeChecklist>> | null = null;
  const r = await lockLedgerPeriod({ tenantId: input.tenantId, period: input.period, reason: input.reason, actor: input.actor,
    // بعد رفض الشهر المستقبلي/replay للمقفل/الملاحظة: قائمة الفحص كاملة وإلا لا إقفال (BUG-88: لا تجاوز).
    // السباق: القائمة تُقرأ بعد قفل صف الفترة FOR UPDATE ⇒ أي ترحيل جارٍ للشهر (FOR SHARE) انتهى قبلها، وأي ترحيل بعدها يُرفض
    // «مقفل». ما لا يضمنه القفل: عملية تشغيلية (اعتماد جرد/فحص مرتجع/حدث شركة شحن) تُعتمد بين قراءة القائمة والـcommit، أو حدث
    // متأخر بتاريخ داخل الشهر بعد الإقفال — ترحيلها يفشل «مقفل» ويظهر كمراجعة، والتصحيح بإعادة فتح المالك.
    beforeLock: async () => {
      checklist = await closeChecklist({ tenantId: input.tenantId, period: input.period }, d);
      if (!checklist.ready) throw new LedgerError("conflict", `قائمة فحص الإقفال غير مكتملة: ${checklist.checks.filter(c => !c.ok).map(c => c.label).join("؛ ")}`);
    },
    afterLock: withSnapshot ? async (tx, { lockEventId }) => {
      const figures = await periodFigures(tx as LedgerDb, input.tenantId, input.period);
      const hash = figuresHash(figures);
      const [v] = rawRows(await tx.execute(sql`SELECT COALESCE(MAX(version), 0) AS v FROM ledger_period_snapshots WHERE tenantId = ${input.tenantId} AND period = ${input.period} FOR UPDATE`));
      const version = Number(v?.v ?? 0) + 1;
      await tx.execute(sql`INSERT INTO ledger_period_snapshots (tenantId, period, version, lockEventId, figuresJson, checklistJson, figuresHash, createdByEmployeeId)
        VALUES (${input.tenantId}, ${input.period}, ${version}, ${lockEventId}, ${canonicalJson(figures)}, ${canonicalJson(checklist)}, ${hash}, ${employeeId})`);
      snapshot = { version, figuresHash: hash };
    } : undefined }, d);
  return { ...r, snapshot, snapshotsAvailable: withSnapshot };
}

/** إصدارات صورة الشهر مع تحقق البصمة المخزنة، وهل تغيّرت أرقام الشهر الآن عن آخر إصدار (بعد إعادة فتح مثلًا). */
export async function listPeriodSnapshots(input: { tenantId: number; period: string }, db?: LedgerDb) {
  const d = await resolveDb(db);
  if (!(await tablesPresent(d, SNAPSHOT_TABLES))) return { available: false as const, snapshots: [] };
  const rows = rawRows(await d.execute(sql`SELECT s.id, s.version, s.figuresJson AS figures, s.figuresHash AS hash, s.createdAt, e.name AS createdBy
    FROM ledger_period_snapshots s LEFT JOIN employees e ON e.id = s.createdByEmployeeId WHERE s.tenantId = ${input.tenantId} AND s.period = ${input.period} ORDER BY s.version`));
  const current = rows.length ? figuresHash(await periodFigures(d, input.tenantId, input.period)) : null;
  return {
    available: true as const,
    snapshots: rows.map((r: any) => {
      const figures = typeof r.figures === "string" ? JSON.parse(r.figures) : r.figures;
      return { version: Number(r.version), figuresHash: String(r.hash), hashOk: figuresHash(figures) === String(r.hash), changedSince: current != null && current !== String(r.hash),
        createdAt: r.createdAt, createdBy: r.createdBy ?? null, netProfit: figures?.income?.netProfit ?? null };
    }),
  };
}
