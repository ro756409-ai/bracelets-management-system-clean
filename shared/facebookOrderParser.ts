/**
 * Facebook order paste parser.
 *
 * A facebook_entry employee pastes a raw customer message; this turns it into a REVIEW
 * DRAFT — never a submitted order. Two rules drive the whole design:
 *
 *   1. Never invent data. A field that isn't clearly present stays undefined, with a
 *      confidence of "missing", so the UI can highlight it for the human.
 *   2. Never guess a product. Ambiguous variant text returns candidate suggestions that
 *      require manual confirmation; unknown text becomes an "unmatched" item. Nothing is
 *      silently attached to an arbitrary product, and no product/variant is ever created.
 *
 * Pure and dependency-free (aside from the shared matcher types) so it is fully unit
 * testable and runs identically on server and client.
 */

import { GOVERNORATE_NAMES } from "./egyptLocations";

export type FieldConfidence = "high" | "medium" | "low" | "missing";

export interface ParsedField<T> {
  value?: T;
  confidence: FieldConfidence;
  /** Why the parser believes this — shown to the employee on hover. */
  evidence?: string;
}

export interface ParsedItemMatch {
  id: number;
  name: string;
}

export interface ParsedOrderItem {
  /** The raw phrase this item came from, always preserved for the reviewer. */
  rawText: string;
  quantity: number;
  /** How the quantity was expressed, e.g. "قطعتين" → 2. */
  quantityEvidence: string;
  status: "matched" | "ambiguous" | "unmatched";
  productId?: number;
  productName?: string;
  variantId?: number;
  variantName?: string;
  unitPrice?: string | null;
  /** Populated when status is "ambiguous" — the employee must pick one. */
  candidates?: ParsedItemMatch[];
}

export interface ParsedOrder {
  customerName: ParsedField<string>;
  phone: ParsedField<string>;
  governorate: ParsedField<string>;
  city: ParsedField<string>;
  address: ParsedField<string>;
  items: ParsedOrderItem[];
  totalQuantity: number;
  orderTotal: ParsedField<number>;
  shipping: ParsedField<number>;
  adName: ParsedField<string>;
  notes: ParsedField<string>;
  /** 0–100. A blunt readiness signal, not a probability. */
  overallConfidence: number;
  /** Field keys the UI should highlight because they need human attention. */
  needsAttention: string[];
  /** Verbatim pasted text, stored on the order for audit. */
  rawText: string;
}

// ==================== Catalog shape (mirrors server/productMatching.ts) ====================
export interface ParserProduct {
  id: number;
  name: string;
  sku: string | null;
  price: string | null;
}
export interface ParserVariant {
  id: number;
  productId: number;
  name: string | null;
  sku: string | null;
  price: string | null;
  isActive?: boolean;
}
export interface ParserCatalog {
  products: ParserProduct[];
  variants: ParserVariant[];
}

/** Extra spellings seen in real Facebook messages that don't normalize onto a variant name. */
export const VARIANT_ALIASES: Record<string, string[]> = {
  "آية الكرسي": ["ايه الكرسي", "اية الكرسى", "الكرسي", "ايت الكرسي"],
  "عين حورس": ["عين حور", "عين الحورس", "حورس"],
  "ذكر التحصين": ["التحصين", "ذكر التحصن", "تحصين"],
  "فالله خير حافظاً": ["فالله خير حافظا", "خير حافظا", "فالله خير"],
  "إنه من سليمان": ["انه من سليمان", "آية من سليمان", "اية من سليمان", "من سليمان", "سليمان"],
  "كهيعص": ["كيهيعص", "كهيعص"],
  "قل أعوذ برب الفلق": ["قل اعوذ برب الفلق", "الفلق", "برب الفلق"],
  "منقوش": ["منقوشه", "منقوشة", "نقش"],
  "سادة": ["ساده", "سادا"],
};

// ==================== Text normalization ====================
export function toEnglishDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660)) // Arabic-Indic
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0)); // Extended Arabic-Indic
}

