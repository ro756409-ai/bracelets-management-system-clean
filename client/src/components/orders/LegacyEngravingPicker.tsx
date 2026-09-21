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
import { Plus, X, AlertTriangle, Sparkles } from "lucide-react";
import {
  variantDimensions,
  type Catalog,
  type CatalogProduct,
  type CatalogVariant,
  type PickedItem,
} from "./VariantOrderPicker";
import { applyTypeToLine, lineTotal, setLineQuantity, setManualPrice } from "@/lib/legacyLine";

/**
 * قالب الإدخال المبسّط (`bracelets_legacy`): «نوع الحفر | الكمية | سعر الوحدة | إجمالي السطر».
 *
 * مفيش سلة عامة ولا ألوان ولا مقاسات. المنتج بيتحدد **من البيانات** — المنتج اللي
 * تركيباته مميّزة بالنوع (`name`) بس — مش باسم مكتوب في الكود ولا بمعرّف نشاط. لو
 * النشاط عنده منتج واحد كده بيتختار تلقائيًا؛ أكتر من واحد → قائمة؛ صفر → رسالة.
 *
 * السطور الجاية من التحليل بتحمل ثقة: confident عادي، ambiguous أصفر + سبب، unresolved
 * بيعرض نص الرسالة الأصلي والموظف يختار النوع. السعر له مصدر ومابيتستبدلش بسعر الكتالوج
 * عند تغيير النوع/الكمية (قواعد `@/lib/legacyLine`).
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
  const allLegacyTypes = useMemo(
    () => catalog.variants.filter(v => v.isActive !== false && legacyProducts.some(p => p.id === v.productId)),
    [catalog.variants, legacyProducts]
  );

  const [typeId, setTypeId] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [price, setPrice] = useState<string>("");
  const chosenType = types.find(t => t.id === typeId) ?? null;
  const defaultPrice = num(chosenType?.price ?? product?.price);
  const unitPrice = price.trim() === "" ? defaultPrice : num(price);

  function addLine() {
    if (!product || !chosenType) return;
    // سطر يدوي جديد: سعر الكتالوج افتراضيًا (catalog)، أو اللي الموظف كتبه (manual).
    const source: PickedItem["priceSource"] = price.trim() === "" ? "catalog" : "manual";
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
          priceSource: source,
          confidence: "confident",
        },
      ]);
    }
    setTypeId(null);
    setQty(1);
    setPrice("");
  }

  const replaceAt = (idx: number, next: PickedItem) =>
    onChange(value.map((x, i) => (i === idx ? next : x)));

  /** اختيار/تغيير النوع لسطر — السعر اللي له مصدر بيفضل زي ما هو. */
  function pickTypeForLine(idx: number, variantId: number) {
    const v = catalog.variants.find(x => x.id === variantId);
    const p = v ? catalog.products.find(x => x.id === v.productId) : null;
    if (!v || !p) return;
    replaceAt(idx, applyTypeToLine(value[idx], v, p));
  }

  if (legacyProducts.length === 0) {
    return (
      <div className="rounded-md border border-[var(--warning)] bg-[var(--warning)]/5 p-3 text-sm text-[var(--warning)] flex items-center gap-2" data-testid="legacy-no-product">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        لا يوجد منتج بأنواع نقش في كتالوج نشاطك — راجع المنتجات أو اطلب تغيير قالب الإدخال.
      </div>
    );
  }

  const typeOptions = (line: PickedItem): CatalogVariant[] => {
    const scoped = line.productId ? allLegacyTypes.filter(t => t.productId === line.productId) : [];
    return scoped.length ? scoped : types.length ? types : allLegacyTypes;
  };

  const rowTone = (it: PickedItem) =>
    it.needsPick || it.needsVariantReview || it.confidence === "unresolved"
      ? "bg-destructive/5"
      : it.confidence === "ambiguous"
        ? "bg-[var(--warning)]/10"
        : "";

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
        <div className="rounded-md border overflow-hidden" data-testid="legacy-lines">
          <div className="grid grid-cols-[1fr_4.5rem_5.5rem_5.5rem_2rem] gap-2 bg-muted/50 px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
            <span>نوع الحفر</span><span className="text-center">الكمية</span><span className="text-center">سعر الوحدة</span><span className="text-left">إجمالي السطر</span><span />
          </div>
          <div className="divide-y">
            {value.map((it, idx) => {
              const unresolved = it.needsPick || it.needsVariantReview || it.confidence === "unresolved";
              return (
                <div key={idx} className={`grid grid-cols-[1fr_4.5rem_5.5rem_5.5rem_2rem] items-center gap-2 p-2 text-sm ${rowTone(it)}`} data-testid={`legacy-line-${idx}`} data-confidence={it.confidence ?? "confident"} data-price-source={it.priceSource ?? ""}>
                  <div className="min-w-0">
                    {unresolved ? (
                      <div className="space-y-1">
                        <div className="flex items-center gap-1 text-xs text-destructive">
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{it.pickReason ?? "اختر نوع النقش"}</span>
                        </div>
                        {it.segmentText && <div className="text-xs text-muted-foreground truncate" data-testid={`legacy-line-segment-${idx}`}>من الرسالة: «{it.segmentText}»</div>}
                        <Select value="" onValueChange={v => pickTypeForLine(idx, Number(v))}>
                          <SelectTrigger className="h-8 w-full" data-testid={`legacy-line-pick-${idx}`}><SelectValue placeholder="اختر النوع" /></SelectTrigger>
                          <SelectContent>
                            {typeOptions(it).map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : (
                      <div className="min-w-0">
                        <Select value={it.variantId != null ? String(it.variantId) : ""} onValueChange={v => pickTypeForLine(idx, Number(v))}>
                          <SelectTrigger className="h-8 w-full font-medium" data-testid={`legacy-line-type-${idx}`}><SelectValue placeholder={it.optionLabel ?? it.productName} /></SelectTrigger>
                          <SelectContent>
                            {typeOptions(it).map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {it.confidence === "ambiguous" && (
                          <div className="mt-1 flex items-center gap-1 text-[11px] text-[var(--warning)]" data-testid={`legacy-line-review-${idx}`}>
                            {it.aiAssisted ? <Sparkles className="h-3 w-3 shrink-0" /> : <AlertTriangle className="h-3 w-3 shrink-0" />}
                            <span className="truncate">{it.pickReason ?? "راجع النوع"}{it.segmentText ? ` — من الرسالة: «${it.segmentText}»` : ""}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  <Input type="number" min="1" value={it.quantity} onChange={e => replaceAt(idx, setLineQuantity(it, Number(e.target.value)))} className="h-8 text-center" data-testid={`legacy-line-qty-${idx}`} />
                  <Input type="number" min="0" step="0.01" value={it.unitPrice} onChange={e => replaceAt(idx, setManualPrice(it, Number(e.target.value)))} className="h-8" title={it.priceSource === "manual" ? "سعر يدوي" : it.priceSource === "allocated" ? "موزَّع من إجمالي الرسالة" : it.priceSource === "message" ? "مذكور في الرسالة" : "سعر الكتالوج"} data-testid={`legacy-line-price-${idx}`} />
                  <span className="font-semibold text-left tabular-nums" data-testid={`legacy-line-total-${idx}`}>{lineTotal(it).toFixed(2)}</span>
                  <button type="button" onClick={() => onChange(value.filter((_, i) => i !== idx))} aria-label="حذف" className="text-destructive justify-self-center"><X className="h-4 w-4" /></button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
