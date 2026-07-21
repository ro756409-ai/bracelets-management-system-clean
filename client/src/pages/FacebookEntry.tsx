import { useState, useMemo } from "react";
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

// Product name mapping for paste parsing
const PRODUCT_NAME_MAP: Record<string, string> = {
  "ايه الكرسي": "آية الكرسي",
  "اية الكرسي": "آية الكرسي",
  "آية الكرسي": "آية الكرسي",
  "ذكر التحصين": "ذكر التحصين",
  "تحصين": "ذكر التحصين",
  "عين حورس": "عين حورس",
  "حورس": "عين حورس",
  "فالله خير حافظا": "فالله خير حافظاً",
  "فالله خير حافظ": "فالله خير حافظاً",
  "الله خير حافظا": "فالله خير حافظاً",
  "قل اعوذ برب الفلق": "قل أعوذ برب الفلق",
  "سورة الفلق": "قل أعوذ برب الفلق",
  "الفلق": "قل أعوذ برب الفلق",
  "كهيعص": "كهيعص",
  "انه من سليمان": "إنه من سليمان",
  "إنه من سليمان": "إنه من سليمان",
  "سليمان": "إنه من سليمان",
  "سادة": "سادة",
  "ساده": "سادة",
  "منقوش": "منقوش",
  "منقوشه": "منقوش",
};

// ID منتج كفر مرتبة ووتر بروف
const WATERPROOF_PRODUCT_ID = 60001;

type FormState = {
  customerName: string;
  customerPhone: string;
  governorate: string;
  customerAddress: string;
  selectedProducts: { productId: number; productName: string; quantity: number }[];
  quantity: number;
  totalAmount: number;
  shippingCost: number;
  adName: string;
  notes: string;
  variantId?: number;
  size?: string;
  color?: string;
};

