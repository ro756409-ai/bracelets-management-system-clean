import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { inventoryMovements, orderItems, orders, products, productVariants } from "../drizzle/schema";

/**
 * نسخة الرجوع الآمن (Rollback-Safe) — 620a5ae + حواجز مخزون فقط.
 *
 * النسخة دي موجودة عشان تكون هدف رجوع من v2 بس. كود 620a5ae بيخصم عند التأكيد، لكن:
 *   • الإلغاء مابيرجّعش المخزون (فرق جديد مع كل إلغاء لأوردر مخصوم).
 *   • إعادة فتح/تأكيد أوردر ملغي: confirmOrder في 620a5ae بيرفضه (CONFLICT) لو له حركة out سابقة — فمفيش
 *     خصم مزدوج للأوردرات اللي ليها سجل حركات؛ لكن الملغي بيفضل ماسك الخصم (فجوة R-1)، و«orders.update»
 *     بيأكّده من غير خصم، والأوردرات القديمة بلا سجل حركات ممكن تتخصم مرتين.
 *   • تعديل البنود بيحرّك مخزون المنتج الأب مش التركيبة (فرق بين الأب والتركيبة).
 *   • تغيير الحالة المباشر (orders.update / ويبهوك Easy Order) بيعدّي حدود الخصم من غير خصم/إرجاع.
 * الحواجز هنا بترفض أي عملية من دول على أوردر «ماسك مخزون»، وبتسيب الباقي زي ما هو.
 *
 * «ماسك مخزون» مايتحكمش عليه بالحالة بس: صافي حركات الأوردر نفسها (out − in بأسباب الأوردر)
 * هو الدليل. حالة خصم (confirmed…) أو صافي موجب أو حركة مش مفهومة = ماسك/غير موثوق = رفض.
 */
export const ROLLBACK_SAFE_MODE = true;

const SUFFIX = "النسخة الحالية نسخة رجوع مؤقتة — العملية دي متاحة بعد الرجوع للنسخة الجديدة";

export class RollbackSafeBlockedError extends TRPCError {
  readonly rollbackSafe = true as const;
  constructor(message: string) {
    super({ code: "PRECONDITION_FAILED", message: `${message} — ${SUFFIX}` });
    this.name = "RollbackSafeBlockedError";
  }
}

export function isRollbackSafeBlocked(err: unknown): err is RollbackSafeBlockedError {
  return Boolean(err && typeof err === "object" && (err as { rollbackSafe?: unknown }).rollbackSafe === true);
}

/** أسباب الحركات اللي النظام بيكتبها للأوردر نفسه (620a5ae + v2). أي سبب تاني على أوردر = حركة يدوية. */
const ORDER_MOVEMENT_REASON = /^(تأكيد أوردر|تعديل أوردر|تعديل كمية أوردر|تعديل بنود أوردر|إلغاء أوردر|مرتجع - أوردر)/;

/** حالات بعد التأكيد: المخزون اتخصم (أو المفروض يكون اتخصم) — ولو مفيش حركات (عصر قديم بلا سجل). */
export const STOCK_STATUSES: ReadonlySet<string> = new Set([
  "confirmed", "printed", "preparing", "shipped", "delivered", "returned",
]);

export type StockLine = { productId: number; variantId: number | null; qty: number };
/** سطر مقارنة (البنود ممكن يكون فيها صنف بلا منتج — مالوش أثر على المخزون). */
export type LooseLine = { productId?: number | null; variantId?: number | null; qty: number };
export type OrderStockState = {
  status: string;
  /** صافي الخصم الموجب لكل مفتاح (تركيبة أو منتج بسيط). */
  held: Map<string, StockLine>;
  /** سبب عدم الثقة في الصافي (حركة يدوية مربوطة، صافي سالب)، أو null. */
  uncertain: string | null;
};

export const stockKey = (productId: number, variantId: number | null | undefined) =>
  variantId != null ? `v${variantId}` : `p${productId}`;

/** صافي حركات الأوردر من inventory_movements (لازم صف الأوردر يكون مقفول قبلها في نفس المعاملة). */
export async function readOrderStockState(tx: any, order: { id: number; status: string }): Promise<OrderStockState> {
  const rows: { productId: number; variantId: number | null; type: string; quantity: number; reason: string | null }[] = await tx
    .select({
      productId: inventoryMovements.productId,
      variantId: inventoryMovements.variantId,
      type: inventoryMovements.type,
      quantity: inventoryMovements.quantity,
      reason: inventoryMovements.reason,
    })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.orderId, order.id));
  const net = new Map<string, StockLine>();
  let uncertain: string | null = null;
  for (const r of rows) {
    if (!ORDER_MOVEMENT_REASON.test((r.reason ?? "").trim())) {
      uncertain ??= "فيه حركة مخزون يدوية مربوطة بالأوردر";
      continue;
    }
    const key = stockKey(r.productId, r.variantId);
    const cur = net.get(key) ?? { productId: r.productId, variantId: r.variantId ?? null, qty: 0 };
    cur.qty += r.type === "out" ? r.quantity : -r.quantity;
    net.set(key, cur);
  }
  const held = new Map<string, StockLine>();
  for (const [key, line] of Array.from(net.entries())) {
    if (line.qty < 0) uncertain ??= "صافي حركات الأوردر سالب";
    else if (line.qty > 0) held.set(key, line);
  }
  return { status: order.status, held, uncertain };
}

