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
import { Plus, Trash2, AlertTriangle, Sparkles } from "lucide-react";
import {
  variantDimensions,
  type Catalog,
  type CatalogProduct,
  type CatalogVariant,
  type PickedItem,
} from "./VariantOrderPicker";
import { applyTypeToLine, lineTotal, setLineQuantity, setManualPrice } from "@/lib/legacyLine";

/**
 * قالب الإدخال المبسّط (`bracelets_legacy`) — **Mobile-first**.
 *
 * كل صنف Card مستقل: نوع الحفر (قائمة بعرض كامل) | الكمية (− +) | سعر الوحدة | إجمالي السطر |
 * حذف. مفيش جدول أفقي على الشاشات الصغيرة، وكل عنصر لمس ≥ 44px. على الديسكتوب نفس
 * الكروت بتتصف في شبكة منظمة.
 *
 * مفيش سلة عامة ولا ألوان ولا مقاسات. المنتج بيتحدد **من البيانات** — المنتج اللي
 * تركيباته مميّزة بالنوع (`name`) بس — مش باسم مكتوب في الكود ولا بمعرّف نشاط.
 *
 * السطور الجاية من التحليل اقتراح: confident عادي، ambiguous/AI أصفر + سبب، unresolved أحمر
 * بنص الرسالة الأصلي. الموظفة هي المراجع النهائي: تضيف/تحذف/تغيّر النوع والكمية والسعر.
 * السعر له مصدر ومابيتستبدلش بسعر الكتالوج عند تغيير النوع/الكمية (`@/lib/legacyLine`).
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

/** ارتفاع/عرض لمس ≥ 44px لكل عنصر تفاعلي (h-11 = 44px). */
const TOUCH = "h-11 min-h-[44px]";

