import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useOperationalOptions } from "@/hooks/useOperationalOptions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  OrderEditDialog,
  type OrderEditSavePayload,
} from "@/components/orders/OrderEditDialog";
import { useGovernorateOptions } from "@/hooks/useGovernorateOptions";
import { toast } from "sonner";
import { CheckCircle, XCircle, Clock, Phone, MapPin, Package, Calendar, User, Edit2 } from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  new: "جديد", confirmed: "مؤكد", postponed: "مؤجل",
  cancelled: "ملغي", preparing: "قيد التحضير", shipped: "تم الشحن", delivered: "تم التوصيل",
};

const STATUS_COLORS: Record<string, string> = {
  new: "bg-accent text-accent-foreground border-primary/30",
  confirmed: "bg-[var(--success)]/10 text-[var(--success)] border-[var(--success)]/30",
  postponed: "bg-[var(--warning)]/10 text-[var(--warning)] border-[var(--warning)]/30",
  cancelled: "bg-destructive/10 text-destructive border-destructive/30",
  preparing: "bg-[var(--info)]/10 text-[var(--info)] border-[var(--info)]/30",
  shipped: "bg-[var(--info)]/10 text-[var(--info)] border-[var(--info)]/30",
  delivered: "bg-[var(--success)]/10 text-[var(--success)] border-[var(--success)]/30",
};

