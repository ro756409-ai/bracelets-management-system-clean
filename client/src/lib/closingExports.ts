import * as XLSX from "xlsx";

export function exportClosingWorkbook(detail: any) {
  const workbook = XLSX.utils.book_new();
  const totals = detail.totals ?? {};
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { field: "Business", value: detail.businessId },
    { field: "Sequence", value: detail.sequenceNumber },
    { field: "Status", value: detail.status },
    { field: "Period From", value: new Date(detail.periodFrom).toLocaleString("ar-EG") },
    { field: "Period To", value: new Date(detail.periodTo).toLocaleString("ar-EG") },
    ...Object.entries(totals).filter(([, value]) => typeof value !== "object").map(([field, value]) => ({ field, value })),
  ]), "Summary");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detail.lines ?? []), "Subledger Lines");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detail.adjustments ?? []), "Adjustments");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detail.actions ?? []), "Audit Trail");
  XLSX.writeFile(workbook, `closing-${detail.businessId}-${detail.sequenceNumber}.xlsx`);
}

export function printClosingReport(detail: any) {
  const popup = window.open("", "_blank", "noopener,noreferrer");
  if (!popup) return false;
  const rows = Object.entries(detail.totals ?? {}).filter(([, value]) => typeof value !== "object")
    .map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td dir="ltr">${escapeHtml(String(value))}</td></tr>`).join("");
  const adjustments = (detail.adjustments ?? []).map((row: any) =>
    `<tr><td>${escapeHtml(row.adjustmentType)}</td><td dir="ltr">${escapeHtml(row.amount)}</td><td>${escapeHtml(row.reason)}</td></tr>`,
  ).join("");
  popup.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقفيلة #${detail.sequenceNumber}</title>
    <style>@page{size:A4;margin:14mm}body{font-family:Tahoma,sans-serif;color:#172033}h1{margin:0 0 8px}small{color:#657084}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{border:1px solid #d9dee8;padding:8px;text-align:right}th{background:#edf4f1}.meta{display:flex;gap:18px;flex-wrap:wrap}.stamp{display:inline-block;padding:5px 10px;border:1px solid #286a58;border-radius:20px;color:#286a58;font-weight:bold}@media print{button{display:none}}</style>
    </head><body><button onclick="window.print()">حفظ PDF / طباعة</button><h1>Matjarak ERP - Accounting Closing</h1>
    <div class="meta"><span>Business #${detail.businessId}</span><span>تقفيلة #${detail.sequenceNumber}</span><span class="stamp">${escapeHtml(detail.status)}</span></div>
    <p><small>${new Date(detail.periodFrom).toLocaleString("ar-EG")} - ${new Date(detail.periodTo).toLocaleString("ar-EG")}</small></p>
    <table><thead><tr><th>المؤشر</th><th>القيمة</th></tr></thead><tbody>${rows}</tbody></table>
    ${adjustments ? `<h2>التسويات</h2><table><thead><tr><th>النوع</th><th>القيمة</th><th>السبب</th></tr></thead><tbody>${adjustments}</tbody></table>` : ""}
    <script>window.onload=()=>window.print()</script></body></html>`);
  popup.document.close();
  return true;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!);
}
