// @vitest-environment jsdom
/**
 * المرحلة 6 — PartnerLogo لكل الجهات + الـfallback + alt/aria-hidden + الأبعاد الثابتة + Light/Dark،
 * SectionIcon (placeholder)، وربط الشعارات في StatusBadge/OrdersTable/WhatsAppButton/IntegrationsMarketplace.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { ShoppingCart } from "lucide-react";

vi.mock("@/components/ui/tooltip", () => ({ Tooltip: ({ children }: any) => <>{children}</>, TooltipTrigger: ({ children }: any) => <>{children}</>, TooltipContent: () => null }));

import { PartnerLogo, PARTNER_IDS, PARTNERS_BY_ID, PARTNER_LOGO_HEIGHT } from "./PartnerLogo";
import { SectionIcon, SECTION_ICONS } from "./SectionIcon";
import { StatusBadge, ORDER_SOURCE, sourceLogo } from "@/components/shared/StatusBadge";
import { WhatsAppButton } from "@/components/shared/WhatsAppButton";
import { OrdersTable, buildOrdersColumns } from "@/components/orders/OrdersTable";
import { IntegrationsMarketplace } from "@/components/IntegrationsMarketplace";

afterEach(() => cleanup());

describe("🏷️ PartnerLogo", () => {
  it("كل الجهات السبع تُرسم كـ<img> محلي بأبعاد width/height ثابتة ونسبة الملف، alt بالاسم العربي، lazy افتراضيًا", () => {
    for (const id of PARTNER_IDS) {
      const { unmount } = render(<PartnerLogo partner={id} size="md" />);
      const el = screen.getByTestId(`partner-logo-${id}`);
      const img = (el.tagName === "IMG" ? el : el.querySelector('img[data-variant="light"]')) as HTMLImageElement;
      expect(img, id).toBeTruthy();
      expect(img.getAttribute("src"), id).toMatch(/^\/brand\/partners\/[\w.-]+\.(svg|png)$/);
      const h = Number(img.getAttribute("height")), w = Number(img.getAttribute("width"));
      expect(h, id).toBe(PARTNER_LOGO_HEIGHT.md);
      const a = PARTNERS_BY_ID[id]!.light!; expect(Math.abs(w / h - a.width / a.height), `${id} ratio`).toBeLessThan(0.1);
      expect(img.getAttribute("alt"), id).toBe(PARTNERS_BY_ID[id]!.nameAr);
      expect(img.getAttribute("aria-hidden"), id).toBeNull();
      expect(img.getAttribute("loading"), id).toBe("lazy");
      expect(el.getAttribute("data-fallback")).toBeNull();
      unmount();
    }
  });
  it("decorative → alt فارغ + aria-hidden؛ eager → loading=eager؛ alt مخصص", () => {
    render(<PartnerLogo partner="bosta" decorative eager />);
    const img = screen.getByTestId("partner-logo-bosta") as HTMLImageElement;
    expect(img.getAttribute("alt")).toBe(""); expect(img.getAttribute("aria-hidden")).toBe("true"); expect(img.getAttribute("loading")).toBe("eager");
    cleanup();
    render(<PartnerLogo partner="instapay" alt="إنستا باي — محفظة" />);
    expect((screen.getByTestId("partner-logo-instapay") as HTMLImageElement).alt).toBe("إنستا باي — محفظة");
  });
  it("Meta: نسختان رسميتان (mono black للفاتح، mono white للداكن) تُبدَّلان بـCSS dark:", () => {
    render(<PartnerLogo partner="meta" />);
    const wrap = screen.getByTestId("partner-logo-meta");
    expect(wrap.getAttribute("data-variants")).toBe("light,dark");
    const light = wrap.querySelector('img[data-variant="light"]')!, dark = wrap.querySelector('img[data-variant="dark"]')!;
    expect(light.getAttribute("src")).toContain("meta-mono-black.svg"); expect(light.className).toContain("dark:hidden");
    expect(dark.getAttribute("src")).toContain("meta-mono-white.svg"); expect(dark.className).toContain("dark:inline-block");
    for (const id of PARTNER_IDS.filter(p => p !== "meta")) { render(<PartnerLogo partner={id} />); expect(screen.getByTestId(`partner-logo-${id}`).getAttribute("data-variants")).toBe("light"); cleanup(); }
  });
  it("fallback نصي محترم عند فشل التحميل أو forceFallback: اسم الجهة، أبعاد ثابتة، role=img/aria-label أو aria-hidden إن زخرفي", () => {
    render(<PartnerLogo partner="easyorders" />);
    fireEvent.error(screen.getByTestId("partner-logo-easyorders"));
    const fb = screen.getByTestId("partner-logo-easyorders");
    expect(fb.getAttribute("data-fallback")).toBe("true"); expect(fb.textContent).toBe("Easy Orders"); expect(fb.getAttribute("role")).toBe("img"); expect(fb.getAttribute("aria-label")).toBe("إيزي أوردرز");
    expect(fb.style.height).toBe(`${PARTNER_LOGO_HEIGHT.sm}px`);
    cleanup();
    render(<PartnerLogo partner="vodafone_cash" decorative forceFallback />);
    const d = screen.getByTestId("partner-logo-vodafone_cash");
    expect(d.getAttribute("aria-hidden")).toBe("true"); expect(d.getAttribute("role")).toBeNull(); expect(d.textContent).toBe("Vodafone Cash");
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("🧊 SectionIcon — slots الأيقونات ثلاثية الأبعاد", () => {
  it("الأقسام الثمانية placeholder: بلاطة accent + أيقونة lucide بأبعاد ثابتة، زخرفية دائمًا؛ لا <img> يدّعي 3D", () => {
    expect(SECTION_ICONS.map(i => i.id)).toHaveLength(8);
    for (const i of SECTION_ICONS) {
      const { unmount } = render(<SectionIcon section={i.id} fallback={ShoppingCart} size="lg" />);
      const el = screen.getByTestId(`section-icon-${i.id}`);
      expect(el.getAttribute("data-status")).toBe("placeholder"); expect(el.getAttribute("aria-hidden")).toBe("true");
      expect(el.style.width).toBe("56px"); expect(el.style.height).toBe("56px"); expect(el.querySelector("svg")).not.toBeNull(); expect(el.querySelector("img")).toBeNull();
      unmount();
    }
  });
});

describe("🔗 الربط في المواضع الموجودة فقط", () => {
  it("StatusBadge kind=source: شعار رسمي لـ easyorder*/facebook/whatsapp مع الاسم مكتوبًا؛ manual/import نقطة؛ حالات الأوردر بلا شعارات", () => {
    for (const s of ["easyorder", "easyorder_farhat", "facebook", "whatsapp"]) {
      const { unmount } = render(<StatusBadge status={s} kind="source" size="sm" />);
      const img = document.querySelector(`[data-testid="partner-logo-${ORDER_SOURCE[s].logo}"]`);
      expect(img, s).not.toBeNull(); expect(img!.getAttribute("aria-hidden")).toBe("true"); expect(document.body.textContent).toContain(ORDER_SOURCE[s].label);
      unmount();
    }
    for (const s of ["manual", "import", "shopify"]) { render(<StatusBadge status={s} kind="source" />); expect(document.querySelector("[data-testid^=partner-logo-]"), s).toBeNull(); cleanup(); }
    render(<StatusBadge status="new" kind="order" />); expect(document.querySelector("[data-testid^=partner-logo-]")).toBeNull();
    expect(sourceLogo("easyorder_ataba")).toBe("easyorders"); expect(sourceLogo("manual")).toBeUndefined(); expect(sourceLogo(null)).toBeUndefined();
  });
  it("OrdersTable: شعار بوسطة فقط على الأوردر الذي له شحنة بوسطة فعلية", () => {
    const rows = [
      { id: 1, orderNumber: "A", customerName: "x", customerPhone: "0100", productName: "p", quantity: 1, totalAmount: "1", status: "shipped", source: "manual", bostaShipmentId: "SHP-1", bostaTrackingNumber: "T1", createdAt: "2026-10-01T00:00:00Z" },
      { id: 2, orderNumber: "B", customerName: "y", customerPhone: "0101", productName: "p", quantity: 1, totalAmount: "1", status: "shipped", source: "manual", createdAt: "2026-10-01T00:00:00Z" },
    ];
    const ctx = { seqByOrderId: new Map(), employeeNameById: new Map(), businessNameById: new Map(), sourceLabel: (s: string) => s, actions: { isAdmin: false, confirmPending: false, duplicatePending: false, onConfirm: vi.fn(), onCancel: vi.fn(), onDetails: vi.fn(), onPostpone: vi.fn(), onNoAnswer: vi.fn(), onCall: vi.fn(), onEdit: vi.fn(), onDuplicate: vi.fn(), onReturn: vi.fn(), onDelete: vi.fn() } };
    render(<OrdersTable rows={rows as any} columns={buildOrdersColumns(ctx as any)} mobileRow={() => null} hiddenColumns={new Set(["seq", "website"])} />);
    const trs = document.querySelectorAll("tbody tr");
    expect(within(trs[0] as HTMLElement).getAllByTestId("partner-logo-bosta")).toHaveLength(1);
    expect(within(trs[1] as HTMLElement).queryByTestId("partner-logo-bosta")).toBeNull();
    expect((trs[0] as HTMLElement).textContent).toContain("بوسطة");
  });
  it("WhatsAppButton: الشعار الرسمي زخرفي والاسم/العنوان يبقيان؛ IntegrationsMarketplace: شعارا EasyOrder وBosta مع الاسم", () => {
    render(<WhatsAppButton phone="01000000000" />);
    const b = screen.getByRole("button"); expect(b.textContent).toContain("واتساب"); expect(within(b).getByTestId("partner-logo-whatsapp").getAttribute("aria-hidden")).toBe("true");
    cleanup();
    render(<IntegrationsMarketplace connectedPlatforms={new Set()} onConnect={() => {}} />);
    expect(screen.getByTestId("partner-logo-easyorders")).toBeTruthy(); expect(screen.getByTestId("partner-logo-bosta")).toBeTruthy();
    expect(document.body.textContent).toContain("EasyOrder"); expect(document.body.textContent).toContain("Bosta");
    expect(screen.queryByTestId("partner-logo-meta")).toBeNull(); // لا بطاقة Meta حقيقية → لا شعار
  });
});
