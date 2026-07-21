import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  Package, Plus, Minus, AlertTriangle, TrendingUp, TrendingDown,
  History, ArrowDownCircle, ArrowUpCircle, BarChart3, ClipboardList, Pencil, Check, X, Grid3X3, Trash2, Save, Tag
} from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";

// Reason presets
const IN_REASONS = [
  "استلام بضاعة جديدة من المورد",
  "إرجاع من عميل",
  "تصحيح جرد",
  "إضافة يدوية",
];
const OUT_REASONS = [
  "شحن أوردر",
  "تلف / كسر",
  "فقد",
  "عينة / هدية",
  "خصم يدوي",
];

export default function Inventory() {
  const utils = trpc.useUtils();
  const { currentBusinessIds, currentGroup } = useBusinessContext();

  // Dialog state
  const [showMovementDialog, setShowMovementDialog] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null);
  const [movementType, setMovementType] = useState<"in" | "out">("in");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");

  // History / daily log
  const [showHistory, setShowHistory] = useState(false);
  const [historyProductId, setHistoryProductId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"products" | "variants" | "daily">("products");

  // Edit stock state
  const [editingProductId, setEditingProductId] = useState<number | null>(null);
  const [editStockValue, setEditStockValue] = useState("");

  // Variant stock edit
  const [editingVariantId, setEditingVariantId] = useState<number | null>(null);
  const [editVariantStockValue, setEditVariantStockValue] = useState("");

  // Variant movement
  const [showVariantMovementDialog, setShowVariantMovementDialog] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  const [variantMovementType, setVariantMovementType] = useState<"in" | "out">("in");
  const [variantQuantity, setVariantQuantity] = useState("1");
  const [variantReason, setVariantReason] = useState("");
  const [variantCustomReason, setVariantCustomReason] = useState("");

  // Variant create/edit dialog
  const [showVariantFormDialog, setShowVariantFormDialog] = useState(false);
  const [variantFormMode, setVariantFormMode] = useState<"create" | "edit">("create");
  const [variantFormProductId, setVariantFormProductId] = useState<number | null>(null);
  const [variantFormId, setVariantFormId] = useState<number | null>(null);
  const [vfColor, setVfColor] = useState("");
  const [vfSize, setVfSize] = useState("");
  const [vfSku, setVfSku] = useState("");
  const [vfPrice, setVfPrice] = useState("");
  const [vfStock, setVfStock] = useState("0");
  const [vfMinStock, setVfMinStock] = useState("5");

  // Variant delete confirm
  const [deleteVariantTarget, setDeleteVariantTarget] = useState<any | null>(null);

  // Product price edit dialog
  const [showPriceDialog, setShowPriceDialog] = useState(false);
  const [priceProductId, setPriceProductId] = useState<number | null>(null);
  const [priceValue, setPriceValue] = useState("");

  const { data: products, isLoading } = trpc.products.list.useQuery(
    currentBusinessIds ? { businessIds: currentBusinessIds } : undefined
  );
  const { data: lowStock } = trpc.products.lowStock.useQuery(
    currentBusinessIds ? { businessIds: currentBusinessIds } : undefined
  );
  const { data: movements } = trpc.products.movements.useQuery({
    productId: historyProductId ?? undefined,
    limit: 100,
    businessIds: currentBusinessIds,
  });

  // Variants query
  const { data: allVariants, isLoading: variantsLoading } = trpc.variants.all.useQuery(
    currentBusinessIds ? { businessIds: currentBusinessIds } : {}
  );

  const addMovementMutation = trpc.products.addMovement.useMutation({
    onSuccess: () => {
      const label = movementType === 'in' ? 'وارد' : 'صادر';
      toast.success(`تم تسجيل ${label} المخزون بنجاح`);
      utils.products.list.invalidate();
      utils.products.lowStock.invalidate();
      utils.products.movements.invalidate();
      setShowMovementDialog(false);
      setQuantity("1");
      setReason("");
      setCustomReason("");
    },
    onError: (e) => toast.error(e.message),
  });

  const updateStockMutation = trpc.products.update.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث عدد القطع بنجاح");
      utils.products.list.invalidate();
      utils.products.lowStock.invalidate();
      setEditingProductId(null);
      setEditStockValue("");
    },
    onError: (e) => toast.error(e.message),
  });

  const updateVariantMutation = trpc.variants.update.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث جرد الـ variant بنجاح");
      utils.variants.all.invalidate();
      setEditingVariantId(null);
      setEditVariantStockValue("");
    },
    onError: (e) => toast.error(e.message),
  });

  const updateVariantStockMutation = trpc.variants.updateStock.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث المخزون بنجاح");
      utils.variants.all.invalidate();
      setShowVariantMovementDialog(false);
      setVariantQuantity("1");
      setVariantReason("");
      setVariantCustomReason("");
    },
    onError: (e) => toast.error(e.message),
  });

  const createVariantMutation = trpc.variants.create.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة الصنف بنجاح");
      utils.variants.all.invalidate();
      closeVariantForm();
    },
    onError: (e) => toast.error(e.message),
  });

  const editVariantMutation = trpc.variants.update.useMutation({
    onSuccess: () => {
      toast.success("تم تعديل الصنف بنجاح");
      utils.variants.all.invalidate();
      closeVariantForm();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteVariantMutation = trpc.variants.delete.useMutation({
    onSuccess: () => {
      toast.success("تم حذف الصنف");
      utils.variants.all.invalidate();
      setDeleteVariantTarget(null);
    },
    onError: (e) => toast.error(e.message),
  });

  const updateProductPriceMutation = trpc.products.update.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث سعر المنتج بنجاح");
      utils.products.list.invalidate();
      setShowPriceDialog(false);
      setPriceProductId(null);
      setPriceValue("");
    },
    onError: (e) => toast.error(e.message),
  });

  // ---- Variant form helpers ----
  function openCreateVariant(productId: number) {
    setVariantFormMode("create");
    setVariantFormProductId(productId);
    setVariantFormId(null);
    setVfColor(""); setVfSize(""); setVfSku(""); setVfPrice(""); setVfStock("0"); setVfMinStock("5");
    setShowVariantFormDialog(true);
  }

  function openEditVariant(variant: any) {
    setVariantFormMode("edit");
    setVariantFormProductId(variant.productId);
    setVariantFormId(variant.id);
    setVfColor(variant.color ?? "");
    setVfSize(variant.size ?? "");
    setVfSku(variant.sku ?? "");
    setVfPrice(variant.price != null ? String(variant.price) : "");
    setVfStock(String(variant.currentStock ?? 0));
    setVfMinStock(String(variant.minStockLevel ?? 5));
    setShowVariantFormDialog(true);
  }

  function closeVariantForm() {
    setShowVariantFormDialog(false);
    setVariantFormId(null);
    setVariantFormProductId(null);
  }

  function submitVariantForm() {
    if (!vfColor.trim() && !vfSize.trim()) {
      toast.error("لازم تدخل اللون أو المقاس على الأقل");
      return;
    }
    const stockNum = Number(vfStock);
    const minNum = Number(vfMinStock);
    if (isNaN(stockNum) || stockNum < 0 || isNaN(minNum) || minNum < 0) {
      toast.error("المخزون والحد الأدنى لازم أرقام صحيحة");
      return;
    }
    const priceNum = vfPrice.trim() === "" ? undefined : Number(vfPrice);
    if (priceNum !== undefined && (isNaN(priceNum) || priceNum < 0)) {
      toast.error("السعر لازم رقم صحيح");
      return;
    }
    if (variantFormMode === "create") {
      if (!variantFormProductId) return;
      createVariantMutation.mutate({
        productId: variantFormProductId,
        color: vfColor.trim() || undefined,
        size: vfSize.trim() || undefined,
        sku: vfSku.trim() || undefined,
        price: priceNum,
        currentStock: stockNum,
        minStockLevel: minNum,
      });
    } else {
      if (!variantFormId) return;
      editVariantMutation.mutate({
        id: variantFormId,
        color: vfColor.trim() || undefined,
        size: vfSize.trim() || undefined,
        sku: vfSku.trim() || undefined,
        price: priceNum,
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
    updateStockMutation.mutate({ id: editingProductId, currentStock: newStock });
  };

  const cancelEditStock = () => {
    setEditingProductId(null);
    setEditStockValue("");
  };

  const startEditVariantStock = (variant: { id: number; currentStock: number }) => {
    setEditingVariantId(variant.id);
    setEditVariantStockValue(String(variant.currentStock));
  };

  const saveEditVariantStock = () => {
    if (editingVariantId === null || editVariantStockValue === "") return;
    const newStock = Number(editVariantStockValue);
    if (isNaN(newStock) || newStock < 0) {
      toast.error("يرجى إدخال رقم صحيح");
      return;
    }
    updateVariantMutation.mutate({ id: editingVariantId, currentStock: newStock });
  };

  const cancelEditVariantStock = () => {
    setEditingVariantId(null);
    setEditVariantStockValue("");
  };

  const handleMovement = (productId: number, type: "in" | "out") => {
    setSelectedProductId(productId);
    setMovementType(type);
    setQuantity("1");
    setReason("");
    setCustomReason("");
    setShowMovementDialog(true);
  };

  const handleVariantMovement = (variantId: number, type: "in" | "out") => {
    setSelectedVariantId(variantId);
    setVariantMovementType(type);
    setVariantQuantity("1");
    setVariantReason("");
    setVariantCustomReason("");
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
    });
  };

  const handleSubmitVariantMovement = () => {
    if (!selectedVariantId || !variantQuantity) return;
    const delta = variantMovementType === 'in' ? Number(variantQuantity) : -Number(variantQuantity);
    updateVariantStockMutation.mutate({
      variantId: selectedVariantId,
      delta,
    });
  };

  const selectedProduct = products?.find(p => p.id === selectedProductId);
  const selectedVariant = allVariants?.find((v: any) => v.id === selectedVariantId);
  const totalStock = products?.reduce((sum, p) => sum + p.currentStock, 0) ?? 0;
  const totalVariantStock = allVariants?.reduce((sum: number, v: any) => sum + v.currentStock, 0) ?? 0;
  const lowStockCount = lowStock?.length ?? 0;
  const lowVariantCount = allVariants?.filter((v: any) => v.currentStock <= v.minStockLevel).length ?? 0;

  // Daily log: group movements by date
  const dailyLog = useMemo(() => {
    if (!movements) return [];
    const byDate: Record<string, { date: string; inQty: number; outQty: number; items: any[] }> = {};
    for (const m of movements) {
      const d = new Date(m.createdAt).toLocaleDateString('ar-EG', {
        year: 'numeric', month: 'long', day: 'numeric'
      });
      if (!byDate[d]) byDate[d] = { date: d, inQty: 0, outQty: 0, items: [] };
      if (m.type === 'in') byDate[d].inQty += m.quantity;
      else byDate[d].outQty += m.quantity;
      byDate[d].items.push(m);
    }
    return Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date));
  }, [movements]);

  // Today's movements
  const todayStr = new Date().toLocaleDateString('ar-EG', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
  const todayLog = dailyLog.find(d => d.date === todayStr);
  const todayIn = todayLog?.inQty ?? 0;
  const todayOut = todayLog?.outQty ?? 0;

  // Group variants by product
  const variantsByProduct = useMemo(() => {
    if (!allVariants) return {};
    const grouped: Record<string, { productName: string; variants: any[] }> = {};
    for (const v of allVariants as any[]) {
      const key = v.productId;
      if (!grouped[key]) {
        grouped[key] = { productName: v.productName || `منتج #${v.productId}`, variants: [] };
      }
      grouped[key].variants.push(v);
    }
    return grouped;
  }, [allVariants]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">المخزن والجرد</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {currentGroup ? `جرد قسم: ${currentGroup.name}` : 'إدارة المخزون والجرد لكل الأنشطة'}
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
            variant={activeTab === "variants" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTab("variants")}
          >
            <Grid3X3 className="h-4 w-4 ml-1" />
            المقاسات والألوان
          </Button>
          <Button
            variant={activeTab === "daily" ? "default" : "outline"}
            size="sm"
            onClick={() => { setActiveTab("daily"); setHistoryProductId(null); }}
          >
            <ClipboardList className="h-4 w-4 ml-1" />
            الجرد اليومي
          </Button>
        </div>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4 text-center">
            <Package className="h-6 w-6 text-primary mx-auto mb-2" />
            <p className="text-2xl font-bold text-foreground">{(totalStock + totalVariantStock).toLocaleString('ar-EG')}</p>
            <p className="text-xs text-muted-foreground mt-1">إجمالي المخزون</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <AlertTriangle className={`h-6 w-6 mx-auto mb-2 ${(lowStockCount + lowVariantCount) > 0 ? 'text-destructive' : 'text-muted-foreground'}`} />
            <p className={`text-2xl font-bold ${(lowStockCount + lowVariantCount) > 0 ? 'text-destructive' : 'text-foreground'}`}>{lowStockCount + lowVariantCount}</p>
            <p className="text-xs text-muted-foreground mt-1">صنف ينفد</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <ArrowDownCircle className="h-6 w-6 text-green-600 mx-auto mb-2" />
            <p className="text-2xl font-bold text-green-700">+{todayIn}</p>
            <p className="text-xs text-muted-foreground mt-1">وارد اليوم</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 text-center">
            <ArrowUpCircle className="h-6 w-6 text-red-500 mx-auto mb-2" />
            <p className="text-2xl font-bold text-red-600">-{todayOut}</p>
            <p className="text-xs text-muted-foreground mt-1">صادر اليوم</p>
          </CardContent>
        </Card>
      </div>

      {/* Low Stock Alert */}
      {lowStock && lowStock.length > 0 && activeTab !== "variants" && (
        <div className="bg-destructive/10 border border-destructive/20 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <p className="font-semibold text-destructive text-sm">تنبيه: الأصناف التالية تحتاج إعادة تخزين</p>
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

      {/* ===== TAB: PRODUCTS ===== */}
      {activeTab === "products" && (
        <>
          {isLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="h-52 bg-muted animate-pulse rounded-xl" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {products?.map(product => {
                const isLow = product.currentStock <= product.minStockLevel;
                const stockPct = Math.min(100, Math.round((product.currentStock / Math.max(product.minStockLevel * 3, 1)) * 100));

                return (
                  <Card key={product.id} className={`transition-all hover:shadow-md ${isLow ? 'border-destructive/40 bg-destructive/5' : ''}`}>
                    <CardContent className="p-4">
                      {/* Product Header */}
                      <div className="flex items-start justify-between mb-3">
                        <div className="flex-1">
                          <p className="font-bold text-foreground text-sm leading-snug">{product.name}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{product.sku}</p>
                        </div>
                        {isLow && (
                          <Badge variant="destructive" className="text-xs shrink-0 mr-2">
                            <AlertTriangle className="h-3 w-3 ml-1" />
                            ينفد
                          </Badge>
                        )}
                      </div>

                      {/* Stock Bar */}
                      <div className="mb-3">
                        <div className="flex justify-between items-center mb-1.5">
                          <span className="text-xs text-muted-foreground">المخزون الحالي</span>
                          {editingProductId === product.id ? (
                            <div className="flex items-center gap-1">
                              <Input
                                type="number"
                                min="0"
                                value={editStockValue}
                                onChange={e => setEditStockValue(e.target.value)}
                                className="w-20 h-7 text-center text-sm font-bold"
                                autoFocus
                                onKeyDown={e => {
                                  if (e.key === 'Enter') saveEditStock();
                                  if (e.key === 'Escape') cancelEditStock();
                                }}
                              />
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-green-600" onClick={saveEditStock}>
                                <Check className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-red-500" onClick={cancelEditStock}>
                                <X className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-1">
                              <span className={`text-xl font-bold ${isLow ? 'text-destructive' : 'text-foreground'}`}>
                                {product.currentStock} <span className="text-xs font-normal text-muted-foreground">قطعة</span>
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
                            className={`h-2.5 rounded-full transition-all ${isLow ? 'bg-destructive' : stockPct > 60 ? 'bg-green-500' : 'bg-yellow-500'}`}
                            style={{ width: `${stockPct}%` }}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground mt-1">
                          الحد الأدنى: {product.minStockLevel} قطعة
                        </p>
                      </div>

                      {/* Price */}
                      <div className="flex items-center justify-between mb-3 pb-3 border-b border-border">
                        <span className="text-xs text-muted-foreground">السعر</span>
                        <div className="flex items-center gap-1">
                          <span className="text-sm font-semibold text-primary">
                            {Number(product.price).toLocaleString('ar-EG')} ج.م
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
                          className="flex-1 bg-green-600 hover:bg-green-700 text-white h-9"
                          onClick={() => handleMovement(product.id, 'in')}
                        >
                          <ArrowDownCircle className="h-3.5 w-3.5 ml-1" />
                          وارد
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="flex-1 border-red-300 text-red-600 hover:bg-red-50 h-9"
                          onClick={() => handleMovement(product.id, 'out')}
                          disabled={product.currentStock === 0}
                        >
                          <ArrowUpCircle className="h-3.5 w-3.5 ml-1" />
                          صادر
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-9 w-9 p-0 shrink-0"
                          onClick={() => { setHistoryProductId(product.id); setShowHistory(true); }}
                          title="سجل الحركات"
                        >
                          <History className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* ===== TAB: VARIANTS (المقاسات والألوان) ===== */}
      {activeTab === "variants" && (
        <div className="space-y-6">
          {variantsLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-40 bg-muted animate-pulse rounded-xl" />
              ))}
            </div>
          ) : Object.keys(variantsByProduct).length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <Grid3X3 className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground">لا توجد منتجات بمقاسات وألوان</p>
                <p className="text-xs text-muted-foreground mt-1">المنتجات التي لها variants ستظهر هنا</p>
              </CardContent>
            </Card>
          ) : (
            Object.entries(variantsByProduct).map(([productId, group]) => (
              <Card key={productId}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-lg flex items-center gap-2">
                    <Package className="h-5 w-5 text-primary" />
                    {group.productName}
                    <Badge variant="secondary" className="text-xs mr-2">
                      {group.variants.length} نوع
                    </Badge>
                    <Badge variant="outline" className="text-xs">
                      إجمالي: {group.variants.reduce((s: number, v: any) => s + v.currentStock, 0)} قطعة
                    </Badge>
                    <Button
                      size="sm"
                      className="mr-auto h-8 bg-primary hover:bg-primary/90"
                      onClick={() => openCreateVariant(Number(productId))}
                    >
                      <Plus className="h-3.5 w-3.5 ml-1" />
                      إضافة صنف
                    </Button>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {/* Low stock variants alert */}
                  {group.variants.some((v: any) => v.currentStock <= v.minStockLevel) && (
                    <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 mb-4">
                      <div className="flex items-center gap-2 mb-1">
                        <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                        <p className="font-semibold text-destructive text-xs">أنواع تحتاج إعادة تخزين</p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {group.variants.filter((v: any) => v.currentStock <= v.minStockLevel).map((v: any) => (
                          <Badge key={v.id} variant="destructive" className="text-xs">
                            {v.color} - {v.size}: {v.currentStock}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Variants Table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border">
                          <th className="text-right py-2 px-3 text-xs font-semibold text-muted-foreground">اللون</th>
                          <th className="text-right py-2 px-3 text-xs font-semibold text-muted-foreground">المقاس</th>
                          <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">السعر</th>
                          <th className="text-right py-2 px-3 text-xs font-semibold text-muted-foreground">SKU</th>
                          <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">المخزون</th>
                          <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">الحالة</th>
                          <th className="text-center py-2 px-3 text-xs font-semibold text-muted-foreground">إجراءات</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.variants.map((variant: any) => {
                          const isLow = variant.currentStock <= variant.minStockLevel;
                          return (
                            <tr key={variant.id} className={`border-b border-border/50 hover:bg-muted/30 ${isLow ? 'bg-destructive/5' : ''}`}>
                              <td className="py-2.5 px-3">
                                <span className="font-medium text-foreground">{variant.color || '-'}</span>
                              </td>
                              <td className="py-2.5 px-3">
                                <span className="text-foreground">{variant.size || '-'}</span>
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <span className="font-semibold text-foreground">{variant.price ? `${Number(variant.price).toLocaleString()} ج.م` : '-'}</span>
                              </td>
                              <td className="py-2.5 px-3">
                                <span className="text-xs text-muted-foreground font-mono">{variant.sku || '-'}</span>
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                {editingVariantId === variant.id ? (
                                  <div className="flex items-center justify-center gap-1">
                                    <Input
                                      type="number"
                                      min="0"
                                      value={editVariantStockValue}
                                      onChange={e => setEditVariantStockValue(e.target.value)}
                                      className="w-16 h-7 text-center text-sm font-bold"
                                      autoFocus
                                      onKeyDown={e => {
                                        if (e.key === 'Enter') saveEditVariantStock();
                                        if (e.key === 'Escape') cancelEditVariantStock();
                                      }}
                                    />
                                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-green-600" onClick={saveEditVariantStock}>
                                      <Check className="h-3 w-3" />
                                    </Button>
                                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-red-500" onClick={cancelEditVariantStock}>
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </div>
                                ) : (
                                  <div className="flex items-center justify-center gap-1">
                                    <span className={`font-bold ${isLow ? 'text-destructive' : 'text-foreground'}`}>
                                      {variant.currentStock}
                                    </span>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-5 w-5 p-0 text-muted-foreground hover:text-primary"
                                      onClick={() => startEditVariantStock(variant)}
                                    >
                                      <Pencil className="h-2.5 w-2.5" />
                                    </Button>
                                  </div>
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                {isLow ? (
                                  <Badge variant="destructive" className="text-xs">ينفد</Badge>
                                ) : (
                                  <Badge className="text-xs bg-green-100 text-green-700 border-0">متوفر</Badge>
                                )}
                              </td>
                              <td className="py-2.5 px-3">
                                <div className="flex items-center justify-center gap-1">
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 w-7 p-0 text-green-600 hover:bg-green-50"
                                    onClick={() => handleVariantMovement(variant.id, 'in')}
                                    title="وارد"
                                  >
                                    <ArrowDownCircle className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 w-7 p-0 text-red-600 hover:bg-red-50"
                                    onClick={() => handleVariantMovement(variant.id, 'out')}
                                    disabled={variant.currentStock === 0}
                                    title="صادر"
                                  >
                                    <ArrowUpCircle className="h-3.5 w-3.5" />
                                  </Button>
                                  <div className="w-px h-5 bg-border mx-0.5" />
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 w-7 p-0 text-blue-600 hover:bg-blue-50"
                                    onClick={() => openEditVariant(variant)}
                                    title="تعديل الصنف"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    className="h-7 w-7 p-0 text-red-600 hover:bg-red-50"
                                    onClick={() => setDeleteVariantTarget(variant)}
                                    title="حذف الصنف"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* ===== TAB: DAILY LOG ===== */}
      {activeTab === "daily" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-bold text-foreground">الجرد اليومي</h2>
            <Select
              value={historyProductId?.toString() ?? "all"}
              onValueChange={v => setHistoryProductId(v === "all" ? null : Number(v))}
            >
              <SelectTrigger className="w-52">
                <SelectValue placeholder="كل الأصناف" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">كل الأصناف</SelectItem>
                {products?.map(p => (
                  <SelectItem key={p.id} value={p.id.toString()}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {dailyLog.length === 0 ? (
            <Card>
              <CardContent className="p-12 text-center">
                <ClipboardList className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
                <p className="text-muted-foreground">لا توجد حركات مخزون بعد</p>
                <p className="text-xs text-muted-foreground mt-1">ابدأ بإضافة وارد أو صادر من تبويب الأصناف</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {dailyLog.map(day => (
                <Card key={day.date}>
                  <CardHeader className="pb-2 pt-4 px-4">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm font-bold text-foreground">{day.date}</CardTitle>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-semibold text-green-700 bg-green-50 px-2 py-1 rounded-full">
                          وارد: +{day.inQty}
                        </span>
                        <span className="text-xs font-semibold text-red-700 bg-red-50 px-2 py-1 rounded-full">
                          صادر: -{day.outQty}
                        </span>
                        <span className="text-xs font-semibold text-blue-700 bg-blue-50 px-2 py-1 rounded-full">
                          صافي: {day.inQty - day.outQty >= 0 ? '+' : ''}{day.inQty - day.outQty}
                        </span>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="px-4 pb-4">
                    <div className="space-y-2">
                      {day.items.map((m: any) => {
                        const productName = products?.find(p => p.id === m.productId)?.name ?? `صنف #${m.productId}`;
                        return (
                          <div key={m.id} className="flex items-center gap-3 p-2.5 rounded-lg bg-muted/40">
                            <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${m.type === 'in' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                              {m.type === 'in'
                                ? <ArrowDownCircle className="h-3.5 w-3.5" />
                                : <ArrowUpCircle className="h-3.5 w-3.5" />
                              }
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-xs font-semibold text-foreground">{productName}</span>
                                <span className={`text-xs font-bold ${m.type === 'in' ? 'text-green-700' : 'text-red-700'}`}>
                                  {m.type === 'in' ? '+' : '-'}{m.quantity} قطعة
                                </span>
                                {m.reason && (
                                  <span className="text-xs text-muted-foreground truncate">— {m.reason}</span>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {new Date(m.createdAt).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                              </p>
                            </div>
                            <Badge
                              className={`text-xs shrink-0 ${m.type === 'in' ? 'bg-green-100 text-green-700 border-0' : 'bg-red-100 text-red-700 border-0'}`}
                            >
                              {m.type === 'in' ? 'وارد' : 'صادر'}
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

      {/* ===== Movement Dialog (Products) ===== */}
      <Dialog open={showMovementDialog} onOpenChange={setShowMovementDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {movementType === 'in' ? (
                <span className="flex items-center gap-2 text-green-700">
                  <ArrowDownCircle className="h-5 w-5" />
                  إضافة وارد للمخزن
                </span>
              ) : (
                <span className="flex items-center gap-2 text-red-700">
                  <ArrowUpCircle className="h-5 w-5" />
                  تسجيل صادر من المخزن
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className={`rounded-lg p-3 ${movementType === 'in' ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
              <p className="text-sm font-bold text-foreground">{selectedProduct?.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                المخزون الحالي: <span className="font-semibold">{selectedProduct?.currentStock}</span> قطعة
              </p>
            </div>

            <div>
              <Label>الكمية <span className="text-destructive">*</span></Label>
              <Input
                type="number"
                min="1"
                max={movementType === 'out' ? selectedProduct?.currentStock : undefined}
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
                className="mt-1 text-lg font-bold"
                placeholder="أدخل الكمية"
              />
              {movementType === 'out' && selectedProduct && Number(quantity) > selectedProduct.currentStock && (
                <p className="text-xs text-destructive mt-1">الكمية أكبر من المخزون المتاح</p>
              )}
            </div>

            <div>
              <Label>السبب</Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="اختر السبب..." />
                </SelectTrigger>
                <SelectContent>
                  {(movementType === 'in' ? IN_REASONS : OUT_REASONS).map(r => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
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
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMovementDialog(false)}>إلغاء</Button>
            <Button
              className={movementType === 'in' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}
              disabled={
                !quantity ||
                Number(quantity) < 1 ||
                (movementType === 'out' && Number(quantity) > (selectedProduct?.currentStock ?? 0)) ||
                addMovementMutation.isPending
              }
              onClick={handleSubmitMovement}
            >
              {addMovementMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  جاري الحفظ...
                </span>
              ) : movementType === 'in' ? (
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
      <Dialog open={showVariantMovementDialog} onOpenChange={setShowVariantMovementDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {variantMovementType === 'in' ? (
                <span className="flex items-center gap-2 text-green-700">
                  <ArrowDownCircle className="h-5 w-5" />
                  إضافة وارد
                </span>
              ) : (
                <span className="flex items-center gap-2 text-red-700">
                  <ArrowUpCircle className="h-5 w-5" />
                  تسجيل صادر
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className={`rounded-lg p-3 ${variantMovementType === 'in' ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}`}>
              <p className="text-sm font-bold text-foreground">
                {selectedVariant?.color} - {selectedVariant?.size}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                المخزون الحالي: <span className="font-semibold">{selectedVariant?.currentStock}</span> قطعة
              </p>
            </div>

            <div>
              <Label>الكمية <span className="text-destructive">*</span></Label>
              <Input
                type="number"
                min="1"
                max={variantMovementType === 'out' ? selectedVariant?.currentStock : undefined}
                value={variantQuantity}
                onChange={e => setVariantQuantity(e.target.value)}
                className="mt-1 text-lg font-bold"
                placeholder="أدخل الكمية"
              />
              {variantMovementType === 'out' && selectedVariant && Number(variantQuantity) > selectedVariant.currentStock && (
                <p className="text-xs text-destructive mt-1">الكمية أكبر من المخزون المتاح</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowVariantMovementDialog(false)}>إلغاء</Button>
            <Button
              className={variantMovementType === 'in' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}
              disabled={
                !variantQuantity ||
                Number(variantQuantity) < 1 ||
                (variantMovementType === 'out' && Number(variantQuantity) > (selectedVariant?.currentStock ?? 0)) ||
                updateVariantStockMutation.isPending
              }
              onClick={handleSubmitVariantMovement}
            >
              {updateVariantStockMutation.isPending ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  جاري الحفظ...
                </span>
              ) : variantMovementType === 'in' ? (
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
              {historyProductId && products && (
                <span className="text-muted-foreground font-normal text-sm">
                  — {products.find(p => p.id === historyProductId)?.name}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {!movements || movements.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">لا توجد حركات مخزون</p>
            ) : (
              movements.map((m: any) => {
                const productName = products?.find(p => p.id === m.productId)?.name ?? `صنف #${m.productId}`;
                return (
                  <div key={m.id} className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${m.type === 'in' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {m.type === 'in'
                        ? <ArrowDownCircle className="h-4 w-4" />
                        : <ArrowUpCircle className="h-4 w-4" />
                      }
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-foreground">{productName}</span>
                        <span className={`text-sm font-bold ${m.type === 'in' ? 'text-green-700' : 'text-red-700'}`}>
                          {m.type === 'in' ? '+' : '-'}{m.quantity} قطعة
                        </span>
                        {m.reason && (
                          <span className="text-xs text-muted-foreground">— {m.reason}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {new Date(m.createdAt).toLocaleString('ar-EG')}
                      </p>
                    </div>
                    <Badge className={`text-xs shrink-0 ${m.type === 'in' ? 'bg-green-100 text-green-700 border-0' : 'bg-red-100 text-red-700 border-0'}`}>
                      {m.type === 'in' ? 'وارد' : 'صادر'}
                    </Badge>
                  </div>
                );
              })
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowHistory(false)}>إغلاق</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Variant Create/Edit Dialog ===== */}
      <Dialog open={showVariantFormDialog} onOpenChange={(o) => { if (!o) closeVariantForm(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {variantFormMode === "create" ? <Plus className="h-5 w-5 text-primary" /> : <Pencil className="h-5 w-5 text-blue-600" />}
              {variantFormMode === "create" ? "إضافة صنف جديد" : "تعديل الصنف"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>اللون</Label>
                <Input value={vfColor} onChange={e => setVfColor(e.target.value)} className="mt-1" placeholder="مثلاً: ذهبي" />
              </div>
              <div>
                <Label>المقاس</Label>
                <Input value={vfSize} onChange={e => setVfSize(e.target.value)} className="mt-1" placeholder="مثلاً: وسط" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground -mt-1">لازم تدخل اللون أو المقاس على الأقل</p>
            <div>
              <Label>SKU (اختياري)</Label>
              <Input value={vfSku} onChange={e => setVfSku(e.target.value)} className="mt-1 font-mono" placeholder="كود الصنف" />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>السعر</Label>
                <Input type="number" min="0" value={vfPrice} onChange={e => setVfPrice(e.target.value)} className="mt-1" placeholder="ج.م" />
              </div>
              <div>
                <Label>المخزون</Label>
                <Input type="number" min="0" value={vfStock} onChange={e => setVfStock(e.target.value)} className="mt-1" />
              </div>
              <div>
                <Label>الحد الأدنى</Label>
                <Input type="number" min="0" value={vfMinStock} onChange={e => setVfMinStock(e.target.value)} className="mt-1" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeVariantForm}>إلغاء</Button>
            <Button
              onClick={submitVariantForm}
              disabled={createVariantMutation.isPending || editVariantMutation.isPending}
            >
              {(createVariantMutation.isPending || editVariantMutation.isPending) ? (
                <span className="flex items-center gap-2">
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  جاري الحفظ...
                </span>
              ) : (
                <span className="flex items-center gap-2"><Save className="h-4 w-4" />حفظ</span>
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
              {products?.find(p => p.id === priceProductId)?.name}
            </p>
            <Label>السعر (ج.م) <span className="text-destructive">*</span></Label>
            <Input
              type="number"
              min="0"
              value={priceValue}
              onChange={e => setPriceValue(e.target.value)}
              className="text-lg font-bold"
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') submitPrice(); }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPriceDialog(false)}>إلغاء</Button>
            <Button onClick={submitPrice} disabled={updateProductPriceMutation.isPending}>
              {updateProductPriceMutation.isPending ? "جاري الحفظ..." : "حفظ السعر"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ===== Variant Delete Confirm ===== */}
      <Dialog open={!!deleteVariantTarget} onOpenChange={(o) => { if (!o) setDeleteVariantTarget(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" />
              حذف الصنف
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            هل أنت متأكد من حذف الصنف{" "}
            <span className="font-semibold text-foreground">
              {deleteVariantTarget?.color} {deleteVariantTarget?.size ? `- ${deleteVariantTarget.size}` : ""}
            </span>؟ سجلات المخزون السابقة هتفضل محفوظة.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteVariantTarget(null)}>إلغاء</Button>
            <Button
              variant="destructive"
              onClick={() => deleteVariantTarget && deleteVariantMutation.mutate({ id: deleteVariantTarget.id })}
              disabled={deleteVariantMutation.isPending}
            >
              {deleteVariantMutation.isPending ? "جاري الحذف..." : "حذف"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