export function normalizeArabic(text: string): string {
  return text
    .replace(/[ً-ْٰ]/g, "")
    .replace(/ـ/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ==================== Arabic quantity words ====================
const ARABIC_NUMBER_WORDS: Record<string, number> = {
  "واحد": 1, "واحده": 1, "وحده": 1, "قطعه": 1, "حته": 1,
  "اتنين": 2, "اثنين": 2, "اتنان": 2, "قطعتين": 2, "حتتين": 2, "زوج": 2,
  "ثلاثه": 3, "تلاته": 3, "تلات": 3, "ثلاث": 3,
  "اربعه": 4, "اربع": 4, "أربعة": 4,
  "خمسه": 5, "خمس": 5,
  "سته": 6, "ست": 6,
  "سبعه": 7, "سبع": 7,
  "تمانيه": 8, "ثمانيه": 8, "تمن": 8,
  "تسعه": 9, "تسع": 9,
  "عشره": 10, "عشر": 10,
};

/** Resolves an Arabic quantity word (already normalized) to a number, or null. */
export function arabicWordToNumber(word: string): number | null {
  const n = normalizeArabic(word);
  return ARABIC_NUMBER_WORDS[n] ?? null;
}

/**
 * Turns a word into a regex fragment tolerant of Arabic orthographic variants, so a pattern
 * built from the normalized key "واحده" also matches the real-world spelling "واحدة".
 */
function tolerantArabicPattern(word: string): string {
  return word
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/[هة]/g, "[هة]")
    .replace(/[اأإآٱ]/g, "[اأإآٱ]")
    .replace(/[يى]/g, "[يى]");
}

// NOTE: JS \b word boundaries are useless here — Arabic letters are not \w, so \b never
// matches between them. All boundary handling below is done with explicit separators.
const QTY_WORD_PATTERN = Object.keys(ARABIC_NUMBER_WORDS)
  .sort((a, b) => b.length - a.length) // longest first so "قطعتين" wins over "قطعه"
  .map(tolerantArabicPattern)
  .join("|");

/** Conversational lead-ins that precede the real order text ("عايزة 2 عين حورس"). */
const FILLER_PREFIX_RE = /^(?:و\s*)?(?:يا\s+)?(?:ريت\s+|لو\s+سمحت\s+|من\s+فضلك\s+)?(?:انا\s+|أنا\s+)?(?:عايز[ةه]?|عاوز[ةه]?|اريد|أريد|محتاج[ةه]?|هاخد|ها?خد|ابغى|ممكن)\s+/;

// ==================== Governorates ====================
/**
 * Re-exported from shared/egyptLocations.ts so the parser and the confirmation
 * employee's dropdown cannot drift apart: a governorate this parser writes into
 * `orders.governorate` must be selectable in the edit modal, or the order opens with
 * a blank governorate and the employee has to retype what the parser already knew.
 */
export const GOVERNORATES: readonly string[] = GOVERNORATE_NAMES;

const GOVERNORATE_ALIASES: Record<string, string> = {
  "قاهره": "القاهرة", "مصر الجديده": "القاهرة", "مدينه نصر": "القاهرة", "المعادي": "القاهرة",
  "حلوان": "القاهرة", "شبرا": "القاهرة", "عين شمس": "القاهرة", "المطريه": "القاهرة",
  "جيزه": "الجيزة", "فيصل": "الجيزة", "الهرم": "الجيزة", "اكتوبر": "الجيزة", "6 اكتوبر": "الجيزة",
  "اسكندريه": "الإسكندرية", "اسكندريا": "الإسكندرية",
  "منصوره": "الدقهلية", "المنصوره": "الدقهلية", "ميت غمر": "الدقهلية",
  "زقازيق": "الشرقية", "الزقازيق": "الشرقية", "بلبيس": "الشرقية",
  "بنها": "القليوبية", "شبرا الخيمه": "القليوبية", "قليوب": "القليوبية",
  "طنطا": "الغربية", "المحله": "الغربية", "المحله الكبري": "الغربية",
  "شبين الكوم": "المنوفية", "منوف": "المنوفية",
  "دمنهور": "البحيرة", "كفر الدوار": "البحيرة",
  "اسيوط": "أسيوط", "اسوان": "أسوان", "الاقصر": "الأقصر", "بني سويف": "بني سويف",
  "الغردقه": "البحر الأحمر", "الغردقة": "البحر الأحمر", "شرم الشيخ": "جنوب سيناء",
  "العريش": "شمال سيناء", "مرسي مطروح": "مطروح",
};

/** Finds a governorate mentioned anywhere in the text; returns the canonical name. */
export function detectGovernorate(text: string): { gov: string; matched: string } | null {
  const norm = normalizeArabic(text);
  for (const gov of GOVERNORATES) {
    if (norm.includes(normalizeArabic(gov))) return { gov, matched: gov };
  }
  for (const [alias, gov] of Object.entries(GOVERNORATE_ALIASES)) {
    if (norm.includes(normalizeArabic(alias))) return { gov, matched: alias };
  }
  return null;
}

// ==================== Field extraction ====================
const EGYPT_PHONE_RE = /(?:\+?2)?0?1[0125]\d{8}/;
const LOOSE_DIGITS_RE = /\d{7,}/;

export function extractPhone(text: string): ParsedField<string> {
  const t = toEnglishDigits(text);

  const labelled = t.match(/(?:رقم|تليفون|تلفون|موبايل|فون|هاتف|ت)\s*[:\-]?\s*((?:\+?2)?0?1[0125]\d{8})/);
  if (labelled) {
    return { value: normalizePhone(labelled[1]), confidence: "high", evidence: "رقم بصيغة مصرية صحيحة بعد كلمة دالة" };
  }
  const bare = t.match(EGYPT_PHONE_RE);
  if (bare) {
    return { value: normalizePhone(bare[0]), confidence: "high", evidence: "رقم بصيغة مصرية صحيحة" };
  }
  // Digits that look like a phone but aren't valid — surface for correction, never "fix".
  const loose = t.match(LOOSE_DIGITS_RE);
  if (loose) {
    return { value: loose[0], confidence: "low", evidence: "رقم غير مكتمل أو بصيغة غير مصرية — يحتاج مراجعة" };
  }
  return { confidence: "missing" };
}

function normalizePhone(raw: string): string {
  let p = raw.replace(/\D/g, "");
  if (p.startsWith("2") && p.length === 12) p = p.slice(1);
  if (!p.startsWith("0")) p = "0" + p;
  return p;
}

/** Lines that are clearly not a name (contain digits, product words, money words). */
function looksLikeNameLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length < 3 || t.length > 60) return false;
  if (/\d/.test(toEnglishDigits(t))) return false;
  const norm = normalizeArabic(t);
  const banned = [
    "اسوره", "اسورة", "الاجمالي", "الشحن", "العنوان", "محافظه", "عايز", "عاوز",
    "اريد", "من فضلك", "شكرا", "ملاحظات", "بيدج",
    // greetings / pleasantries that commonly open a message
    "السلام عليكم", "وعليكم السلام", "صباح الخير", "مساء الخير", "ازيك", "ازيكم",
    "اهلا", "مرحبا", "حضرتك", "لو سمحت", "تمام", "ok",
  ];
  if (banned.some(b => norm.includes(normalizeArabic(b)))) return false;
  if (detectGovernorate(t)) return false;
  return /[؀-ۿ]/.test(t);
}

