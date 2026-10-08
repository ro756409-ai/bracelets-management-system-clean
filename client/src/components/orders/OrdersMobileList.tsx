import { CheckCircle, Eye, MoreVertical, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AttemptsCell, MobileOrderCard, ReceiptPrediction, StatusBadge, TwoLineCell, UNAVAILABLE_LABEL, WhatsAppButton } from "@/components/shared";
import { COLLECTION_STATUS, OrderMoreMenu, isActionable, money, paymentLabel, type OrderRow, type OrdersColumnsContext } from "./OrdersTable";

/**
 * بطاقة الأوردر على الموبايل (المرحلة 4) — **عرض فقط**، تُمرَّر لـ`OrdersTable` كـ`mobileRow`.
 * نفس إجراءات صف الجدول بنفس بوابات الصلاحية (تأكيد/إلغاء/واتساب/تفاصيل/المزيد)، أهداف لمس ≥44px،
 * ونفس قواعد البيانات: توقع الاستلام ومحاولات التوصيل «غير متاح»، لا أرقام مخترعة.
 */
export type OrdersMobileCardProps = {
  order: OrderRow;
  ctx: OrdersColumnsContext;
  expanded: boolean;
  onToggle: () => void;
};

export function OrdersMobileCard({ order, ctx, expanded, onToggle }: OrdersMobileCardProps) {
  const { actions } = ctx;
  const actionable = isActionable(order);
  const collection = COLLECTION_STATUS[order.collectionStatus];
  const businessName = order.businessId != null ? ctx.businessNameById.get(order.businessId) : undefined;
  const employeeName = order.assignedEmployeeId ? (ctx.employeeNameById.get(order.assignedEmployeeId) ?? `#${order.assignedEmployeeId}`) : "غير موزع";
  return (
    <MobileOrderCard
      orderNumber={order.easyOrderShortId || order.orderNumber}
      customerName={order.customerName}
      customerPhone={order.customerPhone}
      governorate={order.governorate}
      statusBadge={<StatusBadge status={order.status} kind="order" size="sm" />}
      sourceBadge={order.source ? <StatusBadge status={order.source} kind="source" size="sm" label={ctx.sourceLabel(order.source)} /> : undefined}
      productSummary={[
        `${order.productName ?? "—"}${order.quantity > 1 ? ` × ${order.quantity}` : ""}`,
        [order.color, order.size].filter(Boolean).join(" / "),
      ].filter(Boolean).join(" · ")}
      total={money(order.totalAmount)}
      dateLabel={new Date(order.createdAt).toLocaleDateString("ar-EG", { day: "numeric", month: "short" })}
      expanded={expanded}
      onToggle={onToggle}
      onClick={() => actions.onDetails(order)}
      warnings={order.needsReview ? (
        <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-[var(--purple)] bg-[var(--purple)]/10 border border-[var(--purple)]/30">يحتاج مراجعة</span>
      ) : undefined}
      details={
        <div className="space-y-3" data-testid={`order-card-details-${order.id}`}>
          <p className="text-sm text-muted-foreground">{order.customerAddress || "—"}</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <TwoLineCell primary={<span className="text-xs font-normal text-muted-foreground">النشاط</span>} secondary={<span className="text-sm font-medium text-foreground">{businessName ?? (order.businessId != null ? `#${order.businessId}` : "—")}</span>} />
            <TwoLineCell primary={<span className="text-xs font-normal text-muted-foreground">المسؤول</span>} secondary={<span className="text-sm font-medium text-foreground">{employeeName}</span>} />
            <TwoLineCell primary={<span className="text-xs font-normal text-muted-foreground">النوع</span>} secondary={<span className="text-sm font-medium text-foreground">{order.projectedShippingType || paymentLabel(order) || UNAVAILABLE_LABEL}</span>} />
            <TwoLineCell primary={<span className="text-xs font-normal text-muted-foreground">رسوم الشحن المتوقعة</span>} secondary={<span className="font-en text-sm font-medium text-foreground tabular-nums">{order.projectedShippingCostSnapshot != null ? money(order.projectedShippingCostSnapshot) : UNAVAILABLE_LABEL}</span>} />
            <TwoLineCell primary={<span className="text-xs font-normal text-muted-foreground">حالة التحصيل</span>} secondary={collection ? <StatusBadge status={order.collectionStatus} label={collection.label} tone={collection.tone} size="sm" /> : <span className="text-sm text-muted-foreground">{UNAVAILABLE_LABEL}</span>} />
            <TwoLineCell primary={<span className="text-xs font-normal text-muted-foreground">وقت التوصيل المتوقع</span>} secondary={<span className="text-sm text-muted-foreground">{UNAVAILABLE_LABEL}</span>} />
            <AttemptsCell callAttempts={order.noAnswerCallAttempts ?? null} deliveryAttempts={null} />
            <TwoLineCell primary={<span className="text-xs font-normal text-muted-foreground">توقع الاستلام</span>} secondary={<ReceiptPrediction probability={null} />} />
          </div>
          <div className="flex flex-wrap gap-1.5" onClick={e => e.stopPropagation()}>
            {actionable && (
              <>
                <Button size="sm" className="min-h-11 gap-1 bg-[var(--success)] text-[var(--success-foreground)]"
                  disabled={actions.confirmPending} aria-busy={actions.confirmPending || undefined}
                  onClick={() => actions.onConfirm(order)} data-testid={`order-card-confirm-${order.id}`}>
                  <CheckCircle className="h-4 w-4" aria-hidden="true" /> {actions.confirmPending ? "جارٍ التأكيد…" : "تأكيد"}
                </Button>
                <Button size="sm" variant="outline" className="min-h-11 gap-1 border-destructive/30 text-destructive" onClick={() => actions.onCancel(order)}>
                  <XCircle className="h-4 w-4" aria-hidden="true" /> إلغاء
                </Button>
              </>
            )}
            <WhatsAppButton phone={order.customerPhone} size="sm" className="min-h-11" />
            <Button size="sm" variant="outline" className="min-h-11 gap-1 border-[var(--info)]/30 text-[var(--info)]" onClick={() => actions.onDetails(order)}>
              <Eye className="h-4 w-4" aria-hidden="true" /> تفاصيل
            </Button>
            <OrderMoreMenu order={order} actions={actions} trigger={
              <Button size="sm" variant="outline" className="min-h-11 gap-1 text-muted-foreground" aria-label="إجراءات أخرى لهذا الأوردر">
                <MoreVertical className="h-4 w-4" aria-hidden="true" /> المزيد
              </Button>
            } />
          </div>
        </div>
      }
    />
  );
}

/** مُولّد `mobileRow` لـ`OrdersTable` — الصفحة تمرّر الحالة (المفتوح) وتبقى مالكة لها. */
export function renderOrdersMobileRow(ctx: OrdersColumnsContext, expandedId: number | null, onToggle: (id: number) => void) {
  return (order: OrderRow) => <OrdersMobileCard order={order} ctx={ctx} expanded={expandedId === order.id} onToggle={() => onToggle(order.id)} />;
}
