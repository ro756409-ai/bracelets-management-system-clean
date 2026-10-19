import { describe, it, expect } from "vitest";
import { clearZone, occlusionOf, stuckSide } from "./stickyOcclusion";

/** الحساب النقي لحماية المبالغ من التغطية الجزئية (اتقاس في المتصفح كمان: 24 موضع تمرير عند 1280 = 0 مبلغ جزئي ظاهر). */
describe("🧮 تغطية الأعمدة الثابتة", () => {
  const container = { left: 24, right: 1018 };
  it("المنطقة الصافية = الحاوية ناقص العمود الثابت على كل طرف (RTL: البداية يمين، الإجراءات شمال)", () => {
    expect(clearZone(container, [{ left: 851, right: 1018 }, { left: 24, right: 236 }])).toEqual({ left: 236, right: 851 });
    expect(clearZone(container, [])).toEqual(container);
    expect(clearZone(container, [{ left: 500, right: 500 }])).toEqual(container);
  });
  it("ظاهر كليًا / مخفي كليًا / جزئي — والجزئي بس هو اللي بيتخفي ويتعلّم", () => {
    const zone = { left: 236, right: 851 };
    expect(occlusionOf({ left: 300, right: 380 }, zone)).toBe("visible");
    expect(occlusionOf({ left: 100, right: 200 }, zone)).toBe("hidden");
    expect(occlusionOf({ left: 200, right: 280 }, zone)).toBe("partial");
    expect(occlusionOf({ left: 820, right: 900 }, zone)).toBe("partial");
    expect(occlusionOf({ left: 236.3, right: 300 }, zone)).toBe("visible"); // تقريب نص بكسل
  });
});

describe("📌 العمود المثبّت (مبلغ التحصيل)", () => {
  const start = { left: 851, right: 1018 }, end = { left: 24, right: 236 };
  it("بيتحسب لازق بس لما يلمس حافة عمود ثابت — في موضعه الطبيعي مابيغطّيش حاجة", () => {
    expect(stuckSide({ left: 765, right: 851 }, [start, end])).toBe("end-side");
    expect(stuckSide({ left: 236, right: 322 }, [start, end])).toBe("start-side");
    expect(stuckSide({ left: 500, right: 586 }, [start, end])).toBeNull();
  });
});
