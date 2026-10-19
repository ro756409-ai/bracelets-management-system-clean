// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within, act } from "@testing-library/react";

/**
 * الصفحات العامة تحت v2: الرئيسية (أقسام حقيقية، CTA، أسعار 500/1999/3999 والسنة مميزة، فيديو بدون تحميل يوتيوب قبل الضغط،
 * عربي/إنجليزي)، والدخول (إظهار كلمة المرور، افتكرني، نسيت كلمة المرور، مفيش جوجل). v1: الدخول بنفس شكله ومفيش عناصر جديدة.
 */
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: null, loading: false }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/", () => {}] }));
const videos = vi.hoisted(() => ({ heroId: null as string | null }));
vi.mock("@/config/landingVideos", async () => {
  const real = await vi.importActual<any>("@/config/landingVideos");
  return { ...real, get LANDING_VIDEOS() { return real.LANDING_VIDEOS.map((v: any) => (v.slot === "hero" ? { ...v, youtubeId: videos.heroId } : v)); },
    videoForSlot: (slot: string) => real.LANDING_VIDEOS.map((v: any) => (v.slot === "hero" ? { ...v, youtubeId: videos.heroId } : v)).find((v: any) => v.slot === slot) };
});

import { I18nProvider } from "@/i18n";
import Home from "./Home";
import Login from "./Login";
import Register from "./Register";

const setBrand = (b: "v2" | null) => { if (b) document.documentElement.setAttribute("data-brand", b); else document.documentElement.removeAttribute("data-brand"); };
const mount = (ui: React.ReactNode) => render(<I18nProvider>{ui}</I18nProvider>);

beforeEach(() => { localStorage.clear(); videos.heroId = null; });
afterEach(() => { cleanup(); setBrand(null); vi.restoreAllMocks(); });

describe("🏠 الصفحة الرئيسية v2", () => {
  beforeEach(() => setBrand("v2"));
  it("كل الأقسام + CTA «أنشئ حسابك مجانًا» يروح /signup + الأسعار والسنة مميزة", () => {
    mount(<Home />);
    expect(screen.getByTestId("landing-page")).toBeTruthy();
    for (const id of ["features", "pricing", "security", "faq"]) expect(document.getElementById(id), id).toBeTruthy();
    const ctas = screen.getAllByTestId("cta-signup");
    expect(ctas.length).toBeGreaterThan(0);
    for (const a of ctas) { expect(a.getAttribute("href")).toBe("/signup"); expect(a.textContent).toContain("أنشئ حسابك مجانًا"); }
    const cards = screen.getByTestId("pricing-cards");
    // أرقام غربية بتنسيق en-US وdir=ltr على الرقم بس — حتى في الواجهة العربية.
    for (const [code, price] of [["month_1", "500"], ["month_5", "1,999"], ["month_12", "3,999"]] as const) {
      const el = within(screen.getByTestId(`plan-price-${code}`)).getByText(price);
      expect(el.getAttribute("dir")).toBe("ltr");
    }
    expect(screen.getByTestId("plan-month_12").textContent).toContain("333.25");
    expect(screen.getByTestId("plan-month_5").textContent).toContain("399.80");
    expect(screen.getByTestId("plan-month_12").textContent).toContain("2,001");
    expect(document.querySelector("[data-testid=pricing-cards]")!.textContent).not.toMatch(/[٠-٩]/);
    expect(screen.getByTestId("pricing-note").textContent).toContain("مفيش فترة تجريبية");
    expect(screen.getByTestId("showcase-demo-note").textContent).toContain("بيانات تجريبية");
    expect(screen.getByTestId("plan-month_12").dataset.best).toBe("true");
    expect(cards.querySelectorAll("[data-best]")).toHaveLength(1);
    expect(screen.getByTestId("plan-month_12").textContent).toContain("أفضل قيمة");
  });
  it("مفيش آراء عملاء أو أرقام مستخدمين مخترعة، ومفيش iframe يوتيوب لما مفيش معرّف", () => {
    mount(<Home />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/testimonial|عميل سعيد|آراء العملاء|\+\s?\d+\s?(تاجر|merchant)/i);
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.getByTestId("video-hero").dataset.videoPending).toBe("true");
  });
  it("فيديو بمعرّف صالح: مفيش طلب ليوتيوب قبل الضغط، وبعد الضغط iframe من youtube-nocookie", () => {
    videos.heroId = "dQw4w9WgXcQ";
    mount(<Home />);
    expect(document.querySelector("iframe")).toBeNull();
    fireEvent.click(within(screen.getByTestId("video-hero")).getByRole("button"));
    expect(document.querySelector("iframe")?.getAttribute("src")).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
  });
  it("زر اللغة: الصفحة كلها إنجليزي LTR والاختيار محفوظ", () => {
    mount(<Home />);
    fireEvent.click(screen.getByTestId("lang-toggle"));
    fireEvent.click(screen.getByTestId("lang-option-en"));
    expect(screen.getByTestId("landing-page").getAttribute("dir")).toBe("ltr");
    expect(screen.getAllByTestId("cta-signup")[0].textContent).toContain("Create your free account");
    expect(screen.getByTestId("plan-month_12").textContent).toContain("Best value");
    expect(localStorage.getItem("mj.lang")).toBe("en");
  });
});

