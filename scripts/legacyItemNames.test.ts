import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  classifyItemName,
  summariseVerdicts,
  type ItemNameInput,
} from "../shared/legacyItemNames";

/**
 * تصنيف الصفوف القديمة — مين يتصلّح ومين يتساب.
 *
 * القاعدة: الصف مايتصلّحش غير لما الاسم الصح **يتثبت** من الكتالوج. أي شك = يتساب.
 * الاختبارات دي هي اللي بتخلّي تشغيل السكربت على بيانات إنتاج قرار مبني على حاجة.
 */

const VARIANTS = ["ذكر التحصين", "سادة", "آية الكرسي"];

const row = (over: Partial<ItemNameInput> = {}): ItemNameInput => ({
  currentName: "أسورة نحاس",
  canonicalProductName: "أسورة نحاس",
  hasProductId: true,
  productVariantNames: VARIANTS,
  ...over,
});

// ==================== SAFE ====================

describe("🔑 SAFE — الاسم المركّب اللي إثباته قايم", () => {
  it("🔑 «أسورة نحاس - ذكر التحصين» ← «أسورة نحاس»", () => {
    const verdict = classifyItemName(row({ currentName: "أسورة نحاس - ذكر التحصين" }));
    expect(verdict.status).toBe("safe");
    expect(verdict.proposedName).toBe("أسورة نحاس");
  });

  it("🔑 والصف اللي نوعه اتغيّر بعد كده — الاسم فيه نوع قديم والمعرّف نوع جديد", () => {
    // دي الحالة اللي العطل بيعملها بالظبط: الموظف غيّر النوع لسادة، والاسم فضل تحصين.
    const verdict = classifyItemName(
      row({ currentName: "أسورة نحاس - ذكر التحصين" })
    );
    // الإثبات مش على نوع الصف الحالي — على إن الزيادة نوع **معروف للمنتج**.
    expect(verdict.status).toBe("safe");
    expect(verdict.proposedName).toBe("أسورة نحاس");
  });

  it("المسافات الزيادة مابتمنعش التصحيح", () => {
    const verdict = classifyItemName(
      row({ currentName: "  أسورة نحاس - سادة  ", canonicalProductName: " أسورة نحاس " })
    );
    expect(verdict.status).toBe("safe");
    expect(verdict.proposedName).toBe("أسورة نحاس");
  });
});

// ==================== CLEAN ====================

describe("🔑 الصف السليم مابيتلمسش", () => {
  it("الاسم مطابق للكتالوج ← clean", () => {
    const verdict = classifyItemName(row({ currentName: "أسورة نحاس" }));
    expect(verdict.status).toBe("clean");
    expect(verdict.proposedName).toBeNull();
  });

  it("🔑 والصف اللي اتصلّح خلاص بيرجع clean — ده أساس الـidempotency", () => {
    const before = classifyItemName(row({ currentName: "أسورة نحاس - سادة" }));
    expect(before.status).toBe("safe");
    // نطبّق الاقتراح، ونصنّف تاني.
    const after = classifyItemName(row({ currentName: before.proposedName! }));
    expect(after.status).toBe("clean");
  });
});

// ==================== AMBIGUOUS ====================

describe("🔑 AMBIGUOUS — أي شك يبقى يتساب", () => {
  it("🔑 مفيش productId", () => {
    const verdict = classifyItemName(
      row({ currentName: "حاجة من الموقع - نوع", hasProductId: false })
    );
    expect(verdict.status).toBe("ambiguous");
    expect(verdict.proposedName).toBeNull();
  });

  it("🔑 المنتج اتمسح من الكتالوج", () => {
    const verdict = classifyItemName(
      row({ currentName: "أسورة نحاس - سادة", canonicalProductName: null })
    );
    expect(verdict.status).toBe("ambiguous");
  });

  it("🔑 الزيادة مش نوع معروف للمنتج — يمكن تخصيص مكتوب بإيد", () => {
    const verdict = classifyItemName(
      row({ currentName: "أسورة نحاس - اسم العميل محمد" })
    );
    expect(verdict.status).toBe("ambiguous");
    expect(verdict.reason).toContain("مش نوع معروف");
  });

  it("🔑 الاسم مش بيبدأ باسم المنتج — مايتقصّش على الأعمى", () => {
    const verdict = classifyItemName(
      row({ currentName: "أسورة نحاسية طبية - سادة" })
    );
    expect(verdict.status).toBe("ambiguous");
  });

  it("النوع في نص الاسم مش في آخره", () => {
    const verdict = classifyItemName(
      row({ currentName: "أسورة نحاس - سادة - حاجة زيادة" })
    );
    expect(verdict.status).toBe("ambiguous");
  });

  it("فاصل من غير نوع بعده", () => {
    expect(classifyItemName(row({ currentName: "أسورة نحاس - " })).status).toBe(
      "ambiguous"
    );
  });

  it("المنتج مالوش أنواع أصلاً", () => {
    const verdict = classifyItemName(
      row({ currentName: "أسورة نحاس - سادة", productVariantNames: [] })
    );
    expect(verdict.status).toBe("ambiguous");
  });

  it("اسم المنتج في الكتالوج فاضي", () => {
    expect(
      classifyItemName(row({ currentName: "x - سادة", canonicalProductName: "  " })).status
    ).toBe("ambiguous");
  });
});

