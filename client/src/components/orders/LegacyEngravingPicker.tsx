import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, X, AlertTriangle } from "lucide-react";
import {
  variantDimensions,
  type Catalog,
  type CatalogProduct,
  type CatalogVariant,
  type PickedItem,
} from "./VariantOrderPicker";

/**
 * قالب الإدخال المبسّط (`bracelets_legacy`): منتج واحد ← «نوع النقش» ← الكمية ← سطر.
 *
 * مفيش سلة عامة ولا ألوان ولا مقاسات. المنتج بيتحدد **من البيانات** — المنتج اللي
 * تركيباته مميّزة بالنوع (`name`) بس — مش باسم مكتوب في الكود ولا بمعرّف نشاط. لو
 * النشاط عنده منتج واحد كده بيتختار تلقائيًا؛ أكتر من واحد → قائمة؛ صفر → رسالة.
 *
 * نفس `PickedItem` ونفس `addOrder` الذرّي بتوع القالب الكامل — الفرق واجهة بس.
 */

/** المنتجات اللي تركيباتها بالنوع فقط — دي اللي القالب المبسّط بيعرضها. */
export function findLegacyProducts(catalog: Catalog): CatalogProduct[] {
  const active = catalog.variants.filter(v => v.isActive !== false);
  return catalog.products.filter(p => {
    const vs = active.filter(v => v.productId === p.id);
    if (vs.length === 0) return false;
    const dims = variantDimensions(vs);
    return dims.length === 1 && dims[0] === "name";
  });
}

