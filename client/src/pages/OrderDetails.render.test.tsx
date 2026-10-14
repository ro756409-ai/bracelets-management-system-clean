// @vitest-environment jsdom
/**
 * المرحلة 7B — تفاصيل الأوردر: الأقسام الثمانية ومصادر القيم، البنود لكل قطعة بلا دمج، لا تنبؤات،
 * شريط الإجراءات (بوابات الصلاحية/الحالة، تعطيل أثناء pending، ضغطة مزدوجة = طلب واحد)،
 * حوارات الإلغاء/التأجيل/لم يرد بقواعدها، وحالات Loading/Error/Permission/NotFound/Offline.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean; isError?: boolean; error?: any };
const st = vi.hoisted(() => ({
  user: { id: 1, name: "مالك", role: "admin" } as any,
  permissions: [] as string[],
  online: true,
  q: {} as Record<string, Q>,
  enabled: {} as Record<string, boolean | undefined>,
  refetch: {} as Record<string, ReturnType<typeof vi.fn>>,
  mut: {} as Record<string, ReturnType<typeof vi.fn>>,
  pending: {} as Record<string, boolean>,
  navigated: [] as string[],
}));
const { mkQuery, mkMutation } = vi.hoisted(() => ({
  mkQuery: (key: string) => (_input: unknown, opts?: { enabled?: boolean }) => {
    st.enabled[key] = opts?.enabled;
    st.refetch[key] ??= vi.fn();
    const q = st.q[key] ?? {};
    return { data: q.data, isLoading: q.isLoading ?? false, isError: q.isError ?? false, error: q.error, refetch: st.refetch[key] };
  },
  mkMutation: (key: string) => () => {
    st.mut[key] ??= vi.fn();
    return { mutate: st.mut[key], mutateAsync: vi.fn(), isPending: st.pending[key] ?? false };
  },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    orders: {
      get: { useQuery: mkQuery("get") }, orderItems: { useQuery: mkQuery("orderItems") }, getEditHistory: { useQuery: mkQuery("history") },
      sendToBosta: { useMutation: mkMutation("sendToBosta") }, editOrder: { useMutation: mkMutation("editOrder") }, editOrderItems: { useMutation: mkMutation("editOrderItems") },
      confirm: { useMutation: mkMutation("confirm") }, cancel: { useMutation: mkMutation("cancel") }, postpone: { useMutation: mkMutation("postpone") }, markNoAnswer: { useMutation: mkMutation("noAnswer") },
    },
    carrierAccounts: { status: { useQuery: mkQuery("bostaGate") } },
    products: { list: { useQuery: mkQuery("products") } },
    employees: { activeList: { useQuery: mkQuery("employees") } },
    variants: { all: { useQuery: mkQuery("variants") } },
  },
}));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: st.user, loading: false }) }));
vi.mock("@/hooks/usePermission", () => ({ usePermissions: () => ({ permissions: st.permissions, has: (p: string) => st.permissions.includes(p), isLoading: false }), usePermission: (p: string) => st.permissions.includes(p) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => st.online }));
vi.mock("@/hooks/useGovernorateOptions", () => ({ useGovernorateOptions: () => ({ values: ["القاهرة", "الجيزة"], isLoading: false, isError: false, isConfigured: true }) }));
vi.mock("@/hooks/useOperationalOptions", () => ({ useOperationalOptions: () => ({ options: [{ value: "no_stock", label: "لا يوجد مخزون" }], values: ["no_stock"], isLoading: false }) }));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ businesses: [{ id: 7, name: "براند النحاس" }], currentBusinessIds: undefined, currentBusinessId: undefined, setCurrentBusinessId: vi.fn() }) }));
vi.mock("wouter", () => ({ useRoute: () => [true, { id: "42" }], useLocation: () => ["/order/42", (to: string) => { st.navigated.push(to); }] }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/components/orders/OrderEditDialog", () => ({ OrderEditDialog: () => <div data-testid="order-edit-dialog-mock" />, isValidEgyptianMobile: (p: string) => /^01[0125]\d{8}$/.test(p) }));
vi.mock("@/components/BostaPackageImageField", () => ({ BostaShipmentImagePreview: () => <span data-testid="bosta-image-preview" /> }));

import OrderDetails from "./OrderDetails";

const ITEMS = [
  { id: 1, productName: "سوار نحاسي", variantName: "نقش اسم", quantity: 1, unitPrice: 250 },
  { id: 2, productName: "سوار نحاسي", variantName: "نقش تاريخ", quantity: 2, unitPrice: 250 },
];
const ORDER = {
  id: 42, orderNumber: "MJ-1042", businessId: 7, status: "new", source: "facebook",
  customerName: "منى أحمد", customerPhone: "01012345678", customerPhone2: null, governorate: "القاهرة", city: "مدينة نصر", customerAddress: "شارع 1 بجوار المسجد",
  productName: "سوار نحاسي ×3", quantity: 3, totalAmount: "750", shippingFees: 50, projectedShippingCostSnapshot: null, paymentMethod: "cod", collectionStatus: "pending", collectedAmount: null,
  assignedEmployeeId: 5, assignedAt: "2026-10-08T09:00:00Z", confirmedAt: null, printedAt: null, shippedAt: null, deliveredAt: null, createdAt: "2026-10-08T08:00:00Z",
  bostaShipmentId: null, bostaTrackingNumber: null, bostaSentAt: null, bostaStatus: null, bostaLastError: null,
  needsReview: true, reviewReason: "رقم مكرر في اليوم نفسه", isDuplicate: false, notes: "", adName: "حملة أكتوبر", pageName: "صفحة A",
  noAnswerCallAttempts: null, items: ITEMS, contentChangedAfterShipment: false,
};
const HISTORY = [{ id: 1, field: "customerPhone", oldValue: "01000000000", newValue: "01012345678", editedByName: "سارة", editedByRole: "employee", createdAt: "2026-10-08T10:00:00Z" }];

function setup(order: any = ORDER, extra: Partial<typeof st.q> = {}) {
  st.q = { get: { data: order }, history: { data: HISTORY }, employees: { data: [{ id: 5, name: "كريم" }] }, products: { data: [] }, variants: { data: [] }, bostaGate: { data: { canSend: true, reason: null } }, ...extra };
}

beforeEach(() => {
  st.user = { id: 1, name: "مالك", role: "admin" }; st.permissions = []; st.online = true; st.q = {}; st.enabled = {}; st.mut = {}; st.pending = {}; st.navigated = [];
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  Element.prototype.scrollIntoView = vi.fn();
  (window as any).open = vi.fn();
});
afterEach(() => cleanup());

describe("📋 الأقسام الثمانية ومصادر القيم", () => {
  it("المالك: 8 أقسام بالترتيب؛ قيم من الأوردر فقط؛ لا تنبؤ؛ شعار المصدر فقط؛ لا شعار Bosta بلا شحنة", () => {
    setup();
    render(<OrderDetails />);
    const ids = ["identity", "customer", "items", "prices", "shipping", "assignment", "review", "log"].map(k => screen.getByTestId(`od-section-${k}`));
    for (let i = 1; i < ids.length; i++) expect(ids[i - 1].compareDocumentPosition(ids[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("od-section-identity").textContent).toContain("MJ-1042");
    expect(screen.getByTestId("od-section-identity").textContent).toContain("حملة أكتوبر");
    expect(screen.getByTestId("od-section-customer").textContent).toContain("منى أحمد");
    expect(screen.getByTestId("od-section-customer").textContent).toContain("01012345678");
    expect(screen.getByTestId("od-section-customer").textContent).toContain("مدينة نصر");
    // الأسعار: المبلغ/الشحن المسجل/المتوقع «غير متاح»/الدفع/التحصيل
    const prices = screen.getByTestId("od-section-prices").textContent!;
    expect(prices).toContain("٧٥٠"); expect(prices).toContain("٥٠"); expect(prices).toContain("دفع عند الاستلام"); expect(prices).toContain("قيد التحصيل"); expect(prices).toContain("غير متاح");
    // الشحن: لا ناقل → غير متاح؛ لا تنبؤ؛ محاولات التوصيل غير متاحة
    const ship = screen.getByTestId("od-section-shipping");
    expect(within(ship).queryByTestId("partner-logo-bosta")).toBeNull();
    expect(within(ship).getByTestId("receipt-prediction").textContent).toContain("غير متاح");
    expect(within(ship).getByTestId("attempts-delivery").getAttribute("data-state")).toBe("unavailable");
    expect(ship.textContent).not.toMatch(/[0-9٠-٩]+\s*%/);
    // المسؤول والنشاط من lookups حقيقية
    expect(screen.getByTestId("od-section-assignment").textContent).toContain("كريم");
    expect(screen.getByTestId("od-section-assignment").textContent).toContain("براند النحاس");
    // المراجعة: needsReview من الأوردر
    expect(screen.getByTestId("od-review-needsReview").textContent).toContain("رقم مكرر في اليوم نفسه");
    // السجل من getEditHistory
    expect(screen.getByTestId("od-section-log").textContent).toContain("سارة");
    expect(st.enabled.history).toBe(true);
    // الشعار الصحيح للمصدر فقط
    expect(screen.getAllByTestId("partner-logo-facebook").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("partner-logo-bosta")).toBeNull();
    expect(screen.queryByTestId("partner-logo-easyorders")).toBeNull();
  });
  it("البنود: قطعتان بنقشين مختلفين تُعرضان سطرين مستقلين (لا دمج) وإجمالي القطع من البنود", () => {
    setup();
    render(<OrderDetails />);
    expect(screen.getByTestId("od-item-0").textContent).toContain("نقش اسم");
    expect(screen.getByTestId("od-item-1").textContent).toContain("نقش تاريخ");
    expect(screen.getByTestId("od-item-0").textContent).not.toContain("نقش تاريخ");
    expect(screen.getByTestId("od-total-pieces").textContent).toContain("3");
  });
  it("شحنة Bosta حقيقية → شعار Bosta ورقم التتبع وحالة الشحنة؛ بلا شحنة لا شيء من ذلك", () => {
    setup({ ...ORDER, status: "shipped", bostaShipmentId: "SH1", bostaTrackingNumber: "TRK99", bostaStatus: "IN_TRANSIT", bostaSentAt: "2026-10-08T12:00:00Z" });
    render(<OrderDetails />);
    const ship = screen.getByTestId("od-section-shipping");
    expect(within(ship).getByTestId("partner-logo-bosta")).toBeTruthy();
    expect(ship.textContent).toContain("TRK99"); expect(ship.textContent).toContain("IN_TRANSIT");
    expect(within(ship).getByRole("button", { name: /طباعة AWB/ })).toBeTruthy();
  });
  it("لا بنود تفصيلية → سطر من رأس الأوردر مع توضيح صريح", () => {
    setup({ ...ORDER, items: [] });
    render(<OrderDetails />);
    expect(screen.getByTestId("od-section-items").textContent).toContain("لا توجد بنود تفصيلية");
  });
  it("لا أسباب مراجعة → حالة فارغة واضحة؛ هاتف غير صالح → سبب جودة بيانات بجانب الحقل وفي القسم", () => {
    setup({ ...ORDER, needsReview: false, reviewReason: null });
    const { unmount } = render(<OrderDetails />);
    expect(screen.getByTestId("od-section-review").textContent).toContain("لا ملاحظات مراجعة");
    unmount();
    setup({ ...ORDER, needsReview: false, customerPhone: "123" });
    render(<OrderDetails />);
    expect(screen.getByTestId("od-review-phone")).toBeTruthy();
    expect(screen.getByTestId("od-section-customer").textContent).toContain("رقم غير صالح");
  });
});

describe("🎛️ شريط الإجراءات: الصلاحيات والحالة والتعطيل", () => {
  it("المالك + أوردر جديد: تأكيد/إلغاء/تأجيل/لم يرد/واتساب/المزيد؛ ضغطتان على تأكيد = طلب واحد", () => {
    setup();
    render(<OrderDetails />);
    const bar = screen.getByTestId("order-action-bar");
    for (const t of ["action-confirm", "action-cancel", "action-postpone", "action-no-answer", "action-more"]) expect(within(bar).getByTestId(t)).toBeTruthy();
    expect(within(bar).getByRole("button", { name: /واتساب/ })).toBeTruthy();
    const confirm = within(bar).getByTestId("action-confirm");
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(st.mut.confirm).toHaveBeenCalledTimes(1);
    expect(st.mut.confirm.mock.calls[0][0]).toEqual({ orderId: 42, operationId: expect.stringMatching(/^[A-Za-z0-9_-]{8,80}$/) });
  });
  it("أثناء pending: كل أزرار الشريط معطّلة", () => {
    setup(); st.pending.postpone = true;
    render(<OrderDetails />);
    const bar = screen.getByTestId("order-action-bar");
    for (const t of ["action-confirm", "action-cancel", "action-postpone", "action-no-answer", "action-more"]) expect((within(bar).getByTestId(t) as HTMLButtonElement).disabled).toBe(true);
    expect(bar.getAttribute("aria-busy")).toBe("true");
  });
  it("موظف بلا صلاحيات: لا أزرار إجراء ولا حوارات — واتساب فقط", () => {
    setup(); st.user = { id: 2, name: "موظف", role: "user" }; st.permissions = ["orders.view"];
    render(<OrderDetails />);
    const bar = screen.getByTestId("order-action-bar");
    for (const t of ["action-confirm", "action-cancel", "action-postpone", "action-no-answer"]) expect(within(bar).queryByTestId(t)).toBeNull();
    expect(within(bar).getByRole("button", { name: /واتساب/ })).toBeTruthy();
    expect(screen.queryByTestId("cancel-order-dialog")).toBeNull();
    // «المزيد» للموظف: تعديل الأصناف فقط (لا تعديل بيانات ولا AWB)
    expect(within(bar).getByTestId("action-more")).toBeTruthy();
  });
  it("موظف بصلاحية orders.cancel فقط → زر الإلغاء وحده", () => {
    setup(); st.user = { id: 2, name: "موظف", role: "user" }; st.permissions = ["orders.cancel"];
    render(<OrderDetails />);
    const bar = screen.getByTestId("order-action-bar");
    expect(within(bar).getByTestId("action-cancel")).toBeTruthy();
    for (const t of ["action-confirm", "action-postpone", "action-no-answer"]) expect(within(bar).queryByTestId(t)).toBeNull();
  });
  it("حالة غير قابلة للإجراء (confirmed) → لا تأكيد/إلغاء/تأجيل/لم يرد حتى للمالك", () => {
    setup({ ...ORDER, status: "confirmed" });
    render(<OrderDetails />);
    const bar = screen.getByTestId("order-action-bar");
    for (const t of ["action-confirm", "action-cancel", "action-postpone", "action-no-answer"]) expect(within(bar).queryByTestId(t)).toBeNull();
    expect(within(bar).getByTestId("action-more")).toBeTruthy();
  });
});

describe("🗨️ حوارات الإجراءات بقواعد صفحة الأوردرات", () => {
  it("الإلغاء: السبب إلزامي — زر التأكيد معطّل بلا سبب", () => {
    setup();
    render(<OrderDetails />);
    fireEvent.click(screen.getByTestId("action-cancel"));
    const dlg = screen.getByTestId("cancel-order-dialog");
    expect((within(dlg).getByTestId("cancel-confirm") as HTMLButtonElement).disabled).toBe(true);
    expect(st.mut.cancel).not.toHaveBeenCalled();
  });
  it("التأجيل: التاريخ إلزامي؛ بعد إدخاله يُرسل postponedTo كتاريخ", () => {
    setup();
    render(<OrderDetails />);
    fireEvent.click(screen.getByTestId("action-postpone"));
    const dlg = screen.getByTestId("postpone-order-dialog");
    const btn = within(dlg).getByTestId("postpone-confirm") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(within(dlg).getByTestId("postpone-date"), { target: { value: "2099-01-15" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(st.mut.postpone).toHaveBeenCalledTimes(1);
    const arg = st.mut.postpone.mock.calls[0][0];
    expect(arg.orderId).toBe(42); expect(arg.postponedTo).toBeInstanceOf(Date);
  });
  it("لم يرد: المحاولات اختيارية؛ اختيار 2 يُرسل callAttempts=2 — محاولات اتصال لا توصيل", () => {
    setup();
    render(<OrderDetails />);
    fireEvent.click(screen.getByTestId("action-no-answer"));
    const dlg = screen.getByTestId("no-answer-dialog");
    expect(dlg.textContent).toContain("لا تُحسب محاولات توصيل");
    fireEvent.click(within(dlg).getByRole("button", { name: "2" }));
    fireEvent.click(within(dlg).getByTestId("no-answer-confirm"));
    expect(st.mut.noAnswer).toHaveBeenCalledWith({ orderId: 42, callAttempts: 2, operationId: expect.stringMatching(/^[A-Za-z0-9_-]{8,80}$/) });
  });
});

describe("⏳ Loading / Error / Permission / NotFound / Offline", () => {
  it("Loading → هيكل بحالة status؛ لا أقسام", () => {
    st.q = { get: { isLoading: true } };
    render(<OrderDetails />);
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByTestId("od-section-identity")).toBeNull();
  });
  it("Error عام → ErrorState مع إعادة المحاولة؛ FORBIDDEN → PermissionDenied", () => {
    st.q = { get: { isError: true, error: { message: "انقطع" } } };
    const { unmount } = render(<OrderDetails />);
    fireEvent.click(screen.getByRole("button", { name: /إعادة المحاولة/ }));
    expect(st.refetch.get).toHaveBeenCalled();
    unmount();
    st.q = { get: { isError: true, error: { message: "x", data: { code: "FORBIDDEN" } } } };
    render(<OrderDetails />);
    expect(screen.getByText("لا تملك صلاحية الوصول")).toBeTruthy();
  });
  it("غير موجود → حالة فارغة مع زر عودة حقيقي", () => {
    st.q = { get: { data: undefined } };
    render(<OrderDetails />);
    expect(screen.getByText("الأوردر غير موجود")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /العودة للأوردرات/ }));
    expect(st.navigated).toEqual(["/orders"]);
  });
  it("Offline بلا بيانات → OfflineState؛ Offline مع بيانات مخزّنة → الصفحة تظل مقروءة", () => {
    st.online = false; st.q = { get: { data: undefined } };
    const { unmount } = render(<OrderDetails />);
    expect(screen.getByTestId("offline-state")).toBeTruthy();
    unmount();
    setup();
    render(<OrderDetails />);
    expect(screen.getByTestId("od-section-identity")).toBeTruthy();
  });
});

describe("📦 محتاج استكمال بيانات (تنبيه مستقل — ليس حالة)", () => {
  it("أوردر مؤكد بعنوان قصير ومحافظة غير معروفة: يفتح، يظهر التنبيه بالأسباب، وزر إرسال بوسطة معطّل بالسبب", () => {
    setup({ ...ORDER, status: "confirmed", customerAddress: "شارع 1", governorate: "ال" });
    render(<OrderDetails />);
    const review = screen.getByTestId("od-section-review").textContent!;
    expect(review).toContain("محتاج استكمال بيانات");
    expect(review).toContain("العنوان قصير — 10 أحرف على الأقل (الحالي 6)");
    expect(review).toContain("«ال» غير معروفة");
    expect((screen.getByTestId("bosta-send") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("bosta-send-block").textContent).toContain("محتاج استكمال بيانات");
  });
  it("أوردر مؤكد مكتمل: لا تنبيه، وزر الإرسال متاح؛ حالة «جديد» لا تُظهر أزرار بوسطة أصلًا", () => {
    setup({ ...ORDER, status: "confirmed" });
    render(<OrderDetails />);
    expect(screen.getByTestId("od-section-review").textContent).not.toContain("محتاج استكمال بيانات");
    expect((screen.getByTestId("bosta-send") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("bosta-send-block")).toBeNull();
    cleanup(); setup(); render(<OrderDetails />);
    expect(screen.queryByTestId("bosta-controls")).toBeNull();
  });
});
