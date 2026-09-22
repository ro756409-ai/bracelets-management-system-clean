import { createHash, createHmac, timingSafeEqual } from "crypto";
import { labelNumber, labelValue, parsePasteMessage, type ParsedPaste } from "./pasteParser";
import {
  isExactCatalogTerm,
  matchImportItem,
  normalizeArabic,
  normalizeDigits,
  type MatchCatalog,
} from "./productMatching";
import { allocateQuantities, buildDraftLines, expandSegments, type DraftLine } from "../shared/orderLines";
import {
  ALLOCATION_POLICY,
  PARSER_VERSION,
  allocateLinePrices,
  type Confidence,
  type ParsedField,
  type ParsedLine,
  type ParseResultV2,
} from "../shared/orderParse";
import type { SegmentResolver } from "./ai/segmentResolver";

/**
 * Hybrid Order Parser — المسار الواحد لتحليل رسالة ملصوقة إلى ParseResultV2.
 *
 *   A) حتمي: `parsePasteMessage` (الحقول والأرقام) + السطور ضد كتالوج النشاط
 *      (`expandSegments`/`allocateQuantities`/`matchImportItem`).
 *   B) AI (اختياري، `resolver`): **للأجزاء غير المحلولة فقط**، يرجع نصًا مقصودًا؛ السيرفر
 *      هو اللي بيطابقه على نفس الكتالوج. السطر الناتج بيتعلّم ambiguous + aiAssisted
 *      للمراجعة دايمًا.
 *
 * `catalog` لازم يكون كتالوج النشاط المعزول — الدالة مابتعملش أي فلترة نطاق، ومفيش أي
 * مطابقة خارج اللي اتمرّر.
 */

const field = (value: string | number | null, confidence: Confidence, source: string): ParsedField => ({
  value,
  confidence,
  source,
});

/** سعر مذكور لجزء واحد («سادة 150ج» / «نقش بـ 200 جنيه») — بعلامة عملة/«بـ» فقط. */
export function extractSegmentPrice(text: string): { text: string; unitPrice: number | null } {
  const t = normalizeDigits(String(text ?? "")).trim();
  const m = t.match(/^(.*?)\s*(?:بـ|ب|بسعر|@)?\s*(\d+(?:[.,]\d+)?)\s*(?:ج\.?م|جنيه|جنية|ج)\s*$/);
  if (m && m[1].trim().length > 1) return { text: m[1].trim(), unitPrice: parseFloat(m[2].replace(",", ".")) };
  return { text: t, unitPrice: null };
}

function draftLines(parsed: ParsedPaste, catalog: MatchCatalog): { lines: DraftLine[]; prices: (number | null)[] } {
  if (parsed.colorSizePairs.length > 1) {
    const lines = buildDraftLines(parsed.productTerms, parsed.quantity, parsed.colorSizePairs);
    return { lines, prices: lines.map(() => null) };
  }
  const priced = parsed.productSegments.map(seg => ({ ...extractSegmentPrice(seg.text), qty: seg.qty }));
  const expanded = expandSegments(
    priced.map(p => ({ text: p.text, qty: p.qty })),
    t => isExactCatalogTerm(t, catalog)
  );
  const lines = allocateQuantities(expanded, parsed.quantity, parsed.quantityGiven);
  // السعر المذكور بيتبع الجزء الأصلي بنصّه (بعد الفصل، أول جزء بس هو اللي كان شايل السعر).
  const priceByText = new Map(priced.filter(p => p.unitPrice != null).map(p => [normalizeArabic(p.text), p.unitPrice]));
  const prices = lines.map(l => priceByText.get(normalizeArabic(l.term)) ?? null);
  return { lines, prices };
}

function matchLine(term: string, color: string | null, size: string | null, catalog: MatchCatalog) {
  if (!term && !color && !size) return null;
  // **مفيش مطابقة بالاحتواء** لنص نوع: النص لازم يكون اسمًا معروفًا بالظبط (بمكافئاته)،
  // وإلا «ايه كرسي وتحصين» كانت بتتحسب «ذكر التحصين» لأن الاسم جوّاها وتاخد الكمية كلها.
  // النص اللي مش اسم معروف بيفضل غير محلول والموظف يختار. (سطر بلون/مقاس بيمشي بالمسار الكامل.)
  if (term && !color && !size && !isExactCatalogTerm(term, catalog)) return null;
  const m = matchImportItem({ name: term, variantText: term || undefined, color, size }, catalog);
  return m.matched
    ? { productId: m.productId, productName: m.productName, variantId: m.variantId ?? null, variantName: m.variantName ?? null }
    : null;
}

