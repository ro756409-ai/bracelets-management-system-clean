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
