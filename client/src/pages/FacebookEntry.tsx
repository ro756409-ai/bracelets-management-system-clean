import { useState, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Plus, Phone, MapPin, Package, Calendar, Megaphone, LogOut, RefreshCw, ClipboardPaste, X, Check, Trash2, Pencil, StickyNote, AlertTriangle } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

const EGYPT_GOVERNORATES = [
  "القاهرة", "الجيزة", "الإسكندرية", "الدقهلية", "البحر الأحمر",
  "البحيرة", "الفيوم", "الغربية", "الإسماعيلية", "المنوفية",
  "المنيا", "القليوبية", "الوادي الجديد", "السويس", "أسوان",
  "أسيوط", "بني سويف", "بورسعيد", "دمياط", "الشرقية",
  "جنوب سيناء", "كفر الشيخ", "مطروح", "الأقصر", "قنا",
  "شمال سيناء", "سوهاج",
];

// ID منتج كفر مرتبة ووتر بروف
const WATERPROOF_PRODUCT_ID = 60001;

/** Colour + label for the parsing-confidence meter. */
function confidenceTone(pct: number) {
  if (pct >= 75) return { label: "عالية", text: "text-emerald-700", bar: "bg-emerald-500" };
  if (pct >= 45) return { label: "متوسطة", text: "text-amber-700", bar: "bg-amber-500" };
  return { label: "منخفضة — راجع كل الحقول", text: "text-red-700", bar: "bg-red-500" };
}

/** Arabic labels for the fields the confidence meter reports on. */
const FIELD_LABELS: Record<string, string> = {
  customerName: "اسم العميل",
  phone: "رقم الهاتف",
  governorate: "المحافظة",
  address: "العنوان",
  city: "المنطقة",
  orderTotal: "الإجمالي",
  shipping: "الشحن",
};

/** A field needs a human look when the parser was unsure or found nothing at all. */
const LOW_CONFIDENCE = new Set(["low", "missing"]);

/**
 * One line item on the entry form. `productId` is optional so an item the parser could not
 * match is still shown (and saved for review) instead of being silently dropped.
 */
type FormItem = {
  productId?: number;
  productName: string;
  quantity: number;
  variantId?: number;
  variantName?: string;
  /** Set by the paste parser; absent for manually-picked items (always matched). */
  status?: "matched" | "ambiguous" | "unmatched";
  candidates?: { id: number; name: string }[];
  /** Original phrase from the pasted message, kept so the reviewer can see the source. */
  rawText?: string;
};

type FormState = {
  customerName: string;
  customerPhone: string;
  governorate: string;
  customerAddress: string;
  city: string;
  selectedProducts: FormItem[];
  quantity: number;
  totalAmount: number;
  shippingCost: number;
  adName: string;
  notes: string;
  variantId?: number;
  size?: string;
  color?: string;
  /** Verbatim pasted message, submitted with the order for audit. */
  rawText?: string;
};

const EMPTY_FORM: FormState = {
  customerName: "",
  customerPhone: "",
  governorate: "",
  customerAddress: "",
  city: "",
  selectedProducts: [],
  quantity: 1,
  totalAmount: 0,
  shippingCost: 0,
  adName: "",
  notes: "",
  variantId: undefined,
  size: undefined,
  color: undefined,
};

