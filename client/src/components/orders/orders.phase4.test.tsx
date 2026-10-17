// @vitest-environment jsdom
/**
 * المرحلة 4 — صفحة الأوردرات على التصميم الجديد: أجزاء العرض (OrdersTabs / OrdersTable / OrdersMobileList)
 * + حارس الضغط المكرر. الصفحة نفسها (Orders.tsx) تُحرَس نصيًا في orders.phase4.wiring.test.ts.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";

import { OrdersTabs, TODAY_TAB_KEY } from "./OrdersTabs";
import { OrdersTable, buildOrdersColumns, ORDERS_DESKTOP_COLUMN_ORDER, COLLECTION_STATUS, isActionable, canReturn, drawerStatusOptions, type OrdersColumnsContext, type OrdersRowActions } from "./OrdersTable";
import { OrdersMobileCard, renderOrdersMobileRow } from "./OrdersMobileList";
import { createInFlightGuard } from "./confirmGuard";
import { UNAVAILABLE_LABEL } from "@/components/shared";

const media = { wide: true };
beforeEach(() => {
  media.wide = true;
  (window as any).matchMedia = (q: string) => ({ get matches() { return q.includes("min-width") ? media.wide : false; }, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  Element.prototype.scrollIntoView = vi.fn();
  document.documentElement.dir = "rtl";
});
afterEach(() => cleanup());

const focusables = (root: ParentNode) => Array.from(root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [role=button], [role=tab], [tabindex]:not([tabindex="-1"])'));

function makeActions(over: Partial<OrdersRowActions> = {}): OrdersRowActions {
  return {
    isAdmin: true, confirmPending: false, duplicatePending: false,
    onConfirm: vi.fn(), onCancel: vi.fn(), onDetails: vi.fn(), onPostpone: vi.fn(), onNoAnswer: vi.fn(), onCall: vi.fn(), onEdit: vi.fn(), onDuplicate: vi.fn(), onReturn: vi.fn(), onDelete: vi.fn(),
    ...over,
  };
}
function makeCtx(over: Partial<OrdersColumnsContext> = {}, actions: Partial<OrdersRowActions> = {}): OrdersColumnsContext {
  return {
    seqByOrderId: new Map([[1, 1], [2, 2], [3, 3]]),
    employeeNameById: new Map([[7, "سارة"]]),
    businessNameById: new Map([[11, "براند A"], [12, "براند B"]]),
    sourceLabel: s => (s === "manual" ? "يدوي" : s),
    actions: makeActions(actions),
    ...over,
  };
}
const ROWS = [
  { id: 1, orderNumber: "ORD-1", customerName: "أحمد", customerPhone: "0100", governorate: "القاهرة", city: "مدينة نصر", productName: "سوار", quantity: 2, color: "ذهبي", totalAmount: "350", status: "new", source: "manual", businessId: 11, assignedEmployeeId: 7, createdAt: "2026-10-01T10:30:00Z", updatedAt: "2026-10-02T11:00:00Z", noAnswerCallAttempts: null, collectionStatus: "pending", projectedShippingCostSnapshot: null, paymentMethod: "cod" },
  { id: 2, orderNumber: "ORD-2", customerName: "منى", customerPhone: "0101", governorate: "الجيزة", productName: "خاتم", quantity: 1, totalAmount: "120", status: "no_answer", source: "whatsapp", businessId: 12, createdAt: "2026-10-01T10:30:00Z", noAnswerCallAttempts: 3, collectionStatus: "collected", collectedAmount: "120", projectedShippingCostSnapshot: "45.00", projectedShippingType: "standard", deliveredAt: "2026-10-03T09:00:00Z" },
  { id: 3, orderNumber: "ORD-3", customerName: "سعيد", customerPhone: "0102", productName: "سلسلة", quantity: 1, totalAmount: "90", status: "confirmed", source: "facebook", businessId: 99, createdAt: "2026-10-01T10:30:00Z", collectionStatus: "weird" },
];

describe("🛡️ createInFlightGuard — لا mutation ثانية من double-click", () => {
  it("ضغطتان متتاليتان لنفس المفتاح قبل onSettled → تنفيذ واحد؛ بعد done يُسمح مجددًا؛ isPending يمنع أي مفتاح", () => {
    const guard = createInFlightGuard<number>();
    const run = vi.fn(); let release: () => void = () => {};
    expect(guard.run(1, false, done => { release = done; run(); })).toBe(true);
    expect(guard.run(1, false, run)).toBe(false);
    expect(guard.run(1, false, run)).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(guard.run(2, true, run)).toBe(false); // isPending من React Query يمنع الجميع
    release();
    expect(guard.has(1)).toBe(false);
    expect(guard.run(1, false, d => { run(); d(); })).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("لو fn رمى استثناءً يُحرَّر المفتاح", () => {
    const guard = createInFlightGuard<number>();
    expect(() => guard.run(5, false, () => { throw new Error("x"); })).toThrow();
    expect(guard.has(5)).toBe(false);
  });
});

describe("📋 buildOrdersColumns — ترتيب أعمدة الديسكتوب ومصدر كل قيمة", () => {
  it("الأعمدة الظاهرة بالترتيب المعتمد (17 عمودًا) + seq/website إضافيان مخفيان افتراضيًا", () => {
    const cols = buildOrdersColumns(makeCtx());
    expect(cols.filter(c => !c.defaultHidden).map(c => c.id)).toEqual([...ORDERS_DESKTOP_COLUMN_ORDER]);
    expect(cols.filter(c => c.defaultHidden).map(c => c.id)).toEqual(["seq", "website"]);
    expect(cols[0].id).toBe("seq");
    expect(cols.find(c => c.id === "identifier")!.sticky).toBe("start");
    expect(cols.find(c => c.id === "actions")!.sticky).toBe("end");
    expect(cols.find(c => c.id === "codAmount")!.numeric).toBe(true);
  });
  it("الخلايا: توقع الاستلام ووقت التوصيل «غير متاح»؛ التوصيل لا يُشتق من الاتصال؛ رسوم الشحن من projectedShippingCostSnapshot فقط", () => {
    render(<OrdersTable rows={ROWS as any} columns={buildOrdersColumns(makeCtx())} mobileRow={() => null} hiddenColumns={new Set(["seq", "website"])} />);
    const rows = Array.from(document.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(3);
    // كل صف: توقع الاستلام غير متاح، بلا %
    for (const r of rows) {
      const rp = within(r as HTMLElement).getByTestId("receipt-prediction");
      expect(rp.getAttribute("data-state")).toBe("unavailable"); expect(rp.textContent).not.toContain("%");
      expect(within(r as HTMLElement).getByTestId("attempts-delivery").getAttribute("data-state")).toBe("unavailable");
    }
    const r1 = rows[0] as HTMLElement, r2 = rows[1] as HTMLElement, r3 = rows[2] as HTMLElement;
    expect(within(r1).queryByTestId("attempts-calls")).toBeNull();
    expect(within(r2).getByTestId("attempts-calls").textContent).toBe("اتصال:3");
    // رسوم الشحن المتوقعة
    const cell = (r: HTMLElement, idx: number) => r.querySelectorAll("td")[idx];
    const colIdx = (id: string) => ORDERS_DESKTOP_COLUMN_ORDER.indexOf(id as any);
    expect(cell(r1, colIdx("projectedShipping")).textContent).toBe(UNAVAILABLE_LABEL);
    expect(cell(r2, colIdx("projectedShipping")).textContent).toContain("٤٥"); // أرقام عربية-هندية (ar-EG)
    // النوع: نوع الشحن + الدفع، أو الدفع فقط، أو غير متاح
    expect(cell(r1, colIdx("type")).textContent).toBe("دفع عند الاستلام");
    expect(cell(r2, colIdx("type")).textContent).toBe("standard");
    expect(cell(r3, colIdx("type")).textContent).toBe(UNAVAILABLE_LABEL);
    // حالة التحصيل من collectionStatus + المبلغ المحصّل
    expect(cell(r1, colIdx("collection")).textContent).toContain(COLLECTION_STATUS.pending.label);
    expect(cell(r2, colIdx("collection")).textContent).toContain(COLLECTION_STATUS.collected.label); expect(cell(r2, colIdx("collection")).textContent).toContain("١٢٠");
    expect(cell(r3, colIdx("collection")).textContent).toBe(UNAVAILABLE_LABEL);
    // وقت التوصيل المتوقع غير متاح؛ الوصول الفعلي سطر ثانٍ فقط إن وُجد
    expect(cell(r1, colIdx("expectedDelivery")).textContent).toBe(UNAVAILABLE_LABEL);
    expect(cell(r2, colIdx("expectedDelivery")).textContent).toContain("وصل:");
    // النشاط من الخريطة، وإلا #id
    expect(cell(r1, colIdx("business")).textContent).toBe("براند A"); expect(cell(r3, colIdx("business")).textContent).toBe("#99");
    // المسؤول
    expect(cell(r1, colIdx("assignedEmployee")).textContent).toBe("سارة"); expect(cell(r2, colIdx("assignedEmployee")).textContent).toBe("غير موزع");
    // المصدر بالتسمية من إعدادات النشاط
    expect(cell(r1, colIdx("identifier")).textContent).toContain("يدوي"); expect(cell(r1, colIdx("identifier")).textContent).toContain("#ORD-1");
    // المنتجات × الكمية + التخصيص
    expect(cell(r1, colIdx("products")).textContent).toContain("سوار × 2"); expect(cell(r1, colIdx("products")).textContent).toContain("اللون: ذهبي");
    // التواريخ
    expect(cell(r1, colIdx("dates")).textContent).toContain("آخر تحديث");
  });
  it("الإجراءات: تأكيد/إلغاء فقط للجديد والمؤجل؛ التأكيد معطّل أثناء isPending ولا يستدعي الـcallback", () => {
    const pendingCtx = makeCtx({}, { confirmPending: true });
    render(<OrdersTable rows={ROWS as any} columns={buildOrdersColumns(pendingCtx)} mobileRow={() => null} />);
    const confirm1 = screen.getByTestId("order-confirm-1") as HTMLButtonElement;
    expect(confirm1.disabled).toBe(true); expect(confirm1.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(confirm1); expect(pendingCtx.actions.onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId("order-confirm-2")).toBeNull(); // no_answer غير قابل للتأكيد من الصف
    expect(screen.queryByTestId("order-confirm-3")).toBeNull();
    cleanup();
    const ctx = makeCtx();
    render(<OrdersTable rows={ROWS as any} columns={buildOrdersColumns(ctx)} mobileRow={() => null} />);
    fireEvent.click(screen.getByTestId("order-confirm-1"));
    expect(ctx.actions.onConfirm).toHaveBeenCalledTimes(1); expect(ctx.actions.onConfirm).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    fireEvent.click(screen.getByLabelText("إلغاء الأوردر")); expect(ctx.actions.onCancel).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    fireEvent.click(screen.getAllByLabelText("عرض تفاصيل الأوردر")[1]); expect(ctx.actions.onDetails).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
  });
  it("بوابات الصلاحية: canReturn للمدير فقط وبحالات محددة؛ isActionable للجديد/المؤجل فقط", () => {
    expect(isActionable({ id: 1, status: "new" })).toBe(true); expect(isActionable({ id: 1, status: "postponed" })).toBe(true); expect(isActionable({ id: 1, status: "confirmed" })).toBe(false);
    expect(canReturn({ id: 1, status: "shipped" }, true)).toBe(true); expect(canReturn({ id: 1, status: "shipped" }, false)).toBe(false); expect(canReturn({ id: 1, status: "new" }, true)).toBe(false);
    // D4: مؤكد/قيد التجهيز بلا شحنة = لا مرتجع (السيرفر بيرفضه)، وبشحنة بوسطة = مسموح
    expect(canReturn({ id: 1, status: "confirmed" }, true)).toBe(false); expect(canReturn({ id: 1, status: "preparing" }, true)).toBe(false);
    expect(canReturn({ id: 1, status: "confirmed", bostaShipmentId: "SH1" }, true)).toBe(true); expect(canReturn({ id: 1, status: "delivered" }, true)).toBe(true);
  });

  it("DATA-4: قائمة حالات الدرج ما تعرضش «ملغي» للأوردر المشحون؛ باقي الحالات زي ما هي", () => {
    expect(drawerStatusOptions("shipped")).toEqual(["new", "postponed", "no_answer", "preparing", "shipped"]);
    for (const s of ["new", "postponed", "no_answer", "preparing", "printed", "confirmed"])
      expect(drawerStatusOptions(s), s).toEqual(["new", "postponed", "no_answer", "preparing", "shipped", "cancelled"]);
  });
});

describe("📊 OrdersTable — جدول فقط من 768 وبطاقات فقط تحته + الحالات", () => {
  const ctx = makeCtx();
  const mobileRow = renderOrdersMobileRow(ctx, null, () => {});
  it("شاشة واسعة: جدول واحد، لا بطاقات، والاستعلام على 768px (cardsBelow=md)", () => {
    const seen: string[] = []; const orig = window.matchMedia; (window as any).matchMedia = (q: string) => { seen.push(q); return orig(q); };
    render(<OrdersTable rows={ROWS as any} columns={buildOrdersColumns(ctx)} mobileRow={mobileRow} />);
    expect(document.querySelectorAll("table")).toHaveLength(1);
    expect(screen.queryByTestId("responsive-table-cards")).toBeNull();
    expect(document.querySelectorAll("[data-testid=mobile-order-card]")).toHaveLength(0);
    expect(seen.some(q => q.includes("768px"))).toBe(true); expect(seen.some(q => q.includes("1024px"))).toBe(false);
  });
  it("شاشة ضيقة: بطاقات فقط؛ لا <table> ولا أي عنصر جدول قابل للتركيز في DOM", () => {
    media.wide = false;
    render(<OrdersTable rows={ROWS as any} columns={buildOrdersColumns(ctx)} mobileRow={mobileRow} selectedKeys={new Set()} onSelectionChange={() => {}} hiddenColumns={new Set()} onHiddenColumnsChange={() => {}} />);
    expect(document.querySelector("table")).toBeNull();
    expect(document.querySelectorAll("[data-testid=mobile-order-card]")).toHaveLength(3);
    expect(screen.queryByText("الأعمدة")).toBeNull();
    const f = focusables(document.body);
    expect(f.length).toBeGreaterThan(0);
    for (const el of f) expect(el.closest("[data-testid=mobile-order-card]"), el.outerHTML.slice(0, 80)).not.toBeNull();
  });
  it("Loading / Empty / Error(onRetry) / غير مدير → لا تحديد", () => {
    render(<OrdersTable rows={[]} columns={buildOrdersColumns(ctx)} mobileRow={mobileRow} loading />);
    expect(screen.getByRole("status")).toBeTruthy(); cleanup();
    render(<OrdersTable rows={[]} columns={buildOrdersColumns(ctx)} mobileRow={mobileRow} />);
    expect(screen.getByText("لا توجد أوردرات")).toBeTruthy(); cleanup();
    const onRetry = vi.fn();
    render(<OrdersTable rows={[]} columns={buildOrdersColumns(ctx)} mobileRow={mobileRow} error="انقطع الاتصال" onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toContain("انقطع الاتصال");
    fireEvent.click(screen.getByRole("button", { name: /إعادة المحاولة/ })); expect(onRetry).toHaveBeenCalled(); cleanup();
    render(<OrdersTable rows={ROWS as any} columns={buildOrdersColumns(ctx)} mobileRow={mobileRow} />);
    expect(document.querySelectorAll('[role="checkbox"]')).toHaveLength(0); // بلا selectedKeys (غير مدير) لا عمود تحديد
    cleanup();
    render(<OrdersTable rows={ROWS as any} columns={buildOrdersColumns(ctx)} mobileRow={mobileRow} selectedKeys={new Set()} onSelectionChange={() => {}} />);
    expect(document.querySelectorAll('[role="checkbox"]').length).toBeGreaterThan(0);
  });
});

describe("📱 OrdersMobileCard — نفس الإجراءات، أهداف ≥44px، بيانات صادقة", () => {
  it("مطوية: لا تفاصيل؛ مفتوحة: التفاصيل بكل الحقول «غير متاح» الصادقة + أزرار min-h-11؛ التأكيد معطّل أثناء pending", () => {
    const ctx = makeCtx({}, { confirmPending: true });
    const { rerender } = render(<OrdersMobileCard order={ROWS[0] as any} ctx={ctx} expanded={false} onToggle={() => {}} />);
    expect(screen.queryByTestId("order-card-details-1")).toBeNull();
    rerender(<OrdersMobileCard order={ROWS[0] as any} ctx={ctx} expanded onToggle={() => {}} />);
    const details = screen.getByTestId("order-card-details-1");
    expect(within(details).getByTestId("receipt-prediction").getAttribute("data-state")).toBe("unavailable");
    expect(within(details).getByTestId("attempts-delivery").getAttribute("data-state")).toBe("unavailable");
    expect(details.textContent).toContain("وقت التوصيل المتوقع"); expect(details.textContent).toContain("براند A"); expect(details.textContent).toContain("سارة");
    for (const b of details.querySelectorAll("button")) expect(b.className, b.textContent ?? "").toContain("min-h-11");
    const confirm = screen.getByTestId("order-card-confirm-1") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true); fireEvent.click(confirm); expect(ctx.actions.onConfirm).not.toHaveBeenCalled();
    cleanup();
    const ctx2 = makeCtx();
    render(<OrdersMobileCard order={ROWS[0] as any} ctx={ctx2} expanded onToggle={() => {}} />);
    fireEvent.click(screen.getByTestId("order-card-confirm-1")); expect(ctx2.actions.onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /فتح الأوردر ORD-1/ })); expect(ctx2.actions.onDetails).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    expect(ctx2.actions.onConfirm).toHaveBeenCalledTimes(1); // النقر داخل التفاصيل لا يسرّب
  });
  it("حالة غير قابلة للتأكيد: لا زر تأكيد/إلغاء في البطاقة", () => {
    render(<OrdersMobileCard order={ROWS[1] as any} ctx={makeCtx()} expanded onToggle={() => {}} />);
    expect(screen.queryByTestId("order-card-confirm-2")).toBeNull(); expect(screen.queryByText("إلغاء")).toBeNull();
  });
});

describe("〰️ OrdersTabs — نطاق + تبويبات الحالة + شريط المراجعة", () => {
  const base = {
    businesses: [{ id: 11, name: "براند A" }, { id: 12, name: "براند B" }], scopeValue: null as number | null, onScopeChange: vi.fn(),
    statusCounts: { total: 40, byStatus: { new: 5, confirmed: 7 }, needsReview: 2 }, todayCount: 3, value: "all", onChange: vi.fn(), statusLabel: (k: string) => ({ new: "جديد", confirmed: "مؤكد" } as Record<string, string>)[k] ?? k,
    unassigned: { active: true, disabled: false, count: 9, onToggle: vi.fn() },
  };
  it("12 تبويبًا (الكل + 10 حالات + مؤكدات اليوم) بعدّادات حقيقية فقط؛ القيمة/التغيير؛ الشريط يظهر مع needsReview>0", () => {
    render(<OrdersTabs {...base} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(12);
    expect(tabs[0].textContent).toContain("الكل"); expect(tabs[0].textContent).toContain("40");
    expect(tabs[1].textContent).toContain("جديد"); expect(tabs[1].textContent).toContain("5");
    expect(tabs[3].textContent).toBe("no_answer"); // لا عدّاد لحالة بلا رقم (لا صفر مخترع)
    expect(tabs[11].textContent).toContain("مؤكدات اليوم"); expect(tabs[11].textContent).toContain("3");
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tabs[2]); expect(base.onChange).toHaveBeenCalledWith("confirmed");
    fireEvent.click(tabs[11]); expect(base.onChange).toHaveBeenCalledWith(TODAY_TAB_KEY);
    expect(screen.getByTestId("review-attention-banner").textContent).toContain("2");
    // النطاق
    expect(screen.getByTestId("scope-all").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("scope-12")); expect(base.onScopeChange).toHaveBeenCalledWith(12);
    // غير الموزعة
    const toggle = screen.getByTestId("orders-unassigned-toggle");
    expect(toggle.getAttribute("aria-pressed")).toBe("true"); expect(toggle.textContent).toContain("٩"); expect(toggle.className).toContain("min-h-11");
    fireEvent.click(toggle); expect(base.unassigned.onToggle).toHaveBeenCalled();
  });
  it("نشاط واحد → لا ScopeBar (الزر وحده)؛ needsReview=0 → لا شريط؛ الفلترة بموظف تعطّل زر غير الموزعة", () => {
    render(<OrdersTabs {...base} businesses={[{ id: 11, name: "براند A" }]} statusCounts={{ total: 1, byStatus: {}, needsReview: 0 }} value={TODAY_TAB_KEY} unassigned={{ active: false, disabled: true, count: null, onToggle: vi.fn() }} />);
    expect(screen.queryByTestId("scope-bar")).toBeNull();
    expect(screen.queryByTestId("review-attention-banner")).toBeNull();
    expect((screen.getByTestId("orders-unassigned-toggle") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("tab")[11].getAttribute("aria-selected")).toBe("true");
  });
  it("تنقّل لوحة المفاتيح بين التبويبات (RTL: السهم الأيسر = التالي)", () => {
    const onChange = vi.fn();
    render(<OrdersTabs {...base} onChange={onChange} />);
    act(() => { fireEvent.keyDown(screen.getAllByRole("tab")[0], { key: "ArrowLeft" }); });
    expect(onChange).toHaveBeenCalledWith("new");
  });
});
