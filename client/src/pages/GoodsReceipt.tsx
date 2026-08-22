import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  PackagePlus, Plus, Trash2, Save, CheckCircle2, XCircle, RefreshCw, AlertCircle, Send,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useBrandOptions } from "@/hooks/useBrandOptions";
import { usePermission } from "@/hooks/usePermission";
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
  workshopLineTotal, workshopReceiptTotal, workshopReceiptPieces,
  type WorkshopLineInput,
} from "@shared/purchaseTotals";

/**
 * استلام بضاعة من الورشة.
 *
 * الورشة بتسلّم كل يوم، والصنف الواحد بيجي على حالتين بتكلفتين: سادة، وعليه حفر. الصف في
 * الشاشة واحد بالحالتين لأن ده اللي التاجر بيعدّه، وبيتحوّل لسطرين في
 * `purchase_receipt_items` لأن ده اللي المخزون بيتحسب عليه — السادة رصيد المنتج نفسه،
 * والمحفور رصيد النوع.
 *
 * المحرك تحت هو نفسه اللي كان: مسودة ← إرسال ← اعتماد، وبنفس الجسر اللي بيزوّد الدفترين.
 * اللي اتغيّر هو اللغة والحقول: مفيش «إذن شراء» ولا «فاتورة مورد» ولا مستند إجباري.
 * التعقيد الداخلي مخفي، بس الحالة نفسها ظاهرة — لأن «اتسجّل» و«دخل المخزون» فرق بيهم
 * التاجر لازم يشوفه.
 */

const money = (n: number) =>
  n.toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Line = WorkshopLineInput & {
  key: string;
  productId: string;
  variantId: string;
};

const newLine = (): Line => ({
  key: Math.random().toString(36).slice(2),
  productId: "", variantId: "",
  plainQuantity: "", plainUnitCost: "",
  engravedQuantity: "", engravedUnitCost: "",
});

const STATUS: Record<string, { label: string; tone: string }> = {
  draft: { label: "متسجّل — لسه مادخلش المخزون", tone: "var(--muted-foreground)" },
  pending_approval: { label: "مستني الاعتماد", tone: "var(--warning)" },
  approved: { label: "دخل المخزون", tone: "var(--success)" },
  voided: { label: "ملغي", tone: "var(--destructive)" },
};

/**
 * إذن استلام البضاعة — صفحة كاملة، وكمان جزء جوه كشف حساب المصنع.
 *
 * نفس المكوّن بيتنادى من المكانين عن قصد. التاجر عايز يسجّل الاستلام وهو واقف على
 * كشف المصنع ويشوف الحساب اتحرّك في نفس الشاشة — والحل التاني (فورم مبسّط هناك) كان
 * هيبقى نسخة تانية من منطق المخزون: من غير سادة/محفور، ومن غير أصناف متعددة، وبمسار
 * تاني ممكن يختلف عن ده بعد كام تعديل.
 *
 * `lockedSupplierName` بتقفل خانة الورشة على اسم المصنع اللي إنت واقف عليه — عشان
 * الإذن يتربط بالحساب الصح من غير ما التاجر يكتب الاسم تاني (وأي حرف مختلف كان هيعمل
 * مصنع تالت في الكشف).
 */
