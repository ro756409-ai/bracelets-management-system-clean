import { describe, it, expect } from "vitest";
import fs from "fs";
import { buildShipmentContents, describeShipmentLine } from "../shared/orderContent";

/**
 * تعديل بند = **استبدال**، مش إضافة.
 *
 * العطل: الأوردر الجاي من الموقع كان بيتخزّن باسم مركّب — «أسورة نحاس - ذكر التحصين» —
 * يعني نوع الحفر متلزّق جوه `productName` **وكمان** متسجّل في `variantId`. الموظف
 * بيغيّر النوع لـ«سادة»، المعرّف بيتغيّر والاسم بيفضل، وأي شاشة بتركّب الاتنين بتطلع:
 *
 *     أسورة نحاس - ذكر التحصين - سادة
 *
 * البند واحد — العدد صح — لكن جواه نسختين من نفس الاختيار.
 */

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
}

// ==================== ١ · الاسم المركّب ====================

describe("🔑 اسم البند = اسم المنتج لوحده", () => {
  it("🔑 البند المعدّل بيطلع بالنوع الجديد بس", () => {
    expect(
      describeShipmentLine({ productName: "أسورة نحاس", variantName: "سادة", quantity: 1 })
    ).toBe("أسورة نحاس - سادة ×1");
  });

  it("🔑 الصف القديم اللي اسمه مركّب مايتركّبش تاني", () => {
    // صف اتخزّن قبل الإصلاح: الاسم فيه النوع، والمعرّف بيقول نفس النوع.
    expect(
      describeShipmentLine({
        productName: "أسورة نحاس - سادة",
        variantName: "سادة",
        quantity: 1,
      })
    ).toBe("أسورة نحاس - سادة ×1");
  });

  it("النوع اللي جزء من الاسم بالصدفة مايتشالش", () => {
    // «سادة» في نص الاسم مش في آخره — النوع لسه لازم يتكتب.
    expect(
      describeShipmentLine({
        productName: "أسورة سادة نحاس",
        variantName: "آية الكرسي",
        quantity: 1,
      })
    ).toBe("أسورة سادة نحاس - آية الكرسي ×1");
  });
});

// ==================== ٢ · الرحلة الكاملة (نقية) ====================

/**
 * محاكاة السلة: الموقع بيكتب، الموظف بيعدّل، وبوسطة بتقرا.
 *
 * الاستبدال هنا هو نفس اللي `replaceOrderItemsFromEditor` بتعمله — حذف كامل وإعادة
 * كتابة من السطور اللي الشاشة بعتتها، والاسم بيتشتق من الكتالوج.
 */
type Line = { productId: number; variantId: number | null; quantity: number };
const CATALOG_PRODUCTS: Record<number, string> = { 1: "أسورة نحاس", 2: "خاتم نحاس" };
const CATALOG_VARIANTS: Record<number, string> = {
  10: "ذكر التحصين",
  11: "سادة",
  12: "آية الكرسي",
};

/** نفس قاعدة السيرفر: الاسم من الكتالوج، مش من اللي المتصل بعته. */
function save(lines: Line[]) {
  return lines.map(line => ({
    productId: line.productId,
    productName: CATALOG_PRODUCTS[line.productId],
    variantId: line.variantId,
    variantName: line.variantId != null ? CATALOG_VARIANTS[line.variantId] : null,
    quantity: line.quantity,
  }));
}

