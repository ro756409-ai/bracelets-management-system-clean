import { useState, useMemo, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { operationIdFor } from "@/lib/operationId";
import { useAuth } from "@/_core/hooks/useAuth";
import { useOperationalOptions } from "@/hooks/useOperationalOptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  OrderEditDialog,
  type OrderEditSavePayload,
} from "@/components/orders/OrderEditDialog";
import { useGovernorateOptions } from "@/hooks/useGovernorateOptions";
import { usePermission } from "@/hooks/usePermission";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { createInFlightGuard } from "@/components/orders/confirmGuard";
import { PageHeader, StatCard, SectionCard, StatusBadge, EmptyState, LoadingSkeleton, OfflineState } from "@/components/shared";
import { toast } from "sonner";
import { CheckCircle, XCircle, Clock, Phone, MapPin, Package, Calendar, Edit2, ChevronRight, ChevronLeft, Briefcase } from "lucide-react";
import { cairoDateKey } from "@/lib/cairoDate";

const TOUCH = "min-h-11 md:min-h-9";

/**
 * مساحة عمل موظف التأكيد (جلسة لوحة التحكم) — نفس الاستعلامات والـmutations (orders.myOrders/confirm/cancel/
 * editOrder/editOrderItems/orderItems/postpone + products.list/variants.all) ونفس الـpayload ونفس محرر البنود
 * المشترك. المرحلة 7I (عرض فقط): PageHeader، بطاقات إحصاء تعمل كفلتر (StatCard)، تنقّل أيام 44px، شارات
 * الحالة المشتركة، أزرار 44px، حارس ضغط مكرر على التأكيد، وحالات Loading/Empty/Offline.
 */
