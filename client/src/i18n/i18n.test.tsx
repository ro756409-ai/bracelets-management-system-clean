// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { I18nProvider, LANG_STORAGE_KEY, readStoredLang, translate, useDocumentLang, useI18n } from "./index";
import { MESSAGES } from "./messages";
import { LanguageToggle } from "@/components/public/LanguageToggle";

const ARABIC = /[؀-ۿ]/;

function Probe() {
  useDocumentLang();
  const { t, lang, dir } = useI18n();
  return <p data-testid="probe" data-lang={lang} data-dir={dir}>{t("cta.signup")}</p>;
}

describe("🌐 القاموس", () => {
  it("كل مفتاح موجود وغير فاضي في اللغتين، والإنجليزي مفيهوش عربي (عدا زر الرجوع للعربي)", () => {
    const keys = Object.keys(MESSAGES.ar);
    expect(Object.keys(MESSAGES.en).sort()).toEqual([...keys].sort());
    for (const k of keys) {
      expect(MESSAGES.ar[k as keyof typeof MESSAGES.ar].trim(), k).not.toBe("");
      expect(MESSAGES.en[k as keyof typeof MESSAGES.en].trim(), k).not.toBe("");
      if (!k.startsWith("lang.")) expect(ARABIC.test(MESSAGES.en[k as keyof typeof MESSAGES.en]), k).toBe(false);
    }
  });
  it("نفس المتغيرات {x} في الترجمتين، والاستبدال شغال", () => {
    const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",");
    for (const k of Object.keys(MESSAGES.ar) as Array<keyof typeof MESSAGES.ar>) expect(vars(MESSAGES.en[k]), k).toBe(vars(MESSAGES.ar[k]));
    expect(translate("en", "pricing.choose", { plan: "1 year" })).toBe("Start with the 1 year plan");
    expect(translate("ar", "cta.signup")).toBe("أنشئ حسابك مجانًا");
  });
});

describe("🌐 المزوّد", () => {
  beforeEach(() => { cleanup(); localStorage.clear(); document.documentElement.setAttribute("lang", "ar"); document.documentElement.setAttribute("dir", "rtl"); });
  it("v2: التبديل للإنجليزي بيغيّر النص والاتجاه وبيتحفظ، والخروج من الصفحة بيرجّع <html> عربي", () => {
    const r = render(<I18nProvider brand="v2"><LanguageToggle /><Probe /></I18nProvider>);
    expect(screen.getByTestId("probe").textContent).toBe("أنشئ حسابك مجانًا");
    const toggle = screen.getByTestId("lang-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByTestId("lang-option-ar").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("lang-option-en"));
    expect(screen.queryByTestId("lang-menu")).toBeNull();
    expect(screen.getByTestId("probe").textContent).toBe("Create your free account");
    expect(document.documentElement.getAttribute("dir")).toBe("ltr");
    expect(document.documentElement.getAttribute("lang")).toBe("en");
    expect(localStorage.getItem(LANG_STORAGE_KEY)).toBe("en");
    expect(readStoredLang()).toBe("en");
    r.unmount();
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
  });
  it("v2: الاختيار المحفوظ بيترجع عند الفتح", () => {
    localStorage.setItem(LANG_STORAGE_KEY, "en");
    render(<I18nProvider brand="v2"><Probe /></I18nProvider>);
    expect(screen.getByTestId("probe").dataset.dir).toBe("ltr");
  });
  it("v1: عربي دائمًا ومفيش زر لغة حتى لو فيه اختيار محفوظ", () => {
    localStorage.setItem(LANG_STORAGE_KEY, "en");
    render(<I18nProvider brand={null}><LanguageToggle /><Probe /></I18nProvider>);
    expect(screen.queryByTestId("lang-toggle")).toBeNull();
    expect(screen.getByTestId("probe").dataset.lang).toBe("ar");
  });
  it("تخزين مقفول ⇒ الافتراضي عربي من غير ما يقع", () => {
    const orig = Storage.prototype.getItem;
    Storage.prototype.getItem = () => { throw new Error("blocked"); };
    try { expect(readStoredLang()).toBe("ar"); } finally { Storage.prototype.getItem = orig; }
  });
});
