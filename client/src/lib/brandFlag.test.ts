// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { applyBrandFlag, brandFromEnv } from "./brandFlag";
import { ACCENT_IDS, DEFAULT_PREFS, applyPrefsToRoot, loadPrefs, savePrefs, type SessionIdentity } from "./displayPrefs";

/**
 * Matjarak 2.0 — المرحلة 1A: مفتاح الهوية الجديدة من متغير وقت البناء فقط، قابل للإلغاء بلا أي بيانات.
 */
describe("🏷️ مفتاح الهوية VITE_BRAND", () => {
  beforeEach(() => { document.documentElement.removeAttribute("data-brand"); localStorage.clear(); });

  it("\"v2\" فقط يفعّل الهوية الجديدة (بلا حساسية للحالة والمسافات)؛ أي قيمة أخرى أو غيابها = الهوية الحالية", () => {
    expect([brandFromEnv("v2"), brandFromEnv(" V2 ")]).toEqual(["v2", "v2"]);
    for (const v of [undefined, null, "", "v1", "true", "1", "v3", 2]) expect(brandFromEnv(v), String(v)).toBeNull();
  });

  it("يضع data-brand=\"v2\" على <html>، والإلغاء يزيله — بلا قراءة أو كتابة لأي تفضيلات محفوظة", () => {
    const root = document.documentElement;
    root.setAttribute("data-accent", "copper");
    localStorage.setItem("matjarak:display-prefs:v1:u:1", JSON.stringify({ accent: "copper" }));
    const before = { ...localStorage };
    expect(applyBrandFlag(root, "v2")).toBe("v2");
    expect(root.getAttribute("data-brand")).toBe("v2");
    expect(applyBrandFlag(root, undefined)).toBeNull();
    expect(root.hasAttribute("data-brand")).toBe(false);
    expect(root.getAttribute("data-accent")).toBe("copper"); // اختيار المستخدم لا يُمس
    expect({ ...localStorage }).toEqual(before);
  });

  it("main.tsx يطبّق المفتاح من import.meta.env.VITE_BRAND قبل إنشاء التطبيق", () => {
    const src = fs.readFileSync(path.resolve(__dirname, "../main.tsx"), "utf-8");
    const apply = src.indexOf("applyBrandFlag(document.documentElement, import.meta.env.VITE_BRAND)");
    expect(apply).toBeGreaterThan(-1);
    expect(apply).toBeLessThan(src.indexOf("createRoot("));
  });

  afterEach(() => vi.restoreAllMocks());

  it("تشغيل/إيقاف v2 مرارًا لا يكتب ولا يحذف أي تخزين (localStorage/sessionStorage/cookie)، والتفضيلات المحفوظة لكل الهويات والألوان الأربعة كما هي", () => {
    // هوية لكل لون محفوظ (نحاسي/تركواز/نيلي/زيتوني) — مالك، موظف، جلسة صناعية، مالك آخر
    const ids: SessionIdentity[] = [{ kind: "u", id: 1 }, { kind: "e", id: 7 }, { kind: "s", id: -1 }, { kind: "u", id: 2 }];
    ACCENT_IDS.forEach((accent, i) => savePrefs(ids[i], { ...DEFAULT_PREFS, accent, theme: i % 2 ? "dark" : "light" }));
    sessionStorage.setItem("op-key", "x");
    const root = document.documentElement;
    applyPrefsToRoot(root, loadPrefs(ids[1]), { systemDark: false, systemReduce: false, isDesktop: true });
    const snapshot = () => ({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie, prefs: ids.map(id => loadPrefs(id)),
      attrs: Object.fromEntries([...root.attributes].filter(a => a.name !== "data-brand").map(a => [a.name, a.value])), dark: root.classList.contains("dark") });
    const before = snapshot();
    const writes = [vi.spyOn(Storage.prototype, "setItem"), vi.spyOn(Storage.prototype, "removeItem"), vi.spyOn(Storage.prototype, "clear")];
    const cookieSet = vi.spyOn(Document.prototype, "cookie", "set");
    for (let n = 0; n < 5; n++) { applyBrandFlag(root, "v2"); applyBrandFlag(root, undefined); applyBrandFlag(root, "v2"); }
    expect(root.getAttribute("data-brand")).toBe("v2");
    applyBrandFlag(root, "");
    expect(root.hasAttribute("data-brand")).toBe(false);
    for (const w of writes) expect(w).not.toHaveBeenCalled();
    expect(cookieSet).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(before.prefs.map(p => p.accent)).toEqual(["copper", "teal", "indigo", "olive"]);
    expect(Object.keys(before.local).filter(k => k.startsWith("matjarak:display-prefs:v1:")).length).toBe(4);
  });

  it("فصل تام: كود التفضيلات لا يعرف المفتاح، وكود المفتاح لا يلمس أي تخزين أو شبكة", () => {
    const read = (f: string) => fs.readFileSync(path.resolve(__dirname, f), "utf-8");
    for (const f of ["displayPrefs.ts", "../contexts/DisplayPrefsContext.tsx", "../components/shell/DisplayPrefsDialog.tsx"])
      expect(read(f), f).not.toMatch(/data-brand|brandFlag|VITE_BRAND/);
    expect(read("brandFlag.ts")).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB|fetch\(|trpc|savePrefs|loadPrefs/);
  });
});
