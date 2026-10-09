import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Package,
  PackageCheck,
  Plus,
  AlertTriangle,
  History,
  ArrowDownCircle,
  ArrowUpCircle,
  ClipboardList,
  Pencil,
  Save,
  Tag,
  ChevronDown,
  ChevronUp,
  Archive,
  ArchiveRestore,
  Search,
  ArrowUpDown,
  EyeOff,
  Eye,
  MoreVertical,
} from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermission";
import {
  PageHeader, ScopeBar, StatCard, SectionCard, ResponsiveDataTable, StatusBadge, OfflineState, UNAVAILABLE_LABEL, type Column,
} from "@/components/shared";
import { SectionIcon } from "@/components/brand";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { StatusFilterChips, DataToolbar } from "@/components/workspace";
import {
  getStockStatus,
  computeVariantTotals,
  type StockStatus,
} from "@shared/inventoryCalculations";
import { InventoryAccountingSection } from "./InventoryAccounting";
import { useOperationalOptions } from "@/hooks/useOperationalOptions";
import { useBrandOptions } from "@/hooks/useBrandOptions";
import {
  VariantMatrixBuilder,
  emptyVariantMatrix,
  enabledVariants,
  type VariantMatrixValue,
} from "@/components/inventory/VariantMatrixBuilder";

/** هدف لمس ≥44px على الهاتف للمكوّنات المشتركة داخل هذه الصفحة فقط (شرائح الفلتر/البحث)؛ 36px على md+. */
const TOUCH_SCOPE = "[&_button]:min-h-[max(2.75rem,44px)] [&_input]:min-h-[max(2.75rem,44px)] md:[&_button]:min-h-9 md:[&_input]:min-h-9";

function variantLabel(v: any): string {
  return v.name || [v.color, v.size].filter(Boolean).join(" - ") || "بدون اسم";
}

