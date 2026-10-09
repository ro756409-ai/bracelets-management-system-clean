/**
 * المرحلة 7H — حارس نصّي للإعدادات/الشركة/التكاملات/التسجيل/إدارة المنصة: نفس الاستعلامات والـmutations
 * قبل = بعد، لا حقل DB جديد، لا عرض لأي Secret/Token بعد الحفظ (آخر 4 أحرف فقط)، حالة التكامل نصًا +
 * أيقونة، الشعارات الرسمية عبر PartnerLogo فقط، `<main>` واحد في الصفحات المستقلة، أهداف لمس 44px،
 * لا ألوان خام ولا إيموجي، والصفحات تحافظ على السلوك (REST نفسه في التسجيل/المنصة).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const read = (p: string) => strip(readFileSync(path.join(root, p), "utf8"));
const hooks = (src: string) => [...src.matchAll(/trpc\.[a-zA-Z0-9.]+\.use(Query|Mutation)/g)].map(m => m[0]);

describe("🔌 Queries/Mutations قبل = بعد", () => {
  it("Businesses: orderEntryMode/setOrderEntryMode + list/create/update/update", () => {
    expect(hooks(read("pages/Businesses.tsx"))).toEqual([
      "trpc.businesses.orderEntryMode.useQuery", "trpc.businesses.setOrderEntryMode.useMutation",
      "trpc.businesses.list.useQuery", "trpc.businesses.create.useMutation", "trpc.businesses.update.useMutation", "trpc.businesses.update.useMutation",
    ]);
  });
  it("SalesChannels: التسعة نفسها بالترتيب", () => {
    expect(hooks(read("pages/SalesChannels.tsx"))).toEqual([
      "trpc.salesChannels.list.useQuery", "trpc.businesses.activeList.useQuery", "trpc.salesChannels.syncLogs.useQuery",
      "trpc.salesChannels.create.useMutation", "trpc.salesChannels.update.useMutation", "trpc.salesChannels.delete.useMutation",
      "trpc.salesChannels.reactivate.useMutation", "trpc.salesChannels.testConnection.useMutation", "trpc.salesChannels.clearSecret.useMutation",
    ]);
  });
  it("WebhookSettings: webhook.log كل 30 ثانية فقط؛ BostaConnectDialog: status/test/connect/disconnect", () => {
    const w = read("pages/WebhookSettings.tsx");
    expect(hooks(w)).toEqual(["trpc.webhook.log.useQuery"]);
    expect(w).toContain("refetchInterval: 30_000");
    expect(hooks(read("components/BostaConnectDialog.tsx"))).toEqual(["trpc.carrierAccounts.status.useQuery", "trpc.carrierAccounts.testConnection.useMutation", "trpc.carrierAccounts.connect.useMutation", "trpc.carrierAccounts.disconnect.useMutation"]);
  });
  it("التسجيل/الدخول/إدارة المنصة: نفس REST بلا tRPC", () => {
    for (const [f, url] of [["pages/Register.tsx", '"/api/signup"'], ["pages/Login.tsx", '"/api/auth/login"'], ["pages/platform/PlatformAdminLogin.tsx", '"/api/platform/auth/login"'], ["pages/platform/PlatformAdmin.tsx", "/api/platform/signup-requests"]] as const) {
      const p = read(f);
      expect(hooks(p), f).toEqual([]);
      expect(p, f).toContain(url);
    }
    const pa = read("pages/platform/PlatformAdmin.tsx");
    expect(pa).toContain("/approve"); expect(pa).toContain("/reject"); expect(pa).toContain("if (!confirm(");
  });
});

describe("🔐 الأسرار والحالات", () => {
  it("قنوات البيع: الأسرار لا تُعرض بعد الحفظ — آخر 4 أحرف فقط، الحقول password، والفارغ يبقي المحفوظ", () => {
    const p = read("pages/SalesChannels.tsx");
    expect(p).toContain("apiTokenLast4"); expect(p).toContain("webhookSecretLast4");
    expect(p).not.toMatch(/channel\.(apiToken|webhookSecret)\b/);
    expect((p.match(/type="password"/g) ?? []).length).toBe(2);
    expect(p).toContain("apiToken: form.apiToken.trim() || undefined,");
    expect(p).toContain('if (form.webhookSecret.trim() && form.webhookSecret.trim().length < 8)');
  });
  it("Bosta: المفتاح لا يُعرض — آخر 4 أحرف فقط؛ Webhook: الـSecret لا يُعرض في المتصفح", () => {
    const b = read("components/BostaConnectDialog.tsx");
    expect(b).toContain("apiKeyLast4"); expect(b).not.toMatch(/s\?\.apiKey\b/);
    const w = read("pages/WebhookSettings.tsx");
    expect(w).toContain("النظام لا يعرض الـ Secret في المتصفح");
    expect(w).not.toMatch(/webhookSecret|secret=/i);
  });
  it("حالة التكامل نصًا + أيقونة: متصل / غير متصل / خطأ", () => {
    const p = read("pages/SalesChannels.tsx");
    expect(p).toContain('label: "متصل"'); expect(p).toContain('label: "خطأ في الاتصال"'); expect(p).toContain('label: "غير متصل — لم يُختبر بعد"');
    expect(p).toContain("<StatusBadge status={status ?? \"never\"} label={config.label} tone={config.tone} size=\"sm\" icon={<Icon");
    const b = read("components/BostaConnectDialog.tsx");
    expect(b).toContain('label="متصل"'); expect(b).toContain('label="غير متصل"'); expect(b).toContain('label="يحتاج إعادة ربط"');
  });
  it("الشعارات الرسمية عبر PartnerLogo فقط، على المنصة الصحيحة", () => {
    const p = read("pages/SalesChannels.tsx");
    expect(p).toContain('const PLATFORM_LOGOS: Record<string, PartnerId | undefined> = { easyorder: "easyorders", whatsapp: "whatsapp", facebook: "facebook" };');
    expect(read("pages/WebhookSettings.tsx")).toContain('<PartnerLogo partner="easyorders"');
    expect(read("components/BostaConnectDialog.tsx")).toContain('<PartnerLogo partner="bosta"');
    for (const f of ["pages/SalesChannels.tsx", "pages/WebhookSettings.tsx", "components/BostaConnectDialog.tsx", "components/IntegrationsMarketplace.tsx"]) expect(read(f), f).not.toMatch(/<img[^>]*src=["']https?:/);
  });
});

describe("🎨 الهوية وبنية الصفحات", () => {
  const FILES = ["pages/Businesses.tsx", "pages/SalesChannels.tsx", "pages/WebhookSettings.tsx", "pages/Register.tsx", "pages/Login.tsx", "pages/NotFound.tsx", "pages/Home.tsx", "pages/platform/PlatformAdmin.tsx", "pages/platform/PlatformAdminLogin.tsx", "components/IntegrationsMarketplace.tsx", "components/BostaConnectDialog.tsx"];
  for (const f of FILES) {
    it(`${f}: لا ألوان Tailwind خام ولا hex ولا إيموجي؛ كل Button بهدف لمس 44px`, () => {
      const p = read(f);
      expect(p).not.toMatch(/\b(bg|text|border|from|to|ring)-(gray|stone|slate|blue|amber|emerald|green|red|purple|violet|indigo|yellow|orange|rose|sky|cyan|teal|pink|white)-\d{2,3}\b/);
      expect(p).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(p).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
      const buttons = p.match(/<Button\b(?:=>|> 0|[^>])*>/gs) ?? [];
      for (const b of buttons) expect(b, f + " " + b.slice(0, 70)).toMatch(/min-h-11|\bh-11\b|\bh-12\b|\{TOUCH\}|\$\{TOUCH\}|\{ICON_BTN\}|\$\{ICON_BTN\}/);
    });
  }
  it("الصفحات المستقلة (دخول/تسجيل/404/الرئيسية/إدارة المنصة) فيها <main> واحد", () => {
    for (const f of ["pages/Register.tsx", "pages/Login.tsx", "pages/NotFound.tsx", "pages/Home.tsx", "pages/platform/PlatformAdmin.tsx", "pages/platform/PlatformAdminLogin.tsx"]) expect((read(f).match(/<main\b/g) ?? []).length, f).toBe(1);
  });
  it("404 بالعربية؛ التاجر الجديد يرى فراغًا مع خطوات الإعداد (SetupJourney) في الأنشطة/القنوات/Easy Order؛ Businesses بلا businessId ثابت", () => {
    const nf = read("pages/NotFound.tsx");
    expect(nf).toContain("الصفحة غير موجودة"); expect(nf).not.toContain("Page Not Found");
    for (const [f, cur] of [["pages/Businesses.tsx", '<SetupJourney current="business" />'], ["pages/SalesChannels.tsx", '<SetupJourney current="channel" />'], ["pages/WebhookSettings.tsx", '<SetupJourney current="easyorder" />']] as const) expect(read(f), f).toContain(cur);
    expect(read("pages/Businesses.tsx")).toContain('title="لا توجد أنشطة بعد"');
    expect(read("pages/Businesses.tsx")).not.toMatch(/businessId\s*===?\s*\d/);
  });
  it("Businesses عبر ResponsiveDataTable (بطاقات على الهاتف) بلا <Table> يدوي، والـslug يُشتق كما كان", () => {
    const p = read("pages/Businesses.tsx");
    expect(p).toContain("<ResponsiveDataTable<any>"); expect(p).toContain('cardsBelow="md"'); expect(p).not.toContain("<Table");
    expect(p).toContain('const slug = formData.slug.trim() || formData.name.toLowerCase().replace(/\\s+/g, "-").replace(/[^\\w-]/g, "");');
    expect(p).toContain("createInFlightGuard");
  });
});
