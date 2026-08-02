import { useMemo } from "react";
import { Plus, Trash2, Package, AlertCircle } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Sentinel for "the base product, no variant". Radix SelectItem rejects an empty value. */
const NO_VARIANT = "__base__";

export type EditorLine = {
  /** Stable key for React across add/remove — not the database id. */
  key: string;
  productId: number | null;
  productName: string;
  variantId: number | null;
  quantity: number;
  unitPrice: number;
  discount: number;
};

export type CatalogProduct = {
  id: number;
  name: string;
  price?: string | number | null;
};

export type CatalogVariant = {
  id: number;
  productId: number;
  name?: string | null;
  color?: string | null;
  size?: string | null;
  price?: string | number | null;
};

type Props = {
  lines: EditorLine[];
  onChange: (lines: EditorLine[]) => void;
  products: CatalogProduct[];
  variants: CatalogVariant[];
  shippingFees: number;
  onShippingFeesChange: (value: number) => void;
  /** True when the order predates order_items and these lines were derived from the header. */
  derivedFromHeader?: boolean;
  isLoading?: boolean;
  disabled?: boolean;
};

let keyCounter = 0;
export function newLineKey() {
  keyCounter += 1;
  return `line-${keyCounter}-${Date.now()}`;
}

export function emptyLine(): EditorLine {
  return {
    key: newLineKey(),
    productId: null,
    productName: "",
    variantId: null,
    quantity: 1,
    unitPrice: 0,
    discount: 0,
  };
}

const money = (n: number) =>
  n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function lineNet(line: EditorLine): number {
  return Math.max(0, line.quantity * line.unitPrice - line.discount);
}

export function linesTotal(lines: EditorLine[], shippingFees: number): number {
  return lines.reduce((sum, l) => sum + lineNet(l), 0) + shippingFees;
}

/** Label for a variant row — variants carry a name, or a colour/size pair, or neither. */
export function variantLabel(v: CatalogVariant): string {
  if (v.name?.trim()) return v.name.trim();
  const parts = [v.color, v.size].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : `#${v.id}`;
}

/**
 * The order's lines, edited as lines.
 *
 * The old screen had one product select, one quantity, one total — because `orders` carries
 * exactly one product. A customer ordering two engravings of one bracelet plus a different
 * one had no way to be recorded, so employees typed the extra pieces into the notes box and
 * the warehouse read prose. Stock, cost and revenue were all wrong for those orders.
 *
 * These rows map one-to-one onto `order_items`, which has carried `variantId` all along.
 * The same product may appear on several rows with different variants — that is the common
 * case here, not an edge case, so nothing dedupes by productId.
 */
