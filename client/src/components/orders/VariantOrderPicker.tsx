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
}

// ── أبعاد التركيبات (دوال نقية قابلة للاختبار) ──
export type VariantDim = "name" | "color" | "size";
export const DIM_LABEL: Record<VariantDim, string> = {
  name: "النوع",
  color: "اللون",
  size: "المقاس",
};
const DIM_ORDER: VariantDim[] = ["name", "color", "size"];

const val = (v: CatalogVariant, d: VariantDim) => String(v[d] ?? "").trim();

/** الأبعاد اللي ليها قيم فعلية في تركيبات المنتج (بلا افتراض وجود لون/مقاس). */
export function variantDimensions(vs: CatalogVariant[]): VariantDim[] {
  return DIM_ORDER.filter(d => vs.some(v => val(v, d) !== ""));
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

/** وصف التركيبة للعرض/الطباعة: النوع ثم اللون ثم المقاس (الموجود منهم فقط). */
export function variantLabel(v: CatalogVariant | null | undefined): string {
  if (!v) return "";
  return DIM_ORDER.map(d => val(v, d)).filter(Boolean).join(" / ");
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
    if (!product || !ready) return;
    if (availableStock <= 0 || overStock) return;
    const label = variantLabel(resolved);
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
                    const idx = DIM_ORDER.indexOf(dim);
                    for (const d of DIM_ORDER.slice(idx + 1)) delete next[d];
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
            max={availableStock || undefined}
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
              {overStock && <span className="text-destructive"> · الكمية أكبر من المتاح</span>}
              {availableStock <= 0 && <span className="text-destructive"> · لا يوجد مخزون</span>}
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
          disabled={!ready || availableStock <= 0 || overStock}
          data-testid="vop-add"
        >
          <Plus className="h-4 w-4 ml-1" /> إضافة الصنف
        </Button>
      </div>

      {/* الأصناف المضافة — كل بند باختياره الخاص (قطعة بنقشة مختلفة = بند مستقل) */}
      {value.length > 0 && (
        <div className="rounded-md border divide-y">
          {value.map((it, idx) => (
            <div key={idx} className="flex items-center justify-between gap-2 p-2 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-medium">{it.productName}</span>
                {it.optionLabel && <Badge variant="secondary">{it.optionLabel}</Badge>}
                <span className="text-muted-foreground">×{it.quantity}</span>
                <span className="text-muted-foreground">= {it.unitPrice * it.quantity} ج.م</span>
                {it.sku && <span className="font-mono text-xs text-muted-foreground">{it.sku}</span>}
              </div>
              <button
                type="button"
                onClick={() => onChange(value.filter((_, i) => i !== idx))}
                aria-label="حذف الصنف"
                className="text-destructive"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