export function extractName(text: string): ParsedField<string> {
  const labelled = text.match(/(?:الاسم|اسم العميل|اسم)\s*[:\-]\s*([^\n\r]+)/);
  if (labelled) {
    const v = labelled[1].trim();
    if (v) return { value: v, confidence: "high", evidence: "بعد كلمة «الاسم»" };
  }
  // Otherwise the first line that plausibly reads as a person's name.
  const lines = text.split(/[\n\r]+/);
  for (const line of lines) {
    const cleaned = line.replace(EGYPT_PHONE_RE, "").trim();
    if (looksLikeNameLine(cleaned)) {
      return { value: cleaned, confidence: "medium", evidence: "أول سطر يشبه اسم شخص" };
    }
  }
  return { confidence: "missing" };
}

export function extractMoney(text: string, kind: "total" | "shipping"): ParsedField<number> {
  const t = toEnglishDigits(text);
  const labels = kind === "total"
    ? ["الاجمالي", "الإجمالي", "الاجمالى", "المجموع", "الحساب", "التوتال"]
    : ["الشحن", "شحن", "التوصيل", "المواصلات"];
  for (const label of labels) {
    const re = new RegExp(`${label}\\s*[:\\-]?\\s*(\\d+(?:\\.\\d+)?)`);
    const m = t.match(re);
    if (m) {
      return { value: Number(m[1]), confidence: "high", evidence: `بعد كلمة «${label}»` };
    }
  }
  return { confidence: "missing" };
}

export function extractAdName(text: string): ParsedField<string> {
  const m = text.match(/(?:بيدج|البيدج|الحمله|الحملة|اعلان|الاعلان|كامبين)\s*[:\-]?\s*([^\n\r]+)/);
  if (m) {
    const v = m[1].trim().replace(/التاريخ.*$/i, "").trim();
    if (v) return { value: v, confidence: "medium", evidence: "بعد كلمة دالة على الحملة/البيدج" };
  }
  return { confidence: "missing" };
}

