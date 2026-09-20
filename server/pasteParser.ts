import { normalizeDigits, normalizeSize } from "./productMatching";
import { resolveGovernorate } from "../shared/egyptGovernorates";

/**
 * محلّل رسالة العميل الملصوقة (شاشة الإدخال اليدوي). بيدعم القالب:
 *   بيدج: afandy kids
 *   التاريخ: 19 سبتمبر
 *   الاسم: سليم الجزار
 *   العنوان: محافظة السويس
 *   الموشي تعاونيات البحر الاحمر عند مسجد الحرمين
 *   رقم الفون(1): 01229190603
 *   نوع المنتج: طقم اطفال
 *   عدد القطع: ١
 *   اللون: اسود مقاس 8 سنين
 *   الشحن: مجانا
 *   الاجمالي: 500
 * بيتحمّل اختلاف المسافات والألف/الهمزات والأرقام العربية/الإنجليزية. المطابقة (المنتج
 * والتركيبة) بتتعمل بره — هنا استخراج نصّي بس.
 */

export interface ParsedPaste {
  adName: string;
  customerName: string;
  customerPhone: string;
  governorate: string;
  /** المدينة/المركز لو اتحدد من العنوان — منفصل عن المحافظة وعن العنوان الكامل. */
  city: string;
  customerAddress: string;
  productName: string;
  /** الأنواع المذكورة في سطر المنتج («عين حورس وذكر التحصين» → اتنين). */
  productTerms: string[];
  quantity: number;
  color: string;
  size: string;
  /** إجمالي الأصناف قبل الشحن («السعر: 400»). */
  itemsSubtotal: number;
  discount: number;
  shipping: number;
  totalAmount: number;
  /** الإجمالي المكتوب لا يساوي (الأصناف + الشحن − الخصم) — يحتاج مراجعة الموظف. */
  totalMismatch: boolean;
}

// ── حدود القيم ──
//
// كل قيمة بتتقرا من الـlabel بتاعها لحد **آخر السطر أو بداية label تاني** — أيهما أقرب.
// اللصق من واتساب بيحط حقلين في سطر واحد كتير («الشحن: 50 الإجمالي: 450»)، والقراءة
// القديمة كانت بتاخد باقي السطر وتشيل كل حرف مش رقم، فبتلزق الرقمين: 50450. الحد ده
// هو اللي بيمنع الالتصاق، مش تنظيف الناتج بعدين.
const LABELS = [
  "بيدج", "التاريخ", "الاسم", "اسم العميل", "العنوان",
  "رقم", "نوع المنتج", "المنتج", "عدد القطع", "الكمية", "العدد",
  "اللون", "المقاس", "المقاسات", "الحجم",
  "السعر", "سعر", "الشحن", "الخصم", "الاجمالي", "الإجمالي", "المجموع",
];
/** بداية label تاني = نقطة وقف. بنقبل قبلها بداية سطر أو مسافة. */
const NEXT_LABEL = `(?:${LABELS.join("|")})\\s*[:：=]`;
/** فاصل الـlabel عن قيمته: نقطتان عربية/إنجليزية، أو = أو -. */
const SEP = "\\s*[:：=]\\s*";

