import { useState, useEffect } from "react";
import { MessagesEntryButton } from "@/components/messaging/MessagesEntryButton";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { BrandMark } from "@/components/BrandMark";
import {
  Package,
  Plus,
  Minus,
  AlertTriangle,
  LogOut,
  RefreshCw,
  ArrowDownCircle,
  ArrowUpCircle,
  History,
  Box,
} from "lucide-react";

export default function WarehouseDashboard() {
  const [, setLocation] = useLocation();
  const [showMovementDialog, setShowMovementDialog] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState<number | null>(
    null
  );
  const [movementType, setMovementType] = useState<"in" | "out">("in");
  const [quantity, setQuantity] = useState("1");
  const [reason, setReason] = useState("");
  const [customReason, setCustomReason] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [historyProductId, setHistoryProductId] = useState<number | null>(null);

  const empSession = (() => {
    try {
      return JSON.parse(localStorage.getItem("employee_session") || "null");
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    if (!empSession) setLocation("/employee-login");
  }, [empSession]);

  const utils = trpc.useUtils();
  const { data: meData, error: meError } = trpc.employeePortal.me.useQuery(
    undefined,
    { retry: false }
  );
  const { data: inventoryInReasons = [] } =
    trpc.accountingV2.configurationListForBusinesses.useQuery(
      {
        businessIds: meData?.businessId ? [meData.businessId] : [],
        namespace: "inventory_in_reason",
      },
      { enabled: Boolean(meData?.businessId) }
    );
  const { data: inventoryOutReasons = [] } =
    trpc.accountingV2.configurationListForBusinesses.useQuery(
      {
        businessIds: meData?.businessId ? [meData.businessId] : [],
        namespace: "inventory_out_reason",
      },
      { enabled: Boolean(meData?.businessId) }
    );

  useEffect(() => {
    if (meError) {
      localStorage.removeItem("employee_session");
      setLocation("/employee-login");
    }
  }, [meError]);

  const { data: products, isLoading } =
    trpc.employeePortal.productsList.useQuery(undefined, {
      enabled: !!meData,
    });
  const { data: lowStock } = trpc.employeePortal.lowStockProducts.useQuery(
    undefined,
    {
      enabled: !!meData,
    }
  );
  const { data: movements } = trpc.employeePortal.inventoryMovements.useQuery(
    { productId: historyProductId ?? undefined, limit: 50 },
    { enabled: !!meData }
  );

  const addMovementMutation =
    trpc.employeePortal.addInventoryMovement.useMutation({
      onSuccess: () => {
        const label = movementType === "in" ? "وارد" : "صادر";
        toast.success(`تم تسجيل ${label} المخزون بنجاح`);
        utils.employeePortal.productsList.invalidate();
        utils.employeePortal.lowStockProducts.invalidate();
        utils.employeePortal.inventoryMovements.invalidate();
        setShowMovementDialog(false);
        setQuantity("1");
        setReason("");
        setCustomReason("");
      },
      onError: (e: any) => toast.error(e.message),
    });

  const handleAddMovement = () => {
    if (!selectedProductId) return;
    const qty = parseInt(quantity);
    if (isNaN(qty) || qty < 1) {
      toast.error("الكمية يجب أن تكون 1 على الأقل");
      return;
    }
    const finalReason = reason === "custom" ? customReason : reason;
    addMovementMutation.mutate({
      productId: selectedProductId,
      type: movementType,
      quantity: qty,
      reason: finalReason || undefined,
    });
  };

  const handleLogout = () => {
    localStorage.removeItem("employee_session");
    document.cookie =
      "employee_token=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";
    setLocation("/employee-login");
  };

  const totalStock =
    products?.reduce((sum: number, p: any) => sum + (p.currentStock ?? 0), 0) ??
    0;
  const lowStockCount = lowStock?.length ?? 0;

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      {/* Header */}
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-4 py-3 text-primary-foreground shadow-md"
        style={{
          background:
            "linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%)",
        }}
      >
        <div className="flex items-center gap-3">
          <BrandMark className="h-9 w-9" variant="inverse" />
          <div>
            <h1 className="font-bold text-sm">متجرك</h1>
            <p className="text-xs text-primary-foreground/70">
              أهلاً، {empSession?.name || "موظف المخزن"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button data-readonly-safe
            variant="ghost"
            size="sm"
            className="min-h-11 min-w-11 text-primary-foreground hover:bg-primary-foreground/10 md:min-h-9 md:min-w-9"
            aria-label="تحديث"
            onClick={() => {
              utils.employeePortal.productsList.invalidate();
              utils.employeePortal.lowStockProducts.invalidate();
              utils.employeePortal.inventoryMovements.invalidate();
            }}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <MessagesEntryButton via="portal" className="text-primary-foreground hover:bg-primary-foreground/10 md:h-9 md:min-h-9 md:w-9 md:min-w-9" />
          <Button data-readonly-safe
            variant="ghost"
            size="sm"
            className="min-h-11 min-w-11 text-primary-foreground hover:bg-primary-foreground/10 md:min-h-9 md:min-w-9"
            aria-label="خروج"
            onClick={handleLogout}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-6 p-4">
        {/* Stats */}
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-[var(--radius-brand-md)] border border-border bg-card p-4 text-center shadow-[var(--shadow-card)]">
            <Box className="h-6 w-6 mx-auto text-[var(--warning)] mb-1" />
            <p className="text-2xl font-bold text-foreground">{totalStock}</p>
            <p className="text-xs text-muted-foreground">إجمالي المخزون</p>
          </div>
          <div className="rounded-[var(--radius-brand-md)] border border-border bg-card p-4 text-center shadow-[var(--shadow-card)]">
            <AlertTriangle className="h-6 w-6 mx-auto text-destructive mb-1" />
            <p className="text-2xl font-bold text-destructive">
              {lowStockCount}
            </p>
            <p className="text-xs text-muted-foreground">منتجات منخفضة</p>
          </div>
        </div>

        {/* Low Stock Alert */}
        {lowStockCount > 0 && (
          <div className="rounded-[var(--radius-brand-md)] border border-destructive/30 bg-destructive/10 p-4" role="status">
            <h3 className="font-bold text-destructive text-sm flex items-center gap-2 mb-2">
              <AlertTriangle className="h-4 w-4" />
              تنبيه: منتجات تحتاج تعبئة
            </h3>
            <div className="space-y-1">
              {lowStock?.map((p: any) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between text-sm"
                >
                  <span className="text-destructive">{p.name}</span>
                  <Badge variant="destructive" className="text-xs">
                    {p.currentStock} قطعة
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Products List */}
        <div className="rounded-[var(--radius-brand-md)] border border-border bg-card shadow-[var(--shadow-card)]">
          <div className="p-4 border-b flex items-center justify-between">
            <h2 className="font-bold text-foreground flex items-center gap-2">
              <Package className="h-5 w-5 text-[var(--warning)]" />
              المنتجات
            </h2>
            <Button data-readonly-safe
              size="sm"
              variant="outline"
              className="min-h-11 md:min-h-9 gap-1 text-xs"
              onClick={() => {
                setShowHistory(true);
                setHistoryProductId(null);
              }}
            >
              <History className="h-3.5 w-3.5" />
              سجل الحركات
            </Button>
          </div>
          <div className="divide-y">
            {(!products || products.length === 0) && (
              <p className="p-6 text-center text-sm text-muted-foreground">لا توجد منتجات في مخزنك بعد.</p>
            )}
            {products?.map((product: any) => (
              <div
                key={product.id}
                className="p-4 flex items-center justify-between"
              >
                <div>
                  <p className="font-medium text-foreground">{product.name}</p>
                  <p className="text-xs text-muted-foreground">
                    SKU: {product.sku}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={
                      product.currentStock <= (product.minStockLevel ?? 15)
                        ? "destructive"
                        : "secondary"
                    }
                    className="text-sm px-3"
                  >
                    {product.currentStock} قطعة
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11 md:h-8 min-w-11 md:min-w-8 md:w-8 p-0 border-[var(--success)]/30 text-[var(--success)] hover:bg-[var(--success)]/10"
                    onClick={() => {
                      setSelectedProductId(product.id);
                      setMovementType("in");
                      setShowMovementDialog(true);
                    }}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11 md:h-8 min-w-11 md:min-w-8 md:w-8 p-0 border-destructive/30 text-destructive hover:bg-destructive/10"
                    onClick={() => {
                      setSelectedProductId(product.id);
                      setMovementType("out");
                      setShowMovementDialog(true);
                    }}
                  >
                    <Minus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* Movement Dialog */}
      <Dialog open={showMovementDialog} onOpenChange={setShowMovementDialog}>
        <DialogContent className="max-w-sm" dir="rtl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {movementType === "in" ? (
                <>
                  <ArrowDownCircle className="h-5 w-5 text-[var(--success)]" />{" "}
                  إضافة للمخزن
                </>
              ) : (
                <>
                  <ArrowUpCircle className="h-5 w-5 text-destructive" /> سحب من
                  المخزن
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>المنتج</Label>
              <p className="text-sm font-medium mt-1">
                {products?.find((p: any) => p.id === selectedProductId)?.name ??
                  ""}
              </p>
            </div>
            <div>
              <Label htmlFor="wh-qty">الكمية</Label>
              <Input
                id="wh-qty"
                type="number"
                min="1"
                inputMode="numeric"
                dir="ltr"
                value={quantity}
                onChange={e => setQuantity(e.target.value)}
                className="mt-1 min-h-11"
              />
            </div>
            <div>
              <Label htmlFor="wh-reason">السبب</Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger id="wh-reason" className="mt-1 min-h-11">
                  <SelectValue placeholder="اختر السبب" />
                </SelectTrigger>
                <SelectContent>
                  {(movementType === "in"
                    ? inventoryInReasons
                    : inventoryOutReasons
                  ).map(option => (
                    <SelectItem key={option.configKey} value={option.configKey}>
                      {option.displayName}
                    </SelectItem>
                  ))}
                  <SelectItem value="custom">سبب آخر...</SelectItem>
                </SelectContent>
              </Select>
              {reason === "custom" && (
                <Input
                  className="mt-2 min-h-11"
                  aria-label="سبب آخر"
                  placeholder="اكتب السبب..."
                  value={customReason}
                  onChange={e => setCustomReason(e.target.value)}
                />
              )}
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
              onClick={handleAddMovement}
              disabled={addMovementMutation.isPending}
              className={`min-h-11 md:min-h-9 ${
                movementType === "in"
                  ? "bg-[var(--success)] text-[var(--success-foreground,#fff)] hover:opacity-90"
                  : "bg-destructive text-destructive-foreground hover:opacity-90"
              }`}
            >
              {addMovementMutation.isPending ? "جاري التسجيل..." : "تأكيد"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* History Dialog */}
      <Dialog open={showHistory} onOpenChange={setShowHistory}>
        <DialogContent
          className="max-w-lg max-h-[80vh] overflow-y-auto"
          dir="rtl"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <History className="h-5 w-5 text-[var(--warning)]" />
              سجل حركات المخزون
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {movements && movements.length > 0 ? (
              movements.map((m: any, i: number) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-[var(--radius-brand-md)] border border-border bg-muted/30 p-3"
                >
                  <div className="flex items-center gap-2">
                    {m.type === "in" ? (
                      <ArrowDownCircle className="h-4 w-4 text-[var(--success)]" />
                    ) : (
                      <ArrowUpCircle className="h-4 w-4 text-destructive" />
                    )}
                    <div>
                      <p className="text-sm font-medium">
                        {m.productName || "منتج"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {m.reason || "—"}
                      </p>
                    </div>
                  </div>
                  <div className="text-left">
                    <Badge
                      variant={m.type === "in" ? "default" : "destructive"}
                      className="text-xs"
                    >
                      {m.type === "in" ? "+" : "-"}
                      {m.quantity}
                    </Badge>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(m.createdAt).toLocaleDateString("ar-EG", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-center text-muted-foreground py-8">
                لا توجد حركات بعد
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