const EMPTY_FORM: FormState = {
  customerName: "",
  customerPhone: "",
  governorate: "",
  customerAddress: "",
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
  const toggleProduct = (productId: number, productName: string) => {
    setForm((f) => {
      const exists = f.selectedProducts.find((p) => p.productId === productId);
      const newProducts = exists
        ? f.selectedProducts.filter((p) => p.productId !== productId)
        : [...f.selectedProducts, { productId, productName, quantity: 1 }];
      return { ...f, selectedProducts: newProducts };
    });
  };

  // تغيير كمية بند معيّن في الفورم الرئيسي
  const setProductQuantity = (productId: number, quantity: number) => {
    setForm((f) => ({
      ...f,
      selectedProducts: f.selectedProducts.map((p) =>
        p.productId === productId ? { ...p, quantity: Math.max(1, quantity || 1) } : p
      ),
    }));
  };

  // Toggle product selection for edit form
  const toggleEditProduct = (productId: number, productName: string) => {
    setEditForm((f) => {
      const exists = f.selectedProducts.find((p) => p.productId === productId);
      const newProducts = exists
        ? f.selectedProducts.filter((p) => p.productId !== productId)
        : [...f.selectedProducts, { productId, productName, quantity: 1 }];
      return { ...f, selectedProducts: newProducts };
    });
  };

  // تغيير كمية بند في فورم التعديل
  const setEditProductQuantity = (productId: number, quantity: number) => {
    setEditForm((f) => ({
      ...f,
      selectedProducts: f.selectedProducts.map((p) =>
        p.productId === productId ? { ...p, quantity: Math.max(1, quantity || 1) } : p
      ),
    }));
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
      selectedProducts: matchedProducts.length > 0 ? matchedProducts : [],
      quantity: order.quantity || 1,
      totalAmount: Number(order.totalAmount) || 0,
      shippingCost: 0,
      adName: order.adName || "",
      notes: order.notes || "",
    });
    setEditingOrder(order);
  };

  // Parse pasted order text
  const parsePastedOrder = () => {
    if (!pasteText.trim()) {
      toast.error("الصق نص الأوردر أولاً");
      return;
    }

    const text = pasteText;
    const parsed: Partial<FormState> = {};

    // Extract بيدج (page name)
    const pageMatch = text.match(/بيدج\s*[:\s]*([^\n\r]+)/i) || text.match(/البيدج\s*[:\s]*([^\n\r]+)/i);
    if (pageMatch) {
      let pageName = pageMatch[1].trim();
      pageName = pageName.replace(/التاريخ.*$/i, "").trim();
      parsed.adName = pageName;
    }

    // Extract اسم (name)
    const nameMatch = text.match(/الاسم\s*[:\s]*([^\n\r]+)/i) || text.match(/اسم\s*[:\s]*([^\n\r]+)/i);
    if (nameMatch) {
      parsed.customerName = nameMatch[1].trim();
    }

    // Extract عنوان (address)
    const addressMatch = text.match(/العنوان\s*[:\s]*([^\n\r]+)/i) || text.match(/عنوان\s*[:\s]*([^\n\r]+)/i);
    if (addressMatch) {
      const fullAddress = addressMatch[1].trim();
      let foundGov = "";
      for (const gov of EGYPT_GOVERNORATES) {
        if (fullAddress.includes(gov)) {
          foundGov = gov;
          break;
        }
      }
      if (!foundGov) {
        if (fullAddress.includes("شرقية") || fullAddress.includes("الشرقيه")) foundGov = "الشرقية";
        else if (fullAddress.includes("قاهرة") || fullAddress.includes("القاهره")) foundGov = "القاهرة";
        else if (fullAddress.includes("جيزة") || fullAddress.includes("الجيزه")) foundGov = "الجيزة";
        else if (fullAddress.includes("اسكندرية") || fullAddress.includes("الاسكندريه")) foundGov = "الإسكندرية";
        else if (fullAddress.includes("دقهلية") || fullAddress.includes("الدقهليه")) foundGov = "الدقهلية";
        else if (fullAddress.includes("غربية") || fullAddress.includes("الغربيه")) foundGov = "الغربية";
        else if (fullAddress.includes("منوفية") || fullAddress.includes("المنوفيه")) foundGov = "المنوفية";
        else if (fullAddress.includes("بحيرة") || fullAddress.includes("البحيره")) foundGov = "البحيرة";
        else if (fullAddress.includes("قليوبية") || fullAddress.includes("القليوبيه")) foundGov = "القليوبية";
        else if (fullAddress.includes("فيوم") || fullAddress.includes("الفيوم")) foundGov = "الفيوم";
        else if (fullAddress.includes("منيا") || fullAddress.includes("المنيا")) foundGov = "المنيا";
        else if (fullAddress.includes("بني سويف")) foundGov = "بني سويف";
        else if (fullAddress.includes("اسيوط") || fullAddress.includes("أسيوط")) foundGov = "أسيوط";
        else if (fullAddress.includes("سوهاج")) foundGov = "سوهاج";
        else if (fullAddress.includes("اسوان") || fullAddress.includes("أسوان")) foundGov = "أسوان";
        else if (fullAddress.includes("اقصر") || fullAddress.includes("الأقصر")) foundGov = "الأقصر";
        else if (fullAddress.includes("قنا")) foundGov = "قنا";
        else if (fullAddress.includes("دمياط")) foundGov = "دمياط";
        else if (fullAddress.includes("بورسعيد")) foundGov = "بورسعيد";
        else if (fullAddress.includes("سويس") || fullAddress.includes("السويس")) foundGov = "السويس";
        else if (fullAddress.includes("اسماعيلية") || fullAddress.includes("الإسماعيلية")) foundGov = "الإسماعيلية";
        else if (fullAddress.includes("كفر الشيخ")) foundGov = "كفر الشيخ";
        else if (fullAddress.includes("مطروح")) foundGov = "مطروح";
      }
      if (foundGov) parsed.governorate = foundGov;
      parsed.customerAddress = fullAddress.replace(/^محافظة\s*/i, "").trim();
    }

    // Extract phone
    const phoneMatch = text.match(/رقم الفون\s*\(?[١1]\)?\s*[:\s]*([0-9٠-٩]+)/i) || text.match(/الفون\s*[:\s]*([0-9٠-٩]+)/i) || text.match(/التليفون\s*[:\s]*([0-9٠-٩]+)/i);
    if (phoneMatch) {
      let phone = phoneMatch[1].replace(/[٠-٩]/g, (d: string) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
      parsed.customerPhone = phone;
    }

    // Extract product type
    const productMatch = text.match(/نوع المنتج\s*[:\s]*([^\n\r]+)/i) || text.match(/المنتج\s*[:\s]*([^\n\r]+)/i);
    if (productMatch) {
      let rawProduct = productMatch[1].trim();
      rawProduct = rawProduct.replace(/عدد القطع.*$/i, "").trim();
      const matchedProducts: { productId: number; productName: string; quantity: number }[] = [];
      const rawLower = rawProduct.toLowerCase();
      for (const [key, canonical] of Object.entries(PRODUCT_NAME_MAP)) {
        if (rawLower.includes(key.toLowerCase()) || rawLower.includes(canonical.toLowerCase())) {
          const product = products.find((p: any) => p.name.includes(canonical));
          if (product && !matchedProducts.find(mp => mp.productId === product.id)) {
            matchedProducts.push({ productId: product.id, productName: product.name, quantity: 1 });
          }
        }
      }
      if (matchedProducts.length > 0) {
        parsed.selectedProducts = matchedProducts;
      }
    }

    // Extract quantity
    const qtyMatch = text.match(/عدد القطع\s*[:\s]*([0-9٠-٩]+)/i) || text.match(/الكمية\s*[:\s]*([0-9٠-٩]+)/i);
    if (qtyMatch) {
      let qty = qtyMatch[1].replace(/[٠-٩]/g, (d: string) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
      parsed.quantity = parseInt(qty) || 1;
    }

    // Extract shipping cost
    const shippingMatch = text.match(/الشحن\s*[:\s]*([0-9٠-٩]+)/i);
    if (shippingMatch) {
      let shipping = shippingMatch[1].replace(/[٠-٩]/g, (d: string) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
      parsed.shippingCost = parseInt(shipping) || 0;
    }

    // Extract total if available
    const totalMatch = text.match(/الاجمالي\s*[:\s]*([0-9٠-٩]+)/i) || text.match(/الإجمالي\s*[:\s]*([0-9٠-٩]+)/i);
    if (totalMatch) {
      let total = totalMatch[1].replace(/[٠-٩]/g, (d: string) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
      parsed.totalAmount = parseInt(total) || 0;
    }

    // Apply parsed data
    setForm((f) => ({
      ...f,
      customerName: parsed.customerName || f.customerName,
      customerPhone: parsed.customerPhone || f.customerPhone,
      governorate: parsed.governorate || f.governorate,
      customerAddress: parsed.customerAddress || f.customerAddress,
      selectedProducts: parsed.selectedProducts || f.selectedProducts,
      quantity: parsed.quantity || f.quantity,
      shippingCost: parsed.shippingCost ?? f.shippingCost,
      totalAmount: parsed.totalAmount || 0,
      adName: parsed.adName || f.adName,
    }));

    setShowPaste(false);
    setPasteText("");
    toast.success("✅ تم تحليل الأوردر بنجاح — راجع البيانات وأكمل الناقص");
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
      selectedProducts: form.selectedProducts,
      quantity: totalPieces || form.quantity,
      totalAmount: finalTotal,
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
      selectedProducts: editForm.selectedProducts,
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
                  className="flex-1 bg-amber-600 hover:bg-amber-700 text-white gap-1"
                  onClick={parsePastedOrder}
                >
                  <Check className="h-4 w-4" />
                  تحليل وتعبئة
                </Button>
                <Button
                  variant="outline"
                  className="gap-1"
                  onClick={() => { setShowPaste(false); setPasteText(""); }}
                >
                  <X className="h-4 w-4" />
                  إلغاء
                </Button>
              </div>
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
                  className="h-10"
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
                  className="h-10"
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
                  value={form.customerAddress}
                  onChange={(e) => setForm((f) => ({ ...f, customerAddress: e.target.value }))}
                  className="h-10"
                  required
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
                    {form.selectedProducts.map((p) => (
                      <div key={p.productId} className="flex items-center justify-between gap-2">
                        <span className="text-sm text-gray-700 flex-1 truncate">{p.productName}</span>
                        <div className="flex items-center gap-1">
                          <button type="button" onClick={() => setProductQuantity(p.productId, p.quantity - 1)} className="h-7 w-7 rounded-md border border-amber-300 bg-white text-amber-700 font-bold leading-none hover:bg-amber-100">−</button>
                          <Input
                            type="number"
                            min={1}
                            value={p.quantity}
                            onChange={(e) => setProductQuantity(p.productId, Number(e.target.value) || 1)}
                            className="h-7 w-16 text-center"
                          />
                          <button type="button" onClick={() => setProductQuantity(p.productId, p.quantity + 1)} className="h-7 w-7 rounded-md border border-amber-300 bg-white text-amber-700 font-bold leading-none hover:bg-amber-100">+</button>
                          <button type="button" onClick={() => toggleProduct(p.productId, p.productName)} className="h-7 w-7 rounded-md border border-red-200 bg-white text-red-500 leading-none hover:bg-red-50" title="إزالة">×</button>
                        </div>
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
                    className="h-10 font-semibold"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm font-medium">الشحن (ج.م)</Label>
                  <Input
                    type="number"
                    min={0}
                    value={form.shippingCost}
                    onChange={(e) => setForm((f) => ({ ...f, shippingCost: Number(e.target.value) || 0 }))}
                    className="h-10"
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
                  {editForm.selectedProducts.map((p) => (
                    <div key={p.productId} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-gray-700 flex-1 truncate">{p.productName}</span>
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => setEditProductQuantity(p.productId, p.quantity - 1)} className="h-7 w-7 rounded-md border border-amber-300 bg-white text-amber-700 font-bold leading-none hover:bg-amber-100">−</button>
                        <Input
                          type="number"
                          min={1}
                          value={p.quantity}
                          onChange={(e) => setEditProductQuantity(p.productId, Number(e.target.value) || 1)}
                          className="h-7 w-16 text-center"
                        />
                        <button type="button" onClick={() => setEditProductQuantity(p.productId, p.quantity + 1)} className="h-7 w-7 rounded-md border border-amber-300 bg-white text-amber-700 font-bold leading-none hover:bg-amber-100">+</button>
                        <button type="button" onClick={() => toggleEditProduct(p.productId, p.productName)} className="h-7 w-7 rounded-md border border-red-200 bg-white text-red-500 leading-none hover:bg-red-50" title="إزالة">×</button>
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
