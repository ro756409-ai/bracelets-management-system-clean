import { describe, it, expect } from "vitest";
import {
  BOSTA_DELIVERY_IMAGE_TYPE, BOSTA_MAX_DELIVERY_IMAGES, NO_PACKAGE_IMAGE_MESSAGE, PACKAGE_IMAGE_URL_PREFIX,
  imageUrlForLog, isPublicImageUrl, packageImageTenant, parsePackageImageUrl, resolveDeliveryImages,
} from "./packageImages";

/**
 * قاعدة اختيار صور الشحنة لبوسطة (بلا قاعدة بيانات): صورة المنتج → صورة البراند → منع.
 * الشكل الرسمي حسب توثيق Bosta: `deliveryImages: [{ type: "ALLOW_TO_OPEN_THE_PACKAGE", images: string[1..10] }]`.
 */
const P1 = "https://cdn.example.com/p1.jpg", P2 = "https://cdn.example.com/p2.png", BRAND = "https://cdn.example.com/brand.webp";

describe("🖼️ resolveDeliveryImages — ترتيب الاختيار والشكل الرسمي", () => {
  it("فتح الشحنة غير مفعّل → لا صور مطلوبة ولا payload", () => {
    const r = resolveDeliveryImages({ allowToOpenPackage: false, items: [{ productId: 1, imageUrl: null }], brandDefaultUrl: null });
    expect(r).toEqual({ ok: true, required: false, images: [], payload: null, omitted: 0 });
  });

  it("منتج واحد × 3 قطع (3 بنود لنفس المنتج) → صورة واحدة بلا تكرار", () => {
    const r = resolveDeliveryImages({
      allowToOpenPackage: true,
      items: [{ productId: 1, imageUrl: P1 }, { productId: 1, imageUrl: P1 }, { productId: 1, imageUrl: P1 }],
      brandDefaultUrl: BRAND,
    });
    expect(r.ok && r.required).toBe(true);
    if (!r.ok) throw new Error("unexpected");
    expect(r.images).toEqual([{ url: P1, source: "product", productId: 1 }]);
    expect(r.payload).toEqual([{ type: BOSTA_DELIVERY_IMAGE_TYPE, images: [P1] }]);
    expect(BOSTA_DELIVERY_IMAGE_TYPE).toBe("ALLOW_TO_OPEN_THE_PACKAGE");
  });

  it("عدة منتجات لكلٍّ صورة → صورة لكل منتج مرة واحدة، وبلا صورة البراند", () => {
    const r = resolveDeliveryImages({ allowToOpenPackage: true, items: [{ productId: 1, imageUrl: P1 }, { productId: 2, imageUrl: P2 }], brandDefaultUrl: BRAND });
    if (!r.ok) throw new Error("unexpected");
    expect(r.images.map(i => i.source)).toEqual(["product", "product"]);
    expect(r.payload![0].images).toEqual([P1, P2]);
  });

  it("خليط: منتج بصورة + منتجان بلا صورة → صورة المنتج + صورة البراند **مرة واحدة**", () => {
    const r = resolveDeliveryImages({
      allowToOpenPackage: true,
      items: [{ productId: 1, imageUrl: P1 }, { productId: 2, imageUrl: null }, { productId: 3, imageUrl: "" }],
      brandDefaultUrl: BRAND,
    });
    if (!r.ok) throw new Error("unexpected");
    expect(r.images).toEqual([{ url: P1, source: "product", productId: 1 }, { url: BRAND, source: "brand_default" }]);
  });

  it("لا صور منتجات → صورة البراند الافتراضية وحدها (ولو كانت البنود كثيرة)", () => {
    const r = resolveDeliveryImages({ allowToOpenPackage: true, items: [{ productId: 1, imageUrl: null }, { productId: 2, imageUrl: null }], brandDefaultUrl: BRAND });
    if (!r.ok) throw new Error("unexpected");
    expect(r.images).toEqual([{ url: BRAND, source: "brand_default" }]);
    expect(r.payload).toEqual([{ type: BOSTA_DELIVERY_IMAGE_TYPE, images: [BRAND] }]);
  });

  it("أوردر بلا بنود → صورة البراند", () => {
    const r = resolveDeliveryImages({ allowToOpenPackage: true, items: [], brandDefaultUrl: BRAND });
    if (!r.ok) throw new Error("unexpected");
    expect(r.images.map(i => i.source)).toEqual(["brand_default"]);
  });

  it("لا صورة منتج ولا صورة براند → منع برسالة واضحة (لا صورة عشوائية)", () => {
    const r = resolveDeliveryImages({ allowToOpenPackage: true, items: [{ productId: 1, imageUrl: null }], brandDefaultUrl: null });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unexpected");
    expect(r.error).toBe(NO_PACKAGE_IMAGE_MESSAGE);
    expect(r.payload).toBeNull();
  });

  it("رابط منتج غير صالح (http أو بلا امتداد) يُعامَل كـ«لا صورة» ويُكمَّل بصورة البراند", () => {
    const r = resolveDeliveryImages({
      allowToOpenPackage: true,
      items: [{ productId: 1, imageUrl: "http://cdn.example.com/p1.jpg" }, { productId: 2, imageUrl: "https://cdn.example.com/page" }],
      brandDefaultUrl: BRAND,
    });
    if (!r.ok) throw new Error("unexpected");
    expect(r.images).toEqual([{ url: BRAND, source: "brand_default" }]);
  });

  it("صورة البراند غير صالحة ولا صور منتجات → منع", () => {
    const r = resolveDeliveryImages({ allowToOpenPackage: true, items: [{ productId: 1, imageUrl: null }], brandDefaultUrl: "http://insecure.example.com/b.jpg" });
    expect(r.ok).toBe(false);
  });

  it("الحد الأقصى 10 صور حسب التوثيق — 12 منتجًا بصور مختلفة → 10 فقط", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ productId: i + 1, imageUrl: `https://cdn.example.com/p${i + 1}.jpg` }));
    const r = resolveDeliveryImages({ allowToOpenPackage: true, items, brandDefaultUrl: BRAND });
    if (!r.ok) throw new Error("unexpected");
    expect(r.images).toHaveLength(BOSTA_MAX_DELIVERY_IMAGES);
    expect(r.payload![0].images).toHaveLength(10);
    expect(r.payload).toHaveLength(1); // عنصر واحد من النوع المدعوم فقط
    expect(r.omitted).toBe(2);
    // القطع ثابت: أول 10 بترتيب البنود — نفس النتيجة في كل محاولة
    expect(r.payload![0].images).toEqual(items.slice(0, 10).map(i => i.imageUrl));
    expect(resolveDeliveryImages({ allowToOpenPackage: true, items, brandDefaultUrl: BRAND })).toEqual(r);
  });

  it("11 منتجًا بصور + منتج بلا صورة → صورة البراند هي الـ12 فتُحذف (omitted=2) والترتيب ثابت", () => {
    const items = Array.from({ length: 11 }, (_, i) => ({ productId: i + 1, imageUrl: `https://cdn.example.com/p${i + 1}.jpg` }));
    items.push({ productId: 99, imageUrl: null as any });
    const r = resolveDeliveryImages({ allowToOpenPackage: true, items, brandDefaultUrl: BRAND });
    if (!r.ok) throw new Error("unexpected");
    expect(r.images).toHaveLength(10); expect(r.omitted).toBe(2);
    expect(r.images.every(i => i.source === "product")).toBe(true);
  });

  it("بلا تجاوز → omitted = 0", () => {
    const r = resolveDeliveryImages({ allowToOpenPackage: true, items: [{ productId: 1, imageUrl: P1 }], brandDefaultUrl: BRAND });
    expect(r.omitted).toBe(0);
  });

  it("صورة البراند هي نفسها صورة المنتج → لا تكرار", () => {
    const r = resolveDeliveryImages({ allowToOpenPackage: true, items: [{ productId: 1, imageUrl: BRAND }, { productId: 2, imageUrl: null }], brandDefaultUrl: BRAND });
    if (!r.ok) throw new Error("unexpected");
    expect(r.images).toHaveLength(1);
    expect(r.images[0].source).toBe("product");
  });
});

