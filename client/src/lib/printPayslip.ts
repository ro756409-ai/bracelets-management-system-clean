import { formatMoney } from "./money";

/**
 * كشف راتب للطباعة / الحفظ PDF.
 *
 * نافذة مستقلة بـHTML مكتوب للورق، زي `printExpenses`. المشروع مافيهوش مكتبة PDF،
 * وإضافة واحدة (jsPDF أو puppeteer) عشان مستند واحد كانت هتزوّد الحزمة أو تحتاج خدمة
 * على السيرفر — والمتصفح أصلاً بيحوّل الطباعة لـPDF بجودة أعلى وخطوط عربية سليمة عبر
 * "حفظ كـPDF" في نافذة الطباعة.
 *
 * الكشف بيعرض الصيغة كاملة سطرًا سطرًا مش الصافي بس: الموظف لازم يقدر يراجع الرقم
 * بنفسه، وكشف بيقول "٣٣١٩ جنيه" من غير تفصيل بيولّد سؤالًا كل شهر.
 */
export type PayslipData = {
  employeeName: string;
  employeeId: number;
  month: number;
  year: number;
  salaryType: string;
  baseSalary: unknown;
  attendanceDays: number;
  absenceDays: number;
  overtimeAmount: unknown;
  bonuses: unknown;
  commissions: unknown;
  commissionOrders: number;
  absenceDeduction: unknown;
  deductions: unknown;
  advances: unknown;
  netSalary: unknown;
  notes?: string | null;
  periodStatus: string;
  paidAt?: string | Date | null;
  approvedByName?: string | null;
  paidByName?: string | null;
};

const SALARY_TYPE_LABELS: Record<string, string> = {
  monthly: "شهري", daily: "يومي", commission: "عمولة", mixed: "مختلط",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "مسودة", approved: "معتمد", paid: "مدفوع", cancelled: "ملغي",
};

const MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

