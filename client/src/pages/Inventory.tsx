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
} from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";
import {
  getStockStatus,
  computeVariantTotals,
  type StockStatus,
} from "@shared/inventoryCalculations";
import { InventoryAccountingSection } from "./InventoryAccounting";
import { useOperationalOptions } from "@/hooks/useOperationalOptions";

const STATUS_LABELS: Record<StockStatus, string> = {
  available: "متوفر",
  low: "منخفض",
  out: "نفد المخزون",
  archived: "مؤرشف",
};
const STATUS_CLASSES: Record<StockStatus, string> = {
  available: "bg-[var(--success)]/15 text-[var(--success)] border-0",
  low: "bg-[var(--warning)]/15 text-[var(--warning)] border-0",
  out: "bg-destructive/15 text-destructive border-0",
  archived: "bg-muted text-muted-foreground border-0",
};

function StatusBadge({ status }: { status: StockStatus }) {
  return (
    <Badge className={`text-xs shrink-0 ${STATUS_CLASSES[status]}`}>
      {STATUS_LABELS[status]}
    </Badge>
  );
}

function variantLabel(v: any): string {
  return v.name || [v.color, v.size].filter(Boolean).join(" - ") || "بدون اسم";
}

export default function Inventory() {
  const utils = trpc.useUtils();
  const { currentBusinessIds, currentGroup } = useBusinessContext();
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

  // Variant archive confirm
  const [deleteVariantTarget, setDeleteVariantTarget] = useState<any | null>(
    null
  );

  // Product price edit dialog
  const [showPriceDialog, setShowPriceDialog] = useState(false);
  const [priceProductId, setPriceProductId] = useState<number | null>(null);
  const [priceValue, setPriceValue] = useState("");

  const { data: rawProducts, isLoading } = trpc.products.list.useQuery({
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
  const { data: rawVariants, isLoading: variantsLoading } =
    trpc.variants.all.useQuery({
      ...(currentBusinessIds ? { businessIds: currentBusinessIds } : {}),
      includeInactive: true,
    });

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

  function submitVariantForm() {
    if (!vfName.trim()) {
      toast.error("اسم النوع مطلوب");
      return;
    }
    if (!vfSku.trim()) {
      toast.error("رمز المنتج (SKU) مطلوب");
      return;
    }
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
        sku: vfSku.trim(),
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
        sku: vfSku.trim(),
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
  }

  function submitProductForm() {
    if (!pfName.trim()) {
      toast.error("اسم المنتج مطلوب");
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
      if (currentBusinessIds?.length !== 1) {
        toast.error("اختار قسم يحتوي على Business واحد قبل إنشاء منتج");
        return;
      }
      createProductMutation.mutate({
        name: pfName.trim(),
        description: pfDescription.trim() || undefined,
        sku: pfSku.trim() || undefined,
        price: priceNum !== undefined ? String(priceNum) : undefined,
        currentStock: stockNum,
        minStockLevel: minNum,
        businessId: currentBusinessIds[0],
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

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">المخزن والجرد</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {currentGroup
              ? `جرد قسم: ${currentGroup.name}`
              : "إدارة المخزون والجرد لكل الأنشطة"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={activeTab === "products" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("products")}
          >
            <Package className="h-4 w-4 ml-1" />
            الأصناف
          </Button>
          <Button
            variant={activeTab === "daily" ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setActiveTab("daily");
              setHistoryProductId(null);
            }}
          >
            <ClipboardList className="h-4 w-4 ml-1" />
            الجرد اليومي
          </Button>
          <Button
            variant={activeTab === "accounting" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("accounting")}
          >
            <PackageCheck className="h-4 w-4 ml-1" />
            التكلفة والاستلام
          </Button>
          {activeTab === "products" && (
            <Button
              size="sm"
              className="bg-primary hover:bg-primary/90"
              onClick={openCreateProduct}
            >
              <Plus className="h-4 w-4 ml-1" />
              إضافة منتج
            </Button>
          )}
        </div>
      </div>

      {/* Stats Row */}
      {activeTab !== "accounting" && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card>
            <CardContent className="p-4 text-center">
              <Package className="h-6 w-6 text-primary mx-auto mb-2" />
              <p className="text-2xl font-bold text-foreground">
                {totalStockAll.toLocaleString("ar-EG")}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                إجمالي المخزون
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <AlertTriangle
                className={`h-6 w-6 mx-auto mb-2 ${needsRestockCount > 0 ? "text-destructive" : "text-muted-foreground"}`}
              />
              <p
                className={`text-2xl font-bold ${needsRestockCount > 0 ? "text-destructive" : "text-foreground"}`}
              >
                {needsRestockCount}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                صنف يحتاج تخزين
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <ArrowDownCircle className="h-6 w-6 text-[var(--success)] mx-auto mb-2" />
              <p className="text-2xl font-bold text-[var(--success)]">
                +{todayIn}
              </p>
              <p className="text-xs text-muted-foreground mt-1">وارد اليوم</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4 text-center">
              <ArrowUpCircle className="h-6 w-6 text-destructive mx-auto mb-2" />
              <p className="text-2xl font-bold text-destructive">-{todayOut}</p>
              <p className="text-xs text-muted-foreground mt-1">صادر اليوم</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Low Stock Alert */}
      {lowStock && lowStock.length > 0 && activeTab === "products" && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <p className="font-semibold text-destructive text-sm">
              تنبيه: الأصناف التالية تحتاج إعادة تخزين
            </p>
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

      {/* ===== TAB: PRODUCTS (with nested variants) ===== */}
      {activeTab === "products" && (
        <>
          {/* Page controls: search / status filter / archived toggle / sort */}
          <Card>
            <CardContent className="p-3 flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="h-4 w-4 text-muted-foreground absolute right-3 top-1/2 -translate-y-1/2" />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="بحث بالمنتج، النوع، أو SKU..."
                  className="pr-9 h-9"
                />
              </div>
              <Select
                value={stockStatusFilter}
                onValueChange={v =>
                  setStockStatusFilter(v as typeof stockStatusFilter)
                }
              >
                <SelectTrigger className="w-40 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الحالات</SelectItem>
                  <SelectItem value="available">متوفر</SelectItem>
                  <SelectItem value="low">منخفض</SelectItem>
                  <SelectItem value="out">نفد المخزون</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={sortBy}
                onValueChange={v => setSortBy(v as typeof sortBy)}
              >
                <SelectTrigger className="w-36 h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="name">ترتيب بالاسم</SelectItem>
                  <SelectItem value="stock">ترتيب بالمخزون</SelectItem>
                  <SelectItem value="price">ترتيب بالسعر</SelectItem>
                  <SelectItem value="updated">ترتيب بآخر تحديث</SelectItem>
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant="outline"
                className="h-9 w-9 p-0"
                onClick={() => setSortDir(d => (d === "asc" ? "desc" : "asc"))}
                title={sortDir === "asc" ? "تصاعدي" : "تنازلي"}
              >
                <ArrowUpDown className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant={showArchived ? "default" : "outline"}
                className="h-9"
                onClick={() => setShowArchived(s => !s)}
              >
                {showArchived ? (
                  <Eye className="h-3.5 w-3.5 ml-1" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5 ml-1" />
                )}
                {showArchived ? "إخفاء المؤرشف" : "إظهار المؤرشف"}
              </Button>
              {hasActiveFilters && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 text-xs text-muted-foreground"
                  onClick={() => {
                    setSearch("");
                    setStockStatusFilter("all");
                    setShowArchived(false);
                  }}
                >
                  مسح الفلاتر
                </Button>
              )}
            </CardContent>
          </Card>

          {isLoading || variantsLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div
                  key={i}
                  className="h-32 bg-muted animate-pulse rounded-xl"
                />
              ))}
            </div>
          ) : !rawProducts || rawProducts.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <Package className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground">لا توجد منتجات بعد</p>
                <Button size="sm" className="mt-3" onClick={openCreateProduct}>
                  <Plus className="h-3.5 w-3.5 ml-1" />
                  إضافة أول منتج
                </Button>
              </CardContent>
            </Card>
          ) : rows.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <Search className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground">
                  لا توجد نتائج مطابقة للبحث/الفلاتر الحالية
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {rows.map(
                ({
                  product,
                  hasVariants,
                  visibleVariants,
                  totalStock,
                  totalValue,
                  attentionCount,
                  forceExpand,
                }) => {
                  const isExpanded =
                    forceExpand || !!expandedProducts[product.id];
                  const productStatus = getStockStatus(
                    product.isActive,
                    product.currentStock,
                    product.minStockLevel
                  );
                  const isLow =
                    !hasVariants &&
                    (productStatus === "low" || productStatus === "out");
                  const stockPct = Math.min(
                    100,
                    Math.round(
                      (product.currentStock /
                        Math.max(product.minStockLevel * 3, 1)) *
                        100
                    )
                  );

                  return (
                    <Card
                      key={product.id}
                      className={`transition-all ${isLow ? "border-destructive/40 bg-destructive/5" : ""} ${!product.isActive ? "opacity-60" : ""}`}
                    >
                      <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-start gap-2">
                          {hasVariants && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 w-7 p-0 shrink-0 mt-0.5"
                              onClick={() =>
                                setExpandedProducts(prev => ({
                                  ...prev,
                                  [product.id]: !prev[product.id],
                                }))
                              }
                              title={isExpanded ? "طي الأنواع" : "عرض الأنواع"}
                            >
                              {isExpanded ? (
                                <ChevronUp className="h-4 w-4" />
                              ) : (
                                <ChevronDown className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                          <Package className="h-5 w-5 text-primary shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-foreground">
                                {product.name}
                              </span>
                              {!product.isActive && (
                                <StatusBadge status="archived" />
                              )}
                              {product.sku && (
                                <span className="text-xs text-muted-foreground font-mono">
                                  {product.sku}
                                </span>
                              )}
                              {hasVariants && (
                                <>
                                  <Badge
                                    variant="secondary"
                                    className="text-xs"
                                  >
                                    {
                                      visibleVariants.filter(v => v.isActive)
                                        .length
                                    }{" "}
                                    نوع نشط
                                  </Badge>
                                  <Badge variant="outline" className="text-xs">
                                    إجمالي المخزون: {totalStock} قطعة
                                  </Badge>
                                  {totalValue !== null && (
                                    <Badge
                                      variant="outline"
                                      className="text-xs"
                                    >
                                      قيمة المخزون:{" "}
                                      {totalValue.toLocaleString("ar-EG")} ج.م
                                    </Badge>
                                  )}
                                  {attentionCount > 0 && (
                                    <Badge
                                      variant="destructive"
                                      className="text-xs"
                                    >
                                      <AlertTriangle className="h-3 w-3 ml-1" />
                                      {attentionCount} نوع يحتاج تخزين
                                    </Badge>
                                  )}
                                </>
                              )}
                              {isLow && <StatusBadge status={productStatus} />}
                            </div>
                            {product.description && (
                              <p className="text-xs text-muted-foreground mt-1">
                                {product.description}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs"
                              onClick={() => openCreateVariant(product.id)}
                              title="إضافة نوع"
                            >
                              <Plus className="h-3.5 w-3.5 ml-1" />
                              نوع
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0 text-[var(--info)] hover:bg-[var(--info)]/10"
                              onClick={() => openEditProduct(product)}
                              title="تعديل المنتج"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className={`h-8 w-8 p-0 ${product.isActive ? "text-destructive hover:bg-destructive/10" : "text-[var(--success)] hover:bg-[var(--success)]/10"}`}
                              onClick={() => setArchiveProductTarget(product)}
                              title={
                                product.isActive
                                  ? "أرشفة المنتج"
                                  : "إعادة تفعيل المنتج"
                              }
                            >
                              {product.isActive ? (
                                <Archive className="h-3.5 w-3.5" />
                              ) : (
                                <ArchiveRestore className="h-3.5 w-3.5" />
                              )}
                            </Button>
                          </div>
                        </CardTitle>
                      </CardHeader>

                      {hasVariants ? (
                        isExpanded && (
                          <CardContent>
                            {visibleVariants.length === 0 ? (
                              <p className="text-sm text-muted-foreground text-center py-4">
                                لا توجد أنواع مطابقة
                              </p>
                            ) : (
                              <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                  <thead>
                                    <tr className="border-b border-border">
                                      <th className="text-right py-2 px-3 text-xs font-semibold text-muted-foreground">
                                        النوع
                                      </th>
                                      <th className="text-right py-2 px-3 text-xs font-semibold text-muted-foreground">
                                        SKU
                                      </th>
                                      <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">
                                        المخزون
                                      </th>
                                      <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">
                                        الحد الأدنى
                                      </th>
                                      <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">
                                        سعر البيع
                                      </th>
                                      <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">
                                        سعر التكلفة
                                      </th>
                                      <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">
                                        الحالة
                                      </th>
                                      <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">
                                        إجراءات
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {visibleVariants.map((variant: any) => {
                                      const vStatus = getStockStatus(
                                        variant.isActive,
                                        variant.currentStock,
                                        variant.minStockLevel
                                      );
                                      return (
                                        <tr
                                          key={variant.id}
                                          className={`border-b border-border/50 hover:bg-muted/30 ${vStatus === "low" || vStatus === "out" ? "bg-destructive/5" : ""} ${!variant.isActive ? "opacity-60" : ""}`}
                                        >
                                          <td className="py-2.5 px-3">
                                            <span className="font-medium text-foreground">
                                              {variantLabel(variant)}
                                            </span>
                                          </td>
                                          <td className="py-2.5 px-3">
                                            <span className="text-xs text-muted-foreground font-mono">
                                              {variant.sku || "-"}
                                            </span>
                                          </td>
                                          <td className="py-2.5 px-3 text-center">
                                            <span
                                              className={`font-bold ${vStatus === "low" || vStatus === "out" ? "text-destructive" : "text-foreground"}`}
                                            >
                                              {variant.currentStock}
                                            </span>
                                          </td>
                                          <td className="py-2.5 px-3 text-center">
                                            <span className="text-muted-foreground">
                                              {variant.minStockLevel}
                                            </span>
                                          </td>
                                          <td className="py-2.5 px-3 text-center">
                                            <span className="font-semibold text-foreground">
                                              {variant.price
                                                ? `${Number(variant.price).toLocaleString()} ج.م`
                                                : "-"}
                                            </span>
                                          </td>
                                          <td className="py-2.5 px-3 text-center">
                                            <span className="text-muted-foreground">
                                              {variant.costPrice
                                                ? `${Number(variant.costPrice).toLocaleString()} ج.م`
                                                : "-"}
                                            </span>
                                          </td>
                                          <td className="py-2.5 px-3 text-center">
                                            <StatusBadge status={vStatus} />
                                          </td>
                                          <td className="py-2.5 px-3">
                                            <div className="flex items-center justify-center gap-1">
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-7 w-7 p-0 text-[var(--success)] hover:bg-[var(--success)]/10"
                                                onClick={() =>
                                                  handleVariantMovement(
                                                    variant.id,
                                                    "in"
                                                  )
                                                }
                                                title="وارد"
                                                disabled={!variant.isActive}
                                              >
                                                <ArrowDownCircle className="h-3.5 w-3.5" />
                                              </Button>
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-7 w-7 p-0 text-destructive hover:bg-destructive/10"
                                                onClick={() =>
                                                  handleVariantMovement(
                                                    variant.id,
                                                    "out"
                                                  )
                                                }
                                                disabled={
                                                  !variant.isActive ||
                                                  variant.currentStock === 0
                                                }
                                                title="صادر"
                                              >
                                                <ArrowUpCircle className="h-3.5 w-3.5" />
                                              </Button>
                                              <div className="w-px h-5 bg-border mx-0.5" />
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-7 w-7 p-0 text-[var(--info)] hover:bg-[var(--info)]/10"
                                                onClick={() =>
                                                  openEditVariant(variant)
                                                }
                                                title="تعديل الصنف"
                                              >
                                                <Pencil className="h-3.5 w-3.5" />
                                              </Button>
                                              <Button
                                                size="sm"
                                                variant="ghost"
                                                className={`h-7 w-7 p-0 ${variant.isActive ? "text-destructive hover:bg-destructive/10" : "text-[var(--success)] hover:bg-[var(--success)]/10"}`}
                                                onClick={() =>
                                                  setDeleteVariantTarget(
                                                    variant
                                                  )
                                                }
                                                title={
                                                  variant.isActive
                                                    ? "أرشفة الصنف"
                                                    : "إعادة تفعيل الصنف"
                                                }
                                              >
                                                {variant.isActive ? (
                                                  <Archive className="h-3.5 w-3.5" />
                                                ) : (
                                                  <ArchiveRestore className="h-3.5 w-3.5" />
                                                )}
                                              </Button>
                                            </div>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </CardContent>
                        )
                      ) : (
                        <CardContent className="pt-0">
                          {/* Stock Bar */}
                          <div className="mb-3">
                            <div className="flex justify-between items-center mb-1.5">
                              <span className="text-xs text-muted-foreground">
                                المخزون الحالي
                              </span>
                              {editingProductId === product.id ? (
                                <div className="flex items-center gap-1">
                                  <Input
                                    type="number"
                                    min="0"
                                    value={editStockValue}
                                    onChange={e =>
                                      setEditStockValue(e.target.value)
                                    }
                                    className="w-20 h-7 text-center text-sm font-bold"
                                    autoFocus
                                    onKeyDown={e => {
                                      if (e.key === "Enter") saveEditStock();
                                      if (e.key === "Escape") cancelEditStock();
                                    }}
                                  />
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 w-7 p-0 text-[var(--success)]"
                                    onClick={saveEditStock}
                                    disabled={updateStockMutation.isPending}
                                  >
                                    <Save className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-2">
                                  <StatusBadge status={productStatus} />
                                  <span
                                    className={`text-xl font-bold ${isLow ? "text-destructive" : "text-foreground"}`}
                                  >
                                    {product.currentStock}{" "}
                                    <span className="text-xs font-normal text-muted-foreground">
                                      قطعة
                                    </span>
                                  </span>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
                                    onClick={() => startEditStock(product)}
                                    title="تعديل عدد القطع"
                                  >
                                    <Pencil className="h-3 w-3" />
                                  </Button>
                                </div>
                              )}
                            </div>
                            <div className="w-full bg-muted rounded-full h-2.5">
                              <div
                                className={`h-2.5 rounded-full transition-all ${isLow ? "bg-destructive" : stockPct > 60 ? "bg-[var(--success)]/100" : "bg-[var(--warning)]"}`}
                                style={{ width: `${stockPct}%` }}
                              />
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              الحد الأدنى: {product.minStockLevel} قطعة
                            </p>
                          </div>

                          {/* Price */}
                          <div className="flex items-center justify-between mb-3 pb-3 border-b border-border">
                            <span className="text-xs text-muted-foreground">
                              السعر
                            </span>
                            <div className="flex items-center gap-1">
                              <span className="text-sm font-semibold text-primary">
                                {product.price != null
                                  ? `${Number(product.price).toLocaleString("ar-EG")} ج.م`
                                  : "بدون سعر"}
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 w-6 p-0 text-muted-foreground hover:text-primary"
                                onClick={() => openEditPrice(product)}
                                title="تعديل السعر"
                              >
                                <Pencil className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>

                          {/* Action Buttons */}
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              className="flex-1 bg-[var(--success)] hover:bg-[var(--success)] text-white h-9"
                              onClick={() => handleMovement(product.id, "in")}
                              disabled={!product.isActive}
                            >
                              <ArrowDownCircle className="h-3.5 w-3.5 ml-1" />
                              وارد
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1 border-destructive/40 text-destructive hover:bg-destructive/10 h-9"
                              onClick={() => handleMovement(product.id, "out")}
                              disabled={
                                !product.isActive || product.currentStock === 0
                              }
                            >
                              <ArrowUpCircle className="h-3.5 w-3.5 ml-1" />
                              صادر
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-9 w-9 p-0 shrink-0"
                              onClick={() => {
                                setHistoryProductId(product.id);
                                setShowHistory(true);
                              }}
                              title="سجل الحركات"
                            >
                              <History className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </CardContent>
                      )}
                    </Card>
                  );
                }
              )}
            </div>
          )}
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
            <Button
              variant="outline"
              onClick={() => setShowMovementDialog(false)}
            >
              إلغاء
            </Button>
            <Button
              className={
                movementType === "in"
                  ? "bg-[var(--success)] hover:bg-[var(--success)]"
                  : "bg-destructive hover:bg-destructive"
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
            <Button
              variant="outline"
              onClick={() => setShowVariantMovementDialog(false)}
            >
              إلغاء
            </Button>
            <Button
              className={
                variantMovementType === "in"
                  ? "bg-[var(--success)] hover:bg-[var(--success)]"
                  : "bg-destructive hover:bg-destructive"
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
            <Button variant="outline" onClick={() => setShowHistory(false)}>
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
            <Button variant="outline" onClick={closeVariantForm}>
              إلغاء
            </Button>
            <Button
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
            <Button variant="outline" onClick={() => setShowPriceDialog(false)}>
              إلغاء
            </Button>
            <Button
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
            <Button
              variant="outline"
              onClick={() => setDeleteVariantTarget(null)}
            >
              إلغاء
            </Button>
            <Button
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
        <DialogContent className="max-w-md">
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
          <div className="space-y-3">
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeProductForm}>
              إلغاء
            </Button>
            <Button
              onClick={submitProductForm}
              disabled={
                createProductMutation.isPending || editProductMutation.isPending
              }
            >
              {createProductMutation.isPending ||
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
            <Button
              variant="outline"
              onClick={() => setArchiveProductTarget(null)}
            >
              إلغاء
            </Button>
            <Button
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
