import { useState, useMemo, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
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
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import {
  Plus, Search, CheckCircle, XCircle, Clock, UserPlus, Eye, FileSpreadsheet, Download, Truck,
  Trash2, Printer, Phone, Edit2, RotateCcw, CalendarDays, Copy, PackageCheck, QrCode,
  MoreHorizontal, ListChecks, LayoutGrid, Rows3,
} from "lucide-react";
import QRCodeLib from "qrcode";
import ImportExcelDialog from "@/components/ImportExcelDialog";
import ImportWhatsAppDialog from "@/components/ImportWhatsAppDialog";
import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";
import { useBusinessContext } from "@/contexts/BusinessContext";
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
  toast,
  buildFilterChips,
  countActiveFilters,
  type FilterDescriptor,
} from "@/components/shared";

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

const GOVERNORATES = [
  "القاهرة", "الجيزة", "الإسكندرية", "الدقهلية", "البحر الأحمر", "البحيرة",
  "الفيوم", "الغربية", "الإسماعيلية", "المنوفية", "المنيا", "القليوبية",
  "الوادي الجديد", "السويس", "أسوان", "أسيوط", "بني سويف", "بورسعيد",
  "دمياط", "جنوب سيناء", "كفر الشيخ", "مطروح", "الأقصر", "قنا",
  "شمال سيناء", "الشرقية", "سوهاج"
];

// Kept as the source of truth for source labels: these are the real business names
// ("عتبة" / "فرحات للنحاس") the shared StatusBadge component cannot know about — its
// generic ORDER_SOURCE map is used only for colour, the label always comes from here.
const SOURCE_LABELS: Record<string, string> = {
  easyorder: "Easy Order",
  easyorder_ataba: "ويب سايت عتبه",
  easyorder_farhat: "ويب سايت فرحات للنحاس",
  shopify: "Shopify",
  whatsapp: "واتساب",
  manual: "يدوي",
  facebook: "فيسبوك",
};

const RETURN_REASONS = [
  { value: "customer_refused", label: "رفض العميل" },
  { value: "wrong_product", label: "منتج خاطئ" },
  { value: "damaged", label: "تالف" },
  { value: "wrong_address", label: "عنوان خاطئ" },
  { value: "customer_not_available", label: "العميل غير متاح" },
  { value: "other", label: "أخرى" },
];

