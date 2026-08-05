import { useEffect, useMemo, useState } from "react";
import {
  PackagePlus, Plus, Trash2, Save, CheckCircle2, XCircle, RefreshCw, AlertCircle,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
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
import {
  lineFinalUnitCost, lineTotal, documentTotal, type ReceiptLineInput,
} from "@shared/purchaseTotals";

/**
 * إذن استلام بضاعة.
 *
 * الشاشة دي واجهة على `inventoryV2.service` اللي موجود من الأصل — createPurchaseReceiptDraft
 * ثم submit ثم approve. مفيش محرك مخزون ولا طريقة تكلفة جديدة هنا: الاعتماد بيمشي على
 * applyStockIn (متوسط مرجّح) وبيكتب inventory_transactions، والشاشة مابتلمسش رصيد بشكل مباشر.
 *
 * الخصم والتكلفة الإضافية بيتحسبوا هنا وبيتحوّلوا لتكلفة وحدة نهائية، لأن
 * purchase_receipt_items لسه مافيهاش أعمدة تخزّن التفصيلة. الإجمالي وقيمة المخزون بيطلعوا
 * مضبوطين، واللي بيضيع هو التفصيلة نفسها لحد ما تتعمل الـmigration — والشاشة بتقول كده صراحة.
 */

const money = (n: number) =>
  n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Line = ReceiptLineInput & { key: string; productId: string; variantId: string };

const newLine = (): Line => ({
  key: Math.random().toString(36).slice(2),
  productId: "", variantId: "", quantity: "1", unitCost: "", discount: "", extraCost: "",
});

const STATUS_LABEL: Record<string, string> = {
  draft: "مسودة",
  pending_approval: "بانتظار الاعتماد",
  approved: "معتمد",
  voided: "ملغي",
};

export default function GoodsReceipt() {
  const { businesses, currentBusinessIds } = useBusinessContext();
  const utils = trpc.useUtils();

  const [businessId, setBusinessId] = useState("");
  const bid = Number(businessId) || undefined;

  // لازم effect مش قيمة ابتدائية: قائمة الأنشطة بتيجي من استعلام، فأول رندر بتكون فاضية
  // والقيمة الابتدائية بتتقفل على "" وماتتحدّثش أبدًا — وساعتها كل اللي تحت بيفضل مقفول.
  useEffect(() => {
    if (businessId || businesses.length !== 1) return;
    setBusinessId(String(businesses[0].id));
  }, [businesses, businessId]);

  const [warehouseId, setWarehouseId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [reference, setReference] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [receiptDate, setReceiptDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [evidenceUrl, setEvidenceUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [headerDiscount, setHeaderDiscount] = useState("");
  const [headerShipping, setHeaderShipping] = useState("");
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
  const control = trpc.accountingV2.inventoryControlData.useQuery(
    { businessId: bid! }, { enabled: Boolean(bid) }
  );

  const receipts = useMemo(
    () => [...(control.data?.receipts ?? [])].reverse(),
    [control.data?.receipts]
  );

  const refresh = () => { control.refetch(); };

  const createMutation = trpc.accountingV2.purchaseReceiptCreate.useMutation({
    onSuccess: () => { toast.success("تم حفظ المسودة — مفيش مخزون اتغيّر"); resetForm(); refresh(); },
    onError: e => toast.error(e.message),
  });
  const submitMutation = trpc.accountingV2.purchaseReceiptSubmit.useMutation({
    onSuccess: () => { toast.success("اتبعت للاعتماد"); refresh(); },
    onError: e => toast.error(e.message),
  });
  const approveMutation = trpc.accountingV2.purchaseReceiptApprove.useMutation({
    onSuccess: () => { toast.success("تم الاعتماد — المخزون اتزوّد"); refresh(); utils.products.list.invalidate(); },
    onError: e => toast.error(e.message),
  });
  const voidMutation = trpc.accountingV2.purchaseReceiptVoid.useMutation({
    onSuccess: r => {
      toast.success(r.reversed ? "تم الإلغاء بحركة عكسية" : "تم إلغاء المسودة");
      refresh(); utils.products.list.invalidate();
    },
    onError: e => toast.error(e.message),
  });

  const resetForm = () => {
    setSupplierName(""); setReference(""); setInvoiceDate(""); setEvidenceUrl("");
    setNotes(""); setHeaderDiscount(""); setHeaderShipping("");
    setLines([newLine()]); setErrors({});
  };

  const patchLine = (key: string, changes: Partial<Line>) =>
    setLines(ls => ls.map(l => (l.key === key ? { ...l, ...changes } : l)));

  const totals = useMemo(
    () => documentTotal(lines, headerShipping, headerDiscount),
    [lines, headerShipping, headerDiscount]
  );

  const variantsFor = (productId: string) =>
    ((variants ?? []) as CatalogVariant[]).filter(v => v.productId === Number(productId));

  const validate = () => {
    const next: Record<string, string> = {};
    if (!bid) next.businessId = "اختار النشاط";
    if (!warehouseId) next.warehouseId = "اختار مكان الاستلام";
    if (!supplierName.trim()) next.supplierName = "اسم المورد مطلوب";
    if (!receiptDate) next.receiptDate = "تاريخ الاستلام مطلوب";
    if (!evidenceUrl.trim()) next.evidenceUrl = "المستند مطلوب — إذن الاستلام لازم يبقى وراه ورقة";
    lines.forEach((l, i) => {
      if (!l.productId) next[`line-${i}-product`] = "اختار المنتج";
      const vs = variantsFor(l.productId);
      if (vs.length > 0 && !l.variantId) next[`line-${i}-variant`] = "اختار النوع";
      if (l.variantId && !vs.some(v => v.id === Number(l.variantId)))
        next[`line-${i}-variant`] = "النوع ده مش تابع للمنتج المختار";
      if (!(Number(l.quantity) > 0)) next[`line-${i}-qty`] = "الكمية لازم تكون أكبر من صفر";
      if (!Number.isInteger(Number(l.quantity))) next[`line-${i}-qty`] = "الكمية لازم تكون رقم صحيح";
      if (l.unitCost === "" || Number(l.unitCost) < 0) next[`line-${i}-cost`] = "التكلفة لازم تكون صفر أو أكتر";
      if (lineFinalUnitCost(l) < 0) next[`line-${i}-cost`] = "الخصم أكبر من قيمة البند";
    });
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const saveDraft = () => {
    if (!validate()) { toast.error("فيه حقول ناقصة — بُصّ على الرسايل الحمرا"); return; }
    createMutation.mutate({
      businessId: bid!,
      warehouseId: Number(warehouseId),
      // الشاشة دي لإذن استلام مشتريات تحديدًا، فالنوع ثابت. الجرد الافتتاحي والتسويات
      // ليهم شاشة المخزون المحاسبي بقائمة أنواعها.
      receiptType: "purchase",
      supplierName: supplierName.trim(),
      reference: reference.trim() || undefined,
      receiptDate: new Date(receiptDate),
      evidenceUrl: evidenceUrl.trim(),
      reason: [notes.trim(), invoiceDate ? `تاريخ الفاتورة: ${invoiceDate}` : ""]
        .filter(Boolean).join(" · ") || undefined,
      items: lines.map(l => ({
        productId: Number(l.productId),
        variantId: l.variantId ? Number(l.variantId) : undefined,
        quantity: Number(l.quantity),
        unitCost: lineFinalUnitCost(l).toFixed(4),
      })),
    });
  };

  const showError = (k: string) =>
    errors[k] ? <p className="mt-1 text-xs text-destructive">{errors[k]}</p> : null;

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="إذن استلام بضاعة"
        description="تسجيل بضاعة داخلة بكمياتها وتكلفتها. المسودة مابتحركش مخزون — الاعتماد بس هو اللي بيزوّد."
      />

      <SectionCard>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {businesses.length > 1 && (
            <div>
              <Label>النشاط <span className="text-destructive">*</span></Label>
              <Select value={businessId} onValueChange={v => { setBusinessId(v); setWarehouseId(""); }}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="اختار النشاط" /></SelectTrigger>
                <SelectContent>
                  {businesses.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {showError("businessId")}
            </div>
          )}
          <div>
            <Label>مكان الاستلام <span className="text-destructive">*</span></Label>
            <Select value={warehouseId} onValueChange={setWarehouseId} disabled={!bid}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={bid ? "اختار المخزن" : "اختار النشاط الأول"} />
              </SelectTrigger>
              <SelectContent>
                {warehouses.data?.map(w => <SelectItem key={w.id} value={String(w.id)}>{w.name}</SelectItem>)}
              </SelectContent>
            </Select>
            {bid && !warehouses.isLoading && (warehouses.data?.length ?? 0) === 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                مفيش مخازن مسجّلة للنشاط ده. الورشة بتتسجّل هنا كمخزن.
              </p>
            )}
            {showError("warehouseId")}
          </div>
          <div>
            <Label>المورد <span className="text-destructive">*</span></Label>
            <Input className="mt-1" value={supplierName} placeholder="اسم المورد"
              onChange={e => setSupplierName(e.target.value)} />
            {showError("supplierName")}
          </div>
          <div>
            <Label>رقم الفاتورة</Label>
            <Input className="mt-1" value={reference} placeholder="مثال: INV-2026-114"
              onChange={e => setReference(e.target.value)} dir="ltr" />
          </div>
          <div>
            <Label>تاريخ الفاتورة</Label>
            <Input className="mt-1" type="date" value={invoiceDate}
              onChange={e => setInvoiceDate(e.target.value)} />
          </div>
          <div>
            <Label>تاريخ الاستلام <span className="text-destructive">*</span></Label>
            <Input className="mt-1" type="date" value={receiptDate}
              onChange={e => setReceiptDate(e.target.value)} />
            {showError("receiptDate")}
          </div>
          <div className="sm:col-span-2">
            <Label>رابط المستند <span className="text-destructive">*</span></Label>
            <Input className="mt-1" value={evidenceUrl} placeholder="https://..." dir="ltr"
              onChange={e => setEvidenceUrl(e.target.value)} />
            {showError("evidenceUrl")}
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <Label>ملاحظات</Label>
            <Textarea className="mt-1" rows={2} value={notes}
              onChange={e => setNotes(e.target.value)} placeholder="أي تفاصيل إضافية..." />
          </div>
        </div>
      </SectionCard>

      <SectionCard>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <PackagePlus className="h-4 w-4" /> بنود الاستلام
          </h3>
          <Button size="sm" variant="outline" className="gap-1.5"
            onClick={() => setLines(ls => [...ls, newLine()])}>
            <Plus className="h-4 w-4" /> بند جديد
          </Button>
        </div>

        <div className="space-y-3">
          {lines.map((l, i) => {
            const vs = variantsFor(l.productId);
            const finalCost = lineFinalUnitCost(l);
            return (
              <div key={l.key} className="rounded-lg border bg-muted/30 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-bold text-muted-foreground">بند {i + 1}</span>
                  {lines.length > 1 && (
                    <Button size="sm" variant="ghost" className="h-7 gap-1 text-destructive"
                      onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))}>
                      <Trash2 className="h-3.5 w-3.5" /> حذف
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <div className="col-span-2 sm:col-span-1">
                    <Label className="text-xs">المنتج <span className="text-destructive">*</span></Label>
                    <Select value={l.productId}
                      onValueChange={v => patchLine(l.key, { productId: v, variantId: "" })}>
                      {/* اسم المنتج أطول من عرض العمود، فمن غير قص بيطلع بره الخانة ويركب
                          على اللي جنبه. */}
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
                  <div className="col-span-2 sm:col-span-1">
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
                  <div>
                    <Label className="text-xs">تكلفة الوحدة <span className="text-destructive">*</span></Label>
                    <Input className="mt-1" type="number" min="0" step="0.01" dir="ltr" value={l.unitCost}
                      placeholder="0.00" onChange={e => patchLine(l.key, { unitCost: e.target.value })} />
                    {showError(`line-${i}-cost`)}
                  </div>
                  <div>
                    <Label className="text-xs">خصم البند</Label>
                    <Input className="mt-1" type="number" min="0" step="0.01" dir="ltr" value={l.discount}
                      placeholder="0.00" onChange={e => patchLine(l.key, { discount: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-xs">تكلفة إضافية</Label>
                    <Input className="mt-1" type="number" min="0" step="0.01" dir="ltr" value={l.extraCost}
                      placeholder="0.00" onChange={e => patchLine(l.key, { extraCost: e.target.value })} />
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-xs">
                  <span className="text-muted-foreground">
                    تكلفة الوحدة النهائية{" "}
                    <strong className="tabular-nums text-foreground">{money(finalCost)}</strong> ج.م
                  </span>
                  <span className="font-bold tabular-nums">
                    إجمالي البند {money(lineTotal(l))} ج.م
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </SectionCard>

      <SectionCard>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">مصاريف شحن / نقل</Label>
                <Input className="mt-1" type="number" min="0" step="0.01" dir="ltr"
                  value={headerShipping} placeholder="0.00"
                  onChange={e => setHeaderShipping(e.target.value)} />
              </div>
              <div>
                <Label className="text-xs">خصم على الفاتورة</Label>
                <Input className="mt-1" type="number" min="0" step="0.01" dir="ltr"
                  value={headerDiscount} placeholder="0.00"
                  onChange={e => setHeaderDiscount(e.target.value)} />
              </div>
            </div>
            <p className="flex items-start gap-1.5 rounded-md bg-warning/10 p-2 text-xs text-muted-foreground">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <span>
                الخصم والتكلفة الإضافية بيتحوّلوا لتكلفة وحدة نهائية عشان قيمة المخزون تطلع
                مضبوطة. تفصيلتهم لسه مابتتخزّنش لحد ما يتضاف عمود ليها.
              </span>
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <div className="space-y-1.5 text-sm">
              <Row label="إجمالي البنود" value={totals.linesTotal} />
              <Row label="مصاريف شحن" value={totals.shipping} />
              <Row label="خصم الفاتورة" value={-totals.discount} />
              <div className="flex items-center justify-between border-t pt-1.5 text-base font-black">
                <span>إجمالي المستند</span>
                <span className="tabular-nums">{money(totals.total)} ج.م</span>
              </div>
              <Row label="المدفوع" value={0} muted />
              <div className="flex items-center justify-between font-bold text-warning">
                <span>المتبقي للمورد</span>
                <span className="tabular-nums">{money(totals.total)} ج.م</span>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              الدفع إجراء منفصل ولسه مش متاح — مفيش مسار دفع موردين في النظام. الفاتورة
              بتتسجّل كمستحق كامل على المورد.
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button className="gap-1.5" onClick={saveDraft} disabled={createMutation.isPending}>
            <Save className="h-4 w-4" />
            {createMutation.isPending ? "جاري الحفظ..." : "حفظ كمسودة"}
          </Button>
          <Button variant="outline" className="gap-1.5" onClick={resetForm}>
            <XCircle className="h-4 w-4" /> تفريغ النموذج
          </Button>
        </div>
      </SectionCard>

      <SectionCard>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold">أذون الاستلام</h3>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={refresh}>
            <RefreshCw className="h-4 w-4" /> تحديث
          </Button>
        </div>
        {receipts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">مفيش أذون استلام لسه.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-sm">
              <thead>
                <tr className="border-b text-right text-xs text-muted-foreground">
                  <th className="p-2">#</th>
                  <th className="p-2">المورد</th>
                  <th className="p-2">التاريخ</th>
                  <th className="p-2">الإجمالي</th>
                  <th className="p-2">الحالة</th>
                  <th className="p-2">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r: any) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="p-2 tabular-nums">{r.id}</td>
                    <td className="p-2">{r.supplierName}</td>
                    <td className="p-2 tabular-nums">
                      {new Date(r.receiptDate).toLocaleDateString("ar-EG")}
                    </td>
                    <td className="p-2 tabular-nums">{money(Number(r.totalAmount))}</td>
                    <td className="p-2">{STATUS_LABEL[r.status] ?? r.status}</td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-1">
                        {r.status === "draft" && (
                          <Button size="sm" variant="outline" className="h-7 text-xs"
                            onClick={() => submitMutation.mutate({ businessId: bid!, receiptId: r.id })}>
                            إرسال للاعتماد
                          </Button>
                        )}
                        {r.status === "pending_approval" && (
                          <Button size="sm" className="h-7 gap-1 text-xs"
                            onClick={() => approveMutation.mutate({ businessId: bid!, receiptId: r.id })}>
                            <CheckCircle2 className="h-3.5 w-3.5" /> اعتماد
                          </Button>
                        )}
                        {r.status !== "voided" && (
                          <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive"
                            onClick={() => {
                              const reason = window.prompt("سبب الإلغاء؟");
                              if (!reason?.trim()) return;
                              voidMutation.mutate({ businessId: bid!, receiptId: r.id, reason: reason.trim() });
                            }}>
                            إلغاء
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function Row({ label, value, muted }: { label: string; value: number; muted?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${muted ? "text-muted-foreground" : ""}`}>
      <span>{label}</span>
      <span className="tabular-nums">{money(value)} ج.م</span>
    </div>
  );
}
