import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { useOperationalOptions } from "@/hooks/useOperationalOptions";
import { useGovernorateOptions } from "@/hooks/useGovernorateOptions";
import { usePermission } from "@/hooks/usePermission";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  LogOut, RefreshCw, Search, ChevronDown, ChevronUp, User,
  ShoppingBag, TrendingUp, AlertCircle, MessageSquare, Box, Save, Truck, Edit2, CalendarDays, Filter, CalendarRange, QrCode, Camera, CameraOff, Hash, CheckCircle
} from "lucide-react";
import QRCodeLib from "qrcode";
import jsQR from "jsqr";
import { BrandMark } from "@/components/BrandMark";
import { StatCard, ConfirmDialog, WhatsAppButton } from "@/components/shared";
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

  const { data: statsData } = trpc.employeePortal.stats.useQuery(
    selectedBusinessIds ? { businessIds: selectedBusinessIds } : undefined
  );

  // Broadcast message from manager
  const { data: broadcastData } = trpc.employeePortal.activeBroadcast.useQuery(
    undefined,
    { refetchInterval: 30000 } // تحديث كل 30 ثانية
  );

  // عرض المخزون وقائمة المنتجات (مفلتر حسب المجموعة المختارة)
  const { data: stockData } = trpc.employeePortal.stockLevels.useQuery(
    selectedBusinessIds ? { businessIds: selectedBusinessIds } : undefined
  );
  const { data: productsList } = trpc.employeePortal.stockLevels.useQuery(
    selectedBusinessIds ? { businessIds: selectedBusinessIds } : undefined
  );
  // variants للمنتجات (كفر مرتبة بمقاساتها وأسعارها)
  const { data: stockVariants } = trpc.employeePortal.stockVariants.useQuery(
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

  const { data: ordersData, isLoading, refetch } = trpc.employeePortal.myOrders.useQuery(
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
    onSuccess: () => {
      toast.success("تم تأكيد الأوردر");
      utils.employeePortal.myOrders.invalidate();
      utils.employeePortal.stats.invalidate();
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
    updateStatusMutation.mutate({ orderId: order.id, status: next as any });
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
      toast.success("✅ تم تعليم الأوردر كمكرر");
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
        toast.success("✅ تم تجهيز الأوردر بنجاح!");
      } else if (data.result === "duplicate") {
        toast.warning("⚠️ هذا الأوردر تم تجهيزه من قبل");
      } else if (data.result === "cancelled") {
        toast.error("🚫 هذا الأوردر ملغي");
      } else {
        toast.error("❌ QR غير صحيح");
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
    toast.success("✅ تم حفظ التعديلات");
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
    confirmMutation.mutate({ orderId: order.id });
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

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      {/* Header */}
      <header
        className="sticky top-0 z-40 shadow-md"
        style={{ background: "linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%)" }}
      >
        {/* صفّين على الموبايل، صف واحد من sm فوق: ٦ أيقونات أدوات + تحديث + خروج
            كانوا بيخنقوا الاسم لـ٤٢px على شاشة ٣٧٥ — بقى "سارة ..." وخلاص. */}
        <div className="mx-auto flex max-w-2xl flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-3 lg:max-w-6xl">
          <div className="flex min-w-0 items-center gap-3">
            <BrandMark className="w-9 h-9 shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-sm font-bold leading-tight text-white">{employeeName}</p>
              {/* "فاضلك كام" — أهم رقم في شاشة التأكيدات، وكان مش معروض في أي مكان.
                  مكانه جنب الاسم عشان يتشاف من غير ما الموظف ينزل بصره. */}
              <p className="text-xs text-white/75">
                {remainingCount > 0
                  ? <>متبقّي <span className="font-bold tabular-nums text-white">{remainingCount.toLocaleString('ar-EG')}</span> طلب</>
                  : 'خلصت كل الطلبات ✅'}
              </p>
            </div>
          </div>
          <div className="flex items-center justify-end gap-1.5">
            <button
              onClick={() => setLocation("/today-shipments")}
              className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors"
              title="شحنات اليوم"
            >
              <Truck className="h-4 w-4" />
            </button>
            <button
              onClick={() => setLocation("/shipping-schedule")}
              className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors"
              title="جدول توزيع المحافظات"
            >
              <CalendarRange className="h-4 w-4" />
            </button>
            {/* الحالة النشطة كانت بألوان Tailwind خام (amber-500/green-500) جوه هيدر
                متدرّج بلون الهوية — بقت شفافية بيضا موحّدة، فبتقرا كـ"مفعّل" في أي ثيم. */}
            <button
              onClick={() => setShowDateFilter(!showDateFilter)}
              aria-pressed={Boolean(dateFrom || dateTo)}
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-white transition-colors ${
                (dateFrom || dateTo) ? 'bg-white/35 hover:bg-white/45' : 'bg-white/10 hover:bg-white/20'
              }`}
              title="فلتر التاريخ"
            >
              <CalendarDays className="h-4 w-4" />
            </button>
            <button
              onClick={() => { setShowScanPanel(!showScanPanel); if (showScanPanel) stopScanCamera(); setScanResult(null); }}
              aria-pressed={showScanPanel}
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-white transition-colors ${
                showScanPanel ? 'bg-white/35 hover:bg-white/45' : 'bg-white/10 hover:bg-white/20'
              }`}
              title="مسح QR"
            >
              <QrCode className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowTasksPanel(!showTasksPanel)}
              aria-pressed={showTasksPanel}
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-white transition-colors ${
                showTasksPanel ? 'bg-white/35 hover:bg-white/45' : 'bg-white/10 hover:bg-white/20'
              }`}
              title="المهام"
            >
              <MessageSquare className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowStockPanel(!showStockPanel)}
              aria-pressed={showStockPanel}
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-white transition-colors ${
                showStockPanel ? 'bg-white/35 hover:bg-white/45' : 'bg-white/10 hover:bg-white/20'
              }`}
              title="المخزون"
            >
              <Box className="h-4 w-4" />
            </button>

            {/* التحديث والخروج مش أدوات تنقل — كانوا مدفونين كأيقونتين وسط ٦ زيهم بالظبط.
                فاصل + نص على الشاشات الأوسع بيخليهم يتلقطوا من غير ما الموظف يخمّن. */}
            <span className="mx-1 h-5 w-px bg-white/25" />
            <button
              onClick={() => refetch()}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-2 text-white transition-colors hover:bg-white/20"
              title="تحديث القائمة"
            >
              <RefreshCw className="h-4 w-4" />
              <span className="hidden text-xs font-medium sm:inline">تحديث</span>
            </button>
            <button
              onClick={handleLogout}
              className="flex h-8 items-center gap-1.5 rounded-lg bg-white/10 px-2 text-white transition-colors hover:bg-white/25"
              title="تسجيل الخروج"
            >
              <LogOut className="h-4 w-4" />
              <span className="hidden text-xs font-medium sm:inline">خروج</span>
            </button>
          </div>
        </div>
      </header>

      {/* الصفحة كانت محبوسة في max-w-2xl على كل المقاسات — على الديسكتوب كانت عمود
          ضيّق وسط شاشة فاضية. mobile-first زي ما هي، بس بتتوسّع بدل ما تتجمّد. */}
      <div className="mx-auto max-w-2xl space-y-4 px-4 py-4 lg:max-w-6xl">
        {/* Business Group Filter - نحاس / مفروشات */}
        {groupsData.length > 0 && (
          <div className="flex gap-2">
            <button
              onClick={() => setSelectedGroupId(undefined)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${
                !selectedGroupId
                  ? 'bg-[var(--warning)] text-white shadow-md'
                  : 'bg-card text-muted-foreground border border-border hover:border-[var(--warning)]/30'
              }`}
            >
              كل الأقسام
            </button>
            {groupsData.map((group: any) => (
              <button
                key={group.id}
                onClick={() => setSelectedGroupId(group.id)}
                className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${
                  selectedGroupId === group.id
                    ? 'bg-[var(--warning)] text-white shadow-md'
                    : 'bg-card text-muted-foreground border border-border hover:border-[var(--warning)]/30'
                }`}
              >
                {group.name}
              </button>
            ))}
          </div>
        )}

        {/* Stock Panel - مخزون شامل بالمنتجات والمقاسات والأسعار */}
        {showStockPanel && (
          <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 bg-[var(--warning)]/10 border-b border-[var(--warning)]/30">
              <h3 className="font-bold text-foreground flex items-center gap-2">
                <Box className="h-4 w-4 text-[var(--warning)]" />
                جرد المخزون
                {selectedGroupId && (
                  <span className="text-xs font-normal text-[var(--warning)] bg-[var(--warning)]/10 px-2 py-0.5 rounded-full">
                    {groupsData.find((g: any) => g.id === selectedGroupId)?.name || ''}
                  </span>
                )}
              </h3>
              <button onClick={() => setShowStockPanel(false)} className="text-muted-foreground hover:text-muted-foreground">
                <XCircle className="h-4 w-4" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* منتجات بدون variants (أساور نحاس) */}
              {stockData && stockData.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">الأصناف</p>
                  <div className="grid grid-cols-2 gap-2">
                    {stockData.map((p: any) => {
                      const isLow = p.currentStock <= p.minStockLevel;
                      return (
                        <div
                          key={p.id}
                          className={`rounded-lg p-3 border ${
                            isLow ? 'bg-destructive/10 border-destructive/30' : 'bg-muted/50 border-border'
                          }`}
                        >
                          <p className="text-xs text-muted-foreground truncate" title={p.name}>{p.name}</p>
                          <p className={`text-lg font-bold mt-0.5 ${
                            isLow ? 'text-destructive' : 'text-foreground'
                          }`}>
                            {p.currentStock} <span className="text-xs font-normal text-muted-foreground">قطعة</span>
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">سعر: {Number(p.price).toLocaleString('ar-EG')} ج.م</p>
                          {isLow && (
                            <p className="text-xs text-destructive flex items-center gap-1 mt-0.5">
                              <AlertCircle className="h-3 w-3" /> مخزون منخفض
                            </p>
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
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">المقاسات والألوان</p>
                    {Object.entries(grouped).map(([productId, group]) => (
                      <div key={productId} className="mb-3">
                        <p className="text-sm font-bold text-foreground mb-2 flex items-center gap-2">
                          <Package className="h-3.5 w-3.5 text-[var(--warning)]" />
                          {group.productName}
                          <span className="text-xs font-normal text-muted-foreground">
                            (إجمالي: {group.variants.reduce((s: number, v: any) => s + v.currentStock, 0)} قطعة)
                          </span>
                        </p>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs border-collapse">
                            <thead>
                              <tr className="bg-muted/50">
                                <th className="text-right py-1.5 px-2 font-semibold text-muted-foreground border border-border">اللون</th>
                                <th className="text-right py-1.5 px-2 font-semibold text-muted-foreground border border-border">المقاس</th>
                                <th className="text-center py-1.5 px-2 font-semibold text-muted-foreground border border-border">السعر</th>
                                <th className="text-center py-1.5 px-2 font-semibold text-muted-foreground border border-border">المخزون</th>
                                <th className="text-center py-1.5 px-2 font-semibold text-muted-foreground border border-border">الحالة</th>
                              </tr>
                            </thead>
                            <tbody>
                              {group.variants.map((v: any) => {
                                const isLow = v.currentStock <= v.minStockLevel;
                                return (
                                  <tr key={v.id} className={isLow ? 'bg-destructive/10' : 'bg-card'}>
                                    <td className="py-1.5 px-2 border border-border font-medium text-foreground">{v.color || '-'}</td>
                                    <td className="py-1.5 px-2 border border-border text-muted-foreground">{v.size || '-'}</td>
                                    <td className="py-1.5 px-2 border border-border text-center font-bold text-[var(--warning)]">
                                      {v.price ? `${Number(v.price).toLocaleString('ar-EG')} ج.م` : '-'}
                                    </td>
                                    <td className={`py-1.5 px-2 border border-border text-center font-bold ${
                                      isLow ? 'text-destructive' : 'text-foreground'
                                    }`}>
                                      {v.currentStock}
                                    </td>
                                    <td className="py-1.5 px-2 border border-border text-center">
                                      {isLow ? (
                                        <span className="text-destructive font-semibold">ينفد</span>
                                      ) : (
                                        <span className="text-[var(--success)] font-semibold">متوفر</span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}

              {(!stockData || stockData.length === 0) && (!stockVariants || stockVariants.length === 0) && (
                <p className="text-center text-muted-foreground text-sm py-4">لا توجد بيانات مخزون</p>
              )}
            </div>
          </div>
        )}

        {/* QR Scan Panel */}
        {showScanPanel && (
          <div className="bg-card rounded-2xl border border-border shadow-sm overflow-hidden" dir="rtl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-gradient-to-l from-[var(--success)]/10 to-[var(--success)]/5">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-[var(--success)]/10 flex items-center justify-center">
                  <QrCode className="h-4 w-4 text-[var(--success)]" />
                </div>
                <div>
                  <p className="text-sm font-bold text-foreground">مسح QR - تجهيز الأوردرات</p>
                  <p className="text-xs text-muted-foreground">افتح الكاميرا أو أدخل السيريال يدوياً</p>
                </div>
              </div>
              <button
                onClick={() => { setShowScanPanel(false); stopScanCamera(); setScanResult(null); }}
                className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center text-muted-foreground hover:bg-muted"
              >
                <XCircle className="h-4 w-4" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {/* Camera scanner */}
              <div className="flex flex-col items-center gap-3">
                {/* Video element for native camera */}
                <div
                  className={`relative w-full rounded-xl overflow-hidden bg-black ${
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
                    <div className="w-48 h-48 border-2 border-white/70 rounded-xl relative">
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
                  <div className="w-full bg-muted rounded-xl h-40 flex items-center justify-center border-2 border-dashed border-[var(--success)]/30">
                    <div className="text-center text-muted-foreground">
                      <CameraOff className="h-10 w-10 mx-auto mb-2 opacity-50" />
                      <p className="text-xs">اضغط لتشغيل الكاميرا</p>
                    </div>
                  </div>
                )}

                {scanCameraError && (
                  <div className="w-full bg-destructive/10 border border-destructive/30 rounded-xl p-4 text-center">
                    <XCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
                    <p className="text-sm text-destructive">{scanCameraError}</p>
                  </div>
                )}
                {!scanIsScanning ? (
                  <button
                    onClick={startScanCamera}
                    className="flex items-center gap-2 px-5 py-2.5 bg-[var(--success)] hover:bg-[var(--success)] text-white rounded-xl text-sm font-bold transition-colors w-full justify-center"
                  >
                    <Camera className="h-4 w-4" />
                    تشغيل الكاميرا
                  </button>
                ) : (
                  <button
                    onClick={stopScanCamera}
                    className="flex items-center gap-2 px-5 py-2.5 bg-destructive hover:bg-destructive text-white rounded-xl text-sm font-bold transition-colors w-full justify-center"
                  >
                    <CameraOff className="h-4 w-4" />
                    إيقاف الكاميرا
                  </button>
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
                    className="flex-1 text-sm text-right"
                    dir="ltr"
                  />
                  <Button type="submit" size="sm" className="bg-[var(--success)] hover:bg-[var(--success)] text-white" disabled={scanMutation.isPending}>
                    <Hash className="h-4 w-4" />
                  </Button>
                </form>
              </div>

              {/* Scan result */}
              {scanMutation.isPending && (
                <div className="flex items-center justify-center gap-2 py-3 text-muted-foreground text-sm">
                  <RefreshCw className="h-4 w-4 animate-spin" />
                  جاري التحقق...
                </div>
              )}
              {scanResult && !scanMutation.isPending && (
                <div className={`rounded-xl p-4 border ${
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
                      {scanResult.success ? '✅ تم التجهيز بنجاح' :
                       scanResult.result === 'duplicate' ? '⚠️ تم تجهيزه من قبل' :
                       scanResult.result === 'cancelled' ? '🚫 أوردر ملغي' : `❌ QR غير صحيح`}
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
                  <button
                    onClick={() => { setScanResult(null); }}
                    className="mt-3 text-xs text-muted-foreground underline"
                  >
                    مسح ومسح جديد
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tasks Panel */}
        {showTasksPanel && <EmployeeTasksPanel employeeId={meData?.id} />}

        {/* Broadcast Message - Notification احترافي */}
        {broadcastData && (
          <div className="relative overflow-hidden bg-gradient-to-l from-[var(--warning)]/10 to-[var(--warning)]/5 border border-[var(--warning)]/30 rounded-xl p-4 shadow-sm">
            <div className="absolute top-0 left-0 w-1 h-full bg-[var(--warning)]"></div>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-[var(--warning)]/10 border border-[var(--warning)]/30 flex items-center justify-center shrink-0">
                <span className="text-lg">📢</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-sm font-bold text-[var(--warning)]">رسالة من الإدارة</h4>
                  <span className="text-xs text-[var(--warning)] bg-[var(--warning)]/10 px-2 py-0.5 rounded-full">إشعار</span>
                </div>
                <p className="text-sm text-foreground leading-relaxed">{broadcastData.message}</p>
                <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                  <span className="font-medium text-[var(--warning)]">{broadcastData.sentByName}</span>
                  <span>•</span>
                  <span>{new Date(broadcastData.createdAt).toLocaleString('ar-EG')}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Date Filter Panel */}
        {showDateFilter && (
          <div className="bg-card rounded-xl border border-[var(--warning)]/30 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-foreground flex items-center gap-2">
                <CalendarDays className="h-4 w-4 text-[var(--warning)]" />
                فلتر التاريخ
              </h3>
              <button onClick={() => setShowDateFilter(false)} className="text-muted-foreground hover:text-muted-foreground">
                <XCircle className="h-4 w-4" />
              </button>
            </div>
            {/* أزرار سريعة */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => { setDateFrom(""); setDateTo(""); }}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                  !dateFrom && !dateTo ? 'bg-[var(--warning)] text-white shadow-sm' : 'bg-muted text-muted-foreground hover:bg-muted'
                }`}
              >اليوم</button>
              <button
                onClick={() => {
                  const yesterday = new Date(Date.now() + 2*60*60*1000);
                  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
                  const yStr = yesterday.toISOString().slice(0, 10);
                  setDateFrom(yStr); setDateTo(yStr);
                }}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                  dateFrom && dateTo && dateFrom === dateTo && dateFrom === (() => { const y = new Date(Date.now() + 2*60*60*1000); y.setUTCDate(y.getUTCDate() - 1); return y.toISOString().slice(0, 10); })()
                    ? 'bg-[var(--warning)] text-white shadow-sm' : 'bg-muted text-muted-foreground hover:bg-muted'
                }`}
              >أمس</button>
              <button
                onClick={() => { setDateFrom("2024-01-01"); setDateTo(""); }}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                  dateFrom === '2024-01-01' && !dateTo ? 'bg-[var(--warning)] text-white shadow-sm' : 'bg-muted text-muted-foreground hover:bg-muted'
                }`}
              >كل الأوردرات</button>
            </div>
            {/* تاريخ مخصص */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">من تاريخ</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--warning)]/30"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">إلى تاريخ</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={e => setDateTo(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--warning)]/30"
                />
              </div>
            </div>
            {(dateFrom || dateTo) && (
              <p className="text-xs text-[var(--warning)] bg-[var(--warning)]/10 rounded-lg px-3 py-2 mt-2 flex items-center gap-1">
                <Filter className="h-3 w-3" />
                يتم عرض الأوردرات المسندة في الفترة المحددة
              </p>
            )}
          </div>
        )}

        {/* Stats Row — each tile doubles as a quick filter into the tab it names.
            سبع بطاقات مش أربعة: "ملغي" و"لم يرد" و"يحتاج مراجعة" كانوا في شرايط الفلترة
            بس، فالموظف مكانش شايف أرقامهم. على الموبايل شريط بيتمرّر جوه نفسه (نفس نمط
            صفحة الأوردرات)، وعلى الشاشات الأوسع جريد كامل. */}
        <div className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-7 lg:overflow-visible [&>*]:min-w-[128px] [&>*]:snap-start lg:[&>*]:min-w-0">
          <StatCard label="الكل" value={displayStats?.total ?? 0} active={activeTab === "all"} onClick={() => setActiveTab("all")} />
          <StatCard label="جديد" value={displayStats?.new ?? 0} tone="primary" active={activeTab === "new"} onClick={() => setActiveTab("new")} />
          <StatCard label="مؤكد" value={displayStats?.confirmed ?? 0} tone="success" active={activeTab === "confirmed"} onClick={() => setActiveTab("confirmed")} />
          <StatCard label="مؤجل" value={displayStats?.postponed ?? 0} tone="warning" active={activeTab === "postponed"} onClick={() => setActiveTab("postponed")} />
          <StatCard label="ملغي" value={displayStats?.cancelled ?? 0} tone="danger" active={activeTab === "cancelled"} onClick={() => setActiveTab("cancelled")} />
          <StatCard label="لم يرد" value={displayStats?.no_answer ?? 0} tone="warning" active={activeTab === "no_answer"} onClick={() => setActiveTab("no_answer")} />
          <StatCard label="يحتاج مراجعة" value={reviewCount} tone="info" active={activeTab === "needs_review"} onClick={() => setActiveTab("needs_review")} />
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="بحث بالاسم أو الهاتف أو رقم الأوردر..."
            className="pr-10 bg-card"
          />
        </div>

        {/* Tabs */}
        <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          {tabs.map(tab => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-full text-sm font-medium transition-all flex items-center gap-1.5 ${
                activeTab === tab.key
                  ? "bg-primary text-primary-foreground shadow-[var(--shadow-card)]"
                  : "bg-card text-muted-foreground border border-border hover:border-primary/40"
              }`}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className={`text-xs rounded-full px-1.5 py-0.5 ${
                  activeTab === tab.key ? "bg-white/20" : "bg-muted"
                }`}>
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Orders List */}
        {isLoading ? (
          <div className="space-y-3">
            {[1,2,3].map(i => (
              <div key={i} className="animate-pulse rounded-[var(--radius-brand-md)] border border-border bg-card p-4">
                <div className="mb-2 h-4 w-3/4 rounded bg-muted" />
                <div className="h-3 w-1/2 rounded bg-muted/60" />
              </div>
            ))}
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="rounded-[var(--radius-brand-md)] border border-border bg-card p-10 text-center shadow-[var(--shadow-card)]">
            <ShoppingBag className="mx-auto mb-3 h-10 w-10 text-muted-foreground/40" />
            <p className="font-medium text-muted-foreground">لا توجد أوردرات</p>
            <p className="mt-1 text-sm text-muted-foreground/70">
              {search ? "جرب بحثاً مختلفاً" : "لم يتم تعيين أوردرات لك بعد"}
            </p>
          </div>
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
                    className="p-4 cursor-pointer"
                    onClick={() => setExpandedOrder(isExpanded ? null : order.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold">{order.customerName}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${statusConf.bg} ${statusConf.color}`}>
                            {statusConf.label}
                          </span>
                          {order.source && (
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              {sourceOptions.find(option => option.value === order.source)?.label ?? order.source}
                            </span>
                          )}
                          {/* Orders whose items could not be mapped to the catalog need a
                              human before they are confirmed — say so up front. */}
                          {order.needsReview && (
                            <span className="flex items-center gap-1 rounded-full border border-[var(--warning)]/40 bg-[var(--warning)]/15 px-2 py-0.5 text-xs font-medium text-[var(--warning)]">
                              <AlertCircle className="h-3 w-3" />
                              تحتاج مراجعة
                            </span>
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
                        <SelectTrigger className="h-9 flex-1 bg-card"><SelectValue /></SelectTrigger>
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
                      <Button
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
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); goToAdjacentOrder(-1); }}
                            className="flex items-center gap-1 rounded-[var(--radius-brand-sm)] px-2 py-1 hover:bg-muted"
                          >
                            <ChevronRight className="h-3.5 w-3.5" /> السابق
                          </button>
                          <span className="tabular-nums">{expandedIndex + 1} / {filteredOrders.length}</span>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); goToAdjacentOrder(1); }}
                            className="flex items-center gap-1 rounded-[var(--radius-brand-sm)] px-2 py-1 hover:bg-muted"
                          >
                            التالي <ChevronLeft className="h-3.5 w-3.5" />
                          </button>
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
                            <button
                              onClick={() => handleSaveNotes(order.id)}
                              disabled={updateNotesMutation.isPending}
                              className="flex items-center gap-1 text-xs font-medium text-[var(--success)] hover:opacity-80"
                            >
                              <Save className="h-3 w-3" />
                              {updateNotesMutation.isPending ? 'جاري...' : 'حفظ'}
                            </button>
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
                          <button
                            className="flex items-center gap-1 rounded-[var(--radius-brand-sm)] border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-2 py-1 text-xs text-[var(--warning)] hover:bg-[var(--warning)]/20"
                            onClick={() => setDuplicateConfirm({ orderId: order.id, action: "unmark" })}
                            disabled={unmarkDuplicateMutation.isPending}
                            title="إلغاء تعليم التكرار"
                          >
                            <span>⚠️ مكرر</span>
                          </button>
                        ) : (
                          <button
                            className="flex items-center gap-1 rounded-[var(--radius-brand-sm)] border border-border px-2 py-1 text-xs text-muted-foreground hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setDuplicateConfirm({ orderId: order.id, action: "mark" })}
                            disabled={markDuplicateMutation.isPending}
                            title="تعليم كمكرر"
                          >
                            <span>مكرر</span>
                          </button>
                        )}
                      </div>

                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

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
            <button
              type="button"
              className="text-xs text-[var(--info)] underline"
              onClick={() => setShowEditHistory(!showEditHistory)}
            >
              {showEditHistory ? "إخفاء سجل التعديلات" : "عرض سجل التعديلات"}
            </button>
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
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => applyPostponePreset("today")}>مساء اليوم</Button>
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => applyPostponePreset("tomorrow")}>غدًا</Button>
            </div>
            <div>
              <Label>تاريخ الاتصال مرة أخرى <span className="text-destructive">*</span></Label>
              <Input
                type="date"
                value={postponeDate}
                onChange={e => setPostponeDate(e.target.value)}
                min={new Date().toISOString().split("T")[0]}
                className="mt-1"
              />
            </div>
            <div>
              <Label>ملاحظة (اختياري)</Label>
              <Input
                value={postponeNotes}
                onChange={e => setPostponeNotes(e.target.value)}
                placeholder="سبب التأجيل..."
                className="mt-1"
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
              className="h-11 gap-1.5 bg-[var(--warning)] text-white hover:bg-[var(--warning)]"
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
                <SelectTrigger className={`mt-1 w-full ${!cancelReason ? "border-destructive/30 bg-destructive/10" : ""}`}>
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
                  className={`mt-1 h-10 ${!cancelOtherReason.trim() ? "border-destructive/30 bg-destructive/10" : ""}`}
                />
              </div>
            )}
            <div>
              <Label>ملاحظة (اختياري)</Label>
              <Input
                value={cancelNotes}
                onChange={e => setCancelNotes(e.target.value)}
                placeholder="تفاصيل إضافية..."
                className="mt-1 h-10"
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
                  className="h-10"
                  onClick={() => setNoAnswerAttempts(String(n))}
                >
                  {n}
                </Button>
              ))}
            </div>
            <Input
              type="number" min={1} max={20} placeholder="أو رقم مختلف..."
              value={noAnswerAttempts} onChange={e => setNoAnswerAttempts(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNoAnswerDialog({ open: false, orderId: null })}>رجوع</Button>
            <Button
              disabled={noAnswerMutation.isPending}
              onClick={() => {
                if (!noAnswerDialog.orderId) return;
                const attempts = noAnswerAttempts ? Number(noAnswerAttempts) : undefined;
                setBusyOrderId(noAnswerDialog.orderId);
                noAnswerMutation.mutate({ orderId: noAnswerDialog.orderId, callAttempts: attempts });
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
  const { data: logs, isLoading } = trpc.employeePortal.getOrderEditHistory.useQuery({ orderId });

  if (isLoading) return <div className="text-xs text-muted-foreground py-2">جاري تحميل السجل...</div>;
  if (!logs || logs.length === 0) return <div className="text-xs text-muted-foreground py-2">لا توجد تعديلات سابقة</div>;

  return (
    <div className="border border-border rounded-lg p-2 max-h-40 overflow-y-auto bg-muted/50">
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
  const { data: tasksList, isLoading } = trpc.tasks.list.useQuery(
    { employeeId: employeeId ?? undefined },
    { enabled: !!employeeId, refetchInterval: 30000 }
  );

  const updateStatusMutation = trpc.tasks.updateStatus.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث حالة المهمة");
      utils.tasks.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const TASK_STATUS: Record<string, { label: string; color: string; bg: string }> = {
    new: { label: "جديدة", color: "text-[var(--info)]", bg: "bg-[var(--info)]/10 border-[var(--info)]/30" },
    in_progress: { label: "قيد التنفيذ", color: "text-[var(--warning)]", bg: "bg-[var(--warning)]/10 border-[var(--warning)]/30" },
    done: { label: "تمت", color: "text-[var(--success)]", bg: "bg-[var(--success)]/10 border-[var(--success)]/30" },
  };

  if (isLoading) {
    return (
      <div className="bg-card rounded-xl border border-border shadow-sm p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-muted rounded w-1/3" />
          <div className="h-16 bg-muted rounded" />
          <div className="h-16 bg-muted rounded" />
        </div>
      </div>
    );
  }

  const pendingTasks = (tasksList ?? []).filter((t: any) => t.status !== 'done');
  const doneTasks = (tasksList ?? []).filter((t: any) => t.status === 'done');

  return (
    <div className="bg-card rounded-xl border border-border shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-bold text-foreground flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-[var(--warning)]" />
          المهام ({pendingTasks.length} مهمة نشطة)
        </h3>
      </div>

      {pendingTasks.length === 0 && doneTasks.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">لا توجد مهام حالياً</p>
      ) : (
        <div className="space-y-2">
          {pendingTasks.map((task: any) => {
            const statusConf = TASK_STATUS[task.status] ?? TASK_STATUS.new;
            return (
              <div key={task.id} className="border border-border rounded-lg p-3 hover:bg-muted/50 transition-colors">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h4 className="font-semibold text-foreground text-sm">{task.title}</h4>
                      <Badge className={`${statusConf.bg} ${statusConf.color} border text-xs px-1.5 py-0`}>
                        {statusConf.label}
                      </Badge>
                    </div>
                    {task.description && (
                      <p className="text-xs text-muted-foreground leading-relaxed mb-1">{task.description}</p>
                    )}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{new Date(task.createdAt).toLocaleDateString('ar-EG')}</span>
                      <span>•</span>
                      <span>{task.createdByName}</span>
                    </div>
                  </div>
                  <Select
                    value={task.status}
                    onValueChange={(v: any) => updateStatusMutation.mutate({ taskId: task.id, status: v })}
                  >
                    <SelectTrigger className="w-28 text-xs h-7 shrink-0">
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
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                مهام مكتملة ({doneTasks.length})
              </summary>
              <div className="space-y-1 mt-2">
                {doneTasks.slice(0, 5).map((task: any) => (
                  <div key={task.id} className="border border-[var(--success)]/30 rounded-lg p-2 bg-[var(--success)]/10">
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
    </div>
  );
}