function suggestionsFor(term: string, catalog: MatchCatalog): string[] {
  const tokens = normalizeArabic(term).split(" ").filter(t => t.length >= 2);
  const names = Array.from(new Set(catalog.variants.filter(v => v.isActive !== false && v.name).map(v => v.name as string)));
  const hits = names.filter(n => tokens.some(t => normalizeArabic(n).includes(t)));
  return (hits.length ? hits : names).slice(0, 6);
}

export interface AnalyzeV2Options {
  resolver?: SegmentResolver | null;
  aiProvider?: string | null;
}

export async function analyzePasteV2(
  text: string,
  catalog: MatchCatalog,
  opts: AnalyzeV2Options = {}
): Promise<ParseResultV2> {
  const raw = String(text ?? "").replace(/\r/g, "");
  const parsed = parsePasteMessage(raw);

  // ── الحقول (حتمي بالكامل — البيانات الشخصية ماتروحش لأي AI) ──
  const req = (v: string, source: string): ParsedField => field(v || null, v ? "confident" : "unresolved", source);
  const opt = (v: string, source: string): ParsedField => field(v || null, "confident", v ? source : "absent");
  const itemsLabel = labelNumber(raw, "السعر") ?? labelNumber(raw, "سعر");
  const writtenTotal = labelNumber(raw, "الاجمالي") ?? labelNumber(raw, "الإجمالي") ?? labelNumber(raw, "المجموع");
  const itemsTotal: ParsedField =
    itemsLabel != null
      ? field(parsed.itemsSubtotal, "confident", "label")
      : parsed.itemsSubtotal > 0
        ? field(parsed.itemsSubtotal, "ambiguous", "derived-from-total")
        : field(null, "unresolved", "absent");
  const finalTotal: ParsedField =
    writtenTotal != null
      ? field(parsed.totalAmount, parsed.totalMismatch ? "ambiguous" : "confident", parsed.totalMismatch ? "label-mismatch" : "label")
      : parsed.totalAmount > 0
        ? field(parsed.totalAmount, "ambiguous", "computed")
        : field(null, "unresolved", "absent");
  const fields: ParseResultV2["fields"] = {
    customerName: req(parsed.customerName, "label"),
    customerPhone: req(parsed.customerPhone, labelValue(raw, "رقم[^:：]*") ? "label" : "scan"),
    customerPhone2: opt(parsed.customerPhone2, "label"),
    governorate: req(parsed.governorate, "address-resolver"),
    city: opt(parsed.city, "address-resolver"),
    customerAddress: req(parsed.customerAddress, "label"),
    adName: opt(parsed.adName, "label"),
    pieces: parsed.quantityGiven ? field(parsed.quantity, "confident", "label") : field(null, "unresolved", "absent"),
    itemsTotal,
    shipping: labelNumber(raw, "الشحن") != null ? field(parsed.shipping, "confident", "label") : field(0, "confident", "default"),
    discount: labelNumber(raw, "الخصم") != null ? field(parsed.discount, "confident", "label") : field(0, "confident", "default"),
    finalTotal,
  };

  // ── السطور (حتمي) ──
  const { lines: drafts, prices } = draftLines(parsed, catalog);
  type Work = { term: string; color: string | null; size: string | null; quantity: number; fixed: number | null; match: ParsedLine["match"]; confidence: Confidence; reason: string | null; aiAssisted: boolean };
  const work: Work[] = drafts.map((l, i) => {
    const match = matchLine(l.term, l.color ?? null, l.size ?? null, catalog);
    const exact = l.term ? isExactCatalogTerm(l.term, catalog) : false;
    return {
      term: l.term, color: l.color ?? null, size: l.size ?? null, quantity: l.quantity, fixed: prices[i] ?? null,
      match,
      confidence: match ? (exact ? "confident" : "ambiguous") : "unresolved",
      reason: match ? (exact ? null : "تطابق تقريبي — راجع النوع") : l.term ? `«${l.term}» غير موجود في أنواع نشاطك — اختر النوع` : "اختر نوع النقش لهذه القطعة",
      aiAssisted: false,
    };
  });

  // ── AI للأجزاء غير المحلولة فقط (نص الجزء بس، لا حقول شخصية) ──
  let usedAi = false;
  const pending = work.filter(w => !w.match && w.term);
  if (opts.resolver && pending.length > 0) {
    const catalogTerms = Array.from(new Set(catalog.variants.filter(v => v.isActive !== false && v.name).map(v => v.name as string)));
    let out: Awaited<ReturnType<SegmentResolver>> = null;
    try {
      out = await opts.resolver(pending.map(p => p.term), catalogTerms);
    } catch (err) {
      console.warn("[orderParse:ai] resolver failed — continuing deterministic:", err instanceof Error ? err.message : err);
    }
    for (const seg of out ?? []) {
      const w = pending.find(p => normalizeArabic(p.term) === normalizeArabic(seg.segmentText) && !p.match);
      if (!w) continue;
      // السيرفر هو اللي بيطابق النص المقصود على كتالوج النشاط — نص مش في الكتالوج = يفضل غير محلول.
      const m = matchLine(seg.intendedText, null, null, catalog);
      if (!m) continue;
      w.match = m;
      w.confidence = "ambiguous";
      w.reason = `اقتراح آلي: «${seg.intendedText}» — راجع النوع`;
      w.aiAssisted = true;
      if (w.fixed == null && seg.unitPrice != null && seg.unitPrice > 0) w.fixed = seg.unitPrice;
      usedAi = true;
    }
  }

  // ── الأسعار: مذكور لكل نوع → message؛ الباقي يتوزّع بالقرش (قد يقسم آخر سطر) ──
  const itemsTotalValue = typeof itemsTotal.value === "number" && itemsTotal.value > 0 ? itemsTotal.value : null;
  const allocated = allocateLinePrices(work.map(w => ({ quantity: w.quantity, fixedUnitPrice: w.fixed })), itemsTotalValue);
  const lines: ParsedLine[] = (allocated ?? work.map((w, index) => ({ index, quantity: w.quantity, unitPrice: null as number | null, lineTotal: null as number | null, priceSource: null as ParsedLine["priceSource"] })))
    .map(a => {
      const w = work[a.index];
      return {
        segmentText: w.term || (w.color || w.size ? [w.color, w.size].filter(Boolean).join(" ") : ""),
        quantity: a.quantity,
        unitPrice: a.unitPrice,
        lineTotal: a.lineTotal,
        priceSource: a.priceSource ?? null,
        match: w.match,
        confidence: w.confidence,
        reason: w.reason,
        aiAssisted: w.aiAssisted,
      };
    });

  const unresolvedSegments = work
    .filter(w => !w.match)
    .map(w => ({ text: w.term, quantity: w.quantity, suggestions: w.term ? suggestionsFor(w.term, catalog) : [] }));

  return {
    parserVersion: PARSER_VERSION,
    parseSource: usedAi ? "mixed" : "deterministic",
    aiProvider: usedAi ? (opts.aiProvider ?? "unknown") : null,
    fields,
    lines,
    unresolvedSegments,
    allocationPolicy: ALLOCATION_POLICY,
  };
}

