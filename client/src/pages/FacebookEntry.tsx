import { useState, useMemo, useEffect, useRef, type ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { draftKey, readEmployeeScope, sanitizeDraftItems } from "@/lib/employeeScope";
import { activeDraftKey } from "@/lib/activeBusiness";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { summarizeCart, saveBlockers } from "@shared/orderLines";
import { pasteSaveBlockers, type ParseResultV2 } from "@shared/orderParse";
import { linesFromParse } from "@/lib/legacyLine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Plus, Phone, MapPin, Package, LogOut, RefreshCw, X, Trash2, Pencil, Save, Eraser, ClipboardPaste, AlertTriangle,
  ChevronDown, CheckCircle2, Building2, User, Truck, ClipboardCheck, ListChecks,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { useGovernorateOptions } from "@/hooks/useGovernorateOptions";
import { GovernorateCitySelect } from "@/components/orders/GovernorateCitySelect";
import { LegacyEngravingPicker } from "@/components/orders/LegacyEngravingPicker";
import { isValidEgyptianMobile } from "@/components/orders/OrderEditDialog";
import { PartnerLogo } from "@/components/brand/PartnerLogo";
import { createInFlightGuard } from "@/components/orders/confirmGuard";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { ErrorState, OfflineState } from "@/components/shared";
import { DEFAULT_ORDER_ENTRY_MODE, type OrderEntryMode } from "@shared/orderEntryMode";
import {
  VariantOrderPicker,
  variantLabel,
  variantDimensions,
  type Catalog,
  type PickedItem,
} from "@/components/orders/VariantOrderPicker";

/**
 * شاشة موظف إدخال الأوردرات — مبنية بالكامل على منتجات وتركيبات المخزون:
 *   المنتج ← اللون ← المقاس ← الكمية، مع عرض المتاح ومنع تجاوزه.
 * السعر بيتحسب من سعر التركيبة × الكمية. الأوردر بيتحفظ ومعاه variantId وSKU واللون والمقاس.
 * الموظف يرى ويعدّل أوردراته فقط (العزل على السيرفر). مافيش أي منطق قديم للإسورة.
 *
 * المرحلة 7B (عرض فقط): النموذج نفسه مقسّم 7 أقسام مرقّمة قابلة للطي داخل الصفحة الواحدة
 * (لا معالج صفحات) — نفس الحالة، نفس المسودة ومفتاحها، نفس المنتقيات، نفس الحفظ والتحقق.
 */

type CustomerForm = {
  customerName: string;
  customerPhone: string;
  /** رقم إضافي (اختياري) — منفصل عن العنوان. */
  customerPhone2: string;
  governorate: string;
  customerAddress: string;
  city: string;
  notes: string;
  adName: string;
  shipping: string;
  discount: string;
};

const EMPTY_CUSTOMER: CustomerForm = {
  customerName: "", customerPhone: "", customerPhone2: "", governorate: "", customerAddress: "",
  city: "", notes: "", adName: "", shipping: "0", discount: "0",
};

/** أخطاء الحقول المطلوبة — مشتقة من الحالة؛ إصلاح حقل يزيل سببه هو فقط. نفس شروط submit(). */
type FieldIssues = Partial<Record<"customerName" | "customerPhone" | "governorate" | "customerAddress", string>>;
const FIELD_ID: Record<keyof FieldIssues, string> = { customerName: "f-customer-name", customerPhone: "f-customer-phone", governorate: "f-governorate", customerAddress: "f-address" };
const FIELD_SECTION: Record<keyof FieldIssues, number> = { customerName: 2, customerPhone: 2, governorate: 3, customerAddress: 3 };

const TOUCH = "min-h-11";
/**
 * نطاق أهداف اللمس للمكوّنات المشتركة داخل هذا النموذج فقط (منتقي التركيبات/المحافظة): ≥44px على الهاتف
 * (أرضية بالبكسل حتى عند 90%)، والقياس الافتراضي 36px على md+ — بلا تعديل المكوّنات نفسها أو صفحات أخرى.
 */
const TOUCH_SCOPE = "[&_button]:min-h-[max(2.75rem,44px)] [&_button]:min-w-[max(2.75rem,44px)] [&_input]:min-h-[max(2.75rem,44px)] [&_[role=combobox]]:min-h-[max(2.75rem,44px)] md:[&_button]:min-h-9 md:[&_button]:min-w-0 md:[&_input]:min-h-9 md:[&_[role=combobox]]:min-h-9";

/** قسم مرقّم قابل للطي — المحتوى يبقى في الـDOM عند الطي (details) فلا تضيع قيم ولا حالة. */
function EntrySection({ n, title, icon, open, onToggle, status, children }: { n: number; title: string; icon: ReactNode; open: boolean; onToggle: (open: boolean) => void; status?: { ok: boolean; text: string }; children: ReactNode }) {
  return (
    <details
      open={open}
      onToggle={e => onToggle((e.currentTarget as HTMLDetailsElement).open)}
      className="group rounded-[var(--radius-brand-md)] border border-border bg-card shadow-[var(--shadow-card)]"
      data-testid={`entry-section-${n}`}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 px-3 py-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground tabular-nums" aria-hidden="true">{n}</span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="shrink-0 text-muted-foreground" aria-hidden="true">{icon}</span>
          <span className="truncate">{title}</span>
        </span>
        {status && (
          <span className={`hidden shrink-0 items-center gap-1 text-[11px] font-medium sm:inline-flex ${status.ok ? "text-[var(--success)]" : "text-[var(--warning)]"}`} data-testid={`entry-section-${n}-status`}>
            {status.ok ? <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> : <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
            {status.text}
          </span>
        )}
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="space-y-3 border-t border-border p-3">{children}</div>
    </details>
  );
}

export default function FacebookEntry() {
  const governorateOptions = useGovernorateOptions();
  const utils = trpc.useUtils();
  // قالب الإدخال من السيرفر بهوية الجلسة — العميل مابيبعتش حاجة، ومايقدرش يغيّره.
  // لحد ما يوصل بنعرض الافتراضي (نفس سلوك كل الأنشطة النهاردة).
  const { data: entryConfig, isLoading: entryConfigLoading } =
    trpc.facebookEntry.entryConfig.useQuery();
  const entryMode: OrderEntryMode = entryConfig?.mode ?? DEFAULT_ORDER_ENTRY_MODE;
  const isLegacy = entryMode === "bracelets_legacy";
  // مفتاح المسودة مربوط بالحساب (tenant/نشاط/موظف) **والقالب** — مسودة حساب تاني على
  // نفس الجهاز عمرها ما تترجّع هنا، وتغيير القالب مايرجّعش مسودة بشكل تاني.
  // + النشاط الفعّال: تبديل النشاط مايرجّعش مسودة نشاط تاني.
  const { currentBusinessId: activeBusinessId, businesses } = useBusinessContext();
  const DRAFT_KEY = useMemo(
    () => activeDraftKey(draftKey(readEmployeeScope()), activeBusinessId, entryMode),
    [entryMode, activeBusinessId]
  );
  const [cust, setCust] = useState<CustomerForm>(EMPTY_CUSTOMER);
  const [items, setItems] = useState<PickedItem[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [parsing, setParsing] = useState(false);
  // عدد القطع اللي الرسالة قالته — الحفظ بيتوقف لو مجموع كميات السلة مايساويهوش.
  const [expectedPieces, setExpectedPieces] = useState<number | null>(null);
  const [totalMismatch, setTotalMismatch] = useState(false);
  const [totalConfirmed, setTotalConfirmed] = useState(false);
  // Hybrid parser (القالب المبسّط): ناتج التحليل V2 + التوكن الموقّع + النص اللي اتحلّل
  // بالظبط. بيتبعتوا مع الحفظ، والسيرفر بيعيد التحليل ويتحقق بنفسه.
  const [parseV2, setParseV2] = useState<ParseResultV2 | null>(null);
  const [parseToken, setParseToken] = useState<string | null>(null);
  const [analyzedText, setAnalyzedText] = useState<string | null>(null);
  /** إدخال يدوي صريح: مفيش اقتراحات ولا توكن ولا مسودة قديمة تترجّع فوقه. */
  const [manualMode, setManualMode] = useState(false);
  const resetParseState = () => { setParseV2(null); setParseToken(null); setAnalyzedText(null); };
  const [showOrders, setShowOrders] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  /** حالة الطي لكل قسم — كلها مفتوحة افتراضيًا؛ الطي لا يفرّغ شيئًا. */
  const [openSections, setOpenSections] = useState<Record<number, boolean>>({ 1: true, 2: true, 3: true, 4: true, 5: true, 6: true, 7: true });
  const setOpen = (n: number, open: boolean) => setOpenSections(s => (s[n] === open ? s : { ...s, [n]: open }));

  // Edit dialog
  const [editingOrder, setEditingOrder] = useState<any>(null);
  const [editCust, setEditCust] = useState<CustomerForm>(EMPTY_CUSTOMER);
  const [editItems, setEditItems] = useState<PickedItem[]>([]);
  const [deletingOrderId, setDeletingOrderId] = useState<number | null>(null);

  const { data: me, isLoading: meLoading } = trpc.employeePortal.me.useQuery();
  const { data: catalog = { products: [], variants: [] }, isLoading: catalogLoading, isError: catalogError, refetch: refetchCatalog } =
    trpc.facebookEntry.catalog.useQuery() as { data: Catalog; isLoading: boolean; isError: boolean; refetch: () => unknown };
  const online = useOnlineStatus();
  const saveGuard = useRef(createInFlightGuard<string>()).current;

  const { data: myOrders = [], refetch: refetchOrders } =
    trpc.facebookEntry.myOrders.useQuery(
      { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined },
      { enabled: showOrders }
    );

  // الملخّص وأسباب منع الحفظ من نفس الدوال النقية المختبَرة (shared/orderLines).
  const summary = useMemo(
    () => summarizeCart(items, Number(cust.shipping), Number(cust.discount)),
    [items, cust.shipping, cust.discount]
  );
  const subtotal = summary.itemsSubtotal;
  const total = summary.total;
  const baseBlockers = useMemo(
    () =>
      saveBlockers(items, {
        shipping: Number(cust.shipping),
        discount: Number(cust.discount),
        // القالب المبسّط: اختلاف عدد القطع تنبيه مش مانع — التحليل بيوزّع الكميات
        // من «عدد القطع» أصلًا، والموظف بيصحّح السطر بدل ما يتقفل.
        expectedPieces: isLegacy ? null : expectedPieces,
        totalNeedsConfirm: totalMismatch && !totalConfirmed,
      }),
    [items, cust.shipping, cust.discount, expectedPieces, totalMismatch, totalConfirmed, isLegacy]
  );
  const piecesMismatch =
    isLegacy && expectedPieces != null && expectedPieces > 0 && summary.pieces !== expectedPieces;
  // أوردر ناتج عن لصق في القالب المبسّط: قواعد الرسالة (عدد القطع، إجمالي المنتجات،
  // الإجمالي النهائي، لا سطر غير محلول) مانعة — نفس الدالة اللي السيرفر بيطبّقها.
  const pasteExpected = useMemo(() => {
    if (!isLegacy || !parseV2 || !parseToken || manualMode) return null;
    const f = parseV2.fields;
    const n = (v: unknown) => (typeof v === "number" ? v : null);
    return { pieces: n(f.pieces.value), itemsTotal: n(f.itemsTotal.value) };
  }, [isLegacy, parseV2, parseToken]);
  const pasteBlockers = useMemo(
    () =>
      pasteExpected
        ? pasteSaveBlockers(
            items.map(it => ({ quantity: it.quantity, unitPrice: it.unitPrice, resolved: !!it.productId && !it.needsPick && !it.needsVariantReview })),
            { ...pasteExpected, shipping: Number(cust.shipping) || 0, discount: Number(cust.discount) || 0 },
            total
          )
        : [],
    [pasteExpected, items, cust.shipping, cust.discount, total]
  );
  // تنبيه غير مانع: السطور النهائية اختلفت عن اقتراح التحليل (عدد/نوع/كمية) — قرار الموظفة.
  const structurallyEdited = useMemo(() => {
    if (!pasteExpected || !parseV2) return false;
    const sug = parseV2.lines;
    if (sug.length !== items.length) return true;
    return sug.some((l, i) => (l.match?.productId ?? null) !== (items[i].productId || null) || (l.match?.variantId ?? null) !== (items[i].variantId ?? null) || l.quantity !== items[i].quantity);
  }, [pasteExpected, parseV2, items]);
  // سعر القطعة المقترح لسطر يدوي جديد (من الرسالة) — بدل صفر لما الكتالوج بلا سعر.
  const suggestedUnitPrice = useMemo(() => {
    const t = pasteExpected?.itemsTotal, p = pasteExpected?.pieces;
    return t != null && p != null && p > 0 ? Math.round((t / p) * 100) / 100 : null;
  }, [pasteExpected]);
  // كل الموانع (العامة + موانع الرسالة) — الزر والقائمة والحفظ بيقروا من هنا.
  const blockers = useMemo(() => Array.from(new Set([...baseBlockers, ...pasteBlockers])), [baseBlockers, pasteBlockers]);

  // أخطاء الحقول المطلوبة بجانب الحقل + في الملخّص: نفس شروط submit() حرفيًا (فراغ فقط)؛
  // صيغة الهاتف تنبيه غير مانع (السيرفر هو الحكم) — مشتقة من الحالة فتختفي فور الإصلاح.
  const fieldIssues = useMemo((): FieldIssues => {
    const out: FieldIssues = {};
    if (!cust.customerName.trim()) out.customerName = "اسم العميل مطلوب";
    if (!cust.customerPhone.trim()) out.customerPhone = "رقم الهاتف مطلوب";
    if (!cust.governorate.trim()) out.governorate = "المحافظة مطلوبة";
    if (!cust.customerAddress.trim()) out.customerAddress = "العنوان مطلوب";
    return out;
  }, [cust.customerName, cust.customerPhone, cust.governorate, cust.customerAddress]);
  const phoneFormatWarning = cust.customerPhone.trim() !== "" && !isValidEgyptianMobile(cust.customerPhone.trim())
    ? "الرقم ليس رقم موبايل مصري (01xxxxxxxxx) — راجعه قبل الحفظ" : null;
  const issueCount = Object.keys(fieldIssues).length + blockers.length;

  const addOrderMutation = trpc.facebookEntry.addOrder.useMutation({
    onSuccess: data => {
      toast.success(`تم إضافة الأوردر — رقم: ${data.orderNumber}`);
      setCust(EMPTY_CUSTOMER);
      setItems([]);
      resetParseState(); setManualMode(false); setPasteText("");
      localStorage.removeItem(DRAFT_KEY);
      if (showOrders) refetchOrders();
    },
    onError: e => toast.error(`خطأ: ${e.message}`),
  });
  const updateOrderMutation = trpc.facebookEntry.updateOrder.useMutation({
    onSuccess: () => { toast.success("تم تعديل الأوردر"); setEditingOrder(null); refetchOrders(); },
    onError: e => toast.error(`خطأ: ${e.message}`),
  });
  const deleteOrderMutation = trpc.facebookEntry.deleteOrder.useMutation({
    onSuccess: () => { toast.success("تم حذف الأوردر"); setDeletingOrderId(null); refetchOrders(); },
    onError: e => toast.error(`خطأ: ${e.message}`),
  });

  // مسودة محلية (نفس الجهاز والحساب فقط) — تسترجع مرة بعد ما الكتالوج يوصل.
  //
  // الاسترجاع مُقيَّد بالكتالوج الحالي: أي بند منتجه أو تركيبته مش موجودة في كتالوج
  // نشاط الموظف بتتشال. مسودة اتحفظت قبل إيقاف منتج — أو فلتت من حساب تاني — ماتقدرش
  // تدخّل معرّفات هتترفض على السيرفر بعدين. السيرفر بيعيد التحقق من كل معرّف برضه.
  const draftRestored = useRef(false);
  useEffect(() => {
    // مسودة قديمة ماتندمجش مع تحليل جديد أو إدخال يدوي بدأ: الاسترجاع مرة واحدة وقبل أي عمل.
    if (draftRestored.current || catalogLoading || entryConfigLoading || items.length > 0 || parseV2 || manualMode) return;
    draftRestored.current = true;
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as { cust: CustomerForm; items: PickedItem[]; parseV2?: ParseResultV2 | null; parseToken?: string | null; analyzedText?: string | null };
      if (d.cust) setCust(d.cust);
      if (d.parseV2 && d.parseToken && d.analyzedText) { setParseV2(d.parseV2); setParseToken(d.parseToken); setAnalyzedText(d.analyzedText); setPasteText(d.analyzedText); }
      const s = sanitizeDraftItems(Array.isArray(d.items) ? d.items : [], catalog);
      setItems(s.items);
      const notes: string[] = [];
      if (s.dropped > 0) notes.push(`اتشال ${s.dropped} صنف مش موجود في كتالوج نشاطك`);
      if (s.needsReview > 0) notes.push(`${s.needsReview} صنف محتاج اختيار النوع من جديد`);
      toast.info(
        notes.length
          ? `تم استرجاع مسودة محفوظة — ${notes.join("، ")}`
          : "تم استرجاع مسودة محفوظة"
      );
    } catch { localStorage.removeItem(DRAFT_KEY); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogLoading, entryConfigLoading]);

  function saveDraft() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ cust, items, parseV2, parseToken, analyzedText }));
    toast.success("تم حفظ المسودة على هذا الجهاز");
  }
  function clearForm() {
    setCust(EMPTY_CUSTOMER); setItems([]); setPasteText("");
    setExpectedPieces(null); setTotalMismatch(false); setTotalConfirmed(false);
    resetParseState(); setManualMode(false);
    localStorage.removeItem(DRAFT_KEY);
    toast.success("تم مسح النموذج");
  }
  /** «إدخال يدوي»: يمسح اقتراحات التحليل الحالية فقط (بيانات العميل تفضل)، بلا توكن ولا مسودة. */
  function startManualEntry() {
    draftRestored.current = true;
    setItems([]); resetParseState(); setManualMode(true);
    setExpectedPieces(null); setTotalMismatch(false); setTotalConfirmed(false);
    toast.info("إدخال يدوي — أضف الأنواع والكميات ثم احفظ");
  }

  // لصق رسالة العميل → تحليل تلقائي وملء الحقول (قابلة للتعديل يدويًا بعدها).
  async function parseAndFill() {
    if (!pasteText.trim()) return;
    // كل تحليل بيستبدل البنود بالكامل ويلغي نتيجة/توكن الرسالة السابقة — مفيش append ولا مسودة تترجّع فوقه.
    draftRestored.current = true;
    setManualMode(false);
    setParsing(true);
    try {
      const res = await utils.facebookEntry.parsePaste.fetch({ text: pasteText });
      const p = res.parsed;
      setCust(c => ({
        ...c,
        customerName: p.customerName || c.customerName,
        customerPhone: p.customerPhone || c.customerPhone,
        customerPhone2: p.customerPhone2 || c.customerPhone2,
        // المحافظة **يقين أو فراغ** — لو التحليل مش متأكد بيسيبها والموظف يختار.
        governorate: p.governorate || c.governorate,
        city: p.city || c.city,
        customerAddress: p.customerAddress || c.customerAddress,
        adName: p.adName || c.adName,
        shipping: String(p.shipping ?? 0),
        discount: String(p.discount ?? 0),
      }));
      // **سطر لكل نوع مذكور.** السيرفر بيرجّع `lines` مبنية من الأنواع وعدد القطع،
      // ومعاها توزيع إجمالي الأصناف على القطع. السطر اللي مااتطابقش بيفضل بلا منتج
      // ومعلّم للمراجعة — مابنختارش أول منتج ولا أول تركيبة.
      const built: PickedItem[] = (res.lines ?? []).map(l => {
        const m = l.match;
        const v = m?.variantId ? catalog.variants.find(x => x.id === m.variantId) : undefined;
        const prod = m?.productId ? catalog.products.find(x => x.id === m.productId) : undefined;
        // نفس أبعاد المنتج اللي المنتقي بيعرضها — عشان الوصف مايرجّعش «نوعًا» متخفي.
        const dims = variantDimensions(
          catalog.variants.filter(x => x.productId === m?.productId && x.isActive !== false)
        );
        return {
          productId: m?.productId ?? 0,
          productName: m?.productName ?? l.term,
          variantId: m?.variantId ?? undefined,
          sku: m?.sku ?? null,
          color: m?.color ?? null,
          size: m?.size ?? null,
          optionLabel: variantLabel(v, dims) || null,
          quantity: l.quantity,
          // سعر الوحدة من توزيع الإجمالي المكتوب في الرسالة — مش من الكتالوج، عشان
          // عروض الكمية (قطعتان بـ400) تفضل زي ما الموظف اعتمدها. قابل للتعديل.
          unitPrice: l.unitPrice || Number(m?.unitPrice ?? 0),
          availableStock: v?.currentStock ?? prod?.currentStock ?? 0,
          needsPick: !m,
          pickReason: l.matchReason ?? null,
        } as PickedItem;
      });
      // القالب المبسّط: السطور من ParseResultV2 (ثقة لكل سطر، سعر بمصدره، تقسيم بالقرش).
      // القالب الكامل (catalog_variants) يفضل على `res.lines` كما هو — بلا تغيير.
      if (isLegacy && res.v2) {
        setItems(linesFromParse(res.v2, catalog));
        setParseV2(res.v2); setParseToken(res.parseToken ?? null); setAnalyzedText(pasteText);
      } else {
        setItems(built);
        resetParseState();
      }

      if (!p.governorate) toast.info("لم نتعرف على المحافظة — اختر المحافظة");
      // عدد القطع بيتقارن بالسلة بس لو العميل كتبه فعلًا — مش القيمة الافتراضية 1.
      setExpectedPieces(p.quantityGiven ? p.quantity : null);
      setTotalMismatch(Boolean(p.totalMismatch));
      setTotalConfirmed(false);

      const missing = built.filter(b => b.needsPick).length;
      if (p.totalMismatch)
        toast.warning("الإجمالي المكتوب لا يساوي (الأصناف + الشحن − الخصم) — راجع القيم");
      if (missing > 0)
        toast.warning(
          `تم ملء البيانات — ${missing} من ${built.length} صنف محتاج اختيار يدوي`
        );
      else toast.success(`تم التحليل: ${built.length} صنف`);
    } catch (e: any) {
      toast.error(`تعذّر التحليل: ${e.message}`);
    } finally {
      setParsing(false);
    }
  }

  function buildSelectedProducts(list: PickedItem[]) {
    return list.map(it => ({
      productId: it.productId,
      // **اسم المنتج لوحده — من غير النوع/اللون/المقاس.** هوية التركيبة بتتبعت في
      // `variantId` وبس (نفس عقد shared/orderContent.ts). لو ركّبنا النوع في الاسم
      // كان الأوردر هيبقى فيه اختيارين: القديم جوه النص والجديد في المعرّف، ولما
      // الموظف يغيّر النقشة بعدين يفضل الاسم القديم عايش في الصف. العرض والطباعة
      // وبوسطة كلهم بيركّبوا الاسم+النوع لحظة القراءة من `variantId`.
      productName: it.productName,
      quantity: it.quantity,
      variantId: it.variantId,
      unitPrice: it.unitPrice,
      priceSource: it.priceSource,
    }));
  }

  function submit() {
    if (!cust.customerName.trim()) return toast.error("اسم العميل مطلوب");
    if (!cust.customerPhone.trim()) return toast.error("رقم الهاتف مطلوب");
    if (!cust.governorate.trim()) return toast.error("المحافظة مطلوبة");
    if (!cust.customerAddress.trim()) return toast.error("العنوان مطلوب");
    // المخزون **مش** ضمن الموانع — تنبيه بس، زي سياسة confirmOrder.
    if (blockers.length > 0) return toast.error(blockers[0]);
    const first = items[0];
    // أوردر ناتج عن لصق (القالب المبسّط): النص المحلَّل + التوكن + الناتج للسجل.
    // السيرفر بيعيد التحليل ويرفض لو الرسالة اتغيّرت — الحفظ مربوط بالنص اللي اتحلّل.
    const pastePayload =
      isLegacy && !manualMode && parseV2 && parseToken && analyzedText
        ? { rawText: analyzedText, parseToken, parseResult: parseV2, discount: Number(cust.discount) || 0 }
        : {};
    // حارس الضغط المكرر: `isPending` يتأخر render واحدًا — الضغطة الثانية تُرفض فورًا حتى onSettled.
    saveGuard.run(DRAFT_KEY, addOrderMutation.isPending, done => addOrderMutation.mutate({
      customerName: cust.customerName.trim(),
      customerPhone: cust.customerPhone.trim(),
      customerPhone2: cust.customerPhone2.trim() || undefined,
      governorate: cust.governorate.trim(),
      customerAddress: cust.customerAddress.trim(),
      city: cust.city.trim() || undefined,
      selectedProducts: buildSelectedProducts(items),
      totalAmount: total,
      shippingCost: Number(cust.shipping) || 0,
      adName: cust.adName.trim() || undefined,
      notes: cust.notes.trim() || undefined,
      variantId: first.variantId,
      color: first.color ?? undefined,
      size: first.size ?? undefined,
      ...pastePayload,
    } as any, { onSettled: done }));
  }

  function openEdit(order: any) {
    setEditingOrder(order);
    setEditCust({
      customerName: order.customerName ?? "",
      customerPhone: order.customerPhone ?? "",
      customerPhone2: order.customerPhone2 ?? "",
      governorate: order.governorate ?? "",
      customerAddress: order.customerAddress ?? "",
      city: order.city ?? "",
      notes: order.notes ?? "",
      adName: order.adName ?? "",
      shipping: String(order.shippingFees ?? "0"),
      discount: "0",
    });
    // بنود التعديل: من عناصر الأوردر لو متاحة، وإلا صنف واحد من رأس الأوردر.
    const src = (order.items?.length ? order.items : [{ productId: order.productId, productName: order.productName, quantity: order.quantity, variantId: order.variantId }]);
    setEditItems(
      src.map((it: any) => {
        const v = catalog.variants.find(x => x.id === it.variantId);
        const p = catalog.products.find(x => x.id === it.productId);
        const avail = v?.currentStock ?? p?.currentStock ?? it.quantity ?? 0;
        const dims = variantDimensions(
          catalog.variants.filter(x => x.productId === it.productId && x.isActive !== false)
        );
        return {
          productId: it.productId, productName: it.productName ?? p?.name ?? "",
          variantId: it.variantId ?? undefined, sku: v?.sku ?? p?.sku ?? null,
          color: v?.color ?? order.color ?? null, size: v?.size ?? order.size ?? null,
          optionLabel: variantLabel(v, dims) || null,
          quantity: it.quantity ?? 1, unitPrice: Number(v?.price ?? p?.price ?? 0),
          availableStock: avail,
        } as PickedItem;
      })
    );
  }

  function submitEdit() {
    if (!editingOrder) return;
    if (editItems.length === 0) return toast.error("أضف صنفًا واحدًا على الأقل");
    const first = editItems[0];
    const editTotal = editItems.reduce((s, it) => s + it.unitPrice * it.quantity, 0) + (Number(editCust.shipping) || 0);
    updateOrderMutation.mutate({
      orderId: editingOrder.id,
      customerName: editCust.customerName.trim(),
      customerPhone: editCust.customerPhone.trim(),
      customerPhone2: editCust.customerPhone2.trim() || undefined,
      governorate: editCust.governorate.trim(),
      city: editCust.city.trim() || undefined,
      customerAddress: editCust.customerAddress.trim(),
      selectedProducts: editItems.map(it => ({ productId: it.productId, productName: it.productName, quantity: it.quantity })),
      totalAmount: editTotal,
      adName: editCust.adName.trim() || undefined,
      notes: editCust.notes.trim() || undefined,
      variantId: first.variantId,
      color: first.color ?? undefined,
      size: first.size ?? undefined,
    } as any);
  }

  function handleLogout() {
    localStorage.removeItem("employee_token");
    window.location.href = "/employee-login";
  }

  /** القفز لحقل به خطأ: يفتح قسمه ثم يركّز الحقل (لوحة المفاتيح/قارئ الشاشة). */
  function focusField(key: keyof FieldIssues) {
    setOpen(FIELD_SECTION[key], true);
    requestAnimationFrame(() => {
      const el = document.getElementById(FIELD_ID[key]) as HTMLElement | null;
      el?.focus?.(); el?.scrollIntoView?.({ block: "center" });
    });
  }
  function focusLine(i: number) {
    setOpen(4, true);
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-testid="legacy-line-${i}"], [data-testid="vop-item-${i}"]`);
      el?.scrollIntoView?.({ block: "center" });
      el?.querySelector<HTMLElement>("button, input, [role=combobox]")?.focus?.();
    });
  }

  if (meLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-muted-foreground" role="status" aria-live="polite">
          <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> جاري التحميل...
        </div>
      </div>
    );
  }
  if (!me) {
    window.location.href = "/employee-login";
    return null;
  }

  const inlineError = (id: string, msg?: string) => msg ? <p id={`${id}-error`} className="mt-1 flex items-center gap-1 text-xs text-destructive" role="alert"><AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />{msg}</p> : null;

  /** حقول العميل (الاسم/الهاتف/رقم إضافي) — `issues` للنموذج الرئيسي فقط؛ حوار التعديل بلا أخطاء مضمّنة كما كان. */
  const customerFields = (c: CustomerForm, set: (u: CustomerForm) => void, issues?: FieldIssues, idp = "f") => (
    <div className="space-y-3">
      <div>
        <Label htmlFor={`${idp}-customer-name`} className="text-xs flex items-center gap-1"><User className="h-3.5 w-3.5" aria-hidden="true" /> اسم العميل *</Label>
        <Input id={`${idp}-customer-name`} value={c.customerName} onChange={e => set({ ...c, customerName: e.target.value })} className={`mt-1 ${TOUCH}`} autoComplete="off" aria-invalid={!!issues?.customerName || undefined} aria-describedby={issues?.customerName ? `${idp}-customer-name-error` : undefined} />
        {inlineError(`${idp}-customer-name`, issues?.customerName)}
      </div>
      <div>
        <Label htmlFor={`${idp}-customer-phone`} className="text-xs flex items-center gap-1"><Phone className="h-3.5 w-3.5" aria-hidden="true" /> رقم الهاتف *</Label>
        <Input id={`${idp}-customer-phone`} value={c.customerPhone} onChange={e => set({ ...c, customerPhone: e.target.value })} className={`mt-1 ${TOUCH}`} inputMode="tel" dir="ltr" aria-invalid={!!issues?.customerPhone || undefined} aria-describedby={issues?.customerPhone ? `${idp}-customer-phone-error` : undefined} />
        {inlineError(`${idp}-customer-phone`, issues?.customerPhone)}
        {issues && !issues.customerPhone && phoneFormatWarning && (
          <p className="mt-1 flex items-center gap-1 text-xs text-[var(--warning)]" data-testid="phone-format-warning"><AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />{phoneFormatWarning}</p>
        )}
      </div>
      <div>
        <Label htmlFor={`${idp}-customer-phone2`} className="text-xs flex items-center gap-1"><Phone className="h-3.5 w-3.5" aria-hidden="true" /> رقم هاتف إضافي (اختياري)</Label>
        <Input id={`${idp}-customer-phone2`} value={c.customerPhone2} onChange={e => set({ ...c, customerPhone2: e.target.value })} className={`mt-1 ${TOUCH}`} inputMode="tel" dir="ltr" data-testid="phone2" />
      </div>
    </div>
  );
  /** العنوان والمحافظة/المدينة — GovernorateCitySelect كما هو (يعرض «مطلوبة» بنفسه). */
  const addressFields = (c: CustomerForm, set: (u: CustomerForm) => void, issues?: FieldIssues, idp = "f") => (
    <div className="space-y-3">
      <div id={`${idp}-governorate`} tabIndex={-1} className={`rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring ${TOUCH_SCOPE}`} aria-describedby={issues?.governorate ? `${idp}-governorate-error` : undefined}>
        <GovernorateCitySelect
          governorate={c.governorate}
          city={c.city}
          onGovernorateChange={v => set(v !== c.governorate ? { ...c, governorate: v, city: "" } : { ...c, governorate: v })}
          onCityChange={v => set({ ...c, city: v })}
          configuredGovernorates={governorateOptions.values}
          isLoading={governorateOptions.isLoading}
          isError={governorateOptions.isError}
        />
        {issues?.governorate && <span id={`${idp}-governorate-error`} className="sr-only">{issues.governorate}</span>}
      </div>
      <div>
        <Label htmlFor={`${idp}-address`} className="text-xs flex items-center gap-1"><MapPin className="h-3.5 w-3.5" aria-hidden="true" /> العنوان *</Label>
        <Input id={`${idp}-address`} value={c.customerAddress} onChange={e => set({ ...c, customerAddress: e.target.value })} className={`mt-1 ${TOUCH}`} aria-invalid={!!issues?.customerAddress || undefined} aria-describedby={issues?.customerAddress ? `${idp}-address-error` : undefined} />
        {inlineError(`${idp}-address`, issues?.customerAddress)}
      </div>
    </div>
  );
  /** الشحن ومصدر الإعلان والملاحظات. */
  const extraFields = (c: CustomerForm, set: (u: CustomerForm) => void, idp = "f") => (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor={`${idp}-shipping`} className="text-xs">الشحن</Label>
          <Input id={`${idp}-shipping`} type="number" inputMode="decimal" min="0" value={c.shipping} onChange={e => set({ ...c, shipping: e.target.value })} className={`mt-1 ${TOUCH}`} />
        </div>
        <div>
          <Label htmlFor={`${idp}-ad-name`} className="text-xs">مصدر الإعلان (اختياري)</Label>
          <Input id={`${idp}-ad-name`} value={c.adName} onChange={e => set({ ...c, adName: e.target.value })} className={`mt-1 ${TOUCH}`} />
        </div>
      </div>
      <div>
        <Label htmlFor={`${idp}-notes`} className="text-xs">ملاحظات (اختياري)</Label>
        <Input id={`${idp}-notes`} value={c.notes} onChange={e => set({ ...c, notes: e.target.value })} className={`mt-1 ${TOUCH}`} />
      </div>
    </div>
  );
  // حوار التعديل: نفس الحقول كلها متتالية كما كانت (بلا أقسام) — معرّفات مختلفة حتى لا تتصادم مع النموذج الرئيسي.
  const custForm = (c: CustomerForm, set: (u: CustomerForm) => void) => (
    <div className="space-y-3">
      {customerFields(c, set, undefined, "e")}
      {addressFields(c, set, undefined, "e")}
      {extraFields(c, set, "e")}
    </div>
  );

  const activeBusinessName = activeBusinessId != null ? businesses.find(b => b.id === activeBusinessId)?.name ?? null : null;
  const linesOk = items.length > 0 && !items.some(it => it.needsPick || it.needsVariantReview || !it.productId);
  const sectionStatus = {
    2: !fieldIssues.customerName && !fieldIssues.customerPhone ? { ok: true, text: "مكتمل" } : { ok: false, text: "ناقص" },
    3: !fieldIssues.governorate && !fieldIssues.customerAddress ? { ok: true, text: "مكتمل" } : { ok: false, text: "ناقص" },
    4: items.length === 0 ? { ok: false, text: "لا أصناف" } : linesOk ? { ok: true, text: `${items.length} سطر` } : { ok: false, text: "سطر يحتاج اختيارًا" },
    7: issueCount === 0 ? { ok: true, text: "جاهز للحفظ" } : { ok: false, text: `${issueCount} ملاحظة` },
  } as const;

  return (
    <main dir="rtl" className="min-h-screen bg-background p-3 sm:p-6" aria-label="إدخال أوردر يدوي">
      <div className="mx-auto max-w-3xl space-y-4">
        {/* الرأس */}
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <h1 className="text-lg font-bold">إدخال أوردر يدوي</h1>
            <p className="truncate text-xs text-muted-foreground">أهلاً {me.name}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" className={TOUCH} onClick={() => setShowOrders(s => !s)} aria-expanded={showOrders}>
              {showOrders ? "إخفاء أوردراتي" : "أوردراتي"}
            </Button>
            <Button data-readonly-safe size="sm" variant="ghost" className={`${TOUCH} min-w-11`} onClick={handleLogout} aria-label="خروج" title="خروج">
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>

        {/* انقطاع الاتصال: تنبيه واضح — الحفظ على السيرفر سيفشل، والمسودة المحلية متاحة. قواعد الحفظ لا تتغير. */}
        {!online && <OfflineState message="الحفظ على السيرفر غير ممكن الآن. ما كتبته باقٍ هنا — احفظ مسودة على هذا الجهاز ثم أعد المحاولة." className="py-6" />}

        {/* ملخّص المراجعة أعلى النموذج — مشتق من الحالة: كل سبب يختفي وحده فور إصلاح حقله/سطره */}
        {issueCount > 0 && (
          <div className="rounded-[var(--radius-brand-md)] border border-[var(--warning)]/50 bg-[var(--warning)]/5 p-3 text-sm" role="status" aria-live="polite" data-testid="review-summary">
            <p className="mb-1.5 flex items-center gap-1.5 font-semibold text-[var(--warning)]"><ListChecks className="h-4 w-4" aria-hidden="true" /> قبل الحفظ ({issueCount})</p>
            <ul className="space-y-1">
              {(Object.keys(fieldIssues) as (keyof FieldIssues)[]).map(k => (
                <li key={k}>
                  <button type="button" className="min-h-11 w-full text-start text-xs underline-offset-2 hover:underline sm:min-h-9" onClick={() => focusField(k)} data-testid={`review-jump-${k}`}>
                    {fieldIssues[k]}
                  </button>
                </li>
              ))}
              {blockers.map((b, i) => {
                const m = /رقم (\d+)/.exec(b);
                return (
                  <li key={`b-${i}`}>
                    <button type="button" className="min-h-11 w-full text-start text-xs underline-offset-2 hover:underline sm:min-h-9" onClick={() => (m ? focusLine(Number(m[1]) - 1) : setOpen(4, true))} data-testid={`review-jump-line-${i}`}>
                      {b}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {/* نموذج الإدخال — 7 أقسام مرقّمة قابلة للطي داخل الصفحة الواحدة */}
        {/*
          حاوية عادية لا <form>: داخل <form> يرسم Radix Select عنصر <select> أصليًا مخفيًا، وعند ضبط القيمة
          برمجيًا (استرجاع المسودة/التحليل) قبل تركيب خياراته يُطلق change بقيمة فارغة فتُمسح المحافظة والمدينة.
          الحفظ من زر صريح كما كان في الأصل.
        */}
        <div className="space-y-3 pb-[88px] sm:pb-0" role="group" aria-label="أوردر جديد">
          {/* 1 — النشاط والمصدر */}
          <EntrySection n={1} title="النشاط والمصدر" icon={<Building2 className="h-4 w-4" />} open={openSections[1]} onToggle={o => setOpen(1, o)}>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">النشاط</p>
                <p className="text-sm font-medium" data-testid="entry-business">{activeBusinessName ?? "يحدده السيرفر من نطاق حسابك"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">مصدر الأوردر</p>
                {/* السيرفر يسجّل الأوردرات من هذه الشاشة بمصدر facebook (addOrder) — فالشعار هنا صحيح */}
                <p className="inline-flex items-center gap-1.5 text-sm font-medium" data-testid="entry-source"><PartnerLogo partner="facebook" size="xs" decorative /> فيسبوك — إدخال يدوي</p>
              </div>
            </div>
            {/* لصق رسالة العميل — تحليل تلقائي وملء الحقول (تفضل قابلة للتعديل يدويًا). */}
            <div className="rounded-md border bg-muted/30 p-2 space-y-2">
              <Label htmlFor="f-paste" className="text-xs flex items-center gap-1">
                <ClipboardPaste className="h-3.5 w-3.5" aria-hidden="true" /> لصق رسالة العميل (تحليل تلقائي)
              </Label>
              <Textarea
                id="f-paste"
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                rows={4}
                dir="rtl"
                placeholder={"بيدج: ...\nالاسم: ...\nالعنوان: محافظة ...\nرقم الفون(1): 01xxxxxxxxx\nنوع المنتج: ...\nعدد القطع: ١\nاللون: اسود مقاس 8 سنين\nالشحن: مجانا\nالاجمالي: ..."}
                className="text-xs font-mono"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" className={TOUCH} onClick={parseAndFill} disabled={parsing || !pasteText.trim()} data-testid="parse-fill">
                  {parsing ? (
                    <span className="flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> جاري التحليل...</span>
                  ) : (
                    <span className="flex items-center gap-2"><ClipboardPaste className="h-4 w-4" aria-hidden="true" /> تحليل وملء</span>
                  )}
                </Button>
                <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" /> راجع الحقول بعد التحليل قبل الحفظ
                </span>
              </div>
            </div>
          </EntrySection>

          {/* 2 — العميل */}
          <EntrySection n={2} title="العميل" icon={<User className="h-4 w-4" />} open={openSections[2]} onToggle={o => setOpen(2, o)} status={sectionStatus[2]}>
            {customerFields(cust, setCust, fieldIssues)}
          </EntrySection>

          {/* 3 — العنوان والمحافظة */}
          <EntrySection n={3} title="العنوان والمحافظة" icon={<MapPin className="h-4 w-4" />} open={openSections[3]} onToggle={o => setOpen(3, o)} status={sectionStatus[3]}>
            {addressFields(cust, setCust, fieldIssues)}
          </EntrySection>

          {/* 4 — المنتجات والمتغيرات والكميات */}
          <EntrySection n={4} title={isLegacy ? "الأصناف — نوع النقش والكمية" : "الأصناف (من المخزون)"} icon={<Package className="h-4 w-4" />} open={openSections[4]} onToggle={o => setOpen(4, o)} status={sectionStatus[4]}>
            <div data-entry-mode={entryMode} className={TOUCH_SCOPE}>
              {catalogError && (
                <ErrorState title="تعذّر تحميل كتالوج نشاطك" message="بدون الكتالوج لا يمكن اختيار المنتجات. أعد المحاولة." onRetry={() => refetchCatalog()} className="mb-3" />
              )}
              {/* القالب من السيرفر بهوية الجلسة: مكوّنان منفصلان، نفس endpoints ونفس الحفظ الذرّي. */}
              {isLegacy ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    {structurallyEdited ? (
                      <span className="text-xs text-muted-foreground" data-testid="structural-edit-notice">تم تعديل اقتراح التحليل يدويًا</span>
                    ) : <span />}
                    <Button type="button" variant="outline" size="sm" className="h-11 min-h-[44px]" onClick={startManualEntry} data-testid="manual-entry">
                      إدخال يدوي
                    </Button>
                  </div>
                  <LegacyEngravingPicker catalog={catalog} value={items} onChange={setItems} suggestedUnitPrice={suggestedUnitPrice} />
                </div>
              ) : (
                <VariantOrderPicker catalog={catalog} value={items} onChange={setItems} />
              )}
              {piecesMismatch && (
                <div className="mt-2 flex items-center gap-1 text-xs text-[var(--warning)]" data-testid="pieces-soft-warning">
                  <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                  الرسالة تقول {expectedPieces} قطعة والسطور فيها {summary.pieces} — راجع الكميات لو لازم
                </div>
              )}
            </div>
          </EntrySection>

          {/* 5 — النقش/المتغير لكل قطعة: مراجعة سطر بسطر (كل سطر مستقل — لا دمج) */}
          <EntrySection n={5} title="مراجعة كل سطر" icon={<ClipboardCheck className="h-4 w-4" />} open={openSections[5]} onToggle={o => setOpen(5, o)} status={items.length === 0 ? undefined : linesOk ? { ok: true, text: "كل السطور محسومة" } : { ok: false, text: "راجع السطور" }}>
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="line-review-empty">لا سطور بعد — أضف الأصناف في القسم 4. كل قطعة بنقشها/متغيرها في سطر مستقل.</p>
            ) : (
              <ol className="divide-y divide-border" aria-label="سطور الأوردر">
                {items.map((it, i) => {
                  const unresolved = it.needsPick || it.needsVariantReview || !it.productId;
                  const variantText = it.optionLabel || [it.color, it.size].filter(Boolean).join(" / ") || (it.variantId ? `#${it.variantId}` : null);
                  return (
                    <li key={i} className="flex items-start justify-between gap-3 py-2 first:pt-0 last:pb-0" data-testid={`line-review-${i}`}>
                      <div className="min-w-0">
                        <p className="text-sm">
                          <span className="font-semibold">سطر {i + 1}</span>
                          <span className="text-muted-foreground"> · </span>
                          <span className="font-medium">{it.productName || "— لم يُحدَّد المنتج —"}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {variantText ? <span className="text-[var(--info)]">{variantText}</span> : <span>بدون متغير</span>}
                          {it.segmentText && <span> — من الرسالة: «{it.segmentText}»</span>}
                        </p>
                        {unresolved && (
                          <p className="mt-0.5 flex items-center gap-1 text-xs text-[var(--warning)]" data-testid={`line-review-warning-${i}`}>
                            <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" /> {it.pickReason ?? `اختر المنتج والنوع للصنف رقم ${i + 1}`}
                          </p>
                        )}
                      </div>
                      <div className="shrink-0 text-end text-sm tabular-nums">
                        <p className="font-semibold">× {it.quantity}</p>
                        <p className="text-xs text-muted-foreground">{(it.unitPrice * it.quantity).toFixed(2)} ج.م</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </EntrySection>

          {/* 6 — الشحن والدفع */}
          <EntrySection n={6} title="الشحن والدفع" icon={<Truck className="h-4 w-4" />} open={openSections[6]} onToggle={o => setOpen(6, o)}>
            {extraFields(cust, setCust)}
            <p className="text-xs text-muted-foreground" data-testid="payment-note">طريقة الدفع لا تُحدَّد من هذا النموذج (يُسجَّل الأوردر بالقواعد الحالية للنظام) — غير متاح هنا.</p>
          </EntrySection>

          {/* 7 — المراجعة والحفظ */}
          <EntrySection n={7} title="المراجعة والحفظ" icon={<ListChecks className="h-4 w-4" />} open={openSections[7]} onToggle={o => setOpen(7, o)} status={sectionStatus[7]}>
            {/* ملخّص الأوردر — بيتحدّث فورًا مع أي تعديل في كمية أو سعر أو شحن أو خصم */}
            <div className="rounded-lg border bg-muted/30 p-3 space-y-1 text-sm" data-testid="order-summary">
              <div className="flex justify-between">
                <span className="text-muted-foreground">عدد القطع</span>
                <span className="font-semibold" data-testid="sum-pieces">{summary.pieces}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">إجمالي الأصناف</span>
                <span className="font-semibold">{summary.itemsSubtotal.toFixed(2)} ج.م</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="sum-shipping" className="text-muted-foreground font-normal">الشحن</Label>
                <Input
                  id="sum-shipping"
                  type="number" min="0" step="0.01" value={cust.shipping}
                  onChange={e => setCust(c => ({ ...c, shipping: e.target.value }))}
                  className={`w-28 text-left ${TOUCH} sm:min-h-9 sm:h-9`} data-testid="sum-shipping"
                />
              </div>
              {pasteExpected?.itemsTotal != null && (
                <div className={`flex justify-between text-xs ${Math.round(summary.itemsSubtotal * 100) === Math.round(pasteExpected.itemsTotal * 100) ? "text-[var(--success)]" : "text-destructive"}`} data-testid="sum-items-expected">
                  <span>إجمالي المنتجات في الرسالة</span>
                  <span className="font-semibold tabular-nums">{pasteExpected.itemsTotal.toFixed(2)} ج.م {Math.round(summary.itemsSubtotal * 100) === Math.round(pasteExpected.itemsTotal * 100) ? "✓" : "≠"}</span>
                </div>
              )}
              {(!isLegacy || Number(cust.discount) > 0 || !!pasteExpected) && (
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="sum-discount" className="text-muted-foreground font-normal">الخصم</Label>
                  <Input
                    id="sum-discount"
                    type="number" min="0" step="0.01" value={cust.discount}
                    onChange={e => setCust(c => ({ ...c, discount: e.target.value }))}
                    className={`w-28 text-left ${TOUCH} sm:min-h-9 sm:h-9`} data-testid="sum-discount"
                  />
                </div>
              )}
              <div className="flex justify-between border-t pt-1 text-base">
                <span className="font-semibold">الإجمالي النهائي</span>
                <span className="font-bold" data-testid="sum-total">{summary.total.toFixed(2)} ج.م</span>
              </div>
              {totalMismatch && (
                <label className="flex min-h-11 items-center gap-2 pt-1 text-xs text-[var(--warning)]">
                  <input
                    type="checkbox" checked={totalConfirmed}
                    onChange={e => setTotalConfirmed(e.target.checked)}
                    className="h-5 w-5"
                    data-testid="confirm-total"
                  />
                  الإجمالي المكتوب في الرسالة لا يساوي الحساب — راجعته وأؤكده
                </label>
              )}
            </div>

            {/* سبب تعطيل الحفظ بالعربي — الموظف مايضغطش زرًا مقفولًا بلا تفسير */}
            {blockers.length > 0 && (
              <div className="rounded-lg border border-[var(--warning)] bg-[var(--warning)]/5 p-2 text-xs space-y-1" data-testid="save-blockers">
                {blockers.map((b, i) => (
                  <div key={i} className="flex items-center gap-1 text-[var(--warning)]">
                    <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" /> {b}
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">آخر حقل فوق زر الحفظ دائمًا؛ الشريط أدناه يبقى ظاهرًا أثناء التمرير على الموبايل.</p>
          </EntrySection>

          {/* شريط الحفظ ثابت أسفل الشاشة على الهاتف (بخلفية + safe-area) — النموذج له حشو سفلي فلا يغطي آخر حقل؛ عادي على sm+ */}
          <div className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-2 border-t border-border bg-background/95 px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-0" data-testid="save-bar">
            <Button
              type="button"
              onClick={submit}
              disabled={addOrderMutation.isPending || blockers.length > 0}
              className="h-11 min-h-[44px] flex-1"
              data-testid="save-order"
              aria-busy={addOrderMutation.isPending || undefined}
            >
              {addOrderMutation.isPending ? (
                <span className="flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" /> جاري الحفظ...</span>
              ) : (
                <span className="flex items-center gap-2"><Plus className="h-4 w-4" aria-hidden="true" /> حفظ الأوردر</span>
              )}
            </Button>
            <Button type="button" variant="outline" className={`${TOUCH} min-w-11`} onClick={saveDraft} title="حفظ مسودة" aria-label="حفظ مسودة" data-testid="save-draft"><Save className="h-4 w-4" aria-hidden="true" /></Button>
            <Button type="button" variant="ghost" className={`${TOUCH} min-w-11`} onClick={clearForm} title="مسح" aria-label="مسح النموذج" data-testid="clear-form"><Eraser className="h-4 w-4" aria-hidden="true" /></Button>
          </div>
        </div>

        {/* أوردراتي */}
        {showOrders && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">أوردراتي</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={`text-xs ${TOUCH}`} aria-label="من تاريخ" />
                <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={`text-xs ${TOUCH}`} aria-label="إلى تاريخ" />
                <Button data-readonly-safe size="sm" variant="outline" className={`${TOUCH} min-w-11`} onClick={() => refetchOrders()} aria-label="تحديث"><RefreshCw className="h-4 w-4" aria-hidden="true" /></Button>
              </div>
              {myOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">لا توجد أوردرات</p>
              ) : (
                <div className="space-y-2">
                  {myOrders.map((o: any) => (
                    <div key={o.id} className="rounded-md border p-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">#{o.orderNumber}</span>
                        <div className="flex items-center gap-1">
                          <Badge variant="secondary">{o.status}</Badge>
                          {o.status === "new" && (
                            <>
                              <Button size="sm" variant="ghost" className="h-11 w-11 p-0 sm:h-8 sm:w-8" onClick={() => openEdit(o)} aria-label="تعديل"><Pencil className="h-3.5 w-3.5" aria-hidden="true" /></Button>
                              <Button size="sm" variant="ghost" className="h-11 w-11 p-0 text-destructive sm:h-8 sm:w-8" onClick={() => setDeletingOrderId(o.id)} aria-label="حذف"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></Button>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="text-muted-foreground">{o.customerName} · {o.customerPhone} · {o.governorate}</div>
                      <div className="flex items-center gap-1 flex-wrap mt-1">
                        <span>{o.productName}</span>
                        {o.color && <Badge variant="outline">{o.color}</Badge>}
                        {o.size && <Badge variant="outline">{o.size}</Badge>}
                        <span className="text-muted-foreground">×{o.quantity}</span>
                        <span className="font-semibold mr-auto">{o.totalAmount} ج.م</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* حوار التعديل */}
      <Dialog open={!!editingOrder} onOpenChange={o => { if (!o) setEditingOrder(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>تعديل الأوردر #{editingOrder?.orderNumber}</DialogTitle></DialogHeader>
          <div className="space-y-4 max-h-[70vh] overflow-y-auto">
            {custForm(editCust, setEditCust)}
            <div className="border-t pt-3">
              <Label className="text-sm font-semibold">الأصناف</Label>
              <div className={`mt-2 ${TOUCH_SCOPE}`}>
                <VariantOrderPicker catalog={catalog} value={editItems} onChange={setEditItems} />
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className={TOUCH} onClick={() => setEditingOrder(null)}>إلغاء</Button>
            <Button type="button" className={TOUCH} onClick={submitEdit} disabled={updateOrderMutation.isPending}>
              {updateOrderMutation.isPending ? "جاري الحفظ..." : "حفظ التعديل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* تأكيد الحذف */}
      <Dialog open={deletingOrderId != null} onOpenChange={o => { if (!o) setDeletingOrderId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>حذف الأوردر؟</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">لا يمكن التراجع عن هذه العملية.</p>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className={TOUCH} onClick={() => setDeletingOrderId(null)}>إلغاء</Button>
            <Button type="button" variant="destructive" className={TOUCH} onClick={() => deletingOrderId != null && deleteOrderMutation.mutate({ orderId: deletingOrderId })} disabled={deleteOrderMutation.isPending}>
              <Trash2 className="h-4 w-4 ml-1" aria-hidden="true" /> حذف
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