describe("🔑 الموقع ← تعديل الموظف ← بوسطة", () => {
  it("🔑 STEP 1-4: تحصين ← سادة، بند واحد، والقديم اختفى", () => {
    // STEP 1 — الموقع
    let items = save([{ productId: 1, variantId: 10, quantity: 1 }]);
    expect(items).toHaveLength(1);
    expect(items[0].variantName).toBe("ذكر التحصين");
    expect(items[0].productName).toBe("أسورة نحاس");

    // STEP 2 — الموظف بيغيّر **نفس** البند
    items = save([{ productId: 1, variantId: 11, quantity: 1 }]);
    expect(items).toHaveLength(1);
    expect(items[0].variantName).toBe("سادة");
    // القديم مش موجود في أي حقل من حقول البند الحالي.
    expect(JSON.stringify(items)).not.toContain("ذكر التحصين");

    // STEP 3 — اللي الشاشة بتعرضه
    expect(`${items[0].productName} (${items[0].variantName})`).toBe("أسورة نحاس (سادة)");

    // STEP 4 — payload بوسطة
    const { description, itemsCount } = buildShipmentContents(items);
    expect(description).toBe("أسورة نحاس - سادة ×1");
    expect(description).not.toContain("ذكر التحصين");
    expect(itemsCount).toBe(1);
  });

  it("🔑 كل صور الاستبدال — والقديم مابيفضلش في أي واحدة", () => {
    const cases: [string, Line[], Line[], string][] = [
      ["تحصين ← سادة", [{ productId: 1, variantId: 10, quantity: 1 }], [{ productId: 1, variantId: 11, quantity: 1 }], "ذكر التحصين"],
      ["تحصين ← آية الكرسي", [{ productId: 1, variantId: 10, quantity: 1 }], [{ productId: 1, variantId: 12, quantity: 1 }], "ذكر التحصين"],
      ["سادة ← آية الكرسي", [{ productId: 1, variantId: 11, quantity: 1 }], [{ productId: 1, variantId: 12, quantity: 1 }], "سادة"],
      ["منتج A ← منتج B", [{ productId: 1, variantId: 11, quantity: 1 }], [{ productId: 2, variantId: null, quantity: 1 }], "أسورة نحاس"],
    ];
    for (const [label, before, after, gone] of cases) {
      expect(save(before), label).toHaveLength(1);
      const items = save(after);
      expect(items, label).toHaveLength(1);
      const payload = buildShipmentContents(items);
      expect(payload.description, label).not.toContain(gone);
      expect(payload.itemsCount, label).toBe(1);
    }
  });

  it("🔑 تعديل بند = نفس عدد السطور · إضافة = سطر زيادة · حذف = سطر أقل", () => {
    const one = save([{ productId: 1, variantId: 10, quantity: 1 }]);
    expect(one).toHaveLength(1);

    // تعديل
    expect(save([{ productId: 1, variantId: 11, quantity: 1 }])).toHaveLength(1);

    // إضافة صريحة
    const two = save([
      { productId: 1, variantId: 11, quantity: 1 },
      { productId: 2, variantId: null, quantity: 1 },
    ]);
    expect(two).toHaveLength(2);
    expect(buildShipmentContents(two).itemsCount).toBe(2);

    // حذف
    expect(save([{ productId: 2, variantId: null, quantity: 1 }])).toHaveLength(1);
  });

  it("🔑 السلة المتعددة: تعديل بند واحد مايلمسش التاني", () => {
    const before = save([
      { productId: 1, variantId: 10, quantity: 1 },
      { productId: 1, variantId: 12, quantity: 1 },
    ]);
    expect(before.map(i => i.variantName)).toEqual(["ذكر التحصين", "آية الكرسي"]);

    const after = save([
      { productId: 1, variantId: 11, quantity: 1 },
      { productId: 1, variantId: 12, quantity: 1 },
    ]);
    expect(after).toHaveLength(2);
    expect(after.map(i => i.variantName)).toEqual(["سادة", "آية الكرسي"]);
    const { description } = buildShipmentContents(after);
    expect(description).toBe("أسورة نحاس - سادة ×1، أسورة نحاس - آية الكرسي ×1");
    expect(description).not.toContain("ذكر التحصين");
  });

  it("تغيير الكمية على نفس البند مايزوّدش سطر", () => {
    const items = save([{ productId: 1, variantId: 11, quantity: 3 }]);
    expect(items).toHaveLength(1);
    expect(buildShipmentContents(items)).toEqual({
      description: "أسورة نحاس - سادة ×3",
      itemsCount: 3,
    });
  });
});