describe("🔗 isPublicImageUrl — رابط عام صالح لبوسطة", () => {
  it.each([
    ["https://cdn.example.com/a.jpg", true],
    ["https://cdn.example.com/a.JPEG?x=1", true],
    ["https://matjarak.net/api/public/package-images/t5-pkg-0f1e2d3c-1111-2222-3333-444455556666.webp", true],
    ["http://cdn.example.com/a.jpg", false],
    ["https://localhost/a.jpg", false],
    ["https://app.localhost/a.jpg", false],
    ["https://127.0.0.1/a.jpg", false],
    ["https://cdn.example.com/a.gif", false],
    ["https://cdn.example.com/a", false],
    ["/api/public/package-images/t5-pkg-x.png", false],
    ["not a url", false],
  ])("%s → %s", (url, ok) => expect(isPublicImageUrl(url)).toBe(ok));
});

describe("🧾 imageUrlForLog — الرابط في السجلات بلا query string", () => {
  it("يحذف التوقيع/التوكن من الـquery ويبقي الأصل والمسار", () => {
    expect(imageUrlForLog("https://cdn.example.com/a.jpg?X-Amz-Signature=SECRET&Expires=1")).toBe("https://cdn.example.com/a.jpg?[query-redacted]");
    expect(imageUrlForLog("https://cdn.example.com/a.jpg")).toBe("https://cdn.example.com/a.jpg");
    expect(imageUrlForLog("garbage")).toBe("garbage");
  });
});

describe("🏷️ packageImageTenant / parsePackageImageUrl", () => {
  it("يستخرج رقم التينانت من مرجع مرفوع عندنا (نسبي أو كامل)، وnull لرابط خارجي", () => {
    const name = "t42-pkg-0f1e2d3c-1111-2222-3333-444455556666.png";
    expect(packageImageTenant(`${PACKAGE_IMAGE_URL_PREFIX}${name}`)).toBe(42);
    expect(packageImageTenant(`https://matjarak.net${PACKAGE_IMAGE_URL_PREFIX}${name}`)).toBe(42);
    expect(packageImageTenant("https://cdn.example.com/a.jpg")).toBeNull();
    expect(packageImageTenant(`${PACKAGE_IMAGE_URL_PREFIX}../../etc/passwd`)).toBeNull();
    expect(packageImageTenant(`${PACKAGE_IMAGE_URL_PREFIX}t42-pkg-x.gif`)).toBeNull();
  });
  it("القيمة المخزّنة JSON → رابط أو null بلا رمي", () => {
    expect(parsePackageImageUrl(JSON.stringify("https://a.b/c.jpg"))).toBe("https://a.b/c.jpg");
    expect(parsePackageImageUrl(JSON.stringify(null))).toBeNull();
    expect(parsePackageImageUrl("{broken")).toBeNull();
    expect(parsePackageImageUrl(undefined)).toBeNull();
    expect(parsePackageImageUrl(JSON.stringify("   "))).toBeNull();
  });
});
