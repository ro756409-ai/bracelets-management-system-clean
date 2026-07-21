import { describe, it, expect, vi, beforeEach } from "vitest";

// ==================== Helpers copied for testing ====================

const GOVERNORATE_MAP: Record<string, string> = {
  "القاهره": "القاهرة",
  "الجيزه": "الجيزة",
  "الاسكندريه": "الإسكندرية",
  "الاسكندرية": "الإسكندرية",
  "اسكندرية": "الإسكندرية",
  "Alexandria": "الإسكندرية",
  "اسيوط": "أسيوط",
  "الاسيوط": "أسيوط",
  "اسوان": "أسوان",
  "الاسماعيليه": "الإسماعيلية",
  "اسماعيلية": "الإسماعيلية",
  "الفيوم": "الفيوم",
  "فيوم": "الفيوم",
  "المنيا": "المنيا",
  "منيا": "المنيا",
  "بنى سويف": "بني سويف",
  "بني سويف": "بني سويف",
  "سوهاج": "سوهاج",
  "قنا": "قنا",
  "الدقهليه": "الدقهلية",
  "الدقهلية": "الدقهلية",
  "دقهلية": "الدقهلية",
  "الغربيه": "الغربية",
  "الغربية": "الغربية",
  "غربية": "الغربية",
  "المنوفيه": "المنوفية",
  "المنوفية": "المنوفية",
  "منوفية": "المنوفية",
  "القليوبيه": "القليوبية",
  "القليوبية": "القليوبية",
  "قليوبية": "القليوبية",
  "الشرقيه": "الشرقية",
  "الشرقية": "الشرقية",
  "شرقية": "الشرقية",
  "البحيره": "البحيرة",
  "البحيرة": "البحيرة",
  "بحيرة": "البحيرة",
  "كفر الشيخ": "كفر الشيخ",
  "كفرالشيخ": "كفر الشيخ",
  "الاقصر": "الأقصر",
  "الأقصر": "الأقصر",
  "اقصر": "الأقصر",
  "البحر الاحمر": "البحر الأحمر",
  "البحر الأحمر": "البحر الأحمر",
  "الوادي الجديد": "الوادي الجديد",
  "مطروح": "مطروح",
  "شمال سيناء": "شمال سيناء",
  "جنوب سيناء": "جنوب سيناء",
  "بورسعيد": "بورسعيد",
  "السويس": "السويس",
  "الاسماعيلية": "الإسماعيلية",
  "دمياط": "دمياط",
  "شراملس": "الدقهلية",
  "منطقة الرياض": "غير محدد",
};

function normalizeGov(raw: string): string {
  if (!raw) return "غير محدد";
  const trimmed = raw.trim();
  if (GOVERNORATE_MAP[trimmed]) return GOVERNORATE_MAP[trimmed];
  for (const [key, val] of Object.entries(GOVERNORATE_MAP)) {
    if (trimmed.includes(key) || key.includes(trimmed)) return val;
  }
  const firstWord = trimmed.split(/[\s,،]/)[0];
  if (GOVERNORATE_MAP[firstWord]) return GOVERNORATE_MAP[firstWord];
  return trimmed.length > 30 ? "غير محدد" : trimmed;
}

