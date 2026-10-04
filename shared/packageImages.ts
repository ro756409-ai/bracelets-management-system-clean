/**
 * صور الشحنة لبوسطة عند تفعيل «السماح بفتح الشحنة» — **بلا عمود جديد ولا Migration**.
 *
 * المصدر: توثيق Bosta الرسمي (Create delivery): الحقل `deliveryImages` على مستوى **الشحنة**
 * (لا لكل صنف)، مصفوفة من `{ type: "ALLOW_TO_OPEN_THE_PACKAGE", images: string[] }`، والصور
 * 1 إلى 10 روابط. مطلوب عندما `allowToOpenPackage = true` واختياري غير ذلك. التوثيق لا
 * يذكر امتدادات ولا حجمًا للرابط الخارجي، فالقيود أدناه (https + امتداد صورة معروف) قيودنا
 * نحن لضمان رابط عام صالح، لا قيود بوسطة.
 *
 * ترتيب اختيار الصورة لكل شحنة:
 *   1) صورة المنتج الأساسية العامة (https) إن وُجدت — لكل منتج في الأوردر، بلا تكرار.
 *   2) وإلا صورة البراند الافتراضية (إعداد لكل نشاط).
 *   3) وإلا منع الإرسال برسالة واضحة.
 *
 * الصورة الافتراضية تُخزَّن في `business_configuration_values` تحت namespace `carrier_bosta`
 * وconfigKey `defaultPackageImageUrl` لكل نشاط — لا صورة نشاط آخر، ولا أول صورة في النظام.
 */

export const PACKAGE_IMAGE_NAMESPACE = "carrier_bosta";
export const PACKAGE_IMAGE_DEFAULT_KEY = "defaultPackageImageUrl";
/** صور المنتجات (المصدر 1) — نفس الجدول: namespace `product_images`، configKey `product:<id>`. */
export const PRODUCT_IMAGE_NAMESPACE = "product_images";
export const productImageKey = (productId: number) => `product:${productId}`;

export const BOSTA_DELIVERY_IMAGE_TYPE = "ALLOW_TO_OPEN_THE_PACKAGE";
export const BOSTA_MAX_DELIVERY_IMAGES = 10;

/** ملفات مرفوعة عندنا وتُقدَّم علنًا لبوسطة: t<tenant>-pkg-<uuid>.<ext> */
export const PACKAGE_IMAGE_FILENAME_PATTERN = /^t(\d+)-pkg-[a-f0-9-]+\.(png|jpg|webp)$/;
export const PACKAGE_IMAGE_URL_PREFIX = "/api/public/package-images/";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp)(\?.*)?$/i;

/** رابط صورة عام صالح لبوسطة: https، مضيف عام (لا localhost/IP خاص)، وامتداد صورة معروف. */
export function isPublicImageUrl(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".test")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "[::1]") return false;
  if (!host.includes(".")) return false;
  return IMAGE_EXTENSIONS.test(u.pathname);
}

export type PackageImageSource = "product" | "brand_default";
export interface ResolvedPackageImage { url: string; source: PackageImageSource; productId?: number }

export interface ResolveDeliveryImagesInput {
  allowToOpenPackage: boolean;
  /** بنود الأوردر: المنتج وصورته العامة إن وُجدت (null = لا صورة). الكميات لا تهم. */
  items: { productId: number | null; imageUrl: string | null }[];
  /** الصورة الافتراضية لشحنات البراند (نشاط الأوردر نفسه) أو null. */
  brandDefaultUrl: string | null;
}

export type ResolveDeliveryImagesResult =
  | { ok: true; required: false; images: []; payload: null }
  | { ok: true; required: true; images: ResolvedPackageImage[]; payload: { type: string; images: string[] }[] }
  | { ok: false; required: true; images: []; payload: null; error: string };

export const NO_PACKAGE_IMAGE_MESSAGE =
  "لا يمكن إرسال الشحنة مع «السماح بفتح الشحنة» بلا صورة: لا توجد صورة عامة للمنتجات ولا صورة افتراضية لشحنات البراند — ارفع الصورة الافتراضية من ربط بوسطة أو أرسل بلا فتح الشحنة";

/**
 * يبني `deliveryImages` بالشكل الرسمي. نقية (بلا قاعدة بيانات) ليُختبر كل فرع:
 *  - منتج واحد ×N قطعة → صورة واحدة (لا تكرار).
 *  - عدة منتجات بصور → صورة لكل منتج مرة واحدة، بحد 10.
 *  - منتجات بلا صور → صورة البراند الافتراضية **مرة واحدة** تكمّلها.
 *  - لا شيء → خطأ واضح (منع الإرسال).
 */
export function resolveDeliveryImages(input: ResolveDeliveryImagesInput): ResolveDeliveryImagesResult {
  if (!input.allowToOpenPackage) return { ok: true, required: false, images: [], payload: null };
  const images: ResolvedPackageImage[] = [];
  const seen = new Set<string>();
  let anyProductWithoutImage = false;
  for (const item of input.items) {
    const url = item.imageUrl?.trim() ?? "";
    if (url && isPublicImageUrl(url)) {
      if (!seen.has(url)) { seen.add(url); images.push({ url, source: "product", productId: item.productId ?? undefined }); }
    } else {
      anyProductWithoutImage = true;
    }
  }
  const brand = input.brandDefaultUrl?.trim() ?? "";
  if ((anyProductWithoutImage || input.items.length === 0) && brand && isPublicImageUrl(brand) && !seen.has(brand)) {
    seen.add(brand);
    images.push({ url: brand, source: "brand_default" });
  }
  if (images.length === 0) return { ok: false, required: true, images: [], payload: null, error: NO_PACKAGE_IMAGE_MESSAGE };
  const limited = images.slice(0, BOSTA_MAX_DELIVERY_IMAGES);
  return {
    ok: true,
    required: true,
    images: limited,
    payload: [{ type: BOSTA_DELIVERY_IMAGE_TYPE, images: limited.map(i => i.url) }],
  };
}

/** رقم التينانت من مرجع ملف مرفوع عندنا (مسار نسبي أو رابط كامل)، أو null لرابط خارجي. */
export function packageImageTenant(url: string): number | null {
  let pathname = url;
  try { pathname = new URL(url, "https://placeholder.invalid").pathname; } catch { return null; }
  if (!pathname.startsWith(PACKAGE_IMAGE_URL_PREFIX)) return null;
  const m = PACKAGE_IMAGE_FILENAME_PATTERN.exec(pathname.slice(PACKAGE_IMAGE_URL_PREFIX.length));
  return m ? Number(m[1]) : null;
}

/** القيمة المخزّنة (JSON) → رابط أو null. مابترميش أبدًا. */
export function parsePackageImageUrl(valueJson: string | null | undefined): string | null {
  if (!valueJson) return null;
  try {
    const v = JSON.parse(valueJson);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch { return null; }
}