// ==================== التشغيلة التانية ====================

describe("🔑 تشغيلتين = صفر تغييرات في التانية", () => {
  it("🔑 مجموعة صفوف مختلطة", () => {
    const rows = [
      row({ currentName: "أسورة نحاس - ذكر التحصين" }), // safe
      row({ currentName: "أسورة نحاس - سادة" }), // safe
      row({ currentName: "أسورة نحاس" }), // clean
      row({ currentName: "أسورة نحاس - اسم مخصص" }), // ambiguous
      row({ currentName: "حاجة", hasProductId: false }), // ambiguous
    ];

    const first = rows.map(classifyItemName);
    expect(summariseVerdicts(first)).toEqual({
      total: 5,
      clean: 1,
      safe: 2,
      ambiguous: 2,
    });

    // نطبّق التصحيح على الـsafe بس — زي ما السكربت بيعمل بالظبط.
    const afterWrite = rows.map((r, index) =>
      first[index].status === "safe"
        ? { ...r, currentName: first[index].proposedName! }
        : r
    );

    const second = afterWrite.map(classifyItemName);
    expect(summariseVerdicts(second)).toEqual({
      total: 5,
      clean: 3,
      safe: 0, // ← صفر تغييرات في التشغيلة التانية
      ambiguous: 2,
    });
  });
});

// ==================== حراس على السكربتات ====================

describe("🔑 حراس السلامة", () => {
  const audit = fs.readFileSync("scripts/auditLegacyItemNames.ts", "utf-8");
  const fix = fs.readFileSync("scripts/normalizeLegacyItemNames.ts", "utf-8");

  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter(line => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
  }

  it("🔑 التدقيق قراءة فقط — مفيش أي كتابة في الملف", () => {
    const code = codeOnly(audit);
    for (const write of [".insert(", ".update(", ".delete(", ".transaction("]) {
      expect(code, write).not.toContain(write);
    }
  });

  it("🔑 والتصحيح بيتوقف من غير --apply", () => {
    const code = codeOnly(fix);
    expect(code).toContain('process.argv.includes("--apply")');
    // المعاينة بتخرج قبل ما توصل لأي كتابة.
    expect(code.indexOf("if (!apply)")).toBeLessThan(code.indexOf(".update(orderItems)"));
  });

  it("🔑 وبيغيّر عمود واحد بس — والباقي مالوش سطر", () => {
    const code = codeOnly(fix);
    expect(code).toContain(".set({ productName: row.verdict.proposedName! })");
    for (const untouched of [
      "productId:",
      "variantId:",
      "quantity:",
      "unitPrice:",
      "status:",
      "bosta",
      "orderEditLogs",
      "update(orders)",
    ]) {
      expect(code, untouched).not.toContain(untouched);
    }
  });

  it("🔑 والكتابة كلها في ترانزاكشن واحدة", () => {
    const code = codeOnly(fix);
    const tx = code.indexOf("db.transaction(");
    expect(tx).toBeGreaterThan(-1);
    expect(code.indexOf(".update(orderItems)")).toBeGreaterThan(tx);
    // نداء واحد للتحديث في الملف كله.
    expect((code.match(/\.update\(orderItems\)/g) ?? []).length).toBe(1);
  });

  it("🔑 وبيصلّح الـsafe بس", () => {
    const code = codeOnly(fix);
    expect(code).toContain('row.verdict.status === "safe"');
    expect(code).toContain("row.verdict.proposedName");
  });

  it("🔑 وبيثبت الـidempotency بنفسه بعد التنفيذ", () => {
    const code = codeOnly(fix);
    const afterWrite = code.slice(code.indexOf("await db.transaction("));
    expect(afterWrite).toContain("auditLegacyItemNames(businessId)");
    expect(afterWrite).toContain("stillSafe !== 0");
  });

  it("🔑 والقرار مش مكتوب في السكربت — جاي من الوحدة المُختبَرة", () => {
    expect(audit).toContain('from "../shared/legacyItemNames"');
    expect(fix).toContain('from "./auditLegacyItemNames"');
    // مفيش منطق تصنيف تاني مكتوب في السكربتات.
    expect(codeOnly(audit)).not.toContain("startsWith(");
    expect(codeOnly(fix)).not.toContain("startsWith(");
  });
});
