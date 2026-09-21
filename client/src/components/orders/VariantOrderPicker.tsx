import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, X, Package, AlertTriangle } from "lucide-react";

/**
 * منتقي أصناف الأوردر اليدوي — **عام** ومدفوع بأبعاد التركيبات الموجودة فعلًا في المنتج:
 *   • `name`  → النوع (مثل نوع الحفر/النقشة للأساور)
 *   • `color` → اللون
 *   • `size`  → المقاس
 * بنعرض قائمة لكل بُعد **موجود فعلًا** في تركيبات المنتج المختار (بلا افتراض لون/مقاس، وبلا
 * أي أسماء ثابتة أو تمييز بالبراند/اسم المنتج). التركيبة تُحسم فقط لما كل الأبعاد تتحدد
 * وينتج **تطابق واحد ووحيد** — **ممنوع الاختيار الصامت لأول تركيبة**.
 * الكمية أكثر من قطعة بنقشات مختلفة: بيضيف الموظف بندًا لكل قطعة باختيارها الخاص.
 */

export interface CatalogProduct {
  id: number;
  name: string;
  sku: string | null;
  price: string | null;
  currentStock?: number | null;
}
export interface CatalogVariant {
  id: number;
  productId: number;
  name: string | null;
  sku: string | null;
  price: string | null;
  color?: string | null;
  size?: string | null;
  isActive?: boolean;
  currentStock?: number | null;
}
export interface Catalog {
  products: CatalogProduct[];
  variants: CatalogVariant[];
}

export interface PickedItem {
  productId: number;
  productName: string;
  variantId?: number;
  sku?: string | null;
  color?: string | null;
  size?: string | null;
  /** وصف مقروء للتركيبة (النوع/اللون/المقاس) — بيتحط في اسم البند للطباعة والتفاصيل. */
  optionLabel?: string | null;
  quantity: number;
  unitPrice: number;
  availableStock: number;
  /** السطر لسه محتاج اختيار منتج/تركيبة — الحفظ متوقف عليه. */
  needsPick?: boolean;
  /** سبب عدم المطابقة، للعرض جنب السطر. */
  pickReason?: string | null;
  /** التركيبة اتمسحت لأنها مش تابعة لمنتج البند (مسودة قديمة). */
  needsVariantReview?: boolean;
  /** مصدر السعر (القالب المبسّط): message | allocated | catalog | manual — للسجل والحماية من الاستبدال. */
  priceSource?: "message" | "allocated" | "catalog" | "manual";
  /** ثقة التحليل في السطر (القالب المبسّط): confident | ambiguous | unresolved. */
  confidence?: "confident" | "ambiguous" | "unresolved";
  /** النص الأصلي من الرسالة لهذا السطر. */
  segmentText?: string;
  /** السطر اتحل بمساعدة AI — يُعرض للمراجعة دايمًا. */
  aiAssisted?: boolean;
}

// ── أبعاد التركيبات (دوال نقية قابلة للاختبار) ──
export type VariantDim = "name" | "color" | "size" | "sku";
export const DIM_LABEL: Record<VariantDim, string> = {
  name: "النوع",
  color: "اللون",
  size: "المقاس",
  sku: "الرمز",
};
const DIM_ORDER: VariantDim[] = ["name", "color", "size"];

/**
 * قيمة البُعد — مع قاعدة واحدة دقيقة: **`name` اللي بيساوي `sku` مش تسمية بشرية**.
 *
 * في الإنتاج فيه تركيبات ملابس اتسجّل فيها الـSKU في عمود الاسم (`name='AFK-BLK-6'`
 * و`sku='AFK-BLK-6'`)، فالموظف كان بيشوف قائمة «النوع» مليانة أكواد بدل اللون والمقاس
 * الموجودين صح جنبها. المقارنة بالتساوي مع الـSKU بالظبط — مش تخمين «شكله كود» — فاسم
 * بشري حقيقي (نوع الحفر مثلًا) عمره ما هيتخفي: أسماء الأساور عربية وSKU بتاعها
 * `AYAT-001`، فمستحيل يتساووا.
 */
const val = (v: CatalogVariant, d: VariantDim) => {
  const raw = String((v as any)[d] ?? "").trim();
  if (d === "name" && raw && raw === String(v.sku ?? "").trim()) return "";
  return raw;
};

/**
 * الأبعاد اللي ليها قيم فعلية في تركيبات المنتج (بلا افتراض وجود لون/مقاس).
 *
 * لو مفيش أي بُعد مقروء (تركيبات مميّزة بالـSKU وبس)، بنرجّع `sku` كملاذ أخير تحت
 * عنوان «الرمز» — عشان الموظف يقدر يختار بدل ما يقف قدام منتقي مسدود. مش تحت «النوع».
 */
