import { useMemo, useState } from "react";
import {
  RotateCcw, Plus, Trash2, Send, PackageCheck, AlertCircle, RefreshCw,
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
 * مرتجعات الورشة.
 *
 * القطعة المرفوضة بتروح الورشة تتصلّح وبترجع. الاتنين **تحويل مخزون** بين مخزن المكتب
 * ومخزن الورشة — نفس `transferStock` اللي موجود، مفيش مسار جديد ومفيش جدول مرتجعات.
 *
 * والحالة **مشتقّة**: الدفعة «عند الورشة» طول ما مفيش تحويل راجع بيشاور على رقمها. عمود
 * حالة كان ممكن يقول «رجعت» والمخزون بيقول العكس؛ الاشتقاق مستحيل يختلف عن الحركة اللي
 * هو مبني عليها.
 *
 * تكلفة الإصلاح بتتسجّل مع الدفعة **للعلم بس** — مابتعملش مصروف ولا بتلمس خزنة. المصروف
 * بيتسجّل لوحده من شاشة المصروفات لما الورشة تتحاسب فعلًا.
 */

const money = (n: number) =>
  Number(n || 0).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Line = { key: string; productId: string; variantId: string; quantity: string };

const newLine = (): Line => ({
  key: Math.random().toString(36).slice(2),
  productId: "", variantId: "", quantity: "1",
});

export default function WorkshopReturns() {
  const { currentBusinessIds } = useBusinessContext();
  const {
    brands, selected: businessId, setSelected: setBusinessId,
    selectedId: bid, isEmpty: noBrands,
  } = useBrandOptions();

  const [officeWarehouseId, setOfficeWarehouseId] = useState("");
  const [workshopWarehouseId, setWorkshopWarehouseId] = useState("");
  const [reference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [repairCost, setRepairCost] = useState("");
  const [occurredAt, setOccurredAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const warehouses = trpc.businesses.warehouses.useQuery(
    { businessId: bid! }, { enabled: Boolean(bid) }
  );
  const { data: products } = trpc.products.list.useQuery(
    currentBusinessIds?.length ? { businessIds: currentBusinessIds } : undefined
  );
  const { data: variants } = trpc.variants.all.useQuery(
    currentBusinessIds?.length ? { businessIds: currentBusinessIds } : undefined
  );

  const batches = trpc.accountingV2.workshopReturns.useQuery(
    { businessId: bid!, workshopWarehouseId: Number(workshopWarehouseId) },
    { enabled: Boolean(bid) && Boolean(workshopWarehouseId), retry: false }
  );

  const transfer = trpc.accountingV2.stockTransfer.useMutation({
    onError: e => toast.error(e.message),
  });

  const productName = (id: number) =>
    (products ?? []).find((p: any) => p.id === id)?.name ?? `#${id}`;
  const variantName = (id?: number | null) => {
    if (id == null) return null;
    const v = ((variants ?? []) as CatalogVariant[]).find(x => x.id === id);
    return v ? variantLabel(v) : `#${id}`;
  };
  const variantsFor = (productId: string) =>
    ((variants ?? []) as CatalogVariant[]).filter(v => v.productId === Number(productId));

  const patch = (key: string, changes: Partial<Line>) =>
    setLines(ls => ls.map(l => (l.key === key ? { ...l, ...changes } : l)));

  const totalPieces = useMemo(
    () => lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0),
    [lines]
  );

  const validate = () => {
    const next: Record<string, string> = {};
    if (!bid) next.businessId = noBrands ? "مفيش أنشطة متاحة" : "اختار النشاط";
    if (!officeWarehouseId) next.office = "اختار المخزن اللي المرتجع طالع منه";
    if (!workshopWarehouseId) next.workshop = "اختار مخزن الورشة";
    if (officeWarehouseId && officeWarehouseId === workshopWarehouseId)
      next.workshop = "المخزنين لازم يكونوا مختلفين";
    if (!reference.trim()) next.reference = "رقم الإذن مطلوب — هو اللي بيربط الإرسال بالرجوع";
    if (!reason.trim()) next.reason = "سبب المرتجع مطلوب";
    if (repairCost !== "" && Number(repairCost) < 0) next.repairCost = "التكلفة ماتكونش بالسالب";
    lines.forEach((l, i) => {
      if (!l.productId) next[`l${i}-p`] = "اختار الصنف";
      const vs = variantsFor(l.productId);
      if (vs.length > 0 && !l.variantId) next[`l${i}-v`] = "اختار النوع";
      if (l.variantId && !vs.some(v => v.id === Number(l.variantId)))
        next[`l${i}-v`] = "النوع ده مش تابع للصنف المختار";
      const q = Number(l.quantity);
      if (!(q > 0) || !Number.isInteger(q)) next[`l${i}-q`] = "الكمية لازم تكون رقم صحيح أكبر من صفر";
    });
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const send = () => {
    if (!validate()) { toast.error("فيه حقول ناقصة — بُصّ على الرسايل الحمرا"); return; }
    transfer.mutate({
      businessId: bid!,
      fromWarehouseId: Number(officeWarehouseId),
      toWarehouseId: Number(workshopWarehouseId),
      reference: reference.trim(),
      reason: reason.trim(),
      occurredAt: new Date(occurredAt),
      repairCostPerPiece: repairCost ? Number(repairCost).toFixed(4) : undefined,
      lines: lines.map(l => ({
        productId: Number(l.productId),
        variantId: l.variantId ? Number(l.variantId) : null,
        quantity: Number(l.quantity),
      })),
    }, {
      onSuccess: r => {
        toast.success(r.duplicate ? "الإذن ده اتسجّل قبل كده" : "المرتجع راح الورشة");
        if (!r.duplicate) {
          setLines([newLine()]); setReference(""); setReason(""); setRepairCost("");
        }
        batches.refetch();
      },
    });
  };

  /** الرجوع: نفس البنود بالعكس، وبيشاور على رقم إذن الإرسال فبيقفله. */
  const receiveBack = (batch: any) => {
    transfer.mutate({
      businessId: bid!,
      fromWarehouseId: Number(workshopWarehouseId),
      toWarehouseId: Number(officeWarehouseId),
      reference: `${batch.reference}-R`,
      reason: `استلام المشغول — ${batch.reference}`,
      occurredAt: new Date(),
      linkedReference: batch.reference,
      lines: batch.lines,
    }, {
      onSuccess: r => {
        toast.success(r.duplicate ? "اترجّع قبل كده" : "رجع من الورشة للمخزن");
        batches.refetch();
      },
    });
  };

  const showError = (k: string) =>
    errors[k] ? <p className="mt-1 text-xs text-destructive">{errors[k]}</p> : null;

  const wh = warehouses.data ?? [];
  const rows = batches.data ?? [];

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="مرتجعات الورشة"
        description="القطع المرفوضة بتروح الورشة تتصلّح وبترجع. الاتنين تحويل مخزون — مفيش كمية بتتخلق ولا بتتمسح."
      />

      <SectionCard>
        {noBrands && (
          <p className="mb-3 flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <span>مفيش أنشطة متاحة لحسابك.</span>
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {brands.length > 1 && (
            <div>
              <Label>النشاط <span className="text-destructive">*</span></Label>
              <Select value={businessId} onValueChange={v => {
                setBusinessId(v); setOfficeWarehouseId(""); setWorkshopWarehouseId("");
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
            <Label>مخزن المكتب <span className="text-destructive">*</span></Label>
            <Select value={officeWarehouseId} onValueChange={setOfficeWarehouseId} disabled={!bid}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={bid ? "المخزن الأساسي" : "اختار النشاط الأول"} />
              </SelectTrigger>
              <SelectContent>
                {wh.map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {showError("office")}
          </div>
          <div>
            <Label>مخزن الورشة <span className="text-destructive">*</span></Label>
            <Select value={workshopWarehouseId} onValueChange={setWorkshopWarehouseId} disabled={!bid}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={bid ? "الورشة" : "اختار النشاط الأول"} />
              </SelectTrigger>
              <SelectContent>
                {wh.filter(w => String(w.id) !== officeWarehouseId).map(w =>
                  <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {showError("workshop")}
          </div>
          <div>
            <Label>رقم الإذن <span className="text-destructive">*</span></Label>
            <Input className="mt-1" dir="ltr" placeholder="RET-2026-014" value={reference}
              onChange={e => setReference(e.target.value)} />
            {showError("reference")}
          </div>
          <div>
            <Label>التاريخ <span className="text-destructive">*</span></Label>
            <Input className="mt-1" type="date" value={occurredAt}
              onChange={e => setOccurredAt(e.target.value)} />
          </div>
          <div>
            <Label>تكلفة الإصلاح للقطعة</Label>
            <Input className="mt-1" type="number" min="0" step="0.01" dir="ltr" placeholder="0.00"
              value={repairCost} onChange={e => setRepairCost(e.target.value)} />
            {showError("repairCost")}
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Label>سبب المرتجع <span className="text-destructive">*</span></Label>
            <Textarea className="mt-1" rows={2} value={reason}
              placeholder="مثال: حفر مش واضح — إعادة تشطيب"
              onChange={e => setReason(e.target.value)} />
            {showError("reason")}
          </div>
        </div>

        <p className="mt-3 flex items-start gap-1.5 rounded-md bg-info/10 p-2 text-xs text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info" />
          <span>
            تكلفة الإصلاح رقم للعلم بس — <strong className="text-foreground">مابتخصمش من الخزنة
            ومابتتسجّلش كمصروف</strong>. سجّلها مصروف من شاشة المصروفات لما تحاسب الورشة فعلًا.
          </span>
        </p>
      </SectionCard>

      <SectionCard>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <RotateCcw className="h-4 w-4" /> القطع الراجعة للورشة
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
                      onValueChange={v => patch(l.key, { productId: v, variantId: "" })}>
                      <SelectTrigger className="mt-1 w-full min-w-0 [&>span]:truncate">
                        <SelectValue placeholder="اختار" />
                      </SelectTrigger>
                      <SelectContent>
                        {(products ?? []).map((p: any) =>
                          <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {showError(`l${i}-p`)}
                  </div>
                  <div>
                    <Label className="text-xs">نوع الحفر</Label>
                    <Select value={l.variantId} onValueChange={v => patch(l.key, { variantId: v })}
                      disabled={vs.length === 0}>
                      <SelectTrigger className="mt-1 w-full min-w-0 [&>span]:truncate">
                        <SelectValue placeholder={vs.length ? "اختار" : "مفيش أنواع"} />
                      </SelectTrigger>
                      <SelectContent>
                        {vs.map(v => <SelectItem key={v.id} value={String(v.id)}>{variantLabel(v)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {showError(`l${i}-v`)}
                  </div>
                  <div>
                    <Label className="text-xs">العدد <span className="text-destructive">*</span></Label>
                    <Input className="mt-1" type="number" min="1" dir="ltr" value={l.quantity}
                      onChange={e => patch(l.key, { quantity: e.target.value })} />
                    {showError(`l${i}-q`)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button className="gap-1.5" onClick={send} disabled={transfer.isPending}>
            <Send className="h-4 w-4" />
            {transfer.isPending ? "جاري الإرسال..." : "إرسال للورشة"}
          </Button>
          <span className="text-sm text-muted-foreground">
            إجمالي القطع <strong className="tabular-nums text-foreground">{totalPieces}</strong>
            {repairCost && (
              <> · تكلفة إصلاح متوقعة{" "}
                <strong className="tabular-nums text-foreground">
                  {money(totalPieces * Number(repairCost))}
                </strong> ج.م</>
            )}
          </span>
        </div>
      </SectionCard>

      <SectionCard>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold">دفعات المرتجع</h3>
          <Button size="sm" variant="outline" className="gap-1.5"
            onClick={() => batches.refetch()} disabled={batches.isFetching}>
            <RefreshCw className={`h-4 w-4 ${batches.isFetching ? "animate-spin" : ""}`} /> تحديث
          </Button>
        </div>

        {!workshopWarehouseId ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            اختار مخزن الورشة عشان تشوف الدفعات.
          </p>
        ) : batches.isError ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-bold text-destructive">مش قادر أجيب دفعات المرتجع</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{batches.error?.message}</p>
            </div>
          </div>
        ) : batches.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map(i => <div key={i} className="h-12 animate-pulse rounded bg-muted" />)}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">مفيش مرتجعات لسه.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b text-right text-xs text-muted-foreground">
                  <th className="p-2">التاريخ</th>
                  <th className="p-2">رقم الإذن</th>
                  <th className="p-2">الصنف / النوع</th>
                  <th className="p-2">العدد</th>
                  <th className="p-2">تكلفة الإصلاح للقطعة</th>
                  <th className="p-2">الإجمالي</th>
                  <th className="p-2">الحالة</th>
                  <th className="p-2">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b: any) => (
                  <tr key={b.reference} className="border-b align-top last:border-0">
                    <td className="p-2 whitespace-nowrap tabular-nums">
                      {new Date(b.sentAt).toLocaleDateString("ar-EG")}
                    </td>
                    <td className="p-2 whitespace-nowrap" dir="ltr">{b.reference}</td>
                    <td className="p-2">
                      {b.lines.map((l: any, i: number) => (
                        <span key={i} className="block text-xs">
                          {productName(l.productId)}
                          {variantName(l.variantId) && ` — ${variantName(l.variantId)}`}
                          <span className="text-muted-foreground"> ×{l.quantity}</span>
                        </span>
                      ))}
                    </td>
                    <td className="p-2 tabular-nums">{b.quantity}</td>
                    <td className="p-2 tabular-nums">{money(b.repairCostPerPiece)}</td>
                    <td className="p-2 tabular-nums font-semibold">{money(b.repairCostTotal)}</td>
                    <td className="p-2 whitespace-nowrap text-xs font-bold"
                      style={{ color: b.status === "received" ? "var(--success)" : "var(--warning)" }}>
                      {b.status === "received" ? "تم الاستلام" : "عند الورشة"}
                      {b.receivedAt && (
                        <span className="block font-normal text-muted-foreground">
                          {new Date(b.receivedAt).toLocaleDateString("ar-EG")}
                        </span>
                      )}
                    </td>
                    <td className="p-2">
                      {b.status === "at_workshop" && (
                        <Button size="sm" className="h-7 gap-1 text-xs"
                          disabled={!officeWarehouseId || transfer.isPending}
                          onClick={() => receiveBack(b)}>
                          <PackageCheck className="h-3.5 w-3.5" /> استلام المرتجع
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            الحالة مقروءة من الحركات نفسها مش محفوظة في عمود — الدفعة «عند الورشة» طول ما
            مفيش تحويل راجع بيشاور على رقمها. مفيش حركة بتتمسح ولا بتتعدّل.
          </span>
        </p>
      </SectionCard>
    </div>
  );
}
