import { describe, it, expect } from "vitest";
import fs from "fs";

/** حراس نصّية للشل (المرحلة 2): Tokens فقط، لا تكرار لعناصر تفاعلية، قواعد الموبايل، ومصدر التنقّل الواحد. */
const read = (p: string) => fs.readFileSync(p, "utf-8");
const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
const layout = read("client/src/components/DashboardLayout.tsx");
const shell = ["BusinessSwitcher", "MobileBottomNav", "WorkspaceTabs", "TopBar", "CreateMenu"].map(n => [n, read(`client/src/components/shell/${n}.tsx`)] as const);
const palette = read("client/src/components/shared/CommandPalette.tsx");

describe("🔑 الشل — Tokens دلالية فقط", () => {
  it("لا text-white ولا ألوان palette مباشرة ولا hex في الشل وDashboardLayout", () => {
    for (const [name, src] of [["DashboardLayout", layout] as const, ...shell]) {
      const code = codeOnly(src);
      expect(code, name).not.toMatch(/text-white|bg-white|text-black/);
      expect(code, name).not.toMatch(/(bg|text|border)-(red|green|blue|yellow|emerald|amber|orange|purple|violet|slate|gray|zinc|sky|indigo|rose|teal|cyan)-\d{2,3}/);
      expect(code, name).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    }
  });
  it("ألوان السايدبار مشتقة من الـTokens الدلالية (Light بطاقة / Dark داكن دافئ) على حاوية الديسكتوب وورقة الموبايل", () => {
    expect(layout).toContain('[data-slot="sidebar-container"], [data-slot="sidebar"][data-mobile="true"]');
    for (const pair of ["--sidebar: var(--card)", "--sidebar-foreground: var(--foreground)", "--sidebar-accent: var(--primary-soft)", "--sidebar-accent-foreground: var(--primary-text)", "--sidebar-primary: var(--primary)", "--sidebar-border: var(--border)"]) expect(layout).toContain(pair);
    expect(layout).toContain('side="right" collapsible="icon"');
    expect(layout).toContain("before:inset-inline-start-0 before:w-[3px]"); // علامة 3px على الحافة المنطقية
    expect(layout).toContain("tooltip={item.label}");
  });
});

describe("🔑 الشل — بنية واحدة بلا تكرار", () => {
  it("قائمة المستخدم في الشريط العلوي فقط (لا تذييل سايدبار)، وهوية النشاط مرة واحدة (سايدبار ديسكتوب / شريط موبايل)", () => {
    expect(layout).not.toContain("<SidebarFooter");
    expect(layout).not.toContain("AvatarFallback");
    expect((layout.match(/<BusinessSwitcher /g) ?? []).length).toBe(2);
    expect(layout).toContain('{isMobile && <BusinessSwitcher variant="topbar" />}');
    expect(layout).toContain('{!isMobile && <CreateMenu isAdmin={isAdmin} permissions={permissions} />}');
    expect(layout).toContain("<TopBarActions");
    expect(layout).toContain("<WorkspaceTabs tabs={workspaceTabs} />");
    expect(layout).toContain("<MobileBottomNav destinations={navDestinations} />");
  });
  it("الشريط العلوي: البحث يفتح لوحة الأوامر الحالية بحدث، والمدخلات غير المتاحة معطّلة صراحةً لا وهمية", () => {
    const top = read("client/src/components/shell/TopBar.tsx");
    expect(top).toContain("new CustomEvent(COMMAND_PALETTE_OPEN_EVENT)");
    expect(top).toContain('aria-disabled="true" disabled');
    expect(top).toContain("غير متاح حاليًا");
    expect(palette).toContain("window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen)");
  });
  it("لوحة الأوامر تُشتق من config/navigation وتُفلتر بالصلاحيات — لا قائمة ثابتة ولا مسارات محاسبة مجمّدة", () => {
    expect(palette).toContain("paletteItemsFor({ hasUser: Boolean(user), isAdmin: user?.role === \"admin\", permissions })");
    expect(palette).toContain("PRIMARY_DESTINATIONS");
    expect(palette).not.toContain('href: "/treasury"');
    expect(palette).not.toContain('href: "/facebook-entry"');
  });
  it("«إنشاء» يربط بصفحات موجودة فقط وببوابات config/navigation", () => {
    const cm = read("client/src/components/shell/CreateMenu.tsx");
    expect(cm).toContain("gateForPath(");
    for (const p of ["/orders", "/ledger", "/goods-receipt", "/stocktake", "/workshop-returns", "/employees", "/businesses"]) expect(cm).toContain(`path: "${p}"`);
    expect(cm).not.toMatch(/mutation|fetch\(/);
  });
});

describe("🔑 الشل — الموبايل والكيبورد", () => {
  it("Bottom nav: type=button، ≥44px لمس، safe-area؛ WorkspaceTabs: shrink-0 + تمرير داخلي، بلا overflow-x-hidden", () => {
    const nav = read("client/src/components/shell/MobileBottomNav.tsx");
    expect(nav).toContain('type="button"');
    expect(nav).toContain("pb-[env(safe-area-inset-bottom)]");
    expect(nav).toContain("min-h-[56px] min-w-11");
    const tabs = read("client/src/components/shell/WorkspaceTabs.tsx");
    expect(tabs).toContain("shrink-0");
    expect(tabs).toContain("overflow-x-auto");
    expect(tabs).not.toContain("overflow-x-hidden");
    expect(tabs).toContain("scrollIntoView");
    expect(layout).toContain("pb-[calc(6rem+env(safe-area-inset-bottom))]");
  });
  it("زر طي السايدبار زر حقيقي بـaria-label وaria-expanded، وSidebarTrigger على الموبايل 44px", () => {
    expect(layout).toContain('aria-label={isCollapsed ? "توسيع القائمة" : "طي القائمة"}');
    expect(layout).toContain("aria-expanded={!isCollapsed}");
    expect(layout).toContain('<SidebarTrigger className="h-11 w-11 shrink-0 rounded-lg" aria-label="فتح القائمة" />');
    // المجموعة اليمنى تتقلص والإجراءات ثابتة؛ مقبض تغيير العرض ديسكتوب فقط
    expect(layout).toContain('className="flex min-w-0 flex-1 items-center gap-2 md:gap-3"');
    expect(read("client/src/components/shell/TopBar.tsx")).toContain('className="flex shrink-0 items-center gap-1 sm:gap-2"');
    expect(layout).toContain('"hidden" : "hidden md:block"');
  });
});