const num = (s: string | number | null | undefined) => {
  const n = Number(s ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export function LegacyEngravingPicker({
  catalog,
  value,
  onChange,
}: {
  catalog: Catalog;
  value: PickedItem[];
  onChange: (items: PickedItem[]) => void;
}) {
  const legacyProducts = useMemo(() => findLegacyProducts(catalog), [catalog]);
  const [chosenProductId, setChosenProductId] = useState<number | null>(null);
  // منتج واحد → تلقائي. أكتر → لازم اختيار. صفر → مفيش.
  const productId =
    legacyProducts.length === 1 ? legacyProducts[0].id : chosenProductId;
  const product = legacyProducts.find(p => p.id === productId) ?? null;
  const types = useMemo(
    () =>
      product
        ? catalog.variants.filter(v => v.productId === product.id && v.isActive !== false)
        : [],
    [catalog.variants, product]
  );

  const [typeId, setTypeId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState<string>("");
  const chosenType = types.find(t => t.id === typeId) ?? null;
  const defaultPrice = num(chosenType?.price ?? product?.price);
  const unitPrice = price.trim() === "" ? defaultPrice : num(price);

  function addLine() {
    if (!product || !chosenType) return;
    // نفس النوع بنفس السعر → زوّد الكمية بدل سطر مكرر.
    const idx = value.findIndex(
      it => it.productId === product.id && it.variantId === chosenType.id && it.unitPrice === unitPrice
    );
    if (idx >= 0) {
      onChange(value.map((it, i) => (i === idx ? { ...it, quantity: it.quantity + qty } : it)));
    } else {
      onChange([
        ...value,
        {
          productId: product.id,
          productName: product.name,
          variantId: chosenType.id,
          sku: chosenType.sku ?? null,
          color: null,
          size: null,
          optionLabel: chosenType.name ?? null,
          quantity: qty,
          unitPrice,
          availableStock: chosenType.currentStock ?? 0,
        },
      ]);
    }
    setTypeId(null);
    setQty(1);
    setPrice("");
  }

  const patch = (idx: number, p: Partial<PickedItem>) =>
    onChange(value.map((x, i) => (i === idx ? { ...x, ...p } : x)));

  /** سطر جاي من التحليل بلا نوع محسوم → الموظف يختار النوع من نفس المكان. */
  function pickTypeForLine(idx: number, variantId: number) {
    const v = catalog.variants.find(x => x.id === variantId);
    const p = v ? catalog.products.find(x => x.id === v.productId) : null;
    if (!v || !p) return;
    const it = value[idx];
    patch(idx, {
      productId: p.id,
      productName: p.name,
      variantId: v.id,
      sku: v.sku ?? null,
      optionLabel: v.name ?? null,
      unitPrice: it.unitPrice || num(v.price ?? p.price),
      availableStock: v.currentStock ?? 0,
      needsPick: false,
      needsVariantReview: false,
      pickReason: null,
    });
  }

  if (legacyProducts.length === 0) {
    return (
      <div className="rounded-md border border-[var(--warning)] bg-[var(--warning)]/5 p-3 text-sm text-[var(--warning)] flex items-center gap-2" data-testid="legacy-no-product">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        لا يوجد منتج بأنواع نقش في كتالوج نشاطك — راجع المنتجات أو اطلب تغيير قالب الإدخال.
      </div>
    );
  }

  return (
    <div className="space-y-3" data-testid="legacy-picker">
      {legacyProducts.length > 1 && (
        <div>
          <Label className="text-xs">المنتج</Label>
          <Select value={productId != null ? String(productId) : ""} onValueChange={v => { setChosenProductId(Number(v)); setTypeId(null); }}>
            <SelectTrigger className="mt-1" data-testid="legacy-product"><SelectValue placeholder="اختر المنتج" /></SelectTrigger>
            <SelectContent>
              {legacyProducts.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      {product && legacyProducts.length === 1 && (
        <div className="text-sm"><span className="text-muted-foreground">المنتج:</span> <span className="font-medium" data-testid="legacy-product-name">{product.name}</span></div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="col-span-2">
          <Label className="text-xs">نوع النقش</Label>
          <Select value={typeId != null ? String(typeId) : ""} onValueChange={v => setTypeId(Number(v))} disabled={!product}>
            <SelectTrigger className="mt-1" data-testid="legacy-type"><SelectValue placeholder="اختر نوع النقش" /></SelectTrigger>
            <SelectContent>
              {types.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs">الكمية</Label>
          <div className="mt-1 flex items-center gap-1">
            <Button type="button" size="icon" variant="outline" className="h-9 w-9 shrink-0" onClick={() => setQty(q => Math.max(1, q - 1))} aria-label="تقليل">−</Button>
            <Input type="number" min="1" value={qty} onChange={e => setQty(Math.max(1, parseInt(e.target.value || "1", 10) || 1))} className="h-9 text-center" data-testid="legacy-qty" />
            <Button type="button" size="icon" variant="outline" className="h-9 w-9 shrink-0" onClick={() => setQty(q => q + 1)} aria-label="زيادة">+</Button>
          </div>
        </div>
        <div>
          <Label className="text-xs">سعر القطعة</Label>
          <Input type="number" min="0" step="0.01" value={price} placeholder={String(defaultPrice)} onChange={e => setPrice(e.target.value)} className="mt-1 h-9" data-testid="legacy-price" />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">
          {chosenType
            ? <>{chosenType.name} ×{qty} = <b>{(unitPrice * qty).toFixed(2)}</b> ج.م{qty > (chosenType.currentStock ?? 0) && <span className="text-[var(--warning)]"> · تنبيه: المتاح {chosenType.currentStock ?? 0}</span>}</>
            : "اختر نوع النقش والكمية"}
        </span>
        <Button type="button" size="sm" onClick={addLine} disabled={!chosenType} data-testid="legacy-add">
          <Plus className="h-4 w-4 ml-1" /> إضافة
        </Button>
      </div>

      {value.length > 0 && (
        <div className="rounded-md border divide-y">
          {value.map((it, idx) => (
            <div key={idx} className={`flex flex-wrap items-center gap-2 p-2 text-sm ${it.needsPick || it.needsVariantReview ? "bg-[var(--warning)]/5" : ""}`} data-testid={`legacy-line-${idx}`}>
              {it.needsPick || it.needsVariantReview ? (
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <AlertTriangle className="h-4 w-4 text-[var(--warning)] shrink-0" />
                  <span className="text-xs text-[var(--warning)]">{it.pickReason ?? "اختر نوع النقش"}{it.productName ? ` («${it.productName}»)` : ""}</span>
                  <Select value="" onValueChange={v => pickTypeForLine(idx, Number(v))}>
                    <SelectTrigger className="h-8 w-40" data-testid={`legacy-line-pick-${idx}`}><SelectValue placeholder="اختر النوع" /></SelectTrigger>
                    <SelectContent>
                      {(types.length ? types : catalog.variants.filter(v => legacyProducts.some(p => p.id === v.productId))).map(t => (
                        <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <span className="font-medium flex-1 min-w-0 truncate">{it.optionLabel ?? it.productName}</span>
              )}
              <span className="text-muted-foreground">×</span>
              <Input type="number" min="1" value={it.quantity} onChange={e => patch(idx, { quantity: Math.max(1, parseInt(e.target.value || "1", 10) || 1) })} className="h-8 w-16 text-center" data-testid={`legacy-line-qty-${idx}`} />
              <span className="text-muted-foreground">@</span>
              <Input type="number" min="0" step="0.01" value={it.unitPrice} onChange={e => patch(idx, { unitPrice: Math.max(0, Number(e.target.value) || 0) })} className="h-8 w-20" data-testid={`legacy-line-price-${idx}`} />
              <span className="font-semibold w-20 text-left">{(it.unitPrice * it.quantity).toFixed(2)}</span>
              <button type="button" onClick={() => onChange(value.filter((_, i) => i !== idx))} aria-label="حذف" className="text-destructive"><X className="h-4 w-4" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