export default function Inventory() {
  const utils = trpc.useUtils();
  const { currentBusinessIds, currentBusinessId, setCurrentBusinessId, businesses } = useBusinessContext();
  const online = useOnlineStatus();
  // المصدر الواحد لاختيار النشاط (يعالج: واحد→تلقائي، صفر→isEmpty، أكتر→اختيار).
  const brandOptions = useBrandOptions();
  const { user } = useAuth();
  const { permissions } = usePermissions();
  const isAdmin = user?.role === "admin";
  // تبويبات Workspace المخزون (المخزون/الاستلام/الجرد/مرتجعات الورشة) يرسمها DashboardLayout مرة واحدة
  // من نفس NavConfig للوجهة النشطة — الصفحة لا ترسم نسخة ثانية (كانت تظهر مكررة على الهاتف).
  const inventoryInReasons = useOperationalOptions(
    "inventory_in_reason"
  ).options;
  const inventoryOutReasons = useOperationalOptions(
    "inventory_out_reason"
  ).options;

  // ---- Page controls: search / filter / sort / archived toggle ----
  const [search, setSearch] = useState("");
  const [stockStatusFilter, setStockStatusFilter] = useState<
    "all" | "available" | "low" | "out"
  >("all");
  const [showArchived, setShowArchived] = useState(false);
  const [sortBy, setSortBy] = useState<"name" | "stock" | "price" | "updated">(
    "name"
  );
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  // Dialog state — product-level movement
  const [showMovementDialog, setShowMovementDialog] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(
    null
  );
  const [movementType, setMovementType] = useState<"in" | "out">("in");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [movementNotes, setMovementNotes] = useState("");

  // History / daily log
  const [showHistory, setShowHistory] = useState(false);
  const [historyProductId, setHistoryProductId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<
    "products" | "daily" | "accounting"
  >("products");

  // Which product cards are expanded to show their variants
  const [expandedProducts, setExpandedProducts] = useState<
    Record<number, boolean>
  >({});

  // Product create/edit dialog
  const [showProductFormDialog, setShowProductFormDialog] = useState(false);
  const [productFormMode, setProductFormMode] = useState<"create" | "edit">(
    "create"
  );
  const [productFormId, setProductFormId] = useState<number | null>(null);
  const [pfName, setPfName] = useState("");
  const [pfDescription, setPfDescription] = useState("");
  const [pfSku, setPfSku] = useState("");
  const [pfPrice, setPfPrice] = useState("");
  const [pfStock, setPfStock] = useState("0");
  const [pfMinStock, setPfMinStock] = useState("15");
  // وضع المنتج: بسيط (SKU/سعر واحد) أو متعدد الخيارات (ألوان×مقاسات = تركيبات).
  const [pfIsVariant, setPfIsVariant] = useState(false);
  const [pfMatrix, setPfMatrix] = useState<VariantMatrixValue>(
    emptyVariantMatrix()
  );

  // Product archive confirm
  const [archiveProductTarget, setArchiveProductTarget] = useState<any | null>(
    null
  );

  // Edit stock state (standalone products only — direct stock edit was never asked to be
  // removed for standalone products, only for variants; kept as-is)
  const [editingProductId, setEditingProductId] = useState<number | null>(null);
  const [editStockValue, setEditStockValue] = useState("");

  // Variant movement (incoming/outgoing)
  const [showVariantMovementDialog, setShowVariantMovementDialog] =
    useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(
    null
  );
  const [variantMovementType, setVariantMovementType] = useState<"in" | "out">(
    "in"
  );
  const [variantQuantity, setVariantQuantity] = useState("1");
  const [variantReason, setVariantReason] = useState("");
  const [variantCustomReason, setVariantCustomReason] = useState("");
  const [variantMovementNotes, setVariantMovementNotes] = useState("");

  // Variant create/edit dialog
  const [showVariantFormDialog, setShowVariantFormDialog] = useState(false);
  const [variantFormMode, setVariantFormMode] = useState<"create" | "edit">(
    "create"
  );
  const [variantFormProductId, setVariantFormProductId] = useState<
    number | null
  >(null);
  const [variantFormId, setVariantFormId] = useState<number | null>(null);
  const [vfName, setVfName] = useState("");
  const [vfSku, setVfSku] = useState("");
  const [vfPrice, setVfPrice] = useState("");
  const [vfCostPrice, setVfCostPrice] = useState("");
  const [vfStock, setVfStock] = useState("0"); // create-only ("initial stock")
  const [vfMinStock, setVfMinStock] = useState("5");
  const [vfIsActive, setVfIsActive] = useState(true);

  // إضافة ألوان/مقاسات دفعة لمنتج قائم
  const [showAddMatrixDialog, setShowAddMatrixDialog] = useState(false);
  const [addMatrixProductId, setAddMatrixProductId] = useState<number | null>(
    null
  );
  const [addMatrix, setAddMatrix] = useState<VariantMatrixValue>(
    emptyVariantMatrix()
  );

  // Variant archive confirm
  const [deleteVariantTarget, setDeleteVariantTarget] = useState<any | null>(
    null
  );

  // Product price edit dialog
  const [showPriceDialog, setShowPriceDialog] = useState(false);
  const [priceProductId, setPriceProductId] = useState<number | null>(null);
  const [priceValue, setPriceValue] = useState("");

  const { data: rawProducts, isLoading, error: productsError } = trpc.products.list.useQuery({
    ...(currentBusinessIds ? { businessIds: currentBusinessIds } : {}),
    includeInactive: true,
  });
  const { data: lowStock } = trpc.products.lowStock.useQuery(
    currentBusinessIds ? { businessIds: currentBusinessIds } : undefined
  );
  const { data: movements } = trpc.products.movements.useQuery({
    productId: historyProductId ?? undefined,
    limit: 100,
    businessIds: currentBusinessIds,
  });

  // Variants query (all, including archived — filtered client-side by showArchived)
  const { data: rawVariants, isLoading: variantsLoading, error: variantsError } =
    trpc.variants.all.useQuery({
      ...(currentBusinessIds ? { businessIds: currentBusinessIds } : {}),
      includeInactive: true,
    });

  // آخر جرد (قراءة فقط، المرحلة 7C): endpoint موجود بصلاحية inventory_costing.view — يُطلب فقط لنشاط واحد محدد.
  const scopedBusinessId = currentBusinessIds?.length === 1 ? currentBusinessIds[0] : undefined;
  const canViewStocktake = isAdmin || permissions.includes("inventory_costing.view");
  const stocktakes = trpc.accountingV2.stocktakeList.useQuery(
    { businessId: scopedBusinessId ?? 0, limit: 50 },
    { enabled: scopedBusinessId != null && canViewStocktake }
  );

  const addMovementMutation = trpc.products.addMovement.useMutation({
    onSuccess: () => {
      const label = movementType === "in" ? "وارد" : "صادر";
      toast.success(`تم تسجيل ${label} المخزون بنجاح`);
      utils.products.list.invalidate();
      utils.products.lowStock.invalidate();
      utils.products.movements.invalidate();
      setShowMovementDialog(false);
      setQuantity("1");
      setReason("");
      setCustomReason("");
      setMovementNotes("");
    },
    onError: e => toast.error(e.message),
  });

  const updateStockMutation = trpc.products.update.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث عدد القطع بنجاح");
      utils.products.list.invalidate();
      utils.products.lowStock.invalidate();
      setEditingProductId(null);
      setEditStockValue("");
    },
    onError: e => toast.error(e.message),
  });

  const variantMovementMutation = trpc.variants.addMovement.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث المخزون بنجاح");
      utils.variants.all.invalidate();
      setShowVariantMovementDialog(false);
      setVariantQuantity("1");
      setVariantReason("");
      setVariantCustomReason("");
      setVariantMovementNotes("");
    },
    onError: e => toast.error(e.message),
  });

  const createVariantMutation = trpc.variants.create.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة الصنف بنجاح");
      utils.variants.all.invalidate();
      closeVariantForm();
    },
    onError: e => toast.error(e.message),
  });

  const editVariantMutation = trpc.variants.update.useMutation({
    onSuccess: () => {
      toast.success("تم تعديل الصنف بنجاح");
      utils.variants.all.invalidate();
      closeVariantForm();
    },
    onError: e => toast.error(e.message),
  });

  const addVariantsToProductMutation =
    trpc.variants.addToProduct.useMutation({
      onSuccess: res => {
        const created = res.createdIds?.length ?? 0;
        const skipped = res.skipped?.length ?? 0;
        toast.success(
          `تمت إضافة ${created} تركيبة${skipped ? ` (تم تخطي ${skipped} موجودة مسبقًا)` : ""}`
        );
        utils.variants.all.invalidate();
        closeAddMatrix();
      },
      onError: e => toast.error(e.message),
    });

  const deleteVariantMutation = trpc.variants.delete.useMutation({
    onSuccess: () => {
      toast.success(
        deleteVariantTarget?.isActive === false
          ? "تم إعادة تفعيل الصنف"
          : "تم أرشفة الصنف"
      );
      utils.variants.all.invalidate();
      setDeleteVariantTarget(null);
    },
    onError: e => toast.error(e.message),
  });

  const reactivateVariantMutation = trpc.variants.update.useMutation({
    onSuccess: () => {
      toast.success("تم إعادة تفعيل الصنف");
      utils.variants.all.invalidate();
      setDeleteVariantTarget(null);
    },
    onError: e => toast.error(e.message),
  });

  const updateProductPriceMutation = trpc.products.update.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث سعر المنتج بنجاح");
      utils.products.list.invalidate();
      setShowPriceDialog(false);
      setPriceProductId(null);
      setPriceValue("");
    },
    onError: e => toast.error(e.message),
  });

  const createProductMutation = trpc.products.create.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة المنتج بنجاح");
      utils.products.list.invalidate();
      closeProductForm();
    },
    onError: e => toast.error(e.message),
  });

  const createWithVariantsMutation = trpc.products.createWithVariants.useMutation(
    {
      onSuccess: () => {
        toast.success("تم إضافة المنتج وكل تركيباته بنجاح");
        utils.products.list.invalidate();
        closeProductForm();
      },
      onError: e => toast.error(e.message),
    }
  );

  const editProductMutation = trpc.products.update.useMutation({
    onSuccess: () => {
      toast.success("تم تعديل المنتج بنجاح");
      utils.products.list.invalidate();
      closeProductForm();
    },
    onError: e => toast.error(e.message),
  });

  const archiveProductMutation = trpc.products.update.useMutation({
    onSuccess: () => {
      toast.success(
        archiveProductTarget?.isActive
          ? "تم أرشفة المنتج"
          : "تم إعادة تفعيل المنتج"
      );
      utils.products.list.invalidate();
      setArchiveProductTarget(null);
    },
    onError: e => toast.error(e.message),
  });

  // ---- Variant form helpers ----
  function openCreateVariant(productId: number) {
    setVariantFormMode("create");
    setVariantFormProductId(productId);
    setVariantFormId(null);
    setVfName("");
    setVfSku("");
    setVfPrice("");
    setVfCostPrice("");
    setVfStock("0");
    setVfMinStock("5");
    setVfIsActive(true);
    setShowVariantFormDialog(true);
  }

  function openEditVariant(variant: any) {
    setVariantFormMode("edit");
    setVariantFormProductId(variant.productId);
    setVariantFormId(variant.id);
    setVfName(variant.name ?? "");
    setVfSku(variant.sku ?? "");
    setVfPrice(variant.price != null ? String(variant.price) : "");
    setVfCostPrice(variant.costPrice != null ? String(variant.costPrice) : "");
    setVfMinStock(String(variant.minStockLevel ?? 5));
    setVfIsActive(variant.isActive !== false);
    setShowVariantFormDialog(true);
  }

  function closeVariantForm() {
    setShowVariantFormDialog(false);
    setVariantFormId(null);
    setVariantFormProductId(null);
  }

  // ---- إضافة ألوان/مقاسات دفعة لمنتج قائم (الجديد فقط) ----
  function openAddMatrix(productId: number) {
    setAddMatrixProductId(productId);
    setAddMatrix(emptyVariantMatrix());
    setShowAddMatrixDialog(true);
  }
  function closeAddMatrix() {
    setShowAddMatrixDialog(false);
    setAddMatrixProductId(null);
    setAddMatrix(emptyVariantMatrix());
  }
  function submitAddMatrix() {
    if (addMatrixProductId == null) return;
    const rows = enabledVariants(addMatrix);
    if (rows.length === 0) {
      toast.error("أضف تركيبة مفعّلة واحدة على الأقل (لون/مقاس)");
      return;
    }
    const variants = [];
    for (const r of rows) {
      // الرمز اختياري — السيرفر بيولّد رمزًا داخليًا فريدًا (AUTO-…) للفاضي.
      const priceN = r.price.trim() === "" ? undefined : Number(r.price);
      const costN = r.costPrice.trim() === "" ? undefined : Number(r.costPrice);
      const stockN = Number(r.currentStock || "0");
      const minN = Number(r.minStockLevel || "0");
      if (
        (priceN !== undefined && (isNaN(priceN) || priceN < 0)) ||
        (costN !== undefined && (isNaN(costN) || costN < 0)) ||
        isNaN(stockN) ||
        stockN < 0 ||
        isNaN(minN) ||
        minN < 0
      ) {
        toast.error(`أرقام غير صحيحة في تركيبة ${r.color || ""} ${r.size || ""}`);
        return;
      }
      variants.push({
        color: r.color.trim() || undefined,
        size: r.size.trim() || undefined,
        sku: r.sku.trim() || undefined,
        price: priceN,
        costPrice: costN,
        currentStock: stockN,
        minStockLevel: minN,
      });
    }
    addVariantsToProductMutation.mutate({
      productId: addMatrixProductId,
      variants,
    });
  }

  function submitVariantForm() {
    if (!vfName.trim()) {
      toast.error("اسم النوع مطلوب");
      return;
    }
    // الرمز اختياري — السيرفر بيولّده لو اتساب فاضي.
    const minNum = Number(vfMinStock);
    if (isNaN(minNum) || minNum < 0) {
      toast.error("الحد الأدنى لازم يكون رقم صحيح غير سالب");
      return;
    }
    const priceNum = vfPrice.trim() === "" ? undefined : Number(vfPrice);
    if (priceNum !== undefined && (isNaN(priceNum) || priceNum < 0)) {
      toast.error("سعر البيع لازم يكون رقم صحيح غير سالب");
      return;
    }
    const costPriceNum =
      vfCostPrice.trim() === "" ? undefined : Number(vfCostPrice);
    if (
      costPriceNum !== undefined &&
      (isNaN(costPriceNum) || costPriceNum < 0)
    ) {
      toast.error("سعر التكلفة لازم يكون رقم صحيح غير سالب");
      return;
    }
    if (variantFormMode === "create") {
      if (!variantFormProductId) return;
      const stockNum = Number(vfStock);
      if (isNaN(stockNum) || stockNum < 0) {
        toast.error("المخزون الابتدائي لازم يكون رقم صحيح غير سالب");
        return;
      }
      createVariantMutation.mutate({
        productId: variantFormProductId,
        name: vfName.trim(),
        sku: vfSku.trim() || undefined,
        price: priceNum,
        costPrice: costPriceNum,
        currentStock: stockNum,
        minStockLevel: minNum,
        isActive: vfIsActive,
      });
    } else {
      if (!variantFormId) return;
      // Stock is intentionally NOT sent — edit dialog never overwrites currentStock directly.
      editVariantMutation.mutate({
        id: variantFormId,
        name: vfName.trim(),
        sku: vfSku.trim() || undefined,
        price: priceNum,
        costPrice: costPriceNum,
        minStockLevel: minNum,
        isActive: vfIsActive,
      });
    }
  }

  // ---- Product form helpers ----
  function openCreateProduct() {
    setProductFormMode("create");
    setProductFormId(null);
    setPfName("");
    setPfDescription("");
    setPfSku("");
    setPfPrice("");
    setPfStock("0");
    setPfMinStock("15");
    setShowProductFormDialog(true);
  }

  function openEditProduct(product: any) {
    setProductFormMode("edit");
    setProductFormId(product.id);
    setPfName(product.name ?? "");
    setPfDescription(product.description ?? "");
    setPfSku(product.sku ?? "");
    setPfPrice(product.price != null ? String(product.price) : "");
    setPfStock(String(product.currentStock ?? 0));
    setPfMinStock(String(product.minStockLevel ?? 15));
    setShowProductFormDialog(true);
  }

  function closeProductForm() {
    setShowProductFormDialog(false);
    setProductFormId(null);
    setPfIsVariant(false);
    setPfMatrix(emptyVariantMatrix());
  }

  function submitProductForm() {
    if (!pfName.trim()) {
      toast.error("اسم المنتج مطلوب");
      return;
    }
    // وضع متعدد الخيارات (إنشاء فقط): المنتج + كل تركيباته في transaction واحدة.
    if (productFormMode === "create" && pfIsVariant) {
      // النشاط المستهدَف: نفس منطق الوضع البسيط (المبدّل لو نشاط واحد، وإلا المصدر الواحد).
      const targetBusinessId =
        (currentBusinessIds?.length === 1 ? currentBusinessIds[0] : undefined) ??
        brandOptions.selectedId;
      if (targetBusinessId == null) {
        toast.error(
          brandOptions.isEmpty
            ? "لا يوجد نشاط متاح لإنشاء منتج"
            : "اختر النشاط من مبدّل الأنشطة بالأعلى قبل إنشاء منتج"
        );
        return;
      }
      const rows = enabledVariants(pfMatrix);
      if (rows.length === 0) {
        toast.error("أضف تركيبة مفعّلة واحدة على الأقل (لون/مقاس)");
        return;
      }
      const variants = [];
      for (const r of rows) {
        // الرمز اختياري — السيرفر بيولّد رمزًا داخليًا فريدًا (AUTO-…) للفاضي.
        const priceN = r.price.trim() === "" ? undefined : Number(r.price);
        const costN = r.costPrice.trim() === "" ? undefined : Number(r.costPrice);
        const stockN = Number(r.currentStock || "0");
        const minN = Number(r.minStockLevel || "0");
        if (
          (priceN !== undefined && (isNaN(priceN) || priceN < 0)) ||
          (costN !== undefined && (isNaN(costN) || costN < 0)) ||
          isNaN(stockN) ||
          stockN < 0 ||
          isNaN(minN) ||
          minN < 0
        ) {
          toast.error(`أرقام غير صحيحة في تركيبة ${r.color || ""} ${r.size || ""}`);
          return;
        }
        variants.push({
          color: r.color.trim() || undefined,
          size: r.size.trim() || undefined,
          sku: r.sku.trim() || undefined,
          price: priceN,
          costPrice: costN,
          currentStock: stockN,
          minStockLevel: minN,
        });
      }
      createWithVariantsMutation.mutate({
        name: pfName.trim(),
        description: pfDescription.trim() || undefined,
        businessId: targetBusinessId,
        minStockLevel: Number(pfMinStock) || 15,
        variants,
      });
      return;
    }
    const stockNum = Number(pfStock);
    const minNum = Number(pfMinStock);
    if (isNaN(stockNum) || stockNum < 0 || isNaN(minNum) || minNum < 0) {
      toast.error("المخزون والحد الأدنى لازم أرقام صحيحة");
      return;
    }
    const priceNum = pfPrice.trim() === "" ? undefined : Number(pfPrice);
    if (priceNum !== undefined && (isNaN(priceNum) || priceNum < 0)) {
      toast.error("السعر لازم رقم صحيح");
      return;
    }
    if (productFormMode === "create") {
      // النشاط المستهدَف: النشاط المختار في المبدّل (لو واحد)، وإلا المصدر الواحد
      // (useBrandOptions) اللي بيختار النشاط الوحيد تلقائيًا — فمالك بنشاط واحد مايتطلبش
      // اختيارًا مخفيًا. صفر أنشطة → isEmpty؛ أكتر من واحد بلا اختيار → اطلب اختيارًا.
      const targetBusinessId =
        (currentBusinessIds?.length === 1 ? currentBusinessIds[0] : undefined) ??
        brandOptions.selectedId;
      if (targetBusinessId == null) {
        toast.error(
          brandOptions.isEmpty
            ? "لا يوجد نشاط متاح لإنشاء منتج"
            : "اختر النشاط من مبدّل الأنشطة بالأعلى قبل إنشاء منتج"
        );
        return;
      }
      createProductMutation.mutate({
        name: pfName.trim(),
        description: pfDescription.trim() || undefined,
        sku: pfSku.trim() || undefined,
        price: priceNum !== undefined ? String(priceNum) : undefined,
        currentStock: stockNum,
        minStockLevel: minNum,
        businessId: targetBusinessId,
      });
    } else {
      if (!productFormId) return;
      editProductMutation.mutate({
        id: productFormId,
        name: pfName.trim(),
        description: pfDescription.trim() || undefined,
        sku: pfSku.trim() || undefined,
        price: priceNum !== undefined ? String(priceNum) : undefined,
        currentStock: stockNum,
        minStockLevel: minNum,
      });
    }
  }

  // ---- Product price helpers ----
  function openEditPrice(product: { id: number; price: any }) {
    setPriceProductId(product.id);
    setPriceValue(String(product.price ?? ""));
    setShowPriceDialog(true);
  }

  function submitPrice() {
    if (priceProductId === null) return;
    const p = Number(priceValue);
    if (isNaN(p) || p < 0) {
      toast.error("يرجى إدخال سعر صحيح");
      return;
    }
    updateProductPriceMutation.mutate({ id: priceProductId, price: String(p) });
  }

  const startEditStock = (product: { id: number; currentStock: number }) => {
    setEditingProductId(product.id);
    setEditStockValue(String(product.currentStock));
  };

  const saveEditStock = () => {
    if (editingProductId === null || editStockValue === "") return;
    const newStock = Number(editStockValue);
    if (isNaN(newStock) || newStock < 0) {
      toast.error("يرجى إدخال رقم صحيح");
      return;
    }
    updateStockMutation.mutate({
      id: editingProductId,
      currentStock: newStock,
    });
  };

  const cancelEditStock = () => {
    setEditingProductId(null);
    setEditStockValue("");
  };

  const handleMovement = (productId: number, type: "in" | "out") => {
    setSelectedProductId(productId);
    setMovementType(type);
    setQuantity("1");
    setReason("");
    setCustomReason("");
    setMovementNotes("");
    setShowMovementDialog(true);
  };

  const handleVariantMovement = (variantId: number, type: "in" | "out") => {
    setSelectedVariantId(variantId);
    setVariantMovementType(type);
    setVariantQuantity("1");
    setVariantReason("");
    setVariantCustomReason("");
    setVariantMovementNotes("");
    setShowVariantMovementDialog(true);
  };

  const handleSubmitMovement = () => {
    if (!selectedProductId || !quantity) return;
    const finalReason = reason === "__custom__" ? customReason : reason;
    addMovementMutation.mutate({
      productId: selectedProductId,
      type: movementType,
      quantity: Number(quantity),
      reason: finalReason || undefined,
      notes: movementNotes.trim() || undefined,
    });
  };

  const handleSubmitVariantMovement = () => {
    if (!selectedVariantId || !variantQuantity) return;
    const finalReason =
      variantReason === "__custom__" ? variantCustomReason : variantReason;
    variantMovementMutation.mutate({
      variantId: selectedVariantId,
      type: variantMovementType,
      quantity: Number(variantQuantity),
      reason: finalReason || undefined,
      notes: variantMovementNotes.trim() || undefined,
    });
  };

  const selectedProduct = rawProducts?.find(p => p.id === selectedProductId);
  const selectedVariant = rawVariants?.find(
    (v: any) => v.id === selectedVariantId
  );

  // Group ALL variants (active + archived) by product — archived-visibility is applied later per-view.
  const variantsByProduct = useMemo(() => {
    if (!rawVariants)
      return {} as Record<number, { productName: string; variants: any[] }>;
    const grouped: Record<number, { productName: string; variants: any[] }> =
      {};
    for (const v of rawVariants as any[]) {
      const key = v.productId;
      if (!grouped[key])
        grouped[key] = {
          productName: v.productName || `منتج #${v.productId}`,
          variants: [],
        };
      grouped[key].variants.push(v);
    }
    return grouped;
  }, [rawVariants]);

  // ---- Search / filter / sort pipeline ----
  const searchLower = search.trim().toLowerCase();
  function matchesSearch(name?: string | null, sku?: string | null): boolean {
    if (!searchLower) return true;
    return (
      (name ?? "").toLowerCase().includes(searchLower) ||
      (sku ?? "").toLowerCase().includes(searchLower)
    );
  }

  const rows = useMemo(() => {
    if (!rawProducts) return [];
    const list = rawProducts
      .map(product => {
        const group = variantsByProduct[product.id];
        const allVariantsForProduct = group?.variants ?? [];
        const hasVariants = allVariantsForProduct.length > 0;
        const visibleVariants = allVariantsForProduct
          .filter(v => showArchived || v.isActive)
          .filter(
            v =>
              matchesSearch(v.name, v.sku) ||
              !searchLower ||
              matchesSearch(product.name, product.sku)
          );
        const {
          totalStock: variantTotalStock,
          totalValue,
          attentionCount,
        } = computeVariantTotals(allVariantsForProduct);
        const totalStock = hasVariants
          ? variantTotalStock
          : product.currentStock;

        const productMatches = matchesSearch(product.name, product.sku);
        const variantMatches = allVariantsForProduct.some(
          v => (showArchived || v.isActive) && matchesSearch(v.name, v.sku)
        );
        const searchOk = !searchLower || productMatches || variantMatches;

        const productStatus = getStockStatus(
          product.isActive,
          product.currentStock,
          product.minStockLevel
        );
        const statusOk =
          stockStatusFilter === "all"
            ? true
            : hasVariants
              ? visibleVariants.some(
                  v =>
                    getStockStatus(
                      v.isActive,
                      v.currentStock,
                      v.minStockLevel
                    ) === stockStatusFilter
                )
              : productStatus === stockStatusFilter;

        const archivedOk = showArchived || product.isActive;

        const minPrice = hasVariants
          ? visibleVariants.reduce(
              (min, v) =>
                v.price != null && (min === null || Number(v.price) < min)
                  ? Number(v.price)
                  : min,
              null as number | null
            )
          : product.price != null
            ? Number(product.price)
            : null;

        return {
          product,
          group,
          hasVariants,
          visibleVariants,
          totalStock,
          totalValue,
          attentionCount,
          include: archivedOk && searchOk && statusOk,
          forceExpand: !!searchLower && !productMatches && variantMatches,
          sortKeys: {
            name: product.name,
            stock: totalStock,
            price: minPrice ?? -1,
            updated: new Date(product.updatedAt as any).getTime(),
          },
        };
      })
      .filter(r => r.include);

    list.sort((a, b) => {
      let cmp = 0;
      if (sortBy === "name")
        cmp = a.sortKeys.name.localeCompare(b.sortKeys.name, "ar");
      else
        cmp = (a.sortKeys[sortBy] as number) - (b.sortKeys[sortBy] as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [
    rawProducts,
    variantsByProduct,
    showArchived,
    searchLower,
    stockStatusFilter,
    sortBy,
    sortDir,
  ]);

  const totalStockAll = rows.reduce((s, r) => s + r.totalStock, 0);
  // Products judged on their own stock column: the server now excludes any product whose
  // stock actually lives on its variants, so these two counts never overlap.
  const lowStockCount = lowStock?.length ?? 0;
  const lowVariantCount =
    (rawVariants as any[] | undefined)?.filter(
      (v: any) =>
        v.isActive &&
        getStockStatus(true, v.currentStock, v.minStockLevel) !== "available"
    ).length ?? 0;
  const needsRestockCount = lowStockCount + lowVariantCount;

  // Daily log: group movements by date
  const dailyLog = useMemo(() => {
    if (!movements) return [];
    const byDate: Record<
      string,
      { date: string; inQty: number; outQty: number; items: any[] }
    > = {};
    for (const m of movements) {
      const d = new Date(m.createdAt).toLocaleDateString("ar-EG", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      if (!byDate[d]) byDate[d] = { date: d, inQty: 0, outQty: 0, items: [] };
      if (m.type === "in") byDate[d].inQty += m.quantity;
      else byDate[d].outQty += m.quantity;
      byDate[d].items.push(m);
    }
    return Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));
  }, [movements]);

  // Today's movements
  const todayStr = new Date().toLocaleDateString("ar-EG", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const todayLog = dailyLog.find(d => d.date === todayStr);
  const todayIn = todayLog?.inQty ?? 0;
  const todayOut = todayLog?.outQty ?? 0;

  const hasActiveFilters =
    !!search || stockStatusFilter !== "all" || showArchived;

  // ===== المرحلة 7C: صف مسطّح لكل منتج (بلا تركيبات) أو لكل تركيبة — نفس الفلترة/الترتيب أعلاه، عرض فقط =====
  type InvRow = {
    key: string; kind: "product" | "variant"; product: any; variant: any | null;
    name: string; variantLabel: string | null; sku: string | null; qty: number; min: number;
    status: StockStatus; updatedAt: string | null; businessName: string | null;
  };
  const businessNameOf = (id: number | null | undefined) =>
    id == null ? null : (businesses.find(b => b.id === id)?.name ?? null);
  const inventoryRows: InvRow[] = useMemo(() => {
    const out: InvRow[] = [];
    for (const r of rows) {
      const { product, hasVariants, visibleVariants } = r;
      const bizName = businessNameOf(product.businessId);
      if (hasVariants) {
        // رصيد المنتج نفسه (السادة/بدون تركيبة) حقيقي أيضًا — الاستلام «سادة» يزيده — فيُعرض صفًا مستقلًا لو كان له رصيد
        if ((product.currentStock ?? 0) > 0) {
          const st0 = getStockStatus(product.isActive, product.currentStock, product.minStockLevel);
          if (stockStatusFilter === "all" || st0 === stockStatusFilter) {
            out.push({
              key: `p-${product.id}`, kind: "product", product, variant: null, name: product.name,
              variantLabel: "بدون تركيبة (رصيد المنتج)", sku: product.sku ?? null, qty: product.currentStock ?? 0, min: product.minStockLevel ?? 0,
              status: st0, updatedAt: product.updatedAt ? String(product.updatedAt) : null, businessName: bizName,
            });
          }
        }
        for (const v of visibleVariants) {
          const st = getStockStatus(v.isActive, v.currentStock, v.minStockLevel);
          if (stockStatusFilter !== "all" && st !== stockStatusFilter) continue;
          out.push({
            key: `v-${v.id}`, kind: "variant", product, variant: v, name: product.name,
            variantLabel: variantLabel(v), sku: v.sku ?? null, qty: v.currentStock ?? 0, min: v.minStockLevel ?? 0,
            status: st, updatedAt: null, businessName: bizName,
          });
        }
      } else {
        out.push({
          key: `p-${product.id}`, kind: "product", product, variant: null, name: product.name,
          variantLabel: null, sku: product.sku ?? null, qty: product.currentStock ?? 0, min: product.minStockLevel ?? 0,
          status: getStockStatus(product.isActive, product.currentStock, product.minStockLevel),
          updatedAt: product.updatedAt ? String(product.updatedAt) : null, businessName: bizName,
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, stockStatusFilter, businesses]);

  // ===== ملخص حقيقي (مصدر كل رقم مكتوب في hint) =====
  const activeProducts = (rawProducts ?? []).filter((p: any) => p.isActive);
  const activeVariants = ((rawVariants ?? []) as any[]).filter(v => v.isActive);
  const productsWithoutVariants = activeProducts.filter((p: any) => !(variantsByProduct[p.id]?.variants?.length));
  const countBy = (st: StockStatus) =>
    productsWithoutVariants.filter((p: any) => getStockStatus(true, p.currentStock, p.minStockLevel) === st).length +
    activeVariants.filter(v => getStockStatus(true, v.currentStock, v.minStockLevel) === st).length;
  const summaryLow = countBy("low");
  const summaryOut = countBy("out");
  const lastStocktake = useMemo(() => {
    const list = (stocktakes.data ?? []) as any[];
    if (list.length === 0) return null;
    return list.reduce((a, b) => (new Date(b.createdAt).getTime() > new Date(a.createdAt).getTime() ? b : a));
  }, [stocktakes.data]);
  const STOCKTAKE_STATUS: Record<string, string> = { draft: "مسودة", pending_approval: "بانتظار الاعتماد", approved: "معتمد", cancelled: "ملغي" };
  const fmtN = (n: number) => n.toLocaleString("ar-EG");
  const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleDateString("ar-EG", { day: "numeric", month: "short", year: "numeric" }) : UNAVAILABLE_LABEL);

  const refreshAll = () => {
    utils.products.list.invalidate(); utils.products.lowStock.invalidate(); utils.variants.all.invalidate(); utils.products.movements.invalidate();
  };

  // أزرار الحركة: وارد/صادر = نفس الحوارات/الـmutations الحالية — لا كتابة مباشرة للرصيد من الجدول
  const movementButtons = (row: InvRow, size: "table" | "card") => {
    const cls = size === "card" ? "min-h-11 flex-1" : "min-h-9 h-9 px-2";
    const active = row.kind === "variant" ? row.variant.isActive !== false : row.product.isActive;
    const onIn = () => (row.kind === "variant" ? handleVariantMovement(row.variant.id, "in") : handleMovement(row.product.id, "in"));
    const onOut = () => (row.kind === "variant" ? handleVariantMovement(row.variant.id, "out") : handleMovement(row.product.id, "out"));
    return (
      <>
        <Button type="button" size="sm" variant="outline" className={`${cls} gap-1 border-[var(--success)]/40 text-[var(--success)]`} onClick={onIn} disabled={!active} data-testid={`inv-in-${row.key}`}>
          <ArrowDownCircle className="h-4 w-4" aria-hidden="true" /> وارد
        </Button>
        <Button type="button" size="sm" variant="outline" className={`${cls} gap-1 border-destructive/40 text-destructive`} onClick={onOut} disabled={!active || row.qty === 0} data-testid={`inv-out-${row.key}`}>
          <ArrowUpCircle className="h-4 w-4" aria-hidden="true" /> صادر
        </Button>
      </>
    );
  };
  const moreMenu = (row: InvRow, size: "table" | "card") => {
    const p = row.product;
    const items: Array<{ key: string; label: string; onSelect: () => void; destructive?: boolean }> =
      row.kind === "product"
        ? [
            { key: "edit", label: "تعديل المنتج", onSelect: () => openEditProduct(p) },
            { key: "price", label: "تعديل السعر", onSelect: () => openEditPrice(p) },
            { key: "stock", label: "تعديل عدد القطع", onSelect: () => startEditStock(p) },
            { key: "history", label: "سجل الحركات", onSelect: () => { setHistoryProductId(p.id); setShowHistory(true); } },
            { key: "variant", label: "إضافة نوع", onSelect: () => openCreateVariant(p.id) },
            { key: "matrix", label: "إضافة ألوان/مقاسات", onSelect: () => openAddMatrix(p.id) },
            { key: "archive", label: p.isActive ? "أرشفة المنتج" : "إعادة تفعيل المنتج", onSelect: () => setArchiveProductTarget(p), destructive: !!p.isActive },
          ]
        : [
            { key: "edit", label: "تعديل الصنف", onSelect: () => openEditVariant(row.variant) },
            { key: "history", label: "سجل حركات المنتج", onSelect: () => { setHistoryProductId(p.id); setShowHistory(true); } },
            { key: "archive", label: row.variant.isActive ? "أرشفة الصنف" : "إعادة تفعيل الصنف", onSelect: () => setDeleteVariantTarget(row.variant), destructive: !!row.variant.isActive },
          ];
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="sm" variant="ghost" className={size === "card" ? "min-h-11 min-w-11" : "h-9 min-h-9 w-9 p-0"} aria-label="المزيد من الإجراءات" data-testid={`inv-more-${row.key}`}>
            <MoreVertical className="h-4 w-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          {items.map(it => (
            <DropdownMenuItem key={it.key} className={`min-h-11 md:min-h-9 ${it.destructive ? "text-destructive focus:text-destructive" : ""}`} onClick={it.onSelect} data-testid={`inv-more-${row.key}-${it.key}`}>
              {it.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };
  const qtyCell = (row: InvRow) =>
    row.kind === "product" && editingProductId === row.product.id ? (
      <span className="inline-flex items-center gap-1" data-testid="inv-stock-editor">
        <Input type="number" inputMode="numeric" min="0" value={editStockValue} onChange={e => setEditStockValue(e.target.value)} className="h-9 w-20 text-center text-sm font-bold" autoFocus aria-label="عدد القطع"
          onKeyDown={e => { if (e.key === "Enter") saveEditStock(); if (e.key === "Escape") cancelEditStock(); }} />
        <Button type="button" size="sm" variant="ghost" className="min-h-11 min-w-11 p-0 text-[var(--success)] md:h-9 md:w-9 md:min-h-9 md:min-w-9" onClick={saveEditStock} disabled={updateStockMutation.isPending} aria-label="حفظ عدد القطع"><Save className="h-4 w-4" /></Button>
      </span>
    ) : (
      <span className={`font-bold tabular-nums ${row.status === "low" || row.status === "out" ? "text-destructive" : ""}`}>{fmtN(row.qty)}</span>
    );
  const inventoryColumns: Column<InvRow>[] = [
    { id: "product", header: "المنتج", cell: r => <div className="min-w-0"><p className="truncate font-medium">{r.name}</p>{r.kind === "product" && r.sku && <p className="font-mono text-xs text-muted-foreground" dir="ltr">{r.sku}</p>}</div>, sortable: false, alwaysVisible: true },
    { id: "variant", header: "التركيبة", cell: r => r.variantLabel ? <span className="text-[var(--info)]">{r.variantLabel}</span> : <span className="text-muted-foreground">—</span> },
    { id: "sku", header: "SKU / الكود", cell: r => r.sku ? <span className="font-mono text-xs" dir="ltr">{r.sku}</span> : <span className="text-xs text-muted-foreground">{UNAVAILABLE_LABEL}</span> },
    { id: "qty", header: "الكمية", numeric: true, cell: qtyCell },
    { id: "min", header: "حد التنبيه", numeric: true, cell: r => <span className="tabular-nums text-muted-foreground">{fmtN(r.min)}</span> },
    { id: "status", header: "الحالة", cell: r => <StatusBadge kind="stock" status={r.status} size="sm" /> },
    { id: "updated", header: "آخر تحديث", cell: r => <span className="text-xs tabular-nums text-muted-foreground">{fmtDate(r.updatedAt)}</span> },
    { id: "business", header: "النشاط", cell: r => <span className="text-xs">{r.businessName ?? UNAVAILABLE_LABEL}</span> },
    { id: "actions", header: "إجراءات", sticky: "end", alwaysVisible: true, cell: r => <div className="flex items-center justify-end gap-1">{movementButtons(r, "table")}{moreMenu(r, "table")}</div> },
  ];
  const mobileRow = (r: InvRow) => (
    <article className={`space-y-2 rounded-[var(--radius-brand-md)] border bg-card p-3 ${r.status === "out" ? "border-destructive/40" : r.status === "low" ? "border-[var(--warning)]/40" : "border-border"} ${r.status === "archived" ? "opacity-70" : ""}`} data-testid={`inv-card-${r.key}`} data-status={r.status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold">{r.name}</p>
          {r.variantLabel && <p className="text-sm text-[var(--info)]">{r.variantLabel}</p>}
          <p className="font-mono text-xs text-muted-foreground" dir="ltr">{r.sku ?? UNAVAILABLE_LABEL}</p>
        </div>
        <StatusBadge kind="stock" status={r.status} size="sm" />
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div><dt className="text-muted-foreground">الكمية</dt><dd className="text-base">{qtyCell(r)}</dd></div>
        <div><dt className="text-muted-foreground">حد التنبيه</dt><dd className="tabular-nums">{fmtN(r.min)}</dd></div>
        <div><dt className="text-muted-foreground">النشاط</dt><dd className="truncate">{r.businessName ?? UNAVAILABLE_LABEL}</dd></div>
        <div className="col-span-3"><dt className="text-muted-foreground">آخر تحديث</dt><dd className="tabular-nums">{fmtDate(r.updatedAt)}</dd></div>
      </dl>
      <div className="flex items-center gap-2">{movementButtons(r, "card")}{moreMenu(r, "card")}</div>
    </article>
  );

  return (
    <div className="space-y-5">
      {/* المرحلة 7C: رأس + نطاق النشاط + ملخص حقيقي + فلاتر + جدول Desktop/بطاقات Mobile. التبويبات الداخلية
          (أصناف/حركات/تكلفة) كما هي (تبويبات الـWorkspace من الـShell)؛ كل الحوارات والـmutations بلا تغيير. */}
      <PageHeader
        title="المخزون"
        description="الأرصدة الحالية لكل منتج وتركيبة في نطاق الجلسة — الرصيد يتغيّر من حركات الوارد/الصادر والاستلام والجرد فقط."
        icon={<SectionIcon section="inventory" fallback={Package} size="md" />}
        primaryAction={
          activeTab === "products" ? (
            <Button className="min-h-11 md:min-h-9" onClick={openCreateProduct} data-testid="inv-create-product">
              <Plus className="h-4 w-4 ml-1" aria-hidden="true" />
              إضافة منتج
            </Button>
          ) : undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="أقسام المخزون">
            <Button variant={activeTab === "products" ? "default" : "outline"} size="sm" className="min-h-11 md:min-h-9" role="tab" aria-selected={activeTab === "products"} onClick={() => setActiveTab("products")}>
              <Package className="h-4 w-4 ml-1" aria-hidden="true" /> الأصناف
            </Button>
            <Button variant={activeTab === "daily" ? "default" : "outline"} size="sm" className="min-h-11 md:min-h-9" role="tab" aria-selected={activeTab === "daily"} onClick={() => { setActiveTab("daily"); setHistoryProductId(null); }}>
              <ClipboardList className="h-4 w-4 ml-1" aria-hidden="true" /> الحركات
            </Button>
            <Button variant={activeTab === "accounting" ? "default" : "outline"} size="sm" className="min-h-11 md:min-h-9" role="tab" aria-selected={activeTab === "accounting"} onClick={() => setActiveTab("accounting")}>
              <PackageCheck className="h-4 w-4 ml-1" aria-hidden="true" /> التكلفة والاستلام
            </Button>
          </div>
        }
      >
        {businesses.length > 1 && (
          <ScopeBar options={businesses.map(b => ({ id: b.id, label: b.name }))} value={currentBusinessId ?? null} onChange={id => setCurrentBusinessId(id == null ? undefined : Number(id))} />
        )}
      </PageHeader>

      {!online && <OfflineState onRetry={refreshAll} />}

      {/* ملخص حقيقي — مصدر كل رقم مكتوب تحته؛ لا قيمة مخزون ولا تكلفة محسوبة هنا */}
      {activeTab !== "accounting" && (
        <section aria-label="ملخص المخزون" className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5" data-testid="inventory-summary">
          <StatCard label="المنتجات" value={isLoading ? "…" : fmtN(activeProducts.length)} icon={<Package className="h-5 w-5" aria-hidden="true" />} tone="primary" hint="منتج نشط في النطاق" loading={isLoading} />
          <StatCard label="التركيبات" value={variantsLoading ? "…" : fmtN(activeVariants.length)} icon={<Tag className="h-5 w-5" aria-hidden="true" />} hint="تركيبة نشطة" loading={variantsLoading} />
          <StatCard label="منخفض المخزون" value={fmtN(summaryLow)} icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />} tone={summaryLow > 0 ? "warning" : "default"} hint="الكمية ≤ حد التنبيه" onClick={() => { setActiveTab("products"); setStockStatusFilter("low"); }} active={stockStatusFilter === "low"} loading={isLoading || variantsLoading} />
          <StatCard label="نافد" value={fmtN(summaryOut)} icon={<AlertTriangle className="h-5 w-5" aria-hidden="true" />} tone={summaryOut > 0 ? "danger" : "default"} hint="الكمية = صفر" onClick={() => { setActiveTab("products"); setStockStatusFilter("out"); }} active={stockStatusFilter === "out"} loading={isLoading || variantsLoading} />
          <StatCard
            label="آخر جرد"
            value={lastStocktake ? fmtDate(lastStocktake.createdAt) : UNAVAILABLE_LABEL}
            icon={<ClipboardList className="h-5 w-5" aria-hidden="true" />}
            hint={
              scopedBusinessId == null ? "اختر نشاطًا واحدًا لعرض آخر جرد"
              : !canViewStocktake ? "يتطلب صلاحية عرض تكلفة المخزون"
              : lastStocktake ? `${STOCKTAKE_STATUS[lastStocktake.status] ?? lastStocktake.status} · ${lastStocktake.createdByName ?? ""}`
              : stocktakes.isLoading ? "جارٍ التحميل" : "لا جلسات جرد بعد"
            }
            loading={stocktakes.isLoading}
          />
        </section>
      )}

      {/* Low Stock Alert — من products.lowStock كما كان */}
      {lowStock && lowStock.length > 0 && activeTab === "products" && (
        <div className="rounded-[var(--radius-brand-md)] border border-destructive/20 bg-destructive/10 p-4" role="status" data-testid="inventory-low-alert">
          <div className="mb-2 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" aria-hidden="true" />
            <p className="text-sm font-semibold text-destructive">تنبيه: الأصناف التالية تحتاج إعادة تخزين</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {lowStock.map(p => (
              <Badge key={p.id} variant="destructive" className="text-xs">
                {p.name}: {p.currentStock} قطعة
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* ===== TAB: PRODUCTS — جدول/بطاقات ===== */}
      {activeTab === "products" && (
        <>
          {/* فلترة حالة المخزون — المصدر الوحيد (single source) عبر StatusFilterChips.
              الغلاف يمنح شرائح الفلتر وحقل البحث (مكوّنات مشتركة) هدف لمس ≥44px على الهاتف داخل هذه الصفحة فقط. */}
          <div className={TOUCH_SCOPE} data-testid="inventory-filters">
          <StatusFilterChips
            chips={[
              { key: "available", label: "متوفر", tone: "success" },
              { key: "low", label: "منخفض", tone: "warning" },
              { key: "out", label: "نفد المخزون", tone: "danger" },
            ]}
            value={stockStatusFilter === "all" ? null : stockStatusFilter}
            onChange={(key) =>
              setStockStatusFilter((key ?? "all") as typeof stockStatusFilter)
            }
          />

          {/* شريط أدوات موحّد (superset لـFilterBar): بحث + ترتيب/مؤرشفة في «فلاتر متقدمة» + شرائح + مسح. */}
          <DataToolbar
            search={search}
            onSearch={(v) => setSearch(v)}
            searchPlaceholder="بحث بالمنتج، النوع، أو SKU..."
            chips={[
              ...(search ? [{ key: "search", label: "بحث", value: search }] : []),
              ...(showArchived ? [{ key: "archived", label: "المؤرشفة", value: "ظاهرة" }] : []),
            ]}
            onClearChip={(k) => {
              if (k === "search") setSearch("");
              if (k === "archived") setShowArchived(false);
            }}
            onReset={
              hasActiveFilters
                ? () => { setSearch(""); setStockStatusFilter("all"); setShowArchived(false); }
                : undefined
            }
            advancedActiveCount={showArchived ? 1 : 0}
            advancedFilters={
              <>
                <div>
                  <label className="mb-1.5 block text-sm font-medium text-foreground" htmlFor="inv-sort">الترتيب</label>
                  <div className="flex gap-2">
                    <Select value={sortBy} onValueChange={v => setSortBy(v as typeof sortBy)}>
                      <SelectTrigger id="inv-sort" className="min-h-11 w-full md:min-h-9"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="name">ترتيب بالاسم</SelectItem>
                        <SelectItem value="stock">ترتيب بالمخزون</SelectItem>
                        <SelectItem value="price">ترتيب بالسعر</SelectItem>
                        <SelectItem value="updated">ترتيب بآخر تحديث</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button" size="sm" variant="outline" className="min-h-11 w-11 shrink-0 p-0 md:min-h-9 md:w-9"
                      onClick={() => setSortDir(d => (d === "asc" ? "desc" : "asc"))}
                      aria-label={sortDir === "asc" ? "تصاعدي" : "تنازلي"} title={sortDir === "asc" ? "تصاعدي" : "تنازلي"}
                    >
                      <ArrowUpDown className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
                <div>
                  <span className="mb-1.5 block text-sm font-medium text-foreground">المؤرشفة</span>
                  <Button
                    type="button" size="sm" variant={showArchived ? "default" : "outline"} className="min-h-11 w-full md:min-h-9"
                    onClick={() => setShowArchived(s => !s)} aria-pressed={showArchived}
                  >
                    {showArchived ? <Eye className="h-3.5 w-3.5 ml-1" aria-hidden="true" /> : <EyeOff className="h-3.5 w-3.5 ml-1" aria-hidden="true" />}
                    {showArchived ? "إخفاء المؤرشف" : "إظهار المؤرشف"}
                  </Button>
                </div>
              </>
            }
          />
          </div>

          <SectionCard flush testId="inventory-table" title={`الأصناف (${fmtN(inventoryRows.length)})`} description="صف لكل منتج أو تركيبة — الكمية والحد والحالة من المخزون نفسه.">
            <ResponsiveDataTable<InvRow>
              rows={inventoryRows}
              columns={inventoryColumns}
              rowKey={r => r.key}
              loading={isLoading || variantsLoading}
              error={productsError ? (productsError.message || "تعذّر تحميل المخزون") : variantsError ? (variantsError.message || "تعذّر تحميل التركيبات") : null}
              onRetry={refreshAll}
              empty={
                !rawProducts || rawProducts.length === 0
                  ? { title: "لا توجد منتجات بعد", description: "أضف أول منتج لتبدأ متابعة المخزون.", action: <Button size="sm" className="min-h-11 md:min-h-9" onClick={openCreateProduct}><Plus className="h-3.5 w-3.5 ml-1" aria-hidden="true" /> إضافة أول منتج</Button> }
                  : { title: "لا توجد نتائج مطابقة", description: "عدّل البحث أو الفلاتر الحالية.", action: hasActiveFilters ? <Button size="sm" variant="outline" className="min-h-11 md:min-h-9" onClick={() => { setSearch(""); setStockStatusFilter("all"); setShowArchived(false); }}>مسح الفلاتر</Button> : undefined }
              }
              cardsBelow="md"
              mobileRow={mobileRow}
            />
          </SectionCard>
        </>
      )}

      {/* ===== TAB: DAILY LOG ===== */}
      {activeTab === "daily" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-foreground">الجرد اليومي</h2>
            <Select
              value={historyProductId?.toString() ?? "all"}
              onValueChange={v =>
                setHistoryProductId(v === "all" ? null : Number(v))
              }
            >
              <SelectTrigger className="w-52">
                <SelectValue placeholder="كل الأصناف" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الأصناف</SelectItem>
                {rawProducts?.map(p => (
                  <SelectItem key={p.id} value={p.id.toString()}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {dailyLog.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <ClipboardList className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground">لا توجد حركات مخزون بعد</p>
                <p className="text-xs text-muted-foreground mt-1">
                  ابدأ بإضافة وارد أو صادر من تبويب الأصناف
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {dailyLog.map(day => (
                <Card key={day.date}>
                  <CardHeader className="pb-2 pt-4 px-4">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-bold text-foreground">
                        {day.date}
                      </CardTitle>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-semibold text-[var(--success)] bg-[var(--success)]/10 px-2 py-1 rounded-full">
                          وارد: +{day.inQty}
                        </span>
                        <span className="text-xs font-semibold text-destructive bg-destructive/10 px-2 py-1 rounded-full">
                          صادر: -{day.outQty}
                        </span>
                        <span className="text-xs font-semibold text-[var(--info)] bg-[var(--info)]/10 px-2 py-1 rounded-full">
                          صافي: {day.inQty - day.outQty >= 0 ? "+" : ""}
                          {day.inQty - day.outQty}
                        </span>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="space-y-2">
                      {day.items.map((m: any) => {
                        const productName =
                          rawProducts?.find(p => p.id === m.productId)?.name ??
                          `صنف #${m.productId}`;
                        return (
                          <div
                            key={m.id}
                            className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/40"
                          >
                            <div
                              className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${m.type === "in" ? "bg-[var(--success)]/15 text-[var(--success)]" : "bg-destructive/15 text-destructive"}`}
                            >
                              {m.type === "in" ? (
                                <ArrowDownCircle className="h-3.5 w-3.5" />
                              ) : (
                                <ArrowUpCircle className="h-3.5 w-3.5" />
                              )}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-semibold text-foreground">
                                  {productName}
                                </span>
                                <span
                                  className={`text-xs font-bold ${m.type === "in" ? "text-[var(--success)]" : "text-destructive"}`}
                                >
                                  {m.type === "in" ? "+" : "-"}
                                  {m.quantity} قطعة
                                </span>
                                {m.reason && (
                                  <span className="text-xs text-muted-foreground truncate">
                                    — {m.reason}
                                  </span>
                                )}
                              </div>
                              {m.notes && (
                                <p className="text-xs text-muted-foreground mt-0.5">
                                  {m.notes}
                                </p>
                              )}
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {new Date(m.createdAt).toLocaleTimeString(
                                  "ar-EG",
                                  { hour: "2-digit", minute: "2-digit" }
                                )}
                              </p>
                            </div>
                            <Badge
                              className={`text-xs shrink-0 ${m.type === "in" ? "bg-[var(--success)]/15 text-[var(--success)] border-0" : "bg-destructive/15 text-destructive border-0"}`}
                            >
                              {m.type === "in" ? "وارد" : "صادر"}
                            </Badge>
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === "accounting" && <InventoryAccountingSection />}

      {/* ===== Movement Dialog (Products) ===== */}
      <Dialog open={showMovementDialog} onOpenChange={setShowMovementDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {movementType === "in" ? (
                <span className="flex items-center gap-2 text-[var(--success)]">
                  <ArrowDownCircle className="h-5 w-5" />
                  إضافة وارد للمخزن
                </span>
              ) : (
                <span className="flex items-center gap-2 text-destructive">
                  <ArrowUpCircle className="h-5 w-5" />
                  تسجيل صادر من المخزن
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div
              className={`rounded-lg p-3 ${movementType === "in" ? "bg-[var(--success)]/10 border border-[var(--success)]/30" : "bg-destructive/10 border border-destructive/30"}`}
            >
              <p className="text-sm font-bold text-foreground">
                {selectedProduct?.name}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                المخزون الحالي:{" "}
                <span className="font-semibold">
                  {selectedProduct?.currentStock}
                </span>{" "}
                قطعة
              </p>
            </div>

            <div>
              <Label>
                الكمية <span className="text-destructive">*</span>
              </Label>
              <Input
                type="number"
                min="1"
                max={
                  movementType === "out"
                    ? selectedProduct?.currentStock
                    : undefined
                }
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
                className="mt-1 text-lg font-bold"
                placeholder="أدخل الكمية"
              />
              {movementType === "out" &&
                selectedProduct &&
                Number(quantity) > selectedProduct.currentStock && (
                  <p className="text-xs text-destructive mt-1">
                    الكمية أكبر من المخزون المتاح
                  </p>
                )}
            </div>

            <div>
              <Label>السبب</Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="اختر السبب..." />
                </SelectTrigger>
                <SelectContent>
                  {(movementType === "in"
                    ? inventoryInReasons
                    : inventoryOutReasons
                  ).map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="__custom__">سبب آخر...</SelectItem>
                </SelectContent>
              </Select>
              {reason === "__custom__" && (
                <Textarea
                  className="mt-2"
                  placeholder="اكتب السبب..."
                  value={customReason}
                  onChange={e => setCustomReason(e.target.value)}
                  rows={2}
                />
              )}
            </div>

            <div>
              <Label>مرجع/ملاحظات (اختياري)</Label>
              <Textarea
                className="mt-1"
                placeholder="رقم أوردر، اسم مورّد، أو أي ملاحظة إضافية..."
                value={movementNotes}
                onChange={e => setMovementNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <Button className="min-h-11 md:min-h-9"
              variant="outline"
              onClick={() => setShowMovementDialog(false)}
            >
              إلغاء
            </Button>
            <Button
              className={
                movementType === "in"
                  ? "min-h-11 md:min-h-9 bg-[var(--success)] hover:bg-[var(--success)]"
                  : "min-h-11 md:min-h-9 bg-destructive hover:bg-destructive"
              }
              disabled={
                !quantity ||
                Number(quantity) < 1 ||
                (movementType === "out" &&
                  Number(quantity) > (selectedProduct?.currentStock ?? 0)) ||
                addMovementMutation.isPending
              }
              onClick={handleSubmitMovement}
            >
              {addMovementMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  جاري الحفظ...
                </span>
              ) : movementType === "in" ? (
                <span className="flex items-center gap-2">
                  <ArrowDownCircle className="h-4 w-4" />
                  تسجيل الوارد
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <ArrowUpCircle className="h-4 w-4" />
                  تسجيل الصادر
                </span>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Variant Movement Dialog ===== */}
      <Dialog
        open={showVariantMovementDialog}
        onOpenChange={setShowVariantMovementDialog}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {variantMovementType === "in" ? (
                <span className="flex items-center gap-2 text-[var(--success)]">
                  <ArrowDownCircle className="h-5 w-5" />
                  إضافة وارد
                </span>
              ) : (
                <span className="flex items-center gap-2 text-destructive">
                  <ArrowUpCircle className="h-5 w-5" />
                  تسجيل صادر
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div
              className={`rounded-lg p-3 ${variantMovementType === "in" ? "bg-[var(--success)]/10 border border-[var(--success)]/30" : "bg-destructive/10 border border-destructive/30"}`}
            >
              <p className="text-sm font-bold text-foreground">
                {selectedVariant ? variantLabel(selectedVariant) : ""}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                المخزون الحالي:{" "}
                <span className="font-semibold">
                  {selectedVariant?.currentStock}
                </span>{" "}
                قطعة
              </p>
            </div>

            <div>
              <Label>
                الكمية <span className="text-destructive">*</span>
              </Label>
              <Input
                type="number"
                min="1"
                max={
                  variantMovementType === "out"
                    ? selectedVariant?.currentStock
                    : undefined
                }
                value={variantQuantity}
                onChange={e => setVariantQuantity(e.target.value)}
                className="mt-1 text-lg font-bold"
                placeholder="أدخل الكمية"
              />
              {variantMovementType === "out" &&
                selectedVariant &&
                Number(variantQuantity) > selectedVariant.currentStock && (
                  <p className="text-xs text-destructive mt-1">
                    الكمية أكبر من المخزون المتاح
                  </p>
                )}
            </div>

            <div>
              <Label>السبب</Label>
              <Select value={variantReason} onValueChange={setVariantReason}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="اختر السبب..." />
                </SelectTrigger>
                <SelectContent>
                  {(variantMovementType === "in"
                    ? inventoryInReasons
                    : inventoryOutReasons
                  ).map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                  <SelectItem value="__custom__">سبب آخر...</SelectItem>
                </SelectContent>
              </Select>
              {variantReason === "__custom__" && (
                <Textarea
                  className="mt-2"
                  placeholder="اكتب السبب..."
                  value={variantCustomReason}
                  onChange={e => setVariantCustomReason(e.target.value)}
                  rows={2}
                />
              )}
            </div>

            <div>
              <Label>مرجع/ملاحظات (اختياري)</Label>
              <Textarea
                className="mt-1"
                placeholder="رقم أوردر، اسم مورّد، أو أي ملاحظة إضافية..."
                value={variantMovementNotes}
                onChange={e => setVariantMovementNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <Button className="min-h-11 md:min-h-9"
              variant="outline"
              onClick={() => setShowVariantMovementDialog(false)}
            >
              إلغاء
            </Button>
            <Button
              className={
                variantMovementType === "in"
                  ? "min-h-11 md:min-h-9 bg-[var(--success)] hover:bg-[var(--success)]"
                  : "min-h-11 md:min-h-9 bg-destructive hover:bg-destructive"
              }
              disabled={
                !variantQuantity ||
                Number(variantQuantity) < 1 ||
                (variantMovementType === "out" &&
                  Number(variantQuantity) >
                    (selectedVariant?.currentStock ?? 0)) ||
                variantMovementMutation.isPending
              }
              onClick={handleSubmitVariantMovement}
            >
              {variantMovementMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  جاري الحفظ...
                </span>
              ) : variantMovementType === "in" ? (
                <span className="flex items-center gap-2">
                  <ArrowDownCircle className="h-4 w-4" />
                  تسجيل الوارد
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <ArrowUpCircle className="h-4 w-4" />
                  تسجيل الصادر
                </span>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== History Dialog (per-product) ===== */}
      <Dialog open={showHistory} onOpenChange={setShowHistory}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              سجل حركات المخزون
              {historyProductId && rawProducts && (
                <span className="text-muted-foreground font-normal text-sm">
                  — {rawProducts.find(p => p.id === historyProductId)?.name}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {!movements || movements.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">
                لا توجد حركات مخزون
              </p>
            ) : (
              movements.map((m: any) => {
                const productName =
                  rawProducts?.find(p => p.id === m.productId)?.name ??
                  `صنف #${m.productId}`;
                return (
                  <div
                    key={m.id}
                    className="flex items-center gap-3 p-3 rounded-lg bg-muted/50"
                  >
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${m.type === "in" ? "bg-[var(--success)]/15 text-[var(--success)]" : "bg-destructive/15 text-destructive"}`}
                    >
                      {m.type === "in" ? (
                        <ArrowDownCircle className="h-4 w-4" />
                      ) : (
                        <ArrowUpCircle className="h-4 w-4" />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-foreground">
                          {productName}
                        </span>
                        <span
                          className={`text-sm font-bold ${m.type === "in" ? "text-[var(--success)]" : "text-destructive"}`}
                        >
                          {m.type === "in" ? "+" : "-"}
                          {m.quantity} قطعة
                        </span>
                        {m.reason && (
                          <span className="text-xs text-muted-foreground">
                            — {m.reason}
                          </span>
                        )}
                      </div>
                      {m.notes && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {m.notes}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(m.createdAt).toLocaleString("ar-EG")}
                      </p>
                    </div>
                    <Badge
                      className={`text-xs shrink-0 ${m.type === "in" ? "bg-[var(--success)]/15 text-[var(--success)] border-0" : "bg-destructive/15 text-destructive border-0"}`}
                    >
                      {m.type === "in" ? "وارد" : "صادر"}
                    </Badge>
                  </div>
                );
              })
            )}
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={() => setShowHistory(false)}>
              إغلاق
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Variant Create/Edit Dialog ===== */}
      <Dialog
        open={showVariantFormDialog}
        onOpenChange={o => {
          if (!o) closeVariantForm();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {variantFormMode === "create" ? (
                <Plus className="h-5 w-5 text-primary" />
              ) : (
                <Pencil className="h-5 w-5 text-[var(--info)]" />
              )}
              {variantFormMode === "create" ? "إضافة صنف جديد" : "تعديل الصنف"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>
                اسم النوع <span className="text-destructive">*</span>
              </Label>
              <Input
                value={vfName}
                onChange={e => setVfName(e.target.value)}
                className="mt-1"
                placeholder="مثلاً: آية الكرسي"
                autoFocus
              />
            </div>
            <div>
              <Label>
                SKU <span className="text-destructive">*</span>
              </Label>
              <Input
                value={vfSku}
                onChange={e => setVfSku(e.target.value)}
                className="mt-1 font-mono"
                placeholder="كود الصنف"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>سعر البيع</Label>
                <Input
                  type="number"
                  min="0"
                  value={vfPrice}
                  onChange={e => setVfPrice(e.target.value)}
                  className="mt-1"
                  placeholder="ج.م"
                />
              </div>
              <div>
                <Label>سعر التكلفة (اختياري)</Label>
                <Input
                  type="number"
                  min="0"
                  value={vfCostPrice}
                  onChange={e => setVfCostPrice(e.target.value)}
                  className="mt-1"
                  placeholder="ج.م"
                />
              </div>
            </div>
            {variantFormMode === "create" ? (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>المخزون الابتدائي</Label>
                  <Input
                    type="number"
                    min="0"
                    value={vfStock}
                    onChange={e => setVfStock(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>الحد الأدنى</Label>
                  <Input
                    type="number"
                    min="0"
                    value={vfMinStock}
                    onChange={e => setVfMinStock(e.target.value)}
                    className="mt-1"
                  />
                </div>
              </div>
            ) : (
              <div>
                <Label>الحد الأدنى</Label>
                <Input
                  type="number"
                  min="0"
                  value={vfMinStock}
                  onChange={e => setVfMinStock(e.target.value)}
                  className="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  لتغيير المخزون الحالي استخدم زر "وارد"/"صادر" من الجدول، مش
                  التعديل المباشر هنا.
                </p>
              </div>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="vf-active"
                checked={vfIsActive}
                onCheckedChange={c => setVfIsActive(c === true)}
              />
              <Label htmlFor="vf-active" className="cursor-pointer">
                نشط
              </Label>
            </div>
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={closeVariantForm}>
              إلغاء
            </Button>
            <Button className="min-h-11 md:min-h-9"
              onClick={submitVariantForm}
              disabled={
                createVariantMutation.isPending || editVariantMutation.isPending
              }
            >
              {createVariantMutation.isPending ||
              editVariantMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  جاري الحفظ...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Save className="h-4 w-4" />
                  حفظ
                </span>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Product Price Dialog ===== */}
      <Dialog open={showPriceDialog} onOpenChange={setShowPriceDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Tag className="h-5 w-5 text-primary" />
              تعديل سعر المنتج
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm font-semibold text-foreground">
              {rawProducts?.find(p => p.id === priceProductId)?.name}
            </p>
            <Label>
              السعر (ج.م) <span className="text-destructive">*</span>
            </Label>
            <Input
              type="number"
              min="0"
              value={priceValue}
              onChange={e => setPriceValue(e.target.value)}
              className="text-lg font-bold"
              autoFocus
              onKeyDown={e => {
                if (e.key === "Enter") submitPrice();
              }}
            />
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={() => setShowPriceDialog(false)}>
              إلغاء
            </Button>
            <Button className="min-h-11 md:min-h-9"
              onClick={submitPrice}
              disabled={updateProductPriceMutation.isPending}
            >
              {updateProductPriceMutation.isPending
                ? "جاري الحفظ..."
                : "حفظ السعر"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Variant Archive/Reactivate Confirm ===== */}
      <Dialog
        open={!!deleteVariantTarget}
        onOpenChange={o => {
          if (!o) setDeleteVariantTarget(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Archive className="h-5 w-5" />
              {deleteVariantTarget?.isActive
                ? "أرشفة الصنف"
                : "إعادة تفعيل الصنف"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {deleteVariantTarget?.isActive ? (
              <>
                هل أنت متأكد من أرشفة الصنف{" "}
                <span className="font-semibold text-foreground">
                  {deleteVariantTarget ? variantLabel(deleteVariantTarget) : ""}
                </span>
                ؟ لن يظهر بعدها للموظفين، لكن سجلات المخزون والأوردرات المرتبطة
                به هتفضل محفوظة، ويمكن التراجع لاحقًا.
              </>
            ) : (
              <>
                هل تريد إعادة تفعيل الصنف{" "}
                <span className="font-semibold text-foreground">
                  {deleteVariantTarget ? variantLabel(deleteVariantTarget) : ""}
                </span>
                ؟
              </>
            )}
          </p>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9"
              variant="outline"
              onClick={() => setDeleteVariantTarget(null)}
            >
              إلغاء
            </Button>
            <Button className="min-h-11 md:min-h-9"
              variant={
                deleteVariantTarget?.isActive ? "destructive" : "default"
              }
              onClick={() => {
                if (!deleteVariantTarget) return;
                if (deleteVariantTarget.isActive) {
                  deleteVariantMutation.mutate({ id: deleteVariantTarget.id });
                } else {
                  reactivateVariantMutation.mutate({
                    id: deleteVariantTarget.id,
                    isActive: true,
                  });
                }
              }}
              disabled={
                deleteVariantMutation.isPending ||
                reactivateVariantMutation.isPending
              }
            >
              {deleteVariantMutation.isPending ||
              reactivateVariantMutation.isPending
                ? "جاري الحفظ..."
                : deleteVariantTarget?.isActive
                  ? "أرشفة"
                  : "تفعيل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Product Create/Edit Dialog ===== */}
      <Dialog
        open={showProductFormDialog}
        onOpenChange={o => {
          if (!o) closeProductForm();
        }}
      >
        <DialogContent
          className={
            productFormMode === "create" && pfIsVariant
              ? "max-w-3xl"
              : "max-w-md"
          }
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {productFormMode === "create" ? (
                <Plus className="h-5 w-5 text-primary" />
              ) : (
                <Pencil className="h-5 w-5 text-[var(--info)]" />
              )}
              {productFormMode === "create"
                ? "إضافة منتج جديد"
                : "تعديل المنتج"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 max-h-[70vh] overflow-y-auto">
            <div>
              <Label>
                اسم المنتج <span className="text-destructive">*</span>
              </Label>
              <Input
                value={pfName}
                onChange={e => setPfName(e.target.value)}
                className="mt-1"
                placeholder="مثلاً: أسورة نحاس"
                autoFocus
              />
            </div>
            <div>
              <Label>الوصف (اختياري)</Label>
              <Textarea
                value={pfDescription}
                onChange={e => setPfDescription(e.target.value)}
                className="mt-1"
                rows={2}
              />
            </div>

            {/* اختيار نوع المنتج — إنشاء فقط (التعديل بيفضل على المنتج البسيط الحالي). */}
            {productFormMode === "create" && (
              <div className="flex items-center gap-2 rounded-md border p-2">
                <Checkbox
                  id="pf-is-variant"
                  checked={pfIsVariant}
                  onCheckedChange={c => setPfIsVariant(Boolean(c))}
                />
                <Label htmlFor="pf-is-variant" className="cursor-pointer">
                  منتج متعدد الخيارات (ألوان/مقاسات)
                </Label>
              </div>
            )}

            {productFormMode === "create" && pfIsVariant ? (
              <VariantMatrixBuilder
                value={pfMatrix}
                onChange={setPfMatrix}
                skuBase={pfSku}
              />
            ) : (
              <>
                <div>
                  <Label>
                    SKU (اختياري — اتركه فارغًا لو المنتج له أنواع متعددة بأسعار
                    مختلفة)
                  </Label>
                  <Input
                    value={pfSku}
                    onChange={e => setPfSku(e.target.value)}
                    className="mt-1 font-mono"
                    placeholder="كود المنتج"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label>السعر (اختياري)</Label>
                    <Input
                      type="number"
                      min="0"
                      value={pfPrice}
                      onChange={e => setPfPrice(e.target.value)}
                      className="mt-1"
                      placeholder="ج.م"
                    />
                  </div>
                  <div>
                    <Label>المخزون</Label>
                    <Input
                      type="number"
                      min="0"
                      value={pfStock}
                      onChange={e => setPfStock(e.target.value)}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label>الحد الأدنى</Label>
                    <Input
                      type="number"
                      min="0"
                      value={pfMinStock}
                      onChange={e => setPfMinStock(e.target.value)}
                      className="mt-1"
                    />
                  </div>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={closeProductForm}>
              إلغاء
            </Button>
            <Button className="min-h-11 md:min-h-9"
              onClick={submitProductForm}
              disabled={
                createProductMutation.isPending ||
                createWithVariantsMutation.isPending ||
                editProductMutation.isPending
              }
            >
              {createProductMutation.isPending ||
              createWithVariantsMutation.isPending ||
              editProductMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  جاري الحفظ...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Save className="h-4 w-4" />
                  حفظ
                </span>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Add Color/Size Matrix to existing product ===== */}
      <Dialog
        open={showAddMatrixDialog}
        onOpenChange={o => {
          if (!o) closeAddMatrix();
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-primary" />
              إضافة ألوان/مقاسات
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 max-h-[70vh] overflow-y-auto">
            <p className="text-sm text-muted-foreground">
              التركيبات الموجودة مسبقًا هيتم تخطّيها تلقائيًا — الجديد فقط اللي
              هيتضاف.
            </p>
            <VariantMatrixBuilder
              value={addMatrix}
              onChange={setAddMatrix}
              skuBase=""
            />
          </div>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9" variant="outline" onClick={closeAddMatrix}>
              إلغاء
            </Button>
            <Button className="min-h-11 md:min-h-9"
              onClick={submitAddMatrix}
              disabled={addVariantsToProductMutation.isPending}
            >
              {addVariantsToProductMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  جاري الحفظ...
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Save className="h-4 w-4" />
                  إضافة التركيبات الجديدة
                </span>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Product Archive Confirm ===== */}
      <Dialog
        open={!!archiveProductTarget}
        onOpenChange={o => {
          if (!o) setArchiveProductTarget(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Archive className="h-5 w-5" />
              {archiveProductTarget?.isActive
                ? "أرشفة المنتج"
                : "إعادة تفعيل المنتج"}
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {archiveProductTarget?.isActive ? (
              <>
                هل أنت متأكد من أرشفة المنتج{" "}
                <span className="font-semibold text-foreground">
                  {archiveProductTarget?.name}
                </span>
                ؟ لن يظهر بعدها للموظفين، لكن سجلات المخزون والأوردرات المرتبطة
                به هتفضل محفوظة بالكامل، ويمكن التراجع لاحقًا.
              </>
            ) : (
              <>
                هل تريد إعادة تفعيل المنتج{" "}
                <span className="font-semibold text-foreground">
                  {archiveProductTarget?.name}
                </span>
                ؟
              </>
            )}
          </p>
          <DialogFooter>
            <Button className="min-h-11 md:min-h-9"
              variant="outline"
              onClick={() => setArchiveProductTarget(null)}
            >
              إلغاء
            </Button>
            <Button className="min-h-11 md:min-h-9"
              variant={
                archiveProductTarget?.isActive ? "destructive" : "default"
              }
              onClick={() =>
                archiveProductTarget &&
                archiveProductMutation.mutate({
                  id: archiveProductTarget.id,
                  isActive: !archiveProductTarget.isActive,
                })
              }
              disabled={archiveProductMutation.isPending}
            >
              {archiveProductMutation.isPending
                ? "جاري الحفظ..."
                : archiveProductTarget?.isActive
                  ? "أرشفة"
                  : "تفعيل"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