export function LegacyEngravingPicker({
  catalog,
  value,
  onChange,
  suggestedUnitPrice,
}: {
  catalog: Catalog;
  value: PickedItem[];
  onChange: (items: PickedItem[]) => void;
  /** سعر القطعة المقترح لسطر يدوي جديد (من الرسالة: إجمالي المنتجات ÷ عدد القطع) لما الكتالوج بلا سعر. */
  suggestedUnitPrice?: number | null;
}) {
  const legacyProducts = useMemo(() => findLegacyProducts(catalog), [catalog]);
  const [chosenProductId, setChosenProductId] = useState<number | null>(null);
  const productId = legacyProducts.length === 1 ? legacyProducts[0].id : chosenProductId;
  const product = legacyProducts.find(p => p.id === productId) ?? null;
  const types = useMemo(
    () => (product ? catalog.variants.filter(v => v.productId === product.id && v.isActive !== false) : []),
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
  // سطر يدوي جديد: سعر الكتالوج، ولو الكتالوج بلا سعر → سعر القطعة من الرسالة (مش صفر).
  const catalogPrice = num(chosenType?.price ?? product?.price);
  const defaultPrice = catalogPrice > 0 ? catalogPrice : num(suggestedUnitPrice);
  const unitPrice = price.trim() === "" ? defaultPrice : num(price);

  function addLine() {
    if (!product || !chosenType) return;
    const source: PickedItem["priceSource"] =
      price.trim() !== "" ? "manual" : catalogPrice > 0 ? "catalog" : "allocated";
    const idx = value.findIndex(it => it.productId === product.id && it.variantId === chosenType.id && it.unitPrice === unitPrice);
    if (idx >= 0) {
      onChange(value.map((it, i) => (i === idx ? { ...it, quantity: it.quantity + qty } : it)));
    } else {
      onChange([
        ...value,
        {
          productId: product.id, productName: product.name, variantId: chosenType.id, sku: chosenType.sku ?? null,
          color: null, size: null, optionLabel: chosenType.name ?? null, quantity: qty, unitPrice,
          availableStock: chosenType.currentStock ?? 0, priceSource: source, confidence: "confident",
        },
      ]);
    }
    setTypeId(null); setQty(1); setPrice("");
  }

  const replaceAt = (idx: number, next: PickedItem) => onChange(value.map((x, i) => (i === idx ? next : x)));

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

  // أحمر = غير محلول؛ أصفر = غامض أو اقتراح AI (اقتراح لحد ما الموظفة تراجعه).
  const tone = (it: PickedItem) =>
    it.needsPick || it.needsVariantReview || it.confidence === "unresolved"
      ? "border-destructive/40 bg-destructive/5"
      : it.confidence === "ambiguous" || it.aiAssisted
        ? "border-[var(--warning)]/50 bg-[var(--warning)]/10"
        : "border-border bg-card";

  return (
    <div className="space-y-3 min-w-0" data-testid="legacy-picker">
      {legacyProducts.length > 1 && (
        <div>
          <Label className="text-xs">المنتج</Label>
          <Select value={productId != null ? String(productId) : ""} onValueChange={v => { setChosenProductId(Number(v)); setTypeId(null); }}>
            <SelectTrigger className={`mt-1 w-full ${TOUCH}`} data-testid="legacy-product"><SelectValue placeholder="اختر المنتج" /></SelectTrigger>
            <SelectContent>
              {legacyProducts.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
      {product && legacyProducts.length === 1 && (
        <div className="text-sm"><span className="text-muted-foreground">المنتج:</span> <span className="font-medium" data-testid="legacy-product-name">{product.name}</span></div>
      )}

      {/* إضافة صنف يدوي — بعرض كامل على الموبايل، صف واحد على الديسكتوب */}
      <div className="rounded-lg border bg-muted/20 p-3 space-y-2 sm:grid sm:grid-cols-[1fr_9rem_8rem_auto] sm:items-end sm:gap-2 sm:space-y-0" data-testid="legacy-add-form">
        <div className="min-w-0">
          <Label className="text-xs">نوع النقش</Label>
          <Select value={typeId != null ? String(typeId) : ""} onValueChange={v => setTypeId(Number(v))} disabled={!product}>
            <SelectTrigger className={`mt-1 w-full ${TOUCH}`} data-testid="legacy-type"><SelectValue placeholder="اختر نوع النقش" /></SelectTrigger>
            <SelectContent>
              {types.map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-0">
          <Label className="text-xs">الكمية</Label>
          <div className="mt-1 flex items-center gap-1">
            <Button type="button" variant="outline" className={`w-11 shrink-0 px-0 ${TOUCH}`} onClick={() => setQty(q => Math.max(1, q - 1))} aria-label="تقليل">−</Button>
            <Input type="number" inputMode="numeric" min="1" value={qty} onChange={e => setQty(Math.max(1, parseInt(e.target.value || "1", 10) || 1))} className={`text-center ${TOUCH}`} data-testid="legacy-qty" />
            <Button type="button" variant="outline" className={`w-11 shrink-0 px-0 ${TOUCH}`} onClick={() => setQty(q => q + 1)} aria-label="زيادة">+</Button>
          </div>
        </div>
        <div className="min-w-0">
          <Label className="text-xs">سعر القطعة</Label>
          <Input type="number" inputMode="decimal" min="0" step="0.01" value={price} placeholder={String(defaultPrice)} onChange={e => setPrice(e.target.value)} className={`mt-1 ${TOUCH}`} data-testid="legacy-price" />
        </div>
        <Button type="button" className={`w-full sm:w-auto ${TOUCH}`} onClick={addLine} disabled={!chosenType} data-testid="legacy-add">
          <Plus className="h-4 w-4 ml-1" /> إضافة
        </Button>
      </div>

      {value.length > 0 && (
        <div className="space-y-2" data-testid="legacy-lines">
          {/* عناوين الأعمدة — للديسكتوب؛ على الموبايل كل كارت بيحمل تسمياته */}
          <div className="hidden sm:grid sm:grid-cols-[1fr_9rem_8rem_6rem_2.75rem] gap-2 px-3 text-[11px] font-medium text-muted-foreground">
            <span>نوع الحفر</span><span className="text-center">الكمية</span><span className="text-center">سعر الوحدة</span><span className="text-left">إجمالي السطر</span><span />
          </div>
          {value.map((it, idx) => {
            const unresolved = it.needsPick || it.needsVariantReview || it.confidence === "unresolved";
            return (
              <div
                key={idx}
                className={`rounded-lg border p-3 min-w-0 sm:grid sm:grid-cols-[1fr_9rem_8rem_6rem_2.75rem] sm:items-center sm:gap-2 ${tone(it)}`}
                data-testid={`legacy-line-${idx}`}
                data-confidence={it.confidence ?? "confident"}
                data-price-source={it.priceSource ?? ""}
              >
                {/* نوع الحفر */}
                <div className="min-w-0">
                  <Label className="text-[11px] text-muted-foreground sm:hidden">نوع الحفر</Label>
                  <Select value={!unresolved && it.variantId != null ? String(it.variantId) : ""} onValueChange={v => pickTypeForLine(idx, Number(v))}>
                    <SelectTrigger className={`mt-1 w-full font-medium sm:mt-0 ${TOUCH}`} data-testid={unresolved ? `legacy-line-pick-${idx}` : `legacy-line-type-${idx}`}>
                      <SelectValue placeholder={unresolved ? "اختر النوع" : (it.optionLabel ?? it.productName)} />
                    </SelectTrigger>
                    <SelectContent>
                      {typeOptions(it).map(t => <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {unresolved ? (
                    <div className="mt-1 flex items-start gap-1 text-[11px] text-destructive">
                      <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                      <span className="min-w-0 break-words">
                        {it.pickReason ?? "اختر نوع النقش"}
                        {it.segmentText && <span className="text-muted-foreground" data-testid={`legacy-line-segment-${idx}`}> — من الرسالة: «{it.segmentText}»</span>}
                      </span>
                    </div>
                  ) : it.aiAssisted ? (
                    <div className="mt-1 flex items-start gap-1 text-[11px] text-[var(--warning)]" data-testid={`legacy-line-ai-${idx}`}>
                      <Sparkles className="h-3 w-3 shrink-0 mt-0.5" />
                      <span className="min-w-0 break-words">اقتراح AI — راجع الاختيار{it.segmentText ? ` (من الرسالة: «${it.segmentText}»)` : ""}</span>
                    </div>
                  ) : it.confidence === "ambiguous" ? (
                    <div className="mt-1 flex items-start gap-1 text-[11px] text-[var(--warning)]" data-testid={`legacy-line-review-${idx}`}>
                      <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
                      <span className="min-w-0 break-words">{it.pickReason ?? "راجع النوع"}{it.segmentText ? ` — من الرسالة: «${it.segmentText}»` : ""}</span>
                    </div>
                  ) : null}
                </div>

                {/* الكمية والسعر والإجمالي والحذف — صف واحد على الموبايل، أعمدة على الديسكتوب */}
                <div className="mt-2 grid grid-cols-[1fr_1fr] gap-2 sm:contents">
                  <div className="min-w-0">
                    <Label className="text-[11px] text-muted-foreground sm:hidden">الكمية</Label>
                    <div className="mt-1 flex items-center gap-1 sm:mt-0">
                      <Button type="button" variant="outline" className={`w-11 shrink-0 px-0 ${TOUCH}`} onClick={() => replaceAt(idx, setLineQuantity(it, it.quantity - 1))} aria-label="تقليل" data-testid={`legacy-line-qty-minus-${idx}`}>−</Button>
                      <Input type="number" inputMode="numeric" min="1" value={it.quantity} onChange={e => replaceAt(idx, setLineQuantity(it, Number(e.target.value)))} className={`w-full min-w-0 text-center ${TOUCH}`} data-testid={`legacy-line-qty-${idx}`} />
                      <Button type="button" variant="outline" className={`w-11 shrink-0 px-0 ${TOUCH}`} onClick={() => replaceAt(idx, setLineQuantity(it, it.quantity + 1))} aria-label="زيادة" data-testid={`legacy-line-qty-plus-${idx}`}>+</Button>
                    </div>
                  </div>
                  <div className="min-w-0">
                    <Label className="text-[11px] text-muted-foreground sm:hidden">سعر الوحدة</Label>
                    <Input
                      type="number" inputMode="decimal" min="0" step="0.01" value={it.unitPrice}
                      onChange={e => replaceAt(idx, setManualPrice(it, Number(e.target.value)))}
                      className={`mt-1 w-full min-w-0 sm:mt-0 ${TOUCH}`}
                      title={it.priceSource === "manual" ? "سعر يدوي" : it.priceSource === "allocated" ? "موزَّع من إجمالي الرسالة" : it.priceSource === "message" ? "مذكور في الرسالة" : "سعر الكتالوج"}
                      data-testid={`legacy-line-price-${idx}`}
                    />
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 sm:contents">
                  <div className="min-w-0 sm:text-left">
                    <span className="text-[11px] text-muted-foreground sm:hidden">إجمالي السطر: </span>
                    <span className="font-semibold tabular-nums" data-testid={`legacy-line-total-${idx}`}>{lineTotal(it).toFixed(2)}</span>
                    <span className="text-[11px] text-muted-foreground sm:hidden"> ج.م</span>
                  </div>
                  <Button type="button" variant="ghost" className={`w-11 shrink-0 px-0 text-destructive ${TOUCH}`} onClick={() => onChange(value.filter((_, i) => i !== idx))} aria-label="حذف" data-testid={`legacy-line-delete-${idx}`}>
                    <Trash2 className="h-5 w-5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
