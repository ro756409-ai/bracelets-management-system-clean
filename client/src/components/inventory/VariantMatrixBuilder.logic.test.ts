import { describe, it, expect } from "vitest";
import {
  rebuildRows,
  enabledVariants,
  comboKey,
  emptyVariantMatrix,
  type VariantRowDraft,
} from "./VariantMatrixBuilder";

/**
 * المرحلة B — منطق بانِي المصفوفة (دوال نقية، بلا DOM): توليد Color×Size، الحفاظ على تعديلات
 * الصفوف الباقية، وتصفية المفعّلة فقط.
 */

describe("🔑 rebuildRows — توليد التركيبات Color × Size", () => {
  it("🔑 لونان × مقاسان = 4 تركيبات فريدة", () => {
    const rows = rebuildRows(["أسود", "أبيض"], ["S", "M"], {}, "TSHIRT");
    expect(Object.keys(rows).length).toBe(4);
    expect(rows[comboKey("أسود", "S")].sku).toBe("TSHIRT-أسود-S");
    expect(new Set(Object.values(rows).map(r => `${r.color}|${r.size}`)).size).toBe(4);
  });

  it("🔑 لون فقط (بلا مقاس) = تركيبة لكل لون", () => {
    const rows = rebuildRows(["أحمر", "أخضر"], [], {}, "");
    expect(Object.keys(rows).length).toBe(2);
    expect(Object.values(rows).every(r => r.size === "")).toBe(true);
  });

  it("🔑 بلا لون ولا مقاس = صفر تركيبات", () => {
    expect(Object.keys(rebuildRows([], [], {}, "")).length).toBe(0);
  });

  it("🔑 إعادة البناء بتحافظ على تعديلات الصفوف الباقية وتشيل اللي اتحذف", () => {
    const first = rebuildRows(["أسود"], ["S", "M"], {}, "X");
    const key = comboKey("أسود", "S");
    first[key].price = "199";
    first[key].enabled = false;
    // شيل مقاس M وضيف لون أبيض
    const second = rebuildRows(["أسود", "أبيض"], ["S"], first, "X");
    expect(second[key].price).toBe("199"); // الصف الباقي احتفظ بتعديله
    expect(second[key].enabled).toBe(false);
    expect(second[comboKey("أسود", "M")]).toBeUndefined(); // اتشال
    expect(second[comboKey("أبيض", "S")]).toBeTruthy(); // اتضاف
  });
});

describe("🔑 enabledVariants — المفعّلة فقط", () => {
  it("🔑 بترجّع الصفوف المفعّلة بس", () => {
    const rows = rebuildRows(["أسود", "أبيض"], ["S"], {}, "X");
    rows[comboKey("أبيض", "S")].enabled = false;
    const value = { colors: ["أسود", "أبيض"], sizes: ["S"], rows };
    const enabled: VariantRowDraft[] = enabledVariants(value);
    expect(enabled.length).toBe(1);
    expect(enabled[0].color).toBe("أسود");
  });
  it("🔑 المصفوفة الفاضية → صفر", () => {
    expect(enabledVariants(emptyVariantMatrix()).length).toBe(0);
  });
});
