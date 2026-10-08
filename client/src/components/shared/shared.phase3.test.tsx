// @vitest-environment jsdom
/**
 * المرحلة 3 — المكوّنات المشتركة (Copper Signature): عرض + لوحة مفاتيح + وصول لكل مكوّن جديد،
 * وتوافق API للمكوّنات المطوَّرة (StatusBadge / MobileOrderCard / ResponsiveDataTable).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

import {
  StatusBadge, ORDER_STATUS, ORDER_SOURCE, STOCK_STATUS,
  MobileOrderCard, ResponsiveDataTable, type Column,
  UnderlineTabs, ScopeBar, ReviewAttentionBanner, OrderToolbar, CustomerCell, TwoLineCell,
  AttemptsCell, UNAVAILABLE_LABEL, ReceiptPrediction, PREDICTION_UNAVAILABLE, receiptBand, OfflineState,
} from "./index";

// matchMedia قابل للتحكم: `wide` يحدد نتيجة استعلامات min-width
const media = { wide: true, listeners: [] as Array<() => void> };
beforeEach(() => {
  media.wide = true; media.listeners = [];
  (window as any).matchMedia = (q: string) => ({
    get matches() { return q.includes("min-width") ? media.wide : false; },
    media: q,
    addEventListener: (_: string, fn: () => void) => { media.listeners.push(fn); },
    removeEventListener: (_: string, fn: () => void) => { media.listeners = media.listeners.filter(l => l !== fn); },
    addListener() {}, removeListener() {},
  });
  Element.prototype.scrollIntoView = vi.fn();
  document.documentElement.dir = "rtl";
});
afterEach(() => cleanup());

/** كل ما يمكن أن يصل إليه Tab داخل عنصر */
const focusables = (root: ParentNode) =>
  Array.from(root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'));

describe("🏷️ StatusBadge — نص + أيقونة دلالية، لا لون فقط؛ API متوافق", () => {
  it("كل حالة أوردر تعرض النص + أيقونة svg مخفية عن القارئ + data-status/data-tone + title", () => {
    for (const key of Object.keys(ORDER_STATUS)) {
      const { container, unmount } = render(<StatusBadge status={key} />);
      const badge = container.firstElementChild as HTMLElement;
      expect(badge.textContent).toBe(ORDER_STATUS[key].label);
      expect(badge.getAttribute("data-status")).toBe(key);
      expect(badge.getAttribute("data-tone")).toBe(ORDER_STATUS[key].tone);
      expect(badge.getAttribute("title")).toBe(ORDER_STATUS[key].label);
      const svg = badge.querySelector("svg");
      expect(svg, `أيقونة ${key}`).not.toBeNull();
      expect(svg!.getAttribute("aria-hidden")).toBe("true");
      unmount();
    }
  });
  it("أيقونات الحالات المتعارضة مختلفة (ملغي ≠ مرتجع، مؤكد ≠ تم التوصيل، لم يرد ≠ مؤجل)", () => {
    const pairs: Array<[string, string]> = [["cancelled", "returned"], ["confirmed", "delivered"], ["no_answer", "postponed"], ["new", "shipped"]];
    for (const [a, b] of pairs) expect(ORDER_STATUS[a].icon, `${a} vs ${b}`).not.toBe(ORDER_STATUS[b].icon);
  });
  it("الخصائص القديمة كما هي: kind/label/tone/size/className؛ حالة غير معروفة تعرض قيمتها الخام؛ المصدر نقطة فقط", () => {
    const { container } = render(<StatusBadge status="weird" label="مخصص" tone="warning" size="sm" className="x-custom" />);
    const b = container.firstElementChild as HTMLElement;
    expect(b.textContent).toBe("مخصص"); expect(b.getAttribute("data-tone")).toBe("warning"); expect(b.className).toContain("x-custom"); expect(b.className).toContain("text-[11px]");
    cleanup();
    const raw = render(<StatusBadge status="unknown_x" />).container.firstElementChild as HTMLElement;
    expect(raw.textContent).toBe("unknown_x");
    cleanup();
    const src = render(<StatusBadge status="whatsapp" kind="source" />).container.firstElementChild as HTMLElement;
    expect(src.textContent).toBe(ORDER_SOURCE.whatsapp.label); expect(src.querySelector("svg")).toBeNull(); expect(src.querySelector("[aria-hidden]")).not.toBeNull();
    cleanup();
    const stock = render(<StatusBadge status="low" kind="stock" />).container.firstElementChild as HTMLElement;
    expect(stock.textContent).toBe(STOCK_STATUS.low.label); expect(stock.querySelector("svg")).not.toBeNull();
    cleanup();
    const noIcon = render(<StatusBadge status="new" icon={null} />).container.firstElementChild as HTMLElement;
    expect(noIcon.querySelector("svg")).toBeNull();
  });
});

describe("📱 MobileOrderCard — role=button + Enter/Space + زر تفاصيل ≥44px", () => {
  const base = { orderNumber: "ORD-1001", customerName: "أحمد علي", customerPhone: "01012345678", governorate: "القاهرة", statusBadge: <StatusBadge status="new" />, productSummary: "سوار نحاسي × 2", total: "350 ج.م" };
  it("بلا onClick: لا role ولا tabIndex؛ مع onClick: role=button في ترتيب التركيز ويستجيب لـEnter/Space", () => {
    const { container } = render(<MobileOrderCard {...base} />);
    expect(container.querySelector('[role="button"]')).toBeNull();
    expect(focusables(container)).toHaveLength(0);
    cleanup();
    const onClick = vi.fn();
    render(<MobileOrderCard {...base} onClick={onClick} />);
    const btn = screen.getByRole("button", { name: /فتح الأوردر ORD-1001/ });
    expect(btn.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(btn, { key: "Enter" }); fireEvent.keyDown(btn, { key: " " }); fireEvent.keyDown(btn, { key: "a" });
    expect(onClick).toHaveBeenCalledTimes(2);
    fireEvent.click(btn); expect(onClick).toHaveBeenCalledTimes(3);
  });
  it("زر التفاصيل min-h-11 + aria-expanded ولا يفتح الأوردر عند النقر/المفاتيح؛ التفاصيل تظهر فقط عند expanded", () => {
    const onClick = vi.fn(); const onToggle = vi.fn();
    const { rerender } = render(<MobileOrderCard {...base} onClick={onClick} onToggle={onToggle} details={<span>تفاصيل كاملة</span>} />);
    const toggle = screen.getByRole("button", { name: /عرض التفاصيل/ });
    expect(toggle.className).toContain("min-h-11"); expect(toggle.getAttribute("type")).toBe("button"); expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("تفاصيل كاملة")).toBeNull();
    fireEvent.click(toggle); fireEvent.keyDown(toggle, { key: "Enter" });
    expect(onToggle).toHaveBeenCalledTimes(1); expect(onClick).not.toHaveBeenCalled();
    rerender(<MobileOrderCard {...base} onClick={onClick} onToggle={onToggle} expanded details={<span>تفاصيل كاملة</span>} />);
    expect(screen.getByText("تفاصيل كاملة")).toBeTruthy();
    expect(screen.getByRole("button", { name: /إخفاء التفاصيل/ }).getAttribute("aria-expanded")).toBe("true");
  });
  it("الرقم والهاتف LTR بخط DM Sans (font-en) وأرقام جدولية", () => {
    const { container } = render(<MobileOrderCard {...base} />);
    const ltr = Array.from(container.querySelectorAll('[dir="ltr"]')).map(e => e.textContent);
    expect(ltr).toEqual(["ORD-1001", "01012345678"]);
    for (const el of container.querySelectorAll('[dir="ltr"]')) { expect(el.className).toContain("font-en"); expect(el.className).toContain("tabular-nums"); }
  });
});

type Row = { id: number; name: string; total: number };
const ROWS: Row[] = [{ id: 1, name: "أ", total: 10 }, { id: 2, name: "ب", total: 20 }, { id: 3, name: "ج", total: 30 }];
const COLS: Column<Row>[] = [
  { id: "name", header: "الاسم", cell: r => r.name, sticky: "start" },
  { id: "total", header: "الإجمالي", cell: r => r.total, numeric: true, sticky: "end" },
  // `true` = الحافة الختامية (end) — سلوك المستهلكين القدامى الذين يثبّتون عمود الإجراءات الأخير
  { id: "act", header: "إجراء", cell: r => <button type="button">فتح {r.id}</button>, sticky: true },
];
const cardRow = (r: Row) => <div data-testid={`card-${r.id}`}><button type="button">بطاقة {r.id}</button></div>;

describe("📊 ResponsiveDataTable — نسخة واحدة في DOM، تثبيت منطقي، API قديم كما هو", () => {
  it("شاشة واسعة: الجدول وحده (لا بطاقات في DOM إطلاقًا) حتى مع mobileRow", () => {
    render(<ResponsiveDataTable rows={ROWS} columns={COLS} rowKey={r => r.id} mobileRow={cardRow} />);
    expect(screen.getByTestId("responsive-table-table")).toBeTruthy();
    expect(screen.queryByTestId("responsive-table-cards")).toBeNull();
    expect(screen.queryByTestId("card-1")).toBeNull();
    expect(focusables(document.body).filter(b => b.textContent?.startsWith("بطاقة"))).toHaveLength(0);
  });
  it("شاشة ضيقة + mobileRow: البطاقات وحدها؛ لا جدول ولا زر أعمدة ولا أي عنصر جدول قابل للتركيز", () => {
    media.wide = false;
    render(<ResponsiveDataTable rows={ROWS} columns={COLS} rowKey={r => r.id} mobileRow={cardRow} hiddenColumns={new Set()} onHiddenColumnsChange={() => {}} />);
    expect(screen.getByTestId("responsive-table-cards")).toBeTruthy();
    expect(screen.queryByTestId("responsive-table-table")).toBeNull();
    expect(document.querySelector("table")).toBeNull();
    expect(screen.queryByText("الأعمدة")).toBeNull();
    expect(focusables(document.body).map(b => b.textContent)).toEqual(["بطاقة 1", "بطاقة 2", "بطاقة 3"]);
  });
  it("شاشة ضيقة بلا mobileRow: الجدول يبقى (سلوك المستهلكين الحاليين دون تغيير)", () => {
    media.wide = false;
    render(<ResponsiveDataTable rows={ROWS} columns={COLS} rowKey={r => r.id} />);
    expect(screen.getByTestId("responsive-table-table")).toBeTruthy();
    expect(screen.queryByTestId("responsive-table-cards")).toBeNull();
  });
  it("تغيّر matchMedia وقت التشغيل يبدّل النسخة (بطاقات ⇄ جدول) دون إعادة تحميل", () => {
    render(<ResponsiveDataTable rows={ROWS} columns={COLS} rowKey={r => r.id} mobileRow={cardRow} />);
    expect(screen.getByTestId("responsive-table-table")).toBeTruthy();
    media.wide = false;
    const { act } = require("@testing-library/react");
    act(() => { media.listeners.forEach(l => l()); });
    expect(screen.queryByTestId("responsive-table-table")).toBeNull();
    expect(screen.getByTestId("responsive-table-cards")).toBeTruthy();
  });
  it("sticky منطقي: start-0 / end-0 فقط — لا left-0/right-0؛ المحاذاة text-start/text-end", () => {
    render(<ResponsiveDataTable rows={ROWS} columns={COLS} rowKey={r => r.id} />);
    const ths = Array.from(document.querySelectorAll("th"));
    const name = ths.find(t => t.textContent?.includes("الاسم"))!; const total = ths.find(t => t.textContent?.includes("الإجمالي"))!;
    expect(name.className).toContain("sticky"); expect(name.className).toContain("start-0"); expect(name.className).toContain("text-start");
    expect(total.className).toContain("sticky"); expect(total.className).toContain("end-0"); expect(total.className).toContain("text-end");
    const act = ths.find(t => t.textContent?.includes("إجراء"))!;
    expect(act.className).toContain("end-0"); expect(act.className).not.toContain("start-0"); // true = end
    for (const el of document.querySelectorAll("th, td")) { expect(el.className).not.toMatch(/\b(left|right)-0\b/); expect(el.className).not.toMatch(/\btext-(left|right)\b/); }
    const firstTd = document.querySelector("tbody td")!;
    expect(firstTd.className).toContain("start-0");
  });
  it("cardsBelow=md يستعلم 768 بدل 1024 (اختيار صريح للصفحة)", () => {
    const seen: string[] = [];
    const orig = window.matchMedia;
    (window as any).matchMedia = (q: string) => { seen.push(q); return orig(q); };
    render(<ResponsiveDataTable rows={ROWS} columns={COLS} rowKey={r => r.id} mobileRow={cardRow} cardsBelow="md" />);
    expect(seen.some(q => q.includes("768px"))).toBe(true); expect(seen.some(q => q.includes("1024px"))).toBe(false);
    cleanup();
    seen.length = 0;
    render(<ResponsiveDataTable rows={ROWS} columns={COLS} rowKey={r => r.id} mobileRow={cardRow} />);
    expect(seen.some(q => q.includes("1024px"))).toBe(true);
  });
  it("التحديد والفرز والمفاتيح كما كانت: صف قابل للتركيز، Enter يفتح، مسافة تحدد، Shift+نقر نطاق", () => {
    const onRowClick = vi.fn(); const onSelectionChange = vi.fn(); const onSortChange = vi.fn();
    render(<ResponsiveDataTable rows={ROWS} columns={COLS} rowKey={r => r.id} onRowClick={onRowClick} selectedKeys={new Set()} onSelectionChange={onSelectionChange} sort={null} onSortChange={onSortChange} />);
    const trs = Array.from(document.querySelectorAll("tbody tr"));
    expect(trs[0].getAttribute("tabindex")).toBe("0"); expect(trs[1].getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(trs[0], { key: "Enter" }); expect(onRowClick).toHaveBeenCalledWith(ROWS[0]);
    fireEvent.keyDown(trs[0], { key: " " }); expect(onSelectionChange).toHaveBeenCalled();
    fireEvent.keyDown(trs[0], { key: "ArrowDown" }); expect(document.activeElement).toBe(trs[1]);
    const sortBtn = Array.from(document.querySelectorAll("th button")).find(b => b.textContent?.includes("الاسم"));
    expect(sortBtn).toBeUndefined(); // لا sortable → لا زر فرز (سلوك قديم)
  });
  it("حالات التحميل/الخطأ/الفراغ تعرض مكوّناتها بدل الجدول", () => {
    render(<ResponsiveDataTable rows={[]} columns={COLS} rowKey={r => r.id} loading />);
    expect(screen.getByRole("status")).toBeTruthy(); cleanup();
    const onRetry = vi.fn();
    render(<ResponsiveDataTable rows={[]} columns={COLS} rowKey={r => r.id} error="عطل" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole("button", { name: /إعادة المحاولة/ })); expect(onRetry).toHaveBeenCalled(); cleanup();
    render(<ResponsiveDataTable rows={[]} columns={COLS} rowKey={r => r.id} empty={{ title: "لا شيء" }} />);
    expect(screen.getByText("لا شيء")).toBeTruthy(); expect(document.querySelector("table")).toBeNull();
  });
});

describe("〰️ UnderlineTabs — tablist + أسهم (RTL) + Home/End + تركيز واحد", () => {
  const TABS = [{ key: "all", label: "الكل", count: 12 }, { key: "new", label: "جديد", count: 3 }, { key: "review", label: "مراجعة", count: null }];
  it("role=tablist/tab، النشط وحده tabindex=0 وaria-selected، العدّاد يظهر فقط عند وجود رقم، كل تبويب ≥44px shrink-0", () => {
    render(<UnderlineTabs tabs={TABS} value="new" onChange={() => {}} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(tabs.map(t => t.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    expect(tabs.map(t => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    for (const t of tabs) { expect(t.className).toContain("min-h-11"); expect(t.className).toContain("shrink-0"); expect(t.getAttribute("type")).toBe("button"); }
    expect(within(tabs[0]).getByText("12")).toBeTruthy();
    expect(tabs[2].textContent).toBe("مراجعة");
    expect(screen.getByRole("tablist").className).toContain("overflow-x-auto");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
  it("RTL: السهم الأيسر = التالي، الأيمن = السابق، Home/End، والدوران عند الطرف", () => {
    const changes: string[] = [];
    const { rerender } = render(<UnderlineTabs tabs={TABS} value="all" onChange={k => { changes.push(k); rerender(<UnderlineTabs tabs={TABS} value={k} onChange={k2 => changes.push(k2)} />); }} />);
    fireEvent.keyDown(screen.getByTestId("underline-tab-all"), { key: "ArrowLeft" });
    expect(changes.at(-1)).toBe("new");
    fireEvent.keyDown(screen.getByTestId("underline-tab-all"), { key: "ArrowRight" });
    expect(changes.at(-1)).toBe("review"); // دوران للخلف من الأول إلى الأخير
    fireEvent.keyDown(screen.getByTestId("underline-tab-all"), { key: "End" }); expect(changes.at(-1)).toBe("review");
    fireEvent.keyDown(screen.getByTestId("underline-tab-all"), { key: "Home" }); expect(changes.at(-1)).toBe("all");
  });
  it("LTR: الاتجاه ينعكس (السهم الأيمن = التالي)", () => {
    document.documentElement.dir = "ltr";
    const onChange = vi.fn();
    render(<UnderlineTabs tabs={TABS} value="all" onChange={onChange} />);
    fireEvent.keyDown(screen.getByTestId("underline-tab-all"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("new");
  });
});

describe("🎯 ScopeBar — اختيار أحادي aria-pressed ≥44px، لون النشاط من البيانات فقط", () => {
  const OPTS = [{ id: 1, label: "براند A", color: "#B87333" }, { id: 2, label: "براند B" }];
  it("«كل الأنشطة» مضغوط عند null؛ النقر يرسل id أو null؛ بلا لون → أول حرف؛ بلون → مربع بلون البيانات", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ScopeBar options={OPTS} value={null} onChange={onChange} />);
    expect(screen.getByTestId("scope-all").getAttribute("aria-pressed")).toBe("true");
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    for (const b of buttons) { expect(b.className).toContain("min-h-11"); expect(b.getAttribute("type")).toBe("button"); }
    fireEvent.click(screen.getByTestId("scope-2")); expect(onChange).toHaveBeenCalledWith(2);
    rerender(<ScopeBar options={OPTS} value={2} onChange={onChange} />);
    expect(screen.getByTestId("scope-all").getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByTestId("scope-2").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("scope-2").textContent).toContain("ب"); // أول حرف
    expect((screen.getByTestId("scope-1").querySelector("[style]") as HTMLElement).style.backgroundColor).toBe("rgb(184, 115, 51)");
    fireEvent.click(screen.getByTestId("scope-all")); expect(onChange).toHaveBeenLastCalledWith(null);
    expect(screen.getByRole("group", { name: "نطاق العرض" }).className).toContain("overflow-x-auto");
  });
});

describe("🚩 ReviewAttentionBanner — يظهر فقط بعدد حقيقي > 0", () => {
  it("0/null/undefined/NaN → لا شيء في DOM", () => {
    for (const c of [0, null, undefined, NaN, -2]) { const { container, unmount } = render(<ReviewAttentionBanner count={c as any} />); expect(container.innerHTML).toBe(""); unmount(); }
  });
  it("عدد > 0 → role=status مع النص + أيقونة + زر إجراء ≥44px فقط عند وجود action", () => {
    const { rerender } = render(<ReviewAttentionBanner count={3} />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("لديك 3 أوردرات بانتظار قرار منك");
    expect(banner.querySelector("svg")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    const onClick = vi.fn();
    rerender(<ReviewAttentionBanner count={1} action={{ label: "عرض", onClick }} />);
    expect(screen.getByRole("status").textContent).toContain("لديك 1 أوردر بانتظار");
    const btn = screen.getByTestId("review-attention-action");
    expect(btn.className).toContain("min-h-11"); fireEvent.click(btn); expect(onClick).toHaveBeenCalled();
    rerender(<ReviewAttentionBanner count={2} message="رسالة مخصصة" />);
    expect(screen.getByRole("status").textContent).toContain("رسالة مخصصة");
  });
});

describe("🧰 OrderToolbar — بحث بحقل محدد يُرسل بـEnter/زر، عدد حقيقي فقط", () => {
  const FIELDS = [{ id: "orderNumber", label: "رقم الأوردر" }, { id: "phone", label: "الهاتف" }];
  it("form role=search، الحقل والمدخل والزر ≥44px، Enter يرسل {field, query}، العدد يظهر فقط إن وُجد", () => {
    const onSearchChange = vi.fn(); const onSubmit = vi.fn();
    const { rerender } = render(<OrderToolbar title="الأوردرات" fields={FIELDS} search={{ field: "phone", query: "" }} onSearchChange={onSearchChange} onSubmit={onSubmit} />);
    expect(screen.queryByTestId("order-toolbar-count")).toBeNull();
    const form = screen.getByRole("search", { name: "بحث في الأوردرات" });
    const input = screen.getByTestId("order-toolbar-input") as HTMLInputElement;
    expect(input.placeholder).toBe("ابحث بـالهاتف");
    expect(screen.getByLabelText("بحث حسب الهاتف")).toBe(input);
    for (const id of ["order-toolbar-field", "order-toolbar-input", "order-toolbar-submit"]) expect(screen.getByTestId(id).className).toContain("min-h-11");
    fireEvent.change(input, { target: { value: "0100" } });
    expect(onSearchChange).toHaveBeenCalledWith({ field: "phone", query: "0100" });
    fireEvent.submit(form);
    expect(onSubmit).toHaveBeenCalledWith({ field: "phone", query: "" });
    rerender(<OrderToolbar title="الأوردرات" count={42} fields={FIELDS} search={{ field: "orderNumber", query: "7" }} onSearchChange={onSearchChange} onSubmit={onSubmit} actions={<button type="button">تصفية</button>} />);
    expect(screen.getByTestId("order-toolbar-count").textContent).toBe("42 أوردر");
    fireEvent.click(screen.getByTestId("order-toolbar-submit"));
    expect(onSubmit).toHaveBeenLastCalledWith({ field: "orderNumber", query: "7" });
    expect(screen.getByRole("button", { name: "تصفية" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("الأوردرات");
  });
});

describe("🧩 خلايا: CustomerCell / TwoLineCell / AttemptsCell / ReceiptPrediction", () => {
  it("CustomerCell: أول حرف مخفي عن القارئ، الاسم، الهاتف LTR بـfont-en، بلا هاتف لا سطر ثانٍ", () => {
    const { container } = render(<CustomerCell name="منى حسن" phone="01000000000" secondaryPhone="01111111111" />);
    const initial = container.querySelector('[aria-hidden="true"]')!; expect(initial.textContent).toBe("م");
    const phone = container.querySelector('[dir="ltr"]')!; expect(phone.textContent).toBe("01000000000 · 01111111111"); expect(phone.className).toContain("font-en");
    cleanup();
    expect(render(<CustomerCell name="  " />).container.querySelector('[aria-hidden="true"]')!.textContent).toBe("؟");
    cleanup();
    expect(render(<CustomerCell name="س" />).container.querySelector('[dir="ltr"]')).toBeNull();
  });
  it("TwoLineCell: سطر رئيسي + ثانوي اختياري، محاذاة منطقية، numeric → font-en tabular-nums", () => {
    const { container } = render(<TwoLineCell primary="القاهرة" secondary="مدينة نصر" />);
    expect(container.firstElementChild!.className).toContain("text-start"); expect(container.textContent).toBe("القاهرةمدينة نصر");
    cleanup();
    const n = render(<TwoLineCell primary="350" align="end" numeric />).container.firstElementChild as HTMLElement;
    expect(n.className).toContain("text-end"); expect(n.className).toContain("tabular-nums"); expect(n.querySelectorAll("span")).toHaveLength(1);
  });
  it("AttemptsCell: توصيل غير معروف → «غير متاح» بلا رقم/نقاط حتى مع محاولات اتصال؛ لا خلط بين النوعين", () => {
    render(<AttemptsCell callAttempts={2} />);
    const delivery = screen.getByTestId("attempts-delivery");
    expect(delivery.getAttribute("data-state")).toBe("unavailable"); expect(delivery.textContent).toBe(`توصيل:${UNAVAILABLE_LABEL}`);
    expect(delivery.querySelectorAll(".rounded-full")).toHaveLength(0);
    expect(screen.getByTestId("attempts-calls").textContent).toBe("اتصال:2");
    cleanup();
    render(<AttemptsCell deliveryAttempts={1} />);
    expect(screen.getByTestId("attempts-delivery").textContent).toBe("توصيل:1/3"); expect(screen.getByTestId("attempts-delivery").querySelectorAll(".rounded-full")).toHaveLength(3);
    expect(screen.queryByTestId("attempts-calls")).toBeNull();
    cleanup();
    render(<AttemptsCell callAttempts={null} deliveryAttempts={undefined} />);
    expect(screen.getByTestId("attempts-delivery").getAttribute("data-state")).toBe("unavailable"); expect(screen.queryByTestId("attempts-calls")).toBeNull();
  });
  it("ReceiptPrediction: بلا مصدر → «غير متاح» بلا % ولا لون نجاح؛ مع رقم → النطاق الصحيح + «توقع لا ضمان»", () => {
    for (const p of [undefined, null, NaN, -1, 101]) {
      const { unmount } = render(<ReceiptPrediction probability={p as any} />);
      const el = screen.getByTestId("receipt-prediction");
      expect(el.getAttribute("data-state")).toBe("unavailable"); expect(el.textContent).toBe(PREDICTION_UNAVAILABLE); expect(el.textContent).not.toContain("%");
      expect(el.className).not.toContain("success"); expect(el.querySelector("svg")).toBeNull();
      unmount();
    }
    expect([receiptBand(100), receiptBand(85), receiptBand(84), receiptBand(70), receiptBand(69), receiptBand(50), receiptBand(49), receiptBand(0)]).toEqual(["high", "high", "good", "good", "medium", "medium", "low", "low"]);
    render(<ReceiptPrediction probability={42} reasons={["محاولتا اتصال بلا رد"]} />);
    const el = screen.getByTestId("receipt-prediction");
    expect(el.getAttribute("data-band")).toBe("low"); expect(el.textContent).toContain("42%"); expect(el.textContent).toContain("راجع قبل الشحن"); expect(el.textContent).toContain("توقع لا ضمان");
    expect(screen.getByTestId("receipt-prediction-reasons").textContent).toContain("محاولتا اتصال بلا رد");
    cleanup();
    render(<ReceiptPrediction probability={91} compact />);
    expect(screen.getByTestId("receipt-prediction").getAttribute("data-band")).toBe("high"); expect(screen.queryByTestId("receipt-prediction-reasons")).toBeNull(); expect(screen.getByTestId("receipt-prediction").textContent).not.toContain("احتمال مرتفع");
  });
});

describe("📡 OfflineState", () => {
  it("role=status + نص + أيقونة مخفية؛ زر إعادة المحاولة ≥44px فقط مع onRetry ومعطّل أثناء retrying", () => {
    const { rerender } = render(<OfflineState />);
    expect(screen.getByRole("status").textContent).toContain("لا يوجد اتصال بالإنترنت"); expect(screen.queryByRole("button")).toBeNull();
    const onRetry = vi.fn();
    rerender(<OfflineState onRetry={onRetry} message="رسالة" />);
    const btn = screen.getByRole("button", { name: /إعادة المحاولة/ });
    expect(btn.className).toContain("min-h-11"); fireEvent.click(btn); expect(onRetry).toHaveBeenCalled();
    rerender(<OfflineState onRetry={onRetry} retrying />);
    expect((screen.getByRole("button", { name: /إعادة المحاولة/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
