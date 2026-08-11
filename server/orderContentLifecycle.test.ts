import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  buildShipmentContents,
  describeShipmentLine,
  isOrderContentField,
  orderContentChangedAfterShipment,
  ORDER_CONTENT_HEADER_FIELDS,
  SHIPMENT_DESCRIPTION_LIMIT,
} from "../shared/orderContent";

/**
 * محتوى الأوردر — نسخة واحدة حالية من الموقع لحد البوليصة المطبوعة.
 *
 * العطل اللي الملف ده بيحرسه: الأوردر بيتعمل بحفر A، الموظف بيغيّره لـ«آية الكرسي»،
 * الشاشة بتوري الجديد، وبوسطة بتستلم A. السبب إن محتوى الصندوق كان متخزّن في مكانين —
 * هيدر `orders` و`order_items` — وفيه مسارات تعديل بتكتب في واحد بس.
 *
 * الاختبارات هنا على تلات طبقات:
 *   ١. الوصف نفسه — دالة نقية، بتتنفّذ فعليًا هنا.
 *   ٢. حراس على الكود — إن مفيش مسار تاني بيرجّع نفس العطل.
 *   ٣. رحلة كاملة على داتابيز حقيقية — بتشتغل مع `TEST_DATABASE_URL` بس.
 */