export function extractAddress(text: string, governorate?: string): { address: ParsedField<string>; city: ParsedField<string> } {
  const labelled = text.match(/(?:العنوان|عنوان)\s*[:\-]\s*([^\n\r]+)/);
  let addressLine: string | undefined;
  let confidence: FieldConfidence = "missing";
  let evidence: string | undefined;

  if (labelled) {
    addressLine = labelled[1].trim();
    confidence = "high";
    evidence = "بعد كلمة «العنوان»";
  } else if (governorate) {
    // The line naming the governorate usually carries the address too.
    const line = text.split(/[\n\r]+/).find(l => detectGovernorate(l)?.gov === governorate);
    if (line) {
      addressLine = line.trim();
      confidence = "medium";
      evidence = "السطر الذي يحتوي المحافظة";
    }
  }

  if (!addressLine) {
    return { address: { confidence: "missing" }, city: { confidence: "missing" } };
  }

  // City/area = the address with the governorate token removed.
  let city: ParsedField<string> = { confidence: "missing" };
  if (governorate) {
    const stripped = addressLine
      .replace(new RegExp(governorate, "g"), "")
      .replace(/^[\s\-،,•·]+|[\s\-،,•·]+$/g, "")
      .trim();
    if (stripped && stripped !== addressLine) {
      city = { value: stripped, confidence: "medium", evidence: "الجزء المتبقي بعد إزالة اسم المحافظة" };
    }
  }

  return { address: { value: addressLine, confidence, evidence }, city };
}

// ==================== Item / quantity parsing ====================
/**
 * Splits the message into candidate "quantity + product" phrases.
 * Handles: "2 آية الكرسي و1 عين حورس", "قطعتين آية الكرسي",
 * "3 عين حورس وواحدة ذكر التحصين", and line-per-item lists.
 */
export function extractItemPhrases(text: string): { rawText: string; quantity: number; quantityEvidence: string }[] {
  const t = toEnglishDigits(text);

  // Split into one segment per item. The conjunction "و" acts as a separator only when it
  // introduces another quantity ("... و1 عين حورس", "... وواحدة ذكر التحصين") — otherwise it
  // is part of a product name (e.g. "كفر مرتبة ووتر بروف") and must be left alone.
  const qtyStart = `(?:\\d+|${QTY_WORD_PATTERN})`;
  const segments = t
    .replace(new RegExp(`\\s+و\\s*(?=${qtyStart}\\s)`, "g"), "\n")
    .split(/[\n\r]+|[,،؛;]+|\s\+\s/)
    .map(s => s.trim())
    .filter(Boolean);

  const phrases: { rawText: string; quantity: number; quantityEvidence: string }[] = [];

  for (const raw of segments) {
    // Skip lines that are clearly not items (address/money/phone lines).
    if (/^(?:الاجمالي|الإجمالي|المجموع|الشحن|العنوان|الاسم|ملاحظات|بيدج)/.test(raw)) continue;

    // Drop a conversational lead-in so the quantity lands at the start of the segment.
    const segment = raw.replace(FILLER_PREFIX_RE, "").trim();
    if (!segment) continue;

    // "اسم المنتج ×3"
    const mult = segment.match(/^(.+?)\s*[×xX*]\s*(\d+)\s*$/);
    if (mult) {
      const name = cleanItemName(mult[1]);
      if (name) pushPhrase(name, Math.max(1, parseInt(mult[2], 10)), `×${mult[2]}`);
      continue;
    }

    // Leading digit: "2 آية الكرسي" (optionally "2 قطع آية الكرسي")
    const digitLead = segment.match(/^(\d+)\s*(?:قطع[ةه]?|قطعتين|اسور[ةه]|أسور[ةه]|اساور|أساور)?\s*(.+)$/);
    if (digitLead) {
      const name = cleanItemName(digitLead[2]);
      const qty = Math.max(1, parseInt(digitLead[1], 10));
      // A bare count with no product after it ("أريد 4 أساور:") is a summary, not an item.
      if (name && hasArabicLetters(name)) pushPhrase(name, qty, `رقم ${digitLead[1]}`);
      continue;
    }

    // Leading Arabic quantity word: "قطعتين آية الكرسي" / "واحدة ذكر التحصين"
    const wordLead = segment.match(new RegExp(`^(${QTY_WORD_PATTERN})\\s+(?:من\\s+)?(?:قطع[ةه]?\\s+)?(.+)$`));
    if (wordLead) {
      const qty = arabicWordToNumber(wordLead[1]);
      const name = cleanItemName(wordLead[2]);
      if (qty && name && hasArabicLetters(name)) pushPhrase(name, qty, `كلمة «${wordLead[1]}»`);
      continue;
    }
  }

  return phrases;

  function pushPhrase(rawText: string, quantity: number, quantityEvidence: string) {
    const key = normalizeArabic(rawText);
    if (!key) return;
    // Same product named twice in one message → keep the first reading, don't double-count.
    if (phrases.some(p => normalizeArabic(p.rawText) === key)) return;
    phrases.push({ rawText, quantity, quantityEvidence });
  }
}