export function variantDimensions(vs: CatalogVariant[]): VariantDim[] {
  const dims = DIM_ORDER.filter(d => vs.some(v => val(v, d) !== ""));

  // **«النوع» بيتشال لو اللون+المقاس لوحدهم بيميّزوا كل تركيبة.**
  //
  // في الإنتاج فيه منتجات ملابس اتسجّل في عمود `name` بتاعها حاجة مش «نوع» حقيقي:
  // الـSKU («AFK-BLK-6»)، أو اسم المنتج نفسه («بدلة اطفالي»)، أو إعادة صياغة للّون
  // والمقاس («اسود 10»). كلها بتملا قائمة «النوع» بقيم مالهاش معنى للموظف. بدل قايمة
  // استثناءات بتتنسى، بنسأل سؤالًا واحدًا: هل اللون+المقاس كافيين لتمييز كل تركيبة؟
  // لو أيوه فـ«النوع» زيادة مهما كان محتواه. الأساور مالهاش لون/مقاس فبتفضل بالنوع.
  const csDims = dims.filter(d => d === "color" || d === "size");
  if (dims.includes("name") && csDims.length > 0) {
    // JSON كمفتاح بدل فاصل نصّي: مستحيل يصطدم بقيمة لون/مقاس، ومفيش حروف تحكّم
    // في الملف (بايت NUL حرفي كان بيخلّي git يعامل الملف كثنائي ويكسر الدمج).
    const keys = vs.map(v => JSON.stringify(csDims.map(d => val(v, d))));
    if (new Set(keys).size === vs.length) return csDims;
  }

  if (dims.length > 0) return dims;
  return vs.some(v => val(v, "sku") !== "") ? ["sku"] : [];
}

/** القيم المتاحة لبُعد معيّن، مفلترة بما اختاره الموظف في الأبعاد الأخرى. */
export function optionsFor(
  vs: CatalogVariant[],
  dim: VariantDim,
  selected: Partial<Record<VariantDim, string>>
): string[] {
  const pool = vs.filter(v =>
    DIM_ORDER.every(d => d === dim || !selected[d] || val(v, d) === selected[d])
  );
  return Array.from(new Set(pool.map(v => val(v, dim)).filter(Boolean)));
}

export type ResolveReason = "ok" | "incomplete" | "none" | "ambiguous";

/**
 * يحسم التركيبة: لازم كل بُعد موجود يتحدد، وينتج **تطابق واحد ووحيد**. أي غير كده →
 * بلا تركيبة + سبب واضح (مفيش تخمين ولا أول تركيبة).
 */
export function resolveVariant(
  vs: CatalogVariant[],
  dims: VariantDim[],
  selected: Partial<Record<VariantDim, string>>
): { variant: CatalogVariant | null; reason: ResolveReason } {
  if (dims.length === 0) return { variant: null, reason: "none" };
  if (dims.some(d => !selected[d])) return { variant: null, reason: "incomplete" };
  const m = vs.filter(v => dims.every(d => val(v, d) === selected[d]));
  if (m.length === 1) return { variant: m[0], reason: "ok" };
  return { variant: null, reason: m.length > 1 ? "ambiguous" : "none" };
}

/**
 * وصف التركيبة للعرض/الطباعة: النوع ثم اللون ثم المقاس (الموجود منهم فقط).
 * بيتخطّى الاسم اللي هو نفسه الـSKU — نفس قاعدة `val`، فالبوليصة مابتحملش كودًا تقنيًا.
 */
export function variantLabel(
  v: CatalogVariant | null | undefined,
  /**
   * الأبعاد اللي هتتعرض. لازم تتمرّر من `variantDimensions(productVariants)` عشان
   * الوصف يطابق اللي الموظف شافه في القوائم — «النوع» المحذوف (لأن اللون والمقاس
   * كافيين) مايرجعش يظهر في اسم البند وعلى البوليصة.
   */
  dims: VariantDim[] = DIM_ORDER
): string {
  if (!v) return "";
  return dims.map(d => val(v, d)).filter(Boolean).join(" / ");
}