// ── النتيجة القانونية وبصمتها ──

/**
 * الموظف هو المراجع النهائي: أي سطر — حتمي واثق أو اقتراح AI — يقدر يغيّر نوعه لأي
 * تركيبة **مملوكة لنفس النشاط ونفس المنتج**. الأمان من فحص الملكية على السيرفر
 * (requireAllOwned + التركيبة تتبع منتجها)، مش من قفل القائمة. الاقتراح الأصلي بيفضل
 * مسجّلًا في النتيجة الموقّعة (parseResult) وفي audit كـsuggested/final + resolutionSource.
 */
export type ResolutionSource = "ai_accepted" | "deterministic_accepted" | "employee_corrected" | "employee_selected";

export function classifyResolution(
  suggested: { productId: number | null; variantId: number | null; aiAssisted: boolean },
  final: { productId: number | null; variantId: number | null }
): ResolutionSource {
  if (suggested.productId == null) return "employee_selected";
  const same = suggested.productId === final.productId && (suggested.variantId ?? null) === (final.variantId ?? null);
  if (!same) return "employee_corrected";
  return suggested.aiAssisted ? "ai_accepted" : "deterministic_accepted";
}

/** الجزء الملزِم من النتيجة (اللي التوكن بيوقّع عليه) — بلا الحقول الشخصية. */
export function canonicalParse(v2: ParseResultV2) {
  const f = v2.fields;
  return {
    parserVersion: v2.parserVersion,
    parseSource: v2.parseSource,
    totals: {
      pieces: f.pieces.value, itemsTotal: f.itemsTotal.value, shipping: f.shipping.value,
      discount: f.discount.value, finalTotal: f.finalTotal.value,
    },
    lines: v2.lines.map(l => ({
      segmentText: l.segmentText, quantity: l.quantity, unitPrice: l.unitPrice, priceSource: l.priceSource,
      productId: l.match?.productId ?? null, variantId: l.match?.variantId ?? null,
      confidence: l.confidence, aiAssisted: l.aiAssisted,
    })),
  };
}

