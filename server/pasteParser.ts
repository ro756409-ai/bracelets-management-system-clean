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
  /** رقم الهاتف التاني لو مذكور («رقم الفون(٢)») — منفصل عن العنوان. */
  customerPhone2: string;
  governorate: string;
  /** المدينة/المركز لو اتحدد من العنوان — منفصل عن المحافظة وعن العنوان الكامل. */
  city: string;
  customerAddress: string;
  productName: string;
  /** الأنواع المذكورة في سطر المنتج («عين حورس وذكر التحصين» → اتنين). */
  productTerms: string[];
  /**
   * أجزاء سطر المنتج بكمياتها: «٢ ساده، 1 نقش وعين حورس» →
   * [{ساده, 2}, {نقش وعين حورس, 1}]. الفصل هنا على الفواصل بس؛ فصل «و» بيحصل بعدين
   * **ضد الكتالوج** عشان مايكسرش اسم تركيبة مركّب فيه «و».
   */
  productSegments: ProductSegment[];
  /** أزواج اللون/المقاس بالترتيب («بيج مقاس 10 اسود مقاس 6» → اتنين). */
  colorSizePairs: ColorSize[];
  quantity: number;
  /** «عدد القطع» مكتوب صراحة؟ لو لأ، `quantity` قيمة افتراضية (1) مش رقم من العميل. */
  quantityGiven: boolean;
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
export function labelValue(text: string, label: string): string {
  const re = new RegExp(`(?:^|\\s)${label}${SEP}((?:(?!${NEXT_LABEL})[^\\n])*)`, "m");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

/** رقم من قيمة label — أول رقم فيها بس، مش كل الأرقام ملزوقة. */
export function labelNumber(text: string, label: string): number | null {
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

export interface ProductSegment {
  text: string;
  /** الكمية المكتوبة قبل/بعد الاسم («٢ ساده» / «ساده ×2»)، أو null لو مش مذكورة. */
  qty: number | null;
}

/**
 * يقسّم سطر المنتج على الفواصل (، , + ؛ «ثم») ويستخرج كمية كل جزء:
 *   «٢ ساده، 1 نقش وعين حورس» → [{ساده, 2}, {نقش وعين حورس, 1}]
 *   «ساده ×2» / «ساده x2» / «2x ساده» → {ساده, 2}
 *
 * **مابيفصلش على «و»** — ده بيحصل ضد كتالوج النشاط (`expandSegments`)، لأن «و» ممكن
 * تكون جزء من اسم تركيبة مركّب، وفصلها عشوائيًا بيطلّع أصنافًا مالهاش وجود.
 */
export function parseProductSegments(line: string): ProductSegment[] {
  const s = normalizeDigits(String(line ?? "")).trim();
  if (!s) return [];
  return s
    .split(/\s*[+،,؛;]\s*|\s+ثم\s+/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      let m = part.match(/^(\d+)\s*[x×*]?\s*(.+)$/);
      if (m && m[2].trim().length > 1) return { text: m[2].trim(), qty: Number(m[1]) };
      m = part.match(/^(.+?)\s*[x×*]\s*(\d+)$/);
      if (m) return { text: m[1].trim(), qty: Number(m[2]) };
      return { text: part, qty: null };
    })
    .filter(seg => seg.text.length > 1 && (seg.qty == null || seg.qty > 0));
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
export interface ColorSize {
  color: string;
  size: string;
}

/** كلمات ربط بين رقمين (نطاق «من 6 إلى 8») — مش لون. */
const RANGE_WORDS = /^(من|الى|إلى|لـ|ل|حتى|و|او|أو)$/;
/** كلمات بتسبق اللون من غير ما تكون جزء منه. */
const COLOR_NOISE = /^(?:ال)?(?:لون|الوان|ألوان)\s*/;

/**
 * يفصل سطر اللون/المقاس لـ**كل الأزواج** بالترتيب اللي اتكتبوا بيه:
 *   «بيج مقاس 10 اسود مقاس 6» → [بيج/10, اسود/6]
 *   «اسود مقاس 8 سنين»        → [اسود/8]
 *   «بيج (12 سنة)»            → [بيج/12]
 *   «بيج 10»                  → [بيج/10]
 *   «من 6 إلى 8»              → [/8]  (نطاق = الحد الأعلى، مش زوجين)
 *
 * الترتيب مهم: العميل بيكتب اللون وبعده مقاسه مباشرة، فالزوج الأول هو القطعة الأولى.
 * كانت القراءة القديمة بترجّع زوجًا واحدًا بس، فـ«بيج مقاس 10 اسود مقاس 6» كان بيبقى
 * لون «بيج» ومقاس 10 (أو max(10,6)) — والقطعة التانية بتضيع خالص.
 */
export function parseColorSizePairs(text: string): ColorSize[] {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const t = normalizeDigits(raw);

  const out: ColorSize[] = [];
  // كل «نص ثم رقم»: النص هو اللون (أو كلمة ربط) والرقم هو المقاس.
  const re = /([^\d]*?)(\d+)/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = re.exec(t)) !== null) {
    lastIndex = re.lastIndex;
    const label = cleanColor(m[1]).replace(COLOR_NOISE, "").trim();
    // «مقاس/الحجم» مجرد عنوان، مش لون.
    const color = label.replace(/(?:^|\s)(?:المقاسات|المقاس|مقاس|الحجم)\s*$/, "").trim();
    const size = m[2];
    if (RANGE_WORDS.test(color) || color === "") {
      const prev = out[out.length - 1];
      if (prev) {
        // نطاق: «من 6 إلى 8» → نوسّع مقاس آخر زوج للحد الأعلى بدل ما نعمل زوج جديد.
        prev.size = String(Math.max(Number(prev.size) || 0, Number(size) || 0));
        continue;
      }
      // أول رقم بلا لون قبله («من 6 …») — زوج بلا لون، والأرقام اللي بعده بتوسّعه.
      out.push({ color: "", size });
      continue;
    }
    out.push({ color, size });
  }

  // نص بلا أي أرقام = لون لوحده.
  if (out.length === 0) {
    const color = cleanColor(t).replace(COLOR_NOISE, "").trim();
    return color ? [{ color, size: "" }] : [];
  }
  // ذيل بعد آخر رقم فيه لون بلا مقاس («بيج 10 وأسود») — بيتسجّل بلا مقاس للمراجعة.
  const tail = cleanColor(t.slice(lastIndex)).replace(COLOR_NOISE, "").trim();
  if (tail && !RANGE_WORDS.test(tail) && !/^(سنه|سنين|سنة|عام|اعوام)$/.test(tail))
    out.push({ color: tail, size: "" });

  return out;
}