const CANCEL_REASONS = [
  { value: "price", label: "السعر" },
  { value: "not_serious", label: "غير جاد" },
  { value: "wrong_number", label: "رقم خاطئ" },
  { value: "duplicate", label: "مكرر" },
];

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
  adName: string; hideAssigned: boolean; dateRange: DateRange;
}>[] = [
  { key: "status", label: "الحالة", format: (v) => STATUS_LABEL(v) },
  { key: "source", label: "المصدر", format: (v) => SOURCE_LABELS[v] ?? v },
  { key: "governorates", label: "المحافظة" },
  { key: "adName", label: "البيدج" },
  { key: "hideAssigned", label: "التوزيع", format: () => "غير الموزعة فقط" },
  {
    key: "dateRange", label: "التاريخ",
    format: (v: DateRange) => {
      const from = v.from ? v.from.toLocaleDateString("ar-EG") : "";
      const to = v.to ? v.to.toLocaleDateString("ar-EG") : "";
      return from && to ? `${from} – ${to}` : from || to;
    },
  },
];

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
  const isAdmin = user?.role === 'admin';
  const { currentBusinessIds } = useBusinessContext();

  const [activeTab, setActiveTab] = useState<'all' | 'today_confirmed'>('all');
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [websiteFilter, setWebsiteFilter] = useState<string>("all");
  const [governorateFilter, setGovernorateFilter] = useState<string[]>([]);
  const [adNameFilter, setAdNameFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });
  const [page, setPage] = useState(1);
  const [density, setDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(new Set());
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

  // Edit order state
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editOrderId, setEditOrderId] = useState<number | null>(null);
  const [editProductName, setEditProductName] = useState("");
  const [editQuantity, setEditQuantity] = useState<number>(1);
  const [editTotalAmount, setEditTotalAmount] = useState<number>(0);
  const [editNotes, setEditNotes] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editSize, setEditSize] = useState("");
  const [editCustomerName, setEditCustomerName] = useState("");
  const [editCustomerPhone, setEditCustomerPhone] = useState("");
  const [editCustomerPhone2, setEditCustomerPhone2] = useState("");
  const [editCustomerAddress, setEditCustomerAddress] = useState("");
  const [editGovernorate, setEditGovernorate] = useState("");
  const [editShippingFees, setEditShippingFees] = useState<number>(0);

  const [hideAssigned, setHideAssigned] = useState(true);
  const [showBostaDialog, setShowBostaDialog] = useState(false);
  const [bostaAllowOpen, setBostaAllowOpen] = useState(true);

  // فلتر تاريخ الطباعة (يظهر عند اختيار حالة مطبوع)
  const [printedDateFilter, setPrintedDateFilter] = useState<'all' | 'today' | 'yesterday' | 'custom'>('today');
  const [printedCustomDate, setPrintedCustomDate] = useState('');

  const printedDateRange = useMemo(() => {
    if (statusFilter !== 'printed') return { from: undefined, to: undefined };
    const now = new Date(Date.now() + 2 * 60 * 60 * 1000); // Cairo offset
    if (printedDateFilter === 'today') {
      const start = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z');
      const end = new Date(now.toISOString().slice(0, 10) + 'T23:59:59Z');
      return { from: start, to: end };
    }
    if (printedDateFilter === 'yesterday') {
      const y = new Date(now);
      y.setUTCDate(y.getUTCDate() - 1);
      const start = new Date(y.toISOString().slice(0, 10) + 'T00:00:00Z');
      const end = new Date(y.toISOString().slice(0, 10) + 'T23:59:59Z');
      return { from: start, to: end };
    }
    if (printedDateFilter === 'custom' && printedCustomDate) {
      const start = new Date(printedCustomDate + 'T00:00:00Z');
      const end = new Date(printedCustomDate + 'T23:59:59Z');
      return { from: start, to: end };
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
    unassignedOnly: hideAssigned ? true : undefined,
    page,
    limit: 100,
    businessIds: currentBusinessIds,
  }), [search, statusFilter, sourceFilter, websiteFilter, governorateFilter, dateRange, printedDateRange, adNameFilter, hideAssigned, page, currentBusinessIds]);

  const { data, isLoading, refetch } = trpc.orders.list.useQuery(queryParams);
  const { data: statusCounts } = trpc.orders.statusCounts.useQuery({ businessIds: currentBusinessIds });
  const confirmedDateParam = useMemo(() => {
    if (confirmedDateFilter === 'yesterday') {
      const y = new Date(Date.now() + 2 * 60 * 60 * 1000); // Cairo
      y.setUTCDate(y.getUTCDate() - 1);
      return y.toISOString().slice(0, 10);
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
  const { data: adNames } = trpc.orders.distinctAdNames.useQuery();
  const { data: employees } = trpc.employees.activeList.useQuery(
    currentBusinessIds && currentBusinessIds.length === 1 ? { businessId: currentBusinessIds[0] } : undefined
  );
  const { data: salesChannels } = trpc.salesChannels.activeList.useQuery(
    currentBusinessIds && currentBusinessIds.length === 1 ? { businessId: currentBusinessIds[0] } : undefined
  );

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
    onSuccess: () => { toast.success("تم تسجيل لم يرد"); utils.orders.list.invalidate(); utils.orders.statusCounts.invalidate(); },
    onError: (e) => toast.error(e.message),
  });

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

  const editOrderMutation = trpc.orders.editOrder.useMutation({
    onSuccess: () => {
      toast.success("✅ تم تعديل الأوردر بنجاح");
      utils.orders.list.invalidate();
      utils.orders.todayConfirmed.invalidate();
      setShowEditDialog(false);
    },
    onError: (e) => toast.error(e.message),
  });

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
  const totalPages = Math.ceil(total / 100);
  // Sequence number shown in the table — fixed to match the actual page size (100); the
  // previous constant (20) desynced the displayed "#" from the real page boundary on any
  // page after the first.
  const seqByOrderId = useMemo(() => {
    const map = new Map<number, number>();
    orders.forEach((o: any, i: number) => map.set(o.id, (page - 1) * 100 + i + 1));
    return map;
  }, [orders, page]);

  const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);

  const toggleOrderSelect = (id: number, index: number, shiftKey: boolean) => {
    if (shiftKey && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const rangeIds = orders.slice(start, end + 1).map((o: any) => o.id);
      setSelectedOrderIds(prev => Array.from(new Set([...prev, ...rangeIds])));
    } else {
      setSelectedOrderIds(prev =>
        prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
      );
    }
    setLastSelectedIndex(index);
  };

  const currentPageIds = orders.map((o: any) => o.id);
  const selectedInCurrentPage = selectedOrderIds.filter(id => currentPageIds.includes(id));
  const allCurrentPageSelected = currentPageIds.length > 0 && selectedInCurrentPage.length === currentPageIds.length;

  const selectAllCurrentPage = () => {
    if (allCurrentPageSelected) {
      setSelectedOrderIds(prev => prev.filter(id => !currentPageIds.includes(id)));
    } else {
      setSelectedOrderIds(prev => Array.from(new Set([...prev, ...currentPageIds])));
    }
  };

  const clearAllSelections = () => setSelectedOrderIds([]);

  const openEditFor = (order: any) => {
    setEditOrderId(order.id);
    setEditProductName(order.productName ?? "");
    setEditQuantity(order.quantity ?? 1);
    setEditTotalAmount(Number(order.totalAmount));
    setEditNotes(order.notes ?? "");
    setEditColor(order.color ?? "");
    setEditSize(order.size ?? "");
    setEditCustomerName(order.customerName ?? "");
    setEditCustomerPhone(order.customerPhone ?? "");
    setEditCustomerPhone2(order.customerPhone2 ?? "");
    setEditCustomerAddress(order.customerAddress ?? "");
    setEditGovernorate(order.governorate ?? "");
    setEditShippingFees(Number(order.shippingFees ?? 0));
    setShowEditDialog(true);
  };

  // ==================== Filter chips (display only — each underlying useState above
  // remains the single source of truth; this object exists purely to describe them) ====
  const filtersSnapshot = {
    status: statusFilter, source: sourceFilter, website: websiteFilter,
    governorates: governorateFilter, adName: adNameFilter, hideAssigned, dateRange,
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
    else if (key === "dateRange") setDateRange({ from: null, to: null });
  };
  const resetAllFilters = () => {
    setPage(1);
    setSearch(""); setStatusFilter("all"); setSourceFilter("all"); setWebsiteFilter("all");
    setGovernorateFilter([]); setAdNameFilter("all"); setHideAssigned(false);
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
  const columns: Column<any>[] = [
    {
      id: "select",
      alwaysVisible: true,
      header: isAdmin ? (
        <input
          type="checkbox"
          checked={allCurrentPageSelected}
          onChange={selectAllCurrentPage}
          className="w-4 h-4 rounded cursor-pointer accent-primary"
          title="تحديد/إلغاء كل الصفحة الحالية"
        />
      ) : null,
      cell: (order) => isAdmin ? (
        <input
          type="checkbox"
          checked={selectedOrderIds.includes(order.id)}
          onChange={(e) => {
            const idx = orders.findIndex((o: any) => o.id === order.id);
            toggleOrderSelect(order.id, idx, e.nativeEvent instanceof MouseEvent ? (e.nativeEvent as MouseEvent).shiftKey : false);
          }}
          onClick={(e) => e.stopPropagation()}
          className="w-4 h-4 rounded cursor-pointer accent-primary"
        />
      ) : null,
      className: "w-10",
    },
    {
      id: "seq", header: "#", alwaysVisible: true,
      cell: (order) => <span className="text-xs text-muted-foreground font-semibold">{seqByOrderId.get(order.id)}</span>,
      className: "text-center w-12",
    },
    {
      id: "identifier", header: "المعرّف", alwaysVisible: true,
      cell: (order) => (
        <div>
          {order.easyOrderShortId ? (
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-sm font-bold px-2 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)]">{order.easyOrderShortId}</span>
              <span className="text-xs text-muted-foreground font-mono">#{order.orderNumber}</span>
            </div>
          ) : (
            <span className="font-mono text-sm font-bold px-2 py-0.5 rounded bg-muted">{order.orderNumber}</span>
          )}
          {order.status === 'new' && <span className="block mt-0.5 text-xs bg-[var(--success)] text-[var(--success-foreground)] px-1.5 py-0.5 rounded-full w-fit">جديد</span>}
          {order.needsReview && (
            <span className="block mt-0.5 text-[10px] font-bold text-[var(--warning)] bg-[var(--warning)]/10 border border-[var(--warning)]/30 rounded px-1.5 py-0.5 w-fit">
              ⚠️ يحتاج مراجعة
            </span>
          )}
          {order.bostaShipmentId && (
            <span className="flex items-center gap-0.5 mt-0.5 text-[10px] bg-[var(--info)] text-white px-1.5 py-0.5 rounded-full w-fit font-bold" title={`شحنة Bosta: ${order.bostaTrackingNumber || order.bostaShipmentId}`}>
              <PackageCheck className="h-2.5 w-2.5" /> بوسطة
            </span>
          )}
          {order.bostaLastError && !order.bostaShipmentId && (
            <div className="mt-0.5 flex flex-col gap-0.5 max-w-[220px]">
              <span className="flex items-center gap-0.5 text-[10px] bg-destructive/10 text-destructive border border-destructive/20 px-1.5 py-0.5 rounded-full w-fit font-bold">
                ⚠️ فشل بوسطة
              </span>
              <span className="text-[10px] leading-tight text-destructive bg-destructive/5 border border-destructive/10 rounded px-1.5 py-0.5 break-words line-clamp-2" title={order.bostaLastError}>
                {order.bostaLastError}
              </span>
            </div>
          )}
        </div>
      ),
    },
    {
      id: "customer", header: "العميل", alwaysVisible: true,
      cell: (order) => (
        <div>
          <p className="font-semibold text-sm">{order.customerName}</p>
          <p className="text-xs text-muted-foreground font-mono" dir="ltr">{order.customerPhone}</p>
        </div>
      ),
    },
    {
      id: "address", header: "العنوان",
      cell: (order) => (
        <div className="max-w-[220px]">
          <p className="text-sm leading-snug break-words line-clamp-2" title={order.customerAddress || order.governorate || undefined}>
            {order.customerAddress || order.governorate || '—'}
          </p>
          {order.customerAddress && order.governorate && (
            <p className="text-xs text-muted-foreground">{order.governorate}</p>
          )}
        </div>
      ),
    },
    {
      id: "total", header: "المبلغ الإجمالي", numeric: true, alwaysVisible: true,
      cell: (order) => <span className="font-bold text-sm">{Number(order.totalAmount).toLocaleString('ar-EG')}</span>,
    },
    {
      id: "status", header: "الحالة", alwaysVisible: true,
      cell: (order) => (
        <div className="flex flex-col gap-1">
          <StatusBadge status={order.status} kind="order" size="sm" />
          {order.status === 'confirmed' && (
            <span className="text-[10px] font-bold text-[var(--warning)] bg-[var(--warning)]/10 border border-[var(--warning)]/30 rounded px-1.5 py-0.5 text-center w-fit">
              لسه مطبعش
            </span>
          )}
        </div>
      ),
    },
    {
      id: "product", header: "المنتج",
      cell: (order) => (
        <div className="max-w-[200px]">
          <p className="text-sm break-words line-clamp-2" title={order.productName}>{order.productName}</p>
          {order.quantity > 1 && <p className="text-xs text-muted-foreground">الكمية: {order.quantity}</p>}
          {(order.color || order.size) && (
            <p className="text-xs text-muted-foreground">
              {order.color && <span>اللون: {order.color}</span>}
              {order.color && order.size && <span> · </span>}
              {order.size && <span>المقاس: {order.size}</span>}
            </p>
          )}
        </div>
      ),
    },
    {
      id: "website", header: "الموقع",
      cell: (order) => order.websiteName ? (
        <span className="inline-block bg-accent text-accent-foreground px-2 py-1 rounded text-xs font-medium">
          {order.websiteName}
        </span>
      ) : <span className="text-muted-foreground">—</span>,
    },
    {
      id: "date", header: "تاريخ الطلب",
      cell: (order) => (
        <div className="text-xs text-muted-foreground whitespace-nowrap">
          <p>{new Date(order.createdAt).toLocaleDateString('ar-EG', { year: 'numeric', month: 'numeric', day: 'numeric' })}</p>
          <p className="text-muted-foreground/70">{new Date(order.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</p>
        </div>
      ),
    },
    {
      id: "actions", header: "إجراءات", alwaysVisible: true, sticky: true,
      cell: (order) => (
        <div className="flex gap-1">
          {(order.status === 'new' || order.status === 'postponed') && (
            <>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-[var(--success)] hover:bg-[var(--success)]/10"
                onClick={() => confirmMutation.mutate({ orderId: order.id })} title="تأكيد">
                <CheckCircle className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-[var(--warning)] hover:bg-[var(--warning)]/10"
                onClick={() => { setSelectedOrderId(order.id); setShowPostponeDialog(true); }} title="تأجيل">
                <Clock className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-[var(--warning)] hover:bg-[var(--warning)]/10"
                onClick={() => noAnswerMutation.mutate({ orderId: order.id })} title="لم يرد">
                <Phone className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
                onClick={() => { setSelectedOrderId(order.id); setShowCancelDialog(true); }} title="إلغاء">
                <XCircle className="h-4 w-4" />
              </Button>
            </>
          )}
          {isAdmin && ['confirmed', 'shipped', 'delivered', 'preparing'].includes(order.status) && (
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
              onClick={() => { setReturnOrderId(order.id); setShowReturnDialog(true); }} title="مرتجع">
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-primary hover:bg-primary/10"
            onClick={() => setDetailOrderId(order.id)} title="تفاصيل الأوردر">
            <Eye className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-[var(--info)] hover:bg-[var(--info)]/10"
            onClick={() => openEditFor(order)} title="تعديل">
            <Edit2 className="h-4 w-4" />
          </Button>
          {isAdmin && (
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-[var(--success)] hover:bg-[var(--success)]/10"
              disabled={duplicateOrderMutation.isPending}
              onClick={() => setPendingConfirm({ type: "duplicateOrder", orderId: order.id, orderNumber: order.orderNumber, customerName: order.customerName })}
              title="تكرار الأوردر">
              <Copy className="h-4 w-4" />
            </Button>
          )}
          {isAdmin && (
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
              onClick={() => setPendingConfirm({ type: "deleteOrder", orderId: order.id, orderNumber: order.orderNumber })}
              title="حذف">
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  const selectedKeysSet = useMemo(() => new Set<string | number>(selectedOrderIds), [selectedOrderIds]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="الأوردرات"
        description={`إجمالي: ${total.toLocaleString('ar-EG')} أوردر`}
        primaryAction={
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="h-4 w-4 ml-1" />
            أوردر جديد
          </Button>
        }
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="gap-1">
                <MoreHorizontal className="h-4 w-4" />
                إجراءات أخرى
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onClick={() => { setExportType('confirmed'); setShowExportDialog(true); }}>
                <Download className="h-4 w-4 ml-2" /> تصدير المؤكدة
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => { setExportType('shipping'); setShowExportDialog(true); }}>
                <Truck className="h-4 w-4 ml-2" /> شيت الشحن
              </DropdownMenuItem>
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
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShowImportDialog(true)}>
                <FileSpreadsheet className="h-4 w-4 ml-2 text-[var(--success)]" /> استيراد Easy Order
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowWhatsAppImportDialog(true)}>
                <svg className="h-4 w-4 ml-2" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" /></svg>
                استيراد واتساب
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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
        {/* Header stat cards — clicking one applies it as a quick filter. */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard label="الكل" value={(statusCounts?.total ?? 0).toLocaleString('ar-EG')}
            active={statusFilter === 'all'} onClick={() => { setStatusFilter('all'); setPage(1); }} />
          <StatCard label="اليوم" value={(statusCounts?.today ?? 0).toLocaleString('ar-EG')} tone="info" />
          <StatCard label="مؤكد" value={(statusCounts?.byStatus?.confirmed ?? 0).toLocaleString('ar-EG')} tone="success"
            active={statusFilter === 'confirmed'} onClick={() => { setStatusFilter('confirmed'); setPage(1); }} />
          <StatCard label="جديد" value={(statusCounts?.byStatus?.new ?? 0).toLocaleString('ar-EG')} tone="primary"
            active={statusFilter === 'new'} onClick={() => { setStatusFilter('new'); setPage(1); }} />
          <StatCard label="يحتاج مراجعة" value={(statusCounts?.needsReview ?? 0).toLocaleString('ar-EG')} tone="warning" />
          <StatCard label="ملغي" value={(statusCounts?.byStatus?.cancelled ?? 0).toLocaleString('ar-EG')} tone="danger"
            active={statusFilter === 'cancelled'} onClick={() => { setStatusFilter('cancelled'); setPage(1); }} />
        </div>
      </PageHeader>

      {/* Tabs */}
      <div className="flex gap-1 bg-muted/50 rounded-xl p-1 w-fit">
        <button
          onClick={() => setActiveTab('all')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
            activeTab === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          كل الأوردرات
        </button>
        <button
          onClick={() => setActiveTab('today_confirmed')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 ${
            activeTab === 'today_confirmed' ? 'bg-[var(--success)] text-[var(--success-foreground)] shadow-sm' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          ✔ مؤكدات اليوم
          {todayConfirmedData && (
            <span className={`text-xs px-1.5 py-0.5 rounded-full font-bold tabular-nums ${
              activeTab === 'today_confirmed' ? 'bg-white/20' : 'bg-[var(--success)]/10 text-[var(--success)]'
            }`}>
              {todayConfirmedData.total}
            </span>
          )}
        </button>
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
              <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
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
        <Card>
          <CardContent className="p-4 space-y-3">
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
              <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(1); }}>
                <SelectTrigger className="w-40 h-10"><SelectValue placeholder="الحالة" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الحالات</SelectItem>
                  {["new", "confirmed", "printed", "postponed", "cancelled", "preparing", "shipped", "delivered", "no_answer", "returned"].map(v => (
                    <SelectItem key={v} value={v}>{STATUS_LABEL(v)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

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
                <SelectTrigger className="w-40 h-10"><SelectValue placeholder="المصدر" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل المصادر</SelectItem>
                  {Object.entries(SOURCE_LABELS).map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                </SelectContent>
              </Select>

              <Select value={websiteFilter} onValueChange={v => { setWebsiteFilter(v); setPage(1); }}>
                <SelectTrigger className="w-44 h-10"><SelectValue placeholder="الموقع" /></SelectTrigger>
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
                className="w-48"
              />

              <Select value={adNameFilter} onValueChange={v => { setAdNameFilter(v); setPage(1); }}>
                <SelectTrigger className="w-44 h-10"><SelectValue placeholder="فلترة حسب اسم البيدج" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل البيدجات</SelectItem>
                  {(adNames ?? []).map(name => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                </SelectContent>
              </Select>

              <Button
                variant={hideAssigned ? "default" : "outline"}
                size="sm"
                className="h-10"
                onClick={() => { setHideAssigned(v => !v); setPage(1); }}
              >
                {hideAssigned ? "غير الموزعة فقط" : "كل الأوردرات"}
              </Button>

              <div className="flex items-center gap-1.5">
                <CalendarDays className="h-4 w-4 text-muted-foreground" />
                <DateRangePicker value={dateRange} onChange={(range) => { setDateRange(range); setPage(1); }} />
              </div>
            </FilterBar>

            {isAdmin && selectedOrderIds.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-border">
                <Badge variant="secondary" className="text-xs px-2 py-1 tabular-nums">
                  محدد: {selectedOrderIds.length} أوردر
                </Badge>
                <Button variant="ghost" size="sm" onClick={clearAllSelections} className="text-muted-foreground text-xs">إلغاء الكل</Button>
                <Button variant="outline" size="sm" onClick={() => setShowAssignDialog(true)}>
                  <UserPlus className="h-4 w-4 ml-1" /> توزيع ({selectedOrderIds.length})
                </Button>
                <Button variant="outline" size="sm" className="border-destructive/30 text-destructive hover:bg-destructive/10"
                  onClick={() => setPendingConfirm({ type: "bulkDelete" })}>
                  <Trash2 className="h-4 w-4 ml-1" /> حذف ({selectedOrderIds.length})
                </Button>
              </div>
            )}
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
        mobileRow={(order: any) => (
          <MobileOrderCard
            orderNumber={order.easyOrderShortId || order.orderNumber}
            customerName={order.customerName}
            customerPhone={order.customerPhone}
            governorate={order.governorate}
            statusBadge={<StatusBadge status={order.status} kind="order" size="sm" />}
            sourceBadge={order.websiteName ? <Badge variant="secondary" className="text-[10px]">{order.websiteName}</Badge> : undefined}
            productSummary={`${order.productName}${order.quantity > 1 ? ` ×${order.quantity}` : ''}`}
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
                <div className="flex flex-wrap gap-1.5">
                  {(order.status === 'new' || order.status === 'postponed') && (
                    <>
                      <Button size="sm" className="h-8 gap-1 bg-[var(--success)] text-[var(--success-foreground)]"
                        onClick={() => confirmMutation.mutate({ orderId: order.id })}>
                        <CheckCircle className="h-3.5 w-3.5" /> تأكيد
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 gap-1 border-[var(--warning)]/40 text-[var(--warning)]"
                        onClick={() => { setSelectedOrderId(order.id); setShowPostponeDialog(true); }}>
                        <Clock className="h-3.5 w-3.5" /> تأجيل
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 gap-1"
                        onClick={() => noAnswerMutation.mutate({ orderId: order.id })}>
                        <Phone className="h-3.5 w-3.5" /> لم يرد
                      </Button>
                      <Button size="sm" variant="outline" className="h-8 gap-1 border-destructive/30 text-destructive"
                        onClick={() => { setSelectedOrderId(order.id); setShowCancelDialog(true); }}>
                        <XCircle className="h-3.5 w-3.5" /> إلغاء
                      </Button>
                    </>
                  )}
                  <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => setDetailOrderId(order.id)}>
                    <Eye className="h-3.5 w-3.5" /> تفاصيل
                  </Button>
                  <Button size="sm" variant="outline" className="h-8 gap-1" onClick={() => openEditFor(order)}>
                    <Edit2 className="h-3.5 w-3.5" /> تعديل
                  </Button>
                </div>
              </div>
            }
          />
        )}
      />

      {activeTab === 'all' && totalPages > 1 && (
        <Pagination page={page} pageSize={100} total={total} onPageChange={setPage} />
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
            <Button size="sm" variant="ghost" className="h-8 px-3 text-red-400 hover:bg-background/20 text-xs font-medium"
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
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>تعديل بيانات الأوردر</DialogTitle></DialogHeader>
          <div className="space-y-5">
            <div className="bg-accent/40 border border-border rounded-lg p-4 space-y-3">
              <h4 className="font-semibold text-sm">بيانات العميل</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>اسم العميل</Label>
                  <Input value={editCustomerName} onChange={e => setEditCustomerName(e.target.value)} placeholder="اسم العميل الكامل" className="mt-1" />
                </div>
                <div>
                  <Label>رقم الهاتف</Label>
                  <Input value={editCustomerPhone} onChange={e => setEditCustomerPhone(e.target.value)} placeholder="01xxxxxxxxx" className="mt-1" dir="ltr" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>رقم هاتف بديل</Label>
                  <Input value={editCustomerPhone2} onChange={e => setEditCustomerPhone2(e.target.value)} placeholder="اختياري" className="mt-1" dir="ltr" />
                </div>
                <div>
                  <Label>المحافظة</Label>
                  <Select value={editGovernorate} onValueChange={setEditGovernorate}>
                    <SelectTrigger className="mt-1"><SelectValue placeholder="اختر المحافظة" /></SelectTrigger>
                    <SelectContent>{GOVERNORATES.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label>العنوان التفصيلي</Label>
                <Input value={editCustomerAddress} onChange={e => setEditCustomerAddress(e.target.value)} placeholder="الشارع، المنطقة، الحي..." className="mt-1" />
              </div>
            </div>

            <div className="bg-[var(--warning)]/10 border border-[var(--warning)]/30 rounded-lg p-4 space-y-3">
              <h4 className="font-semibold text-sm text-[var(--warning)]">بيانات المنتج</h4>
              <div>
                <Label>اسم المنتج</Label>
                <Input value={editProductName} onChange={e => setEditProductName(e.target.value)} placeholder="اسم المنتج..." className="mt-1" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>الكمية <span className="text-destructive">*</span></Label>
                  <Input type="number" min={1} value={editQuantity} onChange={e => setEditQuantity(Number(e.target.value))} className="mt-1" />
                </div>
                <div>
                  <Label>المبلغ الإجمالي</Label>
                  <Input type="number" min={0} value={editTotalAmount} onChange={e => setEditTotalAmount(Number(e.target.value))} className="mt-1" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>اللون</Label>
                  <Input value={editColor} onChange={e => setEditColor(e.target.value)} placeholder="مثلاً: أسود، ذهبي..." className="mt-1" />
                </div>
                <div>
                  <Label>المقاس</Label>
                  <Input value={editSize} onChange={e => setEditSize(e.target.value)} placeholder="مثلاً: L, XL, 120×200..." className="mt-1" />
                </div>
              </div>
              <div>
                <Label>رسوم الشحن</Label>
                <Input type="number" min={0} value={editShippingFees} onChange={e => setEditShippingFees(Number(e.target.value))} className="mt-1" />
              </div>
            </div>

            <div>
              <Label>ملاحظات</Label>
              <Textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} placeholder="ملاحظات إضافية..." className="mt-1" rows={2} />
            </div>
            <p className="text-xs text-muted-foreground bg-[var(--warning)]/10 border border-[var(--warning)]/30 rounded p-2">
              ⚠️ لو كان الأوردر مؤكد، سيتم تعديل الجرد تلقائياً
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>رجوع</Button>
            <Button
              disabled={editQuantity < 1 || editOrderMutation.isPending}
              onClick={() => {
                if (!editOrderId) return;
                editOrderMutation.mutate({
                  orderId: editOrderId, quantity: editQuantity, totalAmount: editTotalAmount, shippingFees: editShippingFees,
                  productName: editProductName || undefined, notes: editNotes || undefined,
                  color: editColor || null, size: editSize || null,
                  customerName: editCustomerName || undefined, customerPhone: editCustomerPhone || undefined,
                  customerPhone2: editCustomerPhone2 || undefined, customerAddress: editCustomerAddress || undefined,
                  governorate: editGovernorate || undefined,
                });
              }}
            >
              {editOrderMutation.isPending ? "جاري الحفظ..." : "حفظ التعديل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Return Dialog */}
      <Dialog open={showReturnDialog} onOpenChange={setShowReturnDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>تسجيل مرتجع</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>سبب الإرجاع <span className="text-destructive">*</span></Label>
              <Select value={returnReason} onValueChange={setReturnReason}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="اختر سبب الإرجاع" /></SelectTrigger>
                <SelectContent>{RETURN_REASONS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
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
                <SelectContent>{CANCEL_REASONS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}</SelectContent>
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
                <div><Label className="text-xs text-muted-foreground">من رقم</Label><Input value={exportFromOrder} onChange={e => setExportFromOrder(e.target.value.replace(/[^0-9]/g, ''))} placeholder="1" className="mt-1" type="number" min="1" dir="ltr" /></div>
                <div><Label className="text-xs text-muted-foreground">إلى رقم</Label><Input value={exportToOrder} onChange={e => setExportToOrder(e.target.value.replace(/[^0-9]/g, ''))} placeholder="999" className="mt-1" type="number" min="1" dir="ltr" /></div>
              </div>
            </div>
            <div className="bg-muted/50 rounded-lg p-3 space-y-2">
              <Label className="text-sm font-semibold">فلتر بالتاريخ (اختياري)</Label>
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">من تاريخ</Label><Input type="date" value={exportDateFrom} onChange={e => setExportDateFrom(e.target.value)} className="mt-1" /></div>
                <div><Label className="text-xs text-muted-foreground">إلى تاريخ</Label><Input type="date" value={exportDateTo} onChange={e => setExportDateTo(e.target.value)} className="mt-1" /></div>
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
        title="تفاصيل الأوردر"
        width="lg"
        footer={(() => {
          const order = orders.find((o: any) => o.id === detailOrderId);
          if (!order) return null;
          return (
            <div className="flex w-full gap-2">
              {isAdmin && (
                <Button variant="outline" className="flex-1 gap-1" disabled={duplicateOrderMutation.isPending}
                  onClick={() => setPendingConfirm({ type: "duplicateOrder", orderId: order.id, orderNumber: order.orderNumber, customerName: order.customerName })}>
                  <Copy className="h-4 w-4" /> تكرار
                </Button>
              )}
              <Button className="flex-1 gap-1" onClick={() => { openEditFor(order); setDetailOrderId(null); }}>
                <Edit2 className="h-4 w-4" /> تعديل
              </Button>
            </div>
          );
        })()}
      >
        {(() => {
          const order = orders.find((o: any) => o.id === detailOrderId);
          if (!order) return <p className="text-muted-foreground text-center py-6">جاري التحميل...</p>;
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground">رقم الأوردر</p>
                  <p className="font-bold text-lg">{order.orderNumber}</p>
                  {order.easyOrderShortId && <p className="text-xs text-[var(--warning)] font-mono">EO: {order.easyOrderShortId}</p>}
                </div>
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground">الحالة</p>
                  <StatusBadge status={order.status} kind="order" className="mt-1" />
                </div>
              </div>

              {order.needsReview && (
                <div className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-3 text-sm">
                  <p className="font-semibold text-[var(--warning)]">⚠️ يحتاج مراجعة</p>
                  {order.reviewReason && <p className="text-muted-foreground mt-1">{order.reviewReason}</p>}
                </div>
              )}

              <Card>
                <CardHeader className="pb-2 pt-3"><CardTitle className="text-sm text-muted-foreground">بيانات العميل</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-muted-foreground">الاسم:</span> <span className="font-semibold">{order.customerName}</span></div>
                  <div><span className="text-muted-foreground">الهاتف:</span> <span className="font-mono font-semibold" dir="ltr">{order.customerPhone}</span></div>
                  <div className="col-span-2"><span className="text-muted-foreground">العنوان:</span> <span className="font-semibold">{order.customerAddress || '—'}</span></div>
                  <div><span className="text-muted-foreground">المحافظة:</span> <span className="font-semibold">{order.governorate || '—'}</span></div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2 pt-3"><CardTitle className="text-sm text-muted-foreground">بيانات المنتج</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-muted-foreground">المنتج:</span> <span className="font-semibold">{order.productName}</span></div>
                  <div><span className="text-muted-foreground">الكمية:</span> <span className="font-semibold">{order.quantity}</span></div>
                  {order.color && <div><span className="text-muted-foreground">اللون:</span> <span className="font-semibold">{order.color}</span></div>}
                  {order.size && <div><span className="text-muted-foreground">المقاس:</span> <span className="font-semibold">{order.size}</span></div>}
                  <div><span className="text-muted-foreground">المبلغ:</span> <span className="font-bold text-primary">{Number(order.totalAmount).toLocaleString('ar-EG')} ج.م</span></div>
                  <div><span className="text-muted-foreground">المصدر:</span> <span className="font-semibold">{SOURCE_LABELS[order.source] || order.source}</span></div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2 pt-3"><CardTitle className="text-sm text-muted-foreground">معلومات إضافية</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-muted-foreground">تاريخ الإنشاء:</span> <span className="font-semibold">{new Date(order.createdAt).toLocaleString('ar-EG')}</span></div>
                  {order.confirmedAt && <div><span className="text-muted-foreground">تاريخ التأكيد:</span> <span className="font-semibold">{new Date(order.confirmedAt).toLocaleString('ar-EG')}</span></div>}
                  {order.adName && <div><span className="text-muted-foreground">البيدج:</span> <span className="font-semibold">{order.adName}</span></div>}
                  {order.assignedEmployeeId && <div><span className="text-muted-foreground">موزع لموظف:</span> <span className="font-semibold">#{order.assignedEmployeeId}</span></div>}
                  {order.assignedAt && <div><span className="text-muted-foreground">تاريخ التوزيع:</span> <span className="font-semibold">{new Date(order.assignedAt).toLocaleString('ar-EG')}</span></div>}
                </CardContent>
              </Card>

              {order.notes && (
                <Card>
                  <CardHeader className="pb-2 pt-3"><CardTitle className="text-sm text-muted-foreground">ملاحظات</CardTitle></CardHeader>
                  <CardContent><p className="text-sm bg-[var(--success)]/10 border border-[var(--success)]/30 rounded-lg p-3">{order.notes}</p></CardContent>
                </Card>
              )}

              {(order.bostaShipmentId || order.bostaLastError) && (
                <Card className={order.bostaShipmentId ? "border-[var(--info)]/30 bg-[var(--info)]/5" : "border-destructive/30 bg-destructive/5"}>
                  <CardHeader className="pb-2 pt-3">
                    <CardTitle className="text-sm flex items-center gap-1.5">
                      <PackageCheck className={`h-4 w-4 ${order.bostaShipmentId ? 'text-[var(--info)]' : 'text-destructive'}`} />
                      <span className={order.bostaShipmentId ? 'text-[var(--info)]' : 'text-destructive'}>
                        {order.bostaShipmentId ? 'تم الإرسال لـ بوسطة' : 'خطأ بوسطة'}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="grid grid-cols-2 gap-3 text-sm">
                    {order.bostaShipmentId && <div className="col-span-2"><span className="text-muted-foreground">رقم الشحنة:</span> <span className="font-mono font-bold text-[var(--info)]">{order.bostaShipmentId}</span></div>}
                    {order.bostaTrackingNumber && <div className="col-span-2"><span className="text-muted-foreground">رقم التتبع:</span> <span className="font-mono font-bold text-[var(--info)]">{order.bostaTrackingNumber}</span></div>}
                    {order.bostaSentAt && <div className="col-span-2"><span className="text-muted-foreground">تاريخ الإرسال:</span> <span className="font-semibold">{new Date(order.bostaSentAt).toLocaleString('ar-EG')}</span></div>}
                    {order.bostaLastError && !order.bostaShipmentId && <div className="col-span-2"><span className="text-muted-foreground">سبب الخطأ:</span> <span className="text-destructive font-medium">{order.bostaLastError}</span></div>}
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
                          <span className="text-xs text-muted-foreground">Serial Number</span>
                          <p className="font-mono font-bold text-primary text-lg">{order.serialNumber}</p>
                        </div>
                        <div>
                          <span className="text-xs text-muted-foreground">حالة التجهيز</span>
                          <p className={`font-bold text-sm mt-0.5 ${order.isPrepared ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>
                            {order.isPrepared ? `✅ تم التجهيز بواسطة ${order.preparedByName || 'موظف'}` : '⏳ لم يتم التجهيز بعد'}
                          </p>
                          {order.preparedAt && <p className="text-xs text-muted-foreground">{new Date(order.preparedAt).toLocaleString('ar-EG')}</p>}
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
  const [form, setForm] = useState({
    customerName: "", customerPhone: "", customerAddress: "", governorate: "",
    productId: "", quantity: "1", totalAmount: "", source: "manual", notes: "",
  });

  const createMutation = trpc.orders.create.useMutation({
    onSuccess: (data) => {
      toast.success(`تم إنشاء الأوردر ${data.orderNumber}`);
      onSuccess();
      setForm({ customerName: "", customerPhone: "", customerAddress: "", governorate: "", productId: "", quantity: "1", totalAmount: "", source: "manual", notes: "" });
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
    if (!form.customerName || !form.customerPhone || !form.customerAddress || !form.governorate || !form.productId || !form.totalAmount) {
      toast.error("يرجى ملء جميع الحقول المطلوبة");
      return;
    }
    createMutation.mutate({
      customerName: form.customerName, customerPhone: form.customerPhone, customerAddress: form.customerAddress,
      governorate: form.governorate, productId: Number(form.productId), productName: selectedProduct?.name ?? "",
      quantity: Number(form.quantity), totalAmount: form.totalAmount, source: form.source as any, notes: form.notes || undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>إضافة أوردر جديد</DialogTitle></DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              <SelectContent>{GOVERNORATES.map(g => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label>المصدر</Label>
            <Select value={form.source} onValueChange={v => setForm(f => ({ ...f, source: v }))}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="manual">يدوي</SelectItem>
                <SelectItem value="easyorder">Easy Order</SelectItem>
                <SelectItem value="easyorder_ataba">ويب سايت عتبه</SelectItem>
                <SelectItem value="easyorder_farhat">ويب سايت فرحات للنحاس</SelectItem>
                <SelectItem value="shopify">Shopify</SelectItem>
                <SelectItem value="whatsapp">واتساب</SelectItem>
                <SelectItem value="facebook">فيسبوك</SelectItem>
              </SelectContent>
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
