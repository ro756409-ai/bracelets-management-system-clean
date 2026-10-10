// @vitest-environment jsdom
/**
 * المرحلة 7B — نموذج الإدخال اليدوي/Facebook: 7 أقسام في مسار واحد، أخطاء بجانب الحقل + ملخّص أعلى
 * (مشتقة؛ إصلاح حقل يزيل سببه فقط)، منتج واحد / منتجان بنقشين مختلفين / منتج بمتغيرات، سطر يحتاج
 * اختيارًا، ضغطتان = طلب واحد، مسودة لمستخدمَين ونشاطَين بلا تسريب، الطي لا يفقد البيانات،
 * وحالات Loading/Error/Offline.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean; isError?: boolean };
const st = vi.hoisted(() => ({
  q: {} as Record<string, Q>,
  mut: {} as Record<string, ReturnType<typeof vi.fn>>,
  pending: {} as Record<string, boolean>,
  refetch: {} as Record<string, ReturnType<typeof vi.fn>>,
  scope: { fp: "A" } as any,
  businessId: 1 as number | undefined,
  online: true,
  nextLines: [] as any[],
}));
const { mkQuery, mkMutation } = vi.hoisted(() => ({
  mkQuery: (key: string) => () => {
    st.refetch[key] ??= vi.fn();
    const q = st.q[key] ?? {};
    return { data: q.data, isLoading: q.isLoading ?? false, isError: q.isError ?? false, refetch: st.refetch[key] };
  },
  mkMutation: (key: string) => () => {
    st.mut[key] ??= vi.fn();
    return { mutate: st.mut[key], mutateAsync: vi.fn(), isPending: st.pending[key] ?? false };
  },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    facebookEntry: {
      entryConfig: { useQuery: mkQuery("entryConfig") }, catalog: { useQuery: mkQuery("catalog") }, myOrders: { useQuery: mkQuery("myOrders") },
      addOrder: { useMutation: mkMutation("addOrder") }, updateOrder: { useMutation: mkMutation("updateOrder") }, deleteOrder: { useMutation: mkMutation("deleteOrder") },
    },
    employeePortal: { /* مدخل الرسائل في القشرة: العلم معطل (الافتراضي) */ messages: { status: { useQuery: () => ({ data: { enabled: false } }) }, conversations: { useQuery: () => ({ data: undefined, refetch: async () => ({}) }) } },  me: { useQuery: mkQuery("me") } },
    useUtils: () => ({ facebookEntry: { parsePaste: { fetch: vi.fn() } } }),
  },
}));
vi.mock("@/lib/employeeScope", () => ({
  draftKey: (s: any) => `manualEntryDraft:${s?.fp ?? "anon"}`,
  readEmployeeScope: () => st.scope,
  sanitizeDraftItems: (items: any[]) => ({ items, dropped: 0, needsReview: 0 }),
}));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ businesses: [{ id: 1, name: "براند النحاس" }, { id: 2, name: "براند المفروشات" }], currentBusinessId: st.businessId, currentBusinessIds: undefined, setCurrentBusinessId: vi.fn() }) }));
vi.mock("@/hooks/useGovernorateOptions", () => ({ useGovernorateOptions: () => ({ values: ["القاهرة", "الجيزة"], isLoading: false, isError: false, isConfigured: true }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => st.online }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
// المحافظة/المدينة: بديل بسيط بنفس العقد (القيمة والمعاودة) — Radix Select لا يُفتح في jsdom
vi.mock("@/components/orders/GovernorateCitySelect", () => ({
  GovernorateCitySelect: ({ governorate, onGovernorateChange, city, onCityChange }: any) => (
    <div>
      <label htmlFor="gov-mock">المحافظة</label>
      <select id="gov-mock" value={governorate} onChange={e => onGovernorateChange(e.target.value)} data-testid="gov-select"><option value="">—</option><option value="القاهرة">القاهرة</option><option value="الجيزة">الجيزة</option></select>
      <input aria-label="المدينة" value={city} onChange={e => onCityChange(e.target.value)} />
      {!governorate && <p>مطلوبة</p>}
    </div>
  ),
}));
// المنتقيات: بديل بنفس العقد (value/onChange) يضيف السطر التالي من المخزن — السطور نفسها حقيقية الشكل (PickedItem)
vi.mock("@/components/orders/VariantOrderPicker", () => ({
  VariantOrderPicker: ({ value, onChange }: any) => (
    <div data-testid="vop-mock">
      {value.map((_: any, i: number) => <div key={i} data-testid={`vop-item-${i}`}><button type="button" onClick={() => onChange(value.filter((_: any, j: number) => j !== i))}>حذف {i + 1}</button></div>)}
      <button type="button" data-testid="vop-add" onClick={() => onChange([...value, st.nextLines.shift()])}>إضافة سطر</button>
    </div>
  ),
  variantLabel: () => "", variantDimensions: () => [],
}));
vi.mock("@/components/orders/LegacyEngravingPicker", () => ({
  LegacyEngravingPicker: ({ value, onChange }: any) => (
    <div data-testid="legacy-picker-mock">
      {value.map((_: any, i: number) => <div key={i} data-testid={`legacy-line-${i}`} />)}
      <button type="button" data-testid="legacy-add" onClick={() => onChange([...value, st.nextLines.shift()])}>إضافة</button>
    </div>
  ),
}));

import FacebookEntry from "./FacebookEntry";

const CATALOG = { products: [{ id: 10, name: "سوار نحاسي", currentStock: 9, price: 250, isActive: true }, { id: 11, name: "خاتم", currentStock: 3, price: 120, isActive: true }], variants: [{ id: 100, productId: 10, color: "أسود", size: "M", currentStock: 5, price: 250, isActive: true }, { id: 101, productId: 10, color: "أسود", size: "L", currentStock: 4, price: 250, isActive: true }] };
const line = (over: Partial<any> = {}) => ({ productId: 10, productName: "سوار نحاسي", variantId: 100, sku: null, color: "أسود", size: "M", optionLabel: "أسود / M", quantity: 1, unitPrice: 250, availableStock: 5, ...over });

function setup(mode: "catalog_variants" | "bracelets_legacy" = "catalog_variants") {
  st.q = { entryConfig: { data: { mode } }, catalog: { data: CATALOG }, me: { data: { id: 3, name: "سارة", role: "employee", businessId: 1 } }, myOrders: { data: [] } };
}
function fillCustomer() {
  fireEvent.change(document.getElementById("f-customer-name")!, { target: { value: "منى" } });
  fireEvent.change(document.getElementById("f-customer-phone")!, { target: { value: "01012345678" } });
  fireEvent.change(screen.getByTestId("gov-select"), { target: { value: "القاهرة" } });
  fireEvent.change(document.getElementById("f-address")!, { target: { value: "شارع 1" } });
}

beforeEach(() => {
  st.q = {}; st.mut = {}; st.pending = {}; st.refetch = {}; st.scope = { fp: "A" }; st.businessId = 1; st.online = true; st.nextLines = [];
  localStorage.clear();
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  Element.prototype.scrollIntoView = vi.fn();
  (window as any).requestAnimationFrame = (cb: () => void) => { cb(); return 0; };
});
afterEach(() => cleanup());

describe("🧭 الأقسام والأخطاء المضمّنة", () => {
  it("7 أقسام مرقّمة بالترتيب في صفحة واحدة؛ النشاط والمصدر (فيسبوك) من مصادر حقيقية", () => {
    setup();
    render(<FacebookEntry />);
    const secs = [1, 2, 3, 4, 5, 6, 7].map(n => screen.getByTestId(`entry-section-${n}`));
    for (let i = 1; i < secs.length; i++) expect(secs[i - 1].compareDocumentPosition(secs[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId("entry-business").textContent).toBe("براند النحاس");
    expect(within(screen.getByTestId("entry-source")).getByTestId("partner-logo-facebook")).toBeTruthy();
    expect(screen.getByTestId("line-review-empty")).toBeTruthy();
  });
  it("الملخّص أعلى النموذج يذكر كل الأسباب؛ كتابة الاسم تزيل سبب الاسم فقط؛ خطأ الهاتف بجانب الحقل ويختفي وحده؛ صيغة هاتف خاطئة = تنبيه غير مانع", () => {
    setup();
    render(<FacebookEntry />);
    const summary = () => screen.getByTestId("review-summary").textContent!;
    expect(summary()).toContain("اسم العميل مطلوب"); expect(summary()).toContain("رقم الهاتف مطلوب"); expect(summary()).toContain("المحافظة مطلوبة"); expect(summary()).toContain("العنوان مطلوب"); expect(summary()).toContain("أضف صنفًا واحدًا على الأقل");
    fireEvent.change(document.getElementById("f-customer-name")!, { target: { value: "منى" } });
    expect(summary()).not.toContain("اسم العميل مطلوب"); expect(summary()).toContain("رقم الهاتف مطلوب");
    const phone = document.getElementById("f-customer-phone") as HTMLInputElement;
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("f-customer-phone-error")!.textContent).toContain("رقم الهاتف مطلوب");
    fireEvent.change(phone, { target: { value: "123" } });
    expect(phone.getAttribute("aria-invalid")).toBeNull();
    expect(document.getElementById("f-customer-phone-error")).toBeNull();
    expect(screen.getByTestId("phone-format-warning")).toBeTruthy();
    expect(summary()).not.toContain("رقم الهاتف مطلوب");
    // القفز لحقل الخطأ من الملخّص يركّز الحقل
    fireEvent.click(screen.getByTestId("review-jump-customerAddress"));
    expect(document.activeElement?.id).toBe("f-address");
  });
  it("طي قسم وإعادة فتحه لا يفقد القيم (details) — البيانات تبقى عند العودة", () => {
    setup();
    render(<FacebookEntry />);
    fireEvent.change(document.getElementById("f-customer-name")!, { target: { value: "منى" } });
    const sec = screen.getByTestId("entry-section-2") as HTMLDetailsElement;
    sec.open = false; fireEvent(sec, new Event("toggle"));
    sec.open = true; fireEvent(sec, new Event("toggle"));
    expect((document.getElementById("f-customer-name") as HTMLInputElement).value).toBe("منى");
  });
});

describe("🧾 سيناريوهات الأصناف والحفظ", () => {
  it("منتج واحد: الحفظ يرسل سطرًا واحدًا بـvariantId وسعر الوحدة، والإجمالي = الأصناف + الشحن", () => {
    setup(); st.nextLines = [line()];
    render(<FacebookEntry />);
    fillCustomer();
    fireEvent.click(screen.getByTestId("vop-add"));
    fireEvent.change(screen.getByTestId("sum-shipping"), { target: { value: "50" } });
    expect(screen.getByTestId("sum-total").textContent).toContain("300.00");
    expect(screen.queryByTestId("review-summary")).toBeNull();
    const save = screen.getByTestId("save-order") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect(st.mut.addOrder).toHaveBeenCalledTimes(1);
    const p = st.mut.addOrder.mock.calls[0][0];
    expect(p.selectedProducts).toEqual([{ productId: 10, productName: "سوار نحاسي", quantity: 1, variantId: 100, unitPrice: 250, priceSource: undefined }]);
    expect(p.totalAmount).toBe(300); expect(p.shippingCost).toBe(50); expect(p.governorate).toBe("القاهرة"); expect(p.variantId).toBe(100);
    expect(p).not.toHaveProperty("businessId");
  });
  it("منتجان بنقشين/متغيرين مختلفين: سطران مستقلان في المراجعة والـpayload، لا دمج في قيمة واحدة", () => {
    setup("bracelets_legacy"); st.nextLines = [line({ optionLabel: "نقش اسم", variantId: 100 }), line({ optionLabel: "نقش تاريخ", variantId: 101, quantity: 2 })];
    render(<FacebookEntry />);
    fillCustomer();
    fireEvent.click(screen.getByTestId("legacy-add")); fireEvent.click(screen.getByTestId("legacy-add"));
    expect(screen.getByTestId("line-review-0").textContent).toContain("سطر 1"); expect(screen.getByTestId("line-review-0").textContent).toContain("نقش اسم");
    expect(screen.getByTestId("line-review-1").textContent).toContain("سطر 2"); expect(screen.getByTestId("line-review-1").textContent).toContain("نقش تاريخ");
    expect(screen.getByTestId("line-review-0").textContent).not.toContain("نقش تاريخ");
    expect(screen.getByTestId("sum-pieces").textContent).toBe("3");
    fireEvent.click(screen.getByTestId("save-order"));
    const p = st.mut.addOrder.mock.calls[0][0];
    expect(p.selectedProducts.map((x: any) => x.variantId)).toEqual([100, 101]);
    expect(p.selectedProducts.map((x: any) => x.quantity)).toEqual([1, 2]);
    expect(p.variantId).toBe(100);
  });
  it("سطر بلا منتج/متغير محسوم → خطأ باسم رقم السطر في الملخّص وبجانب السطر، والحفظ معطّل؛ حذفه يزيل السبب", () => {
    setup(); st.nextLines = [line(), line({ productId: 0, productName: "", variantId: undefined, needsPick: true, pickReason: null })];
    render(<FacebookEntry />);
    fillCustomer();
    fireEvent.click(screen.getByTestId("vop-add")); fireEvent.click(screen.getByTestId("vop-add"));
    expect(screen.getByTestId("review-summary").textContent).toContain("اختر المنتج والنوع للصنف رقم 2");
    expect(screen.getByTestId("line-review-warning-1").textContent).toContain("رقم 2");
    expect(screen.queryByTestId("line-review-warning-0")).toBeNull();
    expect((screen.getByTestId("save-order") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("حذف 2"));
    expect(screen.queryByTestId("review-summary")).toBeNull();
    expect((screen.getByTestId("save-order") as HTMLButtonElement).disabled).toBe(false);
  });
  it("ضغطتان سريعتان على الحفظ → mutation واحدة (حارس قيد التنفيذ)", () => {
    setup(); st.nextLines = [line()];
    render(<FacebookEntry />);
    fillCustomer(); fireEvent.click(screen.getByTestId("vop-add"));
    const save = screen.getByTestId("save-order");
    fireEvent.click(save); fireEvent.click(save);
    expect(st.mut.addOrder).toHaveBeenCalledTimes(1);
  });
  it("الحفظ بحقول ناقصة لا يرسل شيئًا (نفس قواعد submit)", () => {
    setup(); st.nextLines = [line()];
    render(<FacebookEntry />);
    fireEvent.click(screen.getByTestId("vop-add"));
    fireEvent.click(screen.getByTestId("save-order"));
    expect(st.mut.addOrder).not.toHaveBeenCalled();
  });
});

describe("💾 المسودة لكل مستخدم ونشاط", () => {
  it("مفتاح المسودة يشمل الحساب والنشاط والقالب؛ مستخدم آخر أو نشاط آخر لا يرى المسودة", () => {
    setup();
    const r1 = render(<FacebookEntry />);
    fireEvent.change(document.getElementById("f-customer-name")!, { target: { value: "منى" } });
    fireEvent.click(screen.getByTestId("save-draft"));
    const keys = Object.keys(localStorage);
    expect(keys).toEqual(["manualEntryDraft:A:ab1:catalog_variants"]);
    r1.unmount();
    // مستخدم B على نفس الجهاز ونفس النشاط
    st.scope = { fp: "B" };
    const r2 = render(<FacebookEntry />);
    expect((document.getElementById("f-customer-name") as HTMLInputElement).value).toBe("");
    r2.unmount();
    // المستخدم A على نشاط آخر
    st.scope = { fp: "A" }; st.businessId = 2;
    const r3 = render(<FacebookEntry />);
    expect((document.getElementById("f-customer-name") as HTMLInputElement).value).toBe("");
    r3.unmount();
    // المستخدم A على النشاط الأصلي → تُسترجع
    st.businessId = 1;
    render(<FacebookEntry />);
    expect((document.getElementById("f-customer-name") as HTMLInputElement).value).toBe("منى");
  });
});

describe("⏳ Loading / Error / Offline", () => {
  it("تحميل الجلسة → status؛ خطأ الكتالوج → ErrorState مع إعادة محاولة داخل قسم الأصناف؛ انقطاع → تنبيه بلا تغيير قواعد الحفظ", () => {
    st.q = { me: { isLoading: true }, entryConfig: {}, catalog: {} };
    const { unmount } = render(<FacebookEntry />);
    expect(screen.getByRole("status").textContent).toContain("جاري التحميل");
    unmount();
    setup(); st.q.catalog = { isError: true, data: undefined };
    const r2 = render(<FacebookEntry />);
    fireEvent.click(within(screen.getByTestId("entry-section-4")).getByRole("button", { name: /إعادة المحاولة/ }));
    expect(st.refetch.catalog).toHaveBeenCalled();
    r2.unmount();
    setup(); st.online = false; st.nextLines = [line()];
    render(<FacebookEntry />);
    expect(screen.getByTestId("offline-state")).toBeTruthy();
    fillCustomer(); fireEvent.click(screen.getByTestId("vop-add"));
    expect((screen.getByTestId("save-order") as HTMLButtonElement).disabled).toBe(false);
  });
});
