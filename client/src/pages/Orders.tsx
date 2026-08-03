import { useState, useMemo, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import {
  OrderEditDialog, type OrderEditSavePayload,
} from "@/components/orders/OrderEditDialog";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus, Search, CheckCircle, XCircle, Clock, UserPlus, Eye, FileSpreadsheet, Download, Truck,
  Trash2, Printer, PhoneCall, PhoneOff, Edit2, RotateCcw, CalendarDays, Copy, PackageCheck, QrCode,
  MoreHorizontal, MoreVertical, ListChecks, LayoutGrid, Rows3,
  Package, FileText, AlertTriangle, ChevronLeft, ChevronRight, SlidersHorizontal,
} from "lucide-react";
import QRCodeLib from "qrcode";
import ImportExcelDialog from "@/components/ImportExcelDialog";
import ImportWhatsAppDialog from "@/components/ImportWhatsAppDialog";
import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { cairoDateKey, cairoDayRange, previousDateKey } from "@/lib/cairoDate";
import {
  PageHeader,
  StatCard,
  StatusBadge,
  FilterBar,
  SearchInput,
  MultiSelect,
  ResponsiveDataTable,
  type Column,
  MobileOrderCard,
  Pagination,
  Drawer,
  ConfirmDialog,
  WhatsAppButton,
  toast,
  buildFilterChips,
  countActiveFilters,
  type FilterDescriptor,
} from "@/components/shared";
import { useOperationalOptions } from "@/hooks/useOperationalOptions";
import { useGovernorateOptions } from "@/hooks/useGovernorateOptions";

// QR Code renderer component
function QRRenderer({ serialNumber, canvasId }: { serialNumber: string; canvasId: string }) {
  useEffect(() => {
    const canvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
    if (canvas && serialNumber) {
      QRCodeLib.toCanvas(canvas, serialNumber, { width: 100, margin: 1 }).catch(console.error);
    }
  }, [serialNumber, canvasId]);
  return null;
}

/** One dialog per destructive action would repeat five identical confirm/cancel dialogs;
 *  this discriminated union drives a single shared ConfirmDialog instead. */
type PendingConfirm =
  | { type: "deleteOrder"; orderId: number; orderNumber: string }
  | { type: "bulkDelete" }
  | { type: "duplicateOrder"; orderId: number; orderNumber: string; customerName: string }
  | { type: "convertNoAnswer" }
  | { type: "convertPostponed" };

const FILTER_DESCRIPTORS: FilterDescriptor<{
  status: string; source: string; website: string; governorates: string[];
  adName: string; hideAssigned: boolean; employee: string; dateRange: DateRange;
}>[] = [
  { key: "status", label: "الحالة", format: (v) => STATUS_LABEL(v) },
  { key: "source", label: "المصدر" },
  { key: "governorates", label: "المحافظة" },
  { key: "adName", label: "البيدج" },
  { key: "hideAssigned", label: "التوزيع", format: () => "غير الموزعة فقط" },
  // اللقطة بتمرّر اسم الموظف مش رقمه، عشان الشريحة تقرأ "الموظف: أحمد" من غير ما ملف
  // الثوابت ده يحتاج يعرف حاجة عن قائمة الموظفين.
  { key: "employee", label: "الموظف" },
  {
    key: "dateRange", label: "التاريخ",
    format: (v: DateRange) => {
      const from = v.from ? v.from.toLocaleDateString("ar-EG") : "";
      const to = v.to ? v.to.toLocaleDateString("ar-EG") : "";
      return from && to ? `${from} – ${to}` : from || to;
    },
  },
];

/**
 * سجل حالات الأوردر.
 *
 * مفيش جدول تاريخ حالات في قاعدة البيانات، لكن جدول `orders` بيحتفظ بـtimestamp منفصل لكل
 * محطة في رحلة الأوردر (assignedAt, confirmedAt, printedAt, …). المحطات دي مجتمعة هي السجل
 * فعليًا — الناقص كان عرضها. فبنقراها زي ما هي ونرتبها زمنيًا: صفر تعديل في الباك إند، وصفر
 * تخمين لتواريخ مش متسجلة.
 *
 * القيد الوحيد: أي انتقال متسجلش ليه عمود (مثلاً رجوع من "مؤجل" لـ"جديد") مش هيبان — عشان
 * كده السجل بيتقال عنه "المحطات المسجّلة" مش "كل التغييرات".
 */
type TimelineEvent = { at: Date; label: string; detail?: string; tone: string };

const TIMELINE_STATUS_TONE: Record<string, string> = {
  new: "var(--muted-foreground)",
  confirmed: "var(--success)",
  postponed: "var(--warning)",
  cancelled: "var(--destructive)",
  no_answer: "var(--warning)",
  delivered: "var(--success)",
};

/**
 * تغييرات الحالة المسجّلة في order_edit_logs (field='status').
 *
 * الطوابع الزمنية في جدول orders بتقول "الأوردر عدّى بالمحطة دي"، لكنها مش بتقول مين.
 * السجل ده بيقول مين وامتى ومن أي حالة — وهو المصدر الوحيد اللي بيمسك رجوع الأوردر
 * لحالة سابقة (مثلاً من "ملغي" لـ"جديد")، لأن الرجوع ده مالوش عمود طابع زمني أصلاً.
 */
function statusLogEvents(editLogs: any[] | undefined): TimelineEvent[] {
  if (!Array.isArray(editLogs)) return [];
  return editLogs
    .filter((log) => log.field === "status")
    .map((log): TimelineEvent | null => {
      const at = new Date(log.createdAt);
      if (Number.isNaN(at.getTime())) return null;
      return {
        at,
        label: `الحالة → ${STATUS_LABEL(log.newValue)}`,
        detail: [log.editedByName, log.oldValue ? `من ${STATUS_LABEL(log.oldValue)}` : null]
          .filter(Boolean).join(" · "),
        tone: TIMELINE_STATUS_TONE[log.newValue] ?? "var(--info)",
      };
    })
    .filter((e): e is TimelineEvent => e !== null);
}

function buildOrderTimeline(order: any, employeeName?: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const push = (raw: any, label: string, tone: string, detail?: string) => {
    if (!raw) return;
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) return;
    events.push({ at, label, detail, tone });
  };

  push(order.createdAt, "تم إنشاء الأوردر", "var(--muted-foreground)", order.source);
  push(order.assignedAt, "تم التوزيع", "var(--info)", employeeName);
  push(order.confirmedAt, "تم التأكيد", "var(--success)", order.confirmedByEmployeeName || undefined);
  push(order.cancelledAt, "تم الإلغاء", "var(--destructive)", order.cancelReason || undefined);
  push(order.printedAt, "تمت الطباعة", "var(--info)");
  push(order.preparedAt, "تم التجهيز", "var(--success)", order.preparedByName || undefined);
  push(order.bostaSentAt, "تم الإرسال لبوسطة", "var(--info)", order.bostaTrackingNumber || undefined);
  push(order.shippedAt, "تم الشحن", "var(--info)");
  push(order.deliveredAt, "تم التوصيل", "var(--success)");

  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

function STATUS_LABEL(status: string): string {
  const labels: Record<string, string> = {
    new: "جديد", confirmed: "مؤكد", printed: "مطبوع", postponed: "مؤجل",
    cancelled: "ملغي", preparing: "قيد التحضير", shipped: "تم الشحن", delivered: "تم التوصيل",
    no_answer: "لم يرد", returned: "مرتجع",
  };
  return labels[status] ?? status;
}