const num = (s: string | null | undefined) => {
  const n = Number(s ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function VariantOrderPicker({
  catalog,
  value,
  onChange,
}: {
  catalog: Catalog;
  value: PickedItem[];
  onChange: (items: PickedItem[]) => void;
}) {
  const [productId, setProductId] = useState<number | null>(null);
  const [selected, setSelected] = useState<Partial<Record<VariantDim, string>>>({});
  const [qty, setQty] = useState<string>("1");

  const activeVariants = useMemo(
    () => catalog.variants.filter(v => v.isActive !== false),
    [catalog.variants]
  );
  const product = catalog.products.find(p => p.id === productId) ?? null;
  const productVariants = useMemo(
    () => (productId ? activeVariants.filter(v => v.productId === productId) : []),
    [activeVariants, productId]
  );
  const hasVariants = productVariants.length > 0;
  const dims = useMemo(() => variantDimensions(productVariants), [productVariants]);
  const { variant: resolved, reason } = useMemo(
    () => resolveVariant(productVariants, dims, selected),
    [productVariants, dims, selected]
  );

  const availableStock = hasVariants
    ? resolved?.currentStock ?? 0
    : product?.currentStock ?? 0;
  const unitPrice = hasVariants
    ? num(resolved?.price ?? product?.price)
    : num(product?.price);

  // جاهز فقط لما: منتج بسيط، أو تركيبة محسومة (تطابق واحد ووحيد).
  const ready = !!product && (!hasVariants || resolved != null);
  const qtyNum = Math.max(1, parseInt(qty || "1", 10) || 1);
  const overStock = qtyNum > availableStock;

  function resetPicker() {
    setProductId(null);
    setSelected({});
    setQty("1");
  }

  function addItem() {
    // **المخزون مابيمنعش الإضافة.** العميل طلب قطعتين والمتاح واحدة = أوردر حقيقي
    // لازم يتسجّل بكميته الصحيحة؛ العجز بيتعرض كتنبيه و`confirmOrder` بتعلّمه
    // needsReview وقت التأكيد. المنع هنا كان بيخلي الموظف يقلّل الكمية عشان يعدّي.
    if (!product || !ready) return;
    const label = variantLabel(resolved, dims);
    onChange([
      ...value,
      {
        productId: product.id,
        productName: product.name,
        variantId: resolved?.id,
        sku: resolved?.sku ?? product.sku,
        color: resolved?.color ?? null,
        size: resolved?.size ?? null,
        optionLabel: label || null,
        quantity: qtyNum,
        unitPrice,
        availableStock,
      },
    ]);
    resetPicker();
  }

  const hint =
    !product
      ? "اختر المنتج"
      : !hasVariants
        ? null
        : reason === "incomplete"
          ? `اختر ${dims.filter(d => !selected[d]).map(d => DIM_LABEL[d]).join(" و ")}`
          : reason === "none"
            ? "لا توجد تركيبة بهذه الخيارات — راجع الاختيار"
            : reason === "ambiguous"
              ? "أكثر من تركيبة تطابق هذه الخيارات — حدّد باقي الخيارات"
              : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {/* المنتج */}
        <div>
          <Label className="text-xs">المنتج</Label>
          <Select
            value={productId != null ? String(productId) : ""}
            onValueChange={v => {
              setProductId(Number(v));
              setSelected({});
              setQty("1");
            }}
          >
            <SelectTrigger className="mt-1" data-testid="vop-product">
              <SelectValue placeholder="اختر المنتج" />
            </SelectTrigger>
            <SelectContent>
              {catalog.products.map(p => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* قائمة لكل بُعد موجود فعلًا في تركيبات المنتج (النوع/اللون/المقاس) */}
        {dims.map(dim => {
          const opts = optionsFor(productVariants, dim, selected);
          return (
            <div key={dim}>
              <Label className="text-xs">{DIM_LABEL[dim]}</Label>
              <Select
                value={selected[dim] ?? ""}
                onValueChange={v =>
                  // تغيير بُعد بيصفّر الأبعاد اللي بعده عشان القوائم تتفلتر صح.
                  setSelected(prev => {
                    const next: Partial<Record<VariantDim, string>> = { ...prev, [dim]: v };
                    const idx = dims.indexOf(dim);
                    for (const d of dims.slice(idx + 1)) delete next[d];
                    return next;
                  })
                }
              >
                <SelectTrigger className="mt-1" data-testid={`vop-${dim}`}>
                  <SelectValue placeholder={`اختر ${DIM_LABEL[dim]}`} />
                </SelectTrigger>
                <SelectContent>
                  {opts.map(o => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}

        {/* الكمية */}
        <div>
          <Label className="text-xs">الكمية</Label>
          <Input
            type="number"
            min="1"
            // مفيش max من المخزون — الكمية بتتبع طلب العميل (تنبيه بس لو أكبر من المتاح).
            value={qty}
            onChange={e => setQty(e.target.value)}
            className="mt-1"
            disabled={!ready}
            data-testid="vop-qty"
          />
        </div>
      </div>

      {/* المتاح + السعر + زر الإضافة */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-muted-foreground">
          {product && ready ? (
            <>
              المتاح:{" "}
              <span className={availableStock > 0 ? "font-semibold text-foreground" : "font-semibold text-destructive"}>
                {availableStock}
              </span>
              {" · "}سعر الوحدة: <span className="font-semibold text-foreground">{unitPrice}</span> ج.م
              {/* تنبيه مخزون — مش مانع. الحفظ والتأكيد بيكمّلوا والعجز بيتعلّم للمراجعة. */}
              {overStock && (
                <span className="text-[var(--warning)]"> · تنبيه: الكمية أكبر من المتاح</span>
              )}
              {availableStock <= 0 && (
                <span className="text-[var(--warning)]"> · تنبيه: لا يوجد مخزون</span>
              )}
            </>
          ) : (
            <span className="flex items-center gap-1">
              {hint && <AlertTriangle className="h-3 w-3" />} {hint}
            </span>
          )}
        </div>
        <Button
          type="button"
          size="sm"
          onClick={addItem}
          disabled={!ready}
          data-testid="vop-add"
        >
          <Plus className="h-4 w-4 ml-1" /> إضافة الصنف
        </Button>
      </div>

      {/* الأصناف المضافة — كارت لكل صنف: كمية بأزرار، سعر وحدة قابل للتعديل، إجمالي السطر */}
      {value.length > 0 && (
        <div className="space-y-2">
          {value.map((it, idx) => {
            const patch = (p: Partial<PickedItem>) =>
              onChange(value.map((x, i) => (i === idx ? { ...x, ...p } : x)));
            const over = it.quantity > it.availableStock;
            return (
              <div
                key={idx}
                className={`rounded-lg border p-3 space-y-2 ${it.needsPick || it.needsVariantReview ? "border-[var(--warning)] bg-[var(--warning)]/5" : ""}`}
                data-testid={`vop-item-${idx}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                    <span className="font-medium truncate">
                      {it.productName || "— لم يتم التعرف على المنتج —"}
                    </span>
                    {it.optionLabel && <Badge variant="secondary">{it.optionLabel}</Badge>}
                  </div>
                  <button
                    type="button"
                    onClick={() => onChange(value.filter((_, i) => i !== idx))}
                    aria-label="حذف الصنف"
                    className="text-destructive shrink-0"
                    data-testid={`vop-remove-${idx}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {(it.needsPick || it.needsVariantReview) && (
                  <div className="flex items-center gap-1 text-xs text-[var(--warning)]">
                    <AlertTriangle className="h-3 w-3 shrink-0" />
                    {it.pickReason ?? "اختر النوع لهذه القطعة"}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <div>
                    <Label className="text-xs">الكمية</Label>
                    <div className="mt-1 flex items-center gap-1">
                      <Button
                        type="button" size="icon" variant="outline" className="h-9 w-9 shrink-0"
                        onClick={() => patch({ quantity: Math.max(1, it.quantity - 1) })}
                        aria-label="تقليل الكمية"
                        data-testid={`vop-qty-minus-${idx}`}
                      >−</Button>
                      <Input
                        type="number" min="1" value={it.quantity}
                        onChange={e =>
                          patch({ quantity: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })
                        }
                        className="h-9 text-center"
                        data-testid={`vop-qty-${idx}`}
                      />
                      <Button
                        type="button" size="icon" variant="outline" className="h-9 w-9 shrink-0"
                        onClick={() => patch({ quantity: it.quantity + 1 })}
                        aria-label="زيادة الكمية"
                        data-testid={`vop-qty-plus-${idx}`}
                      >+</Button>
                    </div>
                  </div>
                  <div>
                    <Label className="text-xs">سعر الوحدة</Label>
                    <Input
                      type="number" min="0" step="0.01" value={it.unitPrice}
                      onChange={e => patch({ unitPrice: Math.max(0, Number(e.target.value) || 0) })}
                      className="mt-1 h-9"
                      data-testid={`vop-price-${idx}`}
                    />
                  </div>
                  <div className="col-span-2 sm:col-span-1">
                    <Label className="text-xs">إجمالي السطر</Label>
                    <div className="mt-1 flex h-9 items-center font-semibold">
                      {(it.unitPrice * it.quantity).toFixed(2)} ج.م
                    </div>
                  </div>
                </div>

                {/* المخزون تنبيه مش مانع — الحفظ والتأكيد بيكمّلوا والعجز بيتعلّم للمراجعة */}
                {over && (
                  <div className="text-xs text-[var(--warning)]">
                    تنبيه: المطلوب {it.quantity} والمتاح {it.availableStock}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
