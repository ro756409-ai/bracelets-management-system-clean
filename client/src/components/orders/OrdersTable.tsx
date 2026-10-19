import { activeBrand } from "@/lib/brandFlag";
import type { ReactNode } from "react";
import { CheckCircle, Clock, Copy, Edit2, Eye, MoreVertical, PhoneCall, PhoneOff, RotateCcw, Trash2, XCircle } from "lucide-react";
import { TrackingChip } from "@/components/orders/TrackingChip";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  AttemptsCell, CustomerCell, ReceiptPrediction, ResponsiveDataTable, StatusBadge, TwoLineCell, WhatsAppButton,
  type Column, type Density, type ResponsiveDataTableProps, UNAVAILABLE_LABEL,
} from "@/components/shared";
import { AR_LOCALE } from "@/lib/format";

/**
 * جدول الأوردرات (المرحلة 4) — **عرض فقط**. الصفحة تملك الاستعلامات والـmutations والنوافذ وتمرّر
 * هنا الصفوف + سياق العرض + callbacks. لا tRPC ولا منطق أعمال ولا أرقام مخترعة:
 *   • توقع الاستلام: لا مصدر حقيقي اليوم → `ReceiptPrediction` بـ`null` = «غير متاح».
 *   • وقت التوصيل المتوقع: لا عمود في الـDB → «غير متاح» (الوصول الفعلي `deliveredAt` يُعرض كسطر ثانٍ فقط إن وُجد).
 *   • المحاولات: الاتصال من `noAnswerCallAttempts` باسم «اتصال»؛ محاولات التوصيل لا تُستنتج منها → «غير متاح».
 *   • رسوم الشحن المتوقعة: `projectedShippingCostSnapshot` فقط؛ غيابها = «غير متاح».
 */
export type OrderRow = Record<string, any> & { id: number };

export type OrdersRowActions = {
  isAdmin: boolean;
  /** أثناء أي تأكيد جارٍ تُعطَّل كل أزرار التأكيد (حماية من الضغط المكرر) */
  confirmPending: boolean;
  duplicatePending: boolean;
  onConfirm: (order: OrderRow) => void;
  onCancel: (order: OrderRow) => void;
  onDetails: (order: OrderRow) => void;
  onPostpone: (order: OrderRow) => void;
  onNoAnswer: (order: OrderRow) => void;
  onCall: (order: OrderRow) => void;
  onEdit: (order: OrderRow) => void;
  onDuplicate: (order: OrderRow) => void;
  onReturn: (order: OrderRow) => void;
  onDelete: (order: OrderRow) => void;
};

export type OrdersColumnsContext = {
  seqByOrderId: Map<number, number>;
  employeeNameById: Map<number, string>;
  businessNameById: Map<number, string>;
  /** اسم المصدر من إعدادات النشاط (operational options) — أو القيمة الخام */
  sourceLabel: (source: string) => string;
  actions: OrdersRowActions;
};

/** ترتيب أعمدة الديسكتوب المعتمد (17 عمودًا ظاهرًا؛ `seq`/`website` إضافيان مخفيان افتراضيًا). */
export const ORDERS_DESKTOP_COLUMN_ORDER = [
  "identifier", "type", "customer", "area", "products", "codAmount", "projectedShipping", "status", "attempts",
  "collection", "expectedDelivery", "receipt", "business", "assignedEmployee", "dates", "actions",
] as const;

export const COLLECTION_STATUS: Record<string, { label: string; tone: "neutral" | "success" | "warning" | "danger" }> = {
  pending: { label: "قيد التحصيل", tone: "neutral" },
  collected: { label: "تم التحصيل", tone: "success" },
  partial: { label: "تحصيل جزئي", tone: "warning" },
  failed: { label: "فشل التحصيل", tone: "danger" },
};

