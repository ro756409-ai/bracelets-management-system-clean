// @vitest-environment jsdom
/**
 * المرحلة 7D — التجهيز والطباعة: التحديد الجماعي (صفحة/مؤكدة/إلغاء)، الطباعة وشيت الشحن بحارس ضغط مكرر
 * (ضغطتان = نافذة واحدة وسجل واحد)، التحقق من البيانات الناقصة قبل الشيت، جدول Desktop فقط/بطاقات Mobile فقط،
 * وحالات Loading/Empty/Error/Offline. نفس الاستعلامات (orders.list / statusCounts / printLogs.create).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean; isError?: boolean; error?: any };
const st = vi.hoisted(() => ({ q: {} as Record<string, Q>, mut: {} as Record<string, ReturnType<typeof vi.fn>>, online: true, desktop: true, opened: [] as string[] }));
const { mkQuery, mkMutation } = vi.hoisted(() => ({
  mkQuery: (key: string) => () => { const q = st.q[key] ?? {}; return { data: q.data, isLoading: q.isLoading ?? false, isError: q.isError ?? false, error: q.error, refetch: vi.fn() }; },
  mkMutation: (key: string) => () => { st.mut[key] ??= vi.fn(); return { mutate: st.mut[key], isPending: false }; },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    orders: { list: { useQuery: mkQuery("list") }, statusCounts: { useQuery: mkQuery("counts") } },
    printLogs: { create: { useMutation: mkMutation("printLog") } },
    useUtils: () => ({ printLogs: { list: { invalidate: vi.fn() } }, orders: { list: { invalidate: vi.fn() }, statusCounts: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ currentBusinessIds: [1], businesses: [{ id: 1, name: "براند" }] }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => st.online }));
vi.mock("@/components/workspace", () => ({
  WorkspaceShell: ({ title, actions, children }: any) => <div data-testid="shell"><h1>{title}</h1>{actions}{children}</div>,
  StatusFilterChips: ({ chips, value, onChange }: any) => <div>{chips.map((c: any) => <button key={c.key} type="button" aria-pressed={value === c.key} onClick={() => onChange(value === c.key ? null : c.key)}>{c.label} {c.count}</button>)}</div>,
  DataToolbar: ({ search, onSearch }: any) => <input aria-label="بحث" value={search} onChange={e => onSearch(e.target.value)} />,
  StatusBadge: ({ status }: any) => <span data-status={status}>{status}</span>,
  ORDER_STATUS: { confirmed: { label: "مؤكد", tone: "success" }, printed: { label: "مطبوع", tone: "neutral" } },
  Pagination: ({ page, total }: any) => <nav data-testid="pagination">{page}/{total}</nav>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
import { toast } from "sonner";
vi.mock("@/components/ui/select", () => import("@/test-utils/selectMock"));

import Preparation from "./Preparation";

const ORDERS = [
  { id: 1, orderNumber: "A-1", customerName: "منى", customerPhone: "01012345678", governorate: "القاهرة", customerAddress: "شارع طويل جدًا", productName: "سوار", totalAmount: "250", status: "confirmed", confirmedAt: "2026-10-08T10:00:00Z" },
  { id: 2, orderNumber: "A-2", customerName: "سارة", customerPhone: "0100", governorate: "", customerAddress: "", productName: "خاتم", totalAmount: "120", status: "confirmed", confirmedAt: null },
  { id: 3, orderNumber: "A-3", customerName: "هدى", customerPhone: "01098765432", governorate: "الجيزة", customerAddress: "شارع آخر طويل", productName: "سلسلة", totalAmount: "180", status: "printed", confirmedAt: "2026-10-07T10:00:00Z" },
];
function setup() { st.q = { list: { data: { orders: ORDERS, total: 3 } }, counts: { data: { byStatus: { confirmed: 2, printed: 1 } } } }; }
beforeEach(() => {
  st.q = {}; st.mut = {}; st.online = true; st.desktop = true; st.opened = [];
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width") ? st.desktop : !st.desktop, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  (window as any).open = vi.fn((url: string) => { st.opened.push(url); return null; });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("✅ التحديد الجماعي", () => {
  it("تحديد كل المؤكدة يحدد 2؛ تحديد الصفحة يحدد 3؛ إلغاء يفرّغ", () => {
    setup();
    render(<Preparation />);
    fireEvent.click(screen.getByTestId("prep-select-confirmed"));
    expect(screen.getByTestId("prep-selected-count").textContent).toContain("2");
    fireEvent.click(screen.getByTestId("prep-select-page"));
    expect(screen.getByTestId("prep-selected-count").textContent).toContain("3");
    fireEvent.click(screen.getByTestId("prep-select-page"));
    expect(screen.queryByTestId("prep-selected-count")).toBeNull();
  });
});

describe("🖨️ الطباعة وشيت الشحن", () => {
  it("ضغطتان على الطباعة → نافذة واحدة وسجل واحد؛ الزر معطّل أثناء الطباعة ثم يعود", () => {
    setup();
    render(<Preparation />);
    fireEvent.click(screen.getByTestId("prep-select-confirmed"));
    const print = screen.getByTestId("prep-print") as HTMLButtonElement;
    fireEvent.click(print); fireEvent.click(print);
    expect(st.opened).toHaveLength(1);
    expect(st.opened[0]).toContain("/api/export/print-labels?orderIds=1%2C2");
    expect(st.mut.printLog).toHaveBeenCalledTimes(1);
    expect(st.mut.printLog.mock.calls[0][0]).toEqual({ type: "labels", orderIds: [1, 2] });
    expect(print.disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(2600); });
    expect(screen.queryByTestId("prep-print")).toBeNull(); // التحديد اتفرّغ بعد الطباعة → الشريط اختفى
  });
  it("شيت الشحن يستبعد الأوردر ناقص البيانات بعدده وأسبابه، ويصدّر المكتمل فقط (السجل بالمصدَّر فقط)", () => {
    setup();
    render(<Preparation />);
    fireEvent.click(screen.getByTestId("prep-select-confirmed")); // A-1 مكتمل + A-2 ناقص
    fireEvent.click(screen.getByTestId("prep-sheet"));
    expect(st.opened).toHaveLength(1);
    expect(st.opened[0]).toContain("/api/export/shipping?orderIds=1");
    expect(st.opened[0]).not.toContain("2");
    expect(st.mut.printLog.mock.calls[0][0]).toEqual({ type: "shipping_sheet", orderIds: [1] });
    const warn = String(vi.mocked(toast.warning).mock.calls.at(-1)?.[0]);
    expect(warn).toContain("استُبعد 1 أوردر");
    expect(warn).toContain("#A-2: رقم الهاتف غير صحيح، العنوان مفقود، المحافظة غير محددة");
  });
  it("شيت الشحن وكل المحدد ناقص ⇒ لا نافذة ولا سجل، ورسالة بالأسباب", () => {
    setup();
    render(<Preparation />);
    const rows = within(screen.getByTestId("responsive-table-table")).getAllByRole("checkbox");
    fireEvent.click(rows[2]); // A-2 الناقص وحده
    fireEvent.click(screen.getByTestId("prep-sheet"));
    expect(st.opened).toHaveLength(0);
    expect(st.mut.printLog).not.toHaveBeenCalled();
    expect(String(vi.mocked(toast.error).mock.calls.at(-1)?.[0])).toContain("لا يوجد أوردر مكتمل للتصدير");
  });
  it("شيت الشحن لأوردر كامل → نافذة واحدة وسجل shipping_sheet", () => {
    setup();
    render(<Preparation />);
    const rows = within(screen.getByTestId("responsive-table-table")).getAllByRole("checkbox");
    fireEvent.click(rows[1]); // الصف الأول (A-1) — الأول هو «تحديد كل الصفوف»
    expect(screen.getByTestId("prep-selected-count").textContent).toContain("1");
    const sheet = screen.getByTestId("prep-sheet");
    fireEvent.click(sheet); fireEvent.click(sheet);
    expect(st.opened).toHaveLength(1);
    expect(st.opened[0]).toContain("/api/export/shipping?orderIds=1");
    expect(st.mut.printLog.mock.calls[0][0]).toEqual({ type: "shipping_sheet", orderIds: [1] });
  });
});

describe("📱 Desktop/Mobile والحالات", () => {
  it("Desktop: جدول وحده؛ Mobile: بطاقات وحدها مع checkbox 44px", () => {
    setup();
    const { unmount } = render(<Preparation />);
    expect(screen.getByTestId("responsive-table-table")).toBeTruthy();
    expect(screen.queryByTestId("prep-card-1")).toBeNull();
    unmount(); st.desktop = false;
    render(<Preparation />);
    expect(screen.queryByTestId("responsive-table-table")).toBeNull();
    const card = screen.getByTestId("prep-card-1");
    fireEvent.click(within(card).getByRole("checkbox"));
    expect(card.getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("prep-print")).toBeTruthy();
  });
  it("Loading / Empty / Error / Offline", () => {
    st.q = { list: { isLoading: true }, counts: {} };
    const { unmount } = render(<Preparation />);
    expect(screen.getAllByRole("status").length).toBeGreaterThanOrEqual(1);
    unmount(); st.q = { list: { data: { orders: [], total: 0 } }, counts: { data: { byStatus: {} } } };
    const r2 = render(<Preparation />);
    expect(screen.getByText("لا توجد أوردرات مؤكدة حالياً")).toBeTruthy();
    r2.unmount(); st.q = { list: { isError: true, error: { message: "انقطع" } }, counts: {} };
    const r3 = render(<Preparation />);
    expect(screen.getByRole("alert").textContent).toContain("انقطع");
    r3.unmount(); setup(); st.online = false;
    render(<Preparation />);
    expect(screen.getByTestId("offline-state")).toBeTruthy();
  });
});
