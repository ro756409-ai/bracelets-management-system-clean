/**
 * سطور الأوردر من رسالة ملصوقة — **بناء حتمي، بلا تخمين**.
 *
 * الرسالة بتقول «عدد القطع: 2» و«نوع المنتج: عين حورس وذكر التحصين». اللي كان بيحصل
 * إن كل ده بيتحوّل لسطر واحد بكمية 1: النوع التاني بيضيع، والكمية بتتقص. هنا بنبني
 * سطرًا لكل نوع مذكور، وبنكمّل بسطور ناقصة لو عدد القطع أكبر من الأنواع.
 *
 * الملف مالوش أي اعتماد على قاعدة بيانات ولا React عن قصد — القواعد دي بتتنفّذ في
 * الواجهة وبتتختبر من غير متصفح ولا سيرفر.
 */

export interface DraftLine {
  /** النص اللي الرسالة ذكرته لهذا السطر (نوع/منتج) — للعرض والمطابقة اليدوية. */
  term: string;
  quantity: number;
  /** مفيش منتج/تركيبة محسومة — الموظف لازم يختار قبل الحفظ. */
  needsPick: boolean;
}

/**
 * يوزّع `quantity` قطعة على الأنواع المذكورة.
 *
 *   • أنواع = 0 → سطر واحد ناقص بكل الكمية («لم يتم التعرف على المنتج»).
 *   • أنواع = 1 → سطر واحد بكل الكمية (قطعتان من نفس النوع = كمية 2، مش سطرين).
 *   • أنواع = عدد القطع → سطر لكل نوع بكمية 1.
 *   • أنواع < عدد القطع → سطر لكل نوع بكمية 1، **وسطور ناقصة للباقي** عشان الموظف
 *     يحدّد نوع كل قطعة فاضلة بدل ما نوزّع بالتخمين.
 *   • أنواع > عدد القطع → سطر لكل نوع بكمية 1 (الكمية المكتوبة أقل من الواقع).
 */
export function buildDraftLines(terms: string[], quantity: number): DraftLine[] {
  const qty = Math.max(1, Math.floor(quantity) || 1);
  const clean = terms.map(t => t.trim()).filter(Boolean);

  if (clean.length === 0) return [{ term: "", quantity: qty, needsPick: true }];
  if (clean.length === 1) return [{ term: clean[0], quantity: qty, needsPick: true }];

  const lines: DraftLine[] = clean.map(term => ({ term, quantity: 1, needsPick: true }));
  for (let i = clean.length; i < qty; i++) {
    lines.push({ term: "", quantity: 1, needsPick: true });
  }
  return lines;
}

/**
 * يوزّع إجمالي الأصناف المعتمد على القطع بالقرش، **ومجموع الناتج يساوي الإجمالي
 * بالظبط**: الباقي من القسمة بيروح لآخر سطر.
 *
 * النشاط ممكن يكون عنده عرض كمية (قطعتان بـ400 بدل 220×2)، فـ«سعر الوحدة × الكمية»
 * مش دايمًا صحيح. الجدول محتاج `unitPrice` لكل سطر، فبنوزّع الإجمالي اللي الموظف
 * اعتمده بدل ما نغيّره — وسعر الكتالوج مابيتلمسش.
 *
 * بيرجّع سعر الوحدة لكل سطر (بالجنيه، منازل عشرية محدودة) وبواقي القروش في الأخير.
 */
