import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
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
  CheckCircle2, XCircle, Clock, Phone, MapPin, Package,
  LogOut, RefreshCw, Search, ChevronDown, ChevronUp, User,
  ShoppingBag, TrendingUp, AlertCircle, MessageSquare, Box, Save, Truck, Edit2, CalendarDays, Filter, CalendarRange, QrCode, Camera, CameraOff, Hash, CheckCircle
} from "lucide-react";
import QRCodeLib from "qrcode";
import jsQR from "jsqr";
import { BrandMark } from "@/components/BrandMark";
import { StatCard, ConfirmDialog, WhatsAppButton } from "@/components/shared";
import { ChevronRight, ChevronLeft } from "lucide-react";
import { getMissingConfirmationFields } from "@/lib/orderConfirmationValidation";

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

const CANCEL_REASONS = [
  { value: "price",        label: "السعر مرتفع" },
  { value: "not_serious",  label: "غير جاد" },
  { value: "wrong_number", label: "رقم خطأ" },
  { value: "duplicate",    label: "طلب مكرر" },
];

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

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  easyorder: { label: "Easy Order", color: "bg-muted text-muted-foreground" },
  facebook:  { label: "فيسبوك", color: "bg-muted text-muted-foreground" },
  whatsapp:  { label: "واتسآب", color: "bg-muted text-muted-foreground" },
  shopify:   { label: "Shopify", color: "bg-muted text-muted-foreground" },
  manual:    { label: "يدوي", color: "bg-muted text-muted-foreground" },
};