function hasArabicLetters(s: string): boolean {
  return /[؀-ۿ]/.test(s);
}

/** Strips filler words that cling to a product phrase. */
function cleanItemName(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^(?:و|من|اسور[هة]|اساور|قطع[هة]|عايز|عاوز|اريد|أريد)\s+/g, "");
  s = s.replace(/\s+(?:و|من فضلك|لو سمحت|شكرا|بس)$/g, "");
  s = s.replace(/[:،,.]+$/g, "");
  return s.trim();
}

/** Matches one phrase against the live catalog. Ambiguity and misses are reported, never guessed. */
export function matchItem(phrase: string, catalog: ParserCatalog): Omit<ParsedOrderItem, "rawText" | "quantity" | "quantityEvidence"> {
  const activeVariants = catalog.variants.filter(v => v.isActive !== false);
  const productById = new Map(catalog.products.map(p => [p.id, p]));
  const target = normalizeArabic(phrase);
  if (!target) return { status: "unmatched" };

  // 1. exact SKU
  const skuHit = [...activeVariants].find(v => v.sku && v.sku.trim().toLowerCase() === phrase.trim().toLowerCase());
  if (skuHit) {
    const parent = productById.get(skuHit.productId);
    if (parent) return okVariant(parent, skuHit);
  }
  const prodSkuHit = catalog.products.find(p => p.sku && p.sku.trim().toLowerCase() === phrase.trim().toLowerCase());
  if (prodSkuHit) {
    return { status: "matched", productId: prodSkuHit.id, productName: prodSkuHit.name, unitPrice: prodSkuHit.price };
  }

  // 2. exact normalized variant name
  const exact = activeVariants.filter(v => v.name && normalizeArabic(v.name) === target);
  if (exact.length === 1) {
    const parent = productById.get(exact[0].productId);
    if (parent) return okVariant(parent, exact[0]);
  }
  if (exact.length > 1) return ambiguous(exact);

  // 3. known aliases
  for (const [canonical, aliases] of Object.entries(VARIANT_ALIASES)) {
    if (aliases.some(a => normalizeArabic(a) === target)) {
      const hit = activeVariants.filter(v => v.name && normalizeArabic(v.name) === normalizeArabic(canonical));
      if (hit.length === 1) {
        const parent = productById.get(hit[0].productId);
        if (parent) return okVariant(parent, hit[0]);
      }
    }
  }

  // 4. exact standalone product name
  const exactProduct = catalog.products.filter(p => normalizeArabic(p.name) === target);
  if (exactProduct.length === 1) {
    return { status: "matched", productId: exactProduct[0].id, productName: exactProduct[0].name, unitPrice: exactProduct[0].price };
  }

  // 5. fuzzy containment — LAST resort, and only when it resolves to exactly one candidate
  const fuzzyVariants = activeVariants.filter(v => {
    if (!v.name) return false;
    const n = normalizeArabic(v.name);
    return n.includes(target) || target.includes(n);
  });
  const fuzzyAliases = activeVariants.filter(v => {
    if (!v.name) return false;
    const aliases = VARIANT_ALIASES[v.name] ?? [];
    return aliases.some(a => {
      const n = normalizeArabic(a);
      return n.includes(target) || target.includes(n);
    });
  });
  const fuzzy = Array.from(new Set([...fuzzyVariants, ...fuzzyAliases]));
  if (fuzzy.length === 1) {
    const parent = productById.get(fuzzy[0].productId);
    if (parent) return okVariant(parent, fuzzy[0]);
  }
  if (fuzzy.length > 1) return ambiguous(fuzzy);

  const fuzzyProducts = catalog.products.filter(p => {
    const n = normalizeArabic(p.name);
    return n.includes(target) || target.includes(n);
  });
  if (fuzzyProducts.length === 1) {
    return { status: "matched", productId: fuzzyProducts[0].id, productName: fuzzyProducts[0].name, unitPrice: fuzzyProducts[0].price };
  }
  if (fuzzyProducts.length > 1) {
    return { status: "ambiguous", candidates: fuzzyProducts.map(p => ({ id: p.id, name: p.name })) };
  }

  return { status: "unmatched" };

  function okVariant(parent: ParserProduct, v: ParserVariant): Omit<ParsedOrderItem, "rawText" | "quantity" | "quantityEvidence"> {
    return {
      status: "matched",
      productId: parent.id,
      productName: parent.name,
      variantId: v.id,
      variantName: v.name ?? undefined,
      unitPrice: v.price ?? parent.price,
    };
  }
  function ambiguous(vs: ParserVariant[]): Omit<ParsedOrderItem, "rawText" | "quantity" | "quantityEvidence"> {
    return { status: "ambiguous", candidates: vs.map(v => ({ id: v.id, name: v.name ?? `#${v.id}` })) };
  }
}