export function printPayslip(data: PayslipData): boolean {
  const win = window.open("", "_blank", "width=800,height=900");
  // المتصفح ممكن يمنع النوافذ المنبثقة — بنرجّع false والصفحة بتقول للمستخدم
  if (!win) return false;

  const row = (label: string, value: string, kind: "add" | "sub" | "plain" = "plain") => `
    <tr class="${kind}">
      <td>${escapeHtml(label)}</td>
      <td class="num">${kind === "sub" ? "−" : kind === "add" ? "+" : ""}${value}</td>
    </tr>`;

  // المسودة بتتطبع بعلامة مائية: كشف غير معتمد ممكن يوصل لموظف ويتعامل معه كأنه نهائي
  const watermark = data.periodStatus !== "paid"
    ? `<div class="watermark">${escapeHtml(STATUS_LABELS[data.periodStatus] ?? data.periodStatus)}</div>`
    : "";

  win.document.write(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>كشف راتب — ${escapeHtml(data.employeeName)} — ${MONTHS[data.month - 1]} ${data.year}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: "IBM Plex Sans Arabic", system-ui, sans-serif;
    margin: 0; padding: 28px; color: #1E293B; position: relative;
  }
  .watermark {
    position: fixed; top: 45%; left: 50%; transform: translate(-50%,-50%) rotate(-24deg);
    font-size: 84px; font-weight: 800; color: rgba(100,116,139,.13);
    pointer-events: none; letter-spacing: 6px;
  }
  header { border-bottom: 2px solid #5B3DF5; padding-bottom: 12px; margin-bottom: 18px; }
  .brand { font-size: 20px; font-weight: 800; color: #5B3DF5; }
  .brand span { font-size: 11px; color: #64748B; font-weight: 500; letter-spacing: 2px; }
  h1 { font-size: 16px; margin: 10px 0 2px; }
  .period { font-size: 12px; color: #64748B; }
  .info { display: flex; gap: 28px; flex-wrap: wrap; margin-bottom: 18px; font-size: 12px; }
  .info div { min-width: 120px; }
  .info .k { color: #64748B; display: block; margin-bottom: 2px; }
  .info .v { font-weight: 700; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #F8FAFC; text-align: right; padding: 8px 10px; border: 1px solid #E2E8F0; font-weight: 600; }
  td { padding: 7px 10px; border: 1px solid #E2E8F0; }
  .num { text-align: left; font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
  tr.add .num { color: #10B981; }
  tr.sub .num { color: #EF4444; }
  tfoot td { background: #EDE9FE; font-size: 15px; font-weight: 800; padding: 11px 10px; }
  .notes { margin-top: 16px; font-size: 12px; color: #64748B; }
  .sign { display: flex; justify-content: space-between; margin-top: 46px; font-size: 12px; }
  .sign div { text-align: center; width: 42%; }
  .sign .line { border-top: 1px solid #94A3B8; margin-top: 34px; padding-top: 5px; color: #64748B; }
  footer { margin-top: 26px; font-size: 10px; color: #94A3B8; text-align: center; }
  @page { size: A4; margin: 12mm; }
  @media print { body { padding: 0; } }
</style></head><body>
  ${watermark}
  <header>
    <div class="brand">متجرك <span>MATJARAK</span></div>
    <h1>كشف راتب</h1>
    <p class="period">${MONTHS[data.month - 1]} ${data.year}</p>
  </header>

  <div class="info">
    <div><span class="k">الموظف</span><span class="v">${escapeHtml(data.employeeName)}</span></div>
    <div><span class="k">كود الموظف</span><span class="v">#${data.employeeId}</span></div>
    <div><span class="k">نوع الراتب</span><span class="v">${SALARY_TYPE_LABELS[data.salaryType] ?? data.salaryType}</span></div>
    <div><span class="k">أيام الحضور</span><span class="v">${data.attendanceDays}</span></div>
    <div><span class="k">أيام الغياب</span><span class="v">${data.absenceDays}</span></div>
    <div><span class="k">الحالة</span><span class="v">${STATUS_LABELS[data.periodStatus] ?? data.periodStatus}</span></div>
  </div>

  <table>
    <thead><tr><th>البند</th><th style="text-align:left">المبلغ</th></tr></thead>
    <tbody>
      ${row("الراتب الأساسي", formatMoney(data.baseSalary))}
      ${row("بدل إضافي (أوفرتايم)", formatMoney(data.overtimeAmount), "add")}
      ${row("حوافز ومكافآت", formatMoney(data.bonuses), "add")}
      ${row(`عمولة${data.commissionOrders > 0 ? ` (${data.commissionOrders} أوردر)` : ""}`, formatMoney(data.commissions), "add")}
      ${row(`خصم غياب${data.absenceDays > 0 ? ` (${data.absenceDays} يوم)` : ""}`, formatMoney(data.absenceDeduction), "sub")}
      ${row("خصومات أخرى", formatMoney(data.deductions), "sub")}
      ${row("سُلف مستقطعة", formatMoney(data.advances), "sub")}
    </tbody>
    <tfoot><tr><td>صافي المستحق</td><td class="num">${formatMoney(data.netSalary)}</td></tr></tfoot>
  </table>

  ${data.notes ? `<p class="notes"><strong>ملاحظات:</strong> ${escapeHtml(data.notes)}</p>` : ""}
  ${data.paidAt ? `<p class="notes"><strong>تاريخ الصرف:</strong> ${new Date(data.paidAt).toLocaleDateString("ar-EG")}</p>` : ""}

  <div class="sign">
    <div><div class="line">توقيع الموظف</div></div>
    <div><div class="line">${escapeHtml(data.paidByName || data.approvedByName || "المسؤول المالي")}</div></div>
  </div>

  <footer>طُبع من نظام متجرك — ${new Date().toLocaleString("ar-EG")}</footer>
</body></html>`);
  win.document.close();
  win.focus();
  win.print();
  return true;
}

/** أسماء الموظفين وملاحظاتهم بيانات تاجر — أي `<` جواها لازم يتهرّب قبل ما يتحط في HTML. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
