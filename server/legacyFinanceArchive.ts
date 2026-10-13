import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

/**
 * المرحلة 7 — تجهيز V1/V2 كأرشيف للقراءة فقط (بلا حذف، وبلا تحويل فعلي — التحويل يحتاج موافقة منفصلة):
 *  • `assertLegacyFinanceWritable`: أي كتابة مالية قديمة (خزنة V1، حركة مالية V2، مصروف، سلفة) لنشاط شركته **فُعّل لها Ledger V3
 *    يومًا** تُرفض قبل أي كتابة — لا كتابة مزدوجة حتى لو فُتح علم المحاسبة القديم (ACCOUNTING_MODULE_ENABLED) بالخطأ.
 *    الحظر مفصول عن حالة علم V3: يثبت بلحظة التفعيل نفسها (enabledAt يُكتب داخل معاملة التفعيل) و**إطفاء V3 لا يرفعه**
 *    (الإطفاء لا يمس enabledAt). لا مسار لرفعه حاليًا — رفعه سيكون إجراءً منفصلًا للمالك بسبب مسجّل بعد المطابقة (يحتاج سجلًا
 *    دائمًا: Migration 0051 مقترحة، لم تُكتب). شركة لم تُفعَّل قط (أو قاعدة بلا جداول 0040) = السلوك القديم كما هو.
 *  • `legacyFinanceWritesBetween`: عدّ الكتابات القديمة في فترة لشركة — بند في قائمة فحص الإقفال (يجب أن يكون صفرًا).
 */
/** خطأ tRPC مباشرة (PRECONDITION_FAILED) فتصل رسالته للواجهة كما هي من أي مسار قديم. */
export class LegacyFinanceArchivedError extends TRPCError {
  constructor() { super({ code: "PRECONDITION_FAILED", message: "الحسابات القديمة أرشيف للقراءة فقط لهذه الشركة بعد تفعيل دفتر الحسابات الجديد — سجّل العملية في الدفتر الجديد" }); this.name = "LegacyFinanceArchivedError"; }
}

const rowsOf = (r: any): any[] => (Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : r?.rows ?? []);
const noTable = (e: unknown) => { for (let x: any = e, i = 0; x && i < 6; x = x.cause, i++) if (x.code === "ER_NO_SUCH_TABLE") return true; return false; };

export async function assertLegacyFinanceWritable(exec: { execute: (q: any) => Promise<any> }, businessId: number): Promise<void> {
  let archived = false;
  try {
    // «فُعّل يومًا» لا «مفعّل الآن» — الإطفاء لا يرفع الحظر
    const [row] = rowsOf(await exec.execute(sql`SELECT f.enabledAt IS NOT NULL AS a FROM businesses b JOIN ledger_tenant_flags f ON f.tenantId = b.tenantId WHERE b.id = ${businessId} LIMIT 1`));
    archived = Number(row?.a ?? 0) === 1;
  } catch (e) {
    if (noTable(e)) return; // قبل 0040: لا دفتر جديد ⇒ لا أرشفة
    throw e;
  }
  if (archived) throw new LegacyFinanceArchivedError();
}

const LEGACY_TABLES = [
  { table: "treasury_transactions", label: "حركات خزنة قديمة" },
  { table: "financial_transactions", label: "حركات مالية V2" },
  { table: "expenses", label: "مصروفات قديمة" },
  { table: "employee_advances", label: "سلف قديمة" },
] as const;

/**
 * كتابات مالية قديمة لأنشطة الشركة بين لحظتين مطلقتين (ميلي ثانية) — المقارنة بـUNIX_TIMESTAMP فلا تتأثر بتوقيت Node أو جلسة
 * القاعدة (تمرير Date يُرسل بتوقيت Node المحلي). جداول غير موجودة تُتجاهل.
 */
export async function legacyFinanceWritesBetween(exec: { execute: (q: any) => Promise<any> }, tenantId: number, fromMs: number, toMs: number) {
  const out: { table: string; label: string; count: number }[] = [];
  for (const t of LEGACY_TABLES) {
    try {
      const [r] = rowsOf(await exec.execute(sql`SELECT COUNT(*) AS n FROM ${sql.raw(`\`${t.table}\``)} x JOIN businesses b ON b.id = x.businessId
        WHERE b.tenantId = ${tenantId} AND UNIX_TIMESTAMP(x.createdAt) * 1000 >= ${fromMs} AND UNIX_TIMESTAMP(x.createdAt) * 1000 < ${toMs}`));
      const n = Number(r?.n ?? 0);
      if (n > 0) out.push({ table: t.table, label: t.label, count: n });
    } catch (e) { if (!noTable(e)) throw e; }
  }
  return out;
}
