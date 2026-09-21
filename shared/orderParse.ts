import { z } from "zod";

/**
 * Hybrid Order Parser — العقد الموحّد (ParseResultV2) بين السيرفر والواجهة.
 *
 * التحليل على مرحلتين: حتمي أولًا (الحقول الصريحة والأرقام)، ثم AI **للأجزاء الغامضة
 * فقط** وبمخرج Zod صارم بلا أي معرّفات — المطابقة على كتالوج النشاط تحصل على السيرفر.
 * الملف بلا أي اعتماد على قاعدة بيانات أو React عن قصد: القواعد (الثقة، التوزيع بالقرش،
 * مصدر السعر) بتتنفّذ في الاتنين وبتتختبر من غير سيرفر.
 *
 * كل ده بيتحفظ داخل `order_parse_audits.resultJson` — **مفيش أي عمود جديد في
 * `order_items`**؛ السطر بيحتفظ بالسعر النهائي في `unitPrice` كما هو.
 */

export const PARSER_VERSION = "2.0";

/** سياسة توزيع إجمالي الأصناف — معلنة وقابلة للمراجعة (انظر allocateLinePrices). */
export const ALLOCATION_POLICY =
  "equal-per-piece-piastres; remainder to one split piece of the last allocated line";

export const CONFIDENCE = ["confident", "ambiguous", "unresolved"] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const PARSE_SOURCE = ["deterministic", "ai", "mixed"] as const;
export type ParseSource = (typeof PARSE_SOURCE)[number];

export const PRICE_SOURCE = ["message", "allocated", "catalog", "manual"] as const;
export type PriceSource = (typeof PRICE_SOURCE)[number];

const confidenceSchema = z.enum(CONFIDENCE);

export const parsedFieldSchema = z.object({
  value: z.union([z.string(), z.number(), z.null()]),
  confidence: confidenceSchema,
  /** من فين جت القيمة: label صريح، استنتاج من العنوان، … */
  source: z.string().max(40),
});
export type ParsedField = z.infer<typeof parsedFieldSchema>;

export const parsedLineSchema = z.object({
  /** النص الأصلي من الرسالة لهذا السطر (للعرض ولاختيار الموظف لو مش محلول). */
  segmentText: z.string(),
  quantity: z.number().int().min(1),
  /** سعر الوحدة بالجنيه (منازل القروش) — null لو مفيش أي سعر قابل للاعتماد. */
  unitPrice: z.number().min(0).nullable(),
  /** إجمالي السطر بالجنيه = unitPrice × quantity **بالظبط** بالقرش. */
  lineTotal: z.number().min(0).nullable(),
  priceSource: z.enum(PRICE_SOURCE).nullable(),
  /** المطابقة من كتالوج النشاط (السيرفر فقط هو اللي بيحطها). */
  match: z
    .object({
      productId: z.number().int(),
      productName: z.string(),
      variantId: z.number().int().nullable(),
      variantName: z.string().nullable(),
    })
    .nullable(),
  confidence: confidenceSchema,
  /** سبب المراجعة/عدم الحل — بالعربي للموظف. */
  reason: z.string().nullable(),
  /** السطر ده اتحل بمساعدة AI (بعد مطابقة السيرفر) — بيتعرض للمراجعة دايمًا. */
  aiAssisted: z.boolean().default(false),
});
export type ParsedLine = z.infer<typeof parsedLineSchema>;

export const unresolvedSegmentSchema = z.object({
  text: z.string(),
  quantity: z.number().int().min(1).nullable(),
  /** اقتراحات بأسماء من كتالوج النشاط (نص فقط) — الموظف يختار. */
  suggestions: z.array(z.string()).default([]),
});

export const parseResultV2Schema = z.object({
  parserVersion: z.literal(PARSER_VERSION),
  parseSource: z.enum(PARSE_SOURCE),
  aiProvider: z.string().nullable(),
  fields: z.object({
    customerName: parsedFieldSchema,
    customerPhone: parsedFieldSchema,
    customerPhone2: parsedFieldSchema,
    governorate: parsedFieldSchema,
    city: parsedFieldSchema,
    customerAddress: parsedFieldSchema,
    adName: parsedFieldSchema,
    pieces: parsedFieldSchema,
    itemsTotal: parsedFieldSchema,
    shipping: parsedFieldSchema,
    discount: parsedFieldSchema,
    finalTotal: parsedFieldSchema,
  }),
  lines: z.array(parsedLineSchema),
  unresolvedSegments: z.array(unresolvedSegmentSchema),
  allocationPolicy: z.string(),
});
export type ParseResultV2 = z.infer<typeof parseResultV2Schema>;