// ==================== ٣ · حراس على الكود ====================

describe("🔑 المصدر: الاسم بيتشتق من الكتالوج", () => {
  const db = codeOnly(fs.readFileSync("server/db.ts", "utf-8"));

  it("🔑 الموقع مابيلزقش النوع جوه اسم البند", () => {
    const service = codeOnly(fs.readFileSync("server/easyorder.service.ts", "utf-8"));
    const rows = service.slice(service.indexOf("const itemRows = resolved.map"));
    const block = rows.slice(0, rows.indexOf("}));"));
    expect(block).toContain("variantId: r.match.matched ? r.match.variantId");
    // الاسم المركّب مابقاش في صف البند.
    expect(block).not.toContain("r.match.variantName");
    // وهيدر الأوردر لسه بيعرض الاسم المركّب — ده عرض مش مصدر.
    expect(service).toContain("const displayName = resolved");
  });

  it("🔑 الكاتب بيشتق الاسم من `products` — مش بيصدّق المتصل", () => {
    expect(db).toContain("async function withCatalogProductNames");
    const fn = db.slice(db.indexOf("async function withCatalogProductNames"));
    const body = fn.slice(0, fn.indexOf("\nasync function replaceOrderItemsInTransaction"));
    expect(body).toContain(".from(products)");
    expect(body).toContain("productName: canonical");
    // البند اللي مالوش منتج بيفضل باسمه الخام.
    expect(body).toContain("canonical ? { ...item, productName: canonical } : item");
  });

  it("🔑 والمسارين الكاتبين بينادوه", () => {
    expect((db.match(/await withCatalogProductNames\(tx, /g) ?? []).length).toBe(2);
    for (const writer of [
      "async function replaceOrderItemsInTransaction",
      "export async function replaceOrderItemsFromEditor",
    ]) {
      const fn = db.slice(db.indexOf(writer));
      const body = fn.slice(0, fn.indexOf("insert(orderItems)"));
      expect(body, writer).toContain("withCatalogProductNames");
    }
  });

  it("🔑 والكتابة استبدال كامل — حذف قبل الإضافة، مش دمج", () => {
    for (const writer of [
      "async function replaceOrderItemsInTransaction",
      "export async function replaceOrderItemsFromEditor",
    ]) {
      const fn = db.slice(db.indexOf(writer));
      const body = fn.slice(0, fn.indexOf("insert(orderItems)"));
      expect(body, writer).toContain("delete(orderItems)");
      // مفيش `onDuplicateKeyUpdate` ولا دمج — الصفوف بتتكتب من الأول.
      expect(body, writer).not.toContain("onDuplicateKeyUpdate");
    }
  });

  it("🔑 والشاشة بترجّع الاسم لاسم المنتج مع تغيير النوع", () => {
    const editor = codeOnly(
      fs.readFileSync("client/src/components/orders/OrderItemsEditor.tsx", "utf-8")
    );
    const handler = editor.slice(editor.indexOf("if (value === NO_VARIANT)"));
    const block = handler.slice(0, handler.indexOf("disabled={disabled}"));
    expect(block).toContain("productName: catalogName");
    // الحالتين: «بدون نوع» ونوع محدد.
    expect((block.match(/productName: catalogName/g) ?? []).length).toBe(2);
  });

  it("🔑 وبوسطة مااتغيّرتش — لسه بتقرا البنود الحالية", () => {
    const bosta = codeOnly(fs.readFileSync("server/bosta.service.ts", "utf-8"));
    expect(bosta).toContain("await getOrderItems(orderId)");
    expect(bosta).toContain("buildShipmentContents(");
  });

  it("🔑 والقديم بيفضل في سجل التعديلات بس", () => {
    const fn = db.slice(db.indexOf("export async function replaceOrderItemsFromEditor"));
    const body = fn.slice(0, fn.indexOf("\nexport async function", 10));
    expect(body).toContain("insert(orderEditLogs)");
    expect(body).toContain("oldValue: existing");
    expect(body).toContain("newValue: summary");
  });
});
