import { useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  PackagePlus, Plus, Trash2, Save, CheckCircle2, XCircle, RefreshCw, AlertCircle, Send, Building2, ListChecks, ClipboardList,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useBrandOptions } from "@/hooks/useBrandOptions";
import { usePermission } from "@/hooks/usePermission";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  PageHeader, SectionCard, StatusBadge, StickyActionBar, ResponsiveDataTable, OfflineState, PermissionDeniedState, type Column,
} from "@/components/shared";
import { SectionIcon } from "@/components/brand";
import { variantLabel, type CatalogVariant } from "@/components/orders/OrderItemsEditor";
import { createInFlightGuard } from "@/components/orders/confirmGuard";
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
 *
 * المرحلة 7C (عرض فقط): ثلاث خطوات مرقّمة (النشاط والمصدر ← الأصناف ← المراجعة والحفظ) في الصفحة
 * نفسها، أخطاء مرتبطة بالسطر والحقل، شريط حفظ ثابت على الهاتف، حارس ضغط مكرر، نتيجة الحفظ ظاهرة،
 * وقائمة الاستلامات جدول Desktop/بطاقات Mobile. نفس التحقق ونفس الـmutations ونفس الـpayload.
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

const STATUS: Record<string, { label: string; tone: "neutral" | "warning" | "success" | "danger" }> = {
  draft: { label: "متسجّل — لسه مادخلش المخزون", tone: "neutral" },
  pending_approval: { label: "مستني الاعتماد", tone: "warning" },
  approved: { label: "دخل المخزون", tone: "success" },
  voided: { label: "ملغي", tone: "danger" },
};

const TOUCH = "min-h-11 md:min-h-9";