describe("🔐 الدخول v2", () => {
  beforeEach(() => setBrand("v2"));
  it("تخطيط مقسوم + إظهار كلمة المرور + نسيت كلمة المرور + مفيش زر جوجل", () => {
    mount(<Login />);
    expect(screen.getByTestId("login-page").dataset.layout).toBe("split");
    const pwd = document.getElementById("login-password") as HTMLInputElement;
    expect(pwd.type).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "إظهار كلمة المرور" }));
    expect(pwd.type).toBe("text");
    expect(screen.queryByTestId("login-forgot-help")).toBeNull();
    fireEvent.click(screen.getByTestId("login-forgot"));
    expect(screen.getByTestId("login-forgot-help").textContent).toContain("الدعم");
    expect(document.body.textContent).not.toMatch(/google|جوجل/i);
    expect(screen.getByRole("link", { name: "أنشئ حسابك مجانًا" }).getAttribute("href")).toBe("/signup");
  });
  it("«افتكرني» بيتبعت للسيرفر (الافتراضي true، والإلغاء false)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: false, error: "بيانات غير صحيحة" }), { status: 401 }));
    mount(<Login />);
    fireEvent.change(document.getElementById("login-username")!, { target: { value: "owner" } });
    fireEvent.change(document.getElementById("login-password")!, { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("login-remember"));
    await act(async () => { fireEvent.submit(document.querySelector("form")!); });
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toMatchObject({ username: "owner", rememberMe: false });
    expect(screen.getByRole("alert").textContent).toContain("بيانات غير صحيحة");
  });
  it("بالإنجليزي: رسالة خطأ عامة (مش نص السيرفر العربي) والاتجاه LTR", async () => {
    localStorage.setItem("mj.lang", "en");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ success: false, error: "بيانات غير صحيحة" }), { status: 401 }));
    mount(<Login />);
    expect(screen.getByTestId("login-page").getAttribute("dir")).toBe("ltr");
    fireEvent.change(document.getElementById("login-username")!, { target: { value: "owner" } });
    fireEvent.change(document.getElementById("login-password")!, { target: { value: "pw" } });
    await act(async () => { fireEvent.submit(document.querySelector("form")!); });
    expect(screen.getByRole("alert").textContent).toBe("Sign-in failed. Check your details and try again.");
  });
});

describe("v1 بدون تغيير", () => {
  beforeEach(() => setBrand(null));
  it("الرئيسية القديمة، والدخول بالكارت القديم بدون افتكرني/نسيت/زر لغة، والتسجيل بنفس النصوص", () => {
    localStorage.setItem("mj.lang", "en");
    mount(<Home />);
    expect(screen.getByTestId("home-page")).toBeTruthy();
    expect(screen.queryByTestId("landing-page")).toBeNull();
    cleanup();
    mount(<Login />);
    expect(screen.getByTestId("login-page").dataset.layout).toBeUndefined();
    expect(screen.getByTestId("login-page").getAttribute("dir")).toBe("rtl");
    expect(screen.queryByTestId("login-remember")).toBeNull();
    expect(screen.queryByTestId("login-forgot")).toBeNull();
    expect(screen.queryByTestId("lang-toggle")).toBeNull();
    expect(screen.getByText("تسجيل دخول لوحة الإدارة")).toBeTruthy();
    cleanup();
    mount(<Register />);
    expect(screen.getByText("إنشاء حساب تاجر جديد")).toBeTruthy();
    expect(screen.queryByTestId("register-free-note")).toBeNull();
  });
});
