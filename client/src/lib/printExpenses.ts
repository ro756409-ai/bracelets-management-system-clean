import { formatMoney } from "./money";

/**
 * طباعة كشف المصروفات المعروض.
 *
 * نافذة مستقلة بـHTML وCSS خاصين بها، مش `window.print()` على الصفحة الحالية: الصفحة
 * فيها سايدبار وفلاتر وأزرار مالهم لازمة على الورق، وإخفاؤهم بـ`@media print` كان معناه
 * قواعد طباعة متفرّقة في كل صفحة. الكشف هنا مستند واحد مكتوب للورق من الأول.
 *
 * بيطبع الصفوف المعروضة فعلاً — يعني الفلاتر النشطة داخلة في الكشف، وده المتوقع: التاجر
 * بيفلتر على شهر أو تصنيف ثم يطبع اللي شافه.
 */
export function printExpenses(
  rows: Array<{
    expenseDate: string | Date;
    categoryName?: string | null;
    description: string;
    amount: string | number;
    createdByName: string;
    reference?: string | null;
  }>,
  totalAmount: number,
) {
  const win = window.open("", "_blank", "width=900,height=700");
  // المتصفح ممكن يمنع النوافذ المنبثقة — بنرجّع false والصفحة بتقول للمستخدم بدل
  // ما الزرار يبان إنه مابيعملش حاجة.
  if (!win) return false;

  const rowsHtml = rows.map(r => `
    <tr>
      <td>${new Date(r.expenseDate).toLocaleDateString("ar-EG", { day: "numeric", month: "short", year: "numeric" })}</td>
      <td>${escapeHtml(r.categoryName ?? "بدون تصنيف")}</td>
      <td>${escapeHtml(r.description)}</td>
      <td class="num">${formatMoney(r.amount)}</td>
      <td>${escapeHtml(r.createdByName)}</td>
      <td>${escapeHtml(r.reference ?? "—")}</td>
    </tr>`).join("");

  win.document.write(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>كشف المصروفات — متجرك</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "IBM Plex Sans Arabic", system-ui, sans-serif; margin: 24px; color: #1E293B; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { font-size: 12px; color: #64748B; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #E2E8F0; padding: 6px 8px; text-align: right; }
  th { background: #F8FAFC; font-weight: 600; }
  .num { font-variant-numeric: tabular-nums; font-weight: 700; }
  tfoot td { background: #F8FAFC; font-weight: 700; }
  @page { size: A4; margin: 14mm; }
</style></head><body>
  <h1>كشف المصروفات</h1>
  <p class="meta">
    متجرك — تاريخ الطباعة: ${new Date().toLocaleString("ar-EG")}
    · عدد البنود: ${rows.length.toLocaleString("ar-EG")}
  </p>
  <table>
    <thead><tr>
      <th>التاريخ</th><th>التصنيف</th><th>البيان</th><th>المبلغ</th><th>الموظف</th><th>المرجع</th>
    </tr></thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot><tr>
      <td colspan="3">الإجمالي</td>
      <td class="num">${formatMoney(totalAmount)}</td>
      <td colspan="2"></td>
    </tr></tfoot>
  </table>
</body></html>`);
  win.document.close();
  win.focus();
  win.print();
  return true;
}

/** بيانات التاجر بتتحط في HTML مباشرة، فأي `<` جوه اسم أو بيان لازم يتهرّب. */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