export default function AgentWorkspace() {
  const cancelReasonOptions = useOperationalOptions("cancellation_reason").options;
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const online = useOnlineStatus();
  const guard = useRef(createInFlightGuard<number>()).current;

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showPostponeDialog, setShowPostponeDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  // الصف الكامل اللي فُتح منه التعديل — بيتخزّن وقت الفتح عشان الهيدر ميعتمدش على إعادة
  // البحث في `orders` (شوف editingOrder تحت). نفس إصلاح صفحة Orders.
  const [editOrderData, setEditOrderData] = useState<any | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelNotes, setCancelNotes] = useState("");
  const [postponeDate, setPostponeDate] = useState("");
  const [postponeNotes, setPostponeNotes] = useState("");
  const { values: GOVERNORATES } = useGovernorateOptions();
  const canEditItems = usePermission("orders.edit_items");

  // تاريخ التوزيع - افتراضياً اليوم (يوم القاهرة الفعلي، صيفي أو شتوي)
  const todayCairo = useMemo(() => cairoDateKey(), []);
  const [assignedDate, setAssignedDate] = useState<string>(todayCairo);

  const queryParams = useMemo(() => ({
    status: statusFilter !== "all" ? statusFilter : undefined,
    limit: 200,
    assignedDate,
  }), [statusFilter, assignedDate]);

  const { data, isLoading, refetch } = trpc.orders.myOrders.useQuery(queryParams);
  const orders = data?.orders ?? [];
  const total = data?.total ?? 0;

  const confirmMutation = trpc.orders.confirm.useMutation({
    onSuccess: () => { toast.success("تم تأكيد الأوردر"); utils.orders.myOrders.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const cancelMutation = trpc.orders.cancel.useMutation({
    onSuccess: () => {
      toast.success("تم إلغاء الأوردر");
      utils.orders.myOrders.invalidate();
      setShowCancelDialog(false);
      setCancelReason(""); setCancelNotes("");
    },
    onError: (e) => toast.error(e.message),
  });

  /**
   * التعديل هنا بيمشي على **نفس** المسار اللي في صفحة الأوردرات وشاشة الموظف:
   * `editOrderItems` للسلة و`editOrder` لبيانات العميل. الشاشة دي كان عندها فورم
   * صغير خاص بيها بيبعت اسم المنتج والكمية على `editOrder` لوحدها — والمسار ده بيكتب
   * في هيدر الأوردر بس، فالبنود (اللي بوسطة بتقرا منها) كانت بتفضل على القديم.
   * محرر بنود تاني بمنطق تاني هو اللي خلق الاختلاف، فالحل مش تصليحه — الحل إنه يتشال.
   */
  const editOrderMutation = trpc.orders.editOrder.useMutation();
  const editItemsMutation = trpc.orders.editOrderItems.useMutation();
  const editSaving = editOrderMutation.isPending || editItemsMutation.isPending;

  const { data: products } = trpc.products.list.useQuery(undefined);
  const { data: variantsList } = trpc.variants.all.useQuery(undefined);
  const {
    data: editItemsData,
    isLoading: editItemsLoading,
    error: editItemsError,
  } = trpc.orders.orderItems.useQuery(
    { orderId: selectedOrderId ?? 0 },
    { enabled: showEditDialog && selectedOrderId != null, retry: false }
  );
  // الكائن المخزّن أولاً؛ البحث في `orders` fallback بس (لأي فتح برمجي من غير كائن).
  const editingOrder =
    editOrderData ?? orders.find(o => o.id === selectedOrderId) ?? null;

  /** نفس ترتيب الحفظ اللي في صفحة الأوردرات: البنود الأول عشان الإجمالي يتحسب منها. */
  async function saveOrderEdit(payload: OrderEditSavePayload) {
    const { orderId, header, headerDirty, items, itemsDirty, shippingFees } = payload;
    if (itemsDirty) {
      await editItemsMutation.mutateAsync({
        orderId,
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
      await editOrderMutation.mutateAsync({
        orderId,
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
    toast.success("تم تعديل الأوردر بنجاح");
    utils.orders.myOrders.invalidate();
    utils.orders.orderItems.invalidate({ orderId });
    setShowEditDialog(false);
  }

  const postponeMutation = trpc.orders.postpone.useMutation({
    onSuccess: () => {
      toast.success("تم تأجيل الأوردر");
      utils.orders.myOrders.invalidate();
      setShowPostponeDialog(false);
      setPostponeDate(""); setPostponeNotes("");
    },
    onError: (e) => toast.error(e.message),
  });

  const handleConfirm = (orderId: number) => {
    guard.run(orderId, confirmMutation.isPending, done => confirmMutation.mutate({ orderId, operationId: operationIdFor(`confirm:${orderId}`) }, { onSettled: done }));
  };

  // Stats for this agent
  const newCount = orders.filter(o => o.status === 'new').length;
  const confirmedCount = orders.filter(o => o.status === 'confirmed').length;
  const postponedCount = orders.filter(o => o.status === 'postponed').length;
  const cancelledCount = orders.filter(o => o.status === 'cancelled').length;
  const confirmRate = total > 0 ? Math.round((confirmedCount / total) * 100) : 0;

  // تنقل بين الأيام
  function changeDay(delta: number) {
    const d = new Date(assignedDate + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    setAssignedDate(d.toISOString().slice(0, 10));
    setStatusFilter('all');
  }
  const isToday = assignedDate === todayCairo;
  const displayDate = new Date(assignedDate + 'T12:00:00').toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const toggle = (s: string) => setStatusFilter(statusFilter === s ? 'all' : s);

  return (
    <div className="space-y-6" dir="rtl" data-testid="agent-workspace">
      <PageHeader
        title="مساحة العمل"
        description={`أوردراتك المُسندة إليك - ${user?.name ?? ""}`}
        icon={<Briefcase className="h-5 w-5" aria-hidden="true" />}
        actions={
          <div className="flex items-center gap-1 rounded-[var(--radius-brand-md)] bg-muted/50 px-2 py-1" role="group" aria-label="يوم التوزيع" data-testid="agent-day-nav">
            <Button data-readonly-safe type="button" variant="ghost" size="sm" className="min-h-11 min-w-11 md:min-h-9 md:min-w-9" onClick={() => changeDay(-1)} aria-label="اليوم السابق" title="اليوم السابق"><ChevronRight className="h-4 w-4" aria-hidden="true" /></Button>
            <div className="min-w-[140px] text-center">
              <p className="text-xs font-semibold text-foreground">{displayDate}</p>
              {isToday && <span className="text-xs font-medium text-[var(--success)]">اليوم</span>}
            </div>
            <Button data-readonly-safe type="button" variant="ghost" size="sm" className="min-h-11 min-w-11 md:min-h-9 md:min-w-9" onClick={() => changeDay(1)} disabled={isToday} aria-label="اليوم التالي" title="اليوم التالي"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></Button>
            {!isToday && (
              <Button type="button" variant="link" size="sm" className={`${TOUCH} text-xs`} onClick={() => { setAssignedDate(todayCairo); setStatusFilter('all'); }}>عودة لليوم</Button>
            )}
          </div>
        }
      >
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="إحصاءات اليوم" data-testid="agent-stats">
          <StatCard label="جديدة" value={newCount.toLocaleString("ar-EG")} tone="info" active={statusFilter === 'new'} onClick={() => toggle('new')} loading={isLoading} />
          <StatCard label="مؤكدة" value={confirmedCount.toLocaleString("ar-EG")} tone="success" active={statusFilter === 'confirmed'} onClick={() => toggle('confirmed')} loading={isLoading} />
          <StatCard label="مؤجلة" value={postponedCount.toLocaleString("ar-EG")} tone="warning" active={statusFilter === 'postponed'} onClick={() => toggle('postponed')} loading={isLoading} />
          <StatCard label="ملغية" value={cancelledCount.toLocaleString("ar-EG")} tone="danger" active={statusFilter === 'cancelled'} onClick={() => toggle('cancelled')} loading={isLoading} />
        </section>
      </PageHeader>

      {!online && <OfflineState onRetry={() => refetch()} className="py-6" />}

      {/* Confirm Rate — من أوردرات اليوم المعروضة */}
      <SectionCard testId="agent-rate">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">نسبة التأكيد</span>
          <span className="text-lg font-bold tabular-nums text-primary">{confirmRate}%</span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div className="h-2.5 rounded-full bg-primary transition-all duration-[var(--duration-base,200ms)]" style={{ width: `${confirmRate}%` }} />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {confirmedCount} مؤكد من أصل {total} أوردر في هذا اليوم
        </p>
      </SectionCard>

      {/* Filter */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="فلتر الحالة" data-testid="agent-filters">
        {[
          { value: "all", label: "الكل" },
          { value: "new", label: "جديد" },
          { value: "postponed", label: "مؤجل" },
          { value: "confirmed", label: "مؤكد" },
          { value: "cancelled", label: "ملغي" },
        ].map(f => (
          <Button
            key={f.value}
            variant={statusFilter === f.value ? "default" : "outline"}
            size="sm"
            className={`${TOUCH} rounded-[var(--radius-brand-pill)]`}
            aria-pressed={statusFilter === f.value}
            onClick={() => setStatusFilter(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* Orders Cards */}
      {isLoading ? (
        <LoadingSkeleton variant="cards" rows={4} />
      ) : orders.length === 0 ? (
        <EmptyState icon={<Package className="h-6 w-6" aria-hidden="true" />} title="لا توجد أوردرات مُسندة إليك" description="انتظر حتى يقوم المدير بتوزيع الأوردرات" />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2" data-testid="agent-orders">
          {orders.map(order => (
            <li key={order.id} className="rounded-[var(--radius-brand-md)] border border-border bg-card p-4 shadow-[var(--shadow-card)]" data-testid={`agent-order-${order.id}`}>
              {/* Order Header */}
              <div className="mb-3 flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-mono text-xs font-bold text-primary" dir="ltr">{order.orderNumber}</p>
                  <p className="mt-0.5 truncate font-bold text-foreground">{order.customerName}</p>
                </div>
                <StatusBadge status={order.status} size="sm" />
              </div>

              {/* Order Details */}
              <div className="mb-4 space-y-2">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Phone className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span dir="ltr">{order.customerPhone}</span>
                </div>
                <div className="flex items-start gap-2 text-sm">
                  <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="flex flex-col gap-0.5">
                    <span className="font-semibold text-foreground">{order.governorate}</span>
                    <span className="leading-snug text-muted-foreground">{order.customerAddress}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Package className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>{order.productName} × {order.quantity}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold tabular-nums text-foreground">
                    {Number(order.totalAmount).toLocaleString('ar-EG')} ج.م
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {new Date(order.createdAt).toLocaleDateString('ar-EG')}
                  </span>
                </div>
                {order.postponedTo && (
                  <div className="flex items-center gap-2 text-sm text-[var(--warning)]">
                    <Calendar className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span>متابعة: {new Date(order.postponedTo).toLocaleDateString('ar-EG')}</span>
                  </div>
                )}
                {order.notes && (
                  <p className="rounded-[var(--radius-brand-sm,0.375rem)] bg-muted p-2 text-xs text-muted-foreground">{order.notes}</p>
                )}
              </div>

              {/* Edit Button - always visible */}
              <div className="mb-2 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  className={`${TOUCH} border-[var(--info)]/30 text-xs text-[var(--info)] hover:bg-[var(--info)]/10`}
                  onClick={() => {
                    setEditOrderData(order);
                    setSelectedOrderId(order.id);
                    setShowEditDialog(true);
                  }}
                  data-testid={`agent-edit-${order.id}`}
                >
                  <Edit2 className="h-3 w-3 ml-1" aria-hidden="true" />
                  تعديل
                </Button>
              </div>

              {/* Action Buttons */}
              {(order.status === 'new' || order.status === 'postponed') && (
                <div className="flex gap-2">
                  <Button
                    className="min-h-11 flex-1 bg-[var(--success)] text-[var(--success-foreground,#fff)] hover:opacity-90 md:min-h-9"
                    size="sm"
                    onClick={() => handleConfirm(order.id)}
                    disabled={confirmMutation.isPending}
                    data-testid={`agent-confirm-${order.id}`}
                  >
                    <CheckCircle className="h-4 w-4 ml-1" aria-hidden="true" />
                    تأكيد
                  </Button>
                  <Button
                    variant="outline"
                    className="min-h-11 flex-1 border-[var(--warning)]/40 text-[var(--warning)] hover:bg-[var(--warning)]/10 md:min-h-9"
                    size="sm"
                    onClick={() => { setSelectedOrderId(order.id); setShowPostponeDialog(true); }}
                    data-testid={`agent-postpone-${order.id}`}
                  >
                    <Clock className="h-4 w-4 ml-1" aria-hidden="true" />
                    تأجيل
                  </Button>
                  <Button
                    variant="outline"
                    className="min-h-11 flex-1 border-destructive/40 text-destructive hover:bg-destructive/10 md:min-h-9"
                    size="sm"
                    onClick={() => { setSelectedOrderId(order.id); setShowCancelDialog(true); }}
                    data-testid={`agent-cancel-${order.id}`}
                  >
                    <XCircle className="h-4 w-4 ml-1" aria-hidden="true" />
                    إلغاء
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* تعديل الأوردر — نفس محرر البنود المشترك اللي في صفحة الأوردرات */}
      <OrderEditDialog
        open={showEditDialog}
        onOpenChange={open => { setShowEditDialog(open); if (!open) { setSelectedOrderId(null); setEditOrderData(null); } }}
        order={editingOrder}
        items={editItemsData}
        itemsLoading={editItemsLoading}
        itemsError={editItemsError}
        products={(products ?? []) as any}
        variants={(variantsList ?? []) as any}
        configuredGovernorates={GOVERNORATES}
        saving={editSaving}
        onSave={saveOrderEdit}
        showEmployeeNotes={false}
        allowItemsEdit={canEditItems}
      />

      {/* Cancel Dialog */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent className="max-w-md" dir="rtl" data-testid="agent-cancel-dialog">
          <DialogHeader>
            <DialogTitle>إلغاء الأوردر</DialogTitle>
            <DialogDescription>السبب إلزامي ويُسجَّل على الأوردر.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="agent-cancel-reason">سبب الإلغاء <span className="text-destructive">*</span></Label>
              <Select value={cancelReason} onValueChange={setCancelReason}>
                <SelectTrigger id="agent-cancel-reason" className={`mt-1 ${TOUCH}`}>
                  <SelectValue placeholder="اختر السبب" />
                </SelectTrigger>
                <SelectContent>
                  {cancelReasonOptions.map(r => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="agent-cancel-notes">ملاحظات</Label>
              <Textarea
                id="agent-cancel-notes"
                value={cancelNotes}
                onChange={e => setCancelNotes(e.target.value)}
                placeholder="تفاصيل إضافية..."
                className="mt-1"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className={TOUCH} onClick={() => setShowCancelDialog(false)}>رجوع</Button>
            <Button
              variant="destructive"
              className={TOUCH}
              disabled={!cancelReason || cancelMutation.isPending}
              onClick={() => {
                if (!selectedOrderId || !cancelReason) return;
                cancelMutation.mutate({
                  orderId: selectedOrderId,
                  cancelReason: cancelReason as any,
                  notes: cancelNotes || undefined,
                  operationId: operationIdFor(`cancel:${selectedOrderId}`),
                });
              }}
              data-testid="agent-cancel-confirm"
            >
              تأكيد الإلغاء
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Postpone Dialog */}
      <Dialog open={showPostponeDialog} onOpenChange={setShowPostponeDialog}>
        <DialogContent className="max-w-md" dir="rtl" data-testid="agent-postpone-dialog">
          <DialogHeader>
            <DialogTitle>تأجيل الأوردر</DialogTitle>
            <DialogDescription>حدّد تاريخ المتابعة.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="agent-postpone-date">تاريخ المتابعة <span className="text-destructive">*</span></Label>
              <Input
                id="agent-postpone-date"
                type="date"
                value={postponeDate}
                onChange={e => setPostponeDate(e.target.value)}
                className={`mt-1 ${TOUCH}`}
                dir="ltr"
                min={new Date().toISOString().split('T')[0]}
              />
            </div>
            <div>
              <Label htmlFor="agent-postpone-notes">ملاحظات</Label>
              <Textarea
                id="agent-postpone-notes"
                value={postponeNotes}
                onChange={e => setPostponeNotes(e.target.value)}
                placeholder="سبب التأجيل..."
                className="mt-1"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className={TOUCH} onClick={() => setShowPostponeDialog(false)}>رجوع</Button>
            <Button
              className={TOUCH}
              disabled={!postponeDate || postponeMutation.isPending}
              onClick={() => {
                if (!selectedOrderId || !postponeDate) return;
                postponeMutation.mutate({
                  orderId: selectedOrderId,
                  postponedTo: new Date(postponeDate),
                  notes: postponeNotes || undefined,
                  operationId: operationIdFor(`postpone:${selectedOrderId}`),
                });
              }}
              data-testid="agent-postpone-confirm"
            >
              تأكيد التأجيل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
