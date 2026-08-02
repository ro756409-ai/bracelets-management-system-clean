import { describe, it, expect } from "vitest";
import {
  EGYPT_GOVERNORATES,
  GOVERNORATE_NAMES,
  citiesOf,
  isKnownGovernorate,
  isKnownCity,
} from "./egyptLocations";
import { GOVERNORATES, detectGovernorate } from "./facebookOrderParser";

describe("بيانات المحافظات", () => {
  it("٢٧ محافظة — العدد الرسمي", () => {
    expect(EGYPT_GOVERNORATES).toHaveLength(27);
    expect(GOVERNORATE_NAMES).toHaveLength(27);
  });

  it("مفيش محافظة مكررة", () => {
    expect(new Set(GOVERNORATE_NAMES).size).toBe(27);
  });

  it("كل محافظة ليها مدينة واحدة على الأقل", () => {
    for (const gov of EGYPT_GOVERNORATES) {
      expect(gov.cities.length, gov.name).toBeGreaterThan(0);
    }
  });

  it("مفيش مدينة مكررة جوه نفس المحافظة", () => {
    for (const gov of EGYPT_GOVERNORATES) {
      expect(new Set(gov.cities).size, gov.name).toBe(gov.cities.length);
    }
  });

  it("مفيش اسم فاضي أو فيه مسافات زايدة", () => {
    for (const gov of EGYPT_GOVERNORATES) {
      expect(gov.name).toBe(gov.name.trim());
      expect(gov.name.length).toBeGreaterThan(0);
      for (const city of gov.cities) {
        expect(city, `${gov.name}/${city}`).toBe(city.trim());
        expect(city.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("citiesOf", () => {
  it("بيرجّع مدن المحافظة", () => {
    expect(citiesOf("القاهرة")).toContain("مدينة نصر");
    expect(citiesOf("الجيزة")).toContain("6 أكتوبر");
    expect(citiesOf("أسوان")).toContain("كوم أمبو");
  });

  it("🔑 مدن محافظة مش بتظهر في محافظة تانية", () => {
    expect(citiesOf("أسوان")).not.toContain("مدينة نصر");
    expect(citiesOf("القاهرة")).not.toContain("شرم الشيخ");
  });

  it("بيتحمّل مسافات على الأطراف", () => {
    expect(citiesOf("  القاهرة  ")).toContain("المعادي");
  });

  it("🔑 محافظة مش معروفة بترجّع قائمة فاضية مش استثناء", () => {
    expect(citiesOf("محافظة مالهاش وجود")).toEqual([]);
    expect(citiesOf("")).toEqual([]);
    expect(citiesOf(null)).toEqual([]);
    expect(citiesOf(undefined)).toEqual([]);
  });
});

describe("isKnownGovernorate / isKnownCity", () => {
  it("بيميّز الموجود من غير الموجود", () => {
    expect(isKnownGovernorate("القاهرة")).toBe(true);
    expect(isKnownGovernorate("قاهرة")).toBe(false); // مش الاسم القانوني
    expect(isKnownGovernorate(null)).toBe(false);
  });

  it("🔑 المدينة بتتفحص جوه محافظتها هي", () => {
    expect(isKnownCity("القاهرة", "المعادي")).toBe(true);
    expect(isKnownCity("أسوان", "المعادي")).toBe(false);
    expect(isKnownCity("القاهرة", "قرية مش في القائمة")).toBe(false);
    expect(isKnownCity("القاهرة", null)).toBe(false);
  });
});

describe("التوافق مع محلّل فيسبوك", () => {
  it("🔑 نفس المصدر — محافظة المحلّل لازم تكون قابلة للاختيار في الشاشة", () => {
    expect([...GOVERNORATES]).toEqual([...GOVERNORATE_NAMES]);
  });

  it("كل محافظة بيكتشفها المحلّل موجودة في القائمة", () => {
    for (const name of GOVERNORATE_NAMES) {
      const hit = detectGovernorate(`العنوان: ${name} شارع كذا`);
      expect(hit?.gov, name).toBe(name);
    }
  });

  it("🔑 المحافظة اللي بيطلعها المحلّل من اسم دارج ليها مدن", () => {
    const hit = detectGovernorate("انا من المنصوره");
    expect(hit?.gov).toBe("الدقهلية");
    expect(citiesOf(hit!.gov)).toContain("المنصورة");
  });
});
