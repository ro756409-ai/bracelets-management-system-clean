// @vitest-environment jsdom
/**
 * المرحلة 5 — نافذة «تخصيص العرض»: المجموعات الخمس بأسماء عربية، radio semantics + أسهم، أهداف 44px،
 * التطبيق الفوري على الجذر، الاستعادة، ورسالة الزائر. تُفتح من زر الشريط العلوي الحقيقي.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";

const auth = vi.hoisted(() => ({ user: null as null | { id: number } }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: auth.user, loading: false, isAuthenticated: Boolean(auth.user), error: null, refresh: () => {}, logout: () => {} }) }));
vi.mock("@/components/ui/tooltip", () => ({ Tooltip: ({ children }: any) => <>{children}</>, TooltipTrigger: ({ children }: any) => <>{children}</>, TooltipContent: () => null }));

import { DisplayPrefsProvider } from "@/contexts/DisplayPrefsContext";
import { DisplayPrefsDialog } from "./DisplayPrefsDialog";
import { TopBarActions } from "./TopBar";
import { ACCENTS } from "@/lib/displayPrefs";

beforeEach(() => {
  auth.user = { id: 3 }; localStorage.clear();
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  const root = document.documentElement; root.className = ""; root.removeAttribute("style");
});
afterEach(() => cleanup());
const root = () => document.documentElement;

const mountDialog = () => render(<DisplayPrefsProvider><DisplayPrefsDialog open onOpenChange={() => {}} /></DisplayPrefsProvider>);

describe("🪟 DisplayPrefsDialog", () => {
  it("خمس مجموعات radiogroup بأسماء عربية وخيارات 4/3/4/2/3، كل خيار زر ≥44px، النحاسي واللون 100% محددان افتراضيًا", () => {
    mountDialog();
    const groups = screen.getAllByRole("radiogroup");
    expect(groups.map(g => g.getAttribute("aria-label"))).toEqual(["حجم الخط", "الوضع", "اللون الرئيسي", "الكثافة", "تقليل الحركة"]);
    expect(groups.map(g => within(g).getAllByRole("radio").length)).toEqual([4, 3, 4, 2, 3]);
    for (const r of screen.getAllByRole("radio")) { expect(r.className).toContain("min-h-11"); expect(r.getAttribute("type")).toBe("button"); }
    expect(screen.getByTestId("prefs-fontScale-1").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("prefs-accent-copper").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("prefs-accent-copper").textContent).toContain("نحاسي");
    for (const id of ["teal", "indigo", "olive"] as const) expect(screen.getByTestId(`prefs-accent-${id}`).textContent).toContain(ACCENTS[id].label);
    expect(document.querySelector('input[type="color"]')).toBeNull();
    expect((screen.getByTestId("prefs-swatch-teal") as HTMLElement).style.backgroundColor).not.toBe("");
    expect(screen.getByText(/تُحفظ لحسابك/)).toBeTruthy();
  });
  it("النقر يطبّق فورًا على الجذر: 125% / داكن / نيلي / مدمجة / تقليل الحركة — ثم الاستعادة تعيد الافتراضي", () => {
    mountDialog();
    fireEvent.click(screen.getByTestId("prefs-fontScale-1.25")); expect(root().style.getPropertyValue("--font-scale")).toBe("1.25");
    fireEvent.click(screen.getByTestId("prefs-theme-dark")); expect(root().classList.contains("dark")).toBe(true);
    fireEvent.click(screen.getByTestId("prefs-accent-indigo")); expect(root().getAttribute("data-accent")).toBe("indigo");
    fireEvent.click(screen.getByTestId("prefs-density-compact")); expect(root().getAttribute("data-density")).toBe("compact");
    fireEvent.click(screen.getByTestId("prefs-motion-reduce")); expect(root().getAttribute("data-reduce-motion")).toBe("on");
    expect(JSON.parse(localStorage.getItem("matjarak:display-prefs:v1:u:3")!)).toEqual({ fontScale: 1.25, theme: "dark", accent: "indigo", density: "compact", motion: "reduce" });
    fireEvent.click(screen.getByTestId("prefs-reset"));
    expect(root().style.getPropertyValue("--font-scale")).toBe("1"); expect(root().classList.contains("dark")).toBe(false); expect(root().getAttribute("data-accent")).toBe("copper"); expect(root().getAttribute("data-density")).toBe("comfortable"); expect(root().getAttribute("data-reduce-motion")).toBe("off");
    expect(localStorage.getItem("matjarak:display-prefs:v1:u:3")).toBeNull();
    expect(screen.getByTestId("prefs-fontScale-1").getAttribute("aria-checked")).toBe("true");
  });
  it("لوحة المفاتيح داخل المجموعة: تركيز واحد (المحدد) والأسهم تنتقل وتختار؛ RTL: السهم الأيسر = التالي", () => {
    document.documentElement.dir = "rtl"; mountDialog();
    const g = screen.getByRole("radiogroup", { name: "حجم الخط" });
    const radios = within(g).getAllByRole("radio");
    expect(radios.map(r => r.getAttribute("tabindex"))).toEqual(["-1", "0", "-1", "-1"]);
    fireEvent.keyDown(radios[1], { key: "ArrowLeft" });
    expect(root().style.getPropertyValue("--font-scale")).toBe("1.1");
    fireEvent.keyDown(screen.getByTestId("prefs-fontScale-1.1"), { key: "ArrowRight" });
    expect(root().style.getPropertyValue("--font-scale")).toBe("1");
  });
  it("الزائر: رسالة «لهذه الجلسة فقط» ولا كتابة في التخزين", () => {
    auth.user = null; mountDialog();
    expect(screen.getByText(/لهذه الجلسة فقط/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("prefs-accent-olive"));
    expect(root().getAttribute("data-accent")).toBe("olive");
    expect(Object.keys(localStorage).filter(k => k.startsWith("matjarak:display-prefs"))).toHaveLength(0);
  });
});

describe("📜 الوصول إلى آخر النافذة على الهاتف", () => {
  it("الحاوية تُمرَّر داخليًا بارتفاع ≤ الشاشة − 8rem على الهاتف؛ ترتيب DOM: الكثافة → تقليل الحركة → استعادة → تم، و«تم» آخر عنصر قابل للتركيز", () => {
    mountDialog();
    const content = screen.getByTestId("display-prefs-dialog");
    expect(content.className).toContain("overflow-y-auto"); expect(content.className).toContain("max-h-[calc(100dvh-8rem)]"); expect(content.className).toContain("sm:max-h-[90vh]");
    const order = ["prefs-group-density", "prefs-group-motion", "prefs-reset", "prefs-done"].map(id => screen.getByTestId(id));
    for (let i = 1; i < order.length; i++) expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING, `ترتيب ${i}`).toBeTruthy();
    // آخر عنصرين تفاعليين في النافذة (عدا زر الإغلاق X الذي يرسمه DialogContent في النهاية) = استعادة ثم تم
    const focusables = [...content.querySelectorAll<HTMLElement>('[data-testid^="prefs-"]')].filter(el => el.matches("button, [role=radio]"));
    expect(focusables[focusables.length - 1].getAttribute("data-testid")).toBe("prefs-done");
    expect(focusables[focusables.length - 2].getAttribute("data-testid")).toBe("prefs-reset");
    for (const el of [screen.getByTestId("prefs-reset"), screen.getByTestId("prefs-done")]) expect(el.className).toContain("min-h-11");
    const onOpenChange = vi.fn();
    cleanup(); render(<DisplayPrefsProvider><DisplayPrefsDialog open onOpenChange={onOpenChange} /></DisplayPrefsProvider>);
    fireEvent.click(screen.getByTestId("prefs-done")); expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("🔝 الزر في الشريط العلوي", () => {
  const base = { isAdmin: true, permissions: [] as string[], userName: "مالك", roleLabel: "إدارة", lowStockCount: 0, onGoInventory: () => {}, onLogout: vi.fn() };
  it("ديسكتوب: زر «تخصيص العرض» مفعّل (ليس placeholder) ويفتح النافذة؛ المساعدة/الإشعارات تبقى معطّلة", () => {
    render(<DisplayPrefsProvider><TopBarActions {...base} isMobile={false} /></DisplayPrefsProvider>);
    const b = screen.getByTestId("topbar-display-prefs") as HTMLButtonElement;
    expect(b.disabled).toBe(false); expect(b.getAttribute("aria-label")).toBe("تخصيص العرض"); expect(b.getAttribute("aria-haspopup")).toBe("dialog");
    expect(screen.queryByTestId("display-prefs-dialog")).toBeNull();
    fireEvent.click(b);
    expect(screen.getByTestId("display-prefs-dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).toContain("تخصيص العرض");
    for (const id of ["topbar-help", "topbar-notifications"]) expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
  });
  it("موبايل: لا أيقونة في الشريط (تبقى داخل قائمة المستخدم بالكود) ولا نافذة مركّبة قبل الفتح", () => {
    render(<DisplayPrefsProvider><TopBarActions {...base} isMobile /></DisplayPrefsProvider>);
    expect(screen.queryByTestId("topbar-display-prefs")).toBeNull();
    expect(screen.queryByTestId("display-prefs-dialog")).toBeNull();
  });
});

describe("🏷️ Matjarak 2.0 (v2) — «لون مساحة العمل» و«عنابي — الافتراضي» عرضًا فقط", () => {
  afterEach(() => document.documentElement.removeAttribute("data-brand"));
  const KEY = "matjarak:display-prefs:v1:u:3";

  it("تحت v2: عنوان المجموعة «لون مساحة العمل»، والافتراضي «عنابي — الافتراضي» بلون Oxblood، والباقي كما هو", () => {
    document.documentElement.setAttribute("data-brand", "v2");
    mountDialog();
    expect(screen.getByRole("radiogroup", { name: "لون مساحة العمل" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup", { name: "اللون الرئيسي" })).toBeNull();
    const def = screen.getByTestId("prefs-accent-copper");
    expect([def.textContent, def.getAttribute("aria-checked")]).toEqual(["عنابي — الافتراضي", "true"]);
    expect((screen.getByTestId("prefs-swatch-copper") as HTMLElement).style.backgroundColor).toBe("rgb(103, 42, 57)");
    for (const id of ["teal", "indigo", "olive"] as const) expect(screen.getByTestId(`prefs-accent-${id}`).textContent).toBe(ACCENTS[id].label);
    expect(screen.getByText(/ثابت على الشعار وشاشات الدخول/)).toBeTruthy();
  });

  it("بدون v2: العنوان والاسم كما كانا حرفيًا («اللون الرئيسي» و«نحاسي»)", () => {
    mountDialog();
    expect(screen.getByRole("radiogroup", { name: "اللون الرئيسي" })).toBeTruthy();
    expect(screen.getByTestId("prefs-accent-copper").textContent).toBe("نحاسي");
  });

  it("التفضيلات المحفوظة كما هي: فتح النافذة تحت v2 لا يغيّر التخزين، والاختيار يحفظ نفس القيم القديمة (teal ثم copper)", () => {
    const saved = { fontScale: 1.1, theme: "light", accent: "copper", density: "comfortable", motion: "system" };
    localStorage.setItem(KEY, JSON.stringify(saved));
    document.documentElement.setAttribute("data-brand", "v2");
    mountDialog();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(saved);
    fireEvent.click(screen.getByTestId("prefs-accent-teal"));
    expect([root().getAttribute("data-accent"), JSON.parse(localStorage.getItem(KEY)!).accent]).toEqual(["teal", "teal"]);
    fireEvent.click(screen.getByTestId("prefs-accent-copper"));
    expect([root().getAttribute("data-accent"), JSON.parse(localStorage.getItem(KEY)!).accent]).toEqual(["copper", "copper"]);
    expect(Object.keys(localStorage).filter(k => k.startsWith("matjarak:"))).toEqual([KEY]);
  });
});
