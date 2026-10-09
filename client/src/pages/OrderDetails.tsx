import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { operationIdFor } from "@/lib/operationId";
import { useAuth } from "@/_core/hooks/useAuth";
import { useRoute, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { PartnerLogo } from "@/components/brand/PartnerLogo";
import { sourceLogo } from "@/components/shared/StatusBadge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowRight, Save, Edit2, X, Package, User, MapPin, Phone, FileText, Calendar, Hash, Truck, RefreshCw, CheckCircle, AlertCircle, Printer,
  Receipt, UserCheck, ShieldAlert, History, Building2, Copy,
} from "lucide-react";
import { OrderEditDialog, isValidEgyptianMobile, type OrderEditSavePayload } from "@/components/orders/OrderEditDialog";
import { useGovernorateOptions } from "@/hooks/useGovernorateOptions";
import { usePermission, usePermissions } from "@/hooks/usePermission";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { SHIPMENT_STALE_WARNING } from "@shared/orderContent";
import { BostaShipmentImagePreview } from "@/components/BostaPackageImageField";
import { toast } from "sonner";
import {
  PageHeader, SectionCard, StatusBadge, ReceiptPrediction, AttemptsCell, UNAVAILABLE_LABEL,
  LoadingSkeleton, ErrorState, EmptyState, OfflineState, PermissionDeniedState, WhatsAppButton,
} from "@/components/shared";
import { isActionable, money, paymentLabel, COLLECTION_STATUS } from "@/components/orders/OrdersTable";
import { OrderActionBar } from "@/components/orders/OrderActionBar";
import { CancelOrderDialog, PostponeOrderDialog, NoAnswerDialog } from "@/components/orders/OrderActionDialogs";
import { createInFlightGuard } from "@/components/orders/confirmGuard";

const STATUS_LABELS: Record<string, string> = {
  new: "جديد",
  confirmed: "مؤكد",
  postponed: "مؤجل",
  cancelled: "ملغي",
  preparing: "قيد التجهيز",
  shipped: "تم الشحن",
  delivered: "تم التسليم",
  no_answer: "لم يرد",
  returned: "مرتجع",
  printed: "مطبوع",
};

const SOURCE_LABELS: Record<string, string> = {
  easyorder: "Easy Order",
  easyorder_ataba: "Easy Order عتبة",
  easyorder_farhat: "Easy Order فرحات",
  shopify: "Shopify",
  whatsapp: "واتساب",
  manual: "يدوي",
  facebook: "فيسبوك",
};

/** أسماء حقول سجل التعديلات بالعربي — ما ليس هنا يُعرض باسمه الخام (لا نخفي حقلًا). */
const FIELD_LABELS: Record<string, string> = {
  customerName: "اسم العميل", customerPhone: "رقم الهاتف", customerPhone2: "رقم إضافي", customerAddress: "العنوان",
  governorate: "المحافظة", city: "المدينة", totalAmount: "المبلغ الإجمالي", shippingFees: "رسوم الشحن", paymentMethod: "طريقة الدفع",
  notes: "ملاحظات", status: "الحالة", items: "الأصناف", productName: "المنتج", quantity: "الكمية", assignedEmployeeId: "الموظف المسؤول",
};

/** صف «تسمية ← قيمة» موحّد لكل الأقسام؛ القيمة الفارغة تُعرض «-» بوضوح لا فراغًا. */
function Field({ label, children, icon, className, testId }: { label: string; children: ReactNode; icon?: ReactNode; className?: string; testId?: string }) {
  return (
    <div className={className} data-testid={testId}>
      <Label className="flex items-center gap-1 text-xs text-muted-foreground">{icon}{label}</Label>
      <div className="mt-0.5 text-sm font-medium">{children ?? "-"}</div>
    </div>
  );
}

const Unavailable = () => <span className="text-xs font-normal text-muted-foreground">{UNAVAILABLE_LABEL}</span>;

