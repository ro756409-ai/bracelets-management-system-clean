import { useState, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { useRoute, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowRight, Save, Edit2, X, Package, User, MapPin, Phone, FileText, Calendar, Hash, Truck, RefreshCw, CheckCircle, AlertCircle, Printer } from "lucide-react";
import { toast } from "sonner";

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

const STATUS_COLORS: Record<string, string> = {
  new: "bg-accent text-accent-foreground",
  confirmed: "bg-[var(--success)]/10 text-[var(--success)]",
  postponed: "bg-[var(--warning)]/10 text-[var(--warning)]",
  cancelled: "bg-destructive/10 text-destructive",
  preparing: "bg-[var(--info)]/10 text-[var(--info)]",
  shipped: "bg-[var(--info)]/10 text-[var(--info)]",
  delivered: "bg-[var(--success)]/10 text-[var(--success)]",
  no_answer: "bg-[var(--warning)]/10 text-[var(--warning)]",
  returned: "bg-muted text-muted-foreground",
  printed: "bg-[var(--info)]/10 text-[var(--info)]",
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

export default function OrderDetails() {
  const [, params] = useRoute("/order/:id");
  const [, setLocation] = useLocation();
  const { user } = useAuth();

  const isAdmin = user?.role === "admin";

  const orderId = params?.id ? parseInt(params.id) : 0;
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<any>({});

  const { data: order, isLoading, refetch } = trpc.orders.get.useQuery(
    { id: orderId },
    { enabled: orderId > 0 }
  );

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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-muted-foreground">جاري التحميل...</div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
        <p className="text-muted-foreground">الأوردر غير موجود</p>
        <Button variant="outline" onClick={() => setLocation("/orders")}>
          <ArrowRight className="h-4 w-4 ml-1" /> العودة للأوردرات
        </Button>
      </div>
    );
  }

  const handleSave = () => {
    const updates: any = { orderId };
    if (editData.customerName !== order.customerName) updates.customerName = editData.customerName;
    if (editData.customerPhone !== order.customerPhone) updates.customerPhone = editData.customerPhone;
    if (editData.customerAddress !== order.customerAddress) updates.customerAddress = editData.customerAddress;
    if (editData.governorate !== order.governorate) updates.governorate = editData.governorate;
    if (editData.productId !== order.productId) {
      updates.productId = editData.productId;
      updates.productName = editData.productName;
    }
    if (editData.quantity !== order.quantity) updates.quantity = editData.quantity;
    if (Number(editData.totalAmount) !== Number(order.totalAmount)) updates.totalAmount = Number(editData.totalAmount);
    if (editData.notes !== (order.notes || "")) updates.notes = editData.notes;

    if (Object.keys(updates).length <= 1) {
      toast.info("لم يتم تعديل أي بيانات");
      setIsEditing(false);
      return;
    }
    editMutation.mutate(updates);
  };

  const formatDate = (date: any) => {
    if (!date) return "-";
    return new Date(date).toLocaleString("ar-EG", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setLocation("/orders")}>
            <ArrowRight className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">أوردر #{order.orderNumber}</h1>
            <div className="flex items-center gap-2 mt-1">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[order.status]}`}>
                {STATUS_LABELS[order.status]}
              </span>
              <span className="text-sm text-muted-foreground">
                {SOURCE_LABELS[order.source] || order.source}
              </span>
            </div>
          </div>
        </div>
        {isAdmin && !isEditing && (
          <div className="flex gap-2">
            {/* زر Bosta - يظهر فقط للأوردرات المؤكدة */}
            {(order.status === 'confirmed' || order.status === 'printed' || order.status === 'preparing' || order.status === 'shipped') && (
              order.bostaShipmentId ? (
                <>
                  <Button variant="outline" size="sm" className="text-[var(--success)] border-[var(--success)]/40" disabled>
                    <CheckCircle className="h-4 w-4 ml-1" /> مرسل لـ Bosta
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-[var(--info)] border-[var(--info)]/40"
                    onClick={() => window.open(`/api/orders/${order.id}/bosta-awb`, "_blank", "noopener,noreferrer")}
                  >
                    <Printer className="h-4 w-4 ml-1" /> طباعة AWB
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className={order.bostaLastError ? "text-destructive border-destructive/40" : "text-[var(--info)] border-[var(--info)]/40"}
                  onClick={() => sendToBostaMutation.mutate({ orderId: order.id })}
                  disabled={sendToBostaMutation.isPending}
                >
                  {sendToBostaMutation.isPending ? (
                    <RefreshCw className="h-4 w-4 ml-1 animate-spin" />
                  ) : (
                    <Truck className="h-4 w-4 ml-1" />
                  )}
                  {order.bostaLastError ? "إعادة إرسال Bosta" : "إرسال لـ Bosta"}
                </Button>
              )
            )}
            <Button onClick={() => setIsEditing(true)} variant="outline">
              <Edit2 className="h-4 w-4 ml-1" /> تعديل
            </Button>
          </div>
        )}
        {isEditing && (
          <div className="flex gap-2">
            <Button onClick={handleSave} disabled={editMutation.isPending}>
              <Save className="h-4 w-4 ml-1" /> حفظ
            </Button>
            <Button variant="outline" onClick={() => { setIsEditing(false); setEditData({ customerName: order.customerName, customerPhone: order.customerPhone, customerAddress: order.customerAddress, governorate: order.governorate, productId: order.productId, productName: order.productName, quantity: order.quantity, totalAmount: Number(order.totalAmount), notes: order.notes || "" }); }}>
              <X className="h-4 w-4 ml-1" /> إلغاء
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* مراحل الأوردر — خط زمني هادي مبني من تواريخ المراحل المسجلة فعليًا على الأوردر */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Truck className="h-5 w-5 text-primary" /> مراحل الأوردر
            </CardTitle>
          </CardHeader>
          <CardContent>
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
                      <li key={s.label} className="relative flex gap-3 pb-5 last:pb-0">
                        {i < stages.length - 1 && (
                          <span className={`absolute right-[9px] top-6 bottom-0 w-0.5 ${stages[i + 1].date ? "bg-[var(--success)]" : "bg-border"}`} />
                        )}
                        <span className={`relative z-[1] mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                          done ? "border-[var(--success)] bg-[var(--success)]" : "border-border bg-card"
                        }`}>
                          {done && <CheckCircle className="h-3.5 w-3.5 text-white" />}
                        </span>
                        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                          <p className={`text-sm ${done ? "font-semibold" : "text-muted-foreground"} ${isCurrent ? "text-[var(--success)]" : ""}`}>{s.label}</p>
                          {s.date && <p className="text-xs text-muted-foreground tabular-nums">{formatDate(s.date)}</p>}
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
              <div className={`mt-4 rounded-lg border p-3 text-sm ${
                order.status === "cancelled" || order.status === "returned"
                  ? "border-destructive/30 bg-destructive/5 text-destructive"
                  : "border-[var(--warning)]/30 bg-[var(--warning)]/5 text-[var(--warning)]"
              }`}>
                <p className="font-semibold">{STATUS_LABELS[order.status]}</p>
                {order.status === "cancelled" && order.cancelReason && <p className="mt-0.5 text-xs">السبب: {order.cancelReason}</p>}
                {order.status === "cancelled" && order.cancelledAt && <p className="mt-0.5 text-xs">{formatDate(order.cancelledAt)}</p>}
                {order.status === "postponed" && order.postponedTo && <p className="mt-0.5 text-xs">مؤجل إلى: {formatDate(order.postponedTo)}</p>}
                {order.status === "no_answer" && (order as any).noAnswerCallAttempts != null && (
                  <p className="mt-0.5 text-xs">عدد محاولات الاتصال: {(order as any).noAnswerCallAttempts}</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* بيانات العميل */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <User className="h-5 w-5 text-[var(--warning)]" /> بيانات العميل
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-muted-foreground text-xs">اسم العميل</Label>
              {isEditing ? (
                <Input value={editData.customerName} onChange={e => setEditData({ ...editData, customerName: e.target.value })} />
              ) : (
                <p className="font-medium">{order.customerName}</p>
              )}
            </div>
            <div>
              <Label className="text-muted-foreground text-xs flex items-center gap-1"><Phone className="h-3 w-3" /> رقم الهاتف</Label>
              {isEditing ? (
                <Input value={editData.customerPhone} onChange={e => setEditData({ ...editData, customerPhone: e.target.value })} dir="ltr" />
              ) : (
                <p className="font-medium" dir="ltr">{order.customerPhone}</p>
              )}
            </div>
            <div>
              <Label className="text-muted-foreground text-xs flex items-center gap-1"><MapPin className="h-3 w-3" /> المحافظة</Label>
              {isEditing ? (
                <Input value={editData.governorate} onChange={e => setEditData({ ...editData, governorate: e.target.value })} />
              ) : (
                <p className="font-medium">{order.governorate}</p>
              )}
            </div>
            <div>
              <Label className="text-muted-foreground text-xs flex items-center gap-1"><MapPin className="h-3 w-3" /> العنوان</Label>
              {isEditing ? (
                <Textarea value={editData.customerAddress} onChange={e => setEditData({ ...editData, customerAddress: e.target.value })} rows={3} />
              ) : (
                <p className="font-medium">{order.customerAddress}</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* بيانات المنتج */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Package className="h-5 w-5 text-[var(--warning)]" /> بيانات المنتج
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-muted-foreground text-xs">المنتج</Label>
              {isEditing ? (
                <Select
                  value={String(editData.productId)}
                  onValueChange={(val) => {
                    const prod = products?.find((p: any) => p.id === Number(val));
                    setEditData({ ...editData, productId: Number(val), productName: prod?.name || editData.productName });
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {products?.map((p: any) => (
                      <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="font-medium">{order.productName}</p>
              )}
            </div>
            {Array.isArray((order as any).items) && (order as any).items.length > 0 && (
              <div className="rounded-xl border border-[var(--warning)]/30 bg-[var(--warning)]/10/60 p-3">
                <Label className="text-[var(--warning)] text-xs font-semibold">تفصيل الأصناف / الحفر</Label>
                <div className="mt-2 space-y-1">
                  {(order as any).items.map((it: any) => (
                    <div key={it.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 text-foreground">
                        {it.productName}
                        {(it.variantName || it.color || it.size) && (
                          <span className="mr-1.5 text-xs font-semibold text-[var(--info)]">
                            ({it.variantName || [it.color, it.size].filter(Boolean).join(' / ')})
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 font-semibold text-[var(--warning)]">× {it.quantity}</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between border-t border-[var(--warning)]/30 pt-1 mt-1">
                    <span className="text-xs font-semibold text-[var(--warning)]">إجمالي القطع</span>
                    <span className="text-xs font-bold text-[var(--warning)]">{(order as any).items.reduce((s: number, it: any) => s + (it.quantity || 0), 0)} قطعة</span>
                  </div>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label className="text-muted-foreground text-xs">الكمية</Label>
                {isEditing ? (
                  <Input type="number" min={1} value={editData.quantity} onChange={e => setEditData({ ...editData, quantity: parseInt(e.target.value) || 1 })} />
                ) : (
                  <p className="font-medium">{order.quantity}</p>
                )}
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">المبلغ الإجمالي</Label>
                {isEditing ? (
                  <Input type="number" min={0} value={editData.totalAmount} onChange={e => setEditData({ ...editData, totalAmount: parseFloat(e.target.value) || 0 })} />
                ) : (
                  <p className="font-medium text-[var(--success)]">{Number(order.totalAmount)} ج.م</p>
                )}
              </div>
            </div>
            <div>
              <Label className="text-muted-foreground text-xs flex items-center gap-1"><FileText className="h-3 w-3" /> ملاحظات</Label>
              {isEditing ? (
                <Textarea value={editData.notes} onChange={e => setEditData({ ...editData, notes: e.target.value })} rows={3} placeholder="ملاحظات إضافية..." />
              ) : (
                <p className="font-medium text-muted-foreground">{order.notes || "لا توجد ملاحظات"}</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* معلومات النظام */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Calendar className="h-5 w-5 text-[var(--warning)]" /> معلومات النظام
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <Label className="text-muted-foreground text-xs flex items-center gap-1"><Hash className="h-3 w-3" /> رقم الأوردر</Label>
                <p className="font-medium">{order.orderNumber}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">المصدر</Label>
                <p className="font-medium">{SOURCE_LABELS[order.source] || order.source}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">اسم الإعلان</Label>
                <p className="font-medium">{order.adName || "-"}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">اسم الصفحة</Label>
                <p className="font-medium">{order.pageName || "-"}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">تاريخ الإنشاء</Label>
                <p className="font-medium text-sm">{formatDate(order.createdAt)}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">تاريخ التأكيد</Label>
                <p className="font-medium text-sm">{formatDate(order.confirmedAt)}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">تاريخ الطباعة</Label>
                <p className="font-medium text-sm">{formatDate(order.printedAt)}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">تاريخ التوزيع</Label>
                <p className="font-medium text-sm">{formatDate(order.assignedAt)}</p>
              </div>
              {order.postponedTo && (
                <div>
                  <Label className="text-muted-foreground text-xs">مؤجل إلى</Label>
                  <p className="font-medium text-sm">{formatDate(order.postponedTo)}</p>
                </div>
              )}
              {order.cancelReason && (
                <div>
                  <Label className="text-muted-foreground text-xs">سبب الإلغاء</Label>
                  <p className="font-medium text-sm text-destructive">{order.cancelReason}</p>
                </div>
              )}
              {/* Bosta fields */}
              {order.bostaShipmentId && (
                <div>
                  <Label className="text-muted-foreground text-xs flex items-center gap-1"><CheckCircle className="h-3 w-3 text-[var(--success)]" /> Bosta Shipment ID</Label>
                  <p className="font-medium text-sm text-[var(--success)]">{order.bostaShipmentId}</p>
                </div>
              )}
              {order.bostaTrackingNumber && (
                <div>
                  <Label className="text-muted-foreground text-xs flex items-center gap-1"><Truck className="h-3 w-3" /> رقم التتبع</Label>
                  <p className="font-medium text-sm">{order.bostaTrackingNumber}</p>
                </div>
              )}
              {order.bostaSentAt && (
                <div>
                  <Label className="text-muted-foreground text-xs">تاريخ الإرسال لـ Bosta</Label>
                  <p className="font-medium text-sm">{formatDate(order.bostaSentAt)}</p>
                </div>
              )}
              {order.bostaLastError && !order.bostaShipmentId && (
                <div className="col-span-2">
                  <Label className="text-muted-foreground text-xs flex items-center gap-1"><AlertCircle className="h-3 w-3 text-destructive" /> خطأ Bosta</Label>
                  <p className="text-sm text-destructive">{order.bostaLastError}</p>
                </div>
              )}
              <div>
                <Label className="text-muted-foreground text-xs">مكرر</Label>
                <p className="font-medium text-sm">{order.isDuplicate ? "نعم" : "لا"}</p>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs">الموظف المسؤول</Label>
                <p className="font-medium text-sm">{assignedEmployeeName ?? "غير موزع"}</p>
              </div>
              {order.confirmedByEmployeeName && (
                <div>
                  <Label className="text-muted-foreground text-xs">أكّده</Label>
                  <p className="font-medium text-sm">{order.confirmedByEmployeeName}</p>
                </div>
              )}
              {(order as any).noAnswerCallAttempts != null && (
                <div>
                  <Label className="text-muted-foreground text-xs">محاولات الاتصال (لم يرد)</Label>
                  <p className="font-medium text-sm tabular-nums">{(order as any).noAnswerCallAttempts}</p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