export function distributeSubtotal(
  quantities: number[],
  subtotal: number
): { unitPrices: number[]; lineTotals: number[] } {
  const qs = quantities.map(q => Math.max(1, Math.floor(q) || 1));
  const units = qs.reduce((s, q) => s + q, 0);
  const totalPiastres = Math.round((Number(subtotal) || 0) * 100);
  if (units === 0) return { unitPrices: [], lineTotals: [] };

  const perPiece = Math.floor(totalPiastres / units);
  const lineTotals: number[] = [];
  let used = 0;
  for (let i = 0; i < qs.length; i++) {
    const isLast = i === qs.length - 1;
    // آخر سطر بياخد الباقي كله — فالمجموع بيساوي الإجمالي بالقرش بالظبط.
    const cents = isLast ? totalPiastres - used : perPiece * qs[i];
    used += cents;
    lineTotals.push(cents / 100);
  }
  const unitPrices = lineTotals.map((t, i) => t / qs[i]);
  return { unitPrices, lineTotals };
}

// ── ملخّص السلة وأسباب منع الحفظ ──

export interface CartLine {
  productId?: number | null;
  quantity: number;
  unitPrice: number;
  needsPick?: boolean;
  needsVariantReview?: boolean;
}

export interface CartSummary {
  pieces: number;
  itemsSubtotal: number;
  shipping: number;
  discount: number;
  total: number;
}

const money = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export function summarizeCart(
  lines: CartLine[],
  shipping: number,
  discount: number
): CartSummary {
  const pieces = lines.reduce((s, l) => s + (Math.max(1, Math.floor(l.quantity) || 1)), 0);
  const itemsSubtotal = money(
    lines.reduce((s, l) => s + (Number(l.unitPrice) || 0) * (Number(l.quantity) || 0), 0)
  );
  const ship = money(shipping);
  const disc = money(discount);
  return { pieces, itemsSubtotal, shipping: ship, discount: disc, total: money(itemsSubtotal + ship - disc) };
}

/**
 * أسباب منع الحفظ — **بالعربي وبالترتيب**، عشان الموظف يعرف يعمل إيه بدل ما يضغط
 * زرًا مقفولًا بلا تفسير. مصفوفة فاضية = مسموح بالحفظ.
 *
 * المخزون **مش** في القائمة عن قصد: العجز بيتعرض كتنبيه والتأكيد بيعلّمه للمراجعة،
 * فمنع الإدخال بسببه كان هيخلي الموظف يزوّر الكمية عشان يعدّي.
 */
export function saveBlockers(
  lines: CartLine[],
  opts: {
    shipping: number;
    discount: number;
    expectedPieces?: number | null;
    totalNeedsConfirm?: boolean;
  }
): string[] {
  const out: string[] = [];
  if (lines.length === 0) out.push("أضف صنفًا واحدًا على الأقل");

  const missing = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.needsPick || l.needsVariantReview || !l.productId);
  for (const { i } of missing) out.push(`اختر المنتج والنوع للصنف رقم ${i + 1}`);

  if (lines.some(l => !Number.isFinite(l.quantity) || l.quantity < 1))
    out.push("راجع الكميات — لازم تكون رقمًا صحيحًا من 1 فأكثر");
  if (lines.some(l => !Number.isFinite(l.unitPrice) || l.unitPrice < 0))
    out.push("راجع الأسعار — لا تقبل قيمة سالبة أو غير رقمية");

  const ship = Number(opts.shipping);
  const disc = Number(opts.discount);
  if (!Number.isFinite(ship) || ship < 0) out.push("راجع قيمة الشحن");
  if (!Number.isFinite(disc) || disc < 0) out.push("راجع قيمة الخصم");

  const summary = summarizeCart(lines, Number.isFinite(ship) ? ship : 0, Number.isFinite(disc) ? disc : 0);
  if (Number.isFinite(disc) && disc > summary.itemsSubtotal)
    out.push("الخصم أكبر من إجمالي الأصناف");

  if (opts.expectedPieces != null && opts.expectedPieces > 0 && summary.pieces !== opts.expectedPieces)
    out.push(`راجع عدد القطع — الرسالة تقول ${opts.expectedPieces} والسلة فيها ${summary.pieces}`);

  if (opts.totalNeedsConfirm) out.push("الإجمالي يحتاج مراجعة — أكّده قبل الحفظ");

  return out;
}