export default function GoodsReceipt({
  embeddedBusinessId,
  lockedSupplierName,
  onSaved,
}: {
  embeddedBusinessId?: number;
  lockedSupplierName?: string;
  onSaved?: () => void;
} = {}) {
  const embedded = embeddedBusinessId != null;
  const [, navigate] = useLocation();
  const { currentBusinessIds } = useBusinessContext();
  const utils = trpc.useUtils();

  const {
    brands, selected: businessId, setSelected: setBusinessId,
    selectedId: pickedBid, isEmpty: noBrands,
  } = useBrandOptions();
  const bid = embeddedBusinessId ?? pickedBid;

  const [warehouseId, setWarehouseId] = useState("");
  const [workshopName, setWorkshopName] = useState(lockedSupplierName ?? "");
  const [receiptDate, setReceiptDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [attachmentUrl, setAttachmentUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // الاعتماد والإلغاء بيحرّكوا المخزون → على inventory_costing.approve. المحاسب معاهوش
  // الصلاحية دي (عنده manage للمسودة بس)، فالزراري تختفي عنه — والباك بيرفضها كمان.
  const canApprove = usePermission("inventory_costing.approve");

  const warehouses = trpc.businesses.warehouses.useQuery(
    { businessId: bid! }, { enabled: Boolean(bid) }
  );
  const [newWarehouse, setNewWarehouse] = useState("");
  const addWarehouse = trpc.businesses.createWarehouse.useMutation({
    onSuccess: async () => {
      toast.success("اتضاف المخزن");
      setNewWarehouse("");
      // اللي اتعمل لسه بيتختار لوحده: من غير كده التاجر يضيفه ويدوّر عليه تاني.
      const fresh = await warehouses.refetch();
      const added = fresh.data?.find(w => w.name === newWarehouse.trim());
      if (added) setWarehouseId(String(added.id));
    },
    onError: error => toast.error(error.message),
  });
  const { data: products } = trpc.products.list.useQuery(
    currentBusinessIds?.length ? { businessIds: currentBusinessIds } : undefined
  );
  const { data: variants } = trpc.variants.all.useQuery(
    currentBusinessIds?.length ? { businessIds: currentBusinessIds } : undefined
  );
  const control = trpc.accountingV2.inventoryControlData.useQuery(
    { businessId: bid! }, { enabled: Boolean(bid) }
  );

  const receipts = useMemo(
    () => [...(control.data?.receipts ?? [])].reverse(),
    [control.data?.receipts]
  );

  const refresh = () => { control.refetch(); };
  const afterStockChange = () => { refresh(); utils.products.list.invalidate(); };

  const createMutation = trpc.accountingV2.purchaseReceiptCreate.useMutation({
    onSuccess: () => { toast.success("اتسجّل — لسه مادخلش المخزون"); resetForm(); refresh(); },
    onError: e => toast.error(e.message),
  });
  const submitMutation = trpc.accountingV2.purchaseReceiptSubmit.useMutation({
    onSuccess: () => { toast.success("اتبعت للاعتماد"); refresh(); },
    onError: e => toast.error(e.message),
  });
  const approveMutation = trpc.accountingV2.purchaseReceiptApprove.useMutation({
    onSuccess: () => { toast.success("دخل المخزون"); afterStockChange(); },
    onError: e => toast.error(e.message),
  });
  const voidMutation = trpc.accountingV2.purchaseReceiptVoid.useMutation({
    onSuccess: r => {
      toast.success(r.reversed ? "اتلغى وطلع من المخزون" : "اتلغى");
      afterStockChange();
    },
    onError: e => toast.error(e.message),
  });

  const resetForm = () => {
    setWorkshopName(""); setAttachmentUrl(""); setNotes("");
    setLines([newLine()]); setErrors({});
  };

  const patch = (key: string, changes: Partial<Line>) =>
    setLines(ls => ls.map(l => (l.key === key ? { ...l, ...changes } : l)));

  const variantsFor = (productId: string) =>
    ((variants ?? []) as CatalogVariant[]).filter(v => v.productId === Number(productId));

  const total = useMemo(() => workshopReceiptTotal(lines), [lines]);
  const pieces = useMemo(() => workshopReceiptPieces(lines), [lines]);

  const num = (v: string | number) => Number(v) || 0;

  const validate = () => {
    const next: Record<string, string> = {};
    if (!bid) next.businessId = noBrands ? "مفيش أنشطة متاحة" : "اختار النشاط";
    if (!warehouseId) next.warehouseId = "اختار مكان الاستلام";
    if (!workshopName.trim()) next.workshopName = "اسم الورشة مطلوب";
    if (!receiptDate) next.receiptDate = "التاريخ مطلوب";

    lines.forEach((l, i) => {
      const plain = num(l.plainQuantity);
      const engraved = num(l.engravedQuantity);
      if (!l.productId) next[`l${i}-product`] = "اختار الصنف";
      if (plain === 0 && engraved === 0) next[`l${i}-qty`] = "اكتب كمية سادة أو محفور";
      if (plain < 0 || engraved < 0) next[`l${i}-qty`] = "الكمية ماتكونش بالسالب";
      if (!Number.isInteger(plain) || !Number.isInteger(engraved))
        next[`l${i}-qty`] = "الكمية لازم تكون رقم صحيح";
      if (plain > 0 && num(l.plainUnitCost) < 0) next[`l${i}-plainCost`] = "التكلفة ماتكونش بالسالب";
      if (engraved > 0 && num(l.engravedUnitCost) < 0) next[`l${i}-engCost`] = "التكلفة ماتكونش بالسالب";
      // النوع مطلوب للمحفور بس — السادة هو المنتج نفسه من غير حفر
      if (engraved > 0 && !l.variantId) next[`l${i}-variant`] = "اختار نوع الحفر";
      if (l.variantId && !variantsFor(l.productId).some(v => v.id === Number(l.variantId)))
        next[`l${i}-variant`] = "النوع ده مش تابع للصنف المختار";
    });

    setErrors(next);
    return Object.keys(next).length === 0;
  };

  /** الصف الواحد بيتحوّل لسطر أو سطرين — الكمية صفر مابتتبعتش أصلاً. */
  const toItems = () =>
    lines.flatMap(l => {
      const out: Array<{ productId: number; variantId?: number; quantity: number; unitCost: string }> = [];
      const plain = num(l.plainQuantity);
      const engraved = num(l.engravedQuantity);
      if (plain > 0)
        out.push({ productId: Number(l.productId), quantity: plain, unitCost: num(l.plainUnitCost).toFixed(4) });
      if (engraved > 0)
        out.push({
          productId: Number(l.productId), variantId: Number(l.variantId),
          quantity: engraved, unitCost: num(l.engravedUnitCost).toFixed(4),
        });
      return out;
    });

  const save = () => {
    if (!validate()) { toast.error("فيه حقول ناقصة — بُصّ على الرسايل الحمرا"); return; }
    createMutation.mutate({
      businessId: bid!,
      warehouseId: Number(warehouseId),
      receiptType: "purchase",
      // الورشة بتتخزّن في نفس خانة المورد — هي فعلًا الجهة اللي وردّت البضاعة.
      supplierName: workshopName.trim(),
      receiptDate: new Date(receiptDate),
      evidenceUrl: attachmentUrl.trim() || undefined,
      reason: notes.trim() || undefined,
      items: toItems(),
    });
  };

  const showError = (k: string) =>
    errors[k] ? <p className="mt-1 text-xs text-destructive">{errors[k]}</p> : null;

  return (
    <div className="space-y-4" dir="rtl">
      {!embedded && (
        <PageHeader
          title="استلام بضاعة من الورشة"
          description="تسجيل اللي الورشة سلّمته بكمياته وتكلفته. الحفظ لوحده مايزوّدش المخزون — الاعتماد هو اللي بيزوّد."
        />
      )}

      <SectionCard>
        {noBrands && (
          <p className="mb-3 flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <span>
              مفيش أنشطة متاحة لحسابك.{" "}
              <button type="button" onClick={() => navigate("/businesses")}
                className="text-primary underline underline-offset-2">افتح إدارة الأنشطة</button>
            </span>
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {!embedded && brands.length > 1 && (
            <div>
              <Label>النشاط <span className="text-destructive">*</span></Label>
              <Select value={businessId} onValueChange={v => { setBusinessId(v); setWarehouseId(""); }}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="اختار النشاط" /></SelectTrigger>
                <SelectContent>
                  {brands.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {showError("businessId")}
            </div>
          )}
          <div>
            <Label>التاريخ <span className="text-destructive">*</span></Label>
            <Input className="mt-1" type="date" value={receiptDate}
              onChange={e => setReceiptDate(e.target.value)} />
            {showError("receiptDate")}
          </div>
          <div>
            <Label>الورشة <span className="text-destructive">*</span></Label>
            <Input className="mt-1" value={workshopName} placeholder="اسم الورشة"
              disabled={embedded}
              onChange={e => setWorkshopName(e.target.value)} />
            {showError("workshopName")}
          </div>
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
            {showError("warehouseId")}
            {/*
              إضافة مخزن من هنا.

              `businesses.createWarehouse` كان في السيرفر من غير أي شاشة بتناديه — زي
              `payroll.profileCreate` بالظبط. النتيجة إن القايمة دي بتطلع فاضية وإذن
              الاستلام كله مقفول، والتاجر مش لاقي في أي مكان طريقة يعمل بيها مخزن.
            */}
            {bid != null && (warehouses.data?.length ?? 0) === 0 && (
              <p className="mt-1 text-xs" style={{ color: "var(--warning)" }}>
                مفيش مخازن لسه — اكتب اسم مكان الاستلام تحت.
              </p>
            )}
            {bid != null && (
              <div className="mt-2 flex gap-2">
                <Input
                  placeholder="أو اكتب مخزن جديد..."
                  value={newWarehouse}
                  onChange={e => setNewWarehouse(e.target.value)}
                  onKeyDown={e => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    if (newWarehouse.trim().length < 2) return;
                    addWarehouse.mutate({ businessId: bid, name: newWarehouse.trim() });
                  }}
                />
                <Button
                  variant="outline"
                  disabled={addWarehouse.isPending || newWarehouse.trim().length < 2}
                  onClick={() =>
                    addWarehouse.mutate({ businessId: bid, name: newWarehouse.trim() })
                  }
                >
                  إضافة
                </Button>
              </div>
            )}
          </div>
        </div>
      </SectionCard>

      <SectionCard>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <PackagePlus className="h-4 w-4" /> اللي الورشة سلّمته
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

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
                    {showError(`l${i}-product`)}
                  </div>
                  <div>
                    <Label className="text-xs">نوع الحفر</Label>
                    <Select value={l.variantId} onValueChange={v => patch(l.key, { variantId: v })}
                      disabled={vs.length === 0}>
                      <SelectTrigger className="mt-1 w-full min-w-0 [&>span]:truncate">
                        <SelectValue placeholder={vs.length ? "للمحفور بس" : "مفيش أنواع"} />
                      </SelectTrigger>
                      <SelectContent>
                        {vs.map(v => <SelectItem key={v.id} value={String(v.id)}>{variantLabel(v)}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    {showError(`l${i}-variant`)}
                  </div>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <div>
                    <Label className="text-xs">كمية سادة</Label>
                    <Input className="mt-1" type="number" min="0" dir="ltr" placeholder="0"
                      value={String(l.plainQuantity)}
                      onChange={e => patch(l.key, { plainQuantity: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-xs">تكلفة السادة</Label>
                    <Input className="mt-1" type="number" min="0" step="0.01" dir="ltr" placeholder="0.00"
                      value={String(l.plainUnitCost)}
                      onChange={e => patch(l.key, { plainUnitCost: e.target.value })} />
                    {showError(`l${i}-plainCost`)}
                  </div>
                  <div>
                    <Label className="text-xs">كمية محفور</Label>
                    <Input className="mt-1" type="number" min="0" dir="ltr" placeholder="0"
                      value={String(l.engravedQuantity)}
                      onChange={e => patch(l.key, { engravedQuantity: e.target.value })} />
                  </div>
                  <div>
                    <Label className="text-xs">تكلفة المحفور</Label>
                    <Input className="mt-1" type="number" min="0" step="0.01" dir="ltr" placeholder="0.00"
                      value={String(l.engravedUnitCost)}
                      onChange={e => patch(l.key, { engravedUnitCost: e.target.value })} />
                    {showError(`l${i}-engCost`)}
                  </div>
                </div>
                {showError(`l${i}-qty`)}

                <div className="mt-2 flex items-center justify-between border-t pt-2 text-xs">
                  <span className="text-muted-foreground">
                    {num(l.plainQuantity) + num(l.engravedQuantity)} قطعة
                  </span>
                  <span className="font-bold tabular-nums">
                    إجمالي الصنف {money(workshopLineTotal(l))} ج.م
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-3">
          <Label className="text-xs">ملاحظات (اختياري)</Label>
          <Textarea className="mt-1" rows={2} value={notes} placeholder="أي تفاصيل..."
            onChange={e => setNotes(e.target.value)} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t pt-3">
          <Button className="gap-1.5" onClick={save} disabled={createMutation.isPending}>
            <Save className="h-4 w-4" />
            {createMutation.isPending ? "جاري الحفظ..." : "حفظ"}
          </Button>
          <Button variant="outline" className="gap-1.5" onClick={resetForm}>
            <XCircle className="h-4 w-4" /> تفريغ
          </Button>
          <span className="ms-auto text-sm">
            <span className="text-muted-foreground">{pieces} قطعة · </span>
            <strong className="tabular-nums">{money(total)} ج.م</strong>
          </span>
        </div>
      </SectionCard>

      <SectionCard>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-bold">استلامات الورشة</h3>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={refresh}>
            <RefreshCw className="h-4 w-4" /> تحديث
          </Button>
        </div>
        {receipts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">مفيش استلامات لسه.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-sm">
              <thead>
                <tr className="border-b text-right text-xs text-muted-foreground">
                  <th className="p-2">التاريخ</th>
                  <th className="p-2">الورشة</th>
                  <th className="p-2">الإجمالي</th>
                  <th className="p-2">الحالة</th>
                  <th className="p-2">إجراء</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((r: any) => (
                  <tr key={r.id} className="border-b last:border-0">
                    <td className="p-2 whitespace-nowrap tabular-nums">
                      {new Date(r.receiptDate).toLocaleDateString("ar-EG")}
                    </td>
                    <td className="p-2">{r.supplierName}</td>
                    <td className="p-2 tabular-nums">{money(Number(r.totalAmount))}</td>
                    <td className="p-2 whitespace-nowrap text-xs font-bold"
                      style={{ color: STATUS[r.status]?.tone }}>
                      {STATUS[r.status]?.label ?? r.status}
                    </td>
                    <td className="p-2">
                      <div className="flex flex-wrap gap-1">
                        {r.status === "draft" && (
                          <Button size="sm" variant="outline" className="h-7 gap-1 text-xs"
                            onClick={() => submitMutation.mutate({ businessId: bid!, receiptId: r.id })}>
                            <Send className="h-3.5 w-3.5" /> إرسال للاعتماد
                          </Button>
                        )}
                        {r.status === "pending_approval" && canApprove && (
                          <Button size="sm" className="h-7 gap-1 text-xs"
                            onClick={() => approveMutation.mutate({ businessId: bid!, receiptId: r.id })}>
                            <CheckCircle2 className="h-3.5 w-3.5" /> اعتماد وإضافة للمخزون
                          </Button>
                        )}
                        {r.status !== "voided" && canApprove && (
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
        <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            المالك يقدر يعتمد استلامه بنفسه. الموظف اللي سجّل الاستلام لازم حساب تاني
            يعتمده — عشان مايبقاش نفس الشخص هو اللي بيسجّل وهو اللي بيراجع.
          </span>
        </p>
      </SectionCard>
    </div>
  );
}
