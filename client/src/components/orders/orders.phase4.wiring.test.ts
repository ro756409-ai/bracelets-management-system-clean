/**
 * المرحلة 4 — حراسة نصّية لصفحة الأوردرات: كل Queries/Mutations/Dialogs/الفلاتر/بوابات الصلاحية ما زالت
 * موصولة في `Orders.tsx`، صف WorkspaceTabs مرة واحدة (في الـShell فقط)، أجزاء العرض بلا منطق أعمال،
 * ولا بيانات مزيفة، ولا تغيير في عقدة API.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const page = strip(read("pages/Orders.tsx"));
const layout = strip(read("components/DashboardLayout.tsx"));
const tabs = strip(read("components/orders/OrdersTabs.tsx"));
const table = strip(read("components/orders/OrdersTable.tsx"));
const mobile = strip(read("components/orders/OrdersMobileList.tsx"));

describe("🧭 صف WorkspaceTabs مرة واحدة فقط — من الـShell", () => {
  it("Orders.tsx لا يرسم <WorkspaceTabs ولا يستورده؛ DashboardLayout يرسمه مرة واحدة", () => {
    expect(page).not.toContain("<WorkspaceTabs");
    expect(page).not.toMatch(/import\s*\{[^}]*WorkspaceTabs[^}]*\}/);
    expect((layout.match(/<WorkspaceTabs /g) ?? []).length).toBe(1);
  });
  it("Orders.tsx يستخدم أجزاء العرض الثلاثة + OrderToolbar + حارس الضغط المكرر", () => {
    for (const s of ["<OrdersTabs", "<OrdersTable", "renderOrdersMobileRow(", "<OrderToolbar", "createInFlightGuard<number>()", "buildOrdersColumns(columnsCtx)"]) expect(page).toContain(s);
    for (const s of ["<StatusFilterChips", "<ResponsiveDataTable", "<MobileOrderCard"]) expect(page).not.toContain(s);
  });
});

describe("🔌 Queries و Mutations كما كانت — كلها في Orders.tsx", () => {
  const QUERIES = [
    "trpc.orders.list.useQuery", "trpc.orders.statusCounts.useQuery", "trpc.orders.todayConfirmed.useQuery", "trpc.orders.get.useQuery",
    "trpc.orders.getEditHistory.useQuery", "trpc.orders.orderItems.useQuery", "trpc.products.list.useQuery", "trpc.variants.all.useQuery",
    "trpc.orders.distinctAdNames.useQuery", "trpc.employees.activeList.useQuery", "trpc.salesChannels.activeList.useQuery",
    "trpc.carrierAccounts.status.useQuery", "trpc.orders.getByIds.useQuery", "trpc.accountingV2.configurationList.useQuery", "trpc.accountingV2.shippingConfiguration.useQuery",
  ];
  const MUTATIONS = [
    "trpc.orders.confirm.useMutation", "trpc.orders.cancel.useMutation", "trpc.orders.postpone.useMutation", "trpc.orders.bulkAssign.useMutation",
    "trpc.orders.markNoAnswer.useMutation", "trpc.orders.delete.useMutation", "trpc.orders.bulkDelete.useMutation", "trpc.orders.editOrder.useMutation",
    "trpc.orders.editOrderItems.useMutation", "trpc.orders.duplicate.useMutation", "trpc.returns.markAsReturned.useMutation",
    "trpc.orders.convertNoAnswerToNew.useMutation", "trpc.orders.convertPostponedToNew.useMutation", "trpc.orders.bulkSendToBosta.useMutation",
    "trpc.orders.update.useMutation", "trpc.orders.create.useMutation",
  ];
  it(`15 استعلامًا موصولة`, () => { for (const q of QUERIES) expect(page, q).toContain(q); });
  it(`16 mutation موصولة`, () => { for (const m of MUTATIONS) expect(page, m).toContain(m); });
  it("عقدة API لم تتغيّر: نفس مفاتيح queryParams ولا معامل بحث جديد (searchField/awb)", () => {
    const qp = page.slice(page.indexOf("const queryParams = useMemo"), page.indexOf("trpc.orders.list.useQuery"));
    for (const k of ["search:", "status:", "source:", "websiteId:", "governorates:", "dateFrom:", "dateTo:", "printedDateFrom:", "printedDateTo:", "adName:", "assignedEmployeeId:", "unassignedOnly:", "page,", "limit:", "businessIds:"]) expect(qp, k).toContain(k);
    expect(qp).not.toMatch(/searchField|awb|trackingNumber/);
  });
  it("كل النوافذ قائمة", () => {
    for (const d of ["<CreateOrderDialog", "<ImportExcelDialog", "<ImportWhatsAppDialog", "<OrderEditDialog", "<AssignDialog", "<ConfirmDialog", "<Drawer",
      "open={showReturnDialog}", "open={showCancelDialog}", "open={showPostponeDialog}", "open={showNoAnswerDialog}", "open={showExportDialog}", "open={showBostaDialog}"]) expect(page, d).toContain(d);
  });
  it("التحديد الجماعي + الاستيراد + التصدير + الطباعة + AWB + بوابات الصلاحية كما هي", () => {
    for (const s of ["isAdmin ? selectedKeysSet : undefined", "/api/export/print-labels", "/api/orders/bosta-awb", "/api/export/${exportType", 'usePermission("orders.edit_items")', "allowItemsEdit={canEditItems}", "setShowImportDialog(true)", "setShowWhatsAppImportDialog(true)", "setShowAssignDialog(true)", 'type: "bulkDelete"']) expect(page, s).toContain(s);
    expect(page).toContain("isAdmin,"); // rowActions يمرّر الدور لبوابات الصف (تكرار/حذف/مرتجع)
  });
  it("الفلاتر الحالية + debounce + نطاق التاريخ + المصدر محفوظة", () => {
    for (const s of ["setTimeout(() => applySearch(searchDraft), 300)", "<DateRangePicker value={dateRange}", "value={sourceFilter}", "<MultiSelect", "value={adNameFilter}", "value={employeeFilter}", "value={websiteFilter}", "printedDateFilter", "buildFilterChips(filtersSnapshot, FILTER_DESCRIPTORS)", "resetAllFilters", "clearOneFilter"]) expect(page, s).toContain(s);
    expect(page).toContain('setSearch(""); setSearchDraft("");');
  });
  it("حقول البحث حقيقية فقط: حقل واحد مطابق لسلوك السيرفر، وAWB معطّل «غير متاح» — لا فلترة على العميل", () => {
    expect(page).toContain('{ id: "awb", label: "AWB بوسطة", disabled: true }');
    expect(page).not.toMatch(/\.filter\(\s*\(?o(rder)?\)?\s*=>\s*[^)]*(customerPhone|orderNumber|bostaTrackingNumber)[^)]*includes/);
  });
});

describe("🛡️ الحماية من الضغط المكرر", () => {
  it("كل تأكيد (جدول/بطاقة/درج) يمر عبر confirmOrder؛ لا confirmMutation.mutate مباشر خارج الحارس", () => {
    const direct = page.match(/confirmMutation\.mutate\(/g) ?? [];
    expect(direct).toHaveLength(1); // داخل confirmOrder فقط
    expect(page).toContain("onConfirm: order => confirmOrder(order.id)");
    expect(page).toContain("onClick={() => confirmOrder(drawerOrder.id)}");
    expect(page).toContain("confirmPending: confirmMutation.isPending");
  });
  it("تغيير الحالة في الدرج معطّل أثناء الطلب", () => {
    expect(page).toContain("disabled={updateStatusMutation.isPending}");
    expect(page).toContain("if (updateStatusMutation.isPending) return;");
  });
  it("أزرار التأكيد في الجدول والبطاقة تقرأ confirmPending", () => {
    expect(table).toContain("disabled={actions.confirmPending}");
    expect(mobile).toContain("disabled={actions.confirmPending}");
  });
});

describe("🧩 أجزاء العرض بلا منطق أعمال ولا بيانات مزيفة", () => {
  it("لا tRPC/useQuery/useMutation/BusinessContext/localStorage داخل OrdersTabs/OrdersTable/OrdersMobileList", () => {
    for (const [n, s] of [["OrdersTabs", tabs], ["OrdersTable", table], ["OrdersMobileList", mobile]] as const) expect(s, n).not.toMatch(/@\/lib\/trpc|useQuery|useMutation|BusinessContext|localStorage|fetch\(/);
  });
  it("الجدول: cardsBelow=md؛ توقع الاستلام null؛ محاولات التوصيل null؛ رسوم الشحن من projectedShippingCostSnapshot؛ لا نسب/تواريخ مخترعة", () => {
    // v1: md زي ما هو؛ v2 (قرار 2026-10-19): كروت تحت 1024 عشان مبلغ التحصيل يفضل ظاهر كامل على التابلت.
    expect(table).toContain('cardsBelow={activeBrand() === "v2" ? "lg" : "md"}');
    expect(table).toContain("<ReceiptPrediction probability={null}"); expect(mobile).toContain("<ReceiptPrediction probability={null}");
    expect(table).toContain("deliveryAttempts={null}"); expect(mobile).toContain("deliveryAttempts={null}");
    expect(table).toContain("order.projectedShippingCostSnapshot"); expect(mobile).toContain("order.projectedShippingCostSnapshot");
    for (const s of [table, mobile]) { expect(s).not.toMatch(/Math\.random|probability=\{\d/); expect(s).not.toMatch(/deliveryAttempts=\{order\.noAnswerCallAttempts/); }
  });
  it("أهداف اللمس: بطاقة الموبايل min-h-11؛ التبويبات/النطاق عبر المكوّنات المشتركة", () => {
    expect(mobile).toContain("min-h-11");
    expect(tabs).toContain("UnderlineTabs"); expect(tabs).toContain("ScopeBar"); expect(tabs).toContain("ReviewAttentionBanner");
  });
  it("أسماء/قيم الحالات لم تتغيّر (الصفحة ما زالت تستخدم STATUS_LABEL نفسه)", () => {
    for (const [k, v] of Object.entries({ new: "جديد", confirmed: "مؤكد", printed: "مطبوع", postponed: "مؤجل", cancelled: "ملغي", preparing: "قيد التحضير", shipped: "تم الشحن", delivered: "تم التوصيل", no_answer: "لم يرد", returned: "مرتجع" })) expect(page).toContain(`${k}: "${v}"`);
  });
});