/** يقرا قيمة label واحدة، ويقف عند نهاية السطر أو أول label تاني. */
function labelValue(text: string, label: string): string {
  const re = new RegExp(`(?:^|\\s)${label}${SEP}((?:(?!${NEXT_LABEL})[^\\n])*)`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

/** رقم من قيمة label — أول رقم فيها بس، مش كل الأرقام ملزوقة. */
function labelNumber(text: string, label: string): number | null {
  const raw = labelValue(text, label);
  if (!raw) return null;
  if (/مجان/.test(raw)) return 0;
  const m = normalizeDigits(raw).match(/\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function firstLineValue(text: string, labelRe: RegExp): string {
  const m = text.match(labelRe);
  return m ? m[1].trim() : "";
}

/**
 * يفصل سطر المنتج لأنواع متعددة: «عين حورس وذكر التحصين» → ["عين حورس","ذكر التحصين"].
 * الفصل على «و» المستقلة و«+» والفاصلة — مش على «و» اللي جوه كلمة (زي «حورس»).
 */
export function splitProductTerms(line: string): string[] {
  const s = String(line ?? "").trim();
  if (!s) return [];
  return s
    .split(/\s*[+،,]\s*|\s+و\s*(?=\S)|\s+ثم\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 1);
}

/**
 * المحافظة والمدينة من كتلة العنوان — **يقين أو فراغ**.
 *
 * بنطابق على قايمة محافظات مصر ومدنها/مراكزها (`shared/egyptGovernorates`): «المنصورة»
 * → الدقهلية، «إدفو» → أسوان، «6 أكتوبر» → الجيزة. لو الاسم ملتبس (بيأدّي لأكتر من
 * محافظة) أو مفيش تطابق، المحافظة بتفضل **فاضية** والموظف بيختارها — أحسن من تخمين
 * غلط بيعدّي في التصدير وبوسطة. العنوان الكامل بيتحفظ منفصل زي ما هو.
 */
function extractLocation(addressBlock: string): { governorate: string; city: string } {
  const explicit = addressBlock.match(/محافظ[ةه]\s*[:：]?\s*([^\n،,]+)/);
  // بندوّر في كتلة العنوان كلها مش أول سطر بس — المحافظة بتتكتب في أي سطر.
  const r = resolveGovernorate(addressBlock);
  if (r.governorate) return { governorate: r.governorate, city: r.city };
  // «محافظة X» مكتوبة صراحة بس X مش في القايمة — نسيبها للموظف بدل قيمة غلط.
  if (explicit) return { governorate: "", city: "" };
  return { governorate: "", city: "" };
}

/** ينضّف طرف اللون من علامات/أقواس/فواصل زائدة: «بيج (» → «بيج». */
function cleanColor(s: string): string {
  return s.replace(/[()\[\]{}،,:：\-–—]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * يفصل نص اللون/المقاس → لون + مقاس. يدعم:
 *   «اسود مقاس 8 سنين» → اسود / 8
 *   «بيج (12 سنة)»      → بيج / 12   (المقاس داخل أقواس)
 *   «بيج 10»            → بيج / 10
 *   أرقام عربية، و«سنة»/«سنين»، ونطاقات «من 6 إلى 8» → الحد الأعلى.
 */
export function splitColorSize(text: string): { color: string; size: string } {
  if (!text) return { color: "", size: "" };
  const t = text.trim();
  // لو فيه كلمة «مقاس/المقاس/الحجم» — اللون قبلها، والمقاس بعدها.
  const byKeyword = t.split(/\s*(?:المقاس|مقاس|الحجم|المقاسات)\s*[:：]?\s*/);
  if (byKeyword.length > 1) {
    return { color: cleanColor(byKeyword[0]), size: normalizeSize(byKeyword.slice(1).join(" ")) };
  }
  // وإلا: اللون قبل أول رقم، والمقاس من أول رقم (الأقواس بتتنضّف).
  const digits = normalizeDigits(t);
  const digitMatch = digits.match(/\d/);
  if (digitMatch && digitMatch.index != null) {
    return {
      color: cleanColor(t.slice(0, digitMatch.index)),
      size: normalizeSize(t.slice(digitMatch.index)),
    };
  }
  return { color: cleanColor(t), size: "" };
}

export function parsePasteMessage(raw: string): ParsedPaste {
  const text = String(raw ?? "").replace(/\r/g, "");

  const adName = firstLineValue(text, /بيدج\s*[:：]\s*([^\n]+)/);
  // «الاسم» أو «اسم العميل» — والقيمة محدودة بالـlabel اللي بعدها زي باقي الحقول.
  const customerName =
    labelValue(text, "اسم\\s*العميل") || labelValue(text, "الاسم");

  // الهاتف: «رقم الفون(1)» أو «رقم التواصل/الموبايل/التليفون» — مع الحفاظ على الصفر الأول.
  let phone = "";
  const phoneM = text.match(
    /رقم\s*(?:ال)?(?:فون|تواصل|موبايل|محمول|تليفون|تلفون|هاتف)\s*(?:\(?\s*[0-9٠-٩]*\s*\)?)?\s*[:：]\s*([0-9٠-٩۰-۹\s\-]+)/
  );
  if (phoneM) phone = normalizeDigits(phoneM[1]).replace(/[^\d]/g, "");
  if (!phone) {
    const any = normalizeDigits(text).match(/\b(01\d{9})\b/);
    if (any) phone = any[1];
  }

  // العنوان: كل السطور بعد «العنوان:» حتى أول حقل معروف تاني (أي «رقم ...»، نوع المنتج، ...).
  const addrM = text.match(
    /العنوان\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:رقم\b|نوع\s*المنتج|عدد\s*القطع|اللون|المقاس|الحجم|الشحن|الاجمالي|الإجمالي|التاريخ|بيدج)|$)/
  );
  const addressBlock = addrM ? addrM[1].trim() : "";
  const { governorate, city } = extractLocation(addressBlock);
  // العنوان التفصيلي = كل السطور مجمّعة (بما فيها سطر «الموشي ...»).
  const customerAddress = addressBlock
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .join("، ");

  const productName = firstLineValue(text, /نوع\s*المنتج\s*[:：]\s*([^\n]+)/);

  const productTerms = splitProductTerms(productName);

  let quantity = 1;
  for (const l of ["عدد\\s*القطع", "الكمية", "العدد"]) {
    const n = labelNumber(text, l);
    if (n != null && n >= 1) { quantity = Math.floor(n); break; }
  }

  const colorLine = firstLineValue(text, /اللون\s*[:：]\s*([^\n]+)/);
  let { color, size } = splitColorSize(colorLine);
  // المقاس ممكن ييجي في سطر مستقل «المقاس: ...» — لو ماطلعش من سطر اللون.
  if (!size) {
    const sizeLine = firstLineValue(text, /(?:المقاس|الحجم|المقاسات)\s*[:：]\s*([^\n]+)/);
    if (sizeLine) size = normalizeSize(sizeLine);
  }

  // كل قيمة من الـlabel بتاعها، محدودة بنهاية السطر أو أول label تاني.
  const shipping = labelNumber(text, "الشحن") ?? 0;
  const discount = labelNumber(text, "الخصم") ?? 0;
  const itemsSubtotal =
    labelNumber(text, "السعر") ?? labelNumber(text, "سعر") ?? 0;
  const writtenTotal =
    labelNumber(text, "الاجمالي") ??
    labelNumber(text, "الإجمالي") ??
    labelNumber(text, "المجموع");

  // المعادلة هي المرجع، والمكتوب بيتقارن بيها. لو اتنينهم موجودين واختلفوا بنعلّم
  // `totalMismatch` وبنسيب المكتوب زي ما هو — **مابنلزقش أرقام ولا بنصحّح بالتخمين**،
  // الموظف بيراجع. لو المكتوب بس موجود (بلا سعر أصناف) نشتق الأصناف منه.
  const computed = itemsSubtotal + shipping - discount;
  let totalAmount = writtenTotal ?? computed;
  let subtotal = itemsSubtotal;
  let totalMismatch = false;
  if (writtenTotal != null && itemsSubtotal > 0) {
    totalMismatch = Math.abs(writtenTotal - computed) > 0.009;
  } else if (writtenTotal != null && itemsSubtotal === 0) {
    subtotal = Math.max(0, writtenTotal - shipping + discount);
  }

  return {
    adName, customerName, customerPhone: phone, governorate, city, customerAddress,
    productName, productTerms, quantity, color, size,
    itemsSubtotal: subtotal, discount, shipping, totalAmount, totalMismatch,
  };
}