export default function OrderDetails() {
  const [, params] = useRoute("/order/:id");
  const [, setLocation] = useLocation();
  const { user } = useAuth();
  const online = useOnlineStatus();
  const { has } = usePermissions();
  const { businesses } = useBusinessContext();

  const isAdmin = user?.role === "admin";

  const orderId = params?.id ? parseInt(params.id) : 0;
  const [isEditing, setIsEditing] = useState(false);
  const [bostaDeposit, setBostaDeposit] = useState(false);
  const [bostaDepositAmount, setBostaDepositAmount] = useState("50");
  const [showItemsEditor, setShowItemsEditor] = useState(false);
  const [editData, setEditData] = useState<any>({});
  const [showCancel, setShowCancel] = useState(false);
  const [showPostpone, setShowPostpone] = useState(false);
  const [showNoAnswer, setShowNoAnswer] = useState(false);
  const { values: GOVERNORATES } = useGovernorateOptions();
  const canEditItems = usePermission("orders.edit_items");
  // بوابات الإجراءات = بوابات السيرفر نفسها: المالك (protectedProcedure + requireOwned) أو صلاحية الموظف المقابلة.
  const canConfirm = isAdmin || has("orders.confirm");
  const canCancel = isAdmin || has("orders.cancel");
  const canPostpone = isAdmin || has("orders.update");
  const canNoAnswer = isAdmin || has("orders.update");

  const { data: order, isLoading, isError, error, refetch } = trpc.orders.get.useQuery(
    { id: orderId },
    { enabled: orderId > 0 }
  );

  // حالة ربط بوسطة **لنشاط الأوردر نفسه** — بلا أي سر؛ الأزرار بتتعطّل برسالة واضحة.
  const bostaGate = trpc.carrierAccounts.status.useQuery(
    { businessId: (order as any)?.businessId ?? 0 },
    { enabled: isAdmin && Boolean((order as any)?.businessId) }
  );
  const bostaCanSend = bostaGate.data?.canSend ?? true;
  const bostaReason = bostaGate.data?.reason ?? null;

  const { data: products } = trpc.products.list.useQuery();
  // اسم الموظف المسؤول — نفس الـlookup المحلي المستخدم في صفحة الأوردرات (الـAPI بيرجع رقم فقط).
  const { data: employees } = trpc.employees.activeList.useQuery();
  const assignedEmployeeName = order?.assignedEmployeeId
    ? employees?.find((e: any) => e.id === order.assignedEmployeeId)?.name ?? `#${order.assignedEmployeeId}`
    : null;

  const sendToBostaMutation = trpc.orders.sendToBosta.useMutation({
    onSuccess: (result) => {
      if (result.success) {
        toast.success(`تم الإرسال لـ Bosta! رقم التتبع: ${result.trackingNumber || result.shipmentId}`);
        refetch();
      } else {
        toast.error(`فشل الإرسال: ${result.error}`);
      }
    },
    onError: (err) => {
      toast.error(err.message || "حدث خطأ أثناء الإرسال لـ Bosta");
    },
  });

  const editMutation = trpc.orders.editOrder.useMutation({
    onSuccess: () => {
      toast.success("تم تعديل بيانات الأوردر بنجاح");
      setIsEditing(false);
      refetch();
    },
    onError: (err) => {
      toast.error(err.message || "حدث خطأ أثناء التعديل");
    },
  });

  // محرر البنود المشترك — نفس اللي في صفحة الأوردرات وشاشة الموظف وشاشة التأكيدات.
  const { data: variantsList } = trpc.variants.all.useQuery(undefined);
  const {
    data: itemsData,
    isLoading: itemsLoading,
    error: itemsError,
  } = trpc.orders.orderItems.useQuery(
    { orderId },
    { enabled: showItemsEditor && orderId > 0, retry: false }
  );
  const editItemsMutation = trpc.orders.editOrderItems.useMutation();

  // سجل التعديلات الحقيقي (order_edit_logs) — endpoint موجود؛ protectedProcedure + requireOwned.
  const editHistory = trpc.orders.getEditHistory.useQuery({ orderId }, { enabled: orderId > 0 });

  // إجراءات الأوردر — نفس endpoints صفحة الأوردرات ونفس قواعدها؛ لا منطق أعمال هنا.
  const afterAction = (msg: string) => () => { toast.success(msg); refetch(); editHistory.refetch(); };
  const confirmMutation = trpc.orders.confirm.useMutation({ onSuccess: afterAction("تم تأكيد الأوردر"), onError: e => toast.error(e.message) });
  const cancelMutation = trpc.orders.cancel.useMutation({ onSuccess: () => { afterAction("تم إلغاء الأوردر")(); setShowCancel(false); }, onError: e => toast.error(e.message) });
  const postponeMutation = trpc.orders.postpone.useMutation({ onSuccess: () => { afterAction("تم تأجيل الأوردر")(); setShowPostpone(false); }, onError: e => toast.error(e.message) });
  const noAnswerMutation = trpc.orders.markNoAnswer.useMutation({ onSuccess: () => { afterAction("تم تسجيل لم يرد")(); setShowNoAnswer(false); }, onError: e => toast.error(e.message) });
  // حارس الضغط المكرر: `isPending` يتأخر render واحدًا، فالضغطة الثانية ترفض فورًا حتى onSettled.
  const confirmGuard = useRef(createInFlightGuard<number>()).current;
  const confirmOrder = () => {
    confirmGuard.run(orderId, confirmMutation.isPending, done => confirmMutation.mutate({ orderId, operationId: operationIdFor(`confirm:${orderId}`) }, { onSettled: done }));
  };
  const anyPending = confirmMutation.isPending || cancelMutation.isPending || postponeMutation.isPending || noAnswerMutation.isPending || sendToBostaMutation.isPending || editMutation.isPending || editItemsMutation.isPending;

  async function saveItemsEdit(payload: OrderEditSavePayload) {
    const { orderId: id, header, headerDirty, items, itemsDirty, shippingFees } = payload;
    if (itemsDirty) {
      await editItemsMutation.mutateAsync({
        orderId: id,
        items: items.map((l: any) => ({
          productId: l.productId,
          productName: l.productName,
          variantId: l.variantId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discount: l.discount,
        })),
        shippingFees,
      });
    }
    if (headerDirty) {
      await editMutation.mutateAsync({
        orderId: id,
        customerName: header.customerName,
        customerPhone: header.customerPhone,
        customerPhone2: header.customerPhone2,
        customerAddress: header.customerAddress,
        governorate: header.governorate,
        city: header.city,
        paymentMethod: header.paymentMethod,
        notes: header.notes,
        ...(itemsDirty ? {} : { shippingFees }),
      });
    }
    toast.success("تم حفظ التعديلات");
    setShowItemsEditor(false);
    refetch();
  }

  useEffect(() => {
    if (order) {
      setEditData({
        customerName: order.customerName,
        customerPhone: order.customerPhone,
        customerAddress: order.customerAddress,
        governorate: order.governorate,
        productId: order.productId,
        productName: order.productName,
        quantity: order.quantity,
        totalAmount: Number(order.totalAmount),
        notes: order.notes || "",
      });
    }
  }, [order]);

  // أسباب المراجعة: حقول حقيقية على الأوردر + جودة بيانات محسوبة محليًا (لا تنبؤ).
  const reviewReasons = useMemo(() => {
    if (!order) return [] as { key: string; text: string; tone: "warning" | "danger" | "info" }[];
    const o = order as any;
    const out: { key: string; text: string; tone: "warning" | "danger" | "info" }[] = [];
    if (order.needsReview) out.push({ key: "needsReview", text: order.reviewReason ? `يحتاج مراجعة: ${order.reviewReason}` : "يحتاج مراجعة", tone: "warning" });
    if (order.isDuplicate) out.push({ key: "duplicate", text: o.duplicateMarkedAt ? `مكرر — عُلّم في ${fmtDate(o.duplicateMarkedAt)}` : "مكرر", tone: "danger" });
    if (!isValidEgyptianMobile(order.customerPhone ?? "")) out.push({ key: "phone", text: "رقم الهاتف ليس رقم موبايل مصري صالح (01xxxxxxxxx)", tone: "warning" });
    if (!order.governorate) out.push({ key: "governorate", text: "المحافظة غير محددة", tone: "warning" });
    if (!order.customerAddress?.trim()) out.push({ key: "address", text: "العنوان فارغ", tone: "warning" });
    if (o.contentChangedAfterShipment) out.push({ key: "stale", text: SHIPMENT_STALE_WARNING, tone: "danger" });
    if (order.bostaLastError && !order.bostaShipmentId) out.push({ key: "bosta", text: `خطأ Bosta: ${order.bostaLastError}`, tone: "danger" });
    return out;
  }, [order]);

  if (!online && !order) {
    return <OfflineState onRetry={() => refetch()} />;
  }
  if (isLoading) {
    return <LoadingSkeleton variant="form" rows={8} />;
  }
  if (isError) {
    const code = (error as any)?.data?.code;
    if (code === "FORBIDDEN" || code === "UNAUTHORIZED") return <PermissionDeniedState message="هذا الأوردر خارج نطاقك أو لا تملك صلاحية عرضه." />;
    return <ErrorState message={(error as any)?.message || "تعذّر تحميل الأوردر"} onRetry={() => refetch()} />;
  }
  if (!order) {
    return (
      <EmptyState
        title="الأوردر غير موجود"
        description="ربما حُذف أو أن الرقم غير صحيح."
        action={
          <Button data-readonly-safe variant="outline" className="min-h-11 md:min-h-9" onClick={() => setLocation("/orders")}>
            <ArrowRight className="h-4 w-4 ml-1" /> العودة للأوردرات
          </Button>
        }
      />
    );
  }

  const handleSave = () => {
    const updates: any = { orderId };
    if (editData.customerName !== order.customerName) updates.customerName = editData.customerName;
    if (editData.customerPhone !== order.customerPhone) updates.customerPhone = editData.customerPhone;
    if (editData.customerAddress !== order.customerAddress) updates.customerAddress = editData.customerAddress;
    if (editData.governorate !== order.governorate) updates.governorate = editData.governorate;
    if (Number(editData.totalAmount) !== Number(order.totalAmount)) updates.totalAmount = Number(editData.totalAmount);
    if (editData.notes !== (order.notes || "")) updates.notes = editData.notes;

    if (Object.keys(updates).length <= 1) {
      toast.info("لم يتم تعديل أي بيانات");
      setIsEditing(false);
      return;
    }
    editMutation.mutate(updates);
  };
  const cancelEditing = () => {
    setIsEditing(false);
    setEditData({ customerName: order.customerName, customerPhone: order.customerPhone, customerAddress: order.customerAddress, governorate: order.governorate, productId: order.productId, productName: order.productName, quantity: order.quantity, totalAmount: Number(order.totalAmount), notes: order.notes || "" });
  };

  const o = order as any;
  const items: any[] = Array.isArray(o.items) ? o.items : [];
  const businessName = o.businessId != null ? (businesses.find(b => b.id === o.businessId)?.name ?? null) : null;
  const bostaEligible = order.status === 'confirmed' || order.status === 'printed' || order.status === 'preparing' || order.status === 'shipped';
  const collection = order.collectionStatus ? COLLECTION_STATUS[order.collectionStatus] : undefined;
  const pay = paymentLabel(order as any);
  const canAct = isActionable(order as any);

  // قائمة «المزيد»: مفلترة بالصلاحية/الحالة — ما ليس مسموحًا لا يظهر.
  const more = [
    ...(isAdmin && !isEditing ? [{ key: "edit", label: "تعديل البيانات", icon: <Edit2 className="h-4 w-4 ml-2" aria-hidden="true" />, onSelect: () => setIsEditing(true) }] : []),
    { key: "items", label: "تعديل الأصناف", icon: <Package className="h-4 w-4 ml-2" aria-hidden="true" />, onSelect: () => setShowItemsEditor(true) },
    ...(isAdmin && order.bostaShipmentId ? [{ key: "awb", label: "طباعة AWB", icon: <Printer className="h-4 w-4 ml-2" aria-hidden="true" />, disabled: !bostaCanSend, onSelect: () => window.open(`/api/orders/${order.id}/bosta-awb`, "_blank", "noopener,noreferrer") }] : []),
  ];

  return (
    <div className="space-y-5 pb-[128px] md:pb-0" data-testid="order-details-page">
      <PageHeader
        title={`أوردر #${order.orderNumber}`}
        icon={<Hash className="h-5 w-5" aria-hidden="true" />}
        description={`أُنشئ ${fmtDate(order.createdAt)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button data-readonly-safe variant="ghost" className="min-h-11 md:min-h-9" onClick={() => setLocation("/orders")} aria-label="العودة للأوردرات">
              <ArrowRight className="h-4 w-4 ml-1" aria-hidden="true" /> الأوردرات
            </Button>
            {isEditing && (
              <>
                <Button className="min-h-11 md:min-h-9" onClick={handleSave} disabled={editMutation.isPending} data-testid="edit-save">
                  <Save className="h-4 w-4 ml-1" aria-hidden="true" /> {editMutation.isPending ? "جارٍ الحفظ…" : "حفظ"}
                </Button>
                <Button variant="outline" className="min-h-11 md:min-h-9" onClick={cancelEditing} disabled={editMutation.isPending} data-testid="edit-cancel">
                  <X className="h-4 w-4 ml-1" aria-hidden="true" /> إلغاء التعديل
                </Button>
              </>
            )}
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2" data-testid="od-header-badges">
          <StatusBadge status={order.status} kind="order" label={STATUS_LABELS[order.status]} />
          <StatusBadge status={order.source} kind="source" label={SOURCE_LABELS[order.source] || order.source} />
        </div>
      </PageHeader>

      {/*
        الإجراءات الأساسية: ثابتة أسفل الشاشة على الموبايل (فوق MobileBottomNav)، شريط عادي على الديسكتوب.
        داخل حاوية ثابتة حتى لا يرث العنصر fixed هامش space-y (margin-block-end) فيرتفع عن القائمة السفلية.
      */}
      <div data-testid="order-action-bar-slot">
      <OrderActionBar
        phone={order.customerPhone}
        actionable={isActionable(order as any)}
        can={{ confirm: canConfirm, cancel: canCancel, postpone: canPostpone, noAnswer: canNoAnswer }}
        pending={{ confirm: confirmMutation.isPending, cancel: cancelMutation.isPending, postpone: postponeMutation.isPending, noAnswer: noAnswerMutation.isPending, any: anyPending }}
        onConfirm={confirmOrder}
        onCancel={() => setShowCancel(true)}
        onPostpone={() => setShowPostpone(true)}
        onNoAnswer={() => setShowNoAnswer(true)}
        more={more}
      />
      </div>

      {o.contentChangedAfterShipment && (
        /*
          بوسطة مالهاش عندنا مسار «تحديث شحنة»، فاللي عندها هو نسخة وقت الإرسال. لو
          المحتوى اتعدّل بعدها، الشاشة لازم تقول كده بصراحة — عرض أوردر معدّل جوّه
          والشحنة برّه مختلفة من غير أي إشارة هو أسوأ من الغلط نفسه.
        */
        <div className="flex items-start gap-2 rounded-[var(--radius-brand-md)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-sm" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" aria-hidden="true" />
          <div>
            <p className="font-semibold text-[var(--warning)]">{SHIPMENT_STALE_WARNING}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              لو الفرق يهم، ألغِ الشحنة في بوسطة وأنشئ شحنة جديدة — التحديث التلقائي مش متاح.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* 1 — الهوية والمصدر والحالة */}
        <SectionCard title="الهوية والمصدر والحالة" icon={<Hash className="h-4 w-4" aria-hidden="true" />} testId="od-section-identity">
          <div className="grid grid-cols-2 gap-4">
            <Field label="رقم الأوردر"><span className="tabular-nums" dir="ltr">{order.orderNumber}</span></Field>
            <Field label="الحالة"><StatusBadge status={order.status} kind="order" label={STATUS_LABELS[order.status]} size="sm" /></Field>
            <Field label="المصدر">
              <span className="inline-flex items-center gap-1.5">
                {sourceLogo(order.source) && <PartnerLogo partner={sourceLogo(order.source)!} size="xs" decorative />}
                {SOURCE_LABELS[order.source] || order.source}
              </span>
            </Field>
            <Field label="رقم خارجي">{o.externalOrderId || o.easyOrderShortId || "-"}</Field>
            <Field label="اسم الإعلان">{order.adName || "-"}</Field>
            <Field label="اسم الصفحة">{order.pageName || "-"}</Field>
            <Field label="ملاحظات" icon={<FileText className="h-3 w-3" aria-hidden="true" />} className="col-span-2">
              {isEditing ? (
                <Textarea value={editData.notes} onChange={e => setEditData({ ...editData, notes: e.target.value })} rows={3} placeholder="ملاحظات إضافية..." aria-label="ملاحظات" />
              ) : (
                <span className="font-normal text-muted-foreground">{order.notes || "لا توجد ملاحظات"}</span>
              )}
            </Field>
          </div>
        </SectionCard>

        {/* 2 — العميل */}
        <SectionCard title="العميل" icon={<User className="h-4 w-4" aria-hidden="true" />} testId="od-section-customer">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="اسم العميل">
              {isEditing ? <Input value={editData.customerName} onChange={e => setEditData({ ...editData, customerName: e.target.value })} aria-label="اسم العميل" className="min-h-11 md:min-h-9" /> : order.customerName}
            </Field>
            <Field label="رقم الهاتف" icon={<Phone className="h-3 w-3" aria-hidden="true" />}>
              {isEditing ? (
                <Input value={editData.customerPhone} onChange={e => setEditData({ ...editData, customerPhone: e.target.value })} dir="ltr" inputMode="tel" aria-label="رقم الهاتف" className="min-h-11 md:min-h-9" />
              ) : (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span dir="ltr" className="tabular-nums">{order.customerPhone}</span>
                  {!isValidEgyptianMobile(order.customerPhone ?? "") && <span className="text-xs font-normal text-[var(--warning)]">رقم غير صالح</span>}
                  <WhatsAppButton phone={order.customerPhone} iconOnly size="icon-sm" className="min-h-11 min-w-11 md:min-h-9 md:min-w-9" />
                </span>
              )}
            </Field>
            <Field label="رقم إضافي">{o.customerPhone2 ? <span dir="ltr" className="tabular-nums">{o.customerPhone2}</span> : "-"}</Field>
            <Field label="المحافظة" icon={<MapPin className="h-3 w-3" aria-hidden="true" />}>
              {isEditing ? <Input value={editData.governorate} onChange={e => setEditData({ ...editData, governorate: e.target.value })} aria-label="المحافظة" list="od-governorates" className="min-h-11 md:min-h-9" /> : (order.governorate || <span className="text-[var(--warning)]">غير محددة</span>)}
              {isEditing && <datalist id="od-governorates">{GOVERNORATES.map(g => <option key={g} value={g} />)}</datalist>}
            </Field>
            <Field label="المدينة / المركز">{o.city || "-"}</Field>
            <Field label="العنوان" icon={<MapPin className="h-3 w-3" aria-hidden="true" />} className="sm:col-span-2">
              {isEditing ? <Textarea value={editData.customerAddress} onChange={e => setEditData({ ...editData, customerAddress: e.target.value })} rows={3} aria-label="العنوان" /> : (order.customerAddress || <span className="text-[var(--warning)]">فارغ</span>)}
            </Field>
          </div>
        </SectionCard>

        {/* 3 — المنتجات والكميات والمتغيرات/الحفر لكل قطعة */}
        <SectionCard
          title="المنتجات والكميات"
          icon={<Package className="h-4 w-4" aria-hidden="true" />}
          action={
            <Button variant="outline" size="sm" className="min-h-11 md:min-h-9" onClick={() => setShowItemsEditor(true)} data-testid="open-items-editor">
              <Package className="h-3.5 w-3.5 ml-1" aria-hidden="true" /> تعديل الأصناف
            </Button>
          }
          testId="od-section-items"
        >
          {/*
            المنتج والكمية بيتعدّلوا من محرر البنود، مش من هنا. الفورم ده كان بيبعت
            اسم المنتج والكمية على مسار بيكتب في هيدر الأوردر بس، فالبنود (اللي
            بوسطة والتجهيز بيقروا منها) كانت بتفضل على القديم.
          */}
          {items.length > 0 ? (
            <ol className="divide-y divide-border" aria-label="بنود الأوردر">
              {(order as any).items.map((it: any, i: number) => (
                <li key={it.id ?? i} className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0" data-testid={`od-item-${i}`}>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{it.productName}</p>
                    {(it.variantName || it.color || it.size) ? (
                      <p className="text-xs text-[var(--info)]">{it.variantName || [it.color, it.size].filter(Boolean).join(' / ')}</p>
                    ) : (
                      <p className="text-xs text-muted-foreground">بدون متغير/حفر</p>
                    )}
                  </div>
                  <div className="shrink-0 text-end text-sm tabular-nums">
                    <p className="font-semibold">× {it.quantity}</p>
                    {it.unitPrice != null && <p className="text-xs text-muted-foreground">{money(it.unitPrice)}</p>}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-medium">{order.productName}</p>
                <p className="text-xs text-muted-foreground">لا توجد بنود تفصيلية مسجلة — المعروض من رأس الأوردر</p>
              </div>
              <p className="shrink-0 text-sm font-semibold tabular-nums">× {order.quantity}</p>
            </div>
          )}
          <div className="mt-3 flex items-center justify-between border-t border-border pt-2 text-xs">
            <span className="font-semibold text-muted-foreground">إجمالي القطع</span>
            <span className="font-bold tabular-nums" data-testid="od-total-pieces">{items.length > 0 ? items.reduce((s: number, it: any) => s + (it.quantity || 0), 0) : order.quantity} قطعة</span>
          </div>
        </SectionCard>

        {/* 4 — الأسعار والتحصيل */}
        <SectionCard title="الأسعار والتحصيل" icon={<Receipt className="h-4 w-4" aria-hidden="true" />} testId="od-section-prices">
          <div className="grid grid-cols-2 gap-4">
            <Field label="المبلغ الإجمالي">
              {isEditing ? (
                <Input type="number" min={0} value={editData.totalAmount} onChange={e => setEditData({ ...editData, totalAmount: parseFloat(e.target.value) || 0 })} aria-label="المبلغ الإجمالي" className="min-h-11 md:min-h-9" />
              ) : (
                <span className="tabular-nums text-[var(--success)]">{money(order.totalAmount)}</span>
              )}
            </Field>
            <Field label="رسوم الشحن المسجلة"><span className="tabular-nums">{order.shippingFees != null ? money(order.shippingFees) : <Unavailable />}</span></Field>
            <Field label="رسوم الشحن المتوقعة"><span className="tabular-nums">{o.projectedShippingCostSnapshot != null ? money(o.projectedShippingCostSnapshot) : <Unavailable />}</span></Field>
            <Field label="طريقة الدفع">{pay ?? <Unavailable />}</Field>
            <Field label="حالة التحصيل">
              {collection ? <StatusBadge status={order.collectionStatus!} label={collection.label} tone={collection.tone === "danger" ? "danger" : collection.tone === "success" ? "success" : collection.tone === "warning" ? "warning" : "neutral"} size="sm" /> : <Unavailable />}
            </Field>
            <Field label="المحصَّل فعليًا"><span className="tabular-nums">{o.collectedAmount != null ? money(o.collectedAmount) : <Unavailable />}</span></Field>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">المبلغ الإجمالي قيمة الأوردر وليس نقدًا محصّلًا؛ التحصيل يظهر عند تسجيله فقط.</p>
        </SectionCard>

        {/* 5 — الشحن والناقل */}
        <SectionCard title="الشحن والناقل" icon={<Truck className="h-4 w-4" aria-hidden="true" />} testId="od-section-shipping">
          <div className="grid grid-cols-2 gap-4">
            <Field label="الناقل">
              <span className="inline-flex items-center gap-1.5">
                {order.bostaShipmentId ? <PartnerLogo partner="bosta" size="xs" decorative /> : <Truck className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />}
                {order.bostaShipmentId ? "Bosta" : <Unavailable />}
              </span>
            </Field>
            <Field label="رقم التتبع (AWB)">{order.bostaTrackingNumber ? <span dir="ltr" className="tabular-nums">{order.bostaTrackingNumber}</span> : <Unavailable />}</Field>
            <Field label="رقم الشحنة">{order.bostaShipmentId ? <span dir="ltr" className="tabular-nums">{order.bostaShipmentId}</span> : <Unavailable />}</Field>
            <Field label="حالة الشحنة">{o.bostaStatus || <Unavailable />}</Field>
            <Field label="تاريخ الإرسال للناقل">{order.bostaSentAt ? fmtDate(order.bostaSentAt) : <Unavailable />}</Field>
            <Field label="موعد التوصيل المتوقع"><Unavailable /></Field>
            <Field label="احتمال الاستلام"><ReceiptPrediction probability={null} compact /></Field>
            <Field label="المحاولات"><AttemptsCell callAttempts={(order as any).noAnswerCallAttempts ?? null} deliveryAttempts={null} /></Field>
            {order.bostaLastError && !order.bostaShipmentId && (
              <Field label="خطأ Bosta" icon={<AlertCircle className="h-3 w-3 text-destructive" aria-hidden="true" />} className="col-span-2">
                <span className="text-destructive">{order.bostaLastError}</span>
              </Field>
            )}
          </div>
          {isAdmin && !isEditing && bostaEligible && (
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3" data-testid="bosta-controls">
              {order.bostaShipmentId ? (
                <>
                  <Button variant="outline" size="sm" className="min-h-11 md:min-h-9 text-[var(--success)] border-[var(--success)]/40" disabled>
                    <CheckCircle className="h-4 w-4 ml-1" aria-hidden="true" /> مرسل لـ Bosta
                  </Button>
                  <Button data-readonly-safe
                    variant="outline"
                    size="sm"
                    className="min-h-11 md:min-h-9 text-[var(--info)] border-[var(--info)]/40"
                    onClick={() => window.open(`/api/orders/${order.id}/bosta-awb`, "_blank", "noopener,noreferrer")}
                    disabled={!bostaCanSend}
                    title={bostaCanSend ? undefined : bostaReason ?? undefined}
                  >
                    <Printer className="h-4 w-4 ml-1" aria-hidden="true" /> طباعة AWB
                  </Button>
                </>
              ) : (
                <>
                  {isAdmin && bostaCanSend && <BostaShipmentImagePreview orderId={order.id} />}
                  <label className="flex min-h-11 items-center gap-1 text-xs md:min-h-9">
                    <input type="checkbox" checked={bostaDeposit} onChange={e => setBostaDeposit(e.target.checked)} data-testid="bosta-deposit-toggle" className="h-5 w-5" />
                    ديبوزيت
                    {bostaDeposit && (
                      <input type="number" min="1" value={bostaDepositAmount} onChange={e => setBostaDepositAmount(e.target.value)} aria-label="قيمة الديبوزيت"
                        className="h-9 w-20 rounded border border-border bg-background px-1 text-xs md:h-7 md:w-16" data-testid="bosta-deposit-amount" />
                    )}
                  </label>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`min-h-11 md:min-h-9 ${order.bostaLastError ? "text-destructive border-destructive/40" : "text-[var(--info)] border-[var(--info)]/40"}`}
                    onClick={() => sendToBostaMutation.mutate({
                      orderId: order.id,
                      depositAmount: bostaDeposit ? Math.max(1, Number(bostaDepositAmount) || 0) : undefined,
                    })}
                    disabled={sendToBostaMutation.isPending || !bostaCanSend}
                    title={bostaCanSend ? undefined : bostaReason ?? undefined}
                    data-testid="bosta-send"
                  >
                    {sendToBostaMutation.isPending ? (
                      <RefreshCw className="h-4 w-4 ml-1 animate-spin" aria-hidden="true" />
                    ) : (
                      <Truck className="h-4 w-4 ml-1" aria-hidden="true" />
                    )}
                    {order.bostaLastError ? "إعادة إرسال Bosta" : "إرسال لـ Bosta"}
                  </Button>
                </>
              )}
              {!bostaCanSend && bostaReason && <p className="basis-full text-xs text-muted-foreground">{bostaReason}</p>}
            </div>
          )}
        </SectionCard>

        {/* 6 — المسؤول والنشاط والتواريخ */}
        <SectionCard title="المسؤول والنشاط والتواريخ" icon={<UserCheck className="h-4 w-4" aria-hidden="true" />} testId="od-section-assignment">
          <div className="grid grid-cols-2 gap-4">
            <Field label="الموظف المسؤول">{assignedEmployeeName ?? "غير موزع"}</Field>
            <Field label="النشاط" icon={<Building2 className="h-3 w-3" aria-hidden="true" />}>{businessName ?? (o.businessId != null ? `#${o.businessId}` : <Unavailable />)}</Field>
            <Field label="أكّده">{order.confirmedByEmployeeName || "-"}</Field>
            <Field label="تاريخ الإنشاء" icon={<Calendar className="h-3 w-3" aria-hidden="true" />}>{fmtDate(order.createdAt)}</Field>
            <Field label="تاريخ التوزيع">{fmtDate(order.assignedAt)}</Field>
            <Field label="تاريخ التأكيد">{fmtDate(order.confirmedAt)}</Field>
            <Field label="تاريخ الطباعة">{fmtDate(order.printedAt)}</Field>
            <Field label="تاريخ الشحن">{fmtDate(o.shippedAt)}</Field>
            <Field label="تاريخ التوصيل">{fmtDate(o.deliveredAt)}</Field>
            {order.postponedTo && <Field label="مؤجل إلى">{fmtDate(order.postponedTo)}</Field>}
            {order.cancelledAt && <Field label="تاريخ الإلغاء">{fmtDate(order.cancelledAt)}</Field>}
            {order.cancelReason && <Field label="سبب الإلغاء"><span className="text-destructive">{order.cancelReason}</span></Field>}
          </div>
          {/* مراحل الأوردر — خط زمني هادي مبني من تواريخ المراحل المسجلة فعليًا على الأوردر */}
          <div className="mt-4 border-t border-border pt-3">
            <p className="mb-2 text-xs font-semibold text-muted-foreground">مراحل الأوردر</p>
            {(() => {
              const stages: { label: string; date: any; extra?: string }[] = [
                { label: "إنشاء الأوردر", date: order.createdAt },
                { label: "التوزيع على موظف", date: order.assignedAt, extra: assignedEmployeeName ?? undefined },
                { label: "التأكيد", date: order.confirmedAt, extra: order.confirmedByEmployeeName ?? undefined },
                { label: "الطباعة", date: order.printedAt },
                { label: "الشحن", date: (order as any).shippedAt },
                { label: "التوصيل", date: (order as any).deliveredAt },
              ];
              // آخر مرحلة متحققة — كل اللي قبلها مكتمل، واللي بعدها قادم (رمادي).
              const lastDone = stages.reduce((acc, s, i) => (s.date ? i : acc), 0);
              return (
                <ol className="space-y-0">
                  {stages.map((s, i) => {
                    const done = Boolean(s.date);
                    const isCurrent = i === lastDone && done;
                    return (
                      <li key={s.label} className="relative flex gap-3 pb-4 last:pb-0">
                        {i < stages.length - 1 && (
                          <span className={`absolute right-[9px] top-6 bottom-0 w-0.5 ${stages[i + 1].date ? "bg-[var(--success)]" : "bg-border"}`} aria-hidden="true" />
                        )}
                        <span className={`relative z-[1] mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${done ? "border-[var(--success)] bg-[var(--success)]" : "border-border bg-card"}`} aria-hidden="true">
                          {done && <CheckCircle className="h-3.5 w-3.5 text-white" />}
                        </span>
                        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                          <p className={`text-sm ${done ? "font-semibold" : "text-muted-foreground"} ${isCurrent ? "text-[var(--success)]" : ""}`}>{s.label}</p>
                          {s.date && <p className="text-xs text-muted-foreground tabular-nums">{fmtDate(s.date)}</p>}
                          {s.extra && <p className="text-xs font-medium text-muted-foreground">بواسطة: {s.extra}</p>}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              );
            })()}
            {/* أحداث استثنائية خارج المسار الطبيعي — تظهر فقط لو حصلت */}
            {(order.status === "cancelled" || order.status === "postponed" || order.status === "no_answer" || order.status === "returned") && (
              <div className={`mt-3 rounded-[var(--radius-brand-md)] border p-3 text-sm ${
                order.status === "cancelled" || order.status === "returned"
                  ? "border-destructive/30 bg-destructive/5 text-destructive"
                  : "border-[var(--warning)]/30 bg-[var(--warning)]/5 text-[var(--warning)]"
              }`} data-testid="od-exception">
                <p className="font-semibold">{STATUS_LABELS[order.status]}</p>
                {order.status === "cancelled" && order.cancelReason && <p className="mt-0.5 text-xs">السبب: {order.cancelReason}</p>}
                {order.status === "cancelled" && order.cancelledAt && <p className="mt-0.5 text-xs">{fmtDate(order.cancelledAt)}</p>}
                {order.status === "postponed" && order.postponedTo && <p className="mt-0.5 text-xs">مؤجل إلى: {fmtDate(order.postponedTo)}</p>}
                {order.status === "no_answer" && (order as any).noAnswerCallAttempts != null && (
                  <p className="mt-0.5 text-xs">عدد محاولات الاتصال: {(order as any).noAnswerCallAttempts}</p>
                )}
              </div>
            )}
          </div>
        </SectionCard>

        {/* 7 — المراجعة وجودة البيانات */}
        <SectionCard title="المراجعة وجودة البيانات" icon={<ShieldAlert className="h-4 w-4" aria-hidden="true" />} testId="od-section-review">
          {reviewReasons.length === 0 ? (
            <EmptyState title="لا ملاحظات مراجعة" description="الأوردر غير معلّم للمراجعة وبياناته الأساسية مكتملة." className="py-6" />
          ) : (
            <ul className="space-y-2" aria-label="أسباب المراجعة">
              {reviewReasons.map(r => (
                <li key={r.key} className={`flex items-start gap-2 rounded-[var(--radius-brand-md)] border p-2.5 text-sm ${r.tone === "danger" ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-[var(--warning)]/30 bg-[var(--warning)]/5 text-[var(--warning)]"}`} data-testid={`od-review-${r.key}`}>
                  {r.key === "duplicate" ? <Copy className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />}
                  <span>{r.text}</span>
                </li>
              ))}
            </ul>
          )}
          <dl className="mt-3 grid grid-cols-2 gap-3 border-t border-border pt-3 text-xs">
            <div><dt className="text-muted-foreground">يحتاج مراجعة</dt><dd className="font-medium">{order.needsReview ? "نعم" : "لا"}</dd></div>
            <div><dt className="text-muted-foreground">مكرر</dt><dd className="font-medium">{order.isDuplicate ? "نعم" : "لا"}</dd></div>
          </dl>
        </SectionCard>

        {/* 8 — سجل الإجراءات (order_edit_logs — مصدر حقيقي) */}
        <SectionCard title="سجل التعديلات" icon={<History className="h-4 w-4" aria-hidden="true" />} testId="od-section-log" className="lg:col-span-2">
          {editHistory.isLoading ? (
            <LoadingSkeleton variant="table" rows={3} />
          ) : editHistory.isError ? (
            <ErrorState message={(editHistory.error as any)?.message || "تعذّر تحميل السجل"} onRetry={() => editHistory.refetch()} />
          ) : !editHistory.data || editHistory.data.length === 0 ? (
            <EmptyState title="لا تعديلات مسجلة" description="يظهر هنا كل تعديل على بيانات الأوردر مع من قام به ووقته." className="py-6" />
          ) : (
            <ol className="divide-y divide-border" aria-label="سجل التعديلات">
              {editHistory.data.map((log: any) => (
                <li key={log.id} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between" data-testid="od-log-row">
                  <div className="min-w-0 text-sm">
                    <span className="font-medium">{FIELD_LABELS[log.field] ?? log.field}</span>
                    <span className="text-muted-foreground"> — من «{log.oldValue ?? "-"}» إلى «{log.newValue ?? "-"}»</span>
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground tabular-nums">{log.editedByName} · {fmtDate(log.createdAt)}</div>
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      </div>

      {/* محرر بنود الأوردر — نفس المكوّن المشترك في كل الشاشات */}
      <OrderEditDialog
        open={showItemsEditor}
        onOpenChange={setShowItemsEditor}
        order={order}
        items={itemsData}
        itemsLoading={itemsLoading}
        itemsError={itemsError}
        products={(products ?? []) as any}
        variants={(variantsList ?? []) as any}
        configuredGovernorates={GOVERNORATES}
        saving={editItemsMutation.isPending || editMutation.isPending}
        onSave={saveItemsEdit}
        allowItemsEdit={canEditItems}
      />

      {/* حوارات الإجراءات — نفس قواعد صفحة الأوردرات (سبب إلغاء إلزامي، تاريخ تأجيل إلزامي) */}
      {canAct && canCancel && (
        <CancelOrderDialog open={showCancel} onOpenChange={setShowCancel} pending={cancelMutation.isPending}
          onConfirm={v => { if (!cancelMutation.isPending) cancelMutation.mutate({ orderId, cancelReason: v.cancelReason, notes: v.notes, operationId: operationIdFor(`cancel:${orderId}`) }); }} />
      )}
      {canAct && canPostpone && (
        <PostponeOrderDialog open={showPostpone} onOpenChange={setShowPostpone} pending={postponeMutation.isPending}
          onConfirm={v => { if (!postponeMutation.isPending) postponeMutation.mutate({ orderId, postponedTo: v.postponedTo, notes: v.notes, operationId: operationIdFor(`postpone:${orderId}`) }); }} />
      )}
      {canAct && canNoAnswer && (
        <NoAnswerDialog open={showNoAnswer} onOpenChange={setShowNoAnswer} pending={noAnswerMutation.isPending}
          onConfirm={v => { if (!noAnswerMutation.isPending) noAnswerMutation.mutate({ orderId, callAttempts: v.callAttempts, operationId: operationIdFor(`no_answer:${orderId}`) }); }} />
      )}
    </div>
  );
}

function fmtDate(date: any) {
  if (!date) return "-";
  return new Date(date).toLocaleString("ar-EG", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
