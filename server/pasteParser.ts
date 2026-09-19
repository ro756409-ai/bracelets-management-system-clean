import { normalizeDigits, normalizeSize } from "./productMatching";

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
  customerAddress: string;
  productName: string;
  quantity: number;
  color: string;
  size: string;
  shipping: number;
  totalAmount: number;
}

function firstLineValue(text: string, labelRe: RegExp): string {
  const m = text.match(labelRe);
  return m ? m[1].trim() : "";
}

/** يشيل بادئة «محافظة/محافظه» من أول سطر العنوان لاستخراج اسم المحافظة. */
function extractGovernorate(addressBlock: string): string {
  const firstLine = addressBlock.split("\n").map(l => l.trim()).filter(Boolean)[0] ?? "";
  const m = firstLine.match(/محافظ[ةه]\s*[:：]?\s*(.+)/);
  if (m) return m[1].trim();
  return firstLine;
}

/** يفصل «اسود مقاس 8 سنين» → لون «اسود» ومقاس «8». */
export function splitColorSize(text: string): { color: string; size: string } {
  if (!text) return { color: "", size: "" };
  const t = text.trim();
  // لو فيه كلمة «مقاس/المقاس/الحجم» — اللون قبلها، والمقاس بعدها.
  const byKeyword = t.split(/\s*(?:المقاس|مقاس|الحجم|المقاسات)\s*[:：]?\s*/);
  if (byKeyword.length > 1) {
    return { color: byKeyword[0].trim(), size: normalizeSize(byKeyword.slice(1).join(" ")) };
  }
  // وإلا: اللون قبل أول رقم، والمقاس من أول رقم.
  const digitMatch = normalizeDigits(t).match(/\d/);
  if (digitMatch && digitMatch.index != null) {
    return {
      color: t.slice(0, digitMatch.index).trim(),
      size: normalizeSize(t.slice(digitMatch.index)),
    };
  }
  return { color: t, size: "" };
}

export function parsePasteMessage(raw: string): ParsedPaste {
  const text = String(raw ?? "").replace(/\r/g, "");

  const adName = firstLineValue(text, /بيدج\s*[:：]\s*([^\n]+)/);
  const customerName = firstLineValue(text, /الاسم\s*[:：]\s*([^\n]+)/);

  // الهاتف: «رقم الفون» أو «رقم الفون(1)» — مع الحفاظ على الصفر الأول.
  let phone = "";
  const phoneM = text.match(
    /رقم\s*(?:ال)?فون\s*(?:\(?\s*[0-9٠-٩]*\s*\)?)?\s*[:：]\s*([0-9٠-٩۰-۹\s\-]+)/
  );
  if (phoneM) phone = normalizeDigits(phoneM[1]).replace(/[^\d]/g, "");
  if (!phone) {
    const any = normalizeDigits(text).match(/\b(01\d{9})\b/);
    if (any) phone = any[1];
  }

  // العنوان: كل السطور بعد «العنوان:» حتى أول حقل معروف تاني.
  const addrM = text.match(
    /العنوان\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:رقم\s*(?:ال)?فون|نوع\s*المنتج|عدد\s*القطع|اللون|الشحن|الاجمالي|الإجمالي|التاريخ|بيدج)\b|$)/
  );
  const addressBlock = addrM ? addrM[1].trim() : "";
  const governorate = extractGovernorate(addressBlock);
  // العنوان التفصيلي = كل السطور مجمّعة (بما فيها سطر «الموشي ...»).
  const customerAddress = addressBlock
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .join("، ");

  const productName = firstLineValue(text, /نوع\s*المنتج\s*[:：]\s*([^\n]+)/);

  let quantity = 1;
  const qtyM = text.match(/عدد\s*القطع\s*[:：]\s*([0-9٠-٩۰-۹]+)/);
  if (qtyM) quantity = Math.max(1, parseInt(normalizeDigits(qtyM[1]), 10) || 1);

  const colorLine = firstLineValue(text, /اللون\s*[:：]\s*([^\n]+)/);
  const { color, size } = splitColorSize(colorLine);

  let shipping = 0;
  const shipM = text.match(/الشحن\s*[:：]\s*([^\n]+)/);
  if (shipM) {
    if (/مجان/.test(shipM[1])) shipping = 0;
    else shipping = parseFloat(normalizeDigits(shipM[1]).replace(/[^\d.]/g, "")) || 0;
  }

  let totalAmount = 0;
  const totM = text.match(/(?:الاجمالي|الإجمالي)\s*[:：]\s*([0-9٠-٩۰-۹.,]+)/);
  if (totM) totalAmount = parseFloat(normalizeDigits(totM[1]).replace(/[^\d.]/g, "")) || 0;

  return {
    adName, customerName, customerPhone: phone, governorate, customerAddress,
    productName, quantity, color, size, shipping, totalAmount,
  };
}
