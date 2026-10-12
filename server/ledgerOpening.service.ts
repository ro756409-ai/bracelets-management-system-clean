import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { OPENING_AMOUNT_RE, isValidIsoDate, parseOpeningFile } from "../shared/ledgerV3Activation";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { getDb } from "./db";
import { planLedgerV3Activation } from "./ledgerV3Activation.service";
import { LEDGER_BASE_ACCOUNTS } from "./ledgerV3.service";
import type { ReadOnlyExecutor } from "./balanceReconciliation.service";

/**
 * تجهيز الأرصدة الافتتاحية لدفتر V3 (المالك فقط) — **قراءة فقط**: لا يكتب أي صف ولا يفعّل الدفتر.
 *
 *  • المصدر: جرد ومطابقة فعلية يوم Go-live يُدخلها المالك (مبلغ نصي عشري + مرجع + القائم بالعد + ملاحظة لكل حساب).
 *    لا تعبئة من V1/V2 — تقرير مطابقة V2 يُعرض للمقارنة فقط، وفروقه تُعتمد صراحةً.
 *  • ذمة شركة الشحن (COD) منفصلة عن النقدية المتاحة (خزنة/بنك/محافظ) في العرض والإجماليات.
 *  • التحقق = نفس محلل ملف التفعيل الصارم (parseOpeningFile) + نفس خطة التفعيل (planLedgerV3Activation)، كلها داخل
 *    معاملة MySQL `READ ONLY` (أي كتابة مرفوضة من القاعدة نفسها).
 *  • الناتج: كائن JSON مطابق لعقد scripts/activate-ledger-v3.ts حرفيًا؛ الأدلة في مفاتيح `_…` (يتجاهلها المحلل).
 *    التفعيل نفسه يبقى خطوة منفصلة يشغّلها المالك يوم Go-live.
 */
export const OPENING_MONEY_ACCOUNTS = LEDGER_BASE_ACCOUNTS.filter(a => a.money).map(a => ({
  code: a.code, name: a.name, kind: a.kind,
  group: a.kind === "carrier_receivable" ? ("cod_receivable" as const) : ("cash_available" as const),
}));
const MONEY_CODES: readonly string[] = OPENING_MONEY_ACCOUNTS.map(a => a.code);

const evidence = z.object({
  reference: z.string().trim().min(2, "اذكر مرجع الجرد أو الكشف").max(160),
  countedBy: z.string().trim().min(2, "اذكر القائم بالعد").max(100),
  note: z.string().trim().max(300).optional(),
}).strict();
export const openingDraftInput = z.object({
  goLiveDate: z.string().refine(isValidIsoDate, "تاريخ Go-live بصيغة YYYY-MM-DD"),
  balances: z.record(z.string(), z.string().regex(OPENING_AMOUNT_RE, "المبلغ نص عشري موجب حتى 4 خانات")),
  evidence: z.record(z.string(), evidence),
  acknowledgeV2Differences: z.boolean(),
}).strict();
export type OpeningDraftInput = z.infer<typeof openingDraftInput>;

/** منفّذ قراءة فوق نفس المعاملة (READ ONLY) — SELECT فقط. */
const txExecutor = (tx: any): ReadOnlyExecutor => ({
  async query<T = any>(q: string, params: unknown[] = []): Promise<T[]> {
    if (!/^\s*select\b/i.test(q)) throw new Error("Refusing to run a non-SELECT statement");
    let i = 0;
    const chunks = q.split("?");
    const built = chunks.reduce((acc, part, idx) => (idx === 0 ? sql.raw(part) : sql`${acc}${params[i++]}${sql.raw(part)}`), sql``);
    const r: any = await tx.execute(built);
    return (Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : r?.rows ?? []) as T[];
  },
  async close() { /* المعاملة يغلقها المتصل */ },
});

export async function validateOpeningDraft(input: { tenantId: number; ownerEmployeeId: number; draft: OpeningDraftInput }) {
  const v = openingDraftInput.parse(input.draft);
  const errors: string[] = [];
  for (const code of Object.keys(v.balances)) if (!MONEY_CODES.includes(code)) errors.push(`حساب غير معروف للأرصدة الافتتاحية: ${code}`);
  for (const code of MONEY_CODES) {
    const amount = v.balances[code];
    if (amount != null && toMinorUnits(amount) !== 0n && !v.evidence[code]) errors.push(`${code}: المبلغ يحتاج مرجع جرد/كشف والقائم بالعد`);
  }
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });

  return db.transaction(async tx => {
    const exec = txExecutor(tx);
    const preliminary = await planLedgerV3Activation({ tenantId: input.tenantId, db: tx as any, exec, opening: null, goLiveDate: v.goLiveDate, actorEmployeeId: input.ownerEmployeeId });
    const balances: Record<string, string> = {};
    for (const code of MONEY_CODES) balances[code] = v.balances[code] ?? "0";
    const draftFile = {
      goLiveDate: v.goLiveDate, currency: "EGP", openingBalances: balances,
      reconciliation: preliminary.v2Reconciliation
        ? { reportGeneratedAt: preliminary.v2Reconciliation.generatedAt, approvedByEmployeeId: input.ownerEmployeeId, approvedAt: new Date().toISOString(), acknowledgedDifferences: v.acknowledgeV2Differences }
        : null,
    };
    const first = parseOpeningFile(draftFile, MONEY_CODES);
    const file = first.ok ? {
      ...draftFile, openingEquity: first.total,
      _source: "جرد ومطابقة فعلية يوم Go-live — بلا أي رقم من V1/V2",
      _evidence: Object.fromEntries(MONEY_CODES.filter(c => v.evidence[c]).map(c => [c, v.evidence[c]])),
      _preparedByEmployeeId: input.ownerEmployeeId,
    } : null;
    const parsed = file ? parseOpeningFile(file, MONEY_CODES) : first;
    if (!parsed.ok) errors.push(...parsed.errors);
    const plan = parsed.ok
      ? await planLedgerV3Activation({ tenantId: input.tenantId, db: tx as any, exec, opening: parsed.file, actorEmployeeId: input.ownerEmployeeId })
      : preliminary;
    // مجموعات بالوحدات الصغرى (bigint) — بلا أي تحويل float
    const sumGroup = (group: "cash_available" | "cod_receivable") => OPENING_MONEY_ACCOUNTS.filter(a => a.group === group)
      .reduce((acc, a) => acc + toMinorUnits(balances[a.code]), 0n);
    const fmt = (n: bigint) => fromMinorUnits(n);
    return {
      ok: errors.length === 0 && plan.blockers.length === 0,
      errors,
      blockers: plan.blockers,
      warnings: plan.warnings,
      accounts: OPENING_MONEY_ACCOUNTS,
      totals: { cashAvailable: fmt(sumGroup("cash_available")), codReceivable: fmt(sumGroup("cod_receivable")), openingEquity: parsed.ok ? parsed.total : null },
      businessCoverage: plan.businessCoverage.map(b => ({ id: b.id, name: b.name, active: b.active, inPlan: b.inPlan, result: b.result })),
      v2Reconciliation: plan.v2Reconciliation ? { generatedAt: plan.v2Reconciliation.generatedAt, ok: plan.v2Reconciliation.ok, differences: plan.v2Reconciliation.lines.filter(l => !l.ok).length } : null,
      ledgerEnabled: Boolean(plan.flag?.enabled),
      file: errors.length === 0 && parsed.ok ? file : null,
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