/**
 * مخرج الـAI — **نص وكمية وسعر وثقة فقط**. أي مفتاح زيادة (productId/variantId/sku…)
 * مرفوض بالـschema نفسها (strict)، فمستحيل يوصل معرّف من خيال النموذج للمطابقة.
 */
export const aiSegmentSchema = z
  .object({
    segmentText: z.string().max(200),
    intendedText: z.string().max(120),
    quantity: z.number().int().min(1).max(999).nullable(),
    unitPrice: z.number().min(0).max(1_000_000).nullable(),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type AiSegment = z.infer<typeof aiSegmentSchema>;
export const aiSegmentsSchema = z.array(aiSegmentSchema).max(20);

/** حدود ما يُرسل للـAI: أجزاء المنتج الغامضة فقط، بحد أقصى للعدد والطول. */
export const AI_MAX_SEGMENTS = 10;
export const AI_MAX_SEGMENT_CHARS = 120;
export const AI_TIMEOUT_MS = 6000;
export const AI_MAX_RETRIES = 1;

// ── التوزيع بالقرش ──

const toPiastres = (n: number) => Math.round((Number(n) || 0) * 100);
const toPounds = (p: number) => p / 100;

export interface AllocatedLine {
  /** فهرس السطر الأصلي — السطر المقسوم بيطلع مرتين بنفس الفهرس. */
  index: number;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  priceSource: PriceSource;
}

/**
 * يوزّع إجمالي الأصناف على السطور بحيث **`unitPrice × quantity = lineTotal` بالقرش بالظبط
 * لكل سطر، ومجموع السطور = الإجمالي بالظبط**.
 *
 *   • السطر اللي الرسالة ذكرت سعره (`fixedUnitPrice`) بياخده كما هو (`message`).
 *   • الباقي = الإجمالي − مجموع السطور الثابتة، وبيتوزّع بالتساوي بالقرش على قطع السطور
 *     المتبقية (`allocated`).
 *   • باقي القسمة (أقل من عدد القطع) مايتحطش على سعر وحدة سطر مجمّع — ده كان بيكسر
 *     الضرب. بدل كده: لو آخر سطر كميته 1 بياخد الباقي؛ لو أكتر → **بيتقسم** لسطرين:
 *     (q−1) قطعة بالسعر الأساسي + قطعة واحدة بالسعر الأساسي + الباقي. مفيش قرش بيضيع.
 *   • إجمالي مش مذكور (null) → السطور بلا سعر (null) — مفيش اختراع أسعار.
 */
export function allocateLinePrices(
  lines: { quantity: number; fixedUnitPrice?: number | null }[],
  itemsTotal: number | null
): AllocatedLine[] | null {
  const qs = lines.map(l => Math.max(1, Math.floor(l.quantity) || 1));
  if (itemsTotal == null) {
    // بلا إجمالي: السطور اللي ليها سعر مذكور بس هي اللي بتتسعّر.
    if (!lines.some(l => l.fixedUnitPrice != null)) return null;
    return lines.map((l, i) => {
      const u = l.fixedUnitPrice != null ? toPiastres(l.fixedUnitPrice) : null;
      return u == null
        ? { index: i, quantity: qs[i], unitPrice: 0, lineTotal: 0, priceSource: "allocated" as const }
        : { index: i, quantity: qs[i], unitPrice: toPounds(u), lineTotal: toPounds(u * qs[i]), priceSource: "message" as const };
    });
  }
  const totalP = toPiastres(itemsTotal);
  const out: AllocatedLine[] = [];
  let fixedSum = 0;
  const freeIdx: number[] = [];
  lines.forEach((l, i) => {
    if (l.fixedUnitPrice != null) {
      const u = toPiastres(l.fixedUnitPrice);
      fixedSum += u * qs[i];
      out.push({ index: i, quantity: qs[i], unitPrice: toPounds(u), lineTotal: toPounds(u * qs[i]), priceSource: "message" });
    } else freeIdx.push(i);
  });
  if (freeIdx.length === 0) return out;
  const remainingP = Math.max(0, totalP - fixedSum);
  const units = freeIdx.reduce((s, i) => s + qs[i], 0);
  const perPiece = Math.floor(remainingP / units);
  let rem = remainingP - perPiece * units; // 0 ≤ rem < units
  freeIdx.forEach((i, k) => {
    const isLast = k === freeIdx.length - 1;
    const q = qs[i];
    if (!isLast || rem === 0) {
      out.push({ index: i, quantity: q, unitPrice: toPounds(perPiece), lineTotal: toPounds(perPiece * q), priceSource: "allocated" });
      return;
    }
    if (q === 1) {
      out.push({ index: i, quantity: 1, unitPrice: toPounds(perPiece + rem), lineTotal: toPounds(perPiece + rem), priceSource: "allocated" });
      rem = 0;
      return;
    }
    // سطر مجمّع + باقي: قسمة لسطرين عشان الضرب يطلع مظبوط بالقرش.
    out.push({ index: i, quantity: q - 1, unitPrice: toPounds(perPiece), lineTotal: toPounds(perPiece * (q - 1)), priceSource: "allocated" });
    out.push({ index: i, quantity: 1, unitPrice: toPounds(perPiece + rem), lineTotal: toPounds(perPiece + rem), priceSource: "allocated" });
    rem = 0;
  });
  // ترتيب حسب السطر الأصلي (السطور الثابتة اتضافت الأول).
  return out.sort((a, b) => a.index - b.index);
}

/** هل مجموع (unitPrice × quantity) بالقرش يساوي الإجمالي بالظبط؟ */
export function linesSumMatches(lines: { quantity: number; unitPrice: number }[], itemsTotal: number): boolean {
  const sum = lines.reduce((s, l) => s + toPiastres(l.unitPrice) * Math.max(1, Math.floor(l.quantity) || 1), 0);
  return sum === toPiastres(itemsTotal);
}

/**
 * موانع الحفظ الخاصة بأوردر ناتج عن لصق — **نفس القواعد في الواجهة والسيرفر**:
 * الكميات = عدد القطع، مجموع السطور = إجمالي الأصناف، الإجمالي النهائي = أصناف + شحن − خصم،
 * ولا سطر غير محلول. رسائل عربية بالترتيب؛ فاضية = مسموح.
 */
export function pasteSaveBlockers(
  lines: { quantity: number; unitPrice: number; resolved: boolean }[],
  expected: { pieces: number | null; itemsTotal: number | null; shipping: number; discount: number },
  finalTotal: number
): string[] {
  const out: string[] = [];
  const pieces = lines.reduce((s, l) => s + Math.max(1, Math.floor(l.quantity) || 1), 0);
  if (expected.pieces != null && expected.pieces > 0 && pieces !== expected.pieces)
    out.push(`عدد القطع لا يطابق الرسالة — الرسالة تقول ${expected.pieces} والسطور فيها ${pieces}`);
  const sumP = lines.reduce((s, l) => s + toPiastres(l.unitPrice) * Math.max(1, Math.floor(l.quantity) || 1), 0);
  if (expected.itemsTotal != null && expected.itemsTotal > 0 && sumP !== toPiastres(expected.itemsTotal))
    out.push(`مجموع السطور ${toPounds(sumP).toFixed(2)} لا يساوي إجمالي المنتجات ${expected.itemsTotal.toFixed(2)}`);
  const computed = sumP + toPiastres(expected.shipping) - toPiastres(expected.discount);
  if (toPiastres(finalTotal) !== computed)
    out.push(`الإجمالي النهائي ${finalTotal.toFixed(2)} لا يساوي المنتجات + الشحن − الخصم (${toPounds(computed).toFixed(2)})`);
  const unresolved = lines.map((l, i) => (l.resolved ? -1 : i + 1)).filter(i => i > 0);
  if (unresolved.length) out.push(`اختر نوع النقش للسطر رقم ${unresolved.join("، ")}`);
  return out;
}