export const money = (v: unknown) => `${Number(v ?? 0).toLocaleString(AR_LOCALE)} ج.م`;
const day = (v: unknown) => new Date(v as string).toLocaleDateString(AR_LOCALE, { day: "numeric", month: "short" });
const time = (v: unknown) => new Date(v as string).toLocaleTimeString(AR_LOCALE, { hour: "2-digit", minute: "2-digit" });
export const paymentLabel = (order: OrderRow): string | null => {
  const p = order.projectedPaymentType || order.paymentMethod;
  if (!p) return null;
  return p === "cod" ? "دفع عند الاستلام" : String(p);
};
export const isActionable = (order: OrderRow) => order.status === "new" || order.status === "postponed";
/**
 * نفس قاعدة السيرفر (DATA-4 / D4): المشحون أو المُسلَّم، أو المؤكد/قيد التجهيز **بشحنة بوسطة** — غير كده الأوردر لسه في
 * المخزن ومساره الإلغاء (السيرفر بيرفض المرتجع)، فالخيار مايتعرضش.
 */
export const canReturn = (order: OrderRow, isAdmin: boolean) =>
  isAdmin && (["shipped", "delivered"].includes(order.status) || (["confirmed", "preparing"].includes(order.status) && Boolean(order.bostaShipmentId)));
/**
 * حالات قائمة الدرج («مؤكد» من زر التأكيد، و«تم التسليم» من بوسطة أو المسار المعتمد — لا من هنا). المشحون مايتلغيش
 * (DATA-4: الإلغاء بيرجّع المخزون والبضاعة مع شركة الشحن) — السيرفر بيرفضه برضه، ده بس عشان مايتعرضش.
 */
export const drawerStatusOptions = (status: string) =>
  ["new", "postponed", "no_answer", "preparing", "shipped", "cancelled"].filter(v => !(v === "cancelled" && status === "shipped"));

const Unavailable = () => <span className="text-xs text-muted-foreground">{UNAVAILABLE_LABEL}</span>;