export default function EmployeeDashboard() {
  const [, setLocation] = useLocation();
  const [activeTab, setActiveTab] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [expandedOrder, setExpandedOrder] = useState<number | null>(null);

  // Action dialogs
  const [postponeDialog, setPostponeDialog] = useState<{ open: boolean; orderId: number | null }>({ open: false, orderId: null });
  const [cancelDialog, setCancelDialog] = useState<{ open: boolean; orderId: number | null }>({ open: false, orderId: null });
  const [postponeDate, setPostponeDate] = useState("");
  const [postponeNotes, setPostponeNotes] = useState("");
  const [cancelReason, setCancelReason] = useState<string>("");
  const [cancelNotes, setCancelNotes] = useState("");

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
  const [editDialog, setEditDialog] = useState<{ open: boolean; orderId: number | null }>({ open: false, orderId: null });
  const [editProductName, setEditProductName] = useState("");
  const [editQuantity, setEditQuantity] = useState<number>(1);
  const [editTotalAmount, setEditTotalAmount] = useState<number>(0);
  const [editNotes, setEditNotes] = useState("");
  const [editGovernorate, setEditGovernorate] = useState("");
  const [editAddress, setEditAddress] = useState("");
  const [editCustomerName, setEditCustomerName] = useState("");
  const [editCustomerPhone, setEditCustomerPhone] = useState("");
  const [editCustomerPhone2, setEditCustomerPhone2] = useState("");
  const [editCity, setEditCity] = useState("");
  const [editShippingFees, setEditShippingFees] = useState<number>(0);
  const [editPaymentMethod, setEditPaymentMethod] = useState<string>("cod");
  const [editEmployeeNotes, setEditEmployeeNotes] = useState("");
  const [editColor, setEditColor] = useState("");
  const [editSize, setEditSize] = useState("");
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
  });

  const cancelMutation = trpc.employeePortal.cancel.useMutation({
    onSuccess: () => {
      toast.success("تم إلغاء الأوردر");
      setCancelDialog({ open: false, orderId: null });
      setCancelReason(""); setCancelNotes("");
      utils.employeePortal.myOrders.invalidate();
      utils.employeePortal.stats.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const noAnswerMutation = trpc.employeePortal.markNoAnswer.useMutation({
    onSuccess: () => {
      toast.success("تم تسجيل لم يرد");
      utils.employeePortal.myOrders.invalidate();
      utils.employeePortal.stats.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const updateNotesMutation = trpc.employeePortal.updateNotes.useMutation({
    onSuccess: () => {
      toast.success("تم حفظ الملاحظة");
      utils.employeePortal.myOrders.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const editOrderMutation = trpc.employeePortal.editOrder.useMutation({
    onSuccess: () => {
      toast.success("✅ تم تعديل الأوردر بنجاح");
      utils.employeePortal.myOrders.invalidate();
      utils.employeePortal.stats.invalidate();
      setEditDialog({ open: false, orderId: null });
    },
    onError: (e) => toast.error(e.message),
  });

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

  const handleLogout = async () => {
    await fetch("/api/employee/logout", { method: "POST", credentials: "include" });
    localStorage.removeItem("employee_session");
    setLocation("/employee-login");
  };

  const handlePostpone = () => {
    if (!postponeDate) { toast.error("يرجى تحديد تاريخ التأجيل"); return; }
    if (!postponeDialog.orderId) return;
    postponeMutation.mutate({
      orderId: postponeDialog.orderId,
      postponedTo: new Date(postponeDate),
      notes: postponeNotes || undefined,
    });
  };

  const handleCancel = () => {
    if (!cancelReason) { toast.error("يرجى اختيار سبب الإلغاء"); return; }
    if (!cancelDialog.orderId) return;
    cancelMutation.mutate({
      orderId: cancelDialog.orderId,
      cancelReason: cancelReason as any,
      notes: cancelNotes || undefined,
    });
  };

  const reviewCount = (ordersData?.orders ?? []).filter((o: any) => o.needsReview).length;

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

  // ==================== Confirmation validation ====================
  // Blocks تأكيد with a clear reason instead of letting an order through with data the
  // confirmation call cannot act on (no phone to call, no address to ship to, ...).
  function handleConfirmOrder(order: any) {
    const missing = getMissingConfirmationFields(order);
    if (missing.length > 0) {
      toast.error(`لا يمكن التأكيد — بيانات ناقصة: ${missing.join("، ")}`);
      return;
    }
    confirmMutation.mutate({ orderId: order.id });
  }

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
          noAnswerMutation.mutate({ orderId: order.id });
          break;
        case "p":
          setPostponeDialog({ open: true, orderId: order.id });
          setPostponeDate(""); setPostponeNotes("");
          break;
        case "x":
          setCancelDialog({ open: true, orderId: order.id });
          setCancelReason(""); setCancelNotes("");
          break;
        case "e":
          setEditDialog({ open: true, orderId: order.id });
          setEditProductName(order.productName ?? "");
          setEditQuantity(order.quantity ?? 1);
          setEditTotalAmount(Number(order.totalAmount));
          setEditNotes(order.notes ?? "");
          setEditGovernorate(order.governorate ?? "");
          setEditAddress(order.customerAddress ?? "");
          setEditCustomerName(order.customerName ?? "");
          setEditCustomerPhone(order.customerPhone ?? "");
          setEditCustomerPhone2((order as any).customerPhone2 ?? "");
          setEditCity((order as any).city ?? "");
          setEditShippingFees(Number((order as any).shippingFees || 0));
          setEditPaymentMethod((order as any).paymentMethod ?? "cod");
          setEditEmployeeNotes((order as any).employeeNotes ?? "");
          setEditColor((order as any).color ?? "");
          setEditSize((order as any).size ?? "");
          setShowEditHistory(false);
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
        <div className="flex items-center justify-between px-4 py-3 max-w-2xl mx-auto">
          <div className="flex items-center gap-3">
            <BrandMark className="w-9 h-9" />
            <div>
              <p className="text-white font-bold text-sm leading-tight">متجرك</p>
              <p className="text-white/70 text-xs">أهلاً، {employeeName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
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
            <button
              onClick={() => setShowDateFilter(!showDateFilter)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center text-white transition-colors ${
                (dateFrom || dateTo) ? 'bg-amber-500/60 hover:bg-amber-500/80' : 'bg-white/10 hover:bg-white/20'
              }`}
              title="فلتر التاريخ"
            >
              <CalendarDays className="h-4 w-4" />
            </button>
            <button
              onClick={() => { setShowScanPanel(!showScanPanel); if (showScanPanel) stopScanCamera(); setScanResult(null); }}
              className={`w-8 h-8 rounded-lg flex items-center justify-center text-white transition-colors ${
                showScanPanel ? 'bg-green-500/70 hover:bg-green-500/90' : 'bg-white/10 hover:bg-white/20'
              }`}
              title="مسح QR"
            >
              <QrCode className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowTasksPanel(!showTasksPanel)}
              className={`w-8 h-8 rounded-lg flex items-center justify-center text-white transition-colors ${
                showTasksPanel ? 'bg-amber-500/60 hover:bg-amber-500/80' : 'bg-white/10 hover:bg-white/20'
              }`}
              title="المهام"
            >
              <MessageSquare className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowStockPanel(!showStockPanel)}
              className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors"
              title="المخزون"
            >
              <Box className="h-4 w-4" />
            </button>
            <button
              onClick={() => refetch()}
              className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              onClick={handleLogout}
              className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-white hover:bg-red-500/30 transition-colors"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-4 space-y-4">
        {/* Business Group Filter - نحاس / مفروشات */}
        {groupsData.length > 0 && (
          <div className="flex gap-2">
            <button
              onClick={() => setSelectedGroupId(undefined)}
              className={`flex-1 py-2.5 rounded-xl text-sm font-bold transition-all ${
                !selectedGroupId
                  ? 'bg-amber-700 text-white shadow-md'
                  : 'bg-card text-muted-foreground border border-border hover:border-amber-300'
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
                    ? 'bg-amber-700 text-white shadow-md'
                    : 'bg-card text-muted-foreground border border-border hover:border-amber-300'
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
            <div className="flex items-center justify-between px-4 py-3 bg-amber-50 border-b border-amber-100">
              <h3 className="font-bold text-foreground flex items-center gap-2">
                <Box className="h-4 w-4 text-amber-600" />
                جرد المخزون
                {selectedGroupId && (
                  <span className="text-xs font-normal text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
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
                            isLow ? 'bg-red-50 border-red-200' : 'bg-muted/50 border-border'
                          }`}
                        >
                          <p className="text-xs text-muted-foreground truncate" title={p.name}>{p.name}</p>
                          <p className={`text-lg font-bold mt-0.5 ${
                            isLow ? 'text-red-600' : 'text-foreground'
                          }`}>
                            {p.currentStock} <span className="text-xs font-normal text-muted-foreground">قطعة</span>
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">سعر: {Number(p.price).toLocaleString('ar-EG')} ج.م</p>
                          {isLow && (
                            <p className="text-xs text-red-500 flex items-center gap-1 mt-0.5">
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
                          <Package className="h-3.5 w-3.5 text-amber-600" />
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
                                  <tr key={v.id} className={isLow ? 'bg-red-50' : 'bg-card'}>
                                    <td className="py-1.5 px-2 border border-border font-medium text-foreground">{v.color || '-'}</td>
                                    <td className="py-1.5 px-2 border border-border text-muted-foreground">{v.size || '-'}</td>
                                    <td className="py-1.5 px-2 border border-border text-center font-bold text-amber-700">
                                      {v.price ? `${Number(v.price).toLocaleString('ar-EG')} ج.م` : '-'}
                                    </td>
                                    <td className={`py-1.5 px-2 border border-border text-center font-bold ${
                                      isLow ? 'text-red-600' : 'text-foreground'
                                    }`}>
                                      {v.currentStock}
                                    </td>
                                    <td className="py-1.5 px-2 border border-border text-center">
                                      {isLow ? (
                                        <span className="text-red-500 font-semibold">ينفد</span>
                                      ) : (
                                        <span className="text-green-600 font-semibold">متوفر</span>
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
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-gradient-to-l from-green-50 to-emerald-50">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-green-100 flex items-center justify-center">
                  <QrCode className="h-4 w-4 text-green-700" />
                </div>
                <div>
                  <p className="text-sm font-bold text-foreground">مسح QR - تجهيز الأوردرات</p>
                  <p className="text-xs text-muted-foreground">افتح الكاميرا أو أدخل السيريال يدوياً</p>
                </div>
              </div>
              <button
                onClick={() => { setShowScanPanel(false); stopScanCamera(); setScanResult(null); }}
                className="w-7 h-7 rounded-lg bg-muted flex items-center justify-center text-muted-foreground hover:bg-gray-200"
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
                      <div className="absolute top-0 left-0 w-5 h-5 border-t-4 border-l-4 border-green-400 rounded-tl-lg" />
                      <div className="absolute top-0 right-0 w-5 h-5 border-t-4 border-r-4 border-green-400 rounded-tr-lg" />
                      <div className="absolute bottom-0 left-0 w-5 h-5 border-b-4 border-l-4 border-green-400 rounded-bl-lg" />
                      <div className="absolute bottom-0 right-0 w-5 h-5 border-b-4 border-r-4 border-green-400 rounded-br-lg" />
                    </div>
                  </div>
                  {/* Hidden canvas for QR processing */}
                  <canvas ref={scanCanvasRef} className="hidden" />
                </div>

                {!scanIsScanning && !scanCameraError && (
                  <div className="w-full bg-muted rounded-xl h-40 flex items-center justify-center border-2 border-dashed border-green-300">
                    <div className="text-center text-muted-foreground">
                      <CameraOff className="h-10 w-10 mx-auto mb-2 opacity-50" />
                      <p className="text-xs">اضغط لتشغيل الكاميرا</p>
                    </div>
                  </div>
                )}

                {scanCameraError && (
                  <div className="w-full bg-red-50 border border-red-200 rounded-xl p-4 text-center">
                    <XCircle className="h-8 w-8 text-red-400 mx-auto mb-2" />
                    <p className="text-sm text-red-700">{scanCameraError}</p>
                  </div>
                )}
                {!scanIsScanning ? (
                  <button
                    onClick={startScanCamera}
                    className="flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm font-bold transition-colors w-full justify-center"
                  >
                    <Camera className="h-4 w-4" />
                    تشغيل الكاميرا
                  </button>
                ) : (
                  <button
                    onClick={stopScanCamera}
                    className="flex items-center gap-2 px-5 py-2.5 bg-red-500 hover:bg-red-600 text-white rounded-xl text-sm font-bold transition-colors w-full justify-center"
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
                  <Button type="submit" size="sm" className="bg-green-600 hover:bg-green-700 text-white" disabled={scanMutation.isPending}>
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
                  scanResult.success ? 'bg-green-50 border-green-200' :
                  scanResult.result === 'duplicate' ? 'bg-amber-50 border-amber-200' :
                  'bg-red-50 border-red-200'
                }`}>
                  <div className="flex items-center gap-2 mb-2">
                    {scanResult.success ? (
                      <CheckCircle className="h-5 w-5 text-green-600" />
                    ) : scanResult.result === 'duplicate' ? (
                      <AlertCircle className="h-5 w-5 text-amber-600" />
                    ) : (
                      <XCircle className="h-5 w-5 text-red-600" />
                    )}
                    <span className={`font-bold text-sm ${
                      scanResult.success ? 'text-green-800' :
                      scanResult.result === 'duplicate' ? 'text-amber-800' : 'text-red-800'
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
                        <p className="text-amber-700"><span className="font-semibold">جهزه:</span> {scanResult.preparedByName} • {scanResult.preparedAt ? new Date(scanResult.preparedAt).toLocaleString('ar-EG') : ''}</p>
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
          <div className="relative overflow-hidden bg-gradient-to-l from-amber-50 to-orange-50 border border-amber-200 rounded-xl p-4 shadow-sm">
            <div className="absolute top-0 left-0 w-1 h-full bg-amber-500"></div>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 border border-amber-300 flex items-center justify-center shrink-0">
                <span className="text-lg">📢</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between mb-1">
                  <h4 className="text-sm font-bold text-amber-900">رسالة من الإدارة</h4>
                  <span className="text-xs text-amber-600 bg-amber-100 px-2 py-0.5 rounded-full">إشعار</span>
                </div>
                <p className="text-sm text-foreground leading-relaxed">{broadcastData.message}</p>
                <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                  <span className="font-medium text-amber-700">{broadcastData.sentByName}</span>
                  <span>•</span>
                  <span>{new Date(broadcastData.createdAt).toLocaleString('ar-EG')}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Date Filter Panel */}
        {showDateFilter && (
          <div className="bg-card rounded-xl border border-amber-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold text-foreground flex items-center gap-2">
                <CalendarDays className="h-4 w-4 text-amber-600" />
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
                  !dateFrom && !dateTo ? 'bg-amber-600 text-white shadow-sm' : 'bg-muted text-muted-foreground hover:bg-gray-200'
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
                    ? 'bg-amber-600 text-white shadow-sm' : 'bg-muted text-muted-foreground hover:bg-gray-200'
                }`}
              >أمس</button>
              <button
                onClick={() => { setDateFrom("2024-01-01"); setDateTo(""); }}
                className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                  dateFrom === '2024-01-01' && !dateTo ? 'bg-amber-600 text-white shadow-sm' : 'bg-muted text-muted-foreground hover:bg-gray-200'
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
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground mb-1 block">إلى تاريخ</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={e => setDateTo(e.target.value)}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>
            </div>
            {(dateFrom || dateTo) && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2 mt-2 flex items-center gap-1">
                <Filter className="h-3 w-3" />
                يتم عرض الأوردرات المسندة في الفترة المحددة
              </p>
            )}
          </div>
        )}

        {/* Stats Row — each tile doubles as a quick filter into the tab it names */}
        <div className="grid grid-cols-4 gap-2">
          <StatCard label="الكل" value={displayStats?.total ?? 0} active={activeTab === "all"} onClick={() => setActiveTab("all")} />
          <StatCard label="جديد" value={displayStats?.new ?? 0} tone="primary" active={activeTab === "new"} onClick={() => setActiveTab("new")} />
          <StatCard label="مؤكد" value={displayStats?.confirmed ?? 0} tone="success" active={activeTab === "confirmed"} onClick={() => setActiveTab("confirmed")} />
          <StatCard label="مؤجل" value={displayStats?.postponed ?? 0} tone="warning" active={activeTab === "postponed"} onClick={() => setActiveTab("postponed")} />
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
          <div className="space-y-3">
            {filteredOrders.map(order => {
              const statusConf = STATUS_CONFIG[order.status] ?? STATUS_CONFIG.new;
              const isExpanded = expandedOrder === order.id;
              const canAct = order.status === "new" || order.status === "postponed" || order.status === "no_answer";

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
                          {order.source && SOURCE_LABELS[order.source] && (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${SOURCE_LABELS[order.source].color}`}>
                              {SOURCE_LABELS[order.source].label}
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
                        <div className="flex items-center gap-3 mt-1.5 text-sm text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Phone className="h-3.5 w-3.5" />
                            <span dir="ltr">{order.customerPhone}</span>
                          </span>
                          <WhatsAppButton phone={order.customerPhone} iconOnly size="icon-sm" className="h-7 w-7" />
                          <span className="flex items-center gap-1">
                            <MapPin className="h-3.5 w-3.5" />
                            {order.governorate}
                          </span>
                        </div>
                        {/* العنوان الكامل - ظاهر دائماً */}
                        <div className="flex items-start gap-1.5 mt-1.5 text-sm">
                          <MapPin className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary" />
                          <span className="leading-snug">{order.customerAddress}</span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-sm">
                          <span className="flex items-center gap-1 text-muted-foreground">
                            <Package className="h-3.5 w-3.5" />
                            {order.productName}
                            {((order as any).color || (order as any).size) && (
                              <span className="text-xs text-muted-foreground mr-1">
                                ({(order as any).color && `${(order as any).color}`}{(order as any).color && (order as any).size && " - "}{(order as any).size && `${(order as any).size}`})
                              </span>
                            )}
                          </span>
                          <span className="font-semibold">
                            {Number(order.totalAmount).toLocaleString()} ج.م
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className="text-xs text-muted-foreground font-mono">{order.orderNumber}</span>
                        {order.createdAt && (
                          <span className="text-xs text-muted-foreground">{new Date(order.createdAt).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
                        )}
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
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

                      {/* Edit + Duplicate Buttons */}
                      <div className="flex items-center justify-between gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 gap-1 text-xs"
                          onClick={() => {
                            setEditDialog({ open: true, orderId: order.id });
                            setEditProductName(order.productName ?? "");
                            setEditQuantity(order.quantity ?? 1);
                            setEditTotalAmount(Number(order.totalAmount));
                            setEditNotes(order.notes ?? "");
                            setEditGovernorate(order.governorate ?? "");
                            setEditAddress(order.customerAddress ?? "");
                            setEditCustomerName(order.customerName ?? "");
                            setEditCustomerPhone(order.customerPhone ?? "");
                            setEditCustomerPhone2((order as any).customerPhone2 ?? "");
                            setEditCity((order as any).city ?? "");
                            setEditShippingFees(Number((order as any).shippingFees || 0));
                            setEditPaymentMethod((order as any).paymentMethod ?? "cod");
                            setEditEmployeeNotes((order as any).employeeNotes ?? "");
                            setEditColor((order as any).color ?? "");
                            setEditSize((order as any).size ?? "");
                            setShowEditHistory(false);
                          }}
                        >
                          <Edit2 className="h-3.5 w-3.5" />
                          تعديل بيانات
                        </Button>
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

                      {/* Action Buttons */}
                      {canAct && (
                        <div className="flex gap-2 pt-1">
                          <Button
                            size="sm"
                            className="h-9 flex-1 bg-[var(--success)] text-[var(--success-foreground)] hover:opacity-90"
                            onClick={() => handleConfirmOrder(order)}
                            disabled={confirmMutation.isPending}
                          >
                            <CheckCircle2 className="h-4 w-4 ml-1" />
                            تأكيد
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-9 flex-1 border-[var(--warning)]/50 text-[var(--warning)] hover:bg-[var(--warning)]/10"
                            onClick={() => {
                              setPostponeDialog({ open: true, orderId: order.id });
                              setPostponeDate("");
                              setPostponeNotes("");
                            }}
                          >
                            <Clock className="h-4 w-4 ml-1" />
                            تأجيل
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-9 px-3"
                            onClick={() => noAnswerMutation.mutate({ orderId: order.id })}
                            disabled={noAnswerMutation.isPending}
                            title="لم يرد"
                          >
                            <Phone className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-9 flex-1 border-destructive/50 text-destructive hover:bg-destructive/10"
                            onClick={() => {
                              setCancelDialog({ open: true, orderId: order.id });
                              setCancelReason("");
                              setCancelNotes("");
                            }}
                          >
                            <XCircle className="h-4 w-4 ml-1" />
                            إلغاء
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edit Order Dialog - شاشة تعديل شاملة */}
      <Dialog open={editDialog.open} onOpenChange={open => setEditDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Edit2 className="h-5 w-5 text-blue-600" />
              تعديل بيانات الأوردر
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* قسم بيانات العميل */}
            <div className="bg-blue-50/50 border border-blue-100 rounded-lg p-3">
              <p className="text-sm font-semibold text-blue-800 mb-3 flex items-center gap-1">
                <User className="h-4 w-4" />
                بيانات العميل
              </p>
              <div className="space-y-3">
                <div>
                  <Label>اسم العميل <span className="text-destructive">*</span></Label>
                  <Input
                    value={editCustomerName}
                    onChange={e => setEditCustomerName(e.target.value)}
                    placeholder="اسم العميل..."
                    className={`mt-1 ${!editCustomerName ? 'border-red-300 bg-red-50' : ''}`}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>رقم التليفون <span className="text-destructive">*</span></Label>
                    <Input
                      value={editCustomerPhone}
                      onChange={e => setEditCustomerPhone(e.target.value)}
                      placeholder="01xxxxxxxxx"
                      className={`mt-1 ${!editCustomerPhone || editCustomerPhone.length < 10 ? 'border-red-300 bg-red-50' : ''}`}
                      dir="ltr"
                    />
                  </div>
                  <div>
                    <Label>تليفون بديل</Label>
                    <Input
                      value={editCustomerPhone2}
                      onChange={e => setEditCustomerPhone2(e.target.value)}
                      placeholder="01xxxxxxxxx"
                      className="mt-1"
                      dir="ltr"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* قسم بيانات الشحن */}
            <div className="bg-green-50/50 border border-green-100 rounded-lg p-3">
              <p className="text-sm font-semibold text-green-800 mb-3 flex items-center gap-1">
                <Truck className="h-4 w-4" />
                بيانات الشحن
              </p>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>المحافظة <span className="text-destructive">*</span></Label>
                    <Select value={editGovernorate} onValueChange={setEditGovernorate}>
                      <SelectTrigger className={`mt-1 ${!editGovernorate ? 'border-red-300 bg-red-50' : ''}`}>
                        <SelectValue placeholder="اختر المحافظة..." />
                      </SelectTrigger>
                      <SelectContent>
                        {["القاهرة","الجيزة","الإسكندرية","الدقهلية","البحر الأحمر","البحيرة","الفيوم","الغربية","الإسماعيلية","المنوفية","المنيا","القليوبية","الوادي الجديد","السويس","أسوان","أسيوط","بني سويف","بورسعيد","دمياط","جنوب سيناء","كفر الشيخ","مطروح","الأقصر","قنا","شمال سيناء","الشرقية","سوهاج","6 أكتوبر"].map(g => (
                          <SelectItem key={g} value={g}>{g}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {!editGovernorate && <p className="text-xs text-red-500 mt-1">مطلوبة</p>}
                  </div>
                  <div>
                    <Label>المدينة / المركز</Label>
                    <Input
                      value={editCity}
                      onChange={e => setEditCity(e.target.value)}
                      placeholder="المدينة أو المركز..."
                      className="mt-1"
                    />
                  </div>
                </div>
                <div>
                  <Label>العنوان التفصيلي <span className="text-destructive">*</span></Label>
                  <Textarea
                    value={editAddress}
                    onChange={e => setEditAddress(e.target.value)}
                    placeholder="الشارع، المنطقة، علامة مميزة..."
                    className={`mt-1 ${!editAddress || editAddress.length < 5 ? 'border-red-300 bg-red-50' : ''}`}
                    rows={2}
                  />
                  {(!editAddress || editAddress.length < 5) && <p className="text-xs text-red-500 mt-1">العنوان مطلوب (أكثر من 5 حروف)</p>}
                </div>
              </div>
            </div>

            {/* قسم المنتجات */}
            <div className="bg-purple-50/50 border border-purple-100 rounded-lg p-3">
              <p className="text-sm font-semibold text-purple-800 mb-3 flex items-center gap-1">
                <Package className="h-4 w-4" />
                المنتجات
              </p>
              <div className="space-y-3">
                <div>
                  <Label>نوع المنتج / الحفر</Label>
                  <Select
                    value={editProductName}
                    onValueChange={val => {
                      setEditProductName(val);
                      const prod = productsList?.find((p: any) => p.name === val);
                      if (prod && prod.price) setEditTotalAmount(Number(prod.price) * editQuantity + editShippingFees);
                    }}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="اختر نوع المنتج..." />
                    </SelectTrigger>
                    <SelectContent>
                      {productsList?.map((p: any) => (
                        <SelectItem key={p.id} value={p.name}>
                          <div className="flex items-center justify-between gap-4 w-full">
                            <span>{p.name}</span>
                            {p.price && <span className="text-xs text-muted-foreground">{Number(p.price)} ج.م</span>}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {editProductName && (
                    <button type="button" className="text-xs text-muted-foreground mt-1 underline" onClick={() => setEditProductName("")}>مسح الاختيار</button>
                  )}
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label>الكمية <span className="text-destructive">*</span></Label>
                    <Input
                      type="number"
                      min={1}
                      value={editQuantity}
                      onChange={e => {
                        const qty = Number(e.target.value);
                        setEditQuantity(qty);
                        const prod = productsList?.find((p: any) => p.name === editProductName);
                        if (prod && prod.price) setEditTotalAmount(Number(prod.price) * qty + editShippingFees);
                      }}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>رسوم الشحن</Label>
                    <Input
                      type="number"
                      min={0}
                      value={editShippingFees}
                      onChange={e => setEditShippingFees(Number(e.target.value))}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>الإجمالي</Label>
                    <Input
                      type="number"
                      min={0}
                      value={editTotalAmount}
                      onChange={e => setEditTotalAmount(Number(e.target.value))}
                      className="mt-1 font-bold"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>اللون</Label>
                    <Input
                      value={editColor}
                      onChange={e => setEditColor(e.target.value)}
                      placeholder="مثلاً: أسود، ذهبي..."
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>المقاس</Label>
                    <Input
                      value={editSize}
                      onChange={e => setEditSize(e.target.value)}
                      placeholder="مثلاً: L, XL, 120×200..."
                      className="mt-1"
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* قسم ملخص الطلب */}
            <div className="bg-amber-50/50 border border-amber-100 rounded-lg p-3">
              <p className="text-sm font-semibold text-amber-800 mb-3 flex items-center gap-1">
                <ShoppingBag className="h-4 w-4" />
                ملخص الطلب
              </p>
              <div className="space-y-3">
                <div>
                  <Label>وسيلة الدفع</Label>
                  <Select value={editPaymentMethod} onValueChange={setEditPaymentMethod}>
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="cod">كاش عند الاستلام (COD)</SelectItem>
                      <SelectItem value="prepaid">مدفوع مسبقاً</SelectItem>
                      <SelectItem value="partial">دفع جزئي</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>ملاحظات العميل</Label>
                  <Textarea
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    placeholder="ملاحظات من العميل..."
                    className="mt-1"
                    rows={2}
                  />
                </div>
                <div>
                  <Label>ملاحظات الموظف (داخلية)</Label>
                  <Textarea
                    value={editEmployeeNotes}
                    onChange={e => setEditEmployeeNotes(e.target.value)}
                    placeholder="ملاحظات داخلية للموظف..."
                    className="mt-1 bg-muted/50"
                    rows={2}
                  />
                </div>
              </div>
            </div>

            {/* تنبيه بيانات ناقصة */}
            {(!editCustomerName || !editCustomerPhone || editCustomerPhone.length < 10 || !editGovernorate || !editAddress || editAddress.length < 5) && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-2">
                <p className="text-xs text-red-700 font-semibold flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" />
                  بيانات ناقصة - لن يتم تصدير هذا الأوردر في شيت الشحن
                </p>
                <ul className="text-xs text-red-600 mt-1 list-disc list-inside">
                  {!editCustomerName && <li>اسم العميل مطلوب</li>}
                  {(!editCustomerPhone || editCustomerPhone.length < 10) && <li>رقم الهاتف غير صحيح</li>}
                  {!editGovernorate && <li>المحافظة مطلوبة</li>}
                  {(!editAddress || editAddress.length < 5) && <li>العنوان ناقص</li>}
                </ul>
              </div>
            )}

            {/* سجل التعديلات */}
            <button
              type="button"
              className="text-xs text-blue-600 underline"
              onClick={() => setShowEditHistory(!showEditHistory)}
            >
              {showEditHistory ? "إخفاء سجل التعديلات" : "عرض سجل التعديلات"}
            </button>
            {showEditHistory && editDialog.orderId && <EditHistoryPanel orderId={editDialog.orderId} />}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setEditDialog({ open: false, orderId: null })}>إلغاء</Button>
            <Button
              disabled={editQuantity < 1 || editOrderMutation.isPending || !editCustomerName || !editGovernorate || !editCustomerPhone}
              onClick={() => {
                if (!editDialog.orderId) return;
                // Validation checks
                const issues: string[] = [];
                if (!editCustomerName?.trim()) issues.push("اسم العميل مطلوب");
                if (!editCustomerPhone || editCustomerPhone.length < 10) issues.push("رقم الهاتف غير صحيح (يجب أن يكون 10 أرقام على الأقل)");
                if (!editGovernorate?.trim()) issues.push("المحافظة مطلوبة");
                if (!editAddress || editAddress.trim().length < 5) issues.push("العنوان قصير جداً (يجب 5 أحرف على الأقل)");
                if (issues.length > 0) {
                  toast.error(`⚠️ بيانات ناقصة:\n${issues.join('\n')}`);
                  return;
                }
                editOrderMutation.mutate({
                  orderId: editDialog.orderId,
                  quantity: editQuantity,
                  totalAmount: editTotalAmount,
                  productName: editProductName || undefined,
                  notes: editNotes || undefined,
                  governorate: editGovernorate || undefined,
                  customerAddress: editAddress || undefined,
                  customerName: editCustomerName || undefined,
                  customerPhone: editCustomerPhone || undefined,
                  customerPhone2: editCustomerPhone2 || undefined,
                  city: editCity || undefined,
                  shippingFees: editShippingFees,
                  paymentMethod: editPaymentMethod || undefined,
                  employeeNotes: editEmployeeNotes || undefined,
                  color: editColor || null,
                  size: editSize || null,
                });
              }}
              className="bg-blue-600 hover:bg-blue-700"
            >
              {editOrderMutation.isPending ? "جاري الحفظ..." : "حفظ التعديلات"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Postpone Dialog */}
      <Dialog open={postponeDialog.open} onOpenChange={open => setPostponeDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-amber-600" />
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setPostponeDialog({ open: false, orderId: null })}>إلغاء</Button>
            <Button
              onClick={handlePostpone}
              disabled={postponeMutation.isPending}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {postponeMutation.isPending ? "جاري..." : "تأجيل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Dialog */}
      <Dialog open={cancelDialog.open} onOpenChange={open => setCancelDialog(d => ({ ...d, open }))}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <XCircle className="h-5 w-5 text-red-600" />
              إلغاء الأوردر
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>سبب الإلغاء <span className="text-destructive">*</span></Label>
              <Select value={cancelReason} onValueChange={setCancelReason}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="اختر السبب..." />
                </SelectTrigger>
                <SelectContent>
                  {CANCEL_REASONS.map(r => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>ملاحظة (اختياري)</Label>
              <Input
                value={cancelNotes}
                onChange={e => setCancelNotes(e.target.value)}
                placeholder="تفاصيل إضافية..."
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelDialog({ open: false, orderId: null })}>رجوع</Button>
            <Button
              onClick={handleCancel}
              disabled={cancelMutation.isPending}
              variant="destructive"
            >
              {cancelMutation.isPending ? "جاري..." : "تأكيد الإلغاء"}
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
              <span className="text-red-600 line-through">{log.oldValue || '(فارغ)'}</span>{' → '}
              <span className="text-green-700">{log.newValue || '(فارغ)'}</span>
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
    new: { label: "جديدة", color: "text-blue-700", bg: "bg-blue-50 border-blue-200" },
    in_progress: { label: "قيد التنفيذ", color: "text-amber-700", bg: "bg-amber-50 border-amber-200" },
    done: { label: "تمت", color: "text-green-700", bg: "bg-green-50 border-green-200" },
  };

  if (isLoading) {
    return (
      <div className="bg-card rounded-xl border border-border shadow-sm p-4">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-gray-200 rounded w-1/3" />
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
          <MessageSquare className="h-4 w-4 text-amber-600" />
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
                  <div key={task.id} className="border border-green-100 rounded-lg p-2 bg-green-50/50">
                    <div className="flex items-center gap-2">
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />
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
