import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { MessagesEntryButton } from "@/components/messaging/MessagesEntryButton";
import { PortalHeaderActions } from "@/components/shell/PortalHeaderActions";
import { operationIdFor } from "@/lib/operationId";
import { useOperationalOptions } from "@/hooks/useOperationalOptions";
import { useGovernorateOptions } from "@/hooks/useGovernorateOptions";
import { usePermission } from "@/hooks/usePermission";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/textarea";
import {
  CheckCircle2, XCircle, Clock, Phone, PhoneOff, MapPin, Package,
  RefreshCw, ChevronDown, ChevronUp,
  ShoppingBag, AlertCircle, MessageSquare, Box, Save, Truck, Edit2, CalendarDays, Filter, CalendarRange, QrCode, Camera, CameraOff, Hash, CheckCircle, Megaphone, History } from "lucide-react";
import jsQR from "jsqr";
import { BusinessAvatar } from "@/components/BusinessAvatar";
import { useBusinessContext } from "@/contexts/BusinessContext";
import {
  StatCard, ConfirmDialog, WhatsAppButton, SectionCard, StatusBadge, ResponsiveDataTable,
  SearchInput, EmptyState, ErrorState, LoadingSkeleton, OfflineState, type Column,
} from "@/components/shared";
import { ChevronRight, ChevronLeft } from "lucide-react";
import { getMissingConfirmationFields } from "@/lib/orderConfirmationValidation";
import { EMPLOYEE_SETTABLE_ORDER_STATUSES } from "@shared/const";
import {
  OrderEditDialog, isValidEgyptianMobile,
  type OrderEditSavePayload,
} from "@/components/orders/OrderEditDialog";

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  new:       { label: "جديد",         color: "text-primary",            bg: "bg-accent border-primary/30" },
  confirmed: { label: "مؤكد",         color: "text-[var(--success)]",   bg: "bg-[var(--success)]/10 border-[var(--success)]/30" },
  postponed: { label: "مؤجل",         color: "text-[var(--warning)]",   bg: "bg-[var(--warning)]/10 border-[var(--warning)]/30" },
  cancelled: { label: "ملغي",         color: "text-destructive",        bg: "bg-destructive/10 border-destructive/30" },
  preparing: { label: "جاري التجهيز", color: "text-primary",            bg: "bg-accent border-primary/30" },
  shipped:   { label: "تم الشحن",     color: "text-primary",            bg: "bg-accent border-primary/30" },
  delivered: { label: "تم التسليم",   color: "text-[var(--success)]",   bg: "bg-[var(--success)]/10 border-[var(--success)]/30" },
  no_answer: { label: "لم يرد",       color: "text-[var(--warning)]",   bg: "bg-[var(--warning)]/10 border-[var(--warning)]/30" },
};

/**
 * نفس القائمة اللي الـprocedure على السيرفر بيبني منها الـz.enum — مستوردة مش متكتوبة
 * تاني، عشان مايبقاش ممكن نزوّد حالة في الواجهة والحد الأمني مايعرفش عنها حاجة.
 * الاستيراد نوعي وقت التصريف بس (القيمة ثوابت نصية)، فمفيش كود سيرفر بيتحزم للمتصفح.
 */
const EMPLOYEE_EDITABLE_STATUSES: readonly string[] = EMPLOYEE_SETTABLE_ORDER_STATUSES;

const STATUS_SELECT_LABELS: Record<string, string> = {
  new: "جديد", confirmed: "مؤكد", postponed: "مؤجل", cancelled: "لاغي",
};

type Order = {
  id: number;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  governorate: string;
  productName: string;
  quantity: number;
  totalAmount: string;
  status: string;
  source?: string | null;
  notes?: string | null;
  postponedTo?: Date | null;
  isDuplicate?: boolean;
  createdAt?: string | null;
  /** Set when an order arrived with items that could not be mapped to the catalog. */
  needsReview?: boolean | null;
  reviewReason?: string | null;
};

/**
 * Standard cancellation reasons, used when the business has not configured its own.
 * Kept short and mutually exclusive — a reason list people scroll is a reason list people
 * stop reading, and the whole point is that the number in the cancelled column means something.
 */
const DEFAULT_CANCEL_REASONS = [
  "العميل غيّر رأيه",
  "السعر غالي",
  "طلب بالخطأ",
  "مش متاح للتوصيل في منطقته",
  "المنتج مش متوفر",
  "أوردر مكرر",
  "رقم غلط أو مش موجود",
  "العميل مش بيرد",
] as const;

/** Sentinel for the free-text option. Not a stored value — the typed text is what's saved. */
const OTHER_CANCEL_REASON = "__other__";

/**
 * «أمس» بتوقيت القاهرة (UTC+2) كـYYYY-MM-DD — نفس الحساب اللي كان مكتوب مرتين جوه زرار
 * «أمس» (مرة للضغط ومرة لتمييزه نشط)، اتجمع في مكان واحد بدون أي تغيير في النتيجة.
 */
function cairoYesterdayISO(): string {
  const yesterday = new Date(Date.now() + 2*60*60*1000);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return yesterday.toISOString().slice(0, 10);
}