/** بصمة النتيجة القانونية — أي تعديل في معرّف/كمية/سعر/إجمالي بيغيّرها. */
export function canonicalFingerprint(v2: ParseResultV2): string {
  return createHash("sha256").update(JSON.stringify(canonicalParse(v2)), "utf8").digest("hex");
}

// ── parse token: ربط الحفظ بالنص الملصوق **والنتيجة القانونية** (يمنع تعديل/حذف الـmetadata) ──

export function rawTextHash(rawText: string): string {
  return createHash("sha256").update(String(rawText ?? "").replace(/\r/g, ""), "utf8").digest("hex");
}

export interface ParseTokenPayload {
  employeeId: number;
  businessId: number;
  rawHash: string;
  /** بصمة النتيجة القانونية (canonicalFingerprint). */
  fp: string;
  iat: number;
}

/** صلاحية توكن التحليل: ساعتان بالميلي ثانية. */
export const PARSE_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

/** السر إلزامي من البيئة — مفيش قيمة افتراضية ولا fallback في الكود. */
function secret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET غير مضبوط — لا يمكن توقيع/التحقق من توكن التحليل");
  return s;
}

export function signParseToken(p: Omit<ParseTokenPayload, "iat"> & { iat?: number }): string {
  const body: ParseTokenPayload = { employeeId: p.employeeId, businessId: p.businessId, rawHash: p.rawHash, fp: p.fp, iat: p.iat ?? Date.now() };
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  const sig = createHmac("sha256", secret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export type ParseTokenFailure = "malformed" | "signature" | "identity" | "text" | "result" | "expired";

/**
 * يتحقق من التوقيع والموظف والنشاط والنص وبصمة النتيجة والصلاحية.
 * بيرجّع الحمولة أو سبب الفشل (للرسالة) — مش null مبهم.
 */
export function verifyParseToken(
  token: string,
  expect: { employeeId: number; businessId: number; rawText: string; fingerprint?: string; now?: number }
): { ok: true; payload: ParseTokenPayload } | { ok: false; reason: ParseTokenFailure } {
  const [payload, sig] = String(token ?? "").split(".");
  if (!payload || !sig) return { ok: false, reason: "malformed" };
  const good = createHmac("sha256", secret()).update(payload).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(good);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "signature" };
  let p: ParseTokenPayload;
  try {
    p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (p.employeeId !== expect.employeeId || p.businessId !== expect.businessId) return { ok: false, reason: "identity" };
  if (p.rawHash !== rawTextHash(expect.rawText)) return { ok: false, reason: "text" };
  if (expect.fingerprint != null && p.fp !== expect.fingerprint) return { ok: false, reason: "result" };
  const now = expect.now ?? Date.now();
  if (!Number.isFinite(p.iat) || now - p.iat > PARSE_TOKEN_TTL_MS) return { ok: false, reason: "expired" };
  return { ok: true, payload: p };
}

export const PARSE_TOKEN_MESSAGES: Record<ParseTokenFailure, string> = {
  malformed: "توكن التحليل غير صالح — أعد التحليل ثم احفظ",
  signature: "توكن التحليل غير صالح — أعد التحليل ثم احفظ",
  identity: "توكن التحليل لا يخص هذا الموظف/النشاط — أعد التحليل ثم احفظ",
  text: "الرسالة تغيّرت بعد التحليل — أعد التحليل ثم احفظ",
  result: "نتيجة التحليل تغيّرت في المتصفح — أعد التحليل ثم احفظ",
  expired: "انتهت صلاحية التحليل (ساعتان) — أعد التحليل ثم احفظ",
};

/**
 * السطور النهائية **مستقلة** عن نتيجة التحليل: التحليل اقتراح، والموظفة تقدر تضيف/تحذف/
 * تقسم/تدمج/تغيّر النوع والكمية والسعر. اللي بيتفحص هنا إن كل سطر ليه منتج (مفيش سطر
 * غير محلول وقت الحفظ)؛ الملكية والتبعية للمنتج والكميات والأسعار والإجماليات بتتفحص
 * بعد كده على السيرفر. **مفيش رفض بسبب عدد السطور أو ترتيبها.** بيرجّع رسالة المنع أو null.
 */
export function finalLinesBlocker(submitted: { productId?: number | null }[]): string | null {
  if (submitted.length === 0) return "أضف صنفًا واحدًا على الأقل";
  const missing = submitted.map((s, i) => (s.productId == null ? i + 1 : 0)).filter(Boolean);
  return missing.length ? `اختر نوع النقش للسطر رقم ${missing.join("، ")}` : null;
}

/**
 * تصنيف السطور النهائية مقابل اقتراح التحليل — للسجل بس (مش للمنع):
 *   • سطر نهائي بنفس (productId, variantId) لسطر مقترح لسه ماتستهلكش → ai_accepted أو
 *     deterministic_accepted؛ غير كده → employee_corrected (لو التحليل كان فيه اقتراحات)
 *     أو employee_selected (سطر جديد/بلا اقتراح).
 *   • `structurallyEdited` = العدد أو الأنواع أو الكميات اختلفت عن الاقتراح.
 */
export function classifyFinalLines(
  canonical: ReturnType<typeof canonicalParse>["lines"],
  final: { productId?: number | null; variantId?: number | null; quantity: number }[]
): { structurallyEdited: boolean; lines: { finalProductId: number | null; finalVariantId: number | null; suggestedProductId: number | null; suggestedVariantId: number | null; suggestedByAi: boolean; resolutionSource: ResolutionSource }[] } {
  const pool = canonical.map(c => ({ ...c, used: false }));
  const lines = final.map(f => {
    const hit = pool.find(c => !c.used && c.productId != null && c.productId === (f.productId ?? null) && (c.variantId ?? null) === (f.variantId ?? null));
    if (hit) {
      hit.used = true;
      return {
        finalProductId: f.productId ?? null, finalVariantId: f.variantId ?? null,
        suggestedProductId: hit.productId, suggestedVariantId: hit.variantId, suggestedByAi: hit.aiAssisted,
        resolutionSource: (hit.aiAssisted ? "ai_accepted" : "deterministic_accepted") as ResolutionSource,
      };
    }
    const anySuggestion = canonical.some(c => c.productId != null);
    return {
      finalProductId: f.productId ?? null, finalVariantId: f.variantId ?? null,
      suggestedProductId: null, suggestedVariantId: null, suggestedByAi: false,
      resolutionSource: (anySuggestion ? "employee_corrected" : "employee_selected") as ResolutionSource,
    };
  });
  const sameCount = canonical.length === final.length;
  const sameQty = sameCount && canonical.every((c, i) => c.quantity === final[i].quantity);
  const structurallyEdited = !sameCount || !sameQty || lines.some(l => l.resolutionSource === "employee_corrected" || l.resolutionSource === "employee_selected");
  return { structurallyEdited, lines };
}