export default function AgentWorkspace() {
  const cancelReasonOptions = useOperationalOptions("cancellation_reason").options;
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showPostponeDialog, setShowPostponeDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelNotes, setCancelNotes] = useState("");
  const [postponeDate, setPostponeDate] = useState("");
  const [postponeNotes, setPostponeNotes] = useState("");
  const { values: GOVERNORATES } = useGovernorateOptions();

  // تاريخ التوزيع - افتراضياً اليوم
  const todayCairo = useMemo(() => {
    const now = new Date();
    const cairoOffset = 2 * 60 * 60 * 1000;
    const cairoNow = new Date(now.getTime() + cairoOffset);
    return cairoNow.toISOString().slice(0, 10); // YYYY-MM-DD
  }, []);
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
    onSuccess: () => { toast.success("✅ تم تأكيد الأوردر"); utils.orders.myOrders.invalidate(); },
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
  const editingOrder = orders.find(o => o.id === selectedOrderId) ?? null;

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
    toast.success("✅ تم تعديل الأوردر بنجاح");
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">مساحة العمل</h1>
          <p className="text-muted-foreground text-sm mt-1">
            أوردراتك المُسندة إليك - {user?.name}
          </p>
        </div>
        <div className="flex items-center gap-2 bg-muted/50 rounded-xl px-3 py-2">
          <button
            onClick={() => changeDay(-1)}
            className="p-1 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
            title="اليوم السابق"
          >‹</button>
          <div className="text-center min-w-[140px]">
            <p className="text-xs font-semibold text-foreground">{displayDate}</p>
            {isToday && <span className="text-xs text-[var(--success)] font-medium">• اليوم</span>}
          </div>
          <button
            onClick={() => changeDay(1)}
            disabled={isToday}
            className="p-1 rounded-lg hover:bg-muted transition-colors text-muted-foreground hover:text-foreground disabled:opacity-30"
            title="اليوم التالي"
          >›</button>
          {!isToday && (
            <button
              onClick={() => { setAssignedDate(todayCairo); setStatusFilter('all'); }}
              className="text-xs text-primary hover:underline mr-1"
            >عودة لليوم</button>
          )}
        </div>
      </div>

      {/* Agent Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div
          className={`rounded-xl p-4 cursor-pointer transition-all border-2 ${statusFilter === 'new' ? 'border-[var(--info)]/50 bg-[var(--info)]/10' : 'border-transparent bg-[var(--info)]/10/50 hover:bg-[var(--info)]/10'}`}
          onClick={() => setStatusFilter(statusFilter === 'new' ? 'all' : 'new')}
        >
          <p className="text-2xl font-bold text-[var(--info)]">{newCount}</p>
          <p className="text-xs font-medium text-[var(--info)] mt-1">جديدة</p>
        </div>
        <div
          className={`rounded-xl p-4 cursor-pointer transition-all border-2 ${statusFilter === 'confirmed' ? 'border-[var(--success)]/50 bg-[var(--success)]/10' : 'border-transparent bg-[var(--success)]/10/50 hover:bg-[var(--success)]/10'}`}
          onClick={() => setStatusFilter(statusFilter === 'confirmed' ? 'all' : 'confirmed')}
        >
          <p className="text-2xl font-bold text-[var(--success)]">{confirmedCount}</p>
          <p className="text-xs font-medium text-[var(--success)] mt-1">مؤكدة</p>
        </div>
        <div
          className={`rounded-xl p-4 cursor-pointer transition-all border-2 ${statusFilter === 'postponed' ? 'border-[var(--warning)]/50 bg-[var(--warning)]/10' : 'border-transparent bg-[var(--warning)]/10/50 hover:bg-[var(--warning)]/10'}`}
          onClick={() => setStatusFilter(statusFilter === 'postponed' ? 'all' : 'postponed')}
        >
          <p className="text-2xl font-bold text-[var(--warning)]">{postponedCount}</p>
          <p className="text-xs font-medium text-[var(--warning)] mt-1">مؤجلة</p>
        </div>
        <div
          className={`rounded-xl p-4 cursor-pointer transition-all border-2 ${statusFilter === 'cancelled' ? 'border-destructive/50 bg-destructive/10' : 'border-transparent bg-destructive/10/50 hover:bg-destructive/10'}`}
          onClick={() => setStatusFilter(statusFilter === 'cancelled' ? 'all' : 'cancelled')}
        >
          <p className="text-2xl font-bold text-destructive">{cancelledCount}</p>
          <p className="text-xs font-medium text-destructive mt-1">ملغية</p>
        </div>
      </div>

      {/* Confirm Rate */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-foreground">نسبة التأكيد</span>
            <span className="text-lg font-bold text-primary">{confirmRate}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-2.5">
            <div
              className="h-2.5 rounded-full bg-primary transition-all"
              style={{ width: `${confirmRate}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            {confirmedCount} مؤكد من أصل {total} أوردر
          </p>
        </CardContent>
      </Card>

      {/* Filter */}
      <div className="flex gap-2 flex-wrap">
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
            onClick={() => setStatusFilter(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {/* Orders Cards */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-48 bg-muted animate-pulse rounded-xl" />
          ))}
        </div>
      ) : orders.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground font-medium">لا توجد أوردرات مُسندة إليك</p>
            <p className="text-sm text-muted-foreground mt-1">انتظر حتى يقوم المدير بتوزيع الأوردرات</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {orders.map(order => (
            <Card key={order.id} className="transition-all hover:shadow-md">
              <CardContent className="p-4">
                {/* Order Header */}
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <p className="font-mono text-xs text-primary font-bold">{order.orderNumber}</p>
                    <p className="font-bold text-foreground mt-0.5">{order.customerName}</p>
                  </div>
                  <Badge className={`${STATUS_COLORS[order.status]} border text-xs`}>
                    {STATUS_LABELS[order.status]}
                  </Badge>
                </div>

                {/* Order Details */}
                <div className="space-y-2 mb-4">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Phone className="h-3.5 w-3.5 shrink-0" />
                    <span dir="ltr">{order.customerPhone}</span>
                  </div>
                  <div className="flex items-start gap-2 text-sm">
                    <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold text-foreground">{order.governorate}</span>
                      <span className="text-muted-foreground leading-snug">{order.customerAddress}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Package className="h-3.5 w-3.5 shrink-0" />
                    <span>{order.productName} × {order.quantity}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-bold text-foreground">
                      {Number(order.totalAmount).toLocaleString('ar-EG')} ج.م
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(order.createdAt).toLocaleDateString('ar-EG')}
                    </span>
                  </div>
                  {order.postponedTo && (
                    <div className="flex items-center gap-2 text-sm text-[var(--warning)]">
                      <Calendar className="h-3.5 w-3.5 shrink-0" />
                      <span>متابعة: {new Date(order.postponedTo).toLocaleDateString('ar-EG')}</span>
                    </div>
                  )}
                  {order.notes && (
                    <p className="text-xs text-muted-foreground bg-muted rounded p-2">{order.notes}</p>
                  )}
                </div>

                {/* Edit Button - always visible */}
                <div className="flex justify-end mb-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs border-[var(--info)]/30 text-[var(--info)] hover:bg-[var(--info)]/10"
                    onClick={() => {
                      setSelectedOrderId(order.id);
                      setShowEditDialog(true);
                    }}
                  >
                    <Edit2 className="h-3 w-3 ml-1" />
                    تعديل
                  </Button>
                </div>

                {/* Action Buttons */}
                {(order.status === 'new' || order.status === 'postponed') && (
                  <div className="flex gap-2">
                    <Button
                      className="flex-1 bg-[var(--success)] hover:bg-[var(--success)] text-white h-9"
                      size="sm"
                      onClick={() => confirmMutation.mutate({ orderId: order.id })}
                      disabled={confirmMutation.isPending}
                    >
                      <CheckCircle className="h-4 w-4 ml-1" />
                      تأكيد
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1 border-[var(--warning)]/40 text-[var(--warning)] hover:bg-[var(--warning)]/10 h-9"
                      size="sm"
                      onClick={() => { setSelectedOrderId(order.id); setShowPostponeDialog(true); }}
                    >
                      <Clock className="h-4 w-4 ml-1" />
                      تأجيل
                    </Button>
                    <Button
                      variant="outline"
                      className="flex-1 border-destructive/40 text-destructive hover:bg-destructive/10 h-9"
                      size="sm"
                      onClick={() => { setSelectedOrderId(order.id); setShowCancelDialog(true); }}
                    >
                      <XCircle className="h-4 w-4 ml-1" />
                      إلغاء
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* تعديل الأوردر — نفس محرر البنود المشترك اللي في صفحة الأوردرات */}
      <OrderEditDialog
        open={showEditDialog}
        onOpenChange={open => { setShowEditDialog(open); if (!open) setSelectedOrderId(null); }}
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
        allowItemsEdit={user?.role === "admin"}
      />

      {/* Cancel Dialog */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>إلغاء الأوردر</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>سبب الإلغاء <span className="text-destructive">*</span></Label>
              <Select value={cancelReason} onValueChange={setCancelReason}>
                <SelectTrigger className="mt-1">
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
              <Label>ملاحظات</Label>
              <Textarea
                value={cancelNotes}
                onChange={e => setCancelNotes(e.target.value)}
                placeholder="تفاصيل إضافية..."
                className="mt-1"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancelDialog(false)}>رجوع</Button>
            <Button
              variant="destructive"
              disabled={!cancelReason || cancelMutation.isPending}
              onClick={() => {
                if (!selectedOrderId || !cancelReason) return;
                cancelMutation.mutate({
                  orderId: selectedOrderId,
                  cancelReason: cancelReason as any,
                  notes: cancelNotes || undefined,
                });
              }}
            >
              تأكيد الإلغاء
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Postpone Dialog */}
      <Dialog open={showPostponeDialog} onOpenChange={setShowPostponeDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>تأجيل الأوردر</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>تاريخ المتابعة <span className="text-destructive">*</span></Label>
              <Input
                type="date"
                value={postponeDate}
                onChange={e => setPostponeDate(e.target.value)}
                className="mt-1"
                min={new Date().toISOString().split('T')[0]}
              />
            </div>
            <div>
              <Label>ملاحظات</Label>
              <Textarea
                value={postponeNotes}
                onChange={e => setPostponeNotes(e.target.value)}
                placeholder="سبب التأجيل..."
                className="mt-1"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPostponeDialog(false)}>رجوع</Button>
            <Button
              disabled={!postponeDate || postponeMutation.isPending}
              onClick={() => {
                if (!selectedOrderId || !postponeDate) return;
                postponeMutation.mutate({
                  orderId: selectedOrderId,
                  postponedTo: new Date(postponeDate),
                  notes: postponeNotes || undefined,
                });
              }}
            >
              تأكيد التأجيل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