// ==================== Main entry point ====================
export function parseFacebookOrder(text: string, catalog: ParserCatalog): ParsedOrder {
  const rawText = text;

  const phone = extractPhone(text);
  const govHit = detectGovernorate(text);
  const governorate: ParsedField<string> = govHit
    ? { value: govHit.gov, confidence: govHit.matched === govHit.gov ? "high" : "medium", evidence: `مطابقة على «${govHit.matched}»` }
    : { confidence: "missing" };

  const { address, city } = extractAddress(text, governorate.value);
  const customerName = extractName(text);
  const orderTotal = extractMoney(text, "total");
  const shipping = extractMoney(text, "shipping");
  const adName = extractAdName(text);

  const phrases = extractItemPhrases(text);
  const items: ParsedOrderItem[] = phrases.map(p => ({
    rawText: p.rawText,
    quantity: p.quantity,
    quantityEvidence: p.quantityEvidence,
    ...matchItem(p.rawText, catalog),
  }));

  const totalQuantity = items.reduce((s, i) => s + i.quantity, 0);

  // Anything a human must look at before this can be saved.
  const needsAttention: string[] = [];
  if (customerName.confidence === "missing" || customerName.confidence === "low") needsAttention.push("customerName");
  if (phone.confidence !== "high") needsAttention.push("phone");
  if (governorate.confidence === "missing") needsAttention.push("governorate");
  if (address.confidence === "missing") needsAttention.push("address");
  if (orderTotal.confidence === "missing") needsAttention.push("orderTotal");
  if (items.length === 0) needsAttention.push("items");
  if (items.some(i => i.status !== "matched")) needsAttention.push("items");

  const overallConfidence = computeConfidence({ customerName, phone, governorate, address, orderTotal, items });

  return {
    customerName, phone, governorate, city, address,
    items, totalQuantity, orderTotal, shipping, adName,
    notes: extractNotes(text),
    overallConfidence,
    needsAttention: Array.from(new Set(needsAttention)),
    rawText,
  };
}

function extractNotes(text: string): ParsedField<string> {
  const m = text.match(/(?:ملاحظات|ملاحظه|ملحوظه|note[s]?)\s*[:\-]\s*([^\n\r]+)/i);
  if (m && m[1].trim()) {
    return { value: m[1].trim(), confidence: "high", evidence: "بعد كلمة «ملاحظات»" };
  }
  return { confidence: "missing" };
}

const CONFIDENCE_WEIGHT: Record<FieldConfidence, number> = { high: 1, medium: 0.7, low: 0.3, missing: 0 };

function computeConfidence(f: {
  customerName: ParsedField<string>;
  phone: ParsedField<string>;
  governorate: ParsedField<string>;
  address: ParsedField<string>;
  orderTotal: ParsedField<number>;
  items: ParsedOrderItem[];
}): number {
  // Phone and items carry the most weight — an order is useless without them.
  const parts: Array<[number, number]> = [
    [CONFIDENCE_WEIGHT[f.phone.confidence], 3],
    [f.items.length === 0 ? 0 : f.items.filter(i => i.status === "matched").length / f.items.length, 3],
    [CONFIDENCE_WEIGHT[f.customerName.confidence], 2],
    [CONFIDENCE_WEIGHT[f.governorate.confidence], 1],
    [CONFIDENCE_WEIGHT[f.address.confidence], 1],
    [CONFIDENCE_WEIGHT[f.orderTotal.confidence], 1],
  ];
  const totalWeight = parts.reduce((s, [, w]) => s + w, 0);
  const score = parts.reduce((s, [v, w]) => s + v * w, 0);
  return Math.round((score / totalWeight) * 100);
}
