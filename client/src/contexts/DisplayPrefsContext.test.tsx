// @vitest-environment jsdom
/**
 * المرحلة 5 — المزوّد: التطبيق الفوري على الجذر، متابعة النظام أثناء الجلسة، الحفظ لكل هوية،
 * وعدم التسرب عند تسجيل الخروج والدخول بحساب آخر (مالك/صناعية/موظف/زائر).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

const auth = vi.hoisted(() => ({ user: null as null | { id: number; loginMethod?: string }, loading: false }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: auth.user, loading: auth.loading, isAuthenticated: Boolean(auth.user), error: null, refresh: () => {}, logout: () => {} }) }));

import { DisplayPrefsProvider, useDisplayPrefs } from "./DisplayPrefsContext";
import { DEFAULT_PREFS } from "@/lib/displayPrefs";

// matchMedia قابل للتحكم لكل استعلام مع إطلاق change
const media = { dark: false, reduce: false, wide: true, listeners: new Map<string, Set<() => void>>() };
const queryKey = (q: string) => (q.includes("color-scheme") ? "dark" : q.includes("reduced-motion") ? "reduce" : "wide");
function emit(key: string) { media.listeners.get(key)?.forEach(l => l()); }
beforeEach(() => {
  auth.user = null; auth.loading = false; media.dark = false; media.reduce = false; media.wide = true; media.listeners.clear();
  localStorage.clear();
  (window as any).matchMedia = (q: string) => {
    const key = queryKey(q);
    return {
      get matches() { return (media as any)[key]; }, media: q,
      addEventListener: (_: string, fn: () => void) => { if (!media.listeners.has(key)) media.listeners.set(key, new Set()); media.listeners.get(key)!.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { media.listeners.get(key)?.delete(fn); }, addListener() {}, removeListener() {},
    };
  };
  const root = document.documentElement; root.className = ""; root.removeAttribute("style"); for (const a of [...root.getAttributeNames()]) if (a.startsWith("data-")) root.removeAttribute(a);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

let api: ReturnType<typeof useDisplayPrefs> | null = null;
function Probe() { api = useDisplayPrefs(); return null; }
const mount = () => render(<DisplayPrefsProvider><Probe /></DisplayPrefsProvider>);
const root = () => document.documentElement;
const key = (tag: string) => `matjarak:display-prefs:v1:${tag}`;

describe("⚡ التطبيق الفوري على الجذر", () => {
  it("الافتراضي: data-theme=light (النظام فاتح)، --font-scale=1، density=comfortable، accent=copper، reduce-motion=off", () => {
    mount();
    expect(root().classList.contains("dark")).toBe(false); expect(root().getAttribute("data-theme")).toBe("light");
    expect(root().style.getPropertyValue("--font-scale")).toBe("1"); expect(root().getAttribute("data-font-scale")).toBe("1");
    expect(root().getAttribute("data-density")).toBe("comfortable"); expect(root().getAttribute("data-accent")).toBe("copper"); expect(root().getAttribute("data-reduce-motion")).toBe("off");
  });
  it("update يغيّر الجذر فورًا بلا reload: الخط 125%، داكن، تركوازي، مدمجة (ديسكتوب)، تقليل الحركة", () => {
    auth.user = { id: 1 }; mount();
    act(() => api!.update({ fontScale: 1.25, theme: "dark", accent: "teal", density: "compact", motion: "reduce" }));
    expect(root().style.getPropertyValue("--font-scale")).toBe("1.25"); expect(root().classList.contains("dark")).toBe(true); expect(root().getAttribute("data-theme")).toBe("dark");
    expect(root().getAttribute("data-accent")).toBe("teal"); expect(root().getAttribute("data-density")).toBe("compact"); expect(root().getAttribute("data-reduce-motion")).toBe("on");
    expect(api!.resolvedTheme).toBe("dark"); expect(api!.reduceMotion).toBe(true);
  });
  it("الكثافة المدمجة على الديسكتوب فقط: تحت 768 تبقى comfortable على الجذر مع بقاء التفضيل محفوظًا", () => {
    media.wide = false; auth.user = { id: 1 }; mount();
    act(() => api!.update({ density: "compact" }));
    expect(api!.prefs.density).toBe("compact"); expect(root().getAttribute("data-density")).toBe("comfortable");
    act(() => { media.wide = true; emit("wide"); });
    expect(root().getAttribute("data-density")).toBe("compact");
  });
  it("حسب الجهاز: تغيّر prefers-color-scheme وprefers-reduced-motion أثناء الجلسة ينعكس فورًا؛ الاختيار الصريح لا يتبع النظام", () => {
    auth.user = { id: 1 }; mount();
    expect(root().classList.contains("dark")).toBe(false);
    act(() => { media.dark = true; emit("dark"); });
    expect(root().classList.contains("dark")).toBe(true); expect(api!.resolvedTheme).toBe("dark");
    act(() => { media.reduce = true; emit("reduce"); });
    expect(root().getAttribute("data-reduce-motion")).toBe("on");
    act(() => api!.update({ theme: "light", motion: "allow" }));
    expect(root().classList.contains("dark")).toBe(false); expect(root().getAttribute("data-reduce-motion")).toBe("off");
    act(() => { media.dark = false; emit("dark"); });
    expect(root().classList.contains("dark")).toBe(false);
  });
});

describe("🔐 الحفظ لكل هوية وعدم التسرب", () => {
  it("مالك u:1 يحفظ تحت مفتاحه فقط؛ reset يمسح مفتاحه ويعيد الافتراضي", () => {
    auth.user = { id: 1 }; mount();
    act(() => api!.update({ accent: "olive" }));
    expect(JSON.parse(localStorage.getItem(key("u:1"))!)).toMatchObject({ accent: "olive" });
    expect(Object.keys(localStorage).filter(k => k.startsWith("matjarak:display-prefs"))).toEqual([key("u:1")]);
    act(() => api!.reset());
    expect(localStorage.getItem(key("u:1"))).toBeNull(); expect(api!.prefs).toEqual(DEFAULT_PREFS); expect(root().getAttribute("data-accent")).toBe("copper");
  });
  it("الزائر: لا مفتاح، التغيير لهذه الجلسة فقط ولا يُكتب شيء", () => {
    mount();
    expect(api!.canPersist).toBe(false); expect(api!.identity).toBeNull();
    act(() => api!.update({ fontScale: 1.25 }));
    expect(root().style.getPropertyValue("--font-scale")).toBe("1.25");
    expect(Object.keys(localStorage).filter(k => k.startsWith("matjarak:display-prefs"))).toHaveLength(0);
  });
  it("أثناء تحميل auth.me لا تحميل ولا حفظ (هوية غير محسومة)", () => {
    auth.loading = true; localStorage.setItem(key("u:1"), JSON.stringify({ ...DEFAULT_PREFS, accent: "indigo" })); mount();
    expect(api!.identity).toBeUndefined(); expect(root().getAttribute("data-accent")).toBe("copper");
  });
  it("خروج المالك ثم دخول صناعية (id سالب) ثم موظف (employee_session): كل واحد يرى إعداداته فقط، والخروج يعيد الافتراضي", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // استطلاع employee_session في نفس التاب
    auth.user = { id: 1 }; const { rerender } = mount();
    act(() => api!.update({ accent: "teal", fontScale: 1.1 }));
    expect(root().getAttribute("data-accent")).toBe("teal");
    // خروج
    auth.user = null; rerender(<DisplayPrefsProvider><Probe /></DisplayPrefsProvider>);
    expect(api!.identity).toBeNull(); expect(root().getAttribute("data-accent")).toBe("copper"); expect(root().style.getPropertyValue("--font-scale")).toBe("1");
    // دخول جلسة صناعية لموظف 7 — لا ترث تركوازي المالك
    auth.user = { id: -7, loginMethod: "employee" }; rerender(<DisplayPrefsProvider><Probe /></DisplayPrefsProvider>);
    expect(api!.identity).toEqual({ kind: "s", id: 7 }); expect(root().getAttribute("data-accent")).toBe("copper");
    act(() => api!.update({ theme: "dark" }));
    expect(JSON.parse(localStorage.getItem(key("s:7"))!)).toMatchObject({ theme: "dark", accent: "copper" });
    expect(JSON.parse(localStorage.getItem(key("u:1"))!)).toMatchObject({ accent: "teal", theme: "system" }); // لم تُمسّ
    // خروج ثم موظف بوابة (employee_session) رقم 7 أيضًا — مفتاح e:7 مستقل عن s:7
    auth.user = null; rerender(<DisplayPrefsProvider><Probe /></DisplayPrefsProvider>);
    expect(root().classList.contains("dark")).toBe(false);
    act(() => { localStorage.setItem("employee_session", JSON.stringify({ id: 7, businessId: 1, tenantId: 1 })); window.dispatchEvent(new StorageEvent("storage", { key: "employee_session" })); });
    expect(api!.identity).toEqual({ kind: "e", id: 7 }); expect(api!.prefs).toEqual(DEFAULT_PREFS);
    act(() => api!.update({ density: "compact" }));
    expect(JSON.parse(localStorage.getItem(key("e:7"))!)).toMatchObject({ density: "compact" });
    expect(JSON.parse(localStorage.getItem(key("s:7"))!)).toMatchObject({ density: "comfortable" });
    // خروج الموظف (مسح الجلسة في نفس التاب → الاستطلاع الدوري، بلا حدث storage)
    act(() => { localStorage.removeItem("employee_session"); vi.advanceTimersByTime(1100); });
    expect(api!.identity).toBeNull(); expect(root().getAttribute("data-density")).toBe("comfortable");
    // عودة المالك → تركوازي 110% كما تركها
    auth.user = { id: 1 }; rerender(<DisplayPrefsProvider><Probe /></DisplayPrefsProvider>);
    expect(root().getAttribute("data-accent")).toBe("teal"); expect(root().style.getPropertyValue("--font-scale")).toBe("1.1");
  });
});