/** التعليقات مش كود. الحارس اللي بيقيس على شرحه بيعدّي وهو فاضي. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter(line => !line.trim().startsWith("//"))
    .join("\n");
}

// ==================== ١. الوصف اللي بيوصل بوسطة ====================

describe("وصف الشحنة — مبني من البنود الحالية", () => {
  it("نوع الحفر بيتكتب جنب اسم المنتج", () => {
    expect(
      describeShipmentLine({
        productName: "أسورة نحاس",
        variantName: "آية الكرسي",
        quantity: 1,
      })
    ).toBe("أسورة نحاس - آية الكرسي ×1");
  });

  it("البند من غير حفر مابيتكتبش بشرطة فاضية", () => {
    expect(
      describeShipmentLine({ productName: "أسورة نحاس", variantName: "", quantity: 2 })
    ).toBe("أسورة نحاس ×2");
  });

  it("المقاس واللون بيدخلوا الوصف لما يكونوا موجودين", () => {
    expect(
      describeShipmentLine({
        productName: "أسورة",
        variantName: "ذكر الرحمن",
        quantity: 1,
        size: "M",
        color: "ذهبي",
      })
    ).toBe("أسورة - ذكر الرحمن (مقاس M، لون ذهبي) ×1");
  });

  it("🔑 التعديل بيوصل: الحفر المعدّل هو اللي في الوصف، والقديم مش موجود", () => {
    const { description } = buildShipmentContents([
      { productName: "أسورة نحاس", variantName: "آية الكرسي", quantity: 1 },
    ]);
    expect(description).toContain("آية الكرسي");
    expect(description).not.toContain("ذكر الرحمن");
  });

  it("🔑 أوردر متعدد الأصناف: كل بند بحفره وكميته", () => {
    const { description, itemsCount } = buildShipmentContents([
      { productName: "أسورة نحاس", variantName: "آية الكرسي", quantity: 1 },
      { productName: "أسورة نحاس", variantName: "ذكر الرحمن", quantity: 2 },
      { productName: "خاتم", variantName: null, quantity: 1 },
    ]);
    expect(description).toBe(
      "أسورة نحاس - آية الكرسي ×1، أسورة نحاس - ذكر الرحمن ×2، خاتم ×1"
    );
    expect(itemsCount).toBe(4);
  });

  it("عدد القطع = مجموع كميات البنود مش كمية الهيدر", () => {
    const { itemsCount } = buildShipmentContents(
      [
        { productName: "أسورة", quantity: 3 },
        { productName: "خاتم", quantity: 2 },
      ],
      { productName: "حاجة قديمة", quantity: 1 }
    );
    expect(itemsCount).toBe(5);
  });

  it("الأوردر اللي مالوش بنود بيرجع للهيدر — ودي الحالة الوحيدة", () => {
    const { description, itemsCount } = buildShipmentContents([], {
      productName: "أسورة نحاسية طبية",
      quantity: 2,
    });
    expect(description).toBe("أسورة نحاسية طبية");
    expect(itemsCount).toBe(2);
  });

  it("مفيش هيدر ولا بنود ← نص افتراضي مش فاضي", () => {
    expect(buildShipmentContents([], {}).description).toBe("أساور نحاسية");
  });

  it("deterministic: نفس البنود بتدي نفس النص بالحرف", () => {
    const lines = [
      { productName: "أسورة", variantName: "آية الكرسي", quantity: 1 },
      { productName: "خاتم", variantName: "اسم مخصص", quantity: 2 },
    ];
    expect(buildShipmentContents(lines).description).toBe(
      buildShipmentContents(lines).description
    );
  });

  it("القص بيشيل بنود كاملة، مش نص مقطوع من نص بند", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      productName: `أسورة نحاس موديل ${i}`,
      variantName: "آية الكرسي كاملة بخط الثلث",
      quantity: 1,
    }));
    const { description, itemsCount } = buildShipmentContents(many);
    expect(description.length).toBeLessThanOrEqual(SHIPMENT_DESCRIPTION_LIMIT);
    expect(description).toMatch(/\+\d+ صنف$/);
    // العدد بيفضل صح مهما اتقص الوصف — ده اللي المندوب بيعد بيه.
    expect(itemsCount).toBe(40);
    // آخر بند ظاهر لازم يكون كامل مش مقطوع.
    const lastShown = description.split("، ").slice(-1)[0];
    expect(lastShown).toMatch(/×1 \+\d+ صنف$/);
  });
});

// ==================== ٢. تحذير «بوسطة عندها نسخة قديمة» ====================

describe("تحذير اختلاف المحتوى بعد إنشاء الشحنة", () => {
  const sentAt = new Date("2026-08-01T10:00:00Z");
  const before = new Date("2026-08-01T09:00:00Z");
  const after = new Date("2026-08-01T11:00:00Z");

  it("مفيش شحنة ← مفيش تحذير", () => {
    expect(
      orderContentChangedAfterShipment([{ field: "orderItems", createdAt: after }], null)
    ).toBe(false);
  });

  it("التعديل كان قبل الإرسال ← مفيش تحذير", () => {
    expect(
      orderContentChangedAfterShipment(
        [{ field: "orderItems", createdAt: before }],
        sentAt
      )
    ).toBe(false);
  });

  it("🔑 تعديل البنود بعد الإرسال ← تحذير", () => {
    expect(
      orderContentChangedAfterShipment(
        [{ field: "orderItems", createdAt: after }],
        sentAt
      )
    ).toBe(true);
  });

  it("🔑 تعديل داخلي مش محتوى بعد الإرسال ← مفيش تحذير كاذب", () => {
    const nonContent = [
      "customerPhone",
      "customerName",
      "customerAddress",
      "governorate",
      "city",
      "notes",
      "employeeNotes",
      "paymentMethod",
      "totalAmount",
      "shippingFees",
      "status",
    ];
    for (const field of nonContent) {
      expect(
        orderContentChangedAfterShipment([{ field, createdAt: after }], sentAt)
      ).toBe(false);
    }
  });

  it("كل حقول المحتوى بتولّد تحذير", () => {
    for (const field of ORDER_CONTENT_HEADER_FIELDS) {
      expect(
        orderContentChangedAfterShipment([{ field, createdAt: after }], sentAt)
      ).toBe(true);
    }
    expect(isOrderContentField("orderItems")).toBe(true);
  });

  it("المبلغ مش محتوى صندوق — تغييره مايخليش الشحنة «مختلفة»", () => {
    expect(isOrderContentField("totalAmount")).toBe(false);
    expect(isOrderContentField("shippingFees")).toBe(false);
  });
});

// ==================== ٣. حراس على مسارات الكتابة ====================

describe("مصدر واحد لمحتوى الأوردر", () => {
  const db = codeOnly(fs.readFileSync("server/db.ts", "utf-8"));
  const service = codeOnly(fs.readFileSync("server/bosta.service.ts", "utf-8"));
  const routers = codeOnly(fs.readFileSync("server/routers.ts", "utf-8"));

  it("🔑 بوسطة بتقرا البنود وقت الإرسال، ومفيش مصدر تاني للوصف", () => {
    expect(service).toContain("await getOrderItems(orderId)");
    expect(service).toContain("buildShipmentContents(");
    // مفيش وصف بيتبني بالإيد في الخدمة — لو رجع، الاختلاف بيرجع معاه.
    expect(service).not.toMatch(/description:\s*`/);
    expect(service).not.toContain("externalRawPayload");
  });

  it("🔑 editOrderFull مايقدرش يكتب محتوى في الهيدر من غير البنود", () => {
    const start = db.indexOf("export async function editOrderFull(");
    const end = db.indexOf("\nexport async function", start + 10);
    const body = db.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    // بيقيس التغييرات على نفس قايمة الحقول اللي في الملف المشترك.
    expect(body).toContain("ORDER_CONTENT_HEADER_FIELDS.filter");
    // بيكتب على البند لما يكون واحد.
    expect(body).toContain("update(orderItems)");
    // وبيرفض لما تكون سلة — بدل ما يسيب الهيدر مختلف عنها.
    expect(body).toContain("existingItems.length > 1");
    expect(body).toContain("محرر بنود الأوردر");
  });

  it("🔑 resolveReview بيعيّن المنتج على البنود مش على الهيدر بس", () => {
    const start = db.indexOf("export async function resolveOrderReviewProduct(");
    expect(start).toBeGreaterThan(-1);
    const body = db.slice(start, db.indexOf("\nexport async function", start + 10));
    expect(body).toContain("update(orderItems)");
    expect(body).toContain("db.transaction");
    // والراوتر مابقاش بيعدي على updateOrder العام.
    const routerStart = routers.indexOf("resolveReview: adminProcedure");
    const routerBody = routers.slice(routerStart, routerStart + 1400);
    expect(routerBody).toContain("resolveOrderReviewProduct(");
    expect(routerBody).not.toContain("await updateOrder(");
  });

  it("🔑 تكرار الأوردر بينسخ البنود — النقوش مابتضيعش", () => {
    const start = routers.indexOf("duplicate: adminProcedure");
    const body = routers.slice(start, start + 2600);
    expect(body).toContain("getOrderItems(input.orderId)");
    expect(body).toContain("createOrderWithItems(");
  });

  it("🔑 orders.update العام مالوش أي حقل محتوى", () => {
    const start = routers.indexOf("    update: protectedProcedure");
    const body = routers.slice(start, routers.indexOf(".mutation", start));
    for (const field of ORDER_CONTENT_HEADER_FIELDS) {
      expect(body).not.toContain(`${field}:`);
    }
  });

  it("🔑 كل شاشة بتعدّل المحتوى بتعدي على editOrderItems", () => {
    const screens = [
      "client/src/pages/Orders.tsx",
      "client/src/pages/EmployeeDashboard.tsx",
      "client/src/pages/AgentWorkspace.tsx",
      "client/src/pages/OrderDetails.tsx",
    ];
    for (const path of screens) {
      const source = codeOnly(fs.readFileSync(path, "utf-8"));
      expect(source, path).toContain("OrderEditDialog");
      expect(source, path).toMatch(/editOrderItems\.useMutation/);
    }
  });

  it("🔑 مفيش شاشة لسه بتبعت اسم منتج أو كمية على editOrder", () => {
    const screens = [
      "client/src/pages/Orders.tsx",
      "client/src/pages/EmployeeDashboard.tsx",
      "client/src/pages/AgentWorkspace.tsx",
      "client/src/pages/OrderDetails.tsx",
    ];
    for (const path of screens) {
      const source = codeOnly(fs.readFileSync(path, "utf-8"));
      // الاستدعاء الوحيد لـeditOrder في كل شاشة هو بيانات العميل.
      const calls = source.split("editOrderMutation.mutate");
      const editCalls = source.split("editMutation.mutateAsync");
      for (const chunk of [...calls.slice(1), ...editCalls.slice(1)]) {
        // محدود بقفلة النداء نفسه. الـslice المفتوح بيقيس كود مش موضوع الاختبار،
        // وساعتها الحارس بيرن على حاجة تانية خالص.
        const close = chunk.indexOf("});");
        const payload = close > -1 ? chunk.slice(0, close) : chunk;
        expect(payload, `${path} — productName`).not.toContain("productName");
        expect(payload, `${path} — quantity`).not.toContain("quantity:");
        expect(payload, `${path} — variantId`).not.toContain("variantId:");
      }
    }
  });

  it("🔑 التحذير مشتق من سجل التعديلات — مفيش عمود جديد لتخزين المحتوى", () => {
    expect(db).toContain("orderContentChangedAfterShipment(logs");
    const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
    // مفيش نسخة تانية من وصف الشحنة متخزّنة على الأوردر.
    expect(schema).not.toContain("bostaDescription");
    expect(schema).not.toContain("shipmentDescription");
    expect(schema).not.toContain("bostaPayload");
  });
});

// ==================== ٤. الرحلة الكاملة على داتابيز حقيقية ====================
//
// الموقع ← تعديل الحفر ← إضافة صنف ← تعديل كمية ← payload بوسطة.
// بتشتغل مع `TEST_DATABASE_URL` بس. من غيرها بتتخطى — واللي فوق بيغطي المنطق نفسه.

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  "🔑 رحلة كاملة: الموقع ← تعديل الموظف ← بوسطة",
  () => {
    it("بوسطة بتستلم آخر نسخة محفوظة مش نسخة الموقع", async () => {
      const { getDb, createOrderWithItems, getOrderItems, replaceOrderItemsFromEditor } =
        await import("./db");
      const { createCoreTestFixture } = await import("./testFixtures");
      const { orders, orderItems, productVariants } = await import("../drizzle/schema");
      const { eq } = await import("drizzle-orm");

      const db = await getDb();
      if (!db) return;
      const fixture = await createCoreTestFixture("order-content");
      const editor = { id: 1, name: "موظف تأكيدات", role: "agent" };

      const [engravingA] = await db
        .insert(productVariants)
        .values({
          productId: fixture.productId,
          name: "ذكر الرحمن",
          price: "250",
          currentStock: 100,
        } as any)
        .$returningId();
      const [engravingB] = await db
        .insert(productVariants)
        .values({
          productId: fixture.productId,
          name: "آية الكرسي",
          price: "250",
          currentStock: 100,
        } as any)
        .$returningId();

      // ── STEP 1: الطلب جاي من الموقع ──────────────────────────────
      const orderId = (await createOrderWithItems(
        {
          businessId: fixture.businessId,
          orderNumber: `C${Date.now() % 100000000}`,
          customerName: "عميل الموقع",
          customerPhone: "01000000077",
          governorate: "القاهرة",
          customerAddress: "عنوان",
          productId: fixture.productId,
          productName: "أسورة نحاس - ذكر الرحمن",
          variantId: (engravingA as any).id,
          quantity: 1,
          totalAmount: "250",
          source: "easyorder",
          status: "new",
        } as any,
        [
          {
            productId: fixture.productId,
            productName: "أسورة نحاس",
            variantId: (engravingA as any).id,
            quantity: 1,
            unitPrice: 250,
          },
        ]
      )) as number;

      let items = await getOrderItems(orderId);
      expect(items).toHaveLength(1);
      expect(items[0].variantName).toBe("ذكر الرحمن");

      // ── STEP 2: الموظف بيغيّر الحفر ───────────────────────────────
      //
      // من خلال الراوتر بجلسة موظف تأكيدات حقيقية — يعني الصلاحية والرحلة بيتختبروا
      // مع بعض، مش كل واحد لوحده.
      const { appRouter } = await import("./routers");
      const employeeCaller = appRouter.createCaller({
        req: { protocol: "https", headers: {}, cookies: {} },
        res: { clearCookie: () => {} },
        user: null,
        employee: {
          id: editor.id,
          name: editor.name,
          role: "order_confirmation",
          tenantId: 1,
          businessId: fixture.businessId,
          isActive: true,
        },
        tenantId: 1,
      } as any);
      await employeeCaller.employeePortal.editOrderItems({
        orderId,
        items: [
          {
            productId: fixture.productId,
            productName: "أسورة نحاس",
            variantId: (engravingB as any).id,
            quantity: 1,
            unitPrice: 250,
            discount: 0,
          },
        ],
        shippingFees: 0,
      });
      items = await getOrderItems(orderId);
      expect(items.map(i => i.variantName)).toEqual(["آية الكرسي"]);

      // ── STEP 3: الموظف بيضيف صنف تاني ────────────────────────────
      await replaceOrderItemsFromEditor(
        orderId,
        [
          {
            productId: fixture.productId,
            productName: "أسورة نحاس",
            variantId: (engravingB as any).id,
            quantity: 1,
            unitPrice: 250,
            discount: 0,
          },
          {
            productId: fixture.productId,
            productName: "أسورة نحاس",
            variantId: (engravingA as any).id,
            quantity: 1,
            unitPrice: 250,
            discount: 0,
          },
        ],
        0,
        editor
      );
      items = await getOrderItems(orderId);
      expect(items).toHaveLength(2);

      // ── STEP 4: تعديل الكمية ─────────────────────────────────────
      await replaceOrderItemsFromEditor(
        orderId,
        [
          {
            productId: fixture.productId,
            productName: "أسورة نحاس",
            variantId: (engravingB as any).id,
            quantity: 3,
            unitPrice: 250,
            discount: 0,
          },
          {
            productId: fixture.productId,
            productName: "أسورة نحاس",
            variantId: (engravingA as any).id,
            quantity: 1,
            unitPrice: 250,
            discount: 0,
          },
        ],
        0,
        editor
      );
      items = await getOrderItems(orderId);
      expect(items.reduce((s, i) => s + i.quantity, 0)).toBe(4);

      // الهيدر اتزامن مع البنود — مافيش drift.
      const [header] = await db.select().from(orders).where(eq(orders.id, orderId));
      expect(header.quantity).toBe(4);

      // ── STEP 5: الـpayload اللي بوسطة هتاخده ─────────────────────
      const { description, itemsCount } = buildShipmentContents(
        items.map(i => ({
          productName: i.productName,
          variantName: i.variantName,
          quantity: i.quantity,
          size: i.size,
          color: i.color,
        })),
        { productName: header.productName, quantity: header.quantity }
      );
      expect(description).toContain("آية الكرسي");
      expect(description).toContain("×3");
      expect(description).toContain("ذكر الرحمن");
      expect(itemsCount).toBe(4);

      await db.delete(orderItems).where(eq(orderItems.orderId, orderId));
      await db.delete(orders).where(eq(orders.id, orderId));
      await db
        .delete(productVariants)
        .where(eq(productVariants.productId, fixture.productId));
      await fixture.cleanup();
    });
  }
);