export default function Orders() {
  const { user } = useAuth();
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const isAdmin = user?.role === 'admin';
  const { currentBusinessIds } = useBusinessContext();
  // Same shared source as every other screen. The edit dialog falls back on its own,
  // but the two governorate FILTERS on this page read this list directly and were
  // rendering empty for exactly the same reason.
  const { values: GOVERNORATES } = useGovernorateOptions();
  const sourceOptions = useOperationalOptions("order_source").options;
  const returnReasonOptions = useOperationalOptions("return_reason").options;
  const cancelReasonOptions = useOperationalOptions("cancellation_reason").options;

  const [activeTab, setActiveTab] = useState<'all' | 'today_confirmed'>('all');
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [websiteFilter, setWebsiteFilter] = useState<string>("all");
  const [governorateFilter, setGovernorateFilter] = useState<string[]>([]);
  const [adNameFilter, setAdNameFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => {
    const saved = Number(localStorage.getItem('orders-page-size'));
    return [25, 50, 100].includes(saved) ? saved : 50;
  });
  const handlePageSizeChange = (size: number) => {
    setPageSize(size);
    setPage(1);
    localStorage.setItem('orders-page-size', String(size));
  };
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  // لازم يتزامن مع أعمدة columns تحت اللي معلّمة defaultHidden: true (seq/address/website) —
  // ResponsiveDataTable بيحترم فقط الـids الموجودة فعليًا في هذا الـSet، الخاصية defaultHidden
  // على تعريف العمود نفسه مجرد نية، مش بتُطبَّق لوحدها.
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set(['seq', 'website']));
  const [expandedMobileId, setExpandedMobileId] = useState<number | null>(null);

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [showWhatsAppImportDialog, setShowWhatsAppImportDialog] = useState(false);
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportType, setExportType] = useState<'confirmed' | 'shipping'>('confirmed');
  const [exportFromOrder, setExportFromOrder] = useState('');
  const [exportToOrder, setExportToOrder] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [exportDateFrom, setExportDateFrom] = useState('');
  const [exportDateTo, setExportDateTo] = useState('');
  const [exportGovernorate, setExportGovernorate] = useState('all');
  const [exportStatus, setExportStatus] = useState('confirmed_printed');
  const [exportWebsiteId, setExportWebsiteId] = useState('all');
  const [exportGroupId, setExportGroupId] = useState('current');
  const resetExportFilters = () => {
    setExportFromOrder(''); setExportToOrder('');
    setExportDateFrom(''); setExportDateTo('');
    setExportGovernorate('all'); setExportStatus('confirmed_printed');
    setExportWebsiteId('all'); setExportGroupId('current');
  };
  const [showAssignDialog, setShowAssignDialog] = useState(false);
  const [showCancelDialog, setShowCancelDialog] = useState(false);
  const [showPostponeDialog, setShowPostponeDialog] = useState(false);
  const [showNoAnswerDialog, setShowNoAnswerDialog] = useState(false);
  const [noAnswerCallAttempts, setNoAnswerCallAttempts] = useState("");
  const [selectedOrderId, setSelectedOrderId] = useState<number | null>(null);
  const [selectedOrderIds, setSelectedOrderIds] = useState<number[]>([]);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);

  // Cancel form
  const [cancelReason, setCancelReason] = useState("");
  const [cancelNotes, setCancelNotes] = useState("");

  // Postpone form
  const [postponeDate, setPostponeDate] = useState("");
  const [postponeNotes, setPostponeNotes] = useState("");

  // فلتر مؤكدات اليوم بالموظف
  const [todayConfirmedEmployeeId, setTodayConfirmedEmployeeId] = useState<number | null>(null);
  const [confirmedDateFilter, setConfirmedDateFilter] = useState<'today' | 'yesterday' | 'custom'>('today');
  const [confirmedCustomDate, setConfirmedCustomDate] = useState('');

  // Return order state
  const [showReturnDialog, setShowReturnDialog] = useState(false);
  const [returnOrderId, setReturnOrderId] = useState<number | null>(null);
  const [returnReason, setReturnReason] = useState("");
  const [returnNotes, setReturnNotes] = useState("");
  const [returnRestoreStock, setReturnRestoreStock] = useState(true);

  // Order details state
  const [detailOrderId, setDetailOrderId] = useState<number | null>(null);
  // بيانات كاملة للأوردر المفتوح في الـdrawer — بما فيها بنود الأوردر مع اسم نوع الحفر لكل
  // بند (variantName)، وده مش موجود في صفوف orders.list العادية (تُجلب فقط لحظة فتح التفاصيل).
  const { data: detailOrder } = trpc.orders.get.useQuery(
    { id: detailOrderId as number },
    { enabled: detailOrderId != null }
  );
  // سجل تغييرات الحالة (مين غيّرها وامتى) — بيتجمع مع الطوابع الزمنية في سجل الحالات.
  // بيتجلب لحظة فتح الـdrawer بس، مش مع كل صف في الجدول.
  const { data: drawerEditHistory } = trpc.orders.getEditHistory.useQuery(
    { orderId: detailOrderId as number },
    { enabled: detailOrderId != null }
  );

  // Edit order state — the dialog owns the form; the page owns which order is open.
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editOrderId, setEditOrderId] = useState<number | null>(null);

  const [hideAssigned, setHideAssigned] = useState(true);
  // فلتر "الموظف المسؤول" — الـAPI كان بيدعم assignedEmployeeId من الأول، الناقص كان الواجهة.
  const [employeeFilter, setEmployeeFilter] = useState<string>("all");
  const [showBostaDialog, setShowBostaDialog] = useState(false);
  const [bostaAllowOpen, setBostaAllowOpen] = useState(true);

  // فلتر تاريخ الطباعة (يظهر عند اختيار حالة مطبوع)
  const [printedDateFilter, setPrintedDateFilter] = useState<'all' | 'today' | 'yesterday' | 'custom'>('today');
  const [printedCustomDate, setPrintedCustomDate] = useState('');

  const printedDateRange = useMemo(() => {
    if (statusFilter !== 'printed') return { from: undefined, to: undefined };
    const todayKey = cairoDateKey();
    if (printedDateFilter === 'today') {
      return cairoDayRange(todayKey);
    }
    if (printedDateFilter === 'yesterday') {
      return cairoDayRange(previousDateKey(todayKey));
    }
    if (printedDateFilter === 'custom' && printedCustomDate) {
      return cairoDayRange(printedCustomDate);
    }
    return { from: undefined, to: undefined };
  }, [statusFilter, printedDateFilter, printedCustomDate]);

  const queryParams = useMemo(() => ({
    search: search || undefined,
    status: statusFilter !== "all" ? statusFilter : undefined,
    source: sourceFilter !== "all" ? sourceFilter : undefined,
    websiteId: websiteFilter !== "all" ? Number(websiteFilter) : undefined,
    governorates: governorateFilter.length > 0 ? governorateFilter : undefined,
    dateFrom: dateRange.from ?? undefined,
    dateTo: dateRange.to ?? undefined,
    printedDateFrom: printedDateRange.from ?? undefined,
    printedDateTo: printedDateRange.to ?? undefined,
    adName: adNameFilter !== "all" ? adNameFilter : undefined,
    // الفلترين متناقضين بطبيعتهم: "غير الموزعة فقط" معناها assignedEmployeeId = NULL، فلو
    // المستخدم اختار موظف بعينه بنسقط unassignedOnly بدل ما نبعت شرطين مستحيل يتحققوا مع بعض
    // ونرجّع جدول فاضي من غير سبب واضح.
    assignedEmployeeId: employeeFilter !== "all" ? Number(employeeFilter) : undefined,
    unassignedOnly: hideAssigned && employeeFilter === "all" ? true : undefined,
    page,
    limit: pageSize,
    businessIds: currentBusinessIds,
  }), [search, statusFilter, sourceFilter, websiteFilter, governorateFilter, dateRange, printedDateRange, adNameFilter, hideAssigned, employeeFilter, page, pageSize, currentBusinessIds]);

  const { data, isLoading, refetch } = trpc.orders.list.useQuery(queryParams);
  const { data: statusCounts } = trpc.orders.statusCounts.useQuery({ businessIds: currentBusinessIds });
  const confirmedDateParam = useMemo(() => {
    if (confirmedDateFilter === 'yesterday') {
      return previousDateKey(cairoDateKey());
    }
    if (confirmedDateFilter === 'custom' && confirmedCustomDate) {
      return confirmedCustomDate;
    }
    return undefined; // today (default)
  }, [confirmedDateFilter, confirmedCustomDate]);

  const { data: todayConfirmedData, isLoading: isTodayLoading } = trpc.orders.todayConfirmed.useQuery({
    confirmedByEmployeeId: todayConfirmedEmployeeId ?? undefined,
    date: confirmedDateParam,
    businessIds: currentBusinessIds,
  });
  const { data: products } = trpc.products.list.useQuery(
    currentBusinessIds && currentBusinessIds.length === 1 ? { businessId: currentBusinessIds[0] } : undefined
  );
  // Variants for the edit dialog's per-line "نوع الحفر" select.
  const { data: variantsList } = trpc.variants.all.useQuery(
    currentBusinessIds && currentBusinessIds.length ? { businessIds: currentBusinessIds } : undefined
  );
  const { data: adNames } = trpc.orders.distinctAdNames.useQuery();
  const { data: employees } = trpc.employees.activeList.useQuery(
    currentBusinessIds && currentBusinessIds.length === 1 ? { businessId: currentBusinessIds[0] } : undefined
  );
  const { data: salesChannels } = trpc.salesChannels.activeList.useQuery(
    currentBusinessIds && currentBusinessIds.length === 1 ? { businessId: currentBusinessIds[0] } : undefined
  );

  // اسم الموظف المسؤول لعمود "الموظف" — lookup محلي فقط من قائمة الموظفين المُحمّلة أصلاً
  // لفلتر "مؤكدات اليوم"، بدون أي استعلام جديد (الـAPI بيرجّع assignedEmployeeId رقم فقط).
  const employeeNameById = useMemo(() => {
    const map = new Map<number, string>();
    employees?.forEach((emp: any) => map.set(emp.id, emp.name));
    return map;
  }, [employees]);

  // البيانات حسب التاب النشط
  const activeOrders = activeTab === 'today_confirmed'
    ? (todayConfirmedData?.orders ?? [])
    : (data?.orders ?? []);
  const activeTotal = activeTab === 'today_confirmed'
    ? (todayConfirmedData?.total ?? 0)
    : (data?.total ?? 0);
  const activeLoading = activeTab === 'today_confirmed' ? isTodayLoading : isLoading;

  const confirmMutation = trpc.orders.confirm.useMutation({
    onSuccess: () => { toast.success("تم تأكيد الأوردر"); utils.orders.list.invalidate(); utils.orders.statusCounts.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const cancelMutation = trpc.orders.cancel.useMutation({
    onSuccess: () => {
      toast.success("تم إلغاء الأوردر");
      utils.orders.list.invalidate();
      utils.orders.statusCounts.invalidate();
      setShowCancelDialog(false);
      setCancelReason(""); setCancelNotes("");
    },
    onError: (e) => toast.error(e.message),
  });

  const postponeMutation = trpc.orders.postpone.useMutation({
    onSuccess: () => {
      toast.success("تم تأجيل الأوردر");
      utils.orders.list.invalidate();
      utils.orders.statusCounts.invalidate();
      setShowPostponeDialog(false);
      setPostponeDate(""); setPostponeNotes("");
    },
    onError: (e) => toast.error(e.message),
  });

  const assignMutation = trpc.orders.bulkAssign.useMutation({
    onSuccess: () => {
      toast.success("تم توزيع الأوردرات");
      utils.orders.list.invalidate();
      setShowAssignDialog(false);
      setSelectedOrderIds([]);
    },
    onError: (e) => toast.error(e.message),
  });

  const noAnswerMutation = trpc.orders.markNoAnswer.useMutation({
    onSuccess: () => {
      toast.success("تم تسجيل لم يرد");
      utils.orders.list.invalidate();
      utils.orders.statusCounts.invalidate();
      setShowNoAnswerDialog(false);
      setNoAnswerCallAttempts("");
    },
    onError: (e) => toast.error(e.message),
  });

  // استبيان مصغّر لموظف التأكيد: كام مرة اتصل بالعميل قبل ما يعلّم الأوردر "لم يرد".
  const openNoAnswerDialog = (orderId: number) => {
    setSelectedOrderId(orderId);
    setNoAnswerCallAttempts("");
    setShowNoAnswerDialog(true);
  };

  const deleteMutation = trpc.orders.delete.useMutation({
    onSuccess: () => { toast.success("تم حذف الأوردر"); utils.orders.list.invalidate(); utils.orders.statusCounts.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

  const bulkDeleteMutation = trpc.orders.bulkDelete.useMutation({
    onSuccess: () => {
      toast.success("تم حذف الأوردرات المحددة");
      utils.orders.list.invalidate();
      utils.orders.statusCounts.invalidate();
      setSelectedOrderIds([]);
    },
    onError: (e) => toast.error(e.message),
  });

  // Two mutations, one Save button — same split as the confirmation screen. Neither
  // handler closes the dialog: a failed save has to leave the typed values on screen.
  const editOrderMutation = trpc.orders.editOrder.useMutation({
    onError: e => toast.error(e.message),
  });

  const editItemsMutation = trpc.orders.editOrderItems.useMutation({
    onError: e => toast.error(e.message),
  });

  const editSaving = editOrderMutation.isPending || editItemsMutation.isPending;

  const { data: editItemsData, isLoading: editItemsLoading, error: editItemsError } =
    trpc.orders.orderItems.useQuery(
      { orderId: editOrderId ?? 0 },
      { enabled: showEditDialog && editOrderId != null, retry: false }
    );

  /** The order the dialog is open on, read from the list the page already has. */
  const editingOrder =
    (data?.orders ?? []).find((o: any) => o.id === editOrderId) ?? null;

  /**
   * Items first: it is the call that can be refused outright (stock already out) and the
   * one that rewrites totalAmount, so running it second would leave the header saved and
   * the basket rejected — which reads to the user as a successful save.
   *
   * Throwing is how the dialog learns to stay open with the typed values intact.
   */
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
        // Sent unconditionally, not `|| undefined`: clearing a stale note is meant.
        notes: header.notes,
        ...(itemsDirty ? {} : { shippingFees }),
      });
    }
    toast.success("✅ تم حفظ التعديلات");
    utils.orders.list.invalidate();
    utils.orders.todayConfirmed.invalidate();
    utils.orders.orderItems.invalidate({ orderId });
  }

  const duplicateOrderMutation = trpc.orders.duplicate.useMutation({
    onSuccess: (data) => {
      toast.success(`✅ تم تكرار الأوردر — أوردر جديد #${data.newOrderNumber}`);
      utils.orders.list.invalidate();
      utils.orders.todayConfirmed.invalidate();
      utils.orders.statusCounts.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const returnMutation = trpc.returns.markAsReturned.useMutation({
    onSuccess: () => {
      toast.success("✅ تم تسجيل المرتجع بنجاح");
      utils.orders.list.invalidate();
      setShowReturnDialog(false);
      setReturnReason(""); setReturnNotes(""); setReturnRestoreStock(true);
    },
    onError: (e) => toast.error(e.message),
  });

  const convertNoAnswerMutation = trpc.orders.convertNoAnswerToNew.useMutation({
    onSuccess: (data) => {
      toast.success(`تم تحويل ${data.count} أوردر من "لم يرد" إلى "جديد"`);
      utils.orders.list.invalidate();
      utils.orders.statusCounts.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const convertPostponedMutation = trpc.orders.convertPostponedToNew.useMutation({
    onSuccess: (data) => {
      toast.success(`تم تحويل ${data.count} أوردر من "مؤجل" إلى "جديد"`);
      utils.orders.list.invalidate();
      utils.orders.statusCounts.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const bulkSendToBostaMutation = trpc.orders.bulkSendToBosta.useMutation({
    onSuccess: (data) => {
      if (data.failed === 0) {
        toast.success(`✅ تم إرسال ${data.success} أوردر لـ Bosta بنجاح`);
      } else {
        const details = (data.errors ?? [])
          .slice(0, 5)
          .map((e) => `أوردر #${e.orderId}: ${e.error}`)
          .join("\n");
        const more = (data.errors?.length ?? 0) > 5 ? `\n… و${(data.errors!.length - 5)} أخرى` : "";
        toast.warning(`تم إرسال ${data.success} ✅ وفشل ${data.failed} ❌ ${details}${more}`);
      }
      utils.orders.list.invalidate();
      setSelectedOrderIds([]);
    },
    onError: (e) => toast.error('فشل الإرسال: ' + e.message),
  });

  const orders = activeOrders;
  const total = activeTotal;
  const totalPages = Math.ceil(total / pageSize);
  // Sequence number shown in the table — fixed to match the actual page size (100); the
  // previous constant (20) desynced the displayed "#" from the real page boundary on any
  // page after the first.
  const seqByOrderId = useMemo(() => {
    const map = new Map<number, number>();
    orders.forEach((o: any, i: number) => map.set(o.id, (page - 1) * 100 + i + 1));
    return map;
  }, [orders, page]);

  // Selection state itself still lives here (the assign/delete/print mutations read it), but
  // the *interaction* — per-row toggle, shift-click ranges, select-all, clear — is owned by
  // ResponsiveDataTable now. The hand-rolled versions of all four were deleted with the custom
  // checkbox column they served.
  const clearAllSelections = () => setSelectedOrderIds([]);

  const openEditFor = (order: any) => {
    setEditOrderId(order.id);
    setShowEditDialog(true);
  };

  // ==================== Filter chips (display only — each underlying useState above
  // remains the single source of truth; this object exists purely to describe them) ====
  const filtersSnapshot = {
    status: statusFilter, source: sourceFilter, website: websiteFilter,
    governorates: governorateFilter, adName: adNameFilter, hideAssigned, dateRange,
    employee: employeeFilter === "all"
      ? "all"
      : employeeNameById.get(Number(employeeFilter)) ?? `#${employeeFilter}`,
  };
  const filterChips = buildFilterChips(filtersSnapshot, FILTER_DESCRIPTORS);
  const activeFilterCount = countActiveFilters(filtersSnapshot, FILTER_DESCRIPTORS);
  const clearOneFilter = (key: string) => {
    setPage(1);
    if (key === "status") setStatusFilter("all");
    else if (key === "source") setSourceFilter("all");
    else if (key === "governorates") setGovernorateFilter([]);
    else if (key === "adName") setAdNameFilter("all");
    else if (key === "hideAssigned") setHideAssigned(false);
    else if (key === "employee") setEmployeeFilter("all");
    else if (key === "dateRange") setDateRange({ from: null, to: null });
  };
  const resetAllFilters = () => {
    setPage(1);
    setSearch(""); setStatusFilter("all"); setSourceFilter("all"); setWebsiteFilter("all");
    setGovernorateFilter([]); setAdNameFilter("all"); setHideAssigned(false);
    setEmployeeFilter("all");
    setDateRange({ from: null, to: null });
  };

  const runPendingConfirm = () => {
    if (!pendingConfirm) return;
    if (pendingConfirm.type === "deleteOrder") deleteMutation.mutate({ orderId: pendingConfirm.orderId });
    else if (pendingConfirm.type === "bulkDelete") bulkDeleteMutation.mutate({ orderIds: selectedOrderIds });
    else if (pendingConfirm.type === "duplicateOrder") duplicateOrderMutation.mutate({ orderId: pendingConfirm.orderId });
    else if (pendingConfirm.type === "convertNoAnswer") convertNoAnswerMutation.mutate();
    else if (pendingConfirm.type === "convertPostponed") convertPostponedMutation.mutate();
    setPendingConfirm(null);
  };

  // ==================== Table columns ====================
  // No hand-rolled "select" column: row selection (including shift-click ranges and the
  // select-all header box) now comes from ResponsiveDataTable's built-in `selectedKeys`
  // support, so it looks and behaves identically to every other table in the product.
  const columns: Column<any>[] = [
    {
      id: "seq", header: "#", defaultHidden: true,
      cell: (order) => <span className="text-xs text-muted-foreground font-semibold">{seqByOrderId.get(order.id)}</span>,
      className: "text-center w-12",
    },
    {
      id: "identifier", header: "رقم الأوردر", alwaysVisible: true,
      cell: (order) => (
        <div className="leading-tight">
          {/* المعرّف الخارجي هو اللي الموظف بينده بيه، فهو الأبرز؛ الرقم الداخلي سياق تحته.
              اتشال الخلفية الملوّنة: اللون في هذا النظام دلالة حالة، مش زخرفة. */}
          {order.easyOrderShortId ? (
            <>
              <p className="font-mono text-sm font-bold">#{order.easyOrderShortId}</p>
              <p className="type-caption font-mono">{order.orderNumber}</p>
            </>
          ) : (
            <p className="font-mono text-sm font-bold">#{order.orderNumber}</p>
          )}
          {order.bostaShipmentId && (
            <span className="flex items-center gap-0.5 mt-0.5 text-[10px] bg-[var(--info)] text-white px-1.5 py-0.5 rounded-full w-fit font-bold" title={`شحنة Bosta: ${order.bostaTrackingNumber || order.bostaShipmentId}`}>
              <PackageCheck className="h-2.5 w-2.5" /> بوسطة
            </span>
          )}
          {order.bostaLastError && !order.bostaShipmentId && (
            <span className="block mt-0.5 text-[10px] bg-destructive/10 text-destructive border border-destructive/20 px-1.5 py-0.5 rounded-full w-fit font-bold">
              ⚠️ فشل بوسطة
            </span>
          )}
        </div>
      ),
    },
    {
      id: "customer", header: "العميل", alwaysVisible: true,
      cell: (order) => (
        <div className="min-w-0 max-w-[200px] leading-tight">
          <p className="truncate text-sm font-semibold" title={order.customerName}>{order.customerName}</p>
          <p className="flex items-center gap-1 type-caption">
            <PhoneCall className="h-3 w-3 shrink-0" />
            <span className="font-mono" dir="ltr">{order.customerPhone}</span>
          </p>
        </div>
      ),
    },
    {
      // "الموقع" في التصميم: المحافظة بارزة والمنطقة تحتها. العنوان الكامل يظل في الـdrawer
      // بدل ما ياخد عرض عمود كامل في الجدول.
      id: "location", header: "الموقع", alwaysVisible: true,
      cell: (order) => (
        <div className="max-w-[130px] leading-tight">
          <p className="text-sm font-medium">{order.governorate || '—'}</p>
          {(order.city || order.customerAddress) && (
            <p className="truncate type-caption" title={order.customerAddress || undefined}>
              {order.city || order.customerAddress}
            </p>
          )}
        </div>
      ),
    },
    {
      id: "product", header: "المنتج", alwaysVisible: true,
      cell: (order) => {
        // ملخص المنتج: اسم — عدد القطع، وسطر تخصيص (لون/مقاس) لو موجود. أيقونة تحذير لو
        // فيه أكتر من قطعة ومعاها تخصيص — أقرب دليل متاح من بيانات الأوردر الحالية بدون أي
        // تعديل في الـ backend (مفيش items[] منفصل مرجّع من orders.list).
        const hasCustomization = Boolean(order.color || order.size);
        const multipleCustomized = order.quantity > 1 && hasCustomization;
        return (
          <div className="max-w-[210px] leading-tight">
            <p className="truncate text-sm font-medium" title={order.productName}>
              {order.productName}{order.quantity > 1 ? ` – ${order.quantity} قطع` : ''}
            </p>
            {hasCustomization && (
              <p className="flex items-center gap-1 truncate type-caption">
                {/* أيقونة من طقم Lucide بدل إيموجي: الإيموجي بيتغيّر شكله من نظام لنظام
                    وبيكسر اتساق الأيقونات اللي الكتيّب بيفرضه (§18). */}
                {multipleCustomized && (
                  <AlertTriangle className="h-3 w-3 shrink-0 text-[var(--warning)]" />
                )}
                <span className="truncate">
                  {order.color && `اللون: ${order.color}`}
                  {order.color && order.size && ' · '}
                  {order.size && `المقاس: ${order.size}`}
                </span>
              </p>
            )}
          </div>
        );
      },
    },
    {
      id: "status", header: "الحالة", alwaysVisible: true,
      cell: (order) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={order.status} kind="order" size="sm" />
          {order.needsReview && (
            <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-[var(--purple)] bg-[var(--purple)]/10 border border-[var(--purple)]/30">
              يحتاج مراجعة
            </span>
          )}
          {/* شارة "لسه مطبعش" اتشالت عمدًا: حالة "مؤكد" معناها بالتعريف إنه لم يُطبع بعد
              (الطباعة حالة منفصلة "مطبوع") — كانت معلومة مكررة بتزحم العمود في كل صف مؤكد. */}
        </div>
      ),
    },
    {
      id: "assignedEmployee", header: "الموظف المسؤول", alwaysVisible: true,
      cell: (order) => {
        const name = order.assignedEmployeeId ? employeeNameById.get(order.assignedEmployeeId) : undefined;
        return name ? (
          <span className="text-sm font-medium">{name}</span>
        ) : (
          <span className="type-caption">غير موزع</span>
        );
      },
    },
    {
      id: "total", header: "الإجمالي", numeric: true, alwaysVisible: true,
      cell: (order) => (
        // المبلغ هو الرقم اللي العين بتدوّر عليه، فبيفضل بارز والعملة تخفت وراه.
        <span className="text-sm font-bold tabular-nums">
          {Number(order.totalAmount).toLocaleString('ar-EG')}{' '}
          <span className="type-caption font-normal">ج.م</span>
        </span>
      ),
    },
    {
      id: "website", header: "الموقع", defaultHidden: true,
      cell: (order) => order.websiteName ? (
        <span className="inline-block bg-accent text-accent-foreground px-2 py-1 rounded text-xs font-medium">
          {order.websiteName}
        </span>
      ) : <span className="text-muted-foreground">—</span>,
    },
    {
      id: "date", header: "تاريخ الطلب", alwaysVisible: true,
      cell: (order) => (
        <div className="whitespace-nowrap leading-tight">
          <p className="text-sm tabular-nums">
            {new Date(order.createdAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })}
          </p>
          <p className="type-caption tabular-nums">
            {new Date(order.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
      ),
    },
    {
      // أقرب حقل موجود فعليًا لمفهوم "آخر متابعة" — لا يوجد عمود بهذا المعنى تحديدًا في قاعدة
      // البيانات، والاتفاق كان استخدام تاريخ آخر تعديل للأوردر بدل إضافة أي حقل جديد بالباك إند.
      id: "lastFollowUp", header: "آخر متابعة", alwaysVisible: true,
      cell: (order) => (
        <div className="whitespace-nowrap leading-tight">
          {order.updatedAt ? (
            <>
              <p className="text-sm tabular-nums">
                {new Date(order.updatedAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })}
              </p>
              <p className="type-caption tabular-nums">
                {new Date(order.updatedAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </>
          ) : <span className="type-caption">—</span>}
        </div>
      ),
    },
    {
      id: "actions", header: "", alwaysVisible: true, sticky: true,
      cell: (order) => {
        const isActionable = order.status === 'new' || order.status === 'postponed';
        const canReturn = isAdmin && ['confirmed', 'shipped', 'delivered', 'preparing'].includes(order.status);
        return (
          <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
            {/* أزرار أساسية — ظاهرة دايمًا، لون ثابت لكل معنى، بحد أقصى 3-4 عشان الصف ميبقاش مزدحم */}
            {isActionable && (
              <>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-[var(--success)] hover:bg-[var(--success)]/12 hover:text-[var(--success)]"
                  onClick={() => confirmMutation.mutate({ orderId: order.id })}
                  title="تأكيد الأوردر" aria-label="تأكيد الأوردر">
                  <CheckCircle className="h-4 w-4" />
                </Button>
                <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive hover:bg-destructive/12 hover:text-destructive"
                  onClick={() => { setSelectedOrderId(order.id); setShowCancelDialog(true); }}
                  title="إلغاء الأوردر" aria-label="إلغاء الأوردر">
                  <XCircle className="h-4 w-4" />
                </Button>
              </>
            )}
            <WhatsAppButton phone={order.customerPhone} iconOnly size="icon-sm" className="h-8 w-8" />
            <Button size="icon" variant="ghost" className="h-8 w-8 text-[var(--info)] hover:bg-[var(--info)]/12 hover:text-[var(--info)]"
              onClick={() => setDetailOrderId(order.id)}
              title="عرض تفاصيل الأوردر" aria-label="عرض تفاصيل الأوردر">
              <Eye className="h-4 w-4" />
            </Button>

            {/* باقي الإجراءات — أقل استخدامًا، جوه قائمة منسدلة بدل ما تزاحم الصف */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  title="إجراءات أخرى" aria-label="إجراءات أخرى لهذا الأوردر">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {isActionable && (
                  <>
                    <DropdownMenuItem onClick={() => { setSelectedOrderId(order.id); setShowPostponeDialog(true); }}>
                      <Clock className="h-4 w-4 ml-2 text-[var(--warning)]" /> جدولة اتصال لاحق
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => openNoAnswerDialog(order.id)}>
                      <PhoneOff className="h-4 w-4 ml-2 text-[var(--warning)]" /> لم يرد
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => { window.location.href = `tel:${order.customerPhone}`; }}>
                  <PhoneCall className="h-4 w-4 ml-2 text-[var(--info)]" /> اتصال بالعميل
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => openEditFor(order)}>
                  <Edit2 className="h-4 w-4 ml-2 text-[var(--info)]" /> تعديل
                </DropdownMenuItem>
                {isAdmin && (
                  <DropdownMenuItem
                    disabled={duplicateOrderMutation.isPending}
                    onClick={() => setPendingConfirm({ type: "duplicateOrder", orderId: order.id, orderNumber: order.orderNumber, customerName: order.customerName })}
                  >
                    <Copy className="h-4 w-4 ml-2 text-muted-foreground" /> تكرار الأوردر
                  </DropdownMenuItem>
                )}
                {canReturn && (
                  <DropdownMenuItem onClick={() => { setReturnOrderId(order.id); setShowReturnDialog(true); }}>
                    <RotateCcw className="h-4 w-4 ml-2 text-primary" /> مرتجع
                  </DropdownMenuItem>
                )}
                {isAdmin && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => setPendingConfirm({ type: "deleteOrder", orderId: order.id, orderNumber: order.orderNumber })}
                    >
                      <Trash2 className="h-4 w-4 ml-2" /> حذف
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  const selectedKeysSet = useMemo(() => new Set<string | number>(selectedOrderIds), [selectedOrderIds]);

  // ==================== Drawer workspace ====================
  // The drawer is a queue, not a popup: open one order, act on it, move to the next without
  // bouncing back to the table. In RTL, ← advances (forward is leftward) and → goes back.
  const drawerOrder = (detailOrder as any) ?? orders.find((o: any) => o.id === detailOrderId);
  const detailIndex = detailOrderId != null ? orders.findIndex((o: any) => o.id === detailOrderId) : -1;
  const goToOrderAt = (index: number) => {
    if (index < 0 || index >= orders.length) return;
    setDetailOrderId(orders[index].id);
  };

  useEffect(() => {
    if (detailOrderId == null) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      // Never hijack the arrow keys while someone is typing a note inside the drawer.
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); goToOrderAt(detailIndex + 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); goToOrderAt(detailIndex - 1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailOrderId, detailIndex, orders]);

  // Status change from inside the drawer — the same generic update the table's status column
  // uses, so the widened transition rules in db.ts apply identically here.
  const updateStatusMutation = trpc.orders.update.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث الحالة");
      utils.orders.list.invalidate();
      utils.orders.statusCounts.invalidate();
      utils.orders.get.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="الأوردرات"
        description="إدارة ومتابعة الطلبات والشحن والتوصيل"
        primaryAction={
          <Button className="gap-1.5" onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4" />
            أوردر جديد
          </Button>
        }
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* أيقونة فقط: الفائض مش إجراء أساسي، فمياخدش وزن بصري زي الزر الأساسي */}
              <Button variant="outline" size="icon" aria-label="إجراءات أخرى" title="إجراءات أخرى">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="type-caption">استيراد</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => setShowImportDialog(true)}>
                <FileSpreadsheet className="h-4 w-4 ml-2 text-[var(--success)]" /> استيراد Easy Order
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowWhatsAppImportDialog(true)}>
                <svg className="h-4 w-4 ml-2" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" /></svg>
                استيراد واتساب
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="type-caption">تصدير</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => { setExportType('confirmed'); setShowExportDialog(true); }}>
                <Download className="h-4 w-4 ml-2" /> تصدير المؤكدة
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setExportType('shipping'); setShowExportDialog(true); }}>
                <Truck className="h-4 w-4 ml-2" /> شيت الشحن
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="type-caption">إجراءات جماعية</DropdownMenuLabel>
              <DropdownMenuItem
                disabled={selectedOrderIds.length === 0}
                onClick={() => {
                  const params = new URLSearchParams();
                  params.set('orderIds', selectedOrderIds.join(','));
                  window.open(`/api/export/print-labels?${params.toString()}`, '_blank');
                  toast.success(`جاري تجهيز ${selectedOrderIds.length} label للطباعة...`);
                  setTimeout(() => {
                    utils.orders.list.invalidate();
                    utils.orders.todayConfirmed.invalidate();
                    setSelectedOrderIds([]);
                  }, 2000);
                }}
              >
                <Printer className="h-4 w-4 ml-2" />
                تصدير للطباعة {selectedOrderIds.length > 0 ? `(${selectedOrderIds.length})` : ''}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={convertNoAnswerMutation.isPending}
                onClick={() => setPendingConfirm({ type: "convertNoAnswer" })}
              >
                <RotateCcw className="h-4 w-4 ml-2" /> لم يرد ← جديد
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={convertPostponedMutation.isPending}
                onClick={() => setPendingConfirm({ type: "convertPostponed" })}
              >
                <RotateCcw className="h-4 w-4 ml-2" /> مؤجل ← جديد
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        {/* Design System V2 — بطاقات إحصائيات: أيقونة في مربع ملوّن + رقم كبير، وكل بطاقة
            تعمل كفلتر سريع للحالة. الحالات المختارة هي الأكثر استخدامًا فعليًا في هذا النشاط
            (جديد/مؤكد/لم يرد/ملغي هي الأرقام الكبيرة)، وباقي الحالات متاحة من شريط التبويبات.
            ملاحظة: التصميم يعرض مؤشر اتجاه ("من أمس") — لا توجد بيانات مقارنة في الـAPI الحالي
            ولم أختلق أرقامًا؛ الـStatCard يدعم `trend` ويظهر تلقائيًا فور توفّر البيانات. */}
        {/* موبايل: شريط أفقي قابل للتمرير — الشبكة الرأسية كانت بتحط ٧ كروت فوق بعض، يعني
            تمرير طويل قبل ما توصل لأول أوردر. من lg وطالع بيرجع شبكة عادية (الديسكتوب ما اتغيرش).
            -mx-* + px-* عشان أول وآخر كارت يلمسوا حافة الشاشة بدل ما يتقصّوا. */}
        <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-7 lg:overflow-visible [&>*]:min-w-[152px] [&>*]:snap-start lg:[&>*]:min-w-0">
          {([
            { key: 'all', label: 'كل الأوردرات', value: statusCounts?.total, tone: 'default', icon: <Package className="h-5 w-5" /> },
            { key: 'new', label: 'جديد', value: statusCounts?.byStatus?.new, tone: 'info', icon: <FileText className="h-5 w-5" /> },
            { key: 'confirmed', label: 'مؤكد', value: statusCounts?.byStatus?.confirmed, tone: 'success', icon: <CheckCircle className="h-5 w-5" /> },
            { key: 'no_answer', label: 'لم يرد', value: statusCounts?.byStatus?.no_answer, tone: 'warning', icon: <PhoneOff className="h-5 w-5" /> },
            { key: 'shipped', label: 'تم الشحن', value: statusCounts?.byStatus?.shipped, tone: 'info', icon: <Truck className="h-5 w-5" /> },
            { key: 'cancelled', label: 'ملغي', value: statusCounts?.byStatus?.cancelled, tone: 'danger', icon: <XCircle className="h-5 w-5" /> },
          ] as const).map(c => (
            <StatCard
              key={c.key}
              label={c.label}
              value={(c.value ?? 0).toLocaleString('ar-EG')}
              tone={c.tone}
              icon={c.icon}
              active={activeTab === 'all' && statusFilter === c.key}
              onClick={() => { setActiveTab('all'); setStatusFilter(c.key); setPage(1); }}
            />
          ))}
          {/* غير قابلة للنقر: "يحتاج مراجعة" علامة على الأوردر وليست حالة، فمفيش فلتر مقابل لها */}
          <StatCard
            label="يحتاج مراجعة"
            value={(statusCounts?.needsReview ?? 0).toLocaleString('ar-EG')}
            tone="warning"
            icon={<AlertTriangle className="h-5 w-5" />}
          />
        </div>
      </PageHeader>

      {/* شريط التبويبات الموحّد — الحالات كلها + تبويب "مؤكدات اليوم" المميز في صف واحد،
          بدل صفين تبويبات فوق بعض (الزرار القديم اتشال). */}
      <div className="overflow-x-auto border-b border-border px-3">
        <div className="flex w-max items-center gap-0.5">
          {(["all", "new", "confirmed", "no_answer", "postponed", "printed", "preparing", "shipped", "delivered", "cancelled", "returned"] as const).map(v => {
            const active = activeTab === 'all' && statusFilter === v;
            const count = v === 'all' ? statusCounts?.total : statusCounts?.byStatus?.[v];
            return (
              <button
                key={v}
                onClick={() => { setActiveTab('all'); setStatusFilter(v); setPage(1); }}
                className={`relative flex items-center gap-2 whitespace-nowrap px-3.5 py-3 text-sm transition-colors duration-[var(--duration-fast)] ${
                  active ? 'font-bold text-primary' : 'font-medium text-muted-foreground hover:text-foreground'
                }`}
              >
                {v === 'all' ? 'كل الأوردرات' : STATUS_LABEL(v)}
                {count != null && count > 0 && (
                  <span className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums ${
                    active ? 'bg-accent text-accent-foreground' : 'bg-muted text-muted-foreground'
                  }`}>
                    {Number(count).toLocaleString('ar-EG')}
                  </span>
                )}
                {active && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
              </button>
            );
          })}
          <span className="mx-1 h-5 w-px shrink-0 bg-border" />
          <button
            onClick={() => setActiveTab('today_confirmed')}
            className={`relative flex items-center gap-2 whitespace-nowrap px-3.5 py-3 text-sm transition-colors duration-[var(--duration-fast)] ${
              activeTab === 'today_confirmed' ? 'font-bold text-[var(--success)]' : 'font-medium text-muted-foreground hover:text-foreground'
            }`}
          >
            ✔ مؤكدات اليوم
            {/* الحارس على `total` نفسه مش على الكائن: لو الاستجابة رجعت من غير العدّاد كان
                Number(undefined) بيطبع "ليس رقمًا" جوه الشارة قدام المستخدم. */}
            {todayConfirmedData?.total != null && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                activeTab === 'today_confirmed' ? 'bg-[var(--success)]/15 text-[var(--success)]' : 'bg-muted text-muted-foreground'
              }`}>
                {Number(todayConfirmedData.total).toLocaleString('ar-EG')}
              </span>
            )}
            {activeTab === 'today_confirmed' && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-[var(--success)]" />}
          </button>
        </div>
      </div>

      {/* Today-confirmed panel */}
      {activeTab === 'today_confirmed' && (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--success)]/30 bg-[var(--success)]/5 px-4 py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <p className="text-sm font-semibold text-[var(--success)]">
                {confirmedDateFilter === 'today' ? 'مؤكدات اليوم' : confirmedDateFilter === 'yesterday' ? 'مؤكدات أمس' : `مؤكدات ${confirmedCustomDate}`}
                {' - '}
                {confirmedDateFilter === 'today'
                  ? new Date().toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
                  : confirmedDateFilter === 'yesterday'
                  ? new Date(Date.now() - 86400000).toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
                  : confirmedCustomDate ? new Date(confirmedCustomDate + 'T00:00:00').toLocaleDateString('ar-EG', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : ''}
              </p>
              <p className="mt-0.5 type-caption tabular-nums">
                إجمالي: {todayConfirmedData?.total ?? 0} أوردر مؤكد (لم يُطبع بعد) · إجمالي المبالغ: {(todayConfirmedData?.orders ?? []).reduce((s: number, o: any) => s + Number(o.totalAmount), 0).toLocaleString('ar-EG')} ج.م
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex gap-1 bg-card rounded-lg border border-border p-0.5">
                {(['today', 'yesterday', 'custom'] as const).map(f => (
                  <button key={f} onClick={() => setConfirmedDateFilter(f)}
                    className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                      confirmedDateFilter === f ? 'bg-[var(--success)] text-[var(--success-foreground)]' : 'text-muted-foreground hover:bg-muted'
                    }`}>
                    {f === 'today' ? 'اليوم' : f === 'yesterday' ? 'أمس' : 'تاريخ مخصص'}
                  </button>
                ))}
              </div>
              {confirmedDateFilter === 'custom' && (
                <input type="date" value={confirmedCustomDate} onChange={e => setConfirmedCustomDate(e.target.value)}
                  className="text-xs border border-border bg-card rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring" />
              )}
              <select value={todayConfirmedEmployeeId ?? ''} onChange={e => setTodayConfirmedEmployeeId(e.target.value ? Number(e.target.value) : null)}
                className="text-xs border border-border bg-card rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-ring min-w-36">
                <option value="">جميع الموظفين</option>
                {employees?.map(emp => <option key={emp.id} value={emp.id}>{emp.name}</option>)}
              </select>
              {todayConfirmedEmployeeId && (
                <button onClick={() => setTodayConfirmedEmployeeId(null)} className="text-xs text-[var(--success)] hover:underline">
                  إلغاء الفلتر
                </button>
              )}
            </div>
          </div>
          <button
            onClick={() => {
              import('xlsx').then(XLSX => {
                const rows = (todayConfirmedData?.orders ?? []).map((o: any, i: number) => ({
                  '#': i + 1,
                  'رقم Easy Order': o.easyOrderShortId || o.orderNumber,
                  'العميل': o.customerName,
                  'التليفون': o.customerPhone,
                  'المحافظة': o.governorate || '',
                  'العنوان': o.customerAddress || '',
                  'المنتج': o.productName,
                  'الكمية': o.quantity,
                  'المبلغ': Number(o.totalAmount),
                  'وقت التأكيد': o.confirmedAt ? new Date(o.confirmedAt).toLocaleString('ar-EG') : '',
                }));
                const ws = XLSX.utils.json_to_sheet(rows);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, 'مؤكدات اليوم');
                XLSX.writeFile(wb, `مؤكدات-اليوم-${new Date().toISOString().slice(0, 10)}.xlsx`);
              });
            }}
            className="flex items-center gap-1.5 self-start bg-[var(--success)] text-[var(--success-foreground)] text-xs font-medium px-3 py-2 rounded-lg hover:opacity-90 transition-opacity"
          >
            <Download className="h-3.5 w-3.5" />
            تصدير Excel
          </button>
        </div>
      )}

      {/* Filters */}
      {activeTab === 'all' && (
        <Card className="shadow-[var(--shadow-card)]">
          <CardContent className="p-3">
            <FilterBar
              search={
                <SearchInput
                  value={search}
                  onChange={(v) => { setSearch(v); setPage(1); }}
                  placeholder="بحث بالاسم أو الهاتف أو رقم الأوردر..."
                />
              }
              chips={filterChips}
              onClearChip={clearOneFilter}
              onReset={resetAllFilters}
              activeCount={activeFilterCount}
            >
              {statusFilter === 'printed' && (
                <div className="flex items-center gap-1.5 bg-[var(--info)]/10 border border-[var(--info)]/30 rounded-lg px-2 py-1">
                  <span className="text-xs text-[var(--info)] font-medium whitespace-nowrap">مطبوع:</span>
                  {(['today', 'yesterday', 'all', 'custom'] as const).map(f => (
                    <button key={f} onClick={() => { setPrintedDateFilter(f); setPage(1); }}
                      className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                        printedDateFilter === f ? 'bg-[var(--info)] text-white' : 'bg-card text-[var(--info)] hover:bg-[var(--info)]/10'
                      }`}>
                      {f === 'today' ? 'اليوم' : f === 'yesterday' ? 'أمس' : f === 'all' ? 'الكل' : 'مخصص'}
                    </button>
                  ))}
                  {printedDateFilter === 'custom' && (
                    <input type="date" value={printedCustomDate} onChange={e => { setPrintedCustomDate(e.target.value); setPage(1); }}
                      className="text-xs border border-border rounded px-1.5 py-0.5 w-32 bg-card" />
                  )}
                </div>
              )}

              <Select value={sourceFilter} onValueChange={v => { setSourceFilter(v); setPage(1); }}>
                <SelectTrigger className="h-9 w-40"><SelectValue placeholder="المصدر" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل المصادر</SelectItem>
                  {sourceOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
                </SelectContent>
              </Select>

              <Select value={websiteFilter} onValueChange={v => { setWebsiteFilter(v); setPage(1); }}>
                <SelectTrigger className="h-9 w-40"><SelectValue placeholder="الموقع" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل المواقع</SelectItem>
                  {salesChannels?.map((ch: any) => <SelectItem key={ch.id} value={String(ch.id)}>{ch.name}</SelectItem>)}
                </SelectContent>
              </Select>

              <MultiSelect
                options={GOVERNORATES.map(g => ({ value: g, label: g }))}
                selected={governorateFilter}
                onChange={(vals) => { setGovernorateFilter(vals); setPage(1); }}
                placeholder="كل المحافظات"
                countLabel={(n) => `${n} محافظات`}
                className="w-40"
              />

              <Select value={adNameFilter} onValueChange={v => { setAdNameFilter(v); setPage(1); }}>
                <SelectTrigger className="h-9 w-40"><SelectValue placeholder="فلترة حسب اسم البيدج" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل البيدجات</SelectItem>
                  {(adNames ?? []).map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>

              <Select value={employeeFilter} onValueChange={v => { setEmployeeFilter(v); setPage(1); }}>
                <SelectTrigger className="h-9 w-40"><SelectValue placeholder="الموظف المسؤول" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الموظفين</SelectItem>
                  {(employees ?? []).map((emp: any) => (
                    <SelectItem key={emp.id} value={String(emp.id)}>{emp.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                variant={hideAssigned ? "default" : "outline"}
                size="sm"
                className="h-9"
                // متعطّل وقت اختيار موظف: الزرار وقتها مالوش أثر (بنسقط unassignedOnly)،
                // وزرار شكله فعّال ومش بيعمل حاجة أسوأ من زرار متعطّل بسبب واضح.
                disabled={employeeFilter !== "all"}
                title={employeeFilter !== "all" ? "غير متاح أثناء الفلترة بموظف محدد" : undefined}
                onClick={() => { setHideAssigned(v => !v); setPage(1); }}
              >
                {hideAssigned ? "غير الموزعة فقط" : "كل الأوردرات"}
              </Button>

              <div className="flex items-center gap-1.5">
                <CalendarDays className="h-4 w-4 text-muted-foreground" />
                <DateRangePicker value={dateRange} onChange={(range) => { setDateRange(range); setPage(1); }} />
              </div>

              {/* "فلاتر متقدمة" — يفتح/يقفل الأعمدة الإضافية المخفية (seq/website) بدل ما تبقى
                  مدفونة في قائمة الأعمدة. لا فلاتر جديدة، ولا تغيير في منطق أي فلتر قائم. */}
              <Button
                variant="outline" size="sm" className="h-9 gap-1.5"
                aria-expanded={hiddenColumns.size === 0}
                onClick={() => setHiddenColumns(prev => prev.size > 0 ? new Set() : new Set(['seq', 'website']))}
              >
                <SlidersHorizontal className="h-4 w-4" />
                {hiddenColumns.size > 0 ? 'فلاتر متقدمة' : 'إخفاء المتقدمة'}
              </Button>
            </FilterBar>
            {/* إجراءات التحديد الجماعي انتقلت لشريط الجدول نفسه (bulkActions) — كانت هنا فوق
                الجدول وبتدفعه لتحت أول ما تحدد صف. */}
          </CardContent>
        </Card>
      )}

      {/* Orders table */}
      <ResponsiveDataTable
        rows={orders}
        columns={columns}
        rowKey={(o: any) => o.id}
        loading={activeLoading}
        density={density}
        onRowClick={(order: any) => setDetailOrderId(order.id)}
        hiddenColumns={hiddenColumns}
        onHiddenColumnsChange={setHiddenColumns}
        empty={{ title: "لا توجد أوردرات", description: "جرّب تعديل الفلاتر أو أضف أوردرًا جديدًا" }}
        toolbar={
          <div className="flex items-center gap-1">
            <Button
              variant={density === 'comfortable' ? 'secondary' : 'ghost'}
              size="icon" className="h-8 w-8" title="تباعد مريح"
              onClick={() => setDensity('comfortable')}
            >
              <Rows3 className="h-4 w-4" />
            </Button>
            <Button
              variant={density === 'compact' ? 'secondary' : 'ghost'}
              size="icon" className="h-8 w-8" title="تباعد مضغوط"
              onClick={() => setDensity('compact')}
            >
              <LayoutGrid className="h-4 w-4" />
            </Button>
          </div>
        }
        selectedKeys={isAdmin ? selectedKeysSet : undefined}
        onSelectionChange={isAdmin ? (keys) => setSelectedOrderIds(Array.from(keys) as number[]) : undefined}
        bulkActions={() => (
          <>
            <Button variant="outline" size="sm" className="h-8" onClick={() => setShowAssignDialog(true)}>
              <UserPlus className="h-4 w-4 ml-1" /> توزيع
            </Button>
            <Button
              variant="outline" size="sm"
              className="h-8 border-destructive/30 text-destructive hover:bg-destructive/10"
              onClick={() => setPendingConfirm({ type: "bulkDelete" })}
            >
              <Trash2 className="h-4 w-4 ml-1" /> حذف
            </Button>
          </>
        )}
        mobileRow={(order: any) => (
          <MobileOrderCard
            orderNumber={order.easyOrderShortId || order.orderNumber}
            customerName={order.customerName}
            customerPhone={order.customerPhone}
            governorate={order.governorate}
            statusBadge={<StatusBadge status={order.status} kind="order" size="sm" />}
            sourceBadge={order.websiteName ? <Badge variant="secondary" className="text-[10px]">{order.websiteName}</Badge> : undefined}
            productSummary={[
              `${order.productName}${order.quantity > 1 ? ` – ${order.quantity} قطع` : ''}`,
              // نوع الحفر مهم للتجهيز، فبيظهر على كارت الموبايل زي ما بيظهر في الجدول.
              [order.color, order.size].filter(Boolean).join(' / '),
            ].filter(Boolean).join(' · ')}
            total={`${Number(order.totalAmount).toLocaleString('ar-EG')} ج.م`}
            dateLabel={new Date(order.createdAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })}
            expanded={expandedMobileId === order.id}
            onToggle={() => setExpandedMobileId(id => id === order.id ? null : order.id)}
            warnings={order.needsReview ? (
              <Badge variant="outline" className="border-[var(--warning)] text-[var(--warning)] text-[10px]">يحتاج مراجعة</Badge>
            ) : undefined}
            details={
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">{order.customerAddress || '—'}</p>
                <p className="type-caption">
                  الموظف المسؤول: <span className="font-medium text-foreground">{order.assignedEmployeeId ? (employeeNameById.get(order.assignedEmployeeId) ?? `#${order.assignedEmployeeId}`) : 'غير موزع'}</span>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {(order.status === 'new' || order.status === 'postponed') && (
                    <>
                      <Button size="sm" className="h-8 gap-1 bg-[var(--success)] text-[var(--success-foreground)]"
                        onClick={() => confirmMutation.mutate({ orderId: order.id })}>
                        <CheckCircle className="h-3.5 w-3.5" /> تأكيد
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 gap-1 border-destructive/30 text-destructive"
                        onClick={() => { setSelectedOrderId(order.id); setShowCancelDialog(true); }}>
                        <XCircle className="h-3.5 w-3.5" /> إلغاء
                      </Button>
                    </>
                  )}
                  <WhatsAppButton phone={order.customerPhone} size="sm" className="h-8" />
                  <Button size="sm" variant="outline" className="h-8 gap-1 text-[var(--info)] border-[var(--info)]/30" onClick={() => setDetailOrderId(order.id)}>
                    <Eye className="h-3.5 w-3.5" /> تفاصيل
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="outline" className="h-8 gap-1 text-muted-foreground" aria-label="إجراءات أخرى لهذا الأوردر">
                        <MoreVertical className="h-3.5 w-3.5" /> المزيد
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      {(order.status === 'new' || order.status === 'postponed') && (
                        <>
                          <DropdownMenuItem onClick={() => { setSelectedOrderId(order.id); setShowPostponeDialog(true); }}>
                            <Clock className="h-4 w-4 ml-2 text-[var(--warning)]" /> جدولة اتصال لاحق
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => openNoAnswerDialog(order.id)}>
                            <PhoneOff className="h-4 w-4 ml-2 text-[var(--warning)]" /> لم يرد
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      )}
                      <DropdownMenuItem onClick={() => { window.location.href = `tel:${order.customerPhone}`; }}>
                        <PhoneCall className="h-4 w-4 ml-2 text-[var(--info)]" /> اتصال بالعميل
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => openEditFor(order)}>
                        <Edit2 className="h-4 w-4 ml-2 text-[var(--info)]" /> تعديل
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            }
          />
        )}
      />

      {activeTab === 'all' && total > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          pageSizeOptions={[25, 50, 100]}
          onPageSizeChange={handlePageSizeChange}
        />
      )}

      {/* Floating selection bar */}
      {isAdmin && selectedOrderIds.length > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 animate-in slide-in-from-bottom-4 duration-200">
          <div className="flex items-center gap-3 bg-foreground text-background rounded-2xl shadow-2xl px-5 py-3 border border-border/20">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                <span className="text-xs font-bold text-primary-foreground">{selectedOrderIds.length}</span>
              </div>
              <span className="text-sm font-medium">أوردر محدد</span>
            </div>
            <div className="w-px h-5 bg-background/20" />
            <Button size="sm" variant="ghost" className="h-8 px-3 text-background hover:bg-background/20 text-xs font-medium"
              onClick={() => setShowAssignDialog(true)}>
              <UserPlus className="h-3.5 w-3.5 ml-1" /> توزيع
            </Button>
            <Button size="sm" variant="ghost" className="h-8 px-3 text-background hover:bg-background/20 text-xs font-medium"
              onClick={() => {
                const params = new URLSearchParams();
                params.set('orderIds', selectedOrderIds.join(','));
                window.open(`/api/export/print-labels?${params.toString()}`, '_blank');
                setTimeout(() => {
                  utils.orders.list.invalidate();
                  utils.orders.todayConfirmed.invalidate();
                  setSelectedOrderIds([]);
                }, 2000);
              }}>
              <Printer className="h-3.5 w-3.5 ml-1" /> طباعة
            </Button>
            <Button size="sm" variant="ghost" className="h-8 px-3 text-[var(--info)] hover:bg-background/20 text-xs font-medium"
              disabled={bulkSendToBostaMutation.isPending} onClick={() => setShowBostaDialog(true)}>
              <Truck className="h-3.5 w-3.5 ml-1" /> {bulkSendToBostaMutation.isPending ? 'جاري الإرسال...' : 'Bosta'}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 px-3 text-[var(--info)] hover:bg-background/20 text-xs font-medium"
              onClick={() => {
                const params = new URLSearchParams();
                params.set('ids', selectedOrderIds.join(','));
                window.open(`/api/orders/bosta-awb?${params.toString()}`, '_blank', 'noopener,noreferrer');
              }}>
              <Printer className="h-3.5 w-3.5 ml-1" /> AWB بوسطة
            </Button>
            {/* الأحمر هنا دلالة "إجراء مدمّر"، فبياخده من --destructive زي أي إجراء حذف
                في المنتج — مش من درجات Tailwind الخام زي باقي الأزرار المجاورة. */}
            <Button size="sm" variant="ghost" className="h-8 px-3 text-destructive hover:bg-background/20 text-xs font-medium"
              onClick={() => setPendingConfirm({ type: "bulkDelete" })}>
              <Trash2 className="h-3.5 w-3.5 ml-1" /> حذف
            </Button>
            <div className="w-px h-5 bg-background/20" />
            <button onClick={clearAllSelections}
              className="w-7 h-7 rounded-full hover:bg-background/20 flex items-center justify-center text-background/70 hover:text-background transition-colors"
              title="إلغاء التحديد">
              <XCircle className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* ==================== Shared confirmation dialog for all destructive actions ==================== */}
      <ConfirmDialog
        open={pendingConfirm !== null}
        onOpenChange={(open) => { if (!open) setPendingConfirm(null); }}
        title={
          pendingConfirm?.type === "deleteOrder" ? "حذف الأوردر" :
          pendingConfirm?.type === "bulkDelete" ? "حذف الأوردرات المحددة" :
          pendingConfirm?.type === "duplicateOrder" ? "تكرار الأوردر" :
          pendingConfirm?.type === "convertNoAnswer" ? "تحويل \"لم يرد\" إلى \"جديد\"" :
          "تحويل \"مؤجل\" إلى \"جديد\""
        }
        description={
          pendingConfirm?.type === "deleteOrder" ? `سيتم حذف الأوردر ${pendingConfirm.orderNumber} نهائيًا.` :
          pendingConfirm?.type === "bulkDelete" ? `سيتم حذف ${selectedOrderIds.length} أوردر نهائيًا.` :
          pendingConfirm?.type === "duplicateOrder" ? `تكرار أوردر #${pendingConfirm.orderNumber} لـ ${pendingConfirm.customerName} كأوردر جديد.` :
          pendingConfirm?.type === "convertNoAnswer" ? "سيتم تحويل كل أوردرات \"لم يرد\" إلى \"جديد\"." :
          "سيتم تحويل كل أوردرات \"مؤجل\" إلى \"جديد\"."
        }
        tone={pendingConfirm?.type === "deleteOrder" || pendingConfirm?.type === "bulkDelete" ? "destructive" : "default"}
        confirmLabel={pendingConfirm?.type === "duplicateOrder" ? "تكرار" : pendingConfirm?.type?.startsWith("convert") ? "تحويل" : "حذف"}
        onConfirm={runPendingConfirm}
        pending={deleteMutation.isPending || bulkDeleteMutation.isPending || duplicateOrderMutation.isPending || convertNoAnswerMutation.isPending || convertPostponedMutation.isPending}
      />

      {/* Bosta Send Dialog */}
      <Dialog open={showBostaDialog} onOpenChange={setShowBostaDialog}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Truck className="h-5 w-5 text-[var(--info)]" /> إرسال لـ Bosta
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              سيتم إرسال <span className="font-bold text-foreground">{selectedOrderIds.length}</span> أوردر لـ Bosta
            </p>
            <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg border border-border hover:bg-accent/50 transition-colors">
              <input type="checkbox" checked={bostaAllowOpen} onChange={(e) => setBostaAllowOpen(e.target.checked)}
                className="h-5 w-5 rounded border-border accent-primary" />
              <div>
                <span className="text-sm font-medium">السماح بفتح الشحنة (فليكس شيب)</span>
                <p className="text-xs text-muted-foreground mt-0.5">العميل يقدر يفتح الشحنة ويشوف محتواها قبل الدفع — ويتفعّل عليها نظام فليكس شيب (العميل يتحمّل جزء من تكلفة الشحن عند رفض الاستلام بعد الفتح)</p>
              </div>
            </label>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowBostaDialog(false)}>إلغاء</Button>
            <Button
              onClick={() => {
                bulkSendToBostaMutation.mutate({ orderIds: selectedOrderIds, allowToOpenPackage: bostaAllowOpen });
                setShowBostaDialog(false);
              }}
              disabled={bulkSendToBostaMutation.isPending}
            >
              {bulkSendToBostaMutation.isPending ? 'جاري الإرسال...' : 'إرسال'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <CreateOrderDialog
        open={showCreateDialog}
        onClose={() => setShowCreateDialog(false)}
        products={products ?? []}
        onSuccess={() => { utils.orders.list.invalidate(); utils.orders.statusCounts.invalidate(); setShowCreateDialog(false); }}
      />

      <ImportExcelDialog open={showImportDialog} onClose={() => setShowImportDialog(false)} onSuccess={() => utils.orders.list.invalidate()} />
      <ImportWhatsAppDialog open={showWhatsAppImportDialog} onClose={() => setShowWhatsAppImportDialog(false)} onSuccess={() => utils.orders.list.invalidate()} />

      {/* Edit Order Dialog */}
      {/* تعديل الأوردر — نفس المكوّن اللي بتستخدمه شاشة موظف التأكيدات. الفرق بينهم على
          السيرفر بس: الشاشة دي بتعدي على راوتر orders (جلسة إدارية + نطاق النشاط)،
          وشاشة الموظف على employeePortal (كوكي + صلاحية + فحص ملكية الأوردر). */}
      <OrderEditDialog
        open={showEditDialog}
        onOpenChange={open => { setShowEditDialog(open); if (!open) setEditOrderId(null); }}
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
      />

      {/* Return Dialog */}
      <Dialog open={showReturnDialog} onOpenChange={setShowReturnDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>تسجيل مرتجع</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>سبب الإرجاع <span className="text-destructive">*</span></Label>
              <Select value={returnReason} onValueChange={setReturnReason}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="اختر سبب الإرجاع" /></SelectTrigger>
                <SelectContent>{returnReasonOptions.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>ملاحظات إضافية</Label>
              <Textarea value={returnNotes} onChange={e => setReturnNotes(e.target.value)} placeholder="أي تفاصيل إضافية..." className="mt-1" rows={3} />
            </div>
            <div className="flex items-center gap-3 p-3 bg-[var(--success)]/10 border border-[var(--success)]/30 rounded-lg">
              <input type="checkbox" id="restoreStock" checked={returnRestoreStock} onChange={e => setReturnRestoreStock(e.target.checked)}
                className="w-4 h-4 accent-[var(--success)]" />
              <label htmlFor="restoreStock" className="text-sm cursor-pointer">إعادة الكمية للمخزون تلقائياً</label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowReturnDialog(false)}>إلغاء</Button>
            <Button
              variant="destructive"
              disabled={!returnReason || returnMutation.isPending}
              onClick={() => {
                if (!returnOrderId || !returnReason) return;
                returnMutation.mutate({ orderId: returnOrderId, returnReason: returnReason as any, notes: returnNotes || undefined, restoreStock: returnRestoreStock });
              }}
            >
              {returnMutation.isPending ? "جاري التسجيل..." : "تأكيد المرتجع"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Dialog */}
      <Dialog open={showCancelDialog} onOpenChange={setShowCancelDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>إلغاء الأوردر</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>سبب الإلغاء <span className="text-destructive">*</span></Label>
              <Select value={cancelReason} onValueChange={setCancelReason}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="اختر السبب" /></SelectTrigger>
                <SelectContent>{cancelReasonOptions.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label>ملاحظات إضافية</Label>
              <Textarea value={cancelNotes} onChange={e => setCancelNotes(e.target.value)} placeholder="أي تفاصيل إضافية..." className="mt-1" rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCancelDialog(false)}>إلغاء</Button>
            <Button
              variant="destructive"
              disabled={!cancelReason || cancelMutation.isPending}
              onClick={() => {
                if (!selectedOrderId || !cancelReason) return;
                cancelMutation.mutate({ orderId: selectedOrderId, cancelReason: cancelReason as any, notes: cancelNotes || undefined });
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
          <DialogHeader><DialogTitle>تأجيل الأوردر</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>تاريخ المتابعة <span className="text-destructive">*</span></Label>
              <Input type="date" value={postponeDate} onChange={e => setPostponeDate(e.target.value)} className="mt-1" min={new Date().toISOString().split('T')[0]} />
            </div>
            <div>
              <Label>ملاحظات</Label>
              <Textarea value={postponeNotes} onChange={e => setPostponeNotes(e.target.value)} placeholder="سبب التأجيل..." className="mt-1" rows={3} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPostponeDialog(false)}>إلغاء</Button>
            <Button
              disabled={!postponeDate || postponeMutation.isPending}
              onClick={() => {
                if (!selectedOrderId || !postponeDate) return;
                postponeMutation.mutate({ orderId: selectedOrderId, postponedTo: new Date(postponeDate), notes: postponeNotes || undefined });
              }}
            >
              تأكيد التأجيل
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* استبيان "لم يرد" — كام مرة اتصل الموظف بالعميل قبل ما يعلّم الأوردر بالحالة دي */}
      <Dialog open={showNoAnswerDialog} onOpenChange={setShowNoAnswerDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>تسجيل "لم يرد"</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Label>كام مرة اتصلت بالعميل؟</Label>
            <div className="grid grid-cols-4 gap-2">
              {[1, 2, 3, 4].map(n => (
                <Button
                  key={n}
                  type="button"
                  variant={noAnswerCallAttempts === String(n) ? "default" : "outline"}
                  className="h-10"
                  onClick={() => setNoAnswerCallAttempts(String(n))}
                >
                  {n}
                </Button>
              ))}
            </div>
            <Input
              type="number" min={1} max={20} placeholder="أو رقم مختلف..."
              value={noAnswerCallAttempts} onChange={e => setNoAnswerCallAttempts(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNoAnswerDialog(false)}>إلغاء</Button>
            <Button
              disabled={noAnswerMutation.isPending}
              onClick={() => {
                if (!selectedOrderId) return;
                const attempts = noAnswerCallAttempts ? Number(noAnswerCallAttempts) : undefined;
                noAnswerMutation.mutate({ orderId: selectedOrderId, callAttempts: attempts });
              }}
            >
              تأكيد "لم يرد"
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Export Dialog */}
      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {exportType === 'confirmed' ? (<><Download className="h-5 w-5 text-[var(--info)]" /> تصدير الأوردرات المؤكدة</>) : (<><Truck className="h-5 w-5 text-primary" /> تصدير شيت الشحن</>)}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {exportType === 'confirmed' ? 'تصدير الأوردرات المؤكدة كملف Excel مع كل البيانات.' : 'شيت الشحن مقسم حسب الوكيل مع تنسيق شركة الشحن. لن يتم تصدير أوردرات ببيانات ناقصة (بدون هاتف أو عنوان).'}
            </p>
            <div className="bg-muted/50 rounded-lg p-3 space-y-2">
              <Label className="text-sm font-semibold">نطاق أرقام الأوردرات (اختياري)</Label>
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="type-caption">من رقم</Label><Input value={exportFromOrder} onChange={e => setExportFromOrder(e.target.value.replace(/[^0-9]/g, ''))} placeholder="1" className="mt-1" type="number" min="1" dir="ltr" /></div>
                <div><Label className="type-caption">إلى رقم</Label><Input value={exportToOrder} onChange={e => setExportToOrder(e.target.value.replace(/[^0-9]/g, ''))} placeholder="999" className="mt-1" type="number" min="1" dir="ltr" /></div>
              </div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 space-y-2">
              <Label className="text-sm font-semibold">فلتر بالتاريخ (اختياري)</Label>
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="type-caption">من تاريخ</Label><Input type="date" value={exportDateFrom} onChange={e => setExportDateFrom(e.target.value)} className="mt-1" /></div>
                <div><Label className="type-caption">إلى تاريخ</Label><Input type="date" value={exportDateTo} onChange={e => setExportDateTo(e.target.value)} className="mt-1" /></div>
              </div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 space-y-2">
              <Label className="text-sm font-semibold">فلتر بالمحافظة (اختياري)</Label>
              <Select value={exportGovernorate} onValueChange={setExportGovernorate}>
                <SelectTrigger><SelectValue placeholder="كل المحافظات" /></SelectTrigger>
                <SelectContent><SelectItem value="all">كل المحافظات</SelectItem>{GOVERNORATES.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 space-y-2">
              <Label className="text-sm font-semibold">فلتر بالحالة</Label>
              <Select value={exportStatus} onValueChange={setExportStatus}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="confirmed_printed">مؤكد + مطبوع (افتراضي)</SelectItem>
                  <SelectItem value="confirmed">مؤكد فقط</SelectItem>
                  <SelectItem value="printed">مطبوع فقط</SelectItem>
                  <SelectItem value="shipped">تم الشحن</SelectItem>
                  <SelectItem value="all">كل الحالات</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 space-y-2">
              <Label className="text-sm font-semibold">قناة البيع (اختياري)</Label>
              <Select value={exportWebsiteId} onValueChange={setExportWebsiteId}>
                <SelectTrigger><SelectValue placeholder="كل القنوات" /></SelectTrigger>
                <SelectContent><SelectItem value="all">كل القنوات</SelectItem>{salesChannels?.map((ch: any) => <SelectItem key={ch.id} value={String(ch.id)}>{ch.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 space-y-2">
              <Label className="text-sm font-semibold">المجموعة (اختياري)</Label>
              <Select value={exportGroupId} onValueChange={setExportGroupId}>
                <SelectTrigger><SelectValue placeholder="حسب الفلتر الحالي" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">حسب الفلتر الحالي</SelectItem>
                  <SelectItem value="all">كل الأنشطة</SelectItem>
                  <SelectItem value="1">نحاس</SelectItem>
                  <SelectItem value="2">مفروشات وأدوات منزلية</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {selectedOrderIds.length > 0 && (
              <div className="bg-[var(--info)]/10 text-[var(--info)] rounded-lg p-3 text-sm">
                <strong>ملاحظة:</strong> لديك {selectedOrderIds.length} أوردر محدد.
                <Button size="sm" variant="outline" className="text-xs mt-2 flex" onClick={() => {
                  setIsExporting(true);
                  const params = new URLSearchParams();
                  params.set('orderIds', selectedOrderIds.join(','));
                  window.open(`/api/export/${exportType === 'confirmed' ? 'confirmed' : 'shipping'}?${params.toString()}`, '_blank');
                  setIsExporting(false);
                  setShowExportDialog(false);
                }}>
                  تصدير المحددة فقط ({selectedOrderIds.length})
                </Button>
              </div>
            )}
            {exportType === 'shipping' && (
              <div className="bg-[var(--warning)]/10 border border-[var(--warning)]/30 rounded-lg p-2 text-xs text-[var(--warning)]">
                <strong>تنبيه:</strong> الأوردرات التي بها بيانات ناقصة (بدون هاتف / عنوان / محافظة) سيتم تمييزها باللون الأصفر في الشيت. يرجى مراجعتها قبل الإرسال لشركة الشحن.
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setShowExportDialog(false); resetExportFilters(); }}>إلغاء</Button>
            <Button
              disabled={isExporting}
              onClick={() => {
                setIsExporting(true);
                const params = new URLSearchParams();
                if (exportFromOrder) params.set('fromOrder', exportFromOrder);
                if (exportToOrder) params.set('toOrder', exportToOrder);
                if (exportDateFrom) params.set('dateFrom', exportDateFrom);
                if (exportDateTo) params.set('dateTo', exportDateTo);
                if (exportGovernorate && exportGovernorate !== 'all') params.set('governorate', exportGovernorate);
                if (exportWebsiteId && exportWebsiteId !== 'all') params.set('websiteId', exportWebsiteId);
                if (exportStatus === 'confirmed_printed') params.set('statuses', 'confirmed,printed');
                else if (exportStatus === 'all') params.set('statuses', 'new,confirmed,printed,shipped,delivered,preparing');
                else if (exportStatus) params.set('status', exportStatus);
                if (exportGroupId && exportGroupId !== 'all' && exportGroupId !== 'current') params.set('businessGroupId', exportGroupId);
                const url = `/api/export/${exportType === 'confirmed' ? 'confirmed' : 'shipping'}?${params.toString()}`;
                window.open(url, '_blank');
                setIsExporting(false);
                setShowExportDialog(false);
                resetExportFilters();
                toast.success('جاري تحميل الملف...');
              }}
            >
              {isExporting ? 'جاري التصدير...' : (exportType === 'confirmed' ? 'تصدير الأوردرات' : 'تصدير شيت الشحن')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Order Detail Drawer — was a Dialog; a side drawer keeps the table visible behind it
          and matches the pattern used for the row-detail requirement across the redesign. */}
      <Drawer
        open={!!detailOrderId}
        onOpenChange={(open) => { if (!open) setDetailOrderId(null); }}
        width="xl"
        title={
          drawerOrder ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono">#{drawerOrder.easyOrderShortId || drawerOrder.orderNumber}</span>
              <StatusBadge status={drawerOrder.status} kind="order" size="sm" />
              {drawerOrder.needsReview && (
                <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-[var(--purple)] bg-[var(--purple)]/10 border border-[var(--purple)]/30">
                  يحتاج مراجعة
                </span>
              )}
            </span>
          ) : "تفاصيل الأوردر"
        }
        description={drawerOrder?.customerName}
        headerExtra={
          detailIndex >= 0 ? (
            <>
              <span className="hidden text-xs tabular-nums text-muted-foreground sm:inline">
                {(detailIndex + 1).toLocaleString('ar-EG')} / {orders.length.toLocaleString('ar-EG')}
              </span>
              <Button variant="ghost" size="icon" className="h-8 w-8" title="الأوردر السابق (→)"
                disabled={detailIndex <= 0} onClick={() => goToOrderAt(detailIndex - 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon" className="h-8 w-8" title="الأوردر التالي (←)"
                disabled={detailIndex >= orders.length - 1} onClick={() => goToOrderAt(detailIndex + 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
            </>
          ) : undefined
        }
        subHeader={
          drawerOrder ? (
            <div className="flex flex-wrap items-center gap-2">
              {/* تغيير الحالة من جوّه الدرج — من غير ما تقفله وترجع للجدول */}
              <Select
                value={drawerOrder.status}
                onValueChange={(v) => updateStatusMutation.mutate({ id: drawerOrder.id, status: v as any })}
              >
                <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["new", "confirmed", "postponed", "no_answer", "preparing", "shipped", "delivered", "cancelled"].map(v => (
                    <SelectItem key={v} value={v}>{STATUS_LABEL(v)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <WhatsAppButton phone={drawerOrder.customerPhone} size="sm" className="h-9" />
              <Button size="sm" variant="outline" className="h-9 gap-1 border-[var(--info)]/30 text-[var(--info)]"
                onClick={() => { window.location.href = `tel:${drawerOrder.customerPhone}`; }}>
                <PhoneCall className="h-4 w-4" /> اتصال
              </Button>
              {(drawerOrder.status === 'new' || drawerOrder.status === 'postponed') && (
                <>
                  <Button size="sm" className="h-9 gap-1 bg-[var(--success)] text-[var(--success-foreground)] hover:opacity-90"
                    disabled={confirmMutation.isPending}
                    onClick={() => confirmMutation.mutate({ orderId: drawerOrder.id })}>
                    <CheckCircle className="h-4 w-4" /> تأكيد
                  </Button>
                  <Button size="sm" variant="outline" className="h-9 gap-1 border-destructive/30 text-destructive"
                    onClick={() => { setSelectedOrderId(drawerOrder.id); setShowCancelDialog(true); }}>
                    <XCircle className="h-4 w-4" /> إلغاء
                  </Button>
                </>
              )}
            </div>
          ) : undefined
        }
        footer={
          drawerOrder ? (
            <div className="flex w-full gap-2">
              <Button variant="outline" className="flex-1 gap-1"
                onClick={() => { setDetailOrderId(null); navigate(`/order/${drawerOrder.id}`); }}>
                <Eye className="h-4 w-4" /> الصفحة الكاملة
              </Button>
              {isAdmin && (
                <Button variant="outline" className="flex-1 gap-1" disabled={duplicateOrderMutation.isPending}
                  onClick={() => setPendingConfirm({ type: "duplicateOrder", orderId: drawerOrder.id, orderNumber: drawerOrder.orderNumber, customerName: drawerOrder.customerName })}>
                  <Copy className="h-4 w-4" /> تكرار
                </Button>
              )}
              <Button className="flex-1 gap-1" onClick={() => { openEditFor(drawerOrder); setDetailOrderId(null); }}>
                <Edit2 className="h-4 w-4" /> تعديل
              </Button>
            </div>
          ) : null
        }
      >
        {(() => {
          const order = (detailOrder as any) ?? orders.find((o: any) => o.id === detailOrderId);
          if (!order) return <p className="text-muted-foreground text-center py-6">جاري التحميل...</p>;
          return (
            <div className="space-y-4">
              {/* رقم الأوردر وحالته اتشالوا من هنا: الهيدر المثبّت فوق بيعرضهم دايمًا، فكانت
                  نفس المعلومة مرتين وبتاخد أول شاشة كاملة قبل أي تفصيل مفيد. */}
              {order.needsReview && (
                <div className="rounded-lg border border-[var(--purple)]/30 bg-[var(--purple)]/10 p-3">
                  <p className="flex items-center gap-1.5 type-subheading text-[var(--purple)]">
                    <AlertTriangle className="h-4 w-4" /> يحتاج مراجعة
                  </p>
                  {order.reviewReason && <p className="mt-1 type-body text-muted-foreground">{order.reviewReason}</p>}
                </div>
              )}

              <Card>
                <CardHeader className="pb-2 pt-3">
                  <CardTitle className="type-subheading">بيانات العميل</CardTitle>
                  <CardAction className="flex items-center gap-1.5">
                    <WhatsAppButton phone={order.customerPhone} size="sm" />
                    <Button size="sm" variant="outline" className="h-8 gap-1 text-[var(--info)] border-[var(--info)]/30"
                      onClick={() => { window.location.href = `tel:${order.customerPhone}`; }}>
                      <PhoneCall className="h-3.5 w-3.5" /> اتصال
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-muted-foreground">الاسم:</span> <span className="font-semibold">{order.customerName}</span></div>
                  <div><span className="text-muted-foreground">الهاتف:</span> <span className="font-mono font-semibold" dir="ltr">{order.customerPhone}</span></div>
                  {order.customerPhone2 && (
                    <div><span className="text-muted-foreground">هاتف احتياطي:</span> <span className="font-mono font-semibold" dir="ltr">{order.customerPhone2}</span></div>
                  )}
                </CardContent>
              </Card>

              {/* الشحن — كان مفكك: العنوان والمحافظة مع بيانات العميل، ومصاريف الشحن مش
                  معروضة أصلاً، وبوسطة في كارت لوحدها تحت. الثلاثة بيجاوبوا سؤال واحد
                  ("رايح فين وبكام وفين وصل؟") فبقوا كارت واحد. */}
              <Card>
                <CardHeader className="pb-2 pt-3">
                  <CardTitle className="type-subheading">الشحن</CardTitle>
                  {order.bostaShipmentId && (
                    <CardAction>
                      <Button size="sm" variant="outline" className="h-8 gap-1 text-[var(--info)] border-[var(--info)]/30"
                        onClick={() => window.open(`/api/orders/${order.id}/bosta-awb`, "_blank", "noopener,noreferrer")}>
                        <Printer className="h-3.5 w-3.5" /> طباعة AWB
                      </Button>
                    </CardAction>
                  )}
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-muted-foreground">المحافظة:</span> <span className="font-semibold">{order.governorate || '—'}</span></div>
                  <div><span className="text-muted-foreground">المدينة:</span> <span className="font-semibold">{order.city || '—'}</span></div>
                  <div className="col-span-2"><span className="text-muted-foreground">العنوان:</span> <span className="font-semibold">{order.customerAddress || '—'}</span></div>
                  <div>
                    <span className="text-muted-foreground">مصاريف الشحن:</span>{' '}
                    <span className="font-semibold tabular-nums">{Number(order.shippingFees ?? 0).toLocaleString('ar-EG')} ج.م</span>
                  </div>
                  <div><span className="text-muted-foreground">طريقة الدفع:</span> <span className="font-semibold">{order.paymentMethod === 'cod' ? 'دفع عند الاستلام' : (order.paymentMethod || '—')}</span></div>
                  {order.bostaShipmentId && (
                    <>
                      <div className="col-span-2 border-t border-border pt-2">
                        <span className="text-muted-foreground">رقم شحنة بوسطة:</span>{' '}
                        <span className="font-mono font-bold text-[var(--info)]">{order.bostaShipmentId}</span>
                      </div>
                      {order.bostaTrackingNumber && (
                        <div className="col-span-2"><span className="text-muted-foreground">رقم التتبع:</span> <span className="font-mono font-bold text-[var(--info)]">{order.bostaTrackingNumber}</span></div>
                      )}
                      {order.bostaStatus && (
                        <div className="col-span-2"><span className="text-muted-foreground">حالة بوسطة:</span> <span className="font-semibold">{order.bostaStatus}</span></div>
                      )}
                    </>
                  )}
                  {order.bostaLastError && !order.bostaShipmentId && (
                    <div className="col-span-2 rounded-md border border-destructive/20 bg-destructive/10 px-2.5 py-1.5">
                      <span className="text-muted-foreground">فشل الإرسال لبوسطة:</span>{' '}
                      <span className="font-medium text-destructive">{order.bostaLastError}</span>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2 pt-3"><CardTitle className="type-subheading">بيانات المنتج</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-muted-foreground">المنتج:</span> <span className="font-semibold">{order.productName}</span></div>
                  <div><span className="text-muted-foreground">الكمية:</span> <span className="font-semibold">{order.quantity}</span></div>
                  {order.color && <div><span className="text-muted-foreground">اللون:</span> <span className="font-semibold">{order.color}</span></div>}
                  {order.size && <div><span className="text-muted-foreground">المقاس:</span> <span className="font-semibold">{order.size}</span></div>}
                  <div><span className="text-muted-foreground">المبلغ:</span> <span className="font-bold text-primary">{Number(order.totalAmount).toLocaleString('ar-EG')} ج.م</span></div>
                  <div><span className="text-muted-foreground">المصدر:</span> <span className="font-semibold">{sourceOptions.find(option => option.value === order.source)?.label ?? order.source}</span></div>
                  {Array.isArray(order.items) && order.items.length > 0 && (
                    <div className="col-span-2 space-y-1.5 pt-1 border-t border-border">
                      <p className="type-caption">تفاصيل الحفر لكل قطعة:</p>
                      {order.items.map((item: any, idx: number) => (
                        <div key={item.id ?? idx} className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2.5 py-1.5">
                          <span className="font-medium">{item.productName}{item.quantity > 1 ? ` ×${item.quantity}` : ''}</span>
                          <span className="text-[var(--info)] font-semibold">{item.variantName || item.color || item.size || '—'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* الموظف المسؤول — كان سطر مدفون وسط "معلومات إضافية". هو أول سؤال بيتسأل
                  لما أوردر يقف، فبقى كارت واقف لوحده باسم واضح. */}
              <Card>
                <CardHeader className="pb-2 pt-3"><CardTitle className="type-subheading">الموظف المسؤول</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-muted-foreground">موزّع لـ:</span>{' '}
                    <span className="font-semibold">
                      {order.assignedEmployeeId
                        ? (employeeNameById.get(order.assignedEmployeeId) ?? `#${order.assignedEmployeeId}`)
                        : 'غير موزع'}
                    </span>
                  </div>
                  {order.confirmedAt && (
                    <div><span className="text-muted-foreground">أكّده:</span> <span className="font-semibold">{order.confirmedByEmployeeName || 'غير مسجل'}</span></div>
                  )}
                  {order.status === 'no_answer' && order.noAnswerCallAttempts != null && (
                    <div><span className="text-muted-foreground">محاولات الاتصال:</span> <span className="font-semibold tabular-nums">{order.noAnswerCallAttempts}</span></div>
                  )}
                  {order.adName && <div><span className="text-muted-foreground">البيدج:</span> <span className="font-semibold">{order.adName}</span></div>}
                </CardContent>
              </Card>

              {/* سجل الحالات */}
              {(() => {
                const timeline = [
                  ...buildOrderTimeline(
                    order,
                    order.assignedEmployeeId ? employeeNameById.get(order.assignedEmployeeId) : undefined
                  ),
                  ...statusLogEvents(drawerEditHistory),
                ].sort((a, b) => a.at.getTime() - b.at.getTime());
                if (timeline.length === 0) return null;
                return (
                  <Card>
                    <CardHeader className="pb-2 pt-3">
                      <CardTitle className="type-subheading">سجل الحالات</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <ol className="space-y-0">
                        {timeline.map((ev, i) => (
                          <li key={`${ev.label}-${ev.at.getTime()}`} className="flex gap-3">
                            {/* العمود ده هو الخط الزمني: نقطة لكل محطة، وخط واصل بينها ما عدا
                                آخر واحدة عشان الخط ميكملش في الفراغ تحت آخر حدث. */}
                            <div className="flex flex-col items-center">
                              <span
                                className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                                style={{ backgroundColor: ev.tone }}
                              />
                              {i < timeline.length - 1 && <span className="w-px flex-1 bg-border" />}
                            </div>
                            {/* الوقت على الطرف المقابل مش تحت العنوان: بيملا عرض الكارت
                                وبيخلي الأوقات تتقرا كعمود واحد تحت بعضه. */}
                            <div className={`flex min-w-0 flex-1 items-baseline justify-between gap-3 ${i < timeline.length - 1 ? 'pb-3' : ''}`}>
                              <div className="min-w-0">
                                <p className="text-sm font-semibold" style={{ color: ev.tone }}>{ev.label}</p>
                                {ev.detail && <p className="type-caption truncate" title={ev.detail}>{ev.detail}</p>}
                              </div>
                              <p className="type-caption shrink-0 tabular-nums">
                                {ev.at.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })}
                                {' · '}
                                {ev.at.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ol>
                      {order.postponedTo && (
                        <p className="mt-3 rounded-md border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-2.5 py-1.5 text-sm">
                          <span className="text-muted-foreground">مؤجَّل حتى:</span>{' '}
                          <span className="font-semibold text-[var(--warning)]">{new Date(order.postponedTo).toLocaleDateString('ar-EG')}</span>
                        </p>
                      )}
                    </CardContent>
                  </Card>
                );
              })()}

              {(order.notes || order.employeeNotes) && (
                <Card>
                  <CardHeader className="pb-2 pt-3"><CardTitle className="type-subheading">الملاحظات</CardTitle></CardHeader>
                  <CardContent className="space-y-2">
                    {order.notes && (
                      <div>
                        <p className="type-caption mb-1">ملاحظات الأوردر</p>
                        <p className="rounded-lg border border-[var(--success)]/30 bg-[var(--success)]/10 p-3 text-sm">{order.notes}</p>
                      </div>
                    )}
                    {/* employeeNotes كان بيتكتب من بورتال الموظف ومحدش بيشوفه من هنا. */}
                    {order.employeeNotes && (
                      <div>
                        <p className="type-caption mb-1">ملاحظات الموظف</p>
                        <p className="rounded-lg border border-border bg-muted/50 p-3 text-sm">{order.employeeNotes}</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {order.serialNumber && (
                <Card className="border-primary/30 bg-accent/20">
                  <CardHeader className="pb-2 pt-3"><CardTitle className="text-sm text-primary flex items-center gap-2"><QrCode className="h-4 w-4" /> QR Code وكود التجهيز</CardTitle></CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-6">
                      <canvas id={`qr-canvas-${order.id}`} className="border border-primary/30 rounded-lg" />
                      <div className="flex flex-col gap-2">
                        <div>
                          <span className="type-caption">Serial Number</span>
                          <p className="font-mono font-bold text-primary text-lg">{order.serialNumber}</p>
                        </div>
                        <div>
                          <span className="type-caption">حالة التجهيز</span>
                          <p className={`font-bold text-sm mt-0.5 ${order.isPrepared ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>
                            {order.isPrepared ? `✅ تم التجهيز بواسطة ${order.preparedByName || 'موظف'}` : '⏳ لم يتم التجهيز بعد'}
                          </p>
                          {order.preparedAt && <p className="type-caption">{new Date(order.preparedAt).toLocaleString('ar-EG')}</p>}
                        </div>
                      </div>
                    </div>
                    <QRRenderer serialNumber={order.serialNumber} canvasId={`qr-canvas-${order.id}`} />
                  </CardContent>
                </Card>
              )}

              {order.cancelReason && (
                <Card>
                  <CardHeader className="pb-2 pt-3"><CardTitle className="text-sm text-destructive">سبب الإلغاء</CardTitle></CardHeader>
                  <CardContent><p className="text-sm bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-destructive">{order.cancelReason}</p></CardContent>
                </Card>
              )}
            </div>
          );
        })()}
      </Drawer>

      <AssignDialog
        open={showAssignDialog}
        onClose={() => setShowAssignDialog(false)}
        selectedOrderIds={selectedOrderIds}
        employees={employees ?? []}
        onAssign={(empId, filteredIds) => assignMutation.mutate({ orderIds: filteredIds, employeeId: empId })}
        isPending={assignMutation.isPending}
      />
    </div>
  );
}

function CreateOrderDialog({
  open, onClose, products, onSuccess
}: {
  open: boolean;
  onClose: () => void;
  products: any[];
  onSuccess: () => void;
}) {
  const { businesses } = useBusinessContext();
  const [form, setForm] = useState({
    customerName: "", customerPhone: "", customerAddress: "", governorate: "",
    businessId: "", productId: "", quantity: "1", totalAmount: "", source: "", notes: "",
    shippingProviderId: "", shippingType: "", paymentType: "",
  });
  const businessId = Number(form.businessId) || undefined;
  const governorates = trpc.accountingV2.configurationList.useQuery({ businessId: businessId!, namespace: "governorate", activeOnly: true }, { enabled: Boolean(businessId) });
  const shippingTypes = trpc.accountingV2.configurationList.useQuery({ businessId: businessId!, namespace: "shipping_type", activeOnly: true }, { enabled: Boolean(businessId) });
  const paymentTypes = trpc.accountingV2.configurationList.useQuery({ businessId: businessId!, namespace: "payment_type", activeOnly: true }, { enabled: Boolean(businessId) });
  const orderSources = trpc.accountingV2.configurationList.useQuery({ businessId: businessId!, namespace: "order_source", activeOnly: true }, { enabled: Boolean(businessId) });
  const shipping = trpc.accountingV2.shippingConfiguration.useQuery({ businessId: businessId! }, { enabled: Boolean(businessId) });

  const createMutation = trpc.orders.create.useMutation({
    onSuccess: (data) => {
      toast.success(`تم إنشاء الأوردر ${data.orderNumber}`);
      onSuccess();
      setForm({ customerName: "", customerPhone: "", customerAddress: "", governorate: "", businessId: "", productId: "", quantity: "1", totalAmount: "", source: "", notes: "", shippingProviderId: "", shippingType: "", paymentType: "" });
    },
    onError: (e) => toast.error(e.message),
  });

  const selectedProduct = products.find(p => p.id === Number(form.productId));

  const handleProductChange = (productId: string) => {
    const product = products.find(p => p.id === Number(productId));
    setForm(f => ({ ...f, productId, totalAmount: product ? String(Number(product.price) * Number(f.quantity)) : f.totalAmount }));
  };

  const handleQuantityChange = (qty: string) => {
    setForm(f => ({ ...f, quantity: qty, totalAmount: selectedProduct ? String(Number(selectedProduct.price) * Number(qty)) : f.totalAmount }));
  };

  const handleSubmit = () => {
    if (!form.businessId || !form.customerName || !form.customerPhone || !form.customerAddress || !form.governorate || !form.productId || !form.totalAmount || !form.source || !form.shippingProviderId || !form.shippingType || !form.paymentType) {
      toast.error("يرجى ملء جميع الحقول المطلوبة");
      return;
    }
    createMutation.mutate({
      customerName: form.customerName, customerPhone: form.customerPhone, customerAddress: form.customerAddress,
      governorate: form.governorate, productId: Number(form.productId), productName: selectedProduct?.name ?? "",
      quantity: Number(form.quantity), totalAmount: form.totalAmount, source: form.source as any, notes: form.notes || undefined,
      businessId: Number(form.businessId), projectedShippingProviderId: Number(form.shippingProviderId), projectedShippingType: form.shippingType, projectedPaymentType: form.paymentType,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>إضافة أوردر جديد</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div><Label>النشاط <span className="text-destructive">*</span></Label><Select value={form.businessId} onValueChange={businessId => setForm(f => ({ ...f, businessId, governorate: "", shippingProviderId: "", shippingType: "", paymentType: "" }))}><SelectTrigger className="mt-1"><SelectValue placeholder="اختار النشاط" /></SelectTrigger><SelectContent>{businesses.map(business => <SelectItem key={business.id} value={String(business.id)}>{business.name}</SelectItem>)}</SelectContent></Select></div>
          <div>
            <Label>اسم العميل <span className="text-destructive">*</span></Label>
            <Input value={form.customerName} onChange={e => setForm(f => ({ ...f, customerName: e.target.value }))} placeholder="الاسم الكامل" className="mt-1" />
          </div>
          <div>
            <Label>رقم الهاتف <span className="text-destructive">*</span></Label>
            <Input value={form.customerPhone} onChange={e => setForm(f => ({ ...f, customerPhone: e.target.value }))} placeholder="01xxxxxxxxx" className="mt-1" dir="ltr" />
          </div>
          <div className="sm:col-span-2">
            <Label>العنوان <span className="text-destructive">*</span></Label>
            <Input value={form.customerAddress} onChange={e => setForm(f => ({ ...f, customerAddress: e.target.value }))} placeholder="العنوان التفصيلي" className="mt-1" />
          </div>
          <div>
            <Label>المحافظة <span className="text-destructive">*</span></Label>
            <Select value={form.governorate} onValueChange={v => setForm(f => ({ ...f, governorate: v }))}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="اختر المحافظة" /></SelectTrigger>
              <SelectContent>{governorates.data?.map(row => <SelectItem key={row.id} value={row.configKey}>{row.displayName}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div><Label>شركة الشحن <span className="text-destructive">*</span></Label><Select value={form.shippingProviderId} onValueChange={shippingProviderId => setForm(f => ({ ...f, shippingProviderId }))}><SelectTrigger className="mt-1"><SelectValue placeholder="اختار الشركة" /></SelectTrigger><SelectContent>{shipping.data?.providers.map(row => <SelectItem key={row.id} value={String(row.id)}>{row.displayName}</SelectItem>)}</SelectContent></Select></div>
          <div><Label>نوع الشحن <span className="text-destructive">*</span></Label><Select value={form.shippingType} onValueChange={shippingType => setForm(f => ({ ...f, shippingType }))}><SelectTrigger className="mt-1"><SelectValue placeholder="اختار النوع" /></SelectTrigger><SelectContent>{shippingTypes.data?.map(row => <SelectItem key={row.id} value={row.configKey}>{row.displayName}</SelectItem>)}</SelectContent></Select></div>
          <div><Label>نوع الدفع <span className="text-destructive">*</span></Label><Select value={form.paymentType} onValueChange={paymentType => setForm(f => ({ ...f, paymentType }))}><SelectTrigger className="mt-1"><SelectValue placeholder="اختار النوع" /></SelectTrigger><SelectContent>{paymentTypes.data?.map(row => <SelectItem key={row.id} value={row.configKey}>{row.displayName}</SelectItem>)}</SelectContent></Select></div>
          <div>
            <Label>المصدر</Label>
            <Select value={form.source} onValueChange={v => setForm(f => ({ ...f, source: v }))}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>{orderSources.data?.map(row => <SelectItem key={row.id} value={row.configKey}>{row.displayName}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>المنتج <span className="text-destructive">*</span></Label>
            <Select value={form.productId} onValueChange={handleProductChange}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="اختر المنتج" /></SelectTrigger>
              <SelectContent>{products.map(p => <SelectItem key={p.id} value={String(p.id)}>{p.name} - {Number(p.price).toLocaleString('ar-EG')} ج.م</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>الكمية</Label>
            <Input type="number" min="1" value={form.quantity} onChange={e => handleQuantityChange(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>المبلغ الإجمالي <span className="text-destructive">*</span></Label>
            <Input value={form.totalAmount} onChange={e => setForm(f => ({ ...f, totalAmount: e.target.value }))} placeholder="0.00" className="mt-1" dir="ltr" />
          </div>
          <div className="sm:col-span-2">
            <Label>ملاحظات</Label>
            <Textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="أي ملاحظات إضافية..." className="mt-1" rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button onClick={handleSubmit} disabled={createMutation.isPending}>{createMutation.isPending ? "جاري الحفظ..." : "حفظ الأوردر"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** نافذة توزيع الأوردرات مع التحكم في المحافظات */
function AssignDialog({
  open, onClose, selectedOrderIds, employees, onAssign, isPending,
}: {
  open: boolean;
  onClose: () => void;
  selectedOrderIds: number[];
  employees: any[];
  onAssign: (empId: number, filteredIds: number[]) => void;
  isPending: boolean;
}) {
  const [assignEmployeeId, setAssignEmployeeId] = useState("");
  const [govMode, setGovMode] = useState<"all" | "select">("all");
  const [selectedGovs, setSelectedGovs] = useState<string[]>([]);

  const idsKey = useMemo(() => selectedOrderIds, [selectedOrderIds.join(',')]);
  const { data: fetchedOrders = [], isLoading: loadingOrders } = trpc.orders.getByIds.useQuery(
    { ids: idsKey },
    { enabled: open && selectedOrderIds.length > 0 }
  );
  const selectedOrders = fetchedOrders;
  const availableGovs = Array.from(new Set(selectedOrders.map((o: any) => o.governorate).filter(Boolean))).sort() as string[];

  const filteredOrders = govMode === "all" ? selectedOrders : selectedOrders.filter((o: any) => selectedGovs.includes(o.governorate));

  const toggleGov = (gov: string) => {
    setSelectedGovs(prev => prev.includes(gov) ? prev.filter(g => g !== gov) : [...prev, gov]);
  };

  const handleClose = () => {
    setAssignEmployeeId(""); setGovMode("all"); setSelectedGovs([]);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>توزيع الأوردرات على موظف</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div>
            <Label>اختر الموظف <span className="text-destructive">*</span></Label>
            <Select value={assignEmployeeId} onValueChange={setAssignEmployeeId}>
              <SelectTrigger className="mt-1"><SelectValue placeholder="اختر موظف" /></SelectTrigger>
              <SelectContent>{employees.filter(e => e.role === 'agent').map(e => <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          <div>
            <Label className="mb-2 block">المحافظات المراد توزيعها</Label>
            <div className="flex gap-2 mb-2">
              <Button size="sm" variant={govMode === "all" ? "default" : "outline"} onClick={() => setGovMode("all")}>كل المحافظات ({selectedOrders.length})</Button>
              <Button size="sm" variant={govMode === "select" ? "default" : "outline"} onClick={() => setGovMode("select")}>اختر محافظات</Button>
            </div>
            {govMode === "select" && (
              <div className="border rounded-lg p-3 max-h-48 overflow-y-auto space-y-1">
                {availableGovs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">لا توجد محافظات</p>
                ) : (
                  availableGovs.map(gov => {
                    const count = selectedOrders.filter((o: any) => o.governorate === gov).length;
                    const checked = selectedGovs.includes(gov);
                    return (
                      <label key={gov} className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 rounded px-2 py-1">
                        <input type="checkbox" checked={checked} onChange={() => toggleGov(gov)} className="rounded" />
                        <span className="text-sm flex-1">{gov}</span>
                        <Badge variant="secondary" className="text-xs">{count}</Badge>
                      </label>
                    );
                  })
                )}
              </div>
            )}
          </div>

          <div className="bg-muted/50 rounded-lg p-3 text-sm">
            {loadingOrders ? (
              <span className="text-muted-foreground">جاري تحميل الأوردرات...</span>
            ) : (
              <>
                <span className="text-muted-foreground">سيتم توزيع </span>
                <span className="font-semibold">{filteredOrders.length} أوردر</span>
                {govMode === "select" && selectedGovs.length > 0 && <span className="text-muted-foreground"> من محافظات: {selectedGovs.join("، ")}</span>}
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>إلغاء</Button>
          <Button
            disabled={!assignEmployeeId || filteredOrders.length === 0 || isPending}
            onClick={() => { if (!assignEmployeeId) return; onAssign(Number(assignEmployeeId), filteredOrders.map((o: any) => o.id)); }}
          >
            {isPending ? "جاري التوزيع..." : `توزيع ${filteredOrders.length} أوردر`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