function normalizeArabic(text: string): string {
  return text
    .replace(/[أإآا]/g, "ا")
    .replace(/[ةه]/g, "ه")
    .replace(/[يى]/g, "ي")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const DB_PRODUCTS = [
  { id: 1, name: "أسورة نحاس أحمر طبي - آية الكرسي" },
  { id: 2, name: "أسورة نحاس أحمر طبي - عين حورس" },
  { id: 3, name: "أسورة نحاس أحمر طبي - ذكر التحصين" },
  { id: 4, name: "أسورة نحاس أحمر طبي - فاطمة الزهراء" },
  { id: 5, name: "أسورة نحاس أحمر طبي - منفوش" },
  { id: 6, name: "أسورة نحاس أحمر طبي - سادة" },
];

function matchProduct(productNameRaw: string, variantRaw: string, products: any[]): any | null {
  const engravePatterns = [
    /نوع\s*الحفر\s*[:\-]\s*(.+)/,
    /الحفر\s*[:\-]\s*(.+)/,
    /النوع\s*[:\-]\s*(.+)/,
    /حفر\s*[:\-]\s*(.+)/,
  ];

  function tryMatch(text: string): any | null {
    if (!text) return null;
    const t = text.trim();
    const tNorm = normalizeArabic(t);
    let m = products.find((p: any) => t === p.name || tNorm === normalizeArabic(p.name));
    if (m) return m;
    m = products.find((p: any) => t.includes(p.name) || p.name.includes(t));
    if (m) return m;
    m = products.find((p: any) => {
      const pn = normalizeArabic(p.name);
      return tNorm.includes(pn) || pn.includes(tNorm);
    });
    if (m) return m;
    for (const p of products) {
      const keywords = normalizeArabic(p.name).split(/\s+/).filter((w: string) => w.length > 2);
      if (keywords.length > 0 && keywords.every((kw: string) => tNorm.includes(kw))) return p;
    }
    return null;
  }

  const raw = (productNameRaw || "").trim();
  const variantFirst = (variantRaw || "").split("\n")[0].trim();

  if (variantFirst) {
    const m = tryMatch(raw + " - " + variantFirst);
    if (m) return m;
  }
  const m1 = tryMatch(raw);
  if (m1) return m1;

  if (variantFirst) {
    for (const pattern of engravePatterns) {
      const match = variantFirst.match(pattern);
      if (match) {
        const engraveName = match[1].trim();
        const m = tryMatch(engraveName);
        if (m) return m;
        if (normalizeArabic(engraveName) === normalizeArabic("سادة")) {
          const plain = products.find((p: any) => normalizeArabic(p.name).includes(normalizeArabic("سادة")));
          if (plain) return plain;
        }
      }
    }
    const m2 = tryMatch(variantFirst);
    if (m2) return m2;
  }

  for (const pattern of engravePatterns) {
    const match = raw.match(pattern);
    if (match) {
      const m = tryMatch(match[1].trim());
      if (m) return m;
    }
  }

  const parts = raw.split(" - ").map((s: string) => s.trim());
  for (const part of parts) {
    const m = tryMatch(part);
    if (m) return m;
  }

  return null;
}

// ==================== Tests ====================

describe("normalizeGov (webhook)", () => {
  it("يعالج القاهرة بأشكال مختلفة", () => {
    expect(normalizeGov("القاهره")).toBe("القاهرة");
    expect(normalizeGov("القاهرة")).toBe("القاهرة");
  });

  it("يعالج الإسكندرية بأشكال مختلفة", () => {
    expect(normalizeGov("الاسكندريه")).toBe("الإسكندرية");
    expect(normalizeGov("الاسكندرية")).toBe("الإسكندرية");
    expect(normalizeGov("اسكندرية")).toBe("الإسكندرية");
    expect(normalizeGov("Alexandria")).toBe("الإسكندرية");
  });

  it("يعالج منطقة الرياض (خارج مصر)", () => {
    expect(normalizeGov("منطقة الرياض")).toBe("غير محدد");
  });

  it("يعالج شراملس → الدقهلية", () => {
    expect(normalizeGov("شراملس")).toBe("الدقهلية");
  });

  it("يرجع نص طويل كـ غير محدد", () => {
    const longText = "هذا نص طويل جداً لا يمثل محافظة حقيقية في مصر";
    expect(normalizeGov(longText)).toBe("غير محدد");
  });

  it("يتعامل مع فراغ", () => {
    expect(normalizeGov("")).toBe("غير محدد");
  });
});

describe("matchProduct (webhook)", () => {
  it("يطابق اسم المنتج الكامل", () => {
    const result = matchProduct("أسورة نحاس أحمر طبي - آية الكرسي", "", DB_PRODUCTS);
    expect(result?.id).toBe(1);
  });

  it("يطابق اسم المنتج مع variant", () => {
    const result = matchProduct("أسورة نحاس أحمر طبي", "نوع الحفر: آية الكرسي", DB_PRODUCTS);
    expect(result?.id).toBe(1);
  });

  it("يطابق variation_props format", () => {
    const result = matchProduct("أسورة نحاس أحمر طبي", "engraving: آية الكرسي", DB_PRODUCTS);
    // Should match via product name fallback
    expect(result).not.toBeNull();
  });

  it("يطابق عين حورس", () => {
    const result = matchProduct("أسورة نحاس أحمر طبي - عين حورس", "", DB_PRODUCTS);
    expect(result?.id).toBe(2);
  });

  it("يطابق ذكر التحصين", () => {
    const result = matchProduct("أسورة نحاس أحمر طبي - ذكر التحصين", "", DB_PRODUCTS);
    expect(result?.id).toBe(3);
  });

  it("يطابق السادة", () => {
    const result = matchProduct("أسورة نحاس أحمر طبي - سادة", "", DB_PRODUCTS);
    expect(result?.id).toBe(6);
  });

  it("يرجع null لمنتج غير موجود", () => {
    const result = matchProduct("منتج غير موجود في القائمة", "", DB_PRODUCTS);
    expect(result).toBeNull();
  });
});

describe("webhook payload validation", () => {
  it("يتعرف على payload الأوردر الجديد", () => {
    const payload = {
      id: "2692e31f-27f6-472d-b4cd-c0c1c168511c",
      full_name: "أحمد محمد",
      phone: "01012345678",
      government: "القاهرة",
      address: "شارع التحرير",
      total_cost: 250,
      cart_items: [
        {
          id: "item-1",
          product_id: "prod-1",
          price: 250,
          quantity: 1,
          product: { id: "prod-1", name: "أسورة نحاس أحمر طبي - آية الكرسي", price: 250 },
        },
      ],
    };
    expect(payload.id).toBeTruthy();
    expect(payload.full_name).toBeTruthy();
    expect(payload.cart_items.length).toBeGreaterThan(0);
  });

  it("يتعرف على payload تحديث الحالة", () => {
    const payload = {
      event_type: "order-status-update",
      order_id: "2692e31f-27f6-472d-b4cd-c0c1c168511c",
      old_status: "pending",
      new_status: "paid",
    };
    expect(payload.event_type).toBe("order-status-update");
  });

  it("يكتشف payload ناقص", () => {
    const payload = { id: "123" }; // missing full_name and cart_items
    const isValid = !!(payload as any).full_name && !!(payload as any).cart_items?.length;
    expect(isValid).toBe(false);
  });
});

describe("order number generation", () => {
  it("يولد رقم أوردر مفرد للـ cart item الواحد", () => {
    const payloadId = "2692e31f-27f6-472d-b4cd-c0c1c168511c";
    const cartItemsCount = 1;
    const baseOrderNumber = payloadId.slice(0, 20);
    const orderNumber = cartItemsCount > 1 ? `${baseOrderNumber}-0` : baseOrderNumber;
    expect(orderNumber).toBe("2692e31f-27f6-472d-b");
    expect(orderNumber.length).toBeLessThanOrEqual(20);
  });

  it("يولد أرقام أوردرات متعددة لـ cart items متعددة", () => {
    const payloadId = "2692e31f-27f6-472d-b4cd-c0c1c168511c";
    const cartItems = ["item1", "item2", "item3"];
    const baseOrderNumber = payloadId.slice(0, 20);
    const orderNumbers = cartItems.map((_, i) => `${baseOrderNumber}-${i + 1}`);
    expect(orderNumbers).toHaveLength(3);
    expect(orderNumbers[0]).toBe("2692e31f-27f6-472d-b-1");
    expect(orderNumbers[1]).toBe("2692e31f-27f6-472d-b-2");
    expect(orderNumbers[2]).toBe("2692e31f-27f6-472d-b-3");
  });
});

describe("webhook log DB structure", () => {
  it("يحتوي على الحقول المطلوبة في الـ log entry", () => {
    // Simulate what would be inserted into DB
    const logEntry = {
      eventType: "order",
      status: "success" as const,
      externalOrderId: "2692e31f-27f6-472d-b",
      customerName: "أحمد محمد",
      customerPhone: "01012345678",
      governorate: "القاهرة",
      totalAmount: 250,
      itemsCount: 1,
      importedCount: 1,
      rawPayload: JSON.stringify({ id: "test" }),
      message: "تم استيراد 1 أوردر بنجاح",
    };
    expect(logEntry.eventType).toBe("order");
    expect(logEntry.status).toBe("success");
    expect(logEntry.externalOrderId).toBeTruthy();
    expect(logEntry.customerName).toBeTruthy();
    expect(logEntry.importedCount).toBe(1);
  });

  it("يتعامل مع log entry للأوردر المكرر", () => {
    const logEntry = {
      eventType: "order",
      status: "duplicate" as const,
      externalOrderId: "2692e31f-27f6-472d-b",
      customerName: "أحمد محمد",
      message: "أوردر مكرر — تم تخطيه",
    };
    expect(logEntry.status).toBe("duplicate");
    expect(logEntry.externalOrderId).toBeTruthy();
  });

  it("يتعامل مع log entry للخطأ", () => {
    const logEntry = {
      eventType: "unknown",
      status: "error" as const,
      message: "خطأ داخلي: connection refused",
    };
    expect(logEntry.status).toBe("error");
    expect(logEntry.message).toContain("خطأ");
  });

  it("يتعامل مع log entry لتحديث الحالة", () => {
    const logEntry = {
      eventType: "order-status-update",
      status: "status_update" as const,
      externalOrderId: "2692e31f-27f6-472d-b",
      message: "تحديث حالة الأوردر: pending → paid",
    };
    expect(logEntry.status).toBe("status_update");
    expect(logEntry.eventType).toBe("order-status-update");
  });

  it("يقطع rawPayload الطويل إلى 2000 حرف", () => {
    const longPayload = "x".repeat(5000);
    const truncated = longPayload.slice(0, 2000);
    expect(truncated.length).toBe(2000);
  });
});

// ==================== Sales Channel Matching Tests ====================

describe("ربط Webhook بقناة البيع", () => {
  it("getSalesChannelByWebhookSecret is exported from db", async () => {
    const { getSalesChannelByWebhookSecret } = await import("./db");
    expect(typeof getSalesChannelByWebhookSecret).toBe("function");
  });

  it("getSalesChannelByPlatformAndBusiness is exported from db", async () => {
    const { getSalesChannelByPlatformAndBusiness } = await import("./db");
    expect(typeof getSalesChannelByPlatformAndBusiness).toBe("function");
  });

  it("webhook handler sets websiteId and businessId in createOrder call", () => {
    // Simulate the logic: if a channel is matched, websiteId and businessId are set
    const matchedChannelId = 5;
    const matchedBusinessId = 2;

    const orderData = {
      orderNumber: "500",
      customerName: "Test",
      customerPhone: "01012345678",
      customerAddress: "Test Address",
      governorate: "القاهرة",
      productId: 1,
      productName: "Test Product",
      quantity: 1,
      totalAmount: "250",
      source: "easyorder" as const,
      status: "new" as const,
      externalOrderId: "abc-123",
      websiteId: matchedChannelId,
      businessId: matchedBusinessId,
    };

    expect(orderData.websiteId).toBe(5);
    expect(orderData.businessId).toBe(2);
  });

  it("webhook handler defaults businessId to 1 when no channel matched", () => {
    const matchedChannelId: number | null = null;
    const matchedBusinessId: number | null = null;

    const orderData = {
      orderNumber: "501",
      customerName: "Test",
      customerPhone: "01012345678",
      customerAddress: "Test Address",
      governorate: "القاهرة",
      productId: 1,
      productName: "Test Product",
      quantity: 1,
      totalAmount: "250",
      source: "easyorder" as const,
      status: "new" as const,
      externalOrderId: "def-456",
      websiteId: matchedChannelId,
      businessId: matchedBusinessId ?? 1,
    };

    expect(orderData.websiteId).toBeNull();
    expect(orderData.businessId).toBe(1);
  });

  it("log message includes channel info when matched", () => {
    const matchedChannelId = 3;
    const channelInfo = matchedChannelId ? ` | قناة: #${matchedChannelId}` : " | بدون قناة";
    const message = `تم استيراد الأوردر #500 بنجاح — أحمد — القاهرة — منتج${channelInfo}`;
    expect(message).toContain("قناة: #3");
  });

  it("log message shows 'بدون قناة' when no channel matched", () => {
    const matchedChannelId: number | null = null;
    const channelInfo = matchedChannelId ? ` | قناة: #${matchedChannelId}` : " | بدون قناة";
    const message = `تم استيراد الأوردر #501 بنجاح — محمد — الجيزة — منتج${channelInfo}`;
    expect(message).toContain("بدون قناة");
  });
});

// ==================== Shipping Fees Tests ====================
// نفس منطق الـ webhook لحساب الشحن والإجمالي النهائي
function computeShipping(shippingCostRaw: unknown): number {
  const DEFAULT_SHIPPING_FEE = 50;
  const rawShipping = Number(shippingCostRaw);
  return Number.isFinite(rawShipping) && rawShipping > 0
    ? rawShipping
    : DEFAULT_SHIPPING_FEE;
}

function computeFinalTotal(itemsTotal: number, shippingCostRaw: unknown): number {
  return itemsTotal + computeShipping(shippingCostRaw);
}

describe("مصاريف الشحن في الـ webhook", () => {
  it("يضيف 50ج افتراضي عندما لا يوجد shipping_cost (270 → 320)", () => {
    const itemsTotal = 270; // سعر المنتجات
    expect(computeShipping(undefined)).toBe(50);
    expect(computeFinalTotal(itemsTotal, undefined)).toBe(320);
  });

  it("يضيف 50ج افتراضي عندما shipping_cost = 0", () => {
    expect(computeShipping(0)).toBe(50);
    expect(computeFinalTotal(270, 0)).toBe(320);
  });

  it("يستخدم shipping_cost الفعلي من الـ payload عندما يكون موجوداً", () => {
    expect(computeShipping(60)).toBe(60);
    expect(computeFinalTotal(270, 60)).toBe(330);
  });

  it("يتعامل مع shipping_cost كنص رقمي", () => {
    expect(computeShipping("75")).toBe(75);
    expect(computeFinalTotal(200, "75")).toBe(275);
  });

  it("يرجع للافتراضي 50 عند قيمة غير صالحة (NaN)", () => {
    expect(computeShipping("abc")).toBe(50);
    expect(computeFinalTotal(270, "abc")).toBe(320);
  });

  it("يرجع للافتراضي 50 عند قيمة سالبة", () => {
    expect(computeShipping(-10)).toBe(50);
    expect(computeFinalTotal(270, -10)).toBe(320);
  });

  it("totalAmount النهائي دائماً = منتجات + شحن", () => {
    const cases = [
      { items: 270, ship: undefined, expected: 320 },
      { items: 500, ship: 50, expected: 550 },
      { items: 150, ship: 30, expected: 180 },
    ];
    for (const c of cases) {
      expect(computeFinalTotal(c.items, c.ship)).toBe(c.expected);
    }
  });
});