export default function FacebookEntry() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [pasteText, setPasteText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  /** Full parser result — drives the confidence meter and field highlighting. */
  const [parseResult, setParseResult] = useState<any>(null);
  const [autoParse, setAutoParse] = useState(true);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [showOrders, setShowOrders] = useState(false);

  // Edit dialog state
  const [editingOrder, setEditingOrder] = useState<any>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);

  // Delete confirmation state
  const [deletingOrderId, setDeletingOrderId] = useState<number | null>(null);

  // Check employee session
  const { data: me, isLoading: meLoading } = trpc.employeePortal.me.useQuery();

  // Products list
  const { data: products = [] } = trpc.facebookEntry.products.useQuery();
  /** Active products + variants — engraving types live in variants, so both are needed. */
  const { data: catalog } = trpc.facebookEntry.catalog.useQuery();

  // هل تم اختيار كفر وتر بروف في الفورم الرئيسي؟
  const isWaterproofSelected = form.selectedProducts.some(p => p.productId === WATERPROOF_PRODUCT_ID);
  // هل تم اختيار كفر وتر بروف في فورم التعديل؟
  const isEditWaterproofSelected = editForm.selectedProducts.some(p => p.productId === WATERPROOF_PRODUCT_ID);

  // جلب variants كفر وتر بروف
  const { data: waterproofVariants = [] } = trpc.facebookEntry.productVariants.useQuery(
    { productId: WATERPROOF_PRODUCT_ID },
    { enabled: isWaterproofSelected || isEditWaterproofSelected }
  );

  // استخراج المقاسات والألوان الفريدة
  const waterproofSizes = useMemo(() => Array.from(new Set(waterproofVariants.map((v: any) => v.size).filter(Boolean))), [waterproofVariants]);
  const waterproofColors = useMemo(() => {
    if (!form.size) return Array.from(new Set(waterproofVariants.map((v: any) => v.color).filter(Boolean)));
    return Array.from(new Set(waterproofVariants.filter((v: any) => v.size === form.size).map((v: any) => v.color).filter(Boolean)));
  }, [waterproofVariants, form.size]);
  const editWaterproofColors = useMemo(() => {
    if (!editForm.size) return Array.from(new Set(waterproofVariants.map((v: any) => v.color).filter(Boolean)));
    return Array.from(new Set(waterproofVariants.filter((v: any) => v.size === editForm.size).map((v: any) => v.color).filter(Boolean)));
  }, [waterproofVariants, editForm.size]);

  // My orders
  const { data: myOrders = [], refetch: refetchOrders } = trpc.facebookEntry.myOrders.useQuery(
    { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined },
    { enabled: showOrders }
  );

  const addOrderMutation = trpc.facebookEntry.addOrder.useMutation({
    onSuccess: (data) => {
      toast.success(`✅ تم إضافة الأوردر بنجاح — رقم: ${data.orderNumber}`);
      setForm(EMPTY_FORM);
      setPasteText("");
      setParseResult(null);
      if (showOrders) refetchOrders();
    },
    onError: (e) => toast.error(`خطأ: ${e.message}`),
  });

  const deleteOrderMutation = trpc.facebookEntry.deleteOrder.useMutation({
    onSuccess: () => {
      toast.success("✅ تم حذف الأوردر بنجاح");
      setDeletingOrderId(null);
      refetchOrders();
    },
    onError: (e) => toast.error(`خطأ: ${e.message}`),
  });

  const updateOrderMutation = trpc.facebookEntry.updateOrder.useMutation({
    onSuccess: () => {
      toast.success("✅ تم تعديل الأوردر بنجاح");
      setEditingOrder(null);
      refetchOrders();
    },
    onError: (e) => toast.error(`خطأ: ${e.message}`),
  });

  /** Field keys the parser flagged low/missing — drives highlighting on the review form. */
  const lowConfidenceFields = useMemo(() => {
    const set = new Set<string>();
    if (!parseResult) return set;
    for (const key of Object.keys(FIELD_LABELS)) {
      const field = parseResult[key];
      if (field && LOW_CONFIDENCE.has(field.confidence)) set.add(key);
    }
    return set;
  }, [parseResult]);

  const needsAttention = useMemo(
    () => Array.from(lowConfidenceFields).map((k) => FIELD_LABELS[k]),
    [lowConfidenceFields]
  );

  /** Ring styling applied to any input the parser was unsure about. */
  const fieldClass = (key: string) =>
    lowConfidenceFields.has(key) ? "border-amber-500 bg-amber-50 ring-1 ring-amber-300" : "";

  // العدد الإجمالي للقطع = مجموع كميات البنود
  const totalPieces = useMemo(
    () => form.selectedProducts.reduce((sum, p) => sum + (p.quantity || 1), 0),
    [form.selectedProducts]
  );
  const editTotalPieces = useMemo(
    () => editForm.selectedProducts.reduce((sum, p) => sum + (p.quantity || 1), 0),
    [editForm.selectedProducts]
  );

  // الإجمالي المقترح (اقتراحي فقط — الموظف يحدد السعر يدوياً)
  const calculatedTotal = useMemo(() => {
    if (products.length === 0 || form.selectedProducts.length === 0) return 0;
    const pricePerPiece = 270;
    return pricePerPiece * totalPieces + form.shippingCost;
  }, [form.selectedProducts, totalPieces, form.shippingCost, products]);

  const editCalculatedTotal = useMemo(() => {
    if (products.length === 0 || editForm.selectedProducts.length === 0) return 0;
    const pricePerPiece = 270;
    return pricePerPiece * editTotalPieces + editForm.shippingCost;
  }, [editForm.selectedProducts, editTotalPieces, editForm.shippingCost, products]);

  // Toggle product selection (يضيف/يشيل بند، الكمية الافتراضية 1)
  // Manual picker toggles the plain parent product only. Parsed items carrying a variantId
  // are left alone — several of them can share the same productId (all bracelet engravings
  // hang off one parent), so they must never be matched by productId alone.
  const toggleProduct = (productId: number, productName: string) => {
    setForm((f) => {
      const exists = f.selectedProducts.find((p) => p.productId === productId && !p.variantId);
      const newProducts = exists
        ? f.selectedProducts.filter((p) => !(p.productId === productId && !p.variantId))
        : [...f.selectedProducts, { productId, productName, quantity: 1, status: "matched" as const }];
      return { ...f, selectedProducts: newProducts };
    });
  };

  // Toggle product selection for edit form
  const toggleEditProduct = (productId: number, productName: string) => {
    setEditForm((f) => {
      const exists = f.selectedProducts.find((p) => p.productId === productId && !p.variantId);
      const newProducts = exists
        ? f.selectedProducts.filter((p) => !(p.productId === productId && !p.variantId))
        : [...f.selectedProducts, { productId, productName, quantity: 1, status: "matched" as const }];
      return { ...f, selectedProducts: newProducts };
    });
  };

  // تغيير كمية بند في فورم التعديل — بالفهرس، لأن أكثر من نقش قد يشترك في نفس المنتج الأب
  const setEditItemQuantityAt = (index: number, quantity: number) => {
    setEditForm((f) => {
      const items = [...f.selectedProducts];
      items[index] = { ...items[index], quantity: Math.max(1, quantity || 1) };
      return { ...f, selectedProducts: items };
    });
  };

  const removeEditItemAt = (index: number) => {
    setEditForm((f) => ({ ...f, selectedProducts: f.selectedProducts.filter((_, i) => i !== index) }));
  };

  // Open edit dialog with order data
  const openEditDialog = (order: any) => {
    let matchedProducts: { productId: number; productName: string; quantity: number }[] = [];
    // الأفضل: استخدام البنود الفعلية المخزّنة
    if (Array.isArray(order.items) && order.items.length > 0) {
      matchedProducts = order.items.map((it: any) => ({
        productId: it.productId ?? (products.find((p: any) => p.name === it.productName)?.id ?? 0),
        productName: it.productName,
        quantity: it.quantity || 1,
      })).filter((p: any) => p.productId > 0);
    } else {
      // fallback: تحليل الاسم المدمج (للأوردرات القديمة)
      const orderProductNames = (order.productName || "").split(" + ").map((n: string) => n.trim());
      for (const raw of orderProductNames) {
        // استخراج الكمية لو الاسم بالشكل "اسم ×3"
        const m = raw.match(/^(.*?)\s*×\s*(\d+)$/);
        const name = m ? m[1].trim() : raw;
        const qty = m ? parseInt(m[2]) || 1 : 1;
        const product = products.find((p: any) => p.name === name);
        if (product) {
          matchedProducts.push({ productId: product.id, productName: product.name, quantity: qty });
        }
      }
    }

    setEditForm({
      customerName: order.customerName || "",
      customerPhone: order.customerPhone || "",
      governorate: order.governorate || "",
      customerAddress: order.customerAddress || "",
      city: order.city || "",
      selectedProducts: matchedProducts.length > 0 ? matchedProducts : [],
      quantity: order.quantity || 1,
      totalAmount: Number(order.totalAmount) || 0,
      shippingCost: 0,
      adName: order.adName || "",
      notes: order.notes || "",
    });
    setEditingOrder(order);
  };

  // ==================== Paste parsing ====================
  // Parsing runs on the SERVER so it always uses the live catalog (active products +
  // variants) and the same tested parser module. It only fills a review form — it never
  // submits, and never invents values the message did not contain.
  const parseQuery = trpc.facebookEntry.parseOrder.useQuery(
    { text: pasteText },
    { enabled: false, retry: false }
  );

  const applyParsed = (parsed: any) => {
    setForm((f) => ({
      ...f,
      customerName: parsed.customerName?.value ?? f.customerName,
      customerPhone: parsed.phone?.value ?? f.customerPhone,
      governorate: parsed.governorate?.value ?? f.governorate,
      customerAddress: parsed.address?.value ?? f.customerAddress,
      city: parsed.city?.value ?? f.city,
      selectedProducts: parsed.items?.length
        ? parsed.items.map((i: any) => ({
            productId: i.productId,
            productName: i.variantName
              ? `${i.productName} - ${i.variantName}`
              : (i.productName ?? i.rawText),
            quantity: i.quantity,
            variantId: i.variantId,
            variantName: i.variantName,
            status: i.status,
            candidates: i.candidates,
            rawText: i.rawText,
          }))
        : f.selectedProducts,
      quantity: parsed.totalQuantity || f.quantity,
      // Absent values stay absent — never coerced to 0.
      totalAmount: parsed.orderTotal?.value ?? f.totalAmount,
      shippingCost: parsed.shipping?.value ?? f.shippingCost,
      adName: parsed.adName?.value ?? f.adName,
      notes: parsed.notes?.value ?? f.notes,
      rawText: parsed.rawText,
    }));
    setParseResult(parsed);
  };

  const parsePastedOrder = async () => {
    if (!pasteText.trim()) {
      toast.error("الصق نص الأوردر أولاً");
      return;
    }
    try {
      const parsed = await parseQuery.refetch().then((r) => r.data);
      if (!parsed) {
        toast.error("تعذّر تحليل النص");
        return;
      }
      applyParsed(parsed);
      const unresolved = parsed.items.filter((i: any) => i.status !== "matched").length;
      if (parsed.items.length === 0) {
        toast.warning("لم يتم التعرّف على أي صنف — أكمل الاختيار يدويًا");
      } else if (unresolved > 0) {
        toast.warning(`تم التحليل — ${unresolved} صنف يحتاج تأكيد يدوي`);
      } else {
        toast.success("تم التحليل — راجع البيانات قبل الحفظ");
      }
    } catch (err: any) {
      toast.error(err?.message ?? "تعذّر تحليل النص");
    }
  };

  // Auto-parse shortly after the employee stops typing/pasting. Debounced so it does not
  // fire on every keystroke; it still only fills the form and never submits.
  useEffect(() => {
    if (!autoParse || !pasteText.trim() || pasteText.trim().length < 12) return;
    const t = setTimeout(() => { void parsePastedOrder(); }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pasteText, autoParse]);

  /** Resolves an ambiguous item once the employee picks a candidate variant. */
  const chooseCandidate = (index: number, candidateId: number) => {
    setForm((f) => {
      const items = [...f.selectedProducts];
      const item = items[index];
      const chosen = item.candidates?.find((c) => c.id === candidateId);
      const variant = (catalog?.variants ?? []).find((v: any) => v.id === candidateId);
      const parent = (catalog?.products ?? []).find((p: any) => p.id === variant?.productId);
      items[index] = {
        ...item,
        productId: parent?.id ?? item.productId,
        variantId: candidateId,
        variantName: chosen?.name ?? variant?.name ?? undefined,
        productName: parent && chosen ? `${parent.name} - ${chosen.name}` : item.productName,
        status: "matched",
        candidates: undefined,
      };
      return { ...f, selectedProducts: items };
    });
  };

  /** Assigns a product/variant to an item the parser could not match. */
  const assignItemVariant = (index: number, variantId: number) => {
    const variant = (catalog?.variants ?? []).find((v: any) => v.id === variantId);
    const parent = (catalog?.products ?? []).find((p: any) => p.id === variant?.productId);
    if (!variant || !parent) return;
    setForm((f) => {
      const items = [...f.selectedProducts];
      items[index] = {
        ...items[index],
        productId: parent.id,
        variantId: variant.id,
        variantName: variant.name ?? undefined,
        productName: `${parent.name} - ${variant.name}`,
        status: "matched",
        candidates: undefined,
      };
      return { ...f, selectedProducts: items };
    });
  };

  const removeItemAt = (index: number) => {
    setForm((f) => ({ ...f, selectedProducts: f.selectedProducts.filter((_, i) => i !== index) }));
  };

  const setItemQuantityAt = (index: number, quantity: number) => {
    setForm((f) => {
      const items = [...f.selectedProducts];
      items[index] = { ...items[index], quantity: Math.max(1, quantity || 1) };
      return { ...f, selectedProducts: items };
    });
  };


  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.customerName || !form.customerPhone || !form.governorate || !form.customerAddress || form.selectedProducts.length === 0) {
      toast.error("يرجى ملء جميع الحقول المطلوبة واختيار منتج واحد على الأقل");
      return;
    }
    if (isWaterproofSelected && (!form.size || !form.color)) {
      toast.error("يرجى اختيار مقاس ولون الكفر الوتر بروف");
      return;
    }
    const finalTotal = form.totalAmount > 0 ? form.totalAmount : calculatedTotal;
    // إيجاد الـ variantId المناسب
    let variantId: number | undefined;
    if (isWaterproofSelected && form.size && form.color) {
      const variant = waterproofVariants.find((v: any) => v.size === form.size && v.color === form.color);
      variantId = variant?.id;
    }
    addOrderMutation.mutate({
      customerName: form.customerName,
      customerPhone: form.customerPhone,
      governorate: form.governorate,
      customerAddress: form.customerAddress,
      city: form.city || undefined,
      // Unresolved items are sent through as-is (productId undefined). The server flags the
      // order needsReview instead of dropping the line, so nothing is lost silently.
      selectedProducts: form.selectedProducts.map((p) => ({
        productId: p.productId,
        productName: p.productName,
        quantity: p.quantity,
        variantId: p.variantId,
      })),
      quantity: totalPieces || form.quantity,
      totalAmount: finalTotal,
      shippingCost: form.shippingCost || undefined,
      rawText: form.rawText,
      adName: form.adName || undefined,
      notes: form.notes || undefined,
      variantId,
      size: form.size || undefined,
      color: form.color || undefined,
    });
  };

  const handleEditSubmit = () => {
    if (!editingOrder) return;
    if (!editForm.customerName || !editForm.customerPhone || !editForm.governorate || !editForm.customerAddress || editForm.selectedProducts.length === 0) {
      toast.error("يرجى ملء جميع الحقول المطلوبة واختيار منتج واحد على الأقل");
      return;
    }
    if (isEditWaterproofSelected && (!editForm.size || !editForm.color)) {
      toast.error("يرجى اختيار مقاس ولون الكفر الوتر بروف");
      return;
    }
    const finalTotal = editForm.totalAmount > 0 ? editForm.totalAmount : editCalculatedTotal;
    let variantId: number | undefined;
    if (isEditWaterproofSelected && editForm.size && editForm.color) {
      const variant = waterproofVariants.find((v: any) => v.size === editForm.size && v.color === editForm.color);
      variantId = variant?.id;
    }
    updateOrderMutation.mutate({
      orderId: editingOrder.id,
      customerName: editForm.customerName,
      customerPhone: editForm.customerPhone,
      governorate: editForm.governorate,
      customerAddress: editForm.customerAddress,
      // The edit dialog only ever holds resolved items, but narrow explicitly rather than
      // asserting — an unresolved line is skipped here instead of being sent with no product.
      selectedProducts: editForm.selectedProducts.flatMap((p) =>
        p.productId ? [{ productId: p.productId, productName: p.productName, quantity: p.quantity }] : []
      ),
      quantity: editTotalPieces || editForm.quantity,
      totalAmount: finalTotal,
      adName: editForm.adName || undefined,
      notes: editForm.notes || undefined,
      variantId,
      size: editForm.size || undefined,
      color: editForm.color || undefined,
    });
  };

  const handleLogout = () => {
    localStorage.removeItem("employee_token");
    window.location.href = "/employee-login";
  };

  if (meLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#1a0a00]">
        <div className="text-amber-200 text-lg">جاري التحميل...</div>
      </div>
    );
  }

  if (!me) {
    window.location.href = "/employee-login";
    return null;
  }

  const finalTotal = form.totalAmount > 0 ? form.totalAmount : calculatedTotal;
  const editFinalTotal = editForm.totalAmount > 0 ? editForm.totalAmount : editCalculatedTotal;

  return (
    <div className="min-h-screen bg-[#f5f0e8]" dir="rtl">
      {/* Header */}
      <div className="bg-[#3d1a00] text-white px-4 py-3 flex items-center justify-between shadow-lg">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-amber-500 rounded-full flex items-center justify-center font-bold text-sm">
            {me.name?.charAt(0) ?? "م"}
          </div>
          <div>
            <p className="font-semibold text-sm">{me.name}</p>
            <p className="text-xs text-amber-300">إدخال أوردرات فيسبوك</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            className="text-amber-200 hover:text-white hover:bg-white/10 text-xs gap-1"
            onClick={() => setShowOrders(!showOrders)}
          >
            <Package className="h-4 w-4" />
            {showOrders ? "إخفاء" : "أوردراتي"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-amber-200 hover:text-white hover:bg-white/10"
            onClick={handleLogout}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="max-w-lg mx-auto p-4 space-y-4">
        {/* Paste Order Button */}
        <Button
          variant="outline"
          className="w-full h-12 border-dashed border-2 border-amber-400 bg-amber-50 hover:bg-amber-100 text-amber-800 font-semibold gap-2"
          onClick={() => setShowPaste(!showPaste)}
        >
          <ClipboardPaste className="h-5 w-5" />
          {showPaste ? "إخفاء خانة اللصق" : "📋 الصق أوردر كامل (تحليل تلقائي)"}
        </Button>

        {/* Paste Area */}
        {showPaste && (
          <Card className="border-amber-300 border-2 shadow-md">
            <CardContent className="p-4 space-y-3">
              <Label className="text-sm font-semibold text-amber-800">الصق نص الأوردر هنا:</Label>
              <textarea
                className="w-full h-40 border border-amber-200 rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white"
                placeholder={`مثال:\nبيدج:عتبة  التاريخ: 25/4\nالاسم أشرف ابو دياب\nالعنوان :محافظة الشرقية ابو حماد...\nرقم الفون(١):01032579720\nنوع المنتج :ايه الكرسي   عدد القطع: 1\nالسعر: 180  الشحن: 40  الاجمالي:220`}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                dir="rtl"
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  className="flex-1 bg-amber-600 hover:bg-amber-700 text-white gap-1"
                  onClick={parsePastedOrder}
                  disabled={parseQuery.isFetching}
                >
                  {parseQuery.isFetching
                    ? <><RefreshCw className="h-4 w-4 animate-spin" /> جاري التحليل…</>
                    : <><Check className="h-4 w-4" /> مسح النص وتحليل الأوردر</>}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="gap-1"
                  onClick={() => { setShowPaste(false); setPasteText(""); setParseResult(null); }}
                >
                  <X className="h-4 w-4" />
                  إلغاء
                </Button>
              </div>

              <label className="flex items-center gap-2 text-xs text-amber-800">
                <input
                  type="checkbox"
                  checked={autoParse}
                  onChange={(e) => setAutoParse(e.target.checked)}
                  className="h-3.5 w-3.5 accent-amber-600"
                />
                تحليل تلقائي بعد التوقف عن الكتابة
              </label>

              {/* Confidence meter. Parsing only fills the form — saving stays a separate,
                  deliberate action by the employee. */}
              {parseResult && (
                <div className="space-y-2 rounded-lg border border-amber-200 bg-white p-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-amber-900">دقة التحليل</span>
                    <span className={confidenceTone(parseResult.confidence).text}>
                      {parseResult.confidence}% — {confidenceTone(parseResult.confidence).label}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
                    <div
                      className={`h-full ${confidenceTone(parseResult.confidence).bar}`}
                      style={{ width: `${parseResult.confidence}%` }}
                    />
                  </div>
                  {needsAttention.length > 0 && (
                    <p className="flex items-start gap-1 text-[11px] text-amber-800">
                      <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                      راجع يدويًا: {needsAttention.join("، ")}
                    </p>
                  )}
                  <p className="text-[11px] text-gray-500">
                    التحليل يملأ النموذج فقط — لن يُحفظ الأوردر إلا بضغطك على زر الحفظ.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Add Order Form */}
        <Card className="border-0 shadow-md">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-[#3d1a00]">
              <Plus className="h-5 w-5 text-amber-600" />
              إضافة أوردر فيسبوك جديد
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Customer Name */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">اسم العميل *</Label>
                <Input
                  placeholder="اسم العميل الكامل"
                  value={form.customerName}
                  onChange={(e) => setForm((f) => ({ ...f, customerName: e.target.value }))}
                  className={`h-10 ${fieldClass("customerName")}`}
                  required
                />
              </div>

              {/* Phone */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium flex items-center gap-1">
                  <Phone className="h-3.5 w-3.5" /> رقم التليفون *
                </Label>
                <Input
                  placeholder="01xxxxxxxxx"
                  value={form.customerPhone}
                  onChange={(e) => setForm((f) => ({ ...f, customerPhone: e.target.value }))}
                  className={`h-10 ${fieldClass("phone")}`}
                  dir="ltr"
                  required
                />
              </div>

              {/* Governorate */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" /> المحافظة *
                </Label>
                <Select
                  value={form.governorate}
                  onValueChange={(v) => setForm((f) => ({ ...f, governorate: v }))}
                >
                  <SelectTrigger className={`h-10 ${fieldClass("governorate")}`}>
                    <SelectValue placeholder="اختر المحافظة" />
                  </SelectTrigger>
                  <SelectContent>
                    {EGYPT_GOVERNORATES.map((g) => (
                      <SelectItem key={g} value={g}>{g}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Address */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">العنوان التفصيلي *</Label>
                <Input
                  placeholder="الشارع، المنطقة، الحي..."
                  value={form.customerAddress}
                  onChange={(e) => setForm((f) => ({ ...f, customerAddress: e.target.value }))}
                  className={`h-10 ${fieldClass("address")}`}
                  required
                />
              </div>

              {/* City / area — optional, filled by the parser when the message names one */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">المدينة / المنطقة</Label>
                <Input
                  placeholder="مثال: ابو حماد"
                  value={form.city}
                  onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                  className={`h-10 ${fieldClass("city")}`}
                />
              </div>

              {/* Product Multi-Select */}
              <div className="space-y-2">
                <Label className="text-sm font-medium flex items-center gap-1">
                  <Package className="h-3.5 w-3.5" /> نوع المنتج / الحفر * <span className="text-xs text-muted-foreground">(اختر واحد أو أكتر)</span>
                </Label>
                <div className="flex flex-wrap gap-2">
                  {products.map((p: any) => {
                    const isSelected = form.selectedProducts.some((sp) => sp.productId === p.id);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => toggleProduct(p.id, p.name)}
                        className={`px-3 py-2 rounded-xl text-sm font-medium border-2 transition-all ${
                          isSelected
                            ? "bg-amber-600 text-white border-amber-600 shadow-md"
                            : "bg-white text-gray-700 border-gray-200 hover:border-amber-400 hover:bg-amber-50"
                        }`}
                      >
                        {isSelected && <Check className="h-3.5 w-3.5 inline ml-1" />}
                        {p.name}
                      </button>
                    );
                  })}
                </div>
                {form.selectedProducts.length > 0 && (
                  <div className="mt-2 space-y-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                    <p className="text-xs font-semibold text-amber-800">حدّد عدد القطع لكل نوع:</p>
                    {form.selectedProducts.map((p, idx) => (
                      <div key={idx} className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm text-gray-700 flex-1 truncate">
                            {p.productName}
                            {p.status === "ambiguous" && <Badge variant="outline" className="mr-1 border-amber-400 text-amber-700 text-[10px]">يحتاج تحديد</Badge>}
                            {p.status === "unmatched" && <Badge variant="outline" className="mr-1 border-red-400 text-red-700 text-[10px]">غير معروف</Badge>}
                          </span>
                          <div className="flex items-center gap-1">
                            <button type="button" onClick={() => setItemQuantityAt(idx, p.quantity - 1)} className="h-7 w-7 rounded-md border border-amber-300 bg-white text-amber-700 font-bold leading-none hover:bg-amber-100">−</button>
                            <Input
                              type="number"
                              min={1}
                              value={p.quantity}
                              onChange={(e) => setItemQuantityAt(idx, Number(e.target.value) || 1)}
                              className="h-7 w-16 text-center"
                            />
                            <button type="button" onClick={() => setItemQuantityAt(idx, p.quantity + 1)} className="h-7 w-7 rounded-md border border-amber-300 bg-white text-amber-700 font-bold leading-none hover:bg-amber-100">+</button>
                            <button type="button" onClick={() => removeItemAt(idx)} className="h-7 w-7 rounded-md border border-red-200 bg-white text-red-500 leading-none hover:bg-red-50" title="إزالة">×</button>
                          </div>
                        </div>

                        {/* Ambiguous: the parser found more than one plausible engraving — the
                            employee must choose; nothing is guessed on their behalf. */}
                        {p.status === "ambiguous" && p.candidates && p.candidates.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1 rounded-md bg-amber-100/70 p-2">
                            <span className="text-[11px] text-amber-800">هل تقصد:</span>
                            {p.candidates.map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => chooseCandidate(idx, c.id)}
                                className="rounded-md border border-amber-400 bg-white px-2 py-0.5 text-[11px] text-amber-900 hover:bg-amber-50"
                              >
                                {c.name}
                              </button>
                            ))}
                          </div>
                        )}

                        {/* Unmatched: keep the original phrase visible and let the employee
                            pick from the live catalog. Nothing is created automatically. */}
                        {p.status === "unmatched" && (
                          <div className="space-y-1 rounded-md bg-red-50 p-2">
                            {p.rawText && <p className="text-[11px] text-red-800">النص الأصلي: «{p.rawText}»</p>}
                            <Select onValueChange={(v) => assignItemVariant(idx, Number(v))}>
                              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="اختر النوع الصحيح يدويًا" /></SelectTrigger>
                              <SelectContent>
                                {(catalog?.variants ?? []).map((v: any) => (
                                  <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </div>
                    ))}
                    <div className="flex items-center justify-between border-t border-amber-200 pt-2">
                      <span className="text-sm font-semibold text-amber-800">إجمالي القطع</span>
                      <span className="text-sm font-bold text-amber-900">{totalPieces} قطعة</span>
                    </div>
                  </div>
                )}
              </div>

              {/* خانتي المقاس واللون - تظهر فقط عند اختيار كفر مرتبة ووتر بروف */}
              {isWaterproofSelected && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-3">
                  <p className="text-xs font-semibold text-blue-800 flex items-center gap-1">
                    <Package className="h-3.5 w-3.5" /> تفاصيل كفر مرتبة ووتر بروف
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    {/* المقاس */}
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium text-blue-900">المقاس *</Label>
                      <Select
                        value={form.size || ""}
                        onValueChange={(v) => setForm((f) => ({ ...f, size: v, color: undefined, variantId: undefined }))}
                      >
                        <SelectTrigger className="h-10 border-blue-300 bg-white">
                          <SelectValue placeholder="اختر المقاس" />
                        </SelectTrigger>
                        <SelectContent>
                          {waterproofSizes.map((s: any) => (
                            <SelectItem key={s} value={s}>{s}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {/* اللون */}
                    <div className="space-y-1.5">
                      <Label className="text-sm font-medium text-blue-900">اللون *</Label>
                      <Select
                        value={form.color || ""}
                        onValueChange={(v) => setForm((f) => ({ ...f, color: v }))}
                        disabled={!form.size}
                      >
                        <SelectTrigger className="h-10 border-blue-300 bg-white">
                          <SelectValue placeholder={form.size ? "اختر اللون" : "اختر المقاس أولا"} />
                        </SelectTrigger>
                        <SelectContent>
                          {waterproofColors.map((c: any) => (
                            <SelectItem key={c} value={c}>{c}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {form.size && form.color && (
                    <p className="text-xs text-blue-700">
                      ✅ المختار: {form.size} — {form.color}
                    </p>
                  )}
                </div>
              )}

              {/* Total + Shipping - تسعير يدوي */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">الإجمالي (ج.م) *</Label>
                  <Input
                    type="number"
                    min={0}
                    placeholder={calculatedTotal > 0 ? `مقترح: ${calculatedTotal}` : "اكتب الإجمالي"}
                    value={form.totalAmount || ""}
                    onChange={(e) => setForm((f) => ({ ...f, totalAmount: Number(e.target.value) || 0 }))}
                    className={`h-10 font-semibold ${fieldClass("orderTotal")}`}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">الشحن (ج.م)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.shippingCost}
                    onChange={(e) => setForm((f) => ({ ...f, shippingCost: Number(e.target.value) || 0 }))}
                    className={`h-10 ${fieldClass("shipping")}`}
                  />
                </div>
              </div>

              {/* ملخص الإجمالي */}
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-amber-800">الإجمالي المسجّل</span>
                  <span className="text-lg font-bold text-amber-900">{finalTotal.toLocaleString()} ج.م</span>
                </div>
                <p className="text-xs text-amber-600 mt-1">
                  {totalPieces} قطعة إجماليًا
                  {form.shippingCost > 0 && ` — منها شحن ${form.shippingCost} ج.م`}
                  {" — السعر يدوي حسب الاتفاق"}
                </p>
              </div>

              {/* Ad Name (Badge) */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium flex items-center gap-1">
                  <Megaphone className="h-3.5 w-3.5 text-blue-500" /> اسم البيدج (الإعلان)
                </Label>
                <Input
                  placeholder="اسم الإعلان على فيسبوك (اختياري)"
                  value={form.adName}
                  onChange={(e) => setForm((f) => ({ ...f, adName: e.target.value }))}
                  className="h-10"
                />
              </div>

              {/* Notes */}
              <div className="space-y-1.5">
                <Label className="text-sm font-medium flex items-center gap-1">
                  <StickyNote className="h-3.5 w-3.5 text-green-600" /> ملاحظات
                </Label>
                <textarea
                  className="w-full border border-gray-200 rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white h-20"
                  placeholder="أي ملاحظات على الأوردر (اختياري)"
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  dir="rtl"
                />
              </div>

              {/* Date (auto) */}
              <div className="flex items-center gap-2 text-sm text-muted-foreground bg-gray-50 rounded-lg px-3 py-2">
                <Calendar className="h-4 w-4" />
                <span>التاريخ: {new Date().toLocaleDateString("ar-EG", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</span>
              </div>

              <Button
                type="submit"
                className="w-full h-11 bg-[#3d1a00] hover:bg-[#5a2800] text-white font-semibold text-base"
                disabled={addOrderMutation.isPending}
              >
                {addOrderMutation.isPending ? (
                  <span className="flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" /> جاري الإضافة...</span>
                ) : (
                  <span className="flex items-center gap-2"><Plus className="h-5 w-5" /> إضافة الأوردر</span>
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* My Orders Section */}
        {showOrders && (
          <Card className="border-0 shadow-md">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2 text-[#3d1a00]">
                  <Package className="h-5 w-5 text-amber-600" />
                  أوردراتي ({myOrders.length})
                </CardTitle>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs gap-1"
                  onClick={() => refetchOrders()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  تحديث
                </Button>
              </div>
              {/* Date filter */}
              <div className="flex gap-2 mt-2">
                <div className="flex-1">
                  <Label className="text-xs text-muted-foreground">من</Label>
                  <Input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="flex-1">
                  <Label className="text-xs text-muted-foreground">إلى</Label>
                  <Input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {myOrders.length === 0 ? (
                <p className="text-center text-muted-foreground text-sm py-6">لا توجد أوردرات في هذا النطاق</p>
              ) : (
                myOrders.map((order: any) => (
                  <div key={order.id} className="border rounded-xl p-3 bg-white space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Badge variant="outline" className="text-xs font-mono">{order.orderNumber}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {new Date(order.createdAt).toLocaleDateString("ar-EG")}
                      </span>
                    </div>
                    <p className="font-semibold text-sm">{order.customerName}</p>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Phone className="h-3 w-3" />
                      <span dir="ltr">{order.customerPhone}</span>
                    </div>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="h-3 w-3" />
                      <span>{order.governorate} — {order.customerAddress}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-600">{order.productName} × {order.quantity}</span>
                      <span className="font-semibold text-amber-700">{Number(order.totalAmount)} ج.م</span>
                    </div>
                    {(order.size || order.color) && (
                      <div className="flex items-center gap-1 text-xs text-blue-700 bg-blue-50 rounded px-2 py-1">
                        <Package className="h-3 w-3" />
                        <span>{[order.size, order.color].filter(Boolean).join(' — ')}</span>
                      </div>
                    )}
                    {order.adName && (
                      <div className="flex items-center gap-1 text-xs text-blue-600 bg-blue-50 rounded px-2 py-1">
                        <Megaphone className="h-3 w-3" />
                        <span>{order.adName}</span>
                      </div>
                    )}
                    {order.notes && (
                      <div className="flex items-center gap-1 text-xs text-green-700 bg-green-50 rounded px-2 py-1">
                        <StickyNote className="h-3 w-3" />
                        <span>{order.notes}</span>
                      </div>
                    )}
                    {/* Action buttons */}
                    <div className="flex items-center gap-2 pt-1.5 border-t border-gray-100 mt-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 flex-1 text-blue-600 border-blue-200 hover:bg-blue-50"
                        onClick={() => openEditDialog(order)}
                      >
                        <Pencil className="h-3 w-3" />
                        تعديل
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1 flex-1 text-red-600 border-red-200 hover:bg-red-50"
                        onClick={() => setDeletingOrderId(order.id)}
                      >
                        <Trash2 className="h-3 w-3" />
                        حذف
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deletingOrderId !== null} onOpenChange={(open) => { if (!open) setDeletingOrderId(null); }}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <AlertTriangle className="h-5 w-5" />
              تأكيد الحذف
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            هل أنت متأكد من حذف هذا الأوردر؟ لا يمكن التراجع عن هذا الإجراء.
          </p>
          <DialogFooter className="flex gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => setDeletingOrderId(null)}
              className="flex-1"
            >
              إلغاء
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deletingOrderId) {
                  deleteOrderMutation.mutate({ orderId: deletingOrderId });
                }
              }}
              disabled={deleteOrderMutation.isPending}
              className="flex-1 gap-1"
            >
              {deleteOrderMutation.isPending ? (
                <><RefreshCw className="h-4 w-4 animate-spin" /> جاري الحذف...</>
              ) : (
                <><Trash2 className="h-4 w-4" /> حذف الأوردر</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Order Dialog */}
      <Dialog open={editingOrder !== null} onOpenChange={(open) => { if (!open) setEditingOrder(null); }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-[#3d1a00]">
              <Pencil className="h-5 w-5 text-amber-600" />
              تعديل بيانات الأوردر
              {editingOrder && (
                <Badge variant="outline" className="text-xs font-mono mr-2">{editingOrder.orderNumber}</Badge>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Customer Name */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">اسم العميل *</Label>
              <Input
                placeholder="اسم العميل الكامل"
                value={editForm.customerName}
                onChange={(e) => setEditForm((f) => ({ ...f, customerName: e.target.value }))}
                className="h-10"
              />
            </div>

            {/* Phone */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium flex items-center gap-1">
                <Phone className="h-3.5 w-3.5" /> رقم التليفون *
              </Label>
              <Input
                placeholder="01xxxxxxxxx"
                value={editForm.customerPhone}
                onChange={(e) => setEditForm((f) => ({ ...f, customerPhone: e.target.value }))}
                className="h-10"
                dir="ltr"
              />
            </div>

            {/* Governorate */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium flex items-center gap-1">
                <MapPin className="h-3.5 w-3.5" /> المحافظة *
              </Label>
              <Select
                value={editForm.governorate}
                onValueChange={(v) => setEditForm((f) => ({ ...f, governorate: v }))}
              >
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="اختر المحافظة" />
                </SelectTrigger>
                <SelectContent>
                  {EGYPT_GOVERNORATES.map((g) => (
                    <SelectItem key={g} value={g}>{g}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Address */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">العنوان التفصيلي *</Label>
              <Input
                placeholder="الشارع، المنطقة، الحي..."
                value={editForm.customerAddress}
                onChange={(e) => setEditForm((f) => ({ ...f, customerAddress: e.target.value }))}
                className="h-10"
              />
            </div>

            {/* Product Multi-Select */}
            <div className="space-y-2">
              <Label className="text-sm font-medium flex items-center gap-1">
                <Package className="h-3.5 w-3.5" /> نوع المنتج / الحفر *
              </Label>
              <div className="flex flex-wrap gap-2">
                {products.map((p: any) => {
                  const isSelected = editForm.selectedProducts.some((sp) => sp.productId === p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => toggleEditProduct(p.id, p.name)}
                      className={`px-3 py-2 rounded-xl text-sm font-medium border-2 transition-all ${
                        isSelected
                          ? "bg-amber-600 text-white border-amber-600 shadow-md"
                          : "bg-white text-gray-700 border-gray-200 hover:border-amber-400 hover:bg-amber-50"
                      }`}
                    >
                      {isSelected && <Check className="h-3.5 w-3.5 inline ml-1" />}
                      {p.name}
                    </button>
                  );
                })}
              </div>
              {editForm.selectedProducts.length > 0 && (
                <div className="mt-2 space-y-2 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
                  <p className="text-xs font-semibold text-amber-800">حدّد عدد القطع لكل نوع:</p>
                  {editForm.selectedProducts.map((p, idx) => (
                    <div key={idx} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-gray-700 flex-1 truncate">{p.productName}</span>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => setEditItemQuantityAt(idx, p.quantity - 1)} className="h-7 w-7 rounded-md border border-amber-300 bg-white text-amber-700 font-bold leading-none hover:bg-amber-100">−</button>
                        <Input
                          type="number"
                          min={1}
                          value={p.quantity}
                          onChange={(e) => setEditItemQuantityAt(idx, Number(e.target.value) || 1)}
                          className="h-7 w-16 text-center"
                        />
                        <button type="button" onClick={() => setEditItemQuantityAt(idx, p.quantity + 1)} className="h-7 w-7 rounded-md border border-amber-300 bg-white text-amber-700 font-bold leading-none hover:bg-amber-100">+</button>
                        <button type="button" onClick={() => removeEditItemAt(idx)} className="h-7 w-7 rounded-md border border-red-200 bg-white text-red-500 leading-none hover:bg-red-50" title="إزالة">×</button>
                      </div>
                    </div>
                  ))}
                  <div className="flex items-center justify-between border-t border-amber-200 pt-2">
                    <span className="text-sm font-semibold text-amber-800">إجمالي القطع</span>
                    <span className="text-sm font-bold text-amber-900">{editTotalPieces} قطعة</span>
                  </div>
                </div>
              )}
            </div>

            {/* خانتي المقاس واللون - تظهر فقط عند اختيار كفر مرتبة ووتر بروف */}
            {isEditWaterproofSelected && (
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 space-y-3">
                <p className="text-xs font-semibold text-blue-800 flex items-center gap-1">
                  <Package className="h-3.5 w-3.5" /> تفاصيل كفر مرتبة ووتر بروف
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-sm font-medium text-blue-900">المقاس *</Label>
                    <Select
                      value={editForm.size || ""}
                      onValueChange={(v) => setEditForm((f) => ({ ...f, size: v, color: undefined, variantId: undefined }))}
                    >
                      <SelectTrigger className="h-10 border-blue-300 bg-white">
                        <SelectValue placeholder="اختر المقاس" />
                      </SelectTrigger>
                      <SelectContent>
                        {waterproofSizes.map((s: any) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm font-medium text-blue-900">اللون *</Label>
                    <Select
                      value={editForm.color || ""}
                      onValueChange={(v) => setEditForm((f) => ({ ...f, color: v }))}
                      disabled={!editForm.size}
                    >
                      <SelectTrigger className="h-10 border-blue-300 bg-white">
                        <SelectValue placeholder={editForm.size ? "اختر اللون" : "اختر المقاس أولا"} />
                      </SelectTrigger>
                      <SelectContent>
                        {editWaterproofColors.map((c: any) => (
                          <SelectItem key={c} value={c}>{c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                {editForm.size && editForm.color && (
                  <p className="text-xs text-blue-700">
                    ✅ المختار: {editForm.size} — {editForm.color}
                  </p>
                )}
              </div>
            )}

            {/* Total + Shipping - تسعير يدوي */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">الإجمالي (ج.م) *</Label>
                <Input
                  type="number"
                  min={0}
                  placeholder={editCalculatedTotal > 0 ? `مقترح: ${editCalculatedTotal}` : "اكتب الإجمالي"}
                  value={editForm.totalAmount || ""}
                  onChange={(e) => setEditForm((f) => ({ ...f, totalAmount: Number(e.target.value) || 0 }))}
                  className="h-10 font-semibold"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">الشحن (ج.م)</Label>
                <Input
                  type="number"
                  min={0}
                  value={editForm.shippingCost}
                  onChange={(e) => setEditForm((f) => ({ ...f, shippingCost: Number(e.target.value) || 0 }))}
                  className="h-10"
                />
              </div>
            </div>

            {/* ملخص الإجمالي */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-amber-800">الإجمالي المسجّل</span>
                <span className="text-lg font-bold text-amber-900">{editFinalTotal.toLocaleString()} ج.م</span>
              </div>
              <p className="text-xs text-amber-600 mt-1">
                {editTotalPieces} قطعة إجماليًا
                {editForm.shippingCost > 0 && ` — منها شحن ${editForm.shippingCost} ج.م`}
                {" — السعر يدوي حسب الاتفاق"}
              </p>
            </div>

            {/* Ad Name */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium flex items-center gap-1">
                <Megaphone className="h-3.5 w-3.5 text-blue-500" /> اسم البيدج (الإعلان)
              </Label>
              <Input
                placeholder="اسم الإعلان على فيسبوك (اختياري)"
                value={editForm.adName}
                onChange={(e) => setEditForm((f) => ({ ...f, adName: e.target.value }))}
                className="h-10"
              />
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium flex items-center gap-1">
                <StickyNote className="h-3.5 w-3.5 text-green-600" /> ملاحظات
              </Label>
              <textarea
                className="w-full border border-gray-200 rounded-lg p-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-amber-400 bg-white h-20"
                placeholder="أي ملاحظات على الأوردر (اختياري)"
                value={editForm.notes}
                onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                dir="rtl"
              />
            </div>
          </div>

          <DialogFooter className="flex gap-2 sm:gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => setEditingOrder(null)}
              className="flex-1"
            >
              إلغاء
            </Button>
            <Button
              onClick={handleEditSubmit}
              disabled={updateOrderMutation.isPending}
              className="flex-1 bg-[#3d1a00] hover:bg-[#5a2800] text-white gap-1"
            >
              {updateOrderMutation.isPending ? (
                <><RefreshCw className="h-4 w-4 animate-spin" /> جاري الحفظ...</>
              ) : (
                <><Check className="h-4 w-4" /> حفظ التعديلات</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