export function OrderItemsEditor({
  lines,
  onChange,
  products,
  variants,
  shippingFees,
  onShippingFeesChange,
  derivedFromHeader = false,
  isLoading = false,
  disabled = false,
}: Props) {
  const variantsByProduct = useMemo(() => {
    const map = new Map<number, CatalogVariant[]>();
    for (const v of variants) {
      const list = map.get(v.productId) ?? [];
      list.push(v);
      map.set(v.productId, list);
    }
    return map;
  }, [variants]);

  const patch = (index: number, changes: Partial<EditorLine>) => {
    onChange(lines.map((l, i) => (i === index ? { ...l, ...changes } : l)));
  };

  const removeLine = (index: number) => {
    onChange(lines.filter((_, i) => i !== index));
  };

  const productsNet = lines.reduce((sum, l) => sum + lineNet(l), 0);
  const grandTotal = productsNet + shippingFees;

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[0, 1].map(i => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {derivedFromHeader && (
        <p className="flex items-start gap-1.5 rounded-md bg-[var(--warning)]/10 p-2 text-xs text-[var(--warning)]">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            الأوردر ده قديم ومالوش بنود مفصّلة. البند المعروض متولّد من بيانات الأوردر —
            راجعه قبل الحفظ.
          </span>
        </p>
      )}

      {lines.map((line, index) => {
        const productVariants = line.productId
          ? (variantsByProduct.get(line.productId) ?? [])
          : [];
        const net = lineNet(line);
        const overDiscounted = line.discount > line.quantity * line.unitPrice;

        return (
          <div
            key={line.key}
            className="rounded-lg border bg-card p-3 space-y-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-muted-foreground">
                بند {index + 1}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                // h-11 like every other action: this one removes a line the employee just
                // priced, and it sits directly above the product select it would destroy.
                className="h-11 gap-1 px-3 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => removeLine(index)}
                // One line must remain: an order with no items has no meaning, and the
                // server rejects it anyway — better to disable than to fail on save.
                disabled={disabled || lines.length === 1}
                aria-label={`حذف البند ${index + 1}`}
              >
                <Trash2 className="h-4 w-4" />
                <span className="text-xs">حذف</span>
              </Button>
            </div>

            <div>
              <Label className="text-xs">المنتج</Label>
              <Select
                value={line.productId ? String(line.productId) : undefined}
                onValueChange={value => {
                  const id = Number(value);
                  const product = products.find(p => p.id === id);
                  patch(index, {
                    productId: id,
                    productName: product?.name ?? "",
                    // The old variant belongs to the old product — carrying it over would
                    // attach a bracelet's engraving to a bedsheet.
                    variantId: null,
                    unitPrice: product?.price != null ? Number(product.price) : line.unitPrice,
                  });
                }}
                disabled={disabled}
              >
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue placeholder="اختر المنتج..." />
                </SelectTrigger>
                <SelectContent className="max-h-[45vh]">
                  {products.map(p => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      <span className="flex w-full items-center justify-between gap-4">
                        <span>{p.name}</span>
                        {p.price != null && (
                          <span className="text-xs text-muted-foreground">
                            {money(Number(p.price))}
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!line.productId && line.productName && (
                <p className="mt-1 text-xs text-muted-foreground">
                  محفوظ باسم «{line.productName}» بدون ربط بالمخزون
                </p>
              )}
            </div>

            <div>
              <Label className="text-xs">نوع الحفر / المتغير</Label>
              {!line.productId ? (
                <div className="mt-1 flex h-9 items-center rounded-md border border-dashed px-3 text-xs text-muted-foreground">
                  اختر المنتج أولاً
                </div>
              ) : productVariants.length === 0 ? (
                <div className="mt-1 flex h-9 items-center rounded-md border border-dashed px-3 text-xs text-muted-foreground">
                  المنتج ده مالوش أنواع
                </div>
              ) : (
                <Select
                  value={line.variantId ? String(line.variantId) : NO_VARIANT}
                  onValueChange={value => {
                    if (value === NO_VARIANT) {
                      patch(index, { variantId: null });
                      return;
                    }
                    const variant = productVariants.find(v => v.id === Number(value));
                    patch(index, {
                      variantId: Number(value),
                      unitPrice:
                        variant?.price != null ? Number(variant.price) : line.unitPrice,
                    });
                  }}
                  disabled={disabled}
                >
                  <SelectTrigger className="mt-1 w-full">
                    <SelectValue placeholder="اختر النوع..." />
                  </SelectTrigger>
                  <SelectContent className="max-h-[45vh]">
                    <SelectItem value={NO_VARIANT}>— بدون نوع —</SelectItem>
                    {productVariants.map(v => (
                      <SelectItem key={v.id} value={String(v.id)}>
                        {variantLabel(v)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <Label className="text-xs">الكمية</Label>
                <Input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={999}
                  value={line.quantity}
                  onChange={e =>
                    patch(index, { quantity: Math.max(1, Number(e.target.value) || 1) })
                  }
                  className="mt-1 h-10"
                  disabled={disabled}
                />
              </div>
              <div>
                <Label className="text-xs">السعر</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={line.unitPrice}
                  onChange={e =>
                    patch(index, { unitPrice: Math.max(0, Number(e.target.value) || 0) })
                  }
                  className="mt-1 h-10"
                  disabled={disabled}
                />
              </div>
              <div>
                <Label className="text-xs">الخصم</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={line.discount}
                  onChange={e =>
                    patch(index, { discount: Math.max(0, Number(e.target.value) || 0) })
                  }
                  className={`mt-1 h-10 ${overDiscounted ? "border-destructive bg-destructive/10" : ""}`}
                  disabled={disabled}
                />
              </div>
            </div>

            {overDiscounted && (
              <p className="text-xs text-destructive">
                الخصم أكبر من قيمة البند ({money(line.quantity * line.unitPrice)})
              </p>
            )}

            <div className="flex items-center justify-between rounded-md bg-muted/60 px-3 py-2">
              <span className="text-xs text-muted-foreground">إجمالي البند</span>
              <span className="font-bold tabular-nums">
                {money(net)} <span className="text-xs font-normal">ج.م</span>
              </span>
            </div>
          </div>
        );
      })}

      <Button
        type="button"
        variant="outline"
        className="h-11 w-full gap-2"
        onClick={() => onChange([...lines, emptyLine()])}
        disabled={disabled || lines.length >= 20}
      >
        <Plus className="h-4 w-4" />
        إضافة بند
      </Button>

      <div className="rounded-lg border bg-card p-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label className="shrink-0 text-xs">رسوم الشحن</Label>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={shippingFees}
            onChange={e => onShippingFeesChange(Math.max(0, Number(e.target.value) || 0))}
            className="h-10 max-w-[140px] text-end"
            disabled={disabled}
          />
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">إجمالي المنتجات</span>
          <span className="tabular-nums">{money(productsNet)} ج.م</span>
        </div>
        <div className="flex items-center justify-between border-t pt-2">
          <span className="flex items-center gap-1.5 font-semibold">
            <Package className="h-4 w-4" />
            الإجمالي النهائي
          </span>
          <span className="text-lg font-black tabular-nums">
            {money(grandTotal)} <span className="text-sm font-normal">ج.م</span>
          </span>
        </div>
      </div>
    </div>
  );
}