/** الأوردر ماسك مخزون أو مش موثوق: حالة خصم، أو صافي موجب، أو حركات مش مفهومة. */
export function holdsStock(state: OrderStockState): boolean {
  return STOCK_STATUSES.has(state.status) || state.held.size > 0 || state.uncertain != null;
}

/** تجميع سطور (تركيبة/منتج → كمية) للمقارنة. السطور بلا منتج ماتأثرش في المخزون. */
export function toStockMap(lines: LooseLine[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const l of lines) {
    if (l.productId == null || !(l.qty > 0)) continue;
    const key = stockKey(l.productId, l.variantId);
    m.set(key, (m.get(key) ?? 0) + l.qty);
  }
  return m;
}

export function sameStockMap(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of Array.from(a.entries())) if (b.get(k) !== v) return false;
  return true;
}

/** سطور الأوردر الحالية (أو الهيدر لأوردر قديم بلا بنود) — نفس مصدر التأكيد. */
export async function currentStockLines(
  tx: any,
  order: { id: number; productId: number | null; variantId: number | null; quantity: number | null }
): Promise<StockLine[]> {
  const items: { productId: number | null; variantId: number | null; quantity: number }[] = await tx
    .select({ productId: orderItems.productId, variantId: orderItems.variantId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));
  const live = items.filter(i => i.productId != null && i.quantity > 0);
  if (live.length > 0) return live.map(i => ({ productId: i.productId!, variantId: i.variantId ?? null, qty: i.quantity }));
  if (order.productId == null) return [];
  return [{ productId: order.productId, variantId: order.variantId ?? null, qty: Math.max(1, order.quantity ?? 1) }];
}

const heldMap = (state: OrderStockState) =>
  new Map(Array.from(state.held.entries()).map(([k, l]) => [k, l.qty] as [string, number]));

/** الإلغاء (من أي مسار): مرفوض لو الأوردر ماسك مخزون — 620a5ae مابيرجّعش المخزون عند الإلغاء. */
export function assertCancelAllowed(state: OrderStockState): void {
  if (!holdsStock(state)) return;
  throw new RollbackSafeBlockedError(
    state.uncertain
      ? `لا يمكن إلغاء الأوردر: ${state.uncertain}`
      : "لا يمكن إلغاء أوردر اتخصم مخزونه (الإلغاء هنا مابيرجّعش المخزون)"
  );
}

/**
 * التأكيد (confirmOrder): 620a5ae أصلًا بيرفض (CONFLICT) أي أوردر ليه حركة «out» سابقة، فالخصم
 * المزدوج مقفول عنده للأوردرات اللي ليها سجل حركات. الحارس هنا بيقفل الباقي:
 *   • أوردر ملغي أو مرتجع = إعادة تأكيد = مرفوضة حتى لو مالوش حركات (عصر قديم بلا سجل).
 *   • حركات مش مفهومة (يدوية مربوطة/صافي سالب) = مرفوض.
 */
export function assertConfirmAllowed(state: OrderStockState): void {
  if (state.status === "cancelled" || state.status === "returned")
    throw new RollbackSafeBlockedError("لا يمكن إعادة تأكيد أوردر ملغي أو مرتجع");
  if (state.uncertain) throw new RollbackSafeBlockedError(`لا يمكن تأكيد الأوردر: ${state.uncertain}`);
}

/**
 * تغيير الحالة المباشر (orders.update، بوابة الموظف، ويبهوك Easy Order) — مابيخصمش ولا بيرجّع.
 *   • → ملغي: نفس حارس الإلغاء.
 *   • من ملغي لأي حالة: إعادة فتح أوردر ملغي = مرفوضة.
 *   • مرتجع → جديد: مرفوض لو لسه ماسك خصم.
 *   • من حالة بلا خصم لحالة خصم: مسموح بس لو الخصم موجود فعلًا ومطابق للسطور (وإلا لازم زر التأكيد).
 */
export function assertStatusChangeAllowed(state: OrderStockState, to: string, lines: LooseLine[]): void {
  const from = state.status;
  if (from === to) return;
  if (to === "cancelled") return assertCancelAllowed(state);
  if (from === "cancelled") throw new RollbackSafeBlockedError("لا يمكن إعادة فتح أوردر ملغي");
  if (from === "returned" && (state.held.size > 0 || state.uncertain))
    throw new RollbackSafeBlockedError("لا يمكن إعادة فتح مرتجع لسه مخزونه مخصوم");
  if (!STOCK_STATUSES.has(from) && STOCK_STATUSES.has(to)) {
    if (state.uncertain) throw new RollbackSafeBlockedError(`لا يمكن تغيير الحالة: ${state.uncertain}`);
    if (state.held.size > 0 && sameStockMap(heldMap(state), toStockMap(lines))) return;
    throw new RollbackSafeBlockedError("التأكيد بيتم من زر «تأكيد» بس (عشان المخزون يتخصم)");
  }
}

