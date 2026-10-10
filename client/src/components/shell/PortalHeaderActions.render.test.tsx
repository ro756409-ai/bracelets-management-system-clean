// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Box, CalendarDays, QrCode, RefreshCw, Truck } from "lucide-react";
import { PortalHeaderActions, type PortalAction } from "./PortalHeaderActions";

/** رأس بوابات الموظفين: صف واحد على الهاتف (المثبّت + الرسائل + «المزيد» + الخروج)، والكل ظاهر من 640px، بلا حذف أي فعل. */
const media = (wide: boolean) => { (window as any).matchMedia = (q: string) => ({ matches: wide && q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {} }); };
// Radix يفتح القائمة بـpointerdown في jsdom
const openMenu = (el: HTMLElement) => { fireEvent.pointerDown(el, { button: 0, ctrlKey: false, pointerType: "mouse" }); };
afterEach(() => cleanup());

const setup = (wide: boolean) => {
  media(wide);
  const calls: string[] = [];
  const actions: PortalAction[] = [
    { key: "ship", label: "شحنات اليوم", icon: Truck, onSelect: () => calls.push("ship") },
    { key: "date", label: "فلتر التاريخ", icon: CalendarDays, pinned: true, pressed: true, onSelect: () => calls.push("date") },
    { key: "scan", label: "مسح QR", icon: QrCode, pinned: true, pressed: false, onSelect: () => calls.push("scan") },
    { key: "stock", label: "المخزون", icon: Box, pressed: true, onSelect: () => calls.push("stock") },
    { key: "refresh", label: "تحديث القائمة", icon: RefreshCw, textFromSm: "تحديث", separatorBefore: true, onSelect: () => calls.push("refresh") },
  ];
  const logout = vi.fn();
  render(<PortalHeaderActions actions={actions} messages={<button type="button" data-testid="messages-entry" className="min-h-11 min-w-11">رسائل</button>} onLogout={logout} />);
  return { calls, logout };
};

describe("🧩 PortalHeaderActions", () => {
  it("تغيير العرض بلا حدث change (resize فقط) يبدّل التخطيط", async () => {
    setup(true);
    expect(screen.queryByTestId("portal-header-more")).toBeNull();
    media(false);
    const { act } = await import("@testing-library/react");
    act(() => { window.dispatchEvent(new Event("resize")); });
    expect(screen.getByTestId("portal-header-more")).toBeTruthy();
  });

  it("الهاتف: صف واحد بلا التفاف — المثبّت + الرسائل + «المزيد» + الخروج فقط، و44px", () => {
    setup(false);
    const bar = screen.getByTestId("portal-header-actions");
    expect(bar.className).toContain("flex-nowrap");
    const labels = [...bar.querySelectorAll("button")].map(b => b.getAttribute("aria-label") ?? b.getAttribute("data-testid"));
    expect(labels).toEqual(["فلتر التاريخ", "مسح QR", "messages-entry", "المزيد", "تسجيل الخروج"]);
    for (const b of bar.querySelectorAll("button")) expect(b.className).toMatch(/min-h-11/);
    expect(screen.getByRole("button", { name: "فلتر التاريخ" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("الهاتف: كل الأفعال الأخرى في «المزيد» — التنقل بند، والمفتاح يبقى مفتاحًا بحالته، ولا شيء محذوف", () => {
    const { calls } = setup(false);
    openMenu(screen.getByTestId("portal-header-more"));
    expect(screen.getByRole("menuitem", { name: "شحنات اليوم" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "تحديث القائمة" })).toBeTruthy();
    const stock = screen.getByRole("menuitemcheckbox", { name: "المخزون" });
    expect(stock.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "شحنات اليوم" }));
    expect(calls).toContain("ship");
  });

  it("الخروج والمثبّت يعملان كما هما", () => {
    const { calls, logout } = setup(false);
    fireEvent.click(screen.getByRole("button", { name: "مسح QR" }));
    fireEvent.click(screen.getByTestId("portal-header-logout"));
    expect(calls).toEqual(["scan"]); expect(logout).toHaveBeenCalledTimes(1);
  });

  it("من 640px: كل الأفعال ظاهرة كما كانت (بلا «المزيد»)، وتحديث بنصه القصير", () => {
    setup(true);
    expect(screen.queryByTestId("portal-header-more")).toBeNull();
    for (const l of ["شحنات اليوم", "فلتر التاريخ", "مسح QR", "المخزون", "تحديث القائمة", "تسجيل الخروج"]) expect(screen.getByRole("button", { name: l })).toBeTruthy();
    expect(screen.getByRole("button", { name: "تحديث القائمة" }).textContent).toBe("تحديث");
    // الترتيب الأصلي: الرسائل قبل الفاصل و«تحديث»، والخروج أخيرًا
    const order = [...screen.getByTestId("portal-header-actions").querySelectorAll("button")].map(b => b.getAttribute("aria-label") ?? b.getAttribute("data-testid"));
    expect(order).toEqual(["شحنات اليوم", "فلتر التاريخ", "مسح QR", "المخزون", "messages-entry", "تحديث القائمة", "تسجيل الخروج"]);
  });
});