/** أول زوج لون/مقاس — للمسارات اللي لسه بتتعامل مع صنف واحد. */
export function splitColorSize(text: string): ColorSize {
  const pairs = parseColorSizePairs(text);
  if (pairs.length === 0) return { color: "", size: "" };
  return { color: pairs[0].color, size: normalizeSize(pairs[0].size) };
}

export function parsePasteMessage(raw: string): ParsedPaste {
  const text = String(raw ?? "").replace(/\r/g, "");

  // محدودة بالـlabel اللي بعدها: «بيدج:عتبة  التاريخ: 20/9» → «عتبة» مش السطر كله.
  const adName = labelValue(text, "بيدج");
  // «الاسم» أو «اسم العميل» — والقيمة محدودة بالـlabel اللي بعدها زي باقي الحقول.
  const customerName =
    labelValue(text, "اسم\\s*العميل") || labelValue(text, "الاسم");

  // الهواتف: كل «رقم الفون(1)» / «رقم الفون(٢)» / «رقم التواصل…» بالترتيب. الأول هو
  // الأساسي والتاني هو الإضافي — منفصلين عن العنوان. القيمة **على نفس السطر** بس
  // (مسافات وشرطات)، عشان رقم في السطر اللي بعده مايتلزقش.
  const phones: string[] = [];
  const phoneRe =
    /رقم\s*(?:ال)?(?:فون|تواصل|موبايل|محمول|تليفون|تلفون|هاتف)\s*(?:[\(（]\s*[0-9٠-٩۰-۹]*\s*[\)）])?\s*[:：]\s*([0-9٠-٩۰-۹ \t\-]+)/g;
  for (const m of text.matchAll(phoneRe)) {
    const n = normalizeDigits(m[1]).replace(/[^\d]/g, "");
    if (n && !phones.includes(n)) phones.push(n);
  }
  if (phones.length === 0) {
    for (const m of normalizeDigits(text).matchAll(/(?<!\d)(01\d{9})(?!\d)/g)) {
      if (!phones.includes(m[1])) phones.push(m[1]);
    }
  }
  const phone = phones[0] ?? "";
  const phone2 = phones[1] ?? "";

  // العنوان: كل السطور بعد «العنوان:» حتى أول حقل معروف تاني (أي «رقم ...»، نوع المنتج، ...).
  const addrM = text.match(
    // «رقم» بتتقفل بمسافة أو قوس مش بـ`\b`: الـ`\b` في JS بتفهم حروف ASCII بس، فكانت
    // مابتقفش عند «رقم الفون» العربية والعنوان بيبلع سطور الهاتف كلها.
    /العنوان\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:رقم(?=[\s(（])|الهاتف|الموبايل|نوع\s*المنتج|عدد\s*القطع|اللون|المقاس|الحجم|السعر|الشحن|الخصم|الاجمالي|الإجمالي|التاريخ|بيدج|الاسم|اسم\s*العميل)|$)/
  );
  const addressBlock = addrM ? addrM[1].trim() : "";
  const { governorate, city } = extractLocation(addressBlock);
  // العنوان التفصيلي = كل السطور مجمّعة (بما فيها سطر «الموشي ...»).
  const customerAddress = addressBlock
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .join("، ");

  // محدود بالـlabel اللي بعده: «نوع المنتج : … عدد القطع: 4» ماياخدش «عدد القطع».
  const productName = labelValue(text, "نوع\\s*المنتج");
  const productSegments = parseProductSegments(productName);
  // التوافق: الأنواع بلا كميات (بتفصل «و» كمان) للمسارات اللي لسه بتستخدمها.
  const productTerms = productSegments.flatMap(seg => splitProductTerms(seg.text));

  let quantity = 1;
  let quantityGiven = false;
  for (const l of ["عدد\\s*القطع", "الكمية", "العدد"]) {
    const n = labelNumber(text, l);
    if (n != null && n >= 1) { quantity = Math.floor(n); quantityGiven = true; break; }
  }

  const colorLine = firstLineValue(text, /اللون\s*[:：]\s*([^\n]+)/);
  const rawPairs = parseColorSizePairs(colorLine);
  const colorSizePairs = rawPairs.map(p => ({ color: p.color, size: normalizeSize(p.size) }));
  let color = colorSizePairs[0]?.color ?? "";
  let size = colorSizePairs[0]?.size ?? "";
  // المقاس ممكن ييجي في سطر مستقل «المقاس: ...» — لو ماطلعش من سطر اللون.
  if (!size) {
    const sizeLine = firstLineValue(text, /(?:المقاس|الحجم|المقاسات)\s*[:：]\s*([^\n]+)/);
    if (sizeLine) {
      size = normalizeSize(sizeLine);
      if (colorSizePairs[0]) colorSizePairs[0].size = size;
    }
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
    adName, customerName, customerPhone: phone, customerPhone2: phone2,
    governorate, city, customerAddress,
    productName, productTerms, productSegments, colorSizePairs,
    quantity, quantityGiven, color, size,
    itemsSubtotal: subtotal, discount, shipping, totalAmount, totalMismatch,
  };
}
