/**
 * حساب إجماليات إذن الاستلام.
 *
 * منفصلة عن الشاشة عشان الاختبار يقيس نفس المعادلة اللي المستخدم شايفها، مش نسخة تانية
 * منها. نفس سبب فصل netFromComponents في المرتبات.
 *
 * التكلفة النهائية للوحدة هي اللي بتتبعت للسيرفر كـ`unitCost`، لأن
 * `purchase_receipt_items` لسه مافيهاش أعمدة للخصم والتكلفة الإضافية. ده بيخلّي إجمالي
 * المستند وقيمة المخزون مضبوطين، واللي بيضيع هو تفصيلة الخصم لحد ما تتعمل الـmigration.
 */

export type ReceiptLineInput = {
  quantity: string | number;
  unitCost: string | number;
  /** خصم على البند كله، مش على الوحدة. */
  discount?: string | number;
  /** تكلفة إضافية موزّعة على البند (نقل، جمارك، تشطيب). */
  extraCost?: string | number;
};

const num = (v: string | number | undefined | null): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** الكمية × تكلفة الوحدة، قبل أي خصم أو إضافة. */
export function lineSubtotal(line: ReceiptLineInput): number {
  return num(line.quantity) * num(line.unitCost);
}

/** إجمالي البند = الأساس − الخصم + التكلفة الإضافية. */
export function lineTotal(line: ReceiptLineInput): number {
  return lineSubtotal(line) - num(line.discount) + num(line.extraCost);
}

/**
 * تكلفة الوحدة بعد الخصم والإضافة — دي اللي بتدخل المخزون.
 *
 * كمية صفر بترجّع صفر بدل NaN: النموذج بيحسب وإنت بتكتب، وسطر لسه فاضي مايعملش
 * «NaN ج.م» في نص الشاشة.
 */
export function lineFinalUnitCost(line: ReceiptLineInput): number {
  const quantity = num(line.quantity);
  if (quantity <= 0) return 0;
  return lineTotal(line) / quantity;
}

export type DocumentTotals = {
  linesTotal: number;
  shipping: number;
  discount: number;
  total: number;
};

/** إجمالي المستند = مجموع البنود + مصاريف الشحن − خصم الفاتورة. */
export function documentTotal(
  lines: ReceiptLineInput[],
  headerShipping?: string | number,
  headerDiscount?: string | number
): DocumentTotals {
  const linesTotal = lines.reduce((sum, line) => sum + lineTotal(line), 0);
  const shipping = num(headerShipping);
  const discount = num(headerDiscount);
  return { linesTotal, shipping, discount, total: linesTotal + shipping - discount };
}

/** المتبقي للمورد = إجمالي المستند − المدفوع المؤكد. مابينزلش تحت الصفر. */
export function outstandingAmount(total: number, paid: number): number {
  return Math.max(0, total - num(paid));
}

/**
 * سطر استلام من الورشة: سادة ومحفور في صف واحد.
 *
 * الورشة بتسلّم الصنف الواحد على حالتين بتكلفتين مختلفتين — قطعة سادة وقطعة عليها حفر —
 * والتاجر بيعدّهم مع بعض. فالصف في الشاشة واحد، وبيتحوّل لسطرين في `purchase_receipt_items`
 * لأن ده اللي المخزون بيتحسب عليه: السادة رصيد المنتج نفسه، والمحفور رصيد النوع.
 *
 * الصفر معناه «مفيش من ده النهاردة» — سطر بكمية صفر مابيتبعتش أصلاً.
 */
export type WorkshopLineInput = {
  plainQuantity: string | number;
  plainUnitCost: string | number;
  engravedQuantity: string | number;
  engravedUnitCost: string | number;
};

export function workshopLineTotal(line: WorkshopLineInput): number {
  return (
    num(line.plainQuantity) * num(line.plainUnitCost) +
    num(line.engravedQuantity) * num(line.engravedUnitCost)
  );
}

/** إجمالي الإذن = مجموع صفوفه. مفيش خصومات ولا مصاريف شحن — الورشة بتسلّم وخلاص. */
export function workshopReceiptTotal(lines: WorkshopLineInput[]): number {
  return lines.reduce((sum, line) => sum + workshopLineTotal(line), 0);
}

/** إجمالي القطع الداخلة — العدد اللي أمين المخزن بيعدّه. */
export function workshopReceiptPieces(lines: WorkshopLineInput[]): number {
  return lines.reduce(
    (sum, l) => sum + num(l.plainQuantity) + num(l.engravedQuantity),
    0
  );
}
