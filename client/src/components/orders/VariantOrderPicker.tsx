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
import { Plus, X, Package } from "lucide-react";

/**
 * منتقي أصناف الأوردر اليدوي المبني على المخزون (variant-based):
 *   المنتج ← اللون ← المقاس ← الكمية.
 * بيعرض المتاح لكل تركيبة، ويمنع كمية أكبر من المخزون، والمقاسات بتتفلتر حسب اللون المختار.
 * كل صنف مضاف بيحمل variantId وSKU واللون والمقاس والكمية وسعر الوحدة (من التركيبة).
 * مافيهوش أي منطق قديم للإسورة (نوع حفر/نقش/عدد أساور).
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
  quantity: number;
  unitPrice: number;
  availableStock: number;
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
  const [color, setColor] = useState<string>("");
  const [size, setSize] = useState<string>("");
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

  // ألوان المنتج (المميّزة، غير الفارغة).
  const colors = useMemo(
    () => Array.from(new Set(productVariants.map(v => v.color).filter(Boolean))) as string[],
    [productVariants]
  );
  // المقاسات المتاحة للّون المختار فقط (أو كل المقاسات لو مفيش ألوان).
  const sizes = useMemo(() => {
    const pool = colors.length && color
      ? productVariants.filter(v => v.color === color)
      : productVariants;
    return Array.from(new Set(pool.map(v => v.size).filter(Boolean))) as string[];
  }, [productVariants, colors.length, color]);

  // التركيبة المحسومة من (اللون، المقاس).
  const resolvedVariant = useMemo(() => {
    if (!hasVariants) return null;
    return (
      productVariants.find(
        v =>
          (colors.length === 0 || v.color === color) &&
          (sizes.length === 0 || v.size === size)
      ) ?? null
    );
  }, [hasVariants, productVariants, colors.length, color, sizes.length, size]);

  // المخزون المتاح للاختيار الحالي.
  const availableStock = hasVariants
    ? resolvedVariant?.currentStock ?? 0
    : product?.currentStock ?? 0;

  const unitPrice = hasVariants
    ? num(resolvedVariant?.price ?? product?.price)
    : num(product?.price);

  const ready =
    !!product &&
    (!hasVariants ||
      (resolvedVariant != null &&
        (colors.length === 0 || !!color) &&
        (sizes.length === 0 || !!size)));

  const qtyNum = Math.max(1, parseInt(qty || "1", 10) || 1);
  const overStock = qtyNum > availableStock;

  function resetPicker() {
    setProductId(null);
    setColor("");
    setSize("");
    setQty("1");
  }

  function addItem() {
    if (!product || !ready) return;
    if (availableStock <= 0 || overStock) return;
    const item: PickedItem = {
      productId: product.id,
      productName: product.name,
      variantId: resolvedVariant?.id,
      sku: resolvedVariant?.sku ?? product.sku,
      color: resolvedVariant?.color ?? null,
      size: resolvedVariant?.size ?? null,
      quantity: qtyNum,
      unitPrice,
      availableStock,
    };
    onChange([...value, item]);
    resetPicker();
  }

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
              setColor("");
              setSize("");
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

        {/* اللون — فقط لو للمنتج ألوان */}
        {hasVariants && colors.length > 0 && (
          <div>
            <Label className="text-xs">اللون</Label>
            <Select
              value={color}
              onValueChange={v => {
                setColor(v);
                setSize(""); // المقاسات بتعتمد على اللون
              }}
            >
              <SelectTrigger className="mt-1" data-testid="vop-color">
                <SelectValue placeholder="اختر اللون" />
              </SelectTrigger>
              <SelectContent>
                {colors.map(c => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {/* المقاس — المتاح للّون المختار */}
        {hasVariants && sizes.length > 0 && (
          <div>
            <Label className="text-xs">المقاس</Label>
            <Select value={size} onValueChange={setSize}>
              <SelectTrigger className="mt-1" data-testid="vop-size">
                <SelectValue placeholder="اختر المقاس" />
              </SelectTrigger>
              <SelectContent>
                {sizes.map(s => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

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
              المتاح: <span className={availableStock > 0 ? "font-semibold text-foreground" : "font-semibold text-destructive"}>{availableStock}</span>
              {" · "}سعر الوحدة: <span className="font-semibold text-foreground">{unitPrice}</span> ج.م
              {overStock && <span className="text-destructive"> · الكمية أكبر من المتاح</span>}
              {availableStock <= 0 && <span className="text-destructive"> · لا يوجد مخزون</span>}
            </>
          ) : (
            <>اختر المنتج{hasVariants ? " واللون والمقاس" : ""}</>
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

      {/* الأصناف المضافة */}
      {value.length > 0 && (
        <div className="rounded-md border divide-y">
          {value.map((it, idx) => (
            <div key={idx} className="flex items-center justify-between gap-2 p-2 text-sm">
              <div className="flex items-center gap-2 flex-wrap">
                <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="font-medium">{it.productName}</span>
                {it.color && <Badge variant="secondary">{it.color}</Badge>}
                {it.size && <Badge variant="secondary">{it.size}</Badge>}
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
