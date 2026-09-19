import { useState, useMemo, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Plus, Phone, MapPin, Package, LogOut, RefreshCw, X, Trash2, Pencil, Save, Eraser, ClipboardPaste, AlertTriangle,
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
import {
  VariantOrderPicker,
  type Catalog,
  type PickedItem,
} from "@/components/orders/VariantOrderPicker";

/**
 * شاشة موظف إدخال الأوردرات — مبنية بالكامل على منتجات وتركيبات المخزون:
 *   المنتج ← اللون ← المقاس ← الكمية، مع عرض المتاح ومنع تجاوزه.
 * السعر بيتحسب من سعر التركيبة × الكمية. الأوردر بيتحفظ ومعاه variantId وSKU واللون والمقاس.
 * الموظف يرى ويعدّل أوردراته فقط (العزل على السيرفر). مافيش أي منطق قديم للإسورة.
 */

type CustomerForm = {
  customerName: string;
  customerPhone: string;
  governorate: string;
  customerAddress: string;
  city: string;
  notes: string;
  adName: string;
  shipping: string;
};

const EMPTY_CUSTOMER: CustomerForm = {
  customerName: "", customerPhone: "", governorate: "", customerAddress: "",
  city: "", notes: "", adName: "", shipping: "0",
};

const DRAFT_KEY = "manualEntryDraft";

export default function FacebookEntry() {
  const governorateOptions = useGovernorateOptions();
  const utils = trpc.useUtils();
  const [cust, setCust] = useState<CustomerForm>(EMPTY_CUSTOMER);
  const [items, setItems] = useState<PickedItem[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [parsing, setParsing] = useState(false);
  const [showOrders, setShowOrders] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Edit dialog
  const [editingOrder, setEditingOrder] = useState<any>(null);
  const [editCust, setEditCust] = useState<CustomerForm>(EMPTY_CUSTOMER);
  const [editItems, setEditItems] = useState<PickedItem[]>([]);
  const [deletingOrderId, setDeletingOrderId] = useState<number | null>(null);

  const { data: me, isLoading: meLoading } = trpc.employeePortal.me.useQuery();
  const { data: catalog = { products: [], variants: [] } } =
    trpc.facebookEntry.catalog.useQuery() as { data: Catalog };

  const { data: myOrders = [], refetch: refetchOrders } =
    trpc.facebookEntry.myOrders.useQuery(
      { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined },
      { enabled: showOrders }
    );

  const subtotal = useMemo(
    () => items.reduce((s, it) => s + it.unitPrice * it.quantity, 0),
    [items]
  );
  const total = subtotal + (Number(cust.shipping) || 0);

  const addOrderMutation = trpc.facebookEntry.addOrder.useMutation({
    onSuccess: data => {
      toast.success(`✅ تم إضافة الأوردر — رقم: ${data.orderNumber}`);
      setCust(EMPTY_CUSTOMER);
      setItems([]);
      localStorage.removeItem(DRAFT_KEY);
      if (showOrders) refetchOrders();
    },
    onError: e => toast.error(`خطأ: ${e.message}`),
  });
  const updateOrderMutation = trpc.facebookEntry.updateOrder.useMutation({
    onSuccess: () => { toast.success("✅ تم تعديل الأوردر"); setEditingOrder(null); refetchOrders(); },
    onError: e => toast.error(`خطأ: ${e.message}`),
  });
  const deleteOrderMutation = trpc.facebookEntry.deleteOrder.useMutation({
    onSuccess: () => { toast.success("✅ تم حذف الأوردر"); setDeletingOrderId(null); refetchOrders(); },
    onError: e => toast.error(`خطأ: ${e.message}`),
  });

  // مسودة محلية (نفس الجهاز فقط) — تسترجع مرة عند الفتح.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw) as { cust: CustomerForm; items: PickedItem[] };
      if (d.cust) setCust(d.cust);
      if (Array.isArray(d.items)) setItems(d.items);
      toast.info("تم استرجاع مسودة محفوظة");
    } catch { localStorage.removeItem(DRAFT_KEY); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function saveDraft() {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ cust, items }));
    toast.success("تم حفظ المسودة على هذا الجهاز");
  }
  function clearForm() {
    setCust(EMPTY_CUSTOMER); setItems([]); setPasteText("");
    localStorage.removeItem(DRAFT_KEY);
    toast.success("تم مسح النموذج");
  }

  // لصق رسالة العميل → تحليل تلقائي وملء الحقول (قابلة للتعديل يدويًا بعدها).
  async function parseAndFill() {
    if (!pasteText.trim()) return;
    setParsing(true);
    try {
      const res = await utils.facebookEntry.parsePaste.fetch({ text: pasteText });
      const p = res.parsed;
      setCust(c => ({
        ...c,
        customerName: p.customerName || c.customerName,
        customerPhone: p.customerPhone || c.customerPhone,
        governorate: p.governorate || c.governorate,
        customerAddress: p.customerAddress || c.customerAddress,
        adName: p.adName || c.adName,
        shipping: String(p.shipping ?? 0),
      }));
      if (res.match) {
        // تركيبة محسومة من المخزون — نخزّن variantId/SKU (مش نص اللون/المقاس بس).
        const v = catalog.variants.find(x => x.id === res.match!.variantId);
        const prod = catalog.products.find(x => x.id === res.match!.productId);
        const avail = v?.currentStock ?? prod?.currentStock ?? 0;
        setItems([
          {
            productId: res.match.productId,
            productName: res.match.productName,
            variantId: res.match.variantId ?? undefined,
            sku: res.match.sku ?? null,
            color: res.match.color ?? null,
            size: res.match.size ?? null,
            quantity: Math.min(p.quantity || 1, avail || (p.quantity || 1)),
            unitPrice: Number(res.match.unitPrice ?? 0),
            availableStock: avail,
          },
        ]);
        toast.success("تم تحليل الرسالة وتحديد التركيبة من المخزون");
      } else {
        // مفيش تركيبة مطابقة — نملّي الباقي ونعرض السبب بدل اختيار تركيبة غلط.
        setItems([]);
        toast.warning(
          `تم ملء البيانات، لكن لم يتم تحديد الصنف تلقائيًا: ${res.matchReason ?? "اختر المنتج واللون والمقاس يدويًا"}`
        );
      }
    } catch (e: any) {
      toast.error(`تعذّر التحليل: ${e.message}`);
    } finally {
      setParsing(false);
    }
  }

  function buildSelectedProducts(list: PickedItem[]) {
    return list.map(it => ({
      productId: it.productId,
      productName: it.productName,
      quantity: it.quantity,
      variantId: it.variantId,
      unitPrice: it.unitPrice,
    }));
  }

  function submit() {
    if (!cust.customerName.trim()) return toast.error("اسم العميل مطلوب");
    if (!cust.customerPhone.trim()) return toast.error("رقم الهاتف مطلوب");
    if (!cust.governorate.trim()) return toast.error("المحافظة مطلوبة");
    if (!cust.customerAddress.trim()) return toast.error("العنوان مطلوب");
    if (items.length === 0) return toast.error("أضف صنفًا واحدًا على الأقل");
    // حارس واجهة إضافي — السيرفر بيتحقق من المخزون برضه.
    const over = items.find(it => it.quantity > it.availableStock);
    if (over) return toast.error(`الكمية أكبر من المتاح للصنف ${over.productName}`);
    const first = items[0];
    addOrderMutation.mutate({
      customerName: cust.customerName.trim(),
      customerPhone: cust.customerPhone.trim(),
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
    } as any);
  }

  function openEdit(order: any) {
    setEditingOrder(order);
    setEditCust({
      customerName: order.customerName ?? "",
      customerPhone: order.customerPhone ?? "",
      governorate: order.governorate ?? "",
      customerAddress: order.customerAddress ?? "",
      city: order.city ?? "",
      notes: order.notes ?? "",
      adName: order.adName ?? "",
      shipping: String(order.shippingFees ?? "0"),
    });
    // بنود التعديل: من عناصر الأوردر لو متاحة، وإلا صنف واحد من رأس الأوردر.
    const src = (order.items?.length ? order.items : [{ productId: order.productId, productName: order.productName, quantity: order.quantity, variantId: order.variantId }]);
    setEditItems(
      src.map((it: any) => {
        const v = catalog.variants.find(x => x.id === it.variantId);
        const p = catalog.products.find(x => x.id === it.productId);
        const avail = v?.currentStock ?? p?.currentStock ?? it.quantity ?? 0;
        return {
          productId: it.productId, productName: it.productName ?? p?.name ?? "",
          variantId: it.variantId ?? undefined, sku: v?.sku ?? p?.sku ?? null,
          color: v?.color ?? order.color ?? null, size: v?.size ?? order.size ?? null,
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

  if (meLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin" /> جاري التحميل...
        </div>
      </div>
    );
  }
  if (!me) {
    window.location.href = "/employee-login";
    return null;
  }

  const custForm = (c: CustomerForm, set: (u: CustomerForm) => void) => (
    <div className="space-y-3">
      <div>
        <Label className="text-xs flex items-center gap-1"><Package className="h-3.5 w-3.5" /> اسم العميل *</Label>
        <Input value={c.customerName} onChange={e => set({ ...c, customerName: e.target.value })} className="mt-1" />
      </div>
      <div>
        <Label className="text-xs flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> رقم الهاتف *</Label>
        <Input value={c.customerPhone} onChange={e => set({ ...c, customerPhone: e.target.value })} className="mt-1" inputMode="tel" />
      </div>
      <GovernorateCitySelect
        governorate={c.governorate}
        city={c.city}
        onGovernorateChange={v => set(v !== c.governorate ? { ...c, governorate: v, city: "" } : { ...c, governorate: v })}
        onCityChange={v => set({ ...c, city: v })}
        configuredGovernorates={governorateOptions.values}
        isLoading={governorateOptions.isLoading}
        isError={governorateOptions.isError}
      />
      <div>
        <Label className="text-xs flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> العنوان *</Label>
        <Input value={c.customerAddress} onChange={e => set({ ...c, customerAddress: e.target.value })} className="mt-1" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">الشحن</Label>
          <Input type="number" min="0" value={c.shipping} onChange={e => set({ ...c, shipping: e.target.value })} className="mt-1" />
        </div>
        <div>
          <Label className="text-xs">مصدر الإعلان (اختياري)</Label>
          <Input value={c.adName} onChange={e => set({ ...c, adName: e.target.value })} className="mt-1" />
        </div>
      </div>
      <div>
        <Label className="text-xs">ملاحظات (اختياري)</Label>
        <Input value={c.notes} onChange={e => set({ ...c, notes: e.target.value })} className="mt-1" />
      </div>
    </div>
  );

  return (
    <div dir="rtl" className="min-h-screen bg-background p-3 sm:p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        {/* الرأس */}
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold">إدخال أوردر يدوي</h1>
            <p className="text-xs text-muted-foreground">أهلاً {me.name}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowOrders(s => !s)}>
              {showOrders ? "إخفاء أوردراتي" : "أوردراتي"}
            </Button>
            <Button size="sm" variant="ghost" onClick={handleLogout} title="خروج">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* نموذج الإدخال */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">أوردر جديد</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* لصق رسالة العميل — تحليل تلقائي وملء الحقول (تفضل قابلة للتعديل يدويًا). */}
            <div className="rounded-md border bg-muted/30 p-2 space-y-2">
              <Label className="text-xs flex items-center gap-1">
                <ClipboardPaste className="h-3.5 w-3.5" /> لصق رسالة العميل (تحليل تلقائي)
              </Label>
              <Textarea
                value={pasteText}
                onChange={e => setPasteText(e.target.value)}
                rows={4}
                dir="rtl"
                placeholder={"بيدج: ...\nالاسم: ...\nالعنوان: محافظة ...\nرقم الفون(1): 01xxxxxxxxx\nنوع المنتج: ...\nعدد القطع: ١\nاللون: اسود مقاس 8 سنين\nالشحن: مجانا\nالاجمالي: ..."}
                className="text-xs font-mono"
              />
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" onClick={parseAndFill} disabled={parsing || !pasteText.trim()}>
                  {parsing ? (
                    <span className="flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" /> جاري التحليل...</span>
                  ) : (
                    <span className="flex items-center gap-2"><ClipboardPaste className="h-4 w-4" /> تحليل وملء</span>
                  )}
                </Button>
                <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <AlertTriangle className="h-3 w-3" /> راجع الحقول بعد التحليل قبل الحفظ
                </span>
              </div>
            </div>

            {custForm(cust, setCust)}

            <div className="border-t pt-3">
              <Label className="text-sm font-semibold">الأصناف (من المخزون)</Label>
              <div className="mt-2">
                <VariantOrderPicker catalog={catalog} value={items} onChange={setItems} />
              </div>
            </div>

            <div className="flex items-center justify-between border-t pt-3 text-sm">
              <span className="text-muted-foreground">الإجمالي (الأصناف {subtotal} + الشحن {Number(cust.shipping) || 0})</span>
              <span className="font-bold text-lg">{total} ج.م</span>
            </div>

            <div className="flex items-center gap-2">
              <Button onClick={submit} disabled={addOrderMutation.isPending} className="flex-1">
                {addOrderMutation.isPending ? (
                  <span className="flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" /> جاري الحفظ...</span>
                ) : (
                  <span className="flex items-center gap-2"><Plus className="h-4 w-4" /> حفظ الأوردر</span>
                )}
              </Button>
              <Button variant="outline" onClick={saveDraft} title="حفظ مسودة"><Save className="h-4 w-4" /></Button>
              <Button variant="ghost" onClick={clearForm} title="مسح"><Eraser className="h-4 w-4" /></Button>
            </div>
          </CardContent>
        </Card>

        {/* أوردراتي */}
        {showOrders && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">أوردراتي</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="text-xs" />
                <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="text-xs" />
                <Button size="sm" variant="outline" onClick={() => refetchOrders()}><RefreshCw className="h-4 w-4" /></Button>
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
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => openEdit(o)}><Pencil className="h-3.5 w-3.5" /></Button>
                              <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" onClick={() => setDeletingOrderId(o.id)}><Trash2 className="h-3.5 w-3.5" /></Button>
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
              <div className="mt-2">
                <VariantOrderPicker catalog={catalog} value={editItems} onChange={setEditItems} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingOrder(null)}>إلغاء</Button>
            <Button onClick={submitEdit} disabled={updateOrderMutation.isPending}>
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
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingOrderId(null)}>إلغاء</Button>
            <Button variant="destructive" onClick={() => deletingOrderId != null && deleteOrderMutation.mutate({ orderId: deletingOrderId })} disabled={deleteOrderMutation.isPending}>
              <Trash2 className="h-4 w-4 ml-1" /> حذف
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