/** تعديل سطور/منتج/كمية: مسموح لو مابيغيّرش المخزون (نفس التركيبات والكميات)، أو الأوردر مش ماسك مخزون. */
export function assertStockNeutralChange(state: OrderStockState, before: LooseLine[], after: LooseLine[]): void {
  if (!holdsStock(state)) return;
  if (sameStockMap(toStockMap(before), toStockMap(after))) return;
  throw new RollbackSafeBlockedError(
    state.uncertain
      ? `لا يمكن تعديل أصناف/كميات الأوردر: ${state.uncertain}`
      : "لا يمكن تعديل أصناف أو كميات أوردر اتخصم مخزونه (التعديل هنا مابيضبطش التركيبات)"
  );
}

/** تعيين منتج/تركيبة لبنود الأوردر (حل المراجعة): مرفوض لأوردر ماسك مخزون — بيغيّر مصدر المخزون من غير ما يحرّكه. */
export function assertProductReassignAllowed(state: OrderStockState): void {
  if (!holdsStock(state)) return;
  throw new RollbackSafeBlockedError("لا يمكن تغيير منتج أوردر اتخصم مخزونه");
}

/** الحذف: مرفوض لأوردر ماسك مخزون (الخصم هيفضل من غير أوردر). */
export function assertDeleteAllowed(state: OrderStockState, orderNumber?: string | null): void {
  if (!holdsStock(state)) return;
  throw new RollbackSafeBlockedError(`لا يمكن حذف أوردر اتخصم مخزونه${orderNumber ? ` (${orderNumber})` : ""}`);
}

/**
 * المرتجع باسترجاع مخزون: 620a5ae بيرجّع على المنتج الأب بكمية الهيدر. مسموح بس لو ده
 * يطابق الخصم بالظبط (منتج بسيط واحد بنفس الكمية)؛ غير كده المرتجع يتسجّل بدون استرجاع.
 */
export function assertReturnRestoreAllowed(
  state: OrderStockState,
  order: { productId: number | null; quantity: number | null }
): void {
  const exact =
    !state.uncertain &&
    order.productId != null &&
    state.held.size === 1 &&
    state.held.get(stockKey(order.productId, null))?.qty === order.quantity;
  if (exact) return;
  throw new RollbackSafeBlockedError("استرجاع المخزون مع المرتجع مش ممكن بدقة هنا — سجّل المرتجع بدون استرجاع المخزون");
}

/**
 * editOrderFull (تعديل من الهيدر): يقفل صف الأوردر (لازم يتنادى جوه المعاملة اللي هتكتب) ويرفض أي
 * تغيير منتج/تركيبة/كمية لأوردر ماسك مخزون. السطر بعد التعديل = السطر الوحيد (أو الهيدر لأوردر
 * بلا بنود) بالقيم الجديدة؛ الأوردر متعدد الأصناف بيترفض في editOrderFull نفسها أصلًا.
 */
export async function assertHeaderEditStockNeutral(tx: any, orderId: number, updates: Record<string, any>): Promise<void> {
  const [fresh] = await tx
    .select({ id: orders.id, status: orders.status, productId: orders.productId, variantId: orders.variantId, quantity: orders.quantity })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)
    .for("update");
  if (!fresh) throw new Error("الأوردر غير موجود");
  if (!["productId", "variantId", "quantity"].some(f => f in updates)) return;
  const before = await currentStockLines(tx, fresh);
  const after = before.length === 1
    ? [{
        productId: "productId" in updates ? updates.productId : before[0].productId,
        variantId: "variantId" in updates ? (updates.variantId ?? null) : before[0].variantId,
        qty: "quantity" in updates ? Number(updates.quantity) : before[0].qty,
      }]
    : before;
  assertStockNeutralChange(await readOrderStockState(tx, fresh), before, after);
}

/**
 * بصمة كل اللي ممكن تحديث أوردر يلمسه: صف الأوردر كامل (حتى updatedAt)، بنوده، حركاته، ورصيد
 * المنتجات/التركيبات اللي في بنوده. الويبهوك بيقارنها قبل وبعد الرفض — الرد 200 «مرفوض عمدًا»
 * بس لو مفيش أي تغيير؛ غير كده = فشل حقيقي (5xx).
 */
export async function orderWriteFingerprint(db: any, orderId: number): Promise<string> {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, orderId)).orderBy(orderItems.id);
  const moves = await db.select().from(inventoryMovements).where(eq(inventoryMovements.orderId, orderId)).orderBy(inventoryMovements.id);
  const productIds = Array.from(new Set(items.map((i: { productId: number | null }) => i.productId).filter((x: number | null) => x != null))) as number[];
  const stock = productIds.length
    ? {
        products: await db.select({ id: products.id, s: products.currentStock }).from(products).where(inArray(products.id, productIds)).orderBy(products.id),
        variants: await db.select({ id: productVariants.id, s: productVariants.currentStock }).from(productVariants).where(inArray(productVariants.productId, productIds)).orderBy(productVariants.id),
      }
    : null;
  return JSON.stringify({ order, items, moves, stock });
}