export default function EmployeeDashboard() {
  // Governorates the business curated, if any. When the list is empty — which it was for
  // every business, nobody having filled the table in — GovernorateCitySelect falls back to
  // the full national list from shared/egyptLocations.ts instead of rendering nothing.
  const governorateOptions = useGovernorateOptions();
  const canEditItems = usePermission("orders.edit_items");
  const configuredGovernorates = governorateOptions.values;
  const cancelReasonOptions = useOperationalOptions("cancellation_reason").options;
  const sourceOptions = useOperationalOptions("order_source").options;
  const [, setLocation] = useLocation();
  // حالة الاتصال من المتصفح — لعرض OfflineState بدل خطأ غامض (ليست استعلام tRPC).
  const online = useOnlineStatus();
  const [activeTab, setActiveTab] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expandedOrder, setExpandedOrder] = useState<number | null>(null);

  // Action dialogs
  const [postponeDialog, setPostponeDialog] = useState<{ open: boolean; orderId: number | null }>({ open: false, orderId: null });
  const [cancelDialog, setCancelDialog] = useState<{ open: boolean; orderId: number | null }>({ open: false, orderId: null });
  // استبيان "لم يرد": كام مرة اتصل الموظف قبل ما يعلّم الحالة — نفس نمط حواري الإلغاء والتأجيل.
  const [noAnswerDialog, setNoAnswerDialog] = useState<{ open: boolean; orderId: number | null }>({ open: false, orderId: null });
  const [noAnswerAttempts, setNoAnswerAttempts] = useState("");
  const [postponeDate, setPostponeDate] = useState("");
  const [postponeNotes, setPostponeNotes] = useState("");
  const [cancelReason, setCancelReason] = useState<string>("");
  const [cancelNotes, setCancelNotes] = useState("");
  /** Which order has a status write in flight — scopes the busy state to one card. */
  const [busyOrderId, setBusyOrderId] = useState<number | null>(null);
  /** Free text behind the "سبب آخر" option — kept apart so switching back to a preset
   *  does not smuggle the typed text into the saved reason. */
  const [cancelOtherReason, setCancelOtherReason] = useState("");

  // Notes editing state
  const [editingNotes, setEditingNotes] = useState<Record<number, string>>({});
  const [showStockPanel, setShowStockPanel] = useState(false);

  // Confirmation for marking/unmarking an order as a duplicate — previously fired on a
  // single click with no confirmation at all.
  const [duplicateConfirm, setDuplicateConfirm] = useState<{ orderId: number; action: "mark" | "unmark" } | null>(null);

  // Date filter state
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
  const [showDateFilter, setShowDateFilter] = useState(false);

  // Business group filter state (نحاس / مفروشات)
  const [selectedGroupId, setSelectedGroupId] = useState<number | undefined>(undefined);

  // Edit order state
  // `data` = الصف الكامل اللي فُتح منه التعديل — بيتخزّن وقت الفتح عشان الهيدر ميعتمدش على
  // إعادة البحث في `ordersData.orders` (شوف editingOrder تحت). نفس إصلاح صفحة Orders.
  const [editDialog, setEditDialog] = useState<{ open: boolean; orderId: number | null; data: any | null }>({ open: false, orderId: null, data: null });
  const [showEditHistory, setShowEditHistory] = useState(false);

  // Tasks state
  const [showTasksPanel, setShowTasksPanel] = useState(false);

  // QR Scan state
  const [showScanPanel, setShowScanPanel] = useState(false);
  const [scanIsScanning, setScanIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<any>(null);
  const [manualSerial, setManualSerial] = useState("");
  const [scanCameraError, setScanCameraError] = useState<string | null>(null);
  const scanVideoRef = useRef<HTMLVideoElement | null>(null);
  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scanStreamRef = useRef<MediaStream | null>(null);
  const scanAnimRef = useRef<number | null>(null);
  const scanActiveRef = useRef(false);

  // Check employee session
  const empSession = (() => {
    try { return JSON.parse(localStorage.getItem("employee_session") || "null"); } catch { return null; }
  })();

  useEffect(() => {
    if (!empSession) setLocation("/employee-login");
  }, [empSession]);

  const utils = trpc.useUtils();
  // روابط الشحن بتظهر بس لما **هوية البوابة** معاها `shipping_ops.view` (بتجاوزات الشركة) — نفس مصدر
  // حارس السيرفر employeePortal.todayShipments/shippingRoutes. الإخفاء مش أمان: السيرفر هو الحارس.
  // تتحدّث مع زر التحديث، والرجوع من صفحة المنع، وكل دقيقة.
  const { data: portalPermissions } = trpc.employeePortal.myPermissions.useQuery(undefined, {
    retry: false,
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });
  const canViewShipping = (portalPermissions ?? []).includes("shipping_ops.view");
  // «أدائي» يظهر فقط والسجل مفعّل وهوية البوابة معها view_self — العلم معطل = لا تغيير في الشاشة.
  const { data: performanceStatus } = trpc.performance.status.useQuery(undefined, { retry: false, staleTime: 5 * 60 * 1000 });
  const canViewMyPerformance = performanceStatus?.enabled === true && (portalPermissions ?? []).includes("employee_performance.view_self");
  // «حضوري» بنفس القاعدة: الحضور مفعّل + هوية البوابة معها clock_self أو view_self.
  const { data: attendanceStatus } = trpc.attendance.status.useQuery(undefined, { retry: false, staleTime: 5 * 60 * 1000 });
  const canOpenMyAttendance = attendanceStatus?.enabled === true && (portalPermissions ?? []).some(p => p === "attendance.clock_self" || p === "attendance.view_self");

  const { data: meData, error: meError } = trpc.employeePortal.me.useQuery(undefined, {
    retry: false,
  });

  useEffect(() => {
    if (meError) {
      localStorage.removeItem("employee_session");
      setLocation("/employee-login");
    }
  }, [meError]);

  // Fetch business groups for filter
  const { data: groupsData = [] } = trpc.businesses.groupsWithBusinesses.useQuery();

  // Compute businessIds for selected group
  const selectedBusinessIds = useMemo(() => {
    if (!selectedGroupId) return undefined;
    const group = groupsData.find((g: any) => g.id === selectedGroupId);
    return group ? group.businesses.map((b: any) => b.id) : undefined;
  }, [selectedGroupId, groupsData]);

  const {
    data: statsData,
    isLoading: statsLoading,
    isError: statsIsError,
    refetch: refetchStats,
  } = trpc.employeePortal.stats.useQuery(
    selectedBusinessIds ? { businessIds: selectedBusinessIds } : undefined
  );

  // Broadcast message from manager
  const {
    data: broadcastData,
    isError: broadcastIsError,
    refetch: refetchBroadcast,
  } = trpc.employeePortal.activeBroadcast.useQuery(
    undefined,
    { refetchInterval: 30000 } // تحديث كل 30 ثانية
  );

  // عرض المخزون وقائمة المنتجات (مفلتر حسب المجموعة المختارة)
  const {
    data: stockData,
    isLoading: stockLoading,
    isError: stockIsError,
    refetch: refetchStock,
  } = trpc.employeePortal.stockLevels.useQuery(
    selectedBusinessIds ? { businessIds: selectedBusinessIds } : undefined
  );
  const { data: productsList } = trpc.employeePortal.stockLevels.useQuery(
    selectedBusinessIds ? { businessIds: selectedBusinessIds } : undefined
  );
  // variants للمنتجات (كفر مرتبة بمقاساتها وأسعارها)
  const {
    data: stockVariants,
    isLoading: stockVariantsLoading,
    isError: stockVariantsIsError,
    refetch: refetchStockVariants,
  } = trpc.employeePortal.stockVariants.useQuery(
    selectedBusinessIds ? { businessIds: selectedBusinessIds } : undefined
  );

  // The order's real lines, loaded only while the edit dialog is open for that order.
  const {
    data: orderItemsData,
    isLoading: orderItemsLoading,
    error: orderItemsError,
  } = trpc.employeePortal.orderItems.useQuery(
    { orderId: editDialog.orderId ?? 0 },
    { enabled: editDialog.open && editDialog.orderId != null, retry: false }
  );

  // Build query params with optional date filter + business group filter
  const dateFilterParams = useMemo(() => {
    const params: { status?: string; limit: number; dateFrom?: Date; dateTo?: Date; businessIds?: number[] } = {
      // needs_review is a flag, not a status — fetch unfiltered and narrow client-side
      status: activeTab === "all" || activeTab === "needs_review" ? undefined : activeTab,
      limit: 200,
    };
    if (dateFrom) params.dateFrom = new Date(dateFrom + 'T00:00:00');
    if (dateTo) params.dateTo = new Date(dateTo + 'T23:59:59');
    if (selectedBusinessIds) params.businessIds = selectedBusinessIds;
    return params;
  }, [activeTab, dateFrom, dateTo, selectedBusinessIds]);

  const {
    data: ordersData,
    isLoading,
    refetch,
    isError: ordersIsError,
    isFetching: ordersFetching,
  } = trpc.employeePortal.myOrders.useQuery(
    dateFilterParams,
    { refetchInterval: 60000 }
  );

  // حساب الإحصائيات من الأوردرات المعروضة فعلياً (تتوافق مع فلتر التاريخ)
  const computedStats = useMemo(() => {
    const all = ordersData?.orders ?? [];
    return {
      total: all.length,
      new: all.filter(o => o.status === 'new').length,
      confirmed: all.filter(o => o.status === 'confirmed').length,
      postponed: all.filter(o => o.status === 'postponed').length,
      cancelled: all.filter(o => o.status === 'cancelled').length,
      no_answer: all.filter(o => o.status === 'no_answer').length,
    };
  }, [ordersData]);

  // استخدم الإحصائيات المحسوبة لو فيه فلتر تاريخ، وإلا استخدم stats من السيرفر
  const displayStats = (dateFrom || dateTo) ? computedStats : (statsData ?? computedStats);

  const confirmMutation = trpc.employeePortal.confirm.useMutation({
    onSuccess: (r) => {
      toast.success(r?.message ?? "تم تأكيد الأوردر");
      utils.employeePortal.myOrders.invalidate();
      utils.employeePortal.stats.invalidate();
      // الخصم حصل على السيرفر — الكتالوج/المخزون المعروض لازم يتحدّث فورًا (مفيش cache قديم).
      utils.facebookEntry.catalog.invalidate();
      utils.variants.invalidate();
      utils.products.invalidate();
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setBusyOrderId(null),
  });

  const postponeMutation = trpc.employeePortal.postpone.useMutation({
    onSuccess: () => {
      toast.success("تم تأجيل الأوردر");
      setPostponeDialog({ open: false, orderId: null });
      setPostponeDate(""); setPostponeNotes("");
      utils.employeePortal.myOrders.invalidate();
      utils.employeePortal.stats.invalidate();
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setBusyOrderId(null),
  });

  const cancelMutation = trpc.employeePortal.cancel.useMutation({
    onSuccess: () => {
      toast.success("تم إلغاء الأوردر");
      setCancelDialog({ open: false, orderId: null });
      setCancelReason(""); setCancelNotes(""); setCancelOtherReason("");
      utils.employeePortal.myOrders.invalidate();
      utils.employeePortal.stats.invalidate();
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setBusyOrderId(null),
  });

  const noAnswerMutation = trpc.employeePortal.markNoAnswer.useMutation({
    onSuccess: () => {
      toast.success("تم تسجيل لم يرد");
      setNoAnswerDialog({ open: false, orderId: null });
      setNoAnswerAttempts("");
      utils.employeePortal.myOrders.invalidate();
      utils.employeePortal.stats.invalidate();
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setBusyOrderId(null),
  });

  const openNoAnswerDialog = (orderId: number) => {
    // Deliberately does NOT mark the row busy — opening a dialog is not a write, and
    // marking it here left the marker stranded when the employee backed out.
    setNoAnswerAttempts("");
    setNoAnswerDialog({ open: true, orderId });
  };

  const updateStatusMutation = trpc.employeePortal.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("تم تغيير الحالة");
      utils.employeePortal.myOrders.invalidate();
      utils.employeePortal.stats.invalidate();
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setBusyOrderId(null),
  });

  /**
   * قائمة تغيير الحالة على الكارت.
   *
   * "إلغاء" و"تأجيل" محتاجين مدخلات إضافية (سبب / تاريخ) — فبيفتحوا نفس الديالوجات
   * الموجودة بدل ما نبعت للسيرفر طلب ناقص يترفض. "جديد" و"مؤكد" مالهمش مدخلات فبيروحوا
   * على طول.
   */
  function handleStatusSelect(order: any, next: string) {
    if (next === order.status) return;
    // The dropdown writes the same `orders.status` the four buttons do, so it needs the
    // same in-flight guard — otherwise picking a status and then tapping a button races,
    // and the order lands on whichever reply comes back last.
    if (statusWriteInFlight) return;
    if (next === "cancelled") {
      setCancelDialog({ open: true, orderId: order.id });
      setCancelReason(""); setCancelNotes(""); setCancelOtherReason("");
      return;
    }
    if (next === "postponed") {
      setPostponeDialog({ open: true, orderId: order.id });
      setPostponeDate(""); setPostponeNotes("");
      return;
    }
    if (next === "confirmed") {
      // نفس التحقق اللي بيمنع تأكيد أوردر ناقص بياناته من زرار "تأكيد".
      const missing = getMissingConfirmationFields(order);
      if (missing.length > 0) {
        toast.error(`لا يمكن التأكيد — بيانات ناقصة: ${missing.join("، ")}`);
        return;
      }
    }
    setBusyOrderId(order.id);
    updateStatusMutation.mutate({ orderId: order.id, status: next as any, operationId: operationIdFor(`status:${order.id}:${next}`) });
  }

  const updateNotesMutation = trpc.employeePortal.updateNotes.useMutation({
    onSuccess: () => {
      toast.success("تم حفظ الملاحظة");
      utils.employeePortal.myOrders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // Two mutations, one Save button. The header fields (customer, address, notes) and the
  // basket live in different tables and have different guards, so they cannot be one call —
  // but the employee must not have to know that. saveEdit() below sequences them and only
  // closes the dialog once both have landed.
  //
  // Neither handler closes the dialog on its own: a failed save has to leave the typed
  // values on screen, otherwise the employee loses the call they just made.
  const editOrderMutation = trpc.employeePortal.editOrder.useMutation({
    onError: e => toast.error(e.message),
  });

  const editItemsMutation = trpc.employeePortal.editOrderItems.useMutation({
    onError: e => toast.error(e.message),
  });

  const editSaving = editOrderMutation.isPending || editItemsMutation.isPending;

  const markDuplicateMutation = trpc.employeePortal.markDuplicate.useMutation({
    onSuccess: () => {
      toast.success("تم تعليم الأوردر كمكرر");
      utils.employeePortal.myOrders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const unmarkDuplicateMutation = trpc.employeePortal.unmarkDuplicate.useMutation({
    onSuccess: () => {
      toast.success("تم إلغاء تعليم التكرار");
      utils.employeePortal.myOrders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  // QR Scan mutation
  const scanMutation = trpc.employeePortal.scan.useMutation({
    onSuccess: (data: any) => {
      setScanResult(data);
      if (data.success) {
        toast.success("تم تجهيز الأوردر بنجاح!");
      } else if (data.result === "duplicate") {
        toast.warning("هذا الأوردر تم تجهيزه من قبل");
      } else if (data.result === "cancelled") {
        toast.error("هذا الأوردر ملغي");
      } else {
        toast.error("QR غير صحيح");
      }
    },
    onError: (e) => toast.error(e.message),
  });

  const handleScan = (serialNumber: string) => {
    if (!serialNumber.trim() || scanMutation.isPending) return;
    const deviceInfo = navigator.userAgent.substring(0, 200);
    scanMutation.mutate({ serialNumber: serialNumber.trim(), deviceInfo });
  };

  const startScanCamera = async () => {
    setScanCameraError(null);
    try {
      // iOS Safari requires simpler constraints first, then upgrade
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
      } catch {
        // Fallback: simpler constraints for older iOS
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
      }

      scanStreamRef.current = stream;

      const video = scanVideoRef.current;
      if (video) {
        video.srcObject = stream;
        // iOS Safari requires these attributes set before play
        video.setAttribute("playsinline", "true");
        video.setAttribute("autoplay", "true");
        video.setAttribute("muted", "true");
        video.muted = true;
        video.playsInline = true;

        // Wait for video metadata to load before playing
        await new Promise<void>((resolve) => {
          const onLoaded = () => {
            video.removeEventListener("loadedmetadata", onLoaded);
            resolve();
          };
          video.addEventListener("loadedmetadata", onLoaded);
          // Timeout fallback in case event doesn't fire
          setTimeout(() => resolve(), 2000);
        });

        try {
          await video.play();
        } catch (playErr) {
          console.warn("Video play failed, retrying:", playErr);
          // iOS sometimes needs a small delay
          await new Promise(r => setTimeout(r, 300));
          await video.play();
        }
      }

      setScanIsScanning(true);
      scanActiveRef.current = true;

      const scanFrame = () => {
        if (!scanActiveRef.current || !scanVideoRef.current || !scanCanvasRef.current) return;

        const vid = scanVideoRef.current;
        const canvas = scanCanvasRef.current;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        if (vid.readyState >= vid.HAVE_CURRENT_DATA && ctx && vid.videoWidth > 0) {
          canvas.width = vid.videoWidth;
          canvas.height = vid.videoHeight;
          ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);

          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "dontInvert",
          });

          if (code && code.data) {
            stopScanCamera();
            handleScan(code.data);
            return;
          }
        }

        scanAnimRef.current = requestAnimationFrame(scanFrame);
      };

      // Wait for video to actually render frames
      setTimeout(() => {
        if (scanActiveRef.current) {
          scanFrame();
        }
      }, 800);

    } catch (err: any) {
      console.error("Camera error:", err);
      setScanIsScanning(false);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setScanCameraError("تم رفض إذن الكاميرا. يرجى السماح بالوصول للكاميرا من إعدادات المتصفح.");
        toast.error("يرجى السماح للتطبيق باستخدام الكاميرا");
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
        setScanCameraError("لم يتم العثور على كاميرا.");
        toast.error("لم يتم العثور على كاميرا");
      } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
        setScanCameraError("الكاميرا مستخدمة من تطبيق آخر. أغلق التطبيقات الأخرى وحاول مرة أخرى.");
        toast.error("الكاميرا مستخدمة من تطبيق آخر");
      } else {
        setScanCameraError("تعذر فتح الكاميرا: " + (err?.message || "خطأ غير معروف"));
        toast.error("تعذر فتح الكاميرا");
      }
    }
  };

  const stopScanCamera = () => {
    scanActiveRef.current = false;
    if (scanAnimRef.current) {
      cancelAnimationFrame(scanAnimRef.current);
      scanAnimRef.current = null;
    }
    if (scanStreamRef.current) {
      scanStreamRef.current.getTracks().forEach(track => track.stop());
      scanStreamRef.current = null;
    }
    if (scanVideoRef.current) {
      scanVideoRef.current.srcObject = null;
    }
    setScanIsScanning(false);
  };

  // Cleanup camera on unmount
  useEffect(() => {
    return () => {
      scanActiveRef.current = false;
      if (scanAnimRef.current) cancelAnimationFrame(scanAnimRef.current);
      if (scanStreamRef.current) {
        scanStreamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  const handleManualScanSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualSerial.trim()) return;
    handleScan(manualSerial);
    setManualSerial("");
  };

  const handleSaveNotes = (orderId: number) => {
    const notes = editingNotes[orderId];
    if (notes === undefined) return;
    updateNotesMutation.mutate({ orderId, notes });
    setEditingNotes(prev => { const n = { ...prev }; delete n[orderId]; return n; });
  };

  function openEditDialogFor(order: any) {
    setEditDialog({ open: true, orderId: order.id, data: order });
    setShowEditHistory(false);
  }

  /**
   * Two mutations, one Save button. The header fields and the basket live in different
   * tables with different guards, so they cannot be one call — but the employee must not
   * have to know that. Items go first: it is the call that can be refused outright (stock
   * already out) and the one that rewrites totalAmount, so running it second would leave
   * the header saved and the basket rejected, which reads as a successful save.
   *
   * Throwing is how the dialog learns to stay open with the typed values intact.
   */
  async function saveEdit(payload: OrderEditSavePayload) {
    const { orderId, header, headerDirty, items, itemsDirty, shippingFees } = payload;
    if (itemsDirty) {
      await editItemsMutation.mutateAsync({
        orderId,
        items: items.map(l => ({
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
        // Sent unconditionally, not `|| undefined`: an employee who deletes a stale note
        // means it, and `undefined` would silently keep the old text.
        notes: header.notes,
        employeeNotes: header.employeeNotes,
        // shippingFees only when the items call did not already write it.
        ...(itemsDirty ? {} : { shippingFees }),
      });
    }
    toast.success("تم حفظ التعديلات");
    utils.employeePortal.myOrders.invalidate();
    utils.employeePortal.stats.invalidate();
    utils.employeePortal.orderItems.invalidate({ orderId });
  }

  const handleLogout = async () => {
    await fetch("/api/employee/logout", { method: "POST", credentials: "include" });
    localStorage.removeItem("employee_session");
    setLocation("/employee-login");
  };

  const handlePostpone = () => {
    if (postponeMutation.isPending) return; // double-submit guard
    if (!postponeDate) { toast.error("يرجى تحديد تاريخ التأجيل"); return; }
    if (!postponeDialog.orderId) return;
    setBusyOrderId(postponeDialog.orderId);
    postponeMutation.mutate({
      orderId: postponeDialog.orderId,
      postponedTo: new Date(postponeDate),
      notes: postponeNotes || undefined,
      operationId: operationIdFor(`postpone:${postponeDialog.orderId}`),
    });
  };

  // Reasons the business configured, falling back to the standard set. Same failure the
  // governorate dropdown had: the configuration table was empty, so the list rendered with
  // no options and — because a reason is mandatory — cancelling was impossible.
  const cancelReasons = useMemo(() => {
    const configured = cancelReasonOptions.filter(o => o.value && o.label);
    return configured.length > 0
      ? configured
      : DEFAULT_CANCEL_REASONS.map(r => ({ value: r, label: r }));
  }, [cancelReasonOptions]);

  const cancelReasonIsOther = cancelReason === OTHER_CANCEL_REASON;
  const cancelReasonResolved = cancelReasonIsOther
    ? cancelOtherReason.trim()
    : cancelReason;

  const handleCancel = () => {
    if (cancelMutation.isPending) return; // double-submit guard
    if (!cancelReason) { toast.error("اختر سبب الإلغاء"); return; }
    if (cancelReasonIsOther && !cancelOtherReason.trim()) {
      toast.error("اكتب سبب الإلغاء");
      return;
    }
    if (!cancelDialog.orderId) return;
    setBusyOrderId(cancelDialog.orderId);
    cancelMutation.mutate({
      // The server column is 80 chars; a typed reason has to fit or the write fails.
      cancelReason: cancelReasonResolved.slice(0, 80),
      orderId: cancelDialog.orderId,
      notes: cancelNotes || undefined,
      operationId: operationIdFor(`cancel:${cancelDialog.orderId}`),
    });
  };

  const reviewCount = (ordersData?.orders ?? []).filter((o: any) => o.needsReview).length;

  /** The order the edit dialog is open on — the dialog reads its opening values from this. */
  const editingOrder =
    editDialog.data ??
    (ordersData?.orders ?? []).find((o: any) => o.id === editDialog.orderId) ??
    null;

  const filteredOrders = (ordersData?.orders ?? []).filter((o: any) => {
    if (activeTab === "needs_review" && !o.needsReview) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      o.customerName.toLowerCase().includes(q) ||
      o.customerPhone.includes(q) ||
      o.orderNumber.toLowerCase().includes(q) ||
      o.governorate.toLowerCase().includes(q)
    );
  });

  const tabs = [
    { key: "all",       label: "الكل",    count: displayStats?.total ?? 0 },
    { key: "new",       label: "جديد",    count: displayStats?.new ?? 0 },
    { key: "postponed", label: "مؤجل",    count: displayStats?.postponed ?? 0 },
    { key: "confirmed", label: "مؤكد",    count: displayStats?.confirmed ?? 0 },
    { key: "no_answer", label: "لم يرد",  count: displayStats?.no_answer ?? 0 },
    { key: "cancelled", label: "ملغي",    count: displayStats?.cancelled ?? 0 },
    { key: "needs_review", label: "تحتاج مراجعة", count: reviewCount },
  ];

  const employeeName = meData?.name ?? empSession?.name ?? "الموظف";
  // نشاط الموظف — بيتحدد تلقائيًا من `businesses.activeList` (نطاق الجلسة على السيرفر).
  const { activeBusiness } = useBusinessContext();

  // "المتبقي" = الأوردرات اللي لسه محتاجة إجراء من الموظف. مؤكد/ملغي خلصوا، فمش بيتحسبوا.
  // ده الرقم الوحيد اللي بيقول للموظف "فاضلك كام" — كان مش معروض في أي مكان.
  const remainingCount =
    (displayStats?.new ?? 0) + (displayStats?.postponed ?? 0) + (displayStats?.no_answer ?? 0);

  // ==================== Confirmation validation ====================
  // Blocks تأكيد with a clear reason instead of letting an order through with data the
  // confirmation call cannot act on (no phone to call, no address to ship to, ...).
  function handleConfirmOrder(order: any) {
    if (statusWriteInFlight) return; // double-tap guard
    const missing = getMissingConfirmationFields(order);
    if (missing.length > 0) {
      toast.error(`لا يمكن التأكيد — بيانات ناقصة: ${missing.join("، ")}`);
      return;
    }
    setBusyOrderId(order.id);
    confirmMutation.mutate({ orderId: order.id, operationId: operationIdFor(`confirm:${order.id}`) });
  }

  /**
   * True while any status-changing call is in flight. Every one of these writes the same
   * `orders.status`, so letting two race means the order lands on whichever reply arrives
   * last — an order the employee cancelled coming back as confirmed.
   */
  const statusWriteInFlight =
    confirmMutation.isPending ||
    cancelMutation.isPending ||
    postponeMutation.isPending ||
    noAnswerMutation.isPending ||
    updateStatusMutation.isPending;

  // ==================== Next / previous navigation within the expanded order ====================
  const expandedIndex = filteredOrders.findIndex(o => o.id === expandedOrder);
  const goToAdjacentOrder = (direction: 1 | -1) => {
    if (expandedIndex === -1 || filteredOrders.length === 0) return;
    const nextIndex = (expandedIndex + direction + filteredOrders.length) % filteredOrders.length;
    setExpandedOrder(filteredOrders[nextIndex].id);
  };

  // ==================== Keyboard shortcuts ====================
  // C confirm · N no answer · P postpone · X cancel · E edit — act on the expanded order,
  // and only when no dialog is open and focus isn't inside a text field (so typing a note
  // doesn't accidentally trigger an action).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (typing) return;
      if (postponeDialog.open || cancelDialog.open || editDialog.open) return;
      const order = filteredOrders.find(o => o.id === expandedOrder);
      if (!order) return;
      const canAct = order.status === "new" || order.status === "postponed" || order.status === "no_answer";
      if (!canAct) return;

      switch (e.key.toLowerCase()) {
        case "c":
          handleConfirmOrder(order);
          break;
        case "n":
          openNoAnswerDialog(order.id);
          break;
        case "p":
          setPostponeDialog({ open: true, orderId: order.id });
          setPostponeDate(""); setPostponeNotes("");
          break;
        case "x":
          setCancelDialog({ open: true, orderId: order.id });
          setCancelReason(""); setCancelNotes(""); setCancelOtherReason("");
          break;
        case "e":
          openEditDialogFor(order);
          break;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expandedOrder, filteredOrders, postponeDialog.open, cancelDialog.open, editDialog.open]);

  // ==================== Postpone quick presets ====================
  // The date field is day-granular (postponedTo has no time-of-day input here), so presets
  // resolve to the nearest meaningful DAY rather than inventing a time the form can't
  // actually record. "اليوم"/"مساء اليوم" both mean "later today"; "غدًا" means tomorrow.
  function applyPostponePreset(preset: "today" | "tomorrow") {
    const d = new Date();
    if (preset === "tomorrow") d.setDate(d.getDate() + 1);
    setPostponeDate(d.toISOString().split("T")[0]);
  }

  // ==================== View-only derived state (no new data) ====================
  // The tiles read server stats unless a date filter is on (or server stats failed), in which
  // case they are counted from the loaded orders — so "loading" follows whichever source is shown.
  const statsTilesLoading = (dateFrom || dateTo)
    ? isLoading
    : (statsLoading || (!statsData && isLoading));
  const statsFallbackActive = !(dateFrom || dateTo) && statsIsError && !statsData;
  const stockPanelLoading = stockLoading || stockVariantsLoading;
  const stockPanelError = stockIsError || stockVariantsIsError;
  const retryStock = () => { refetchStock(); refetchStockVariants(); };

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      {/* Header */}
      <header
        className="sticky top-0 z-40 shadow-[var(--shadow-card)]"
        style={{ background: "linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%)" }}
      >
        {/* صفّين على الموبايل، صف واحد من sm فوق: ٦ أيقونات أدوات + تحديث + خروج
            كانوا بيخنقوا الاسم لـ٤٢px على شاشة ٣٧٥ — بقى "سارة ..." وخلاص. */}
        <div className="mx-auto flex max-w-2xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 lg:max-w-6xl">
          <div className="flex min-w-0 items-center gap-3">
            {/* هوية نشاط الموظف (من نطاق الجلسة على السيرفر — نشاطه بس) */}
            <BusinessAvatar name={activeBusiness?.name} logoUrl={activeBusiness?.logoUrl} className="w-9 h-9" />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold leading-tight text-primary-foreground">
                {employeeName}
                {activeBusiness && <span className="mr-1.5 text-xs font-normal text-primary-foreground/75" data-testid="employee-business-name">· {activeBusiness.name}</span>}
              </p>
              {/* "فاضلك كام" — أهم رقم في شاشة التأكيدات، وكان مش معروض في أي مكان.
                  مكانه جنب الاسم عشان يتشاف من غير ما الموظف ينزل بصره. */}
              <p className="text-xs text-primary-foreground/75">
                {remainingCount > 0
                  ? <>متبقّي <span className="font-bold tabular-nums text-primary-foreground">{remainingCount.toLocaleString('ar-EG')}</span> طلب</>
                  : 'خلصت كل الطلبات'}
              </p>
            </div>
          </div>
          {/* الأفعال عبر المكوّن المشترك: صف واحد على الهاتف (المثبّت + الرسائل + «المزيد» + الخروج)، والكل ظاهر من 640px.
              نفس الأفعال والصلاحيات والمنطق — لا شيء حُذف. */}
          <PortalHeaderActions
            messages={<MessagesEntryButton via="portal" className="bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/20 md:h-8 md:min-h-8 md:w-8 md:min-w-8" />}
            onLogout={handleLogout}
            messagesBefore={canOpenMyAttendance ? "attendance" : canViewMyPerformance ? "performance" : "refresh"}
            actions={[
              ...(canViewShipping ? [
                { key: "shipments", label: "شحنات اليوم", icon: Truck, onSelect: () => setLocation("/today-shipments") },
                { key: "schedule", label: "جدول توزيع المحافظات", icon: CalendarRange, onSelect: () => setLocation("/shipping-schedule") },
              ] : []),
              { key: "date", label: "فلتر التاريخ", icon: CalendarDays, pinned: true, pressed: Boolean(dateFrom || dateTo), onSelect: () => setShowDateFilter(!showDateFilter) },
              { key: "scan", label: "مسح QR", icon: QrCode, pinned: true, pressed: showScanPanel, onSelect: () => { setShowScanPanel(!showScanPanel); if (showScanPanel) stopScanCamera(); setScanResult(null); } },
              { key: "tasks", label: "المهام", icon: MessageSquare, pressed: showTasksPanel, onSelect: () => setShowTasksPanel(!showTasksPanel) },
              { key: "stock", label: "المخزون", icon: Box, pressed: showStockPanel, onSelect: () => setShowStockPanel(!showStockPanel) },
              ...(canOpenMyAttendance ? [{ key: "attendance", label: "حضوري", icon: Clock, onSelect: () => setLocation("/my-attendance"), testId: "my-attendance-link" }] : []),
              ...(canViewMyPerformance ? [{ key: "performance", label: "أدائي", icon: History, onSelect: () => setLocation("/my-performance"), testId: "my-performance-link" }] : []),
              { key: "refresh", label: "تحديث القائمة", icon: RefreshCw, textFromSm: "تحديث", separatorBefore: true, onSelect: () => { refetch(); utils.employeePortal.myPermissions.invalidate(); } },
            ]}
          />
        </div>
      </header>

      {/* الصفحة كانت محبوسة في max-w-2xl على كل المقاسات — على الديسكتوب كانت عمود
          ضيّق وسط شاشة فاضية. mobile-first زي ما هي، بس بتتوسّع بدل ما تتجمّد. */}
      <main className="mx-auto max-w-2xl space-y-4 px-4 py-4 lg:max-w-6xl">
        {/* انقطاع الاتصال: حالة واضحة فوق القائمة. الأوردرات المحمّلة تفضل ظاهرة تحتها
            عشان الموظف اللي في نص مكالمة مايخسرش بيانات العميل اللي قدامه. */}
        {!online && (
          <OfflineState onRetry={() => refetch()} retrying={ordersFetching} className="py-6" />
        )}

        {/* Business Group Filter - نحاس / مفروشات */}
        {groupsData.length > 0 && (
          <div className="flex gap-2" role="group" aria-label="القسم">
            <Button
              className="min-h-11 md:min-h-9 flex-1 font-bold"
              variant={!selectedGroupId ? "default" : "outline"}
              aria-pressed={!selectedGroupId}
              onClick={() => setSelectedGroupId(undefined)}
            >
              كل الأقسام
            </Button>
            {groupsData.map((group: any) => (
              <Button
                className="min-h-11 md:min-h-9 flex-1 font-bold"
                key={group.id}
                variant={selectedGroupId === group.id ? "default" : "outline"}
                aria-pressed={selectedGroupId === group.id}
                onClick={() => setSelectedGroupId(group.id)}
              >
                {group.name}
              </Button>
            ))}
          </div>
        )}

        {/* Stock Panel - مخزون شامل بالمنتجات والمقاسات والأسعار */}
        {showStockPanel && (
          <SectionCard
            testId="employee-stock-panel"
            icon={<Box className="h-4 w-4 text-primary" aria-hidden="true" />}
            title={
              <>
                جرد المخزون
                {selectedGroupId && (
                  <span className="rounded-[var(--radius-brand-pill)] bg-accent px-2 py-0.5 text-xs font-normal text-accent-foreground">
                    {groupsData.find((g: any) => g.id === selectedGroupId)?.name || ''}
                  </span>
                )}
              </>
            }
            action={
              <Button
                className="min-h-11 min-w-11 md:min-h-9 md:min-w-9"
                variant="ghost"
                size="icon"
                aria-label="إغلاق المخزون"
                onClick={() => setShowStockPanel(false)}
              >
                <XCircle className="h-4 w-4" />
              </Button>
            }
          >
            <div className="space-y-4">
              {stockPanelError ? (
                <ErrorState title="تعذّر تحميل المخزون" message="تحقّق من الاتصال ثم أعد المحاولة." onRetry={retryStock} />
              ) : stockPanelLoading ? (
                <LoadingSkeleton variant="cards" rows={4} />
              ) : (
                <>
                  {/* منتجات بدون variants (أساور نحاس) */}
                  {stockData && stockData.length > 0 && (
                    <div>
                      <p className="mb-2 text-xs font-semibold text-muted-foreground">الأصناف</p>
                      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-4">
                        {stockData.map((p: any) => {
                          const isLow = p.currentStock <= p.minStockLevel;
                          return (
                            <div
                              key={p.id}
                              className={`rounded-[var(--radius-brand-md)] border p-3 ${
                                isLow ? 'border-destructive/30 bg-destructive/10' : 'border-border bg-muted/50'
                              }`}
                            >
                              <p className="truncate text-xs text-muted-foreground" title={p.name}>{p.name}</p>
                              <p className={`mt-0.5 text-lg font-bold tabular-nums ${
                                isLow ? 'text-destructive' : 'text-foreground'
                              }`}>
                                {p.currentStock} <span className="text-xs font-normal text-muted-foreground">قطعة</span>
                              </p>
                              <p className="mt-0.5 text-xs text-muted-foreground">سعر: {Number(p.price).toLocaleString('ar-EG')} ج.م</p>
                              {isLow && (
                                <StatusBadge className="mt-1" status="low" kind="stock" tone="danger" label="مخزون منخفض" size="sm" />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* variants المنتجات (كفر مرتبة بمقاساتها وأسعارها) */}
                  {stockVariants && stockVariants.length > 0 && (() => {
                    // تجميع variants حسب المنتج
                    const grouped: Record<string, { productName: string; variants: any[] }> = {};
                    for (const v of stockVariants as any[]) {
                      const key = String(v.productId);
                      if (!grouped[key]) grouped[key] = { productName: v.productName || `منتج #${v.productId}`, variants: [] };
                      grouped[key].variants.push(v);
                    }
                    return (
                      <div>
                        <p className="mb-2 text-xs font-semibold text-muted-foreground">المقاسات والألوان</p>
                        {Object.entries(grouped).map(([productId, group]) => (
                          <div key={productId} className="mb-3">
                            <p className="mb-2 flex items-center gap-2 text-sm font-bold text-foreground">
                              <Package className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                              {group.productName}
                              <span className="text-xs font-normal text-muted-foreground">
                                (إجمالي: {group.variants.reduce((s: number, v: any) => s + v.currentStock, 0)} قطعة)
                              </span>
                            </p>
                            <ResponsiveDataTable
                              rows={group.variants}
                              columns={STOCK_VARIANT_COLUMNS}
                              rowKey={(v: any) => v.id}
                              density="compact"
                              cardsBelow="md"
                              empty={{ title: "لا توجد مقاسات" }}
                              mobileRow={(v: any) => <StockVariantCard v={v} />}
                            />
                          </div>
                        ))}
                      </div>
                    );
                  })()}

                  {(!stockData || stockData.length === 0) && (!stockVariants || stockVariants.length === 0) && (
                    <EmptyState
                      icon={<Box className="h-7 w-7" />}
                      title="لا توجد بيانات مخزون"
                      description="لما يتسجّل مخزون للأصناف هيظهر هنا."
                      className="py-8"
                    />
                  )}
                </>
              )}
            </div>
          </SectionCard>
        )}

        {/* QR Scan Panel */}
        {showScanPanel && (
          <SectionCard
            testId="employee-scan-panel"
            icon={<QrCode className="h-4 w-4 text-[var(--success)]" aria-hidden="true" />}
            title="مسح QR - تجهيز الأوردرات"
            description="افتح الكاميرا أو أدخل السيريال يدوياً"
            action={
              <Button
                className="min-h-11 min-w-11 md:min-h-9 md:min-w-9"
                variant="ghost"
                size="icon"
                aria-label="إغلاق مسح QR"
                onClick={() => { setShowScanPanel(false); stopScanCamera(); setScanResult(null); }}
              >
                <XCircle className="h-4 w-4" />
              </Button>
            }
          >
            <div className="space-y-4" dir="rtl">
              {/* Camera scanner */}
              <div className="flex flex-col items-center gap-3">
                {/* Video element for native camera */}
                <div
                  className={`relative w-full overflow-hidden rounded-[var(--radius-brand-md)] bg-foreground ${
                    scanIsScanning ? "min-h-[260px]" : "hidden"
                  }`}
                >
                  <video
                    ref={scanVideoRef}
                    className="w-full h-full object-cover min-h-[260px]"
                    style={{ WebkitTransform: 'scaleX(1)', transform: 'scaleX(1)' }}
                    playsInline
                    autoPlay
                    muted
                  />
                  {/* Scan overlay */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="relative h-48 w-48 rounded-[var(--radius-brand-md)] border-2 border-primary-foreground/70">
                      <div className="absolute top-0 left-0 w-5 h-5 border-t-4 border-l-4 border-[var(--success)]/30 rounded-tl-lg" />
                      <div className="absolute top-0 right-0 w-5 h-5 border-t-4 border-r-4 border-[var(--success)]/30 rounded-tr-lg" />
                      <div className="absolute bottom-0 left-0 w-5 h-5 border-b-4 border-l-4 border-[var(--success)]/30 rounded-bl-lg" />
                      <div className="absolute bottom-0 right-0 w-5 h-5 border-b-4 border-r-4 border-[var(--success)]/30 rounded-br-lg" />
                    </div>
                  </div>
                  {/* Hidden canvas for QR processing */}
                  <canvas ref={scanCanvasRef} className="hidden" />
                </div>

                {!scanIsScanning && !scanCameraError && (
                  <div className="flex h-40 w-full items-center justify-center rounded-[var(--radius-brand-md)] border-2 border-dashed border-[var(--success)]/30 bg-muted">
                    <div className="text-center text-muted-foreground">
                      <CameraOff className="h-10 w-10 mx-auto mb-2 opacity-50" />
                      <p className="text-xs">اضغط لتشغيل الكاميرا</p>
                    </div>
                  </div>
                )}

                {scanCameraError && (
                  <div className="w-full rounded-[var(--radius-brand-md)] border border-destructive/30 bg-destructive/10 p-4 text-center" role="alert">
                    <XCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
                    <p className="text-sm text-destructive">{scanCameraError}</p>
                  </div>
                )}
                {!scanIsScanning ? (
                  <Button
                    className="min-h-11 md:min-h-9 w-full gap-2 bg-[var(--success)] font-bold text-[var(--success-foreground)] hover:opacity-90"
                    onClick={startScanCamera}
                  >
                    <Camera className="h-4 w-4" />
                    تشغيل الكاميرا
                  </Button>
                ) : (
                  <Button
                    className="min-h-11 md:min-h-9 w-full gap-2 font-bold"
                    variant="destructive"
                    onClick={stopScanCamera}
                  >
                    <CameraOff className="h-4 w-4" />
                    إيقاف الكاميرا
                  </Button>
                )}
              </div>

              {/* Manual input */}
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground mb-2 text-center">أو أدخل السيريال يدوياً</p>
                <form onSubmit={handleManualScanSubmit} className="flex gap-2">
                  <Input
                    value={manualSerial}
                    onChange={e => setManualSerial(e.target.value)}
                    placeholder="ORD-2026-000001"
                    aria-label="السيريال"
                    className="min-h-11 md:min-h-9 flex-1 text-sm text-right"
                    dir="ltr"
                  />
                  <Button
                    className="min-h-11 min-w-11 md:min-h-9 md:min-w-9 bg-[var(--success)] text-[var(--success-foreground)] hover:opacity-90"
                    type="submit"
                    size="sm"
                    aria-label="تحقق من السيريال"
                    disabled={scanMutation.isPending}
                  >
                    <Hash className="h-4 w-4" />
                  </Button>
                </form>
              </div>

              {/* Scan result */}
              {scanMutation.isPending && (
                <div className="flex items-center justify-center gap-2 py-3 text-muted-foreground text-sm" role="status">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  جاري التحقق...
                </div>
              )}
              {scanResult && !scanMutation.isPending && (
                <div className={`rounded-[var(--radius-brand-md)] border p-4 ${
                  scanResult.success ? 'bg-[var(--success)]/10 border-[var(--success)]/30' :
                  scanResult.result === 'duplicate' ? 'bg-[var(--warning)]/10 border-[var(--warning)]/30' :
                  'bg-destructive/10 border-destructive/30'
                }`}>
                  <div className="flex items-center gap-2 mb-2">
                    {scanResult.success ? (
                      <CheckCircle className="h-5 w-5 text-[var(--success)]" />
                    ) : scanResult.result === 'duplicate' ? (
                      <AlertCircle className="h-5 w-5 text-[var(--warning)]" />
                    ) : (
                      <XCircle className="h-5 w-5 text-destructive" />
                    )}
                    <span className={`font-bold text-sm ${
                      scanResult.success ? 'text-[var(--success)]' :
                      scanResult.result === 'duplicate' ? 'text-[var(--warning)]' : 'text-destructive'
                    }`}>
                      {scanResult.success ? 'تم التجهيز بنجاح' :
                       scanResult.result === 'duplicate' ? 'تم تجهيزه من قبل' :
                       scanResult.result === 'cancelled' ? 'أوردر ملغي' : `QR غير صحيح`}
                    </span>
                  </div>
                  {scanResult.message && !scanResult.order && (
                    <p className="text-xs text-muted-foreground mt-1">{scanResult.message}</p>
                  )}
                  {scanResult.order && (
                    <div className="space-y-1 text-xs text-foreground">
                      <p><span className="font-semibold">الأوردر:</span> {scanResult.order.orderNumber}</p>
                      <p><span className="font-semibold">العميل:</span> {scanResult.order.customerName}</p>
                      <p><span className="font-semibold">المنتج:</span> {scanResult.order.productName}</p>
                      <p><span className="font-semibold">الكمية:</span> {scanResult.order.quantity}</p>
                      <p><span className="font-semibold">المحافظة:</span> {scanResult.order.governorate}</p>
                      {scanResult.preparedByName && (
                        <p className="text-[var(--warning)]"><span className="font-semibold">جهزه:</span> {scanResult.preparedByName} • {scanResult.preparedAt ? new Date(scanResult.preparedAt).toLocaleString('ar-EG') : ''}</p>
                      )}
                    </div>
                  )}
                  <Button
                    className="min-h-11 md:min-h-8 mt-3 h-auto px-0 text-xs text-muted-foreground underline"
                    variant="link"
                    onClick={() => { setScanResult(null); }}
                  >
                    مسح ومسح جديد
                  </Button>
                </div>
              )}
            </div>
          </SectionCard>
        )}

        {/* Tasks Panel */}
        {showTasksPanel && <EmployeeTasksPanel employeeId={meData?.id} />}

        {/* Broadcast Message - Notification احترافي */}
        {broadcastData && (
          <div
            className="relative overflow-hidden rounded-[var(--radius-brand-md)] border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-4 shadow-[var(--shadow-card)]"
            role="status"
            data-testid="employee-broadcast"
          >
            <div className="absolute top-0 left-0 w-1 h-full bg-[var(--warning)]"></div>
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[var(--warning)]">
                <Megaphone className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-sm font-bold text-[var(--warning)]">رسالة من الإدارة</h4>
                  <StatusBadge status="broadcast" label="إشعار" tone="warning" size="sm" icon={null} />
                </div>
                <p className="text-sm text-foreground leading-relaxed">{broadcastData.message}</p>
                <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                  <span className="font-medium text-[var(--warning)]">{broadcastData.sentByName}</span>
                  <span aria-hidden="true">•</span>
                  <span>{new Date(broadcastData.createdAt).toLocaleString('ar-EG')}</span>
                </div>
              </div>
            </div>
          </div>
        )}
        {/* فشل تحميل رسالة الإدارة: لا نعرض مكانها شيئًا مضللًا — تنبيه صغير بإعادة المحاولة.
            لا حالة تحميل هنا عمدًا: غالبًا مافيش رسالة أصلًا، فهيكل فارغ كان هيوحي بإن فيه. */}
        {!broadcastData && broadcastIsError && online && (
          <ErrorState
            title="تعذّر تحميل رسالة الإدارة"
            onRetry={() => refetchBroadcast()}
            className="py-4"
          />
        )}

        {/* Date Filter Panel */}
        {showDateFilter && (
          <SectionCard
            testId="employee-date-filter"
            icon={<CalendarDays className="h-4 w-4 text-primary" aria-hidden="true" />}
            title="فلتر التاريخ"
            action={
              <Button
                className="min-h-11 min-w-11 md:min-h-9 md:min-w-9"
                variant="ghost"
                size="icon"
                aria-label="إغلاق فلتر التاريخ"
                onClick={() => setShowDateFilter(false)}
              >
                <XCircle className="h-4 w-4" />
              </Button>
            }
          >
            {/* أزرار سريعة */}
            <div className="mb-3 flex gap-2" role="group" aria-label="فترات سريعة">
              <Button
                className="min-h-11 md:min-h-8 flex-1 text-xs font-bold"
                size="sm"
                variant={!dateFrom && !dateTo ? "default" : "outline"}
                aria-pressed={!dateFrom && !dateTo}
                onClick={() => { setDateFrom(""); setDateTo(""); }}
              >اليوم</Button>
              <Button
                className="min-h-11 md:min-h-8 flex-1 text-xs font-bold"
                size="sm"
                variant={dateFrom && dateTo && dateFrom === dateTo && dateFrom === cairoYesterdayISO() ? "default" : "outline"}
                aria-pressed={Boolean(dateFrom && dateTo && dateFrom === dateTo && dateFrom === cairoYesterdayISO())}
                onClick={() => {
                  const yStr = cairoYesterdayISO();
                  setDateFrom(yStr); setDateTo(yStr);
                }}
              >أمس</Button>
              <Button
                className="min-h-11 md:min-h-8 flex-1 text-xs font-bold"
                size="sm"
                variant={dateFrom === '2024-01-01' && !dateTo ? "default" : "outline"}
                aria-pressed={dateFrom === '2024-01-01' && !dateTo}
                onClick={() => { setDateFrom("2024-01-01"); setDateTo(""); }}
              >كل الأوردرات</Button>
            </div>
            {/* تاريخ مخصص */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="emp-date-from" className="mb-1 block text-xs text-muted-foreground">من تاريخ</Label>
                <Input
                  id="emp-date-from"
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  className="min-h-11 md:min-h-9 w-full text-sm"
                />
              </div>
              <div>
                <Label htmlFor="emp-date-to" className="mb-1 block text-xs text-muted-foreground">إلى تاريخ</Label>
                <Input
                  id="emp-date-to"
                  type="date"
                  value={dateTo}
                  onChange={e => setDateTo(e.target.value)}
                  className="min-h-11 md:min-h-9 w-full text-sm"
                />
              </div>
            </div>
            {(dateFrom || dateTo) && (
              <p className="mt-2 flex items-center gap-1 rounded-[var(--radius-brand-md)] bg-accent px-3 py-2 text-xs text-accent-foreground">
                <Filter className="h-3 w-3" aria-hidden="true" />
                يتم عرض الأوردرات المسندة في الفترة المحددة
              </p>
            )}
          </SectionCard>
        )}

        {/* Stats Row — each tile doubles as a quick filter into the tab it names.
            سبع بطاقات مش أربعة: "ملغي" و"لم يرد" و"يحتاج مراجعة" كانوا في شرايط الفلترة
            بس، فالموظف مكانش شايف أرقامهم. على الموبايل شريط بيتمرّر جوه نفسه (نفس نمط
            صفحة الأوردرات)، وعلى الشاشات الأوسع جريد كامل. */}
        <div className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-7 lg:overflow-visible [&>*]:min-w-[128px] [&>*]:snap-start lg:[&>*]:min-w-0">
          <StatCard label="الكل" value={displayStats?.total ?? 0} loading={statsTilesLoading} active={activeTab === "all"} onClick={() => setActiveTab("all")} />
          <StatCard label="جديد" value={displayStats?.new ?? 0} loading={statsTilesLoading} tone="primary" active={activeTab === "new"} onClick={() => setActiveTab("new")} />
          <StatCard label="مؤكد" value={displayStats?.confirmed ?? 0} loading={statsTilesLoading} tone="success" active={activeTab === "confirmed"} onClick={() => setActiveTab("confirmed")} />
          <StatCard label="مؤجل" value={displayStats?.postponed ?? 0} loading={statsTilesLoading} tone="warning" active={activeTab === "postponed"} onClick={() => setActiveTab("postponed")} />
          <StatCard label="ملغي" value={displayStats?.cancelled ?? 0} loading={statsTilesLoading} tone="danger" active={activeTab === "cancelled"} onClick={() => setActiveTab("cancelled")} />
          <StatCard label="لم يرد" value={displayStats?.no_answer ?? 0} loading={statsTilesLoading} tone="warning" active={activeTab === "no_answer"} onClick={() => setActiveTab("no_answer")} />
          <StatCard label="يحتاج مراجعة" value={reviewCount} loading={isLoading} tone="info" active={activeTab === "needs_review"} onClick={() => setActiveTab("needs_review")} />
        </div>
        {/* إحصائيات السيرفر فشلت: البطاقات بترجع (زي ما كانت) للعدّ من القائمة المحمّلة —
            بنقول ده صراحة بدل ما الرقم يتقرا كإجمالي السيرفر. */}
        {statsFallbackActive && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-brand-md)] border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-3 py-2 text-xs text-foreground" role="status">
            <span className="flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
              تعذّر تحميل الإحصائيات — الأرقام محسوبة من الأوردرات المعروضة.
            </span>
            <Button className="min-h-11 md:min-h-8 gap-1 text-xs" size="sm" variant="outline" onClick={() => refetchStats()}>
              <RefreshCw className="h-3.5 w-3.5" />
              إعادة المحاولة
            </Button>
          </div>
        )}

        {/* Search — البحث نفسه محلي على القائمة المحمّلة كما كان؛ SearchInput بس بيأخّر
            تطبيقه لحد ما الكتابة تقف. */}
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="بحث بالاسم أو الهاتف أو رقم الأوردر..."
          className="[&_input]:bg-card"
        />

        {/* Tabs */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none" role="group" aria-label="تصفية حسب الحالة">
          {tabs.map(tab => (
            <Button
              className="min-h-11 md:min-h-8 shrink-0 gap-1.5 rounded-[var(--radius-brand-pill)] px-3 text-sm font-medium"
              key={tab.key}
              size="sm"
              variant={activeTab === tab.key ? "default" : "outline"}
              aria-pressed={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className={`rounded-[var(--radius-brand-pill)] px-1.5 py-0.5 text-xs tabular-nums ${
                  activeTab === tab.key ? "bg-primary-foreground/20" : "bg-muted"
                }`}>
                  {tab.count}
                </span>
              )}
            </Button>
          ))}
        </div>

        {/* Orders List */}
        {/* تحديث دوري فشل والقائمة القديمة لسه محمّلة: بنقول كده من غير ما نخفي اللي قدام الموظف. */}
        {ordersIsError && ordersData && online && (
          <ErrorState
            title="تعذّر تحديث الأوردرات"
            message="المعروض هو آخر نسخة اتحمّلت."
            onRetry={() => refetch()}
            retrying={ordersFetching}
            className="py-4"
          />
        )}
        {!ordersData && !online ? null : ordersIsError && !ordersData ? (
          <ErrorState
            title="تعذّر تحميل أوردراتك"
            message="تحقّق من الاتصال ثم أعد المحاولة."
            onRetry={() => refetch()}
            retrying={ordersFetching}
          />
        ) : isLoading ? (
          <LoadingSkeleton variant="cards" rows={3} className="sm:grid-cols-1 lg:grid-cols-1 xl:grid-cols-2" />
        ) : filteredOrders.length === 0 ? (
          <EmptyState
            icon={<ShoppingBag className="h-7 w-7" />}
            title="لا توجد أوردرات"
            description={search ? "جرب بحثاً مختلفاً" : "لم يتم تعيين أوردرات لك بعد"}
          />
        ) : (
          // عمودين على الشاشات الواسعة: كارت التأكيد ارتفاعه ثابت تقريبًا، فعمود واحد
          // على شاشة ١٤٤٠ معناه تمرير ضعف اللازم مقابل نص الشاشة فاضي.
          <div className="space-y-3 xl:grid xl:grid-cols-2 xl:items-start xl:gap-3 xl:space-y-0">
            {filteredOrders.map(order => {
              const statusConf = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.new;
              const isExpanded = expandedOrder === order.id;
              const canAct = order.status === "new" || order.status === "postponed" || order.status === "no_answer";
              // Whole action row locked while any status write for THIS order is in flight.
              // Scoped per order, not globally: a slow confirm on one card must not freeze
              // the other forty on screen.
              const rowBusy = busyOrderId === order.id && statusWriteInFlight;

              return (
                <div
                  key={order.id}
                  className="overflow-hidden rounded-[var(--radius-brand-md)] border border-border bg-card shadow-[var(--shadow-card)]"
                >
                  {/* Order Header */}
                  <div
                    className="p-4 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    onClick={() => setExpandedOrder(isExpanded ? null : order.id)}
                    onKeyDown={(e) => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setExpandedOrder(isExpanded ? null : order.id);
                      }
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold">{order.customerName}</span>
                          {/* النص من STATUS_CONFIG كما كان؛ اللون والأيقونة من الشارة الموحّدة */}
                          <StatusBadge status={order.status} label={statusConf.label} size="sm" />
                          {order.source && (
                            <StatusBadge
                              kind="source"
                              status={order.source}
                              label={sourceOptions.find(option => option.value === order.source)?.label ?? order.source}
                              size="sm"
                            />
                          )}
                          {/* Orders whose items could not be mapped to the catalog need a
                              human before they are confirmed — say so up front. */}
                          {order.needsReview && (
                            <StatusBadge
                              status="needs_review"
                              label="تحتاج مراجعة"
                              tone="warning"
                              size="sm"
                              icon={<AlertCircle />}
                            />
                          )}
                        </div>
                        {/* flex-wrap: على ٣٧٥px كان الصف بيتقطع في نص "القاهرة · مدينة نصر"
                            وتفضل النقطة الفاصلة معلّقة لوحدها في سطر. زرار الواتساب اتشال من
                            هنا — بقى في شريط الإجراءات الثابت تحت بنص واضح بدل أيقونة. */}
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Phone className="h-3.5 w-3.5" />
                            <span dir="ltr">{order.customerPhone}</span>
                          </span>
                          {/* المنطقة كانت ناقصة — "القاهرة" لوحدها مش كفاية لمكالمة تأكيد. */}
                          <span className="flex items-center gap-1 whitespace-nowrap">
                            <MapPin className="h-3.5 w-3.5" />
                            {order.governorate}
                            {(order as any).city && <span className="text-muted-foreground/80"> · {(order as any).city}</span>}
                          </span>
                        </div>
                        {/* العنوان الكامل - ظاهر دائماً */}
                        <div className="flex items-start gap-1.5 mt-1.5 text-sm">
                          <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary" />
                          <span className="leading-snug">{order.customerAddress}</span>
                        </div>
                        {/* المنتج والسعر على طرفي سطر واحد، والتخصيص تحته: مع الالتفاف الحر
                            كان "(ذهبي - وسط)" بيتعلّق في الطرف المقابل بعيد عن اسم المنتج. */}
                        <div className="mt-1 flex items-start justify-between gap-3 text-sm">
                          <span className="flex min-w-0 items-start gap-1 text-muted-foreground">
                            <Package className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span className="min-w-0">
                              <span className="leading-snug">{order.productName}</span>
                              {/* الكمية كانت مش ظاهرة خالص — أهم رقم بعد السعر في مكالمة التأكيد. */}
                              {order.quantity > 1 && (
                                <span className="font-semibold text-foreground"> × {order.quantity}</span>
                              )}
                              {((order as any).color || (order as any).size) && (
                                <span className="block text-xs text-muted-foreground/80">
                                  {(order as any).color}{(order as any).color && (order as any).size && " · "}{(order as any).size}
                                </span>
                              )}
                            </span>
                          </span>
                          <span className="shrink-0 font-semibold tabular-nums">
                            {Number(order.totalAmount).toLocaleString('ar-EG')} ج.م
                          </span>
                        </div>
                        {/* الملاحظة كانت مدفونة جوه التوسيع: الموظف كان لازم يفتح كل كارت
                            عشان يعرف إذا كان فيه تعليمات خاصة قبل ما يتصل. */}
                        {order.notes && (
                          <p className="mt-1.5 flex items-start gap-1.5 rounded-[var(--radius-brand-sm)] bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
                            <MessageSquare className="mt-0.5 h-3 w-3 shrink-0" />
                            <span className="line-clamp-2 leading-snug">{order.notes}</span>
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <span className="font-mono text-xs text-muted-foreground">{order.orderNumber}</span>
                        {order.createdAt && (
                          // بدون السنة: كل أوردرات الموظف من نفس السنة، والسنة كانت بتوسّع
                          // العمود ده وتاكل من عرض بيانات العميل على الموبايل.
                          <span className="whitespace-nowrap text-xs text-muted-foreground">
                            {new Date(order.createdAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })}
                          </span>
                        )}
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </div>
                  </div>

                  {/* شريط الإجراءات — ثابت وظاهر من غير ما الكارت يتفتح.
                      كان كله جوه القسم الموسّع، يعني كل تأكيد كان بيتكلّف ضغطة زيادة
                      وشاشة بتتحرك تحت الصباع. شاشة تأكيدات بتتعامل مع مئات المكالمات
                      في اليوم متتحملش الضغطة دي. */}
                  <div
                    className="space-y-1.5 border-t border-border bg-muted/30 px-3 py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {/* جريد مش flex-wrap: مع الالتفاف الحر كانت الأزرار بتتوزّع ٣ + ١،
                        فيفضل زرار يتيم في سطر لوحده وشكل الشريط يتغيّر من كارت للتاني.
                        الجريد بيثبّت الصفّين: أربعة قرارات فوق، وثلاث وسائل تواصل تحت. */}
                    {/* h-11 = 44px, the smallest reliable touch target. These were 36px and
                        sit four to a row on a 320px screen, so a mistap here changed an
                        order's status. Icons are shrink-0 and labels text-xs so nothing
                        overflows at that width. `busyOrderId` disables the whole row while a
                        status write is in flight — the guard against a double tap sending
                        both "تأكيد" and "لم يرد". */}
                    {canAct && (
                      <div className="grid grid-cols-4 gap-1.5">
                        <Button
                          size="sm"
                          className="h-11 gap-1 bg-[var(--success)] px-1 text-xs text-[var(--success-foreground)] hover:opacity-90"
                          onClick={() => handleConfirmOrder(order)}
                          disabled={rowBusy}
                        >
                          {confirmMutation.isPending && busyOrderId === order.id
                            ? <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />
                            : <CheckCircle2 className="h-4 w-4 shrink-0" />}
                          تأكيد
                        </Button>
                        <Button
                          size="sm" variant="outline"
                          className="h-11 gap-1 border-[var(--warning)]/50 px-1 text-xs text-[var(--warning)] hover:bg-[var(--warning)]/10"
                          onClick={() => { setPostponeDialog({ open: true, orderId: order.id }); setPostponeDate(""); setPostponeNotes(""); }}
                          disabled={rowBusy}
                        >
                          <Clock className="h-4 w-4 shrink-0" />
                          تأجيل
                        </Button>
                        <Button
                          size="sm" variant="outline"
                          className="h-11 gap-1 border-destructive/50 px-1 text-xs text-destructive hover:bg-destructive/10"
                          onClick={() => { setCancelDialog({ open: true, orderId: order.id }); setCancelReason(""); setCancelNotes(""); setCancelOtherReason(""); }}
                          disabled={rowBusy}
                        >
                          <XCircle className="h-4 w-4 shrink-0" />
                          إلغاء
                        </Button>
                        <Button
                          size="sm" variant="outline" className="h-11 gap-1 px-1 text-xs"
                          onClick={() => openNoAnswerDialog(order.id)}
                          disabled={rowBusy}
                        >
                          {noAnswerMutation.isPending && busyOrderId === order.id
                            ? <RefreshCw className="h-4 w-4 shrink-0 animate-spin" />
                            : <PhoneOff className="h-4 w-4 shrink-0" />}
                          لم يرد
                        </Button>
                      </div>
                    )}
                    {/* تغيير الحالة مباشرة — أربع حالات فقط، وهي نفس الأربعة اللي الـ
                        procedure على السيرفر بيقبلها. الحالات التانية (مطبوع/تم الشحن/
                        تم التوصيل/مرتجع) بتتعرض للقراءة بس عشان الموظف يفهم إن الأوردر
                        خرج من نطاقه، ومش قابلة للاختيار. */}
                    <div className="flex items-center gap-2">
                      <span className="shrink-0 type-caption">الحالة:</span>
                      <Select
                        value={EMPLOYEE_EDITABLE_STATUSES.includes(order.status) ? order.status : "__locked"}
                        onValueChange={(v) => handleStatusSelect(order, v)}
                        disabled={updateStatusMutation.isPending || !EMPLOYEE_EDITABLE_STATUSES.includes(order.status)}
                      >
                        <SelectTrigger data-readonly-write className="min-h-11 md:min-h-9 h-9 flex-1 bg-card"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {!EMPLOYEE_EDITABLE_STATUSES.includes(order.status) && (
                            <SelectItem value="__locked" disabled>
                              {STATUS_CONFIG[order.status]?.label ?? order.status} — خارج نطاق التأكيدات
                            </SelectItem>
                          )}
                          {EMPLOYEE_EDITABLE_STATUSES.map(s => (
                            <SelectItem key={s} value={s}>{STATUS_SELECT_LABELS[s] ?? s}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5">
                      <WhatsAppButton phone={order.customerPhone} size="sm" className="h-11 w-full px-1 text-xs" />
                      <Button data-readonly-safe
                        size="sm" variant="outline"
                        className="h-11 gap-1 border-[var(--info)]/40 px-1 text-xs text-[var(--info)] hover:bg-[var(--info)]/10"
                        onClick={() => { window.location.href = `tel:${order.customerPhone}`; }}
                      >
                        <Phone className="h-4 w-4 shrink-0" /> اتصال
                      </Button>
                      <Button size="sm" variant="outline" className="h-11 gap-1 px-1 text-xs" onClick={() => openEditDialogFor(order)}>
                        <Edit2 className="h-4 w-4 shrink-0" /> تعديل
                      </Button>
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <div className="border-t border-border bg-muted/40 px-4 py-3 space-y-3">
                      {/* Move through the current filtered list without collapsing back to it */}
                      {filteredOrders.length > 1 && (
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <Button
                            className="min-h-11 md:min-h-8 gap-1 px-2 text-xs text-muted-foreground"
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={(e) => { e.stopPropagation(); goToAdjacentOrder(-1); }}
                          >
                            <ChevronRight className="h-3.5 w-3.5" /> السابق
                          </Button>
                          <span className="tabular-nums">{expandedIndex + 1} / {filteredOrders.length}</span>
                          <Button
                            className="min-h-11 md:min-h-8 gap-1 px-2 text-xs text-muted-foreground"
                            type="button"
                            size="sm"
                            variant="ghost"
                            onClick={(e) => { e.stopPropagation(); goToAdjacentOrder(1); }}
                          >
                            التالي <ChevronLeft className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                      {/* Why this order was flagged, verbatim from the import/parse step */}
                      {order.needsReview && order.reviewReason && (
                        <div className="flex items-start gap-2 rounded-[var(--radius-brand-md)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3">
                          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warning)]" />
                          <div className="space-y-0.5">
                            <p className="text-xs font-semibold">سبب المراجعة</p>
                            <p className="text-xs text-muted-foreground">{order.reviewReason}</p>
                            <p className="text-[11px] text-muted-foreground">
                              صحّح الصنف من «تعديل بيانات» قبل التأكيد.
                            </p>
                          </div>
                        </div>
                      )}

                      {/* Address */}
                      <div>
                        <p className="mb-1 text-xs text-muted-foreground">العنوان الكامل</p>
                        <p className="text-sm">{order.customerAddress}</p>
                      </div>

                      {/* Notes - قابلة للتعديل */}
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <p className="flex items-center gap-1 text-xs text-muted-foreground">
                            <MessageSquare className="h-3 w-3" />
                            ملاحظات الموظف
                          </p>
                          {editingNotes[order.id] !== undefined && (
                            <Button
                              className="min-h-11 md:min-h-8 gap-1 px-2 text-xs font-medium text-[var(--success)]"
                              size="sm"
                              variant="ghost"
                              onClick={() => handleSaveNotes(order.id)}
                              disabled={updateNotesMutation.isPending}
                            >
                              <Save className="h-3 w-3" />
                              {updateNotesMutation.isPending ? 'جاري...' : 'حفظ'}
                            </Button>
                          )}
                        </div>
                        <Textarea
                          value={editingNotes[order.id] ?? order.notes ?? ''}
                          onChange={e => setEditingNotes(prev => ({ ...prev, [order.id]: e.target.value }))}
                          placeholder="اكتب ملاحظة على الأوردر..."
                          className="min-h-[60px] bg-card text-sm"
                          rows={2}
                        />
                      </div>

                      {/* Postponed date */}
                      {order.status === "postponed" && order.postponedTo && (
                        <div className="flex items-center gap-2 rounded-[var(--radius-brand-md)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-3 py-2 text-sm text-[var(--warning)]">
                          <Clock className="h-4 w-4" />
                          مؤجل لـ: {new Date(order.postponedTo).toLocaleDateString("ar-EG")}
                        </div>
                      )}

                      {/* Duplicate marker — زرار "تعديل بيانات" اتنقل لشريط الإجراءات الثابت */}
                      <div className="flex items-center justify-end gap-2">
                        {order.isDuplicate ? (
                          <Button
                            className="min-h-11 md:min-h-8 gap-1 border-[var(--warning)]/40 bg-[var(--warning)]/10 px-2 text-xs text-[var(--warning)] hover:bg-[var(--warning)]/20"
                            size="sm"
                            variant="outline"
                            onClick={() => setDuplicateConfirm({ orderId: order.id, action: "unmark" })}
                            disabled={unmarkDuplicateMutation.isPending}
                            title="إلغاء تعليم التكرار"
                            aria-label="مكرر — إلغاء تعليم التكرار"
                          >
                            <span>مكرر</span>
                          </Button>
                        ) : (
                          <Button
                            className="min-h-11 md:min-h-8 gap-1 px-2 text-xs text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                            size="sm"
                            variant="outline"
                            onClick={() => setDuplicateConfirm({ orderId: order.id, action: "mark" })}
                            disabled={markDuplicateMutation.isPending}
                            title="تعليم كمكرر"
                            aria-label="تعليم كمكرر"
                          >
                            <span>مكرر</span>
                          </Button>
                        )}
                      </div>

                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </main>

      {/* Edit Order Dialog - شاشة تعديل شاملة */}
      {/* تعديل الأوردر — نفس المكوّن اللي بتستخدمه شاشة المالك. الفرق بينهم على السيرفر
          بس: الشاشة دي بتعدي على employeePortal (كوكي الموظف + صلاحية + فحص ملكية)،
          وشاشة المالك على orders (جلسة إدارية + نطاق النشاط). */}
      <OrderEditDialog
        open={editDialog.open}
        onOpenChange={open => { if (!open) setEditDialog({ open: false, orderId: null, data: null }); }}
        order={editingOrder}
        items={orderItemsData}
        itemsLoading={orderItemsLoading}
        itemsError={orderItemsError}
        products={(productsList ?? []) as any}
        variants={(stockVariants ?? []) as any}
        configuredGovernorates={configuredGovernorates}
        governoratesLoading={governorateOptions.isLoading}
        governoratesError={governorateOptions.isError}
        saving={editSaving}
        onSave={saveEdit}
        allowItemsEdit={canEditItems}
        footerSlot={
          <>
            <Button
              className="min-h-11 md:min-h-8 h-auto px-0 text-xs text-[var(--info)] underline"
              type="button"
              variant="link"
              aria-expanded={showEditHistory}
              onClick={() => setShowEditHistory(!showEditHistory)}
            >
              {showEditHistory ? "إخفاء سجل التعديلات" : "عرض سجل التعديلات"}
            </Button>
            {showEditHistory && editDialog.orderId && (
              <EditHistoryPanel orderId={editDialog.orderId} />
            )}
          </>
        }
      />

      {/* Postpone Dialog */}
      <Dialog open={postponeDialog.open} onOpenChange={open => setPostponeDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-[var(--warning)]" />
              تأجيل الأوردر
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-1.5">
              <Button type="button" size="sm" variant="outline" className="min-h-11 text-xs md:min-h-7" onClick={() => applyPostponePreset("today")}>مساء اليوم</Button>
              <Button type="button" size="sm" variant="outline" className="min-h-11 text-xs md:min-h-7" onClick={() => applyPostponePreset("tomorrow")}>غدًا</Button>
            </div>
            <div>
              <Label>تاريخ الاتصال مرة أخرى <span className="text-destructive">*</span></Label>
              <Input
                type="date"
                value={postponeDate}
                onChange={e => setPostponeDate(e.target.value)}
                min={new Date().toISOString().split("T")[0]}
                className="min-h-11 md:min-h-9 mt-1"
              />
            </div>
            <div>
              <Label>ملاحظة (اختياري)</Label>
              <Input
                value={postponeNotes}
                onChange={e => setPostponeNotes(e.target.value)}
                placeholder="سبب التأجيل..."
                className="min-h-11 md:min-h-9 mt-1"
              />
            </div>
          </div>
          <DialogFooter className="grid grid-cols-2 gap-2 sm:flex">
            <Button
              variant="outline"
              className="h-11 gap-1.5"
              onClick={() => setPostponeDialog({ open: false, orderId: null })}
              disabled={postponeMutation.isPending}
            >
              <ChevronRight className="h-4 w-4" />
              رجوع
            </Button>
            <Button
              onClick={handlePostpone}
              disabled={postponeMutation.isPending || !postponeDate}
              className="h-11 gap-1.5 bg-[var(--warning)] text-[var(--warning-foreground)] hover:opacity-90"
            >
              {postponeMutation.isPending
                ? <><RefreshCw className="h-4 w-4 animate-spin" />جاري التأجيل...</>
                : <><Clock className="h-4 w-4" />تأجيل</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Dialog */}
      <Dialog open={cancelDialog.open} onOpenChange={open => setCancelDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-destructive" />
              إلغاء الأوردر
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              الإلغاء بيتسجّل باسمك وبوقته وسببه في سجل النشاط.
            </p>
            <div>
              <Label>سبب الإلغاء <span className="text-destructive">*</span></Label>
              <Select value={cancelReason || undefined} onValueChange={setCancelReason}>
                <SelectTrigger className={`min-h-11 md:min-h-9 mt-1 w-full ${!cancelReason ? "border-destructive/30 bg-destructive/10" : ""}`}>
                  <SelectValue placeholder="اختر السبب..." />
                </SelectTrigger>
                <SelectContent className="max-h-[45vh]">
                  {cancelReasons.map(r => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                  <SelectItem value={OTHER_CANCEL_REASON}>سبب آخر…</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {cancelReasonIsOther && (
              <div>
                <Label>اكتب السبب <span className="text-destructive">*</span></Label>
                <Input
                  value={cancelOtherReason}
                  onChange={e => setCancelOtherReason(e.target.value)}
                  placeholder="السبب بالتفصيل..."
                  maxLength={80}
                  autoFocus
                  className={`mt-1 min-h-11 md:min-h-9 ${!cancelOtherReason.trim() ? "border-destructive/30 bg-destructive/10" : ""}`}
                />
              </div>
            )}
            <div>
              <Label>ملاحظة (اختياري)</Label>
              <Input
                value={cancelNotes}
                onChange={e => setCancelNotes(e.target.value)}
                placeholder="تفاصيل إضافية..."
                className="mt-1 min-h-11 md:min-h-9"
              />
            </div>
          </div>
          <DialogFooter className="grid grid-cols-2 gap-2 sm:flex">
            <Button
              variant="outline"
              className="h-11 gap-1.5"
              onClick={() => setCancelDialog({ open: false, orderId: null })}
              disabled={cancelMutation.isPending}
            >
              <ChevronRight className="h-4 w-4" />
              رجوع
            </Button>
            <Button
              onClick={handleCancel}
              disabled={cancelMutation.isPending || !cancelReasonResolved}
              variant="destructive"
              className="h-11 gap-1.5"
            >
              {cancelMutation.isPending
                ? <><RefreshCw className="h-4 w-4 animate-spin" />جاري الإلغاء...</>
                : <><XCircle className="h-4 w-4" />تأكيد الإلغاء</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* استبيان "لم يرد" — كام مرة اتصل الموظف بالعميل قبل تسجيل الحالة */}
      <Dialog open={noAnswerDialog.open} onOpenChange={open => setNoAnswerDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Phone className="h-5 w-5 text-[var(--warning)]" />
              تسجيل "لم يرد"
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Label>كام مرة اتصلت بالعميل؟</Label>
            <div className="grid grid-cols-4 gap-2">
              {[1, 2, 3, 4].map(n => (
                <Button
                  key={n}
                  type="button"
                  variant={noAnswerAttempts === String(n) ? "default" : "outline"}
                  className="h-11 md:h-10"
                  aria-pressed={noAnswerAttempts === String(n)}
                  onClick={() => setNoAnswerAttempts(String(n))}
                >
                  {n}
                </Button>
              ))}
            </div>
            <Input className="min-h-11 md:min-h-9"
              type="number" min={1} max={20} placeholder="أو رقم مختلف..."
              value={noAnswerAttempts} onChange={e => setNoAnswerAttempts(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={() => setNoAnswerDialog({ open: false, orderId: null })}>رجوع</Button>
            <Button className="min-h-11 md:min-h-9"
              disabled={noAnswerMutation.isPending}
              onClick={() => {
                if (!noAnswerDialog.orderId) return;
                const attempts = noAnswerAttempts ? Number(noAnswerAttempts) : undefined;
                setBusyOrderId(noAnswerDialog.orderId);
                noAnswerMutation.mutate({ orderId: noAnswerDialog.orderId, callAttempts: attempts, operationId: operationIdFor(`no_answer:${noAnswerDialog.orderId}`) });
              }}
            >
              {noAnswerMutation.isPending ? "جاري..." : 'تأكيد "لم يرد"'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Duplicate mark/unmark confirmation — both actions used to fire on a single click */}
      <ConfirmDialog
        open={duplicateConfirm !== null}
        onOpenChange={(open) => { if (!open) setDuplicateConfirm(null); }}
        title={duplicateConfirm?.action === "mark" ? "تعليم الأوردر كمكرر" : "إلغاء تعليم التكرار"}
        description={
          duplicateConfirm?.action === "mark"
            ? "سيتم تعليم هذا الأوردر كمكرر حتى تتم مراجعته."
            : "سيُزال تعليم التكرار عن هذا الأوردر."
        }
        confirmLabel={duplicateConfirm?.action === "mark" ? "تعليم" : "إلغاء التعليم"}
        onConfirm={() => {
          if (!duplicateConfirm) return;
          if (duplicateConfirm.action === "mark") markDuplicateMutation.mutate({ orderId: duplicateConfirm.orderId });
          else unmarkDuplicateMutation.mutate({ orderId: duplicateConfirm.orderId });
          setDuplicateConfirm(null);
        }}
        pending={markDuplicateMutation.isPending || unmarkDuplicateMutation.isPending}
      />
    </div>
  );
}

// ==================== EDIT HISTORY PANEL ====================
function EditHistoryPanel({ orderId }: { orderId: number }) {
  const { data: logs, isLoading, isError, refetch } = trpc.employeePortal.getOrderEditHistory.useQuery({ orderId });

  if (isLoading) return <LoadingSkeleton variant="table" rows={2} className="py-2" />;
  if (isError) {
    return (
      <ErrorState
        title="تعذّر تحميل سجل التعديلات"
        onRetry={() => refetch()}
        className="py-4"
      />
    );
  }
  if (!logs || logs.length === 0) return <div className="text-xs text-muted-foreground py-2">لا توجد تعديلات سابقة</div>;

  return (
    <div className="max-h-40 overflow-y-auto rounded-[var(--radius-brand-md)] border border-border bg-muted/50 p-2">
      <p className="text-xs font-semibold text-foreground mb-2">سجل التعديلات:</p>
      <div className="space-y-2">
        {logs.map((log: any, i: number) => (
          <div key={i} className="text-xs border-b border-border pb-1 last:border-0">
            <div className="flex items-center justify-between">
              <span className="font-medium text-foreground">{log.editedByName}</span>
              <span className="text-muted-foreground">{new Date(log.editedAt).toLocaleString('ar-EG')}</span>
            </div>
            <div className="mt-0.5 text-muted-foreground">
              <span className="font-medium">{log.fieldName}:</span>{' '}
              <span className="text-destructive line-through">{log.oldValue || '(فارغ)'}</span>{' → '}
              <span className="text-[var(--success)]">{log.newValue || '(فارغ)'}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ==================== TASKS PANEL ====================
function EmployeeTasksPanel({ employeeId }: { employeeId?: number }) {
  const utils = trpc.useUtils();
  // هوية البوابة فقط (employeePortal.tasks) — كانت tasks.list بجلسة المالك فالموظف العادي ماكانش بيشوف مهامه.
  const { data: tasksList, isLoading, isError, refetch } = trpc.employeePortal.tasks.listMine.useQuery(
    undefined,
    { enabled: !!employeeId, refetchInterval: 30000 }
  );

  const updateStatusMutation = trpc.employeePortal.tasks.updateMyStatus.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث حالة المهمة");
      utils.employeePortal.tasks.listMine.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const TASK_STATUS: Record<string, { label: string; tone: "info" | "warning" | "success" }> = {
    new: { label: "جديدة", tone: "info" },
    in_progress: { label: "قيد التنفيذ", tone: "warning" },
    done: { label: "تمت", tone: "success" },
  };

  const pendingTasks = (tasksList ?? []).filter((t: any) => t.status !== 'done');
  const doneTasks = (tasksList ?? []).filter((t: any) => t.status === 'done');

  return (
    <SectionCard
      testId="employee-tasks-panel"
      icon={<MessageSquare className="h-4 w-4 text-primary" aria-hidden="true" />}
      title={isLoading || isError ? "المهام" : `المهام (${pendingTasks.length} مهمة نشطة)`}
    >
      {isLoading ? (
        <LoadingSkeleton variant="table" rows={2} />
      ) : isError ? (
        <ErrorState title="تعذّر تحميل المهام" onRetry={() => refetch()} className="py-6" />
      ) : pendingTasks.length === 0 && doneTasks.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">لا توجد مهام حالياً</p>
      ) : (
        <div className="space-y-2">
          {pendingTasks.map((task: any) => {
            const statusConf = TASK_STATUS[task.status] ?? TASK_STATUS.new;
            return (
              <div key={task.id} className="rounded-[var(--radius-brand-md)] border border-border p-3 transition-colors hover:bg-muted/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <h4 className="font-semibold text-foreground text-sm">{task.title}</h4>
                      <StatusBadge status={task.status} label={statusConf.label} tone={statusConf.tone} size="sm" icon={null} />
                    </div>
                    {task.description && (
                      <p className="text-xs text-muted-foreground leading-relaxed mb-1">{task.description}</p>
                    )}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{new Date(task.createdAt).toLocaleDateString('ar-EG')}</span>
                      <span aria-hidden="true">•</span>
                      <span>{task.createdByName}</span>
                    </div>
                  </div>
                  <Select
                    value={task.status}
                    onValueChange={(v: any) => updateStatusMutation.mutate({ taskId: task.id, status: v })}
                  >
                    <SelectTrigger data-readonly-write className="min-h-11 md:min-h-9 w-28 text-xs h-7 shrink-0" aria-label="حالة المهمة">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">جديدة</SelectItem>
                      <SelectItem value="in_progress">قيد التنفيذ</SelectItem>
                      <SelectItem value="done">تمت</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            );
          })}

          {doneTasks.length > 0 && (
            <details className="mt-2">
              <summary className="flex min-h-11 cursor-pointer items-center text-xs text-muted-foreground hover:text-foreground md:min-h-0">
                مهام مكتملة ({doneTasks.length})
              </summary>
              <div className="space-y-1 mt-2">
                {doneTasks.slice(0, 5).map((task: any) => (
                  <div key={task.id} className="rounded-[var(--radius-brand-md)] border border-[var(--success)]/30 bg-[var(--success)]/10 p-2">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 text-[var(--success)] shrink-0" />
                      <span className="text-sm text-foreground line-through">{task.title}</span>
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ==================== STOCK VARIANTS (view only) ====================
// Same cells the old hand-rolled table rendered; ResponsiveDataTable swaps them for cards below md.
const variantIsLow = (v: any) => v.currentStock <= v.minStockLevel;
const variantPrice = (v: any) => (v.price ? `${Number(v.price).toLocaleString('ar-EG')} ج.م` : '-');
const VariantStockBadge = ({ v }: { v: any }) => (
  variantIsLow(v)
    ? <StatusBadge kind="stock" status="low" label="ينفد" tone="danger" size="sm" />
    : <StatusBadge kind="stock" status="available" label="متوفر" tone="success" size="sm" />
);

const STOCK_VARIANT_COLUMNS: Column<any>[] = [
  { id: "color", header: "اللون", cell: v => <span className="font-medium text-foreground">{v.color || '-'}</span> },
  { id: "size", header: "المقاس", cell: v => <span className="text-muted-foreground">{v.size || '-'}</span> },
  { id: "price", header: "السعر", numeric: true, cell: v => <span className="font-bold text-primary">{variantPrice(v)}</span> },
  {
    id: "stock", header: "المخزون", numeric: true,
    cell: v => <span className={`font-bold ${variantIsLow(v) ? 'text-destructive' : 'text-foreground'}`}>{v.currentStock}</span>,
  },
  { id: "status", header: "الحالة", cell: v => <VariantStockBadge v={v} /> },
];

function StockVariantCard({ v }: { v: any }) {
  const isLow = variantIsLow(v);
  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-[var(--radius-brand-md)] border p-3 ${
        isLow ? 'border-destructive/30 bg-destructive/10' : 'border-border bg-card'
      }`}
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">
          {v.color || '-'} <span className="text-muted-foreground">· {v.size || '-'}</span>
        </p>
        <p className="text-xs font-bold text-primary tabular-nums">{variantPrice(v)}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className={`text-base font-bold tabular-nums ${isLow ? 'text-destructive' : 'text-foreground'}`}>{v.currentStock}</span>
        <VariantStockBadge v={v} />
      </div>
    </div>
  );
}
