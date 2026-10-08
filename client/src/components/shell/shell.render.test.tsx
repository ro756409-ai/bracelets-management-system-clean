// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ShoppingCart, Truck, RotateCcw, AlertTriangle, Printer, QrCode, LayoutDashboard } from "lucide-react";

const state = vi.hoisted(() => ({ location: "/orders", navigated: [] as string[], openMobile: 0, reduced: false }));
vi.mock("wouter", () => ({ useLocation: () => [state.location, (to: string) => { state.navigated.push(to); state.location = to; }] }));
vi.mock("@/components/ui/sidebar", () => ({ useSidebar: () => ({ setOpenMobile: () => { state.openMobile++; } }) }));
vi.mock("@/components/ui/tooltip", () => ({ Tooltip: ({ children }: any) => <>{children}</>, TooltipTrigger: ({ children }: any) => <>{children}</>, TooltipContent: () => null }));

import { WorkspaceTabs } from "./WorkspaceTabs";
import { MobileBottomNav } from "./MobileBottomNav";
import { TopBarActions } from "./TopBar";
import { CreateMenu } from "./CreateMenu";
import { COMMAND_PALETTE_OPEN_EVENT } from "@/components/shared/CommandPalette";

const TABS = [
  { label: "الأوردرات", path: "/orders", icon: ShoppingCart }, { label: "طلبات بوسطة", path: "/bosta-orders", icon: Truck },
  { label: "المرتجعات", path: "/returns", icon: RotateCcw }, { label: "المكررات", path: "/duplicates", icon: AlertTriangle },
  { label: "المطبوعات", path: "/printed-orders", icon: Printer }, { label: "مسح QR الأوردرات", path: "/scan-orders", icon: QrCode },
];
const DESTS = [
  { key: "home", label: "الرئيسية", icon: LayoutDashboard, path: "/dashboard" }, { key: "orders", label: "الطلبات", icon: ShoppingCart, path: "/orders" },
  { key: "operations", label: "التشغيل", icon: Truck, path: "/preparation" }, { key: "inventory", label: "المخزون", icon: Printer, path: "/inventory" },
  { key: "reports", label: "التقارير", icon: QrCode, path: "/reports" },
];

beforeEach(() => {
  state.location = "/orders"; state.navigated = []; state.openMobile = 0; state.reduced = false;
  (window as any).matchMedia = (q: string) => ({ matches: state.reduced && q.includes("reduce"), addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => cleanup());

describe("🧭 WorkspaceTabs", () => {
  it("كل تبويب زر shrink-0 ≥44px بـtype=button، التمرير داخل nav (overflow-x-auto)، والنشط aria-current ويُمرَّر إلى مجال الرؤية", () => {
    render(<WorkspaceTabs tabs={TABS as any} />);
    const nav = screen.getByLabelText("تبويبات القسم");
    expect(nav.className).toContain("overflow-x-auto");
    const buttons = nav.querySelectorAll("button");
    expect(buttons).toHaveLength(6);
    for (const b of buttons) { expect(b.getAttribute("type")).toBe("button"); expect(b.className).toContain("shrink-0"); expect(b.className).toContain("min-h-11"); expect(b.className).toContain("whitespace-nowrap"); }
    const active = screen.getByTestId("workspace-tab-/orders");
    expect(active.getAttribute("aria-current")).toBe("page");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ inline: "nearest", behavior: "smooth" }));
    fireEvent.click(screen.getByTestId("workspace-tab-/returns"));
    expect(state.navigated).toEqual(["/returns"]);
  });
  it("prefers-reduced-motion → التمرير بلا حركة (behavior auto)؛ تبويب واحد → لا شيء", () => {
    state.reduced = true;
    render(<WorkspaceTabs tabs={TABS as any} />);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ behavior: "auto" }));
    cleanup();
    const { container } = render(<WorkspaceTabs tabs={[TABS[0]] as any} />);
    expect(container.textContent).toBe("");
  });
});

describe("📱 MobileBottomNav", () => {
  it("أول 4 وجهات + «المزيد»؛ كل زر type=button بارتفاع ≥56px، safe-area، النشط aria-current، و«المزيد» يفتح السايدبار", () => {
    render(<MobileBottomNav destinations={DESTS as any} />);
    const nav = screen.getByTestId("mobile-bottom-nav");
    expect(nav.className).toContain("pb-[env(safe-area-inset-bottom)]");
    const buttons = nav.querySelectorAll("button");
    expect(buttons).toHaveLength(5);
    for (const b of buttons) { expect(b.getAttribute("type")).toBe("button"); expect(b.className).toContain("min-h-[56px]"); }
    expect(screen.queryByTestId("bottom-nav-reports")).toBeNull(); // الخامسة تحت «المزيد»
    expect(screen.getByTestId("bottom-nav-orders").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByTestId("bottom-nav-more"));
    expect(state.openMobile).toBe(1);
    fireEvent.click(screen.getByTestId("bottom-nav-inventory"));
    expect(state.navigated).toEqual(["/inventory"]);
  });
});

describe("🔝 TopBarActions + CreateMenu", () => {
  const base = { isAdmin: true, permissions: [] as string[], userName: "مالك", roleLabel: "إدارة", lowStockCount: 0, onGoInventory: () => {}, onLogout: vi.fn() };
  it("ديسكتوب: البحث يبث حدث فتح لوحة الأوامر؛ المدخلات غير المتاحة معطّلة صراحةً؛ قائمة المستخدم مرة واحدة", () => {
    const seen = vi.fn();
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, seen);
    render(<TopBarActions {...base} isMobile={false} />);
    fireEvent.click(screen.getByTestId("topbar-search"));
    expect(seen).toHaveBeenCalledTimes(1);
    for (const id of ["topbar-display-prefs", "topbar-help", "topbar-notifications"]) {
      const b = screen.getByTestId(id) as HTMLButtonElement;
      expect(b.disabled).toBe(true); expect(b.getAttribute("aria-disabled")).toBe("true"); expect(b.getAttribute("aria-label")).toContain("غير متاح حاليًا");
    }
    expect(screen.getAllByTestId("user-menu")).toHaveLength(1);
    expect(screen.queryByTestId("create-menu-compact")).toBeNull();
    window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, seen);
  });
  it("موبايل: زر إنشاء مضغوط 44px، بلا مدخلات معطّلة، ومؤشر المخزون يظهر العدد", () => {
    render(<TopBarActions {...base} isMobile lowStockCount={3} />);
    expect(screen.getByTestId("create-menu-compact").className).toContain("h-11");
    expect(screen.queryByTestId("topbar-display-prefs")).toBeNull();
    expect(screen.getByTestId("low-stock-indicator").textContent).toContain("3");
  });
  it("CreateMenu: البند الرئيسي ينقل إلى صفحة الطلبات؛ بلا أي بند مسموح لا يُرندر شيء", () => {
    render(<CreateMenu isAdmin={true} permissions={["ledger.post"]} />);
    fireEvent.click(screen.getByTestId("create-primary"));
    expect(state.navigated).toEqual(["/orders"]);
    cleanup();
    const { container } = render(<CreateMenu isAdmin={false} permissions={[]} hasUser={false} />);
    expect(container.textContent).toBe("");
  });
});