/** قائمة «المزيد» المشتركة بين صف الجدول وبطاقة الموبايل — نفس الإجراءات ونفس بوابات الصلاحية. */
export function OrderMoreMenu({ order, actions, trigger }: { order: OrderRow; actions: OrdersRowActions; trigger: ReactNode }) {
  const actionable = isActionable(order);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        {actionable && (
          <>
            <DropdownMenuItem className="min-h-11 md:min-h-9" onClick={() => actions.onPostpone(order)}>
              <Clock className="h-4 w-4 ml-2 text-[var(--warning)]" aria-hidden="true" /> جدولة اتصال لاحق
            </DropdownMenuItem>
            <DropdownMenuItem className="min-h-11 md:min-h-9" onClick={() => actions.onNoAnswer(order)}>
              <PhoneOff className="h-4 w-4 ml-2 text-[var(--warning)]" aria-hidden="true" /> لم يرد
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem className="min-h-11 md:min-h-9" onClick={() => actions.onCall(order)}>
          <PhoneCall className="h-4 w-4 ml-2 text-[var(--info)]" aria-hidden="true" /> اتصال بالعميل
        </DropdownMenuItem>
        <DropdownMenuItem className="min-h-11 md:min-h-9" onClick={() => actions.onEdit(order)}>
          <Edit2 className="h-4 w-4 ml-2 text-[var(--info)]" aria-hidden="true" /> تعديل
        </DropdownMenuItem>
        {actions.isAdmin && (
          <DropdownMenuItem className="min-h-11 md:min-h-9" disabled={actions.duplicatePending} onClick={() => actions.onDuplicate(order)} data-testid="order-action-duplicate">
            <Copy className="h-4 w-4 ml-2 text-muted-foreground" aria-hidden="true" /> تكرار الأوردر
          </DropdownMenuItem>
        )}
        {canReturn(order, actions.isAdmin) && (
          <DropdownMenuItem className="min-h-11 md:min-h-9" onClick={() => actions.onReturn(order)} data-testid="order-action-return">
            <RotateCcw className="h-4 w-4 ml-2 text-primary" aria-hidden="true" /> مرتجع
          </DropdownMenuItem>
        )}
        {actions.isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="min-h-11 text-destructive focus:text-destructive md:min-h-9" onClick={() => actions.onDelete(order)} data-testid="order-action-delete">
              <Trash2 className="h-4 w-4 ml-2" aria-hidden="true" /> حذف
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function buildOrdersColumns(ctx: OrdersColumnsContext): Column<OrderRow>[] {
  const { actions } = ctx;
  return [
    {
      id: "seq", header: "#", defaultHidden: true,
      cell: order => <span className="text-xs font-semibold text-muted-foreground tabular-nums">{ctx.seqByOrderId.get(order.id)}</span>,
      className: "text-center w-12",
    },
    {
      // 2. رقم الأوردر والمصدر — المعرّف الخارجي أبرز، الداخلي سياق، والمصدر شارة محايدة
      id: "identifier", header: "رقم الأوردر", alwaysVisible: true, sticky: "start",
      cell: order => (
        <div className="min-w-0 leading-tight">
          {order.easyOrderShortId ? (
            <>
              <p className="font-en text-sm font-bold tabular-nums" dir="ltr">#{order.easyOrderShortId}</p>
              <p className="font-en type-caption tabular-nums" dir="ltr">{order.orderNumber}</p>
            </>
          ) : (
            <p className="font-en text-sm font-bold tabular-nums" dir="ltr">#{order.orderNumber}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {order.source && <StatusBadge status={order.source} kind="source" size="sm" label={ctx.sourceLabel(order.source)} />}
            <TrackingChip shipmentId={order.bostaShipmentId} trackingNumber={order.bostaTrackingNumber} />
            {order.bostaLastError && !order.bostaShipmentId && (
              <span className="inline-flex items-center rounded-[var(--radius-brand-pill)] border border-destructive/20 bg-destructive/10 px-1.5 py-0.5 text-[10px] font-bold text-destructive">فشل بوسطة</span>
            )}
          </div>
        </div>
      ),
    },
    {
      // 3. النوع — نوع الشحن المتوقع (projectedShippingType) + طريقة الدفع؛ لا قيمة = «غير متاح»
      id: "type", header: "النوع", alwaysVisible: true,
      cell: order => {
        const pay = paymentLabel(order);
        return order.projectedShippingType || pay
          ? <TwoLineCell primary={order.projectedShippingType || pay} secondary={order.projectedShippingType ? pay : undefined} />
          : <Unavailable />;
      },
    },
    {
      // 4. العميل
      id: "customer", header: "العميل", alwaysVisible: true,
      cell: order => <CustomerCell name={order.customerName} phone={order.customerPhone} secondaryPhone={order.customerPhone2} className="max-w-[220px]" />,
    },
    {
      // 5. المنطقة — المحافظة بارزة والمدينة/العنوان تحتها
      id: "area", header: "المنطقة", alwaysVisible: true,
      cell: order => <TwoLineCell primary={order.governorate || "—"} secondary={order.city || order.customerAddress || undefined} className="max-w-[150px] brand-v2:max-w-[128px]" />,
    },
    {
      // 6. المنتجات/الأنواع — الاسم × الكمية، وسطر التخصيص (لون/مقاس) إن وُجد
      id: "products", header: "المنتجات / الأنواع", alwaysVisible: true,
      cell: order => (
        <TwoLineCell
          primary={`${order.productName ?? "—"}${order.quantity > 1 ? ` × ${order.quantity}` : ""}`}
          secondary={[order.color && `اللون: ${order.color}`, order.size && `المقاس: ${order.size}`].filter(Boolean).join(" · ") || undefined}
          className="max-w-[220px]"
        />
      ),
    },
    {
      // 7. مبلغ التحصيل
      // v2: «مثبّت» — بيفضل ظاهر كامل في كل مواضع التمرير الأفقي (لازق جنب رقم الأوردر أو الإجراءات). v1 زي ما هو.
      id: "codAmount", header: "مبلغ التحصيل", numeric: true, alwaysVisible: true, sticky: activeBrand() === "v2" ? "pinned" : undefined,
      cell: order => <span className="font-en text-sm font-bold tabular-nums brand-v2:whitespace-nowrap">{money(order.totalAmount)}</span>,
    },
    {
      // 8. رسوم الشحن المتوقعة — projectedShippingCostSnapshot فقط
      id: "projectedShipping", header: "رسوم الشحن المتوقعة", numeric: true, alwaysVisible: true,
      cell: order => order.projectedShippingCostSnapshot != null
        ? <span className="font-en text-sm tabular-nums brand-v2:whitespace-nowrap">{money(order.projectedShippingCostSnapshot)}</span>
        : <Unavailable />,
    },
    {
      // 9. الحالة
      id: "status", header: "الحالة", alwaysVisible: true,
      cell: order => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={order.status} kind="order" size="sm" />
          {order.needsReview && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-[var(--purple)] bg-[var(--purple)]/10 border border-[var(--purple)]/30">يحتاج مراجعة</span>
          )}
        </div>
      ),
    },
    {
      // 10. المحاولات — اتصال فقط من مصدر حقيقي؛ التوصيل «غير متاح»
      id: "attempts", header: "المحاولات", alwaysVisible: true,
      cell: order => <AttemptsCell callAttempts={order.noAnswerCallAttempts ?? null} deliveryAttempts={null} />,
    },
    {
      // 11. حالة التحصيل
      id: "collection", header: "حالة التحصيل", alwaysVisible: true,
      cell: order => {
        const def = COLLECTION_STATUS[order.collectionStatus];
        if (!def) return <Unavailable />;
        return (
          <div className="flex flex-col items-start gap-0.5">
            <StatusBadge status={order.collectionStatus} label={def.label} tone={def.tone} size="sm" />
            {order.collectedAmount != null && order.collectionStatus !== "pending" && (
              <span className="font-en text-[11px] text-muted-foreground tabular-nums brand-v2:whitespace-nowrap">{money(order.collectedAmount)}</span>
            )}
          </div>
        );
      },
    },
    {
      // 12. وقت التوصيل المتوقع — لا مصدر → «غير متاح»؛ الوصول الفعلي سطر ثانٍ إن وُجد
      id: "expectedDelivery", header: "وقت التوصيل المتوقع", alwaysVisible: true,
      cell: order => <TwoLineCell primary={<span className="text-xs font-normal text-muted-foreground">{UNAVAILABLE_LABEL}</span>} secondary={order.deliveredAt ? `وصل: ${day(order.deliveredAt)}` : undefined} />,
    },
    {
      // 13. توقع الاستلام — لا مصدر توقع حقيقي في النظام → «غير متاح»
      id: "receipt", header: "توقع الاستلام", alwaysVisible: true,
      cell: () => <ReceiptPrediction probability={null} compact />,
    },
    {
      // 14. النشاط
      id: "business", header: "النشاط", alwaysVisible: true,
      cell: order => {
        const name = order.businessId != null ? ctx.businessNameById.get(order.businessId) : undefined;
        return name ? <span className="text-sm font-medium">{name}</span> : <span className="type-caption">{order.businessId != null ? `#${order.businessId}` : "—"}</span>;
      },
    },
    {
      id: "website", header: "الموقع", defaultHidden: true,
      cell: order => order.websiteName ? <span className="inline-block rounded bg-accent px-2 py-1 text-xs font-medium text-accent-foreground">{order.websiteName}</span> : <span className="text-muted-foreground">—</span>,
    },
    {
      // 15. المسؤول
      id: "assignedEmployee", header: "المسؤول", alwaysVisible: true,
      cell: order => {
        const name = order.assignedEmployeeId ? ctx.employeeNameById.get(order.assignedEmployeeId) : undefined;
        return name ? <span className="text-sm font-medium">{name}</span> : <span className="type-caption">غير موزع</span>;
      },
    },
    {
      // 16. تاريخ الإنشاء وآخر تحديث
      id: "dates", header: "الإنشاء / آخر تحديث", alwaysVisible: true,
      cell: order => (
        <TwoLineCell
          primary={<span className="font-en text-sm font-normal tabular-nums">{day(order.createdAt)} · {time(order.createdAt)}</span>}
          secondary={order.updatedAt ? <span className="font-en tabular-nums">آخر تحديث: {day(order.updatedAt)} · {time(order.updatedAt)}</span> : undefined}
          className="whitespace-nowrap"
        />
      ),
    },
    {
      // 17. الإجراءات — ثابت على الحافة الختامية
      id: "actions", header: "", alwaysVisible: true, sticky: "end",
      cell: order => {
        const actionable = isActionable(order);
        return (
          <div className="flex items-center gap-0.5" onClick={e => e.stopPropagation()}>
            {actionable && (
              <>
                <Button size="icon" variant="ghost" className="h-9 w-9 text-[var(--success)] hover:bg-[var(--success)]/12 hover:text-[var(--success)]"
                  disabled={actions.confirmPending} aria-busy={actions.confirmPending || undefined}
                  onClick={() => actions.onConfirm(order)} title="تأكيد الأوردر" aria-label="تأكيد الأوردر" data-testid={`order-confirm-${order.id}`}>
                  <CheckCircle className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button size="icon" variant="ghost" className="h-9 w-9 text-destructive hover:bg-destructive/12 hover:text-destructive"
                  onClick={() => actions.onCancel(order)} title="إلغاء الأوردر" aria-label="إلغاء الأوردر">
                  <XCircle className="h-4 w-4" aria-hidden="true" />
                </Button>
              </>
            )}
            <WhatsAppButton phone={order.customerPhone} iconOnly size="icon-sm" className="h-9 w-9" />
            <Button data-readonly-safe size="icon" variant="ghost" className="h-9 w-9 text-[var(--info)] hover:bg-[var(--info)]/12 hover:text-[var(--info)]"
              onClick={() => actions.onDetails(order)} title="عرض تفاصيل الأوردر" aria-label="عرض تفاصيل الأوردر">
              <Eye className="h-4 w-4" aria-hidden="true" />
            </Button>
            <OrderMoreMenu order={order} actions={actions} trigger={
              <Button size="icon" variant="ghost" className="h-9 w-9 text-muted-foreground hover:bg-muted hover:text-foreground" title="إجراءات أخرى" aria-label="إجراءات أخرى لهذا الأوردر">
                <MoreVertical className="h-4 w-4" aria-hidden="true" />
              </Button>
            } />
          </div>
        );
      },
    },
  ];
}

export type OrdersTableProps = {
  rows: OrderRow[];
  columns: Column<OrderRow>[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  density?: Density;
  hiddenColumns?: Set<string>;
  onHiddenColumnsChange?: (next: Set<string>) => void;
  selectedKeys?: Set<string | number>;
  onSelectionChange?: (keys: Set<string | number>) => void;
  bulkActions?: ResponsiveDataTableProps<OrderRow>["bulkActions"];
  toolbar?: ReactNode;
  onRowClick?: (order: OrderRow) => void;
  /** بطاقة الموبايل لكل صف — تحت 768px تُعرض البطاقات **فقط**، ومن 768px الجدول **فقط** */
  mobileRow: (order: OrderRow) => ReactNode;
  empty?: ResponsiveDataTableProps<OrderRow>["empty"];
};

export function OrdersTable(props: OrdersTableProps) {
  return (
    <ResponsiveDataTable<OrderRow>
      rows={props.rows}
      columns={props.columns}
      rowKey={o => o.id}
      loading={props.loading}
      error={props.error ?? undefined}
      onRetry={props.onRetry}
      density={props.density}
      hiddenColumns={props.hiddenColumns}
      onHiddenColumnsChange={props.onHiddenColumnsChange}
      selectedKeys={props.selectedKeys}
      onSelectionChange={props.onSelectionChange}
      bulkActions={props.bulkActions}
      toolbar={props.toolbar}
      onRowClick={props.onRowClick}
      mobileRow={props.mobileRow}
      // v2: كروت تحت 1024 (التابلت) — عند 768 الجدول بيتحشر في ~480px والعمودين الثابتين واخدين ~380px، فمبلغ التحصيل مايلحقش
      // يتعرض كامل. الكروت فيها المبلغ ورقم التتبع كاملين. v1 زي ما هي (md).
      cardsBelow={activeBrand() === "v2" ? "lg" : "md"}
      empty={props.empty ?? { title: "لا توجد أوردرات", description: "جرّب تعديل الفلاتر أو أضف أوردرًا جديدًا" }}
    />
  );
}
