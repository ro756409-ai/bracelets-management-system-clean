import { useMemo, useState } from "react";
import {
  ArrowLeftRight, Plus, Trash2, Send, AlertCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useBrandOptions } from "@/hooks/useBrandOptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageHeader, SectionCard } from "@/components/shared";
import { variantLabel, type CatalogVariant } from "@/components/orders/OrderItemsEditor";
import { toast } from "sonner";

/**
 * تحويل مخزون بين مخزنين — ومنها إرسال العهدة للورشة واستلام المشغول منها.
 *
 * الورشة مخزن عادي في `warehouses`، فالشاشة دي مش مخصوصة بيها: أي نقل بين أي مخزنين
 * بيمشي من هنا. مفيش كمية بتتخلق ولا بتتمسح — خروج من مكان ودخول لمكان بنفس التكلفة.
 */

type Line = { key: string; productId: string; variantId: string; quantity: string };

const newLine = (): Line => ({
  key: Math.random().toString(36).slice(2),
  productId: "", variantId: "", quantity: "1",
});

export default function StockTransfer() {
  const { currentBusinessIds } = useBusinessContext();

  const {
    brands, selected: businessId, setSelected: setBusinessId,
    selectedId: bid, isEmpty: noBrands,
  } = useBrandOptions();

  const [fromWarehouseId, setFromWarehouseId] = useState("");
  const [toWarehouseId, setToWarehouseId] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const warehouses = trpc.businesses.warehouses.useQuery(
    { businessId: bid! }, { enabled: Boolean(bid) }
  );
  const { data: products } = trpc.products.list.useQuery(
    currentBusinessIds && currentBusinessIds.length ? { businessIds: currentBusinessIds } : undefined
  );
  const { data: variants } = trpc.variants.all.useQuery(
    currentBusinessIds && currentBusinessIds.length ? { businessIds: currentBusinessIds } : undefined
  );

  const transferMutation = trpc.accountingV2.stockTransfer.useMutation({
    onSuccess: r => {
      toast.success(r.duplicate ? "الإذن ده اتسجّل قبل كده — مفيش تحويل اتكرر" : "تم التحويل");
      if (!r.duplicate) { setLines([newLine()]); setReference(""); setReason(""); }
    },
    onError: e => toast.error(e.message),
  });

  const patchLine = (key: string, changes: Partial<Line>) =>
    setLines(ls => ls.map(l => (l.key === key ? { ...l, ...changes } : l)));

  const variantsFor = (productId: string) =>
    ((variants ?? []) as CatalogVariant[]).filter(v => v.productId === Number(productId));

  const totalPieces = useMemo(
    () => lines.reduce((sum, l) => sum + (Number(l.quantity) || 0), 0),
    [lines]
  );

  const validate = () => {
    const next: Record<string, string> = {};
    if (!bid) next.businessId = noBrands ? "مفيش أنشطة متاحة" : "اختار النشاط";
    if (!fromWarehouseId) next.from = "اختار مكان الإرسال";
    if (!toWarehouseId) next.to = "اختار مكان الاستلام";
    if (fromWarehouseId && fromWarehouseId === toWarehouseId)
      next.to = "مكان الإرسال والاستلام لازم يكونوا مختلفين";
    if (!reference.trim()) next.reference = "رقم الإذن مطلوب — هو اللي بيمنع تكرار نفس التحويل";
    if (!reason.trim()) next.reason = "سبب التحويل مطلوب";
    lines.forEach((l, i) => {
      if (!l.productId) next[`line-${i}-product`] = "اختار الصنف";
      const vs = variantsFor(l.productId);
      if (vs.length > 0 && !l.variantId) next[`line-${i}-variant`] = "اختار النوع";
      if (l.variantId && !vs.some(v => v.id === Number(l.variantId)))
        next[`line-${i}-variant`] = "النوع ده مش تابع للصنف المختار";
      if (!(Number(l.quantity) > 0) || !Number.isInteger(Number(l.quantity)))
        next[`line-${i}-qty`] = "الكمية لازم تكون رقم صحيح أكبر من صفر";
    });
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = () => {
    if (!validate()) { toast.error("فيه حقول ناقصة — بُصّ على الرسايل الحمرا"); return; }
    transferMutation.mutate({
      businessId: bid!,
      fromWarehouseId: Number(fromWarehouseId),
      toWarehouseId: Number(toWarehouseId),
      reference: reference.trim(),
      reason: reason.trim(),
      occurredAt: new Date(occurredAt),
      lines: lines.map(l => ({
        productId: Number(l.productId),
        variantId: l.variantId ? Number(l.variantId) : null,
        quantity: Number(l.quantity),
      })),
    });
  };

  const showError = (k: string) =>
    errors[k] ? <p className="mt-1 text-xs text-destructive">{errors[k]}</p> : null;

  const wh = warehouses.data ?? [];

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="تحويل مخزون"
        description="نقل أصناف بين مخزنين — ومنها تسليم عهدة للورشة واستلام المشغول منها."
      />

      <SectionCard>
        <p className="mb-3 flex items-start gap-1.5 rounded-md bg-info/10 p-2 text-xs text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
          <span>
            التحويل بيطلع من مكان ويدخل مكان بنفس التكلفة — إجمالي المخزون وقيمته مابيتغيروش.
            لو الورشة ضافت شغل على الخامة، ده مصروف أو إذن استلام منفصل مش رقم بيتحط هنا.
          </span>
        </p>

        {noBrands && (
          <p className="mb-3 flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <span>مفيش أنشطة متاحة لحسابك، فمفيش مخازن تتحوّل بينها.</span>
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {brands.length > 1 && (
            <div>
              <Label>النشاط <span className="text-destructive">*</span></Label>
              <Select value={businessId} onValueChange={v => {
                setBusinessId(v); setFromWarehouseId(""); setToWarehouseId("");
              }}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="اختار النشاط" /></SelectTrigger>
                <SelectContent>
                  {brands.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {showError("businessId")}
            </div>
          )}
          <div>
            <Label>من <span className="text-destructive">*</span></Label>
            <Select value={fromWarehouseId} onValueChange={setFromWarehouseId} disabled={!bid}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={bid ? "مكان الإرسال" : "اختار النشاط الأول"} />
              </SelectTrigger>
              <SelectContent>
                {wh.map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {showError("from")}
          </div>
          <div>
            <Label>إلى <span className="text-destructive">*</span></Label>
            <Select value={toWarehouseId} onValueChange={setToWarehouseId} disabled={!bid}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={bid ? "مكان الاستلام" : "اختار النشاط الأول"} />
              </SelectTrigger>
              <SelectContent>
                {wh.filter(w => String(w.id) !== fromWarehouseId).map(w =>
                  <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {showError("to")}
          </div>
          <div>
            <Label>رقم الإذن <span className="text-destructive">*</span></Label>
            <Input className="mt-1" value={reference} dir="ltr" placeholder="TR-2026-007"
              onChange={e => setReference(e.target.value)} />
            {showError("reference")}
          </div>
          <div>
            <Label>التاريخ <span className="text-destructive">*</span></Label>
            <Input className="mt-1" type="date" value={occurredAt}
              onChange={e => setOccurredAt(e.target.value)} />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Label>سبب التحويل <span className="text-destructive">*</span></Label>
            <Textarea className="mt-1" rows={2} value={reason}
              placeholder="مثال: تسليم خام نحاس للورشة للحفر"
              onChange={e => setReason(e.target.value)} />
            {showError("reason")}
          </div>
        </div>
      </SectionCard>

      <SectionCard>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <ArrowLeftRight className="h-4 w-4" /> الأصناف المحوّلة
          </h3>
          <Button size="sm" variant="outline" className="gap-1.5"
            onClick={() => setLines(ls => [...ls, newLine()])}>
            <Plus className="h-4 w-4" /> صنف جديد
          </Button>
        </div>

        <div className="space-y-3">
          {lines.map((l, i) => {
            const vs = variantsFor(l.productId);
            return (
              <div key={l.key} className="rounded-lg border bg-muted/30 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-bold text-muted-foreground">صنف {i + 1}</span>
                  {lines.length > 1 && (
                    <Button size="sm" variant="ghost" className="h-7 gap-1 text-destructive"
                      onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}>
                      <Trash2 className="h-3.5 w-3.5" /> حذف
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <div>
                    <Label className="text-xs">الصنف <span className="text-destructive">*</span></Label>
                    <Select value={l.productId}
                      onValueChange={v => patchLine(l.key, { productId: v, variantId: "" })}>
                      <SelectTrigger className="mt-1 w-full min-w-0 [&>span]:truncate">
                        <SelectValue placeholder="اختار" />
                      </SelectTrigger>
                      <SelectContent>
                        {(products ?? []).map((p: any) =>
                          <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {showError(`line-${i}-product`)}
                  </div>
                  <div>
                    <Label className="text-xs">نوع الحفر / المقاس</Label>
                    <Select value={l.variantId} onValueChange={v => patchLine(l.key, { variantId: v })}
                      disabled={vs.length === 0}>
                      <SelectTrigger className="mt-1 w-full min-w-0 [&>span]:truncate">
                        <SelectValue placeholder={vs.length ? "اختار" : "مفيش أنواع"} />
                      </SelectTrigger>
                      <SelectContent>
                        {vs.map(v => <SelectItem key={v.id} value={String(v.id)}>{variantLabel(v)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {showError(`line-${i}-variant`)}
                  </div>
                  <div>
                    <Label className="text-xs">الكمية <span className="text-destructive">*</span></Label>
                    <Input className="mt-1" type="number" min="1" dir="ltr" value={l.quantity}
                      onChange={e => patchLine(l.key, { quantity: e.target.value })} />
                    {showError(`line-${i}-qty`)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button className="gap-1.5" onClick={submit} disabled={transferMutation.isPending}>
            <Send className="h-4 w-4" />
            {transferMutation.isPending ? "جاري التحويل..." : "تنفيذ التحويل"}
          </Button>
          <span className="text-sm text-muted-foreground">
            إجمالي القطع <strong className="tabular-nums text-foreground">{totalPieces}</strong>
          </span>
        </div>
      </SectionCard>
    </div>
  );
}
