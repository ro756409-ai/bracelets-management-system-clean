import { describe, it, expect } from "vitest";
import fs from "fs";
import { moneyTone, toneColor } from "./Surface";

/**
 * اللغة البصرية للحسابات.
 *
 * الاختبارات دي بتحرس **قاعدة واحدة**: اللون معنى مش زينة. سبع شاشات كل واحدة
 * بتختار ألوانها معناها إن التاجر بيبطّل يصدّق اللون — والأحمر الحقيقي (فلوس خارجة)
 * بيضيع وسط أحمر الديكور.
 */

const surface = fs.readFileSync(
  "client/src/components/accounting/Surface.tsx",
  "utf-8"
);

describe("🔑 اللون مشتق من المعنى", () => {
  it("🔑 الداخل أخضر والخارج أحمر والصفر رمادي", () => {
    expect(moneyTone(250)).toBe("in");
    expect(moneyTone(-250)).toBe("out");
    expect(moneyTone(0)).toBe("neutral");
  });

  it("🔑 والدالة بتاخد المبلغ مش اللون — فمحدش يقدر يلوّن رقم داخل بالأحمر", () => {
    const signature = surface.slice(surface.indexOf("export function moneyTone"));
    expect(signature.slice(0, 90)).toContain("signedAmount: number");
  });

  it("🔑 أربع نغمات بالظبط — مفيش خامسة", () => {
    const type = surface.slice(
      surface.indexOf("export type Tone"),
      surface.indexOf(";", surface.indexOf("export type Tone"))
    );
    expect(type).toContain('"in"');
    expect(type).toContain('"out"');
    expect(type).toContain('"due"');
    expect(type).toContain('"neutral"');
    expect(type.split("|")).toHaveLength(4);
  });

  it("🔑 وكل نغمة مربوطة بمتغيّر الثيم مش بلون مكتوب", () => {
    // لون مكتوب بالإيد بيكسر الوضع الليلي وبيختلف من شاشة لشاشة.
    for (const tone of ["in", "out", "due", "neutral"] as const) {
      expect(toneColor(tone)).toMatch(/^var\(--/);
    }
    expect(surface).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});

describe("🔑 إجراء أساسي واحد", () => {
  it("🔑 رأس الشاشة بياخد إجراء واحد مش مصفوفة", () => {
    // الشاشة اللي فيها تلات أزرار أساسية مالهاش إجراء أساسي.
    const header = surface.slice(surface.indexOf("export function ScreenHeader"));
    expect(header).toContain("action?: ReactNode");
    expect(header).not.toContain("actions:");
  });
});

describe("🔑 الموبايل مابيتمدّش أفقيًا", () => {
  it("🔑 التمرير جوه الجدول مش في الصفحة", () => {
    const scroll = surface.slice(surface.indexOf("export function TableScroll"));
    expect(scroll).toContain("overflow-x-auto");
    expect(scroll).toContain("w-full");
  });

  it("والشبكة بتنزل عمودين على الموبايل", () => {
    const row = surface.slice(surface.indexOf("export function KpiRow"));
    expect(row).toContain("grid-cols-2");
    expect(row).toContain("lg:grid-cols-4");
  });
});

describe("حد واحد بدل كارت جوه كارت", () => {
  it("اللوح بيرسم حد واحد", () => {
    // النهاية على التصدير اللي بعده. من غير الحد ده القصّة بتكمل لآخر الملف وتعدّ
    // حدود `TABLE_HEAD_CLASS` كإنها بتاعت اللوح — نفس الفخ اللي وقع قبل كده في
    // اختبارات تانية: تأكيد بيقيس كود مش بتاعه.
    const start = surface.indexOf("export function Panel");
    const panel = surface.slice(start, surface.indexOf("export function TableScroll"));
    const borders = (panel.match(/\bborder\b/g) ?? []).length;
    // حد اللوح نفسه + الفاصل تحت العنوان — مش أكتر.
    expect(borders).toBeLessThanOrEqual(2);
  });
});

// ───────────────── تطبيق النغمات على الشاشات ─────────────────

describe("🔑 السبع شاشات بتستخدم النغمات مش ألوان حرّة", () => {
  const dashboard = fs.readFileSync(
    "client/src/pages/accounting/ControlCenter.tsx",
    "utf-8"
  );

  it("🔑 اللوحة مافيهاش لون مختار للشكل", () => {
    // كانت: الإعلانات بنفسجي، المخزون بنفسجي، المرتبات كهرماني، تكلفة البضاعة أزرق
    // — كلها اختيارات جمالية بتخلي الأحمر الحقيقي يضيع.
    for (const decorative of ["var(--purple)", "var(--info)"]) {
      expect(dashboard, decorative).not.toContain(`tone: "${decorative}"`);
    }
  });

  it("🔑 وكل كارت نغمته من الأربعة", () => {
    const tones = [...dashboard.matchAll(/tone: "([a-z]+)"/g)].map(m => m[1]);
    expect(tones.length).toBeGreaterThan(8);
    for (const tone of tones) {
      expect(["in", "out", "due", "neutral"], tone).toContain(tone);
    }
  });

  it("🔑 والأرقام اللي ليها اتجاه بتاخد لونها من إشارتها", () => {
    // صافي الربح أخضر لما يكون موجب وأحمر لما يكون سالب — من غير ما حد يختار.
    expect(dashboard).toContain("const tone = c.signed ? moneyTone(v) : c.tone");
  });

  it("🔑 والفلوس الداخلة خضرا والخارجة حمرا", () => {
    expect(dashboard).toContain('value: d?.collectionsToday, icon: HandCoins, tone: "in"');
    expect(dashboard).toContain('value: d?.expensesToday, icon: Receipt, tone: "out"');
    expect(dashboard).toContain('value: d?.advertisingToday, icon: Megaphone, tone: "out"');
    expect(dashboard).toContain('value: d?.salariesToday, icon: Users, tone: "out"');
  });

  it("🔑 و«عليك» حمرا و«ليك» خضرا", () => {
    expect(dashboard).toContain('owedToFactories, icon: Factory, tone: "out"');
    expect(dashboard).toContain('owedByFactories, icon: Factory, tone: "in"');
  });

  it("🔑 والمستحق كهرماني — محتاج إجراء مش خسارة", () => {
    expect(dashboard).toContain('value: d?.supplierDue, icon: Clock, tone: "due"');
  });
});

describe("🔑 الإعلانات كمان", () => {
  const ads = fs.readFileSync("client/src/pages/Advertising.tsx", "utf-8");

  it("🔑 مافيهاش لون للشكل", () => {
    for (const decorative of ["var(--purple)", "var(--info)", "var(--warning)"]) {
      expect(ads, decorative).not.toContain(`tone: "${decorative}"`);
    }
  });

  it("🔑 والصرف خارج والعائد داخل والعدّادات معلومة", () => {
    expect(ads).toContain('label: "صرف النهاردة", value: money(todaySpend), icon: Megaphone, tone: "out"');
    expect(ads).toContain('tone: "in"');
    // «رسايل» كانت كهرماني — وهي مش مستحق ولا محتاجة إجراء.
    expect(ads).toContain('label: "رسايل", value: String(totals.messages), icon: MessageSquare, tone: "neutral"');
  });
});