/** خطوة مرقّمة — بطاقة بعنوان ورقم؛ عرض فقط. */
function Step({ n, title, icon, children, testId }: { n: number; title: string; icon: React.ReactNode; children: React.ReactNode; testId: string }) {
  return (
    <SectionCard
      testId={testId}
      title={
        <span className="flex items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground tabular-nums" aria-hidden="true">{n}</span>
          {title}
        </span>
      }
      icon={icon}
    >
      {children}
    </SectionCard>
  );
}

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
  const online = useOnlineStatus();

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
  /** نتيجة آخر حفظ — تظهر بوضوح بعد الحفظ (المسودة لا تحرّك المخزون). */
  const [savedNotice, setSavedNotice] = useState<{ workshop: string; pieces: number; total: number; at: Date } | null>(null);
  const [voidTarget, setVoidTarget] = useState<{ id: number } | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const saveGuard = useRef(createInFlightGuard<string>()).current;

  // الاعتماد والإلغاء بيحرّكوا المخزون → على inventory_costing.approve. المحاسب معاهوش
  // الصلاحية دي (عنده manage للمسودة بس)، فالزراري تختفي عنه — والباك بيرفضها كمان.
  const canApprove = usePermission("inventory_costing.approve");
  // تسجيل المسودة على inventory_costing.manage (نفس بوابة السيرفر purchaseReceiptCreate) — بلا الصلاحية
  // تُعرض القائمة فقط مع حالة واضحة بدل نموذج يفشل عند الحفظ.
  const canManage = usePermission("inventory_costing.manage");

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
    onSuccess: () => {
      toast.success("اتسجّل — لسه مادخلش المخزون");
      setSavedNotice({ workshop: workshopName.trim(), pieces, total, at: new Date() });
      resetForm(); refresh(); onSaved?.();
    },
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
      setVoidTarget(null); setVoidReason("");
      afterStockChange();
    },
    onError: e => toast.error(e.message),
  });
  const anyListPending = submitMutation.isPending || approveMutation.isPending || voidMutation.isPending;

  const resetForm = () => {
    setWorkshopName(lockedSupplierName ?? ""); setAttachmentUrl(""); setNotes("");
    setLines([newLine()]); setErrors({});
  };

  const patch = (key: string, changes: Partial<Line>) =>
    setLines(ls => ls.map(l => (l.key === key ? { ...l, ...changes } : l)));

  const variantsFor = (productId: string) =>
    ((variants ?? []) as CatalogVariant[]).filter(v => v.productId === Number(productId));
  const productName = (id: string | number) => (products ?? []).find((p: any) => p.id === Number(id))?.name ?? `#${id}`;
  const variantName = (id: string | number) => {
    const v = ((variants ?? []) as CatalogVariant[]).find(x => x.id === Number(id));
    return v ? variantLabel(v) : `#${id}`;
  };

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
    if (!validate()) {
      toast.error("فيه حقول ناقصة — بُصّ على الرسايل الحمرا");
      // القفز لأول حقل به خطأ (لوحة المفاتيح/قارئ الشاشة) — السطور تبقى كما كُتبت
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]')?.focus?.());
      return;
    }
    // حارس الضغط المكرر: isPending يتأخر render واحدًا — لا طلب ثانٍ حتى onSettled
    saveGuard.run("create", createMutation.isPending, done => createMutation.mutate({
      businessId: bid!,
      warehouseId: Number(warehouseId),
      receiptType: "purchase",
      // الورشة بتتخزّن في نفس خانة المورد — هي فعلًا الجهة اللي وردّت البضاعة.
      supplierName: workshopName.trim(),
      receiptDate: new Date(receiptDate),
      evidenceUrl: attachmentUrl.trim() || undefined,
      reason: notes.trim() || undefined,
      items: toItems(),
    }, { onSettled: done }));
  };

  const err = (k: string) => errors[k];
  const showError = (k: string, id?: string) =>
    errors[k] ? <p id={id ? `${id}-error` : undefined} className="mt-1 flex items-center gap-1 text-xs text-destructive" role="alert"><AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />{errors[k]}</p> : null;
  const errorCount = Object.keys(errors).length;

  // المراجعة قبل الحفظ: نفس التحويل اللي هيتبعت (toItems) — بلا أي حساب إضافي
  const review = useMemo(() => lines.flatMap((l, i) => {
    const out: Array<{ key: string; line: number; name: string; kind: string; qty: number; cost: number }> = [];
    if (!l.productId) return out;
    const plain = num(l.plainQuantity), engraved = num(l.engravedQuantity);
    if (plain > 0) out.push({ key: `${l.key}-p`, line: i + 1, name: productName(l.productId), kind: "سادة", qty: plain, cost: num(l.plainUnitCost) });
    if (engraved > 0) out.push({ key: `${l.key}-e`, line: i + 1, name: productName(l.productId), kind: l.variantId ? variantName(l.variantId) : "محفور — بلا نوع", qty: engraved, cost: num(l.engravedUnitCost) });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [lines, products, variants]);

  type ReceiptRow = any;
  const receiptColumns: Column<ReceiptRow>[] = [
    { id: "date", header: "التاريخ", cell: r => <span className="whitespace-nowrap tabular-nums">{new Date(r.receiptDate).toLocaleDateString("ar-EG")}</span>, alwaysVisible: true },
    { id: "workshop", header: "الورشة", cell: r => r.supplierName },
    { id: "total", header: "الإجمالي", numeric: true, cell: r => <span className="tabular-nums">{money(Number(r.totalAmount))} ج.م</span> },
    { id: "status", header: "الحالة", cell: r => <StatusBadge status={r.status} label={STATUS[r.status]?.label ?? r.status} tone={STATUS[r.status]?.tone ?? "neutral"} size="sm" /> },
    { id: "actions", header: "إجراء", sticky: "end", alwaysVisible: true, cell: r => <div className="flex flex-wrap justify-end gap-1">{receiptActions(r, "table")}</div> },
  ];
  const receiptActions = (r: ReceiptRow, size: "table" | "card") => {
    const cls = size === "card" ? "min-h-11 flex-1" : "min-h-9 h-9";
    return (
      <>
        {r.status === "draft" && canManage && (
          <Button type="button" size="sm" variant="outline" className={`${cls} gap-1 text-xs`} disabled={anyListPending} onClick={() => submitMutation.mutate({ businessId: bid!, receiptId: r.id })} data-testid={`receipt-submit-${r.id}`}>
            <Send className="h-3.5 w-3.5" aria-hidden="true" /> إرسال للاعتماد
          </Button>
        )}
        {r.status === "pending_approval" && canApprove && (
          <Button type="button" size="sm" className={`${cls} gap-1 text-xs`} disabled={anyListPending} onClick={() => approveMutation.mutate({ businessId: bid!, receiptId: r.id })} data-testid={`receipt-approve-${r.id}`}>
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> اعتماد وإضافة للمخزون
          </Button>
        )}
        {r.status !== "voided" && canApprove && (
          <Button type="button" size="sm" variant="ghost" className={`${cls} text-xs text-destructive`} disabled={anyListPending} onClick={() => { setVoidReason(""); setVoidTarget({ id: r.id }); }} data-testid={`receipt-void-${r.id}`}>
            إلغاء
          </Button>
        )}
      </>
    );
  };
  const receiptCard = (r: ReceiptRow) => (
    <article className="space-y-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`receipt-card-${r.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{r.supplierName}</p>
          <p className="text-xs tabular-nums text-muted-foreground">{new Date(r.receiptDate).toLocaleDateString("ar-EG")}</p>
        </div>
        <StatusBadge status={r.status} label={STATUS[r.status]?.label ?? r.status} tone={STATUS[r.status]?.tone ?? "neutral"} size="sm" />
      </div>
      <p className="text-sm font-bold tabular-nums">{money(Number(r.totalAmount))} ج.م</p>
      <div className="flex flex-wrap gap-2">{receiptActions(r, "card")}</div>
    </article>
  );

  const showForm = canManage;

  return (
    <div className={`space-y-4 ${embedded ? "" : "pb-[120px] md:pb-0"}`} dir="rtl" data-testid="goods-receipt-page">
      {!embedded && (
        <PageHeader
          title="استلام بضاعة من الورشة"
          description="تسجيل اللي الورشة سلّمته بكمياته وتكلفته. الحفظ لوحده مايزوّدش المخزون — الاعتماد هو اللي بيزوّد."
          icon={<SectionIcon section="inventory" fallback={PackagePlus} size="md" />}
        />
      )}

      {!online && <OfflineState message="الحفظ على السيرفر غير ممكن الآن — ما كتبته باقٍ هنا حتى يعود الاتصال." onRetry={refresh} className="py-6" />}

      {/* نتيجة الحفظ: واضحة ومستقلة عن الـtoast العابر */}
      {savedNotice && (
        <div className="flex items-start gap-2 rounded-[var(--radius-brand-md)] border border-[var(--success)]/40 bg-[var(--success)]/10 p-3 text-sm" role="status" data-testid="receipt-saved-notice">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold text-[var(--success)]">اتسجّل استلام {savedNotice.workshop} — {savedNotice.pieces} قطعة بإجمالي {money(savedNotice.total)} ج.م</p>
            <p className="text-xs text-muted-foreground">الحالة: متسجّل — لسه مادخلش المخزون. أرسله للاعتماد من قائمة الاستلامات أدناه، والاعتماد هو اللي بيزوّد الرصيد.</p>
          </div>
          <Button type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-9" onClick={() => setSavedNotice(null)} aria-label="إخفاء رسالة النتيجة">إخفاء</Button>
        </div>
      )}

      {!showForm ? (
        <PermissionDeniedState message="تسجيل استلام بضاعة يتطلب صلاحية إدارة تكلفة المخزون. يمكنك متابعة الاستلامات المسجلة أدناه." />
      ) : (
        <>
          {/* 1 — النشاط والمصدر ومكان الاستلام */}
          <Step n={1} title="النشاط والمصدر" icon={<Building2 className="h-4 w-4" aria-hidden="true" />} testId="receipt-step-1">
            {noBrands && (
              <p className="mb-3 flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs" role="alert">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" aria-hidden="true" />
                <span>
                  مفيش أنشطة متاحة لحسابك.{" "}
                  <button type="button" onClick={() => navigate("/businesses")}
                    className="min-h-11 text-primary underline underline-offset-2 md:min-h-0">افتح إدارة الأنشطة</button>
                </span>
              </p>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {!embedded && brands.length > 1 && (
                <div>
                  <Label htmlFor="gr-business">النشاط <span className="text-destructive">*</span></Label>
                  <Select value={businessId} onValueChange={v => { setBusinessId(v); setWarehouseId(""); }}>
                    <SelectTrigger id="gr-business" className={`mt-1 ${TOUCH}`} aria-invalid={!!err("businessId") || undefined} data-invalid={err("businessId") ? "true" : undefined}><SelectValue placeholder="اختار النشاط" /></SelectTrigger>
                    <SelectContent>
                      {brands.map(b => <SelectItem key={b.id} value={String(b.id)} className={TOUCH}>{b.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {showError("businessId", "gr-business")}
                </div>
              )}
              {!embedded && brands.length === 1 && (
                <div>
                  <Label>النشاط</Label>
                  <p className="mt-1 flex min-h-11 items-center text-sm font-medium md:min-h-9" data-testid="gr-business-single">{brands[0].name}</p>
                </div>
              )}
              <div>
                <Label htmlFor="gr-date">التاريخ <span className="text-destructive">*</span></Label>
                <Input id="gr-date" className={`mt-1 ${TOUCH}`} type="date" value={receiptDate}
                  onChange={e => setReceiptDate(e.target.value)} aria-invalid={!!err("receiptDate") || undefined} aria-describedby={err("receiptDate") ? "gr-date-error" : undefined} />
                {showError("receiptDate", "gr-date")}
              </div>
              <div>
                <Label htmlFor="gr-workshop">الورشة (المصدر) <span className="text-destructive">*</span></Label>
                <Input id="gr-workshop" className={`mt-1 ${TOUCH}`} value={workshopName} placeholder="اسم الورشة"
                  disabled={embedded} autoComplete="organization"
                  onChange={e => setWorkshopName(e.target.value)} aria-invalid={!!err("workshopName") || undefined} aria-describedby={err("workshopName") ? "gr-workshop-error" : undefined} />
                {showError("workshopName", "gr-workshop")}
              </div>
              <div>
                {/* الحقل كان في الحالة والـpayload (evidenceUrl) بلا إدخال في الشاشة — والاعتماد يطلبه على السيرفر */}
                <Label htmlFor="gr-evidence">رابط المستند / الفاتورة (مطلوب عند الاعتماد)</Label>
                <Input id="gr-evidence" className={`mt-1 ${TOUCH}`} value={attachmentUrl} placeholder="https://…" dir="ltr" inputMode="url" autoComplete="url"
                  onChange={e => setAttachmentUrl(e.target.value)} data-testid="receipt-evidence" />
              </div>
              <div>
                <Label htmlFor="gr-warehouse">مكان الاستلام <span className="text-destructive">*</span></Label>
                <Select value={warehouseId} onValueChange={setWarehouseId} disabled={!bid}>
                  <SelectTrigger id="gr-warehouse" className={`mt-1 ${TOUCH}`} aria-invalid={!!err("warehouseId") || undefined} data-invalid={err("warehouseId") ? "true" : undefined}>
                    <SelectValue placeholder={bid ? "اختار المخزن" : "اختار النشاط الأول"} />
                  </SelectTrigger>
                  <SelectContent>
                    {warehouses.data?.map(w => <SelectItem key={w.id} value={String(w.id)} className={TOUCH}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                {showError("warehouseId", "gr-warehouse")}
                {/*
                  إضافة مخزن من هنا.

                  `businesses.createWarehouse` كان في السيرفر من غير أي شاشة بتناديه — زي
                  `payroll.profileCreate` بالظبط. النتيجة إن القايمة دي بتطلع فاضية وإذن
                  الاستلام كله مقفول، والتاجر مش لاقي في أي مكان طريقة يعمل بيها مخزن.
                */}
                {bid != null && (warehouses.data?.length ?? 0) === 0 && (
                  <p className="mt-1 text-xs text-[var(--warning)]">
                    مفيش مخازن لسه — اكتب اسم مكان الاستلام تحت.
                  </p>
                )}
                {bid != null && (
                  <div className="mt-2 flex gap-2">
                    <Input
                      placeholder="أو اكتب مخزن جديد..."
                      aria-label="اسم مخزن جديد"
                      className={TOUCH}
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
                      type="button"
                      variant="outline"
                      className={TOUCH}
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
          </Step>

          {/* 2 — الأصناف والتركيبات والكميات */}
          <Step n={2} title="اللي الورشة سلّمته" icon={<PackagePlus className="h-4 w-4" aria-hidden="true" />} testId="receipt-step-2">
            <div className="space-y-3">
              {lines.map((l, i) => {
                const vs = variantsFor(l.productId);
                const id = (f: string) => `gr-l${i}-${f}`;
                return (
                  <div key={l.key} className={`rounded-[var(--radius-brand-md)] border bg-muted/30 p-3 ${["product", "qty", "variant", "plainCost", "engCost"].some(f => err(`l${i}-${f}`)) ? "border-destructive/50" : "border-border"}`} data-testid={`receipt-line-${i}`}>
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-xs font-bold text-muted-foreground">صنف {i + 1}</span>
                      {lines.length > 1 && (
                        <Button type="button" size="sm" variant="ghost" className="min-h-11 gap-1 text-destructive md:min-h-9"
                          onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} aria-label={`حذف الصنف ${i + 1}`} data-testid={`receipt-line-remove-${i}`}>
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> حذف
                        </Button>
                      )}
                    </div>

                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <div>
                        <Label htmlFor={id("product")} className="text-xs">الصنف <span className="text-destructive">*</span></Label>
                        <Select value={l.productId}
                          onValueChange={v => patch(l.key, { productId: v, variantId: "" })}>
                          <SelectTrigger id={id("product")} className={`mt-1 w-full min-w-0 [&>span]:truncate ${TOUCH}`} aria-invalid={!!err(`l${i}-product`) || undefined} data-invalid={err(`l${i}-product`) ? "true" : undefined} data-testid={`receipt-product-${i}`}>
                            <SelectValue placeholder="اختار" />
                          </SelectTrigger>
                          <SelectContent>
                            {(products ?? []).map((p: any) =>
                              <SelectItem key={p.id} value={String(p.id)} className={TOUCH}>{p.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {showError(`l${i}-product`, id("product"))}
                      </div>
                      <div>
                        <Label htmlFor={id("variant")} className="text-xs">نوع الحفر</Label>
                        <Select value={l.variantId} onValueChange={v => patch(l.key, { variantId: v })}
                          disabled={vs.length === 0}>
                          <SelectTrigger id={id("variant")} className={`mt-1 w-full min-w-0 [&>span]:truncate ${TOUCH}`} aria-invalid={!!err(`l${i}-variant`) || undefined} data-invalid={err(`l${i}-variant`) ? "true" : undefined} data-testid={`receipt-variant-${i}`}>
                            <SelectValue placeholder={vs.length ? "للمحفور بس" : "مفيش أنواع"} />
                          </SelectTrigger>
                          <SelectContent>
                            {vs.map(v => <SelectItem key={v.id} value={String(v.id)} className={TOUCH}>{variantLabel(v)}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {showError(`l${i}-variant`, id("variant"))}
                      </div>
                    </div>

                    <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
                      <div>
                        <Label htmlFor={id("plainQty")} className="text-xs">كمية سادة</Label>
                        <Input id={id("plainQty")} className={`mt-1 ${TOUCH}`} type="number" inputMode="numeric" min="0" step="1" dir="ltr" placeholder="0"
                          value={String(l.plainQuantity)} aria-invalid={!!err(`l${i}-qty`) || undefined} aria-describedby={err(`l${i}-qty`) ? `${id("qty")}-error` : undefined}
                          onChange={e => patch(l.key, { plainQuantity: e.target.value })} data-testid={`receipt-plain-qty-${i}`} />
                      </div>
                      <div>
                        <Label htmlFor={id("plainCost")} className="text-xs">تكلفة السادة</Label>
                        <Input id={id("plainCost")} className={`mt-1 ${TOUCH}`} type="number" inputMode="decimal" min="0" step="0.01" dir="ltr" placeholder="0.00"
                          value={String(l.plainUnitCost)} aria-invalid={!!err(`l${i}-plainCost`) || undefined}
                          onChange={e => patch(l.key, { plainUnitCost: e.target.value })} data-testid={`receipt-plain-cost-${i}`} />
                        {showError(`l${i}-plainCost`, id("plainCost"))}
                      </div>
                      <div>
                        <Label htmlFor={id("engQty")} className="text-xs">كمية محفور</Label>
                        <Input id={id("engQty")} className={`mt-1 ${TOUCH}`} type="number" inputMode="numeric" min="0" step="1" dir="ltr" placeholder="0"
                          value={String(l.engravedQuantity)} aria-invalid={!!err(`l${i}-qty`) || undefined} aria-describedby={err(`l${i}-qty`) ? `${id("qty")}-error` : undefined}
                          onChange={e => patch(l.key, { engravedQuantity: e.target.value })} data-testid={`receipt-eng-qty-${i}`} />
                      </div>
                      <div>
                        <Label htmlFor={id("engCost")} className="text-xs">تكلفة المحفور</Label>
                        <Input id={id("engCost")} className={`mt-1 ${TOUCH}`} type="number" inputMode="decimal" min="0" step="0.01" dir="ltr" placeholder="0.00"
                          value={String(l.engravedUnitCost)} aria-invalid={!!err(`l${i}-engCost`) || undefined}
                          onChange={e => patch(l.key, { engravedUnitCost: e.target.value })} data-testid={`receipt-eng-cost-${i}`} />
                        {showError(`l${i}-engCost`, id("engCost"))}
                      </div>
                    </div>
                    {showError(`l${i}-qty`, id("qty"))}

                    <div className="mt-2 flex items-center justify-between border-t border-border pt-2 text-xs">
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
            <Button type="button" variant="outline" className="mt-3 min-h-11 w-full gap-1.5 md:min-h-9 md:w-auto"
              onClick={() => setLines(ls => [...ls, newLine()])} data-testid="receipt-add-line">
              <Plus className="h-4 w-4" aria-hidden="true" /> صنف جديد
            </Button>
            <div className="mt-3">
              <Label htmlFor="gr-notes" className="text-xs">ملاحظات (اختياري)</Label>
              <Textarea id="gr-notes" className="mt-1" rows={2} value={notes} placeholder="أي تفاصيل..."
                onChange={e => setNotes(e.target.value)} />
            </div>
          </Step>

          {/* 3 — المراجعة قبل الحفظ: نفس السطور اللي هتتبعت (toItems) */}
          <Step n={3} title="المراجعة قبل الحفظ" icon={<ListChecks className="h-4 w-4" aria-hidden="true" />} testId="receipt-step-3">
            {errorCount > 0 && (
              <div className="mb-3 rounded-[var(--radius-brand-md)] border border-destructive/40 bg-destructive/5 p-3 text-sm" role="alert" data-testid="receipt-errors">
                <p className="font-semibold text-destructive">فيه {errorCount} ملاحظة لازم تتصلح قبل الحفظ</p>
                <ul className="mt-1 space-y-0.5 text-xs text-destructive">
                  {Object.entries(errors).map(([k, v]) => {
                    const m = /^l(\d+)-/.exec(k);
                    return <li key={k}>{m ? `صنف ${Number(m[1]) + 1}: ` : ""}{v}</li>;
                  })}
                </ul>
              </div>
            )}
            {review.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="receipt-review-empty">لسه مفيش سطور كاملة — اختار الصنف واكتب الكمية في الخطوة 2.</p>
            ) : (
              <ol className="divide-y divide-border" aria-label="سطور الاستلام" data-testid="receipt-review">
                {review.map(r => (
                  <li key={r.key} className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0">
                    <div className="min-w-0">
                      <p className="font-medium"><span className="text-muted-foreground">صنف {r.line} · </span>{r.name}</p>
                      <p className="text-xs text-[var(--info)]">{r.kind}</p>
                    </div>
                    <div className="shrink-0 text-end tabular-nums">
                      <p className="font-semibold">× {r.qty}</p>
                      <p className="text-xs text-muted-foreground">{money(r.cost)} ج.م / قطعة</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
            <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 text-sm">
              <div><dt className="text-xs text-muted-foreground">عدد القطع</dt><dd className="font-bold tabular-nums" data-testid="receipt-pieces">{pieces}</dd></div>
              <div><dt className="text-xs text-muted-foreground">الإجمالي</dt><dd className="font-bold tabular-nums" data-testid="receipt-total">{money(total)} ج.م</dd></div>
            </dl>
            <p className="mt-2 text-xs text-muted-foreground">الحفظ يسجّل الاستلام كمسودة ولا يغيّر الرصيد؛ الرصيد يتغيّر عند الاعتماد فقط.</p>
          </Step>

          {/* شريط الحفظ: ثابت أسفل الهاتف فوق القائمة السفلية (إن وُجدت)، عادي على md+ وفي الوضع المضمّن */}
          <StickyActionBar
            className={embedded ? "static mx-0 border-0 bg-transparent px-0 shadow-none backdrop-blur-0" : "fixed inset-x-0 bottom-[var(--bottom-nav-h,0px)] z-30 mx-0 mt-0 mb-0 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:static md:mx-0 md:mt-4 md:border-0 md:bg-transparent md:px-0 md:pb-0 md:backdrop-blur-0"}
            info={<span className="text-sm"><span className="text-muted-foreground">{pieces} قطعة · </span><strong className="tabular-nums">{money(total)} ج.م</strong></span>}
          >
            <Button type="button" variant="outline" className="min-h-11 gap-1.5 md:min-h-9" onClick={resetForm} disabled={createMutation.isPending} data-testid="receipt-reset">
              <XCircle className="h-4 w-4" aria-hidden="true" /> تفريغ
            </Button>
            <Button type="button" className="min-h-11 gap-1.5 md:min-h-9" onClick={save} disabled={createMutation.isPending} aria-busy={createMutation.isPending || undefined} data-testid="receipt-save">
              <Save className="h-4 w-4" aria-hidden="true" />
              {createMutation.isPending ? "جاري الحفظ..." : "حفظ"}
            </Button>
          </StickyActionBar>
        </>
      )}

      <SectionCard
        title="استلامات الورشة"
        icon={<ClipboardList className="h-4 w-4" aria-hidden="true" />}
        action={<Button type="button" size="sm" variant="outline" className="min-h-11 gap-1.5 md:min-h-9" onClick={refresh} disabled={control.isFetching}><RefreshCw className={`h-4 w-4 ${control.isFetching ? "animate-spin" : ""}`} aria-hidden="true" /> تحديث</Button>}
        flush
        testId="receipt-list"
      >
        <ResponsiveDataTable<ReceiptRow>
          rows={receipts}
          columns={receiptColumns}
          rowKey={r => r.id}
          loading={control.isLoading && Boolean(bid)}
          error={control.error ? (control.error.message || "تعذّر تحميل الاستلامات") : null}
          onRetry={refresh}
          empty={{ title: "مفيش استلامات لسه", description: bid ? "أول استلام تسجّله هيظهر هنا بحالته." : "اختار النشاط لعرض استلاماته." }}
          cardsBelow="md"
          mobileRow={receiptCard}
        />
        <p className="flex items-start gap-1.5 p-4 pt-3 text-xs text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            المالك يقدر يعتمد استلامه بنفسه. الموظف اللي سجّل الاستلام لازم حساب تاني
            يعتمده — عشان مايبقاش نفس الشخص هو اللي بيسجّل وهو اللي بيراجع.
          </span>
        </p>
      </SectionCard>

      {/* إلغاء استلام: سبب إلزامي — نفس voidMutation، بدل window.prompt */}
      <Dialog open={voidTarget != null} onOpenChange={o => { if (!o && !voidMutation.isPending) setVoidTarget(null); }}>
        <DialogContent className="max-w-md" data-testid="receipt-void-dialog">
          <DialogHeader>
            <DialogTitle>إلغاء الاستلام</DialogTitle>
            <DialogDescription>لو كان دخل المخزون هيطلع منه. السبب إلزامي.</DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="gr-void-reason">سبب الإلغاء <span className="text-destructive">*</span></Label>
            <Textarea id="gr-void-reason" className="mt-1" rows={3} value={voidReason} onChange={e => setVoidReason(e.target.value)} disabled={voidMutation.isPending} />
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className="min-h-11 md:min-h-9" onClick={() => setVoidTarget(null)} disabled={voidMutation.isPending}>رجوع</Button>
            <Button type="button" variant="destructive" className="min-h-11 md:min-h-9" disabled={!voidReason.trim() || voidMutation.isPending} data-testid="receipt-void-confirm"
              onClick={() => { if (voidTarget && voidReason.trim()) voidMutation.mutate({ businessId: bid!, receiptId: voidTarget.id, reason: voidReason.trim() }); }}>
              {voidMutation.isPending ? "جارٍ الإلغاء…" : "تأكيد الإلغاء"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
