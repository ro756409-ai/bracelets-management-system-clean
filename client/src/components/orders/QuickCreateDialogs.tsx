import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

/**
 * نوافذ «أضف الآن» من داخل نموذج الأوردر — للنشاط الجديد الذي لا يملك بعد شركة شحن ولا أنواع
 * شحن/دفع ولا منتجات.
 *
 * كانت روابط «سجّلها من الإعدادات» تذهب إلى `/accounting-settings`، وهي صفحة النظام المحاسبي
 * المجمّد (تعرض «قيد إعادة التطوير») — فالمالك الجديد ماكانش يقدر يسجّل أي قيمة. النوافذ هنا
 * تفتح فوق نموذج الأوردر (نافذة متداخلة)، فالبيانات المكتوبة في النموذج تبقى كما هي، وبعد الحفظ
 * يُعاد تحميل القائمة المعنية وتُختار القيمة الجديدة فورًا.
 *
 * لا بيانات افتراضية تلقائية: كل عنصر يُنشأ بقرار المستخدم وباسمه هو.
 */

type BaseProps = { businessId: number; open: boolean; onClose: () => void };

/** شركة شحن — حقل اسم واحد (نفس قرار شاشة الإعدادات القديمة: الاسم = الكود = الاسم الظاهر). */
export function QuickShippingProviderDialog({ businessId, open, onClose, onCreated }: BaseProps & { onCreated: (row: { id: number; displayName: string }) => Promise<void> | void }) {
  const [name, setName] = useState("");
  const utils = trpc.useUtils();
  const save = trpc.accountingV2.shippingProviderSave.useMutation({
    onSuccess: async row => {
      await utils.accountingV2.shippingConfiguration.invalidate({ businessId });
      toast.success(`تمت إضافة شركة الشحن «${row.displayName}»`);
      setName("");
      await onCreated({ id: row.id, displayName: row.displayName });
      onClose();
    },
    onError: e => toast.error(e.message),
  });
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return toast.error("اكتب اسم شركة الشحن");
    save.mutate({ businessId, providerCode: trimmed, providerName: trimmed, displayName: trimmed, statusMapping: {} });
  };
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid="quick-shipping-provider">
        <DialogHeader>
          <DialogTitle>إضافة شركة شحن</DialogTitle>
          <DialogDescription>الاسم الذي ستختاره في الأوردرات. لو كتبت اسمًا موجودًا يُعاد استخدامه ولا يتكرر.</DialogDescription>
        </DialogHeader>
        <div>
          <Label>اسم شركة الشحن</Label>
          <Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="مثال: بوسطة" className="mt-1"
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit(); } }} data-testid="quick-shipping-provider-name" />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>إلغاء</Button>
          <Button onClick={submit} disabled={save.isPending} data-testid="quick-shipping-provider-save">{save.isPending ? "جاري الحفظ..." : "حفظ"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** نوع شحن أو نوع دفع — بالاسم فقط؛ المفتاح الثابت يولّده السيرفر. */
export function QuickConfigValueDialog({ businessId, namespace, open, onClose, onCreated }: BaseProps & {
  namespace: "shipping_type" | "payment_type";
  onCreated: (row: { configKey: string; displayName: string }) => Promise<void> | void;
}) {
  const label = namespace === "shipping_type" ? "نوع الشحن" : "نوع الدفع";
  const example = namespace === "shipping_type" ? "مثال: توصيل عادي" : "مثال: كاش عند الاستلام";
  const [name, setName] = useState("");
  const utils = trpc.useUtils();
  const add = trpc.accountingV2.configurationQuickAdd.useMutation({
    onSuccess: async row => {
      await utils.accountingV2.configurationList.invalidate({ businessId, namespace, activeOnly: true });
      toast.success(row.created ? `تمت إضافة ${label} «${row.displayName}»` : `«${row.displayName}» موجود بالفعل — تم اختياره`);
      setName("");
      await onCreated({ configKey: row.configKey, displayName: row.displayName });
      onClose();
    },
    onError: e => toast.error(e.message),
  });
  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return toast.error(`اكتب اسم ${label}`);
    add.mutate({ businessId, namespace, displayName: trimmed });
  };
  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-sm" data-testid={`quick-config-${namespace}`}>
        <DialogHeader>
          <DialogTitle>إضافة {label}</DialogTitle>
          <DialogDescription>يُضاف لهذا النشاط فقط ويظهر فورًا في القائمة.</DialogDescription>
        </DialogHeader>
        <div>
          <Label>اسم {label}</Label>
          <Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={example} className="mt-1"
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit(); } }} data-testid={`quick-config-${namespace}-name`} />
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={add.isPending}>إلغاء</Button>
          <Button onClick={submit} disabled={add.isPending} data-testid={`quick-config-${namespace}-save`}>{add.isPending ? "جاري الحفظ..." : "حفظ"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type VariantRow = { name: string; price: string; currentStock: string };
const emptyVariant = (): VariantRow => ({ name: "", price: "", currentStock: "0" });

/**
 * منتج بسيط (اسم + سعر + مخزون افتتاحي) أو منتج بتركيبات (كل تركيبة باسم وسعر ومخزون).
 * التركيبات تُحفظ مع الأب في transaction واحدة (`products.createWithVariants`).
 */
export function QuickProductDialog({ businessId, open, onClose, onCreated }: BaseProps & {
  onCreated: (result: { productId: number; variantId?: number }) => Promise<void> | void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("0");
  const [withVariants, setWithVariants] = useState(false);
  const [variants, setVariants] = useState<VariantRow[]>([emptyVariant()]);
  const utils = trpc.useUtils();
  const reset = () => { setName(""); setPrice(""); setStock("0"); setWithVariants(false); setVariants([emptyVariant()]); };
  const refresh = async () => { await Promise.all([utils.products.list.invalidate(), utils.variants.all.invalidate()]); };

  const createSimple = trpc.products.create.useMutation({
    onSuccess: async r => {
      await refresh();
      toast.success("تمت إضافة المنتج");
      reset();
      await onCreated({ productId: r.id });
      onClose();
    },
    onError: e => toast.error(e.message),
  });
  const createVariants = trpc.products.createWithVariants.useMutation({
    onSuccess: async r => {
      await refresh();
      toast.success("تمت إضافة المنتج وتركيباته");
      reset();
      await onCreated({ productId: r.productId, variantId: r.variantIds?.[0] });
      onClose();
    },
    onError: e => toast.error(e.message),
  });
  const busy = createSimple.isPending || createVariants.isPending;

  const submit = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) return toast.error("اكتب اسم المنتج (حرفين على الأقل)");
    if (!withVariants) {
      const p = Number(price);
      const s = Number(stock || "0");
      if (!price.trim() || isNaN(p) || p < 0) return toast.error("اكتب سعر المنتج");
      if (isNaN(s) || s < 0) return toast.error("المخزون الافتتاحي رقم غير صحيح");
      createSimple.mutate({ name: trimmed, price: String(p), currentStock: Math.floor(s), businessId });
      return;
    }
    const rows = variants.map(v => ({ ...v, name: v.name.trim() })).filter(v => v.name || v.price.trim() || v.currentStock !== "0");
    if (rows.length === 0) return toast.error("أضف تركيبة واحدة على الأقل");
    const payload: { name: string; price?: number; currentStock: number }[] = [];
    for (const v of rows) {
      if (!v.name) return toast.error("كل تركيبة لازم يكون لها اسم");
      const p = v.price.trim() === "" ? undefined : Number(v.price);
      const s = Number(v.currentStock || "0");
      if ((p !== undefined && (isNaN(p) || p < 0)) || isNaN(s) || s < 0) return toast.error(`أرقام غير صحيحة في تركيبة «${v.name}»`);
      payload.push({ name: v.name, price: p, currentStock: Math.floor(s) });
    }
    createVariants.mutate({ name: trimmed, businessId, variants: payload });
  };

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto" data-testid="quick-product">
        <DialogHeader>
          <DialogTitle>إضافة منتج</DialogTitle>
          <DialogDescription>منتج واحد بسعر، أو منتج له تركيبات (نوع/لون/مقاس) لكلٍّ سعره ومخزونه. يمكنك استكماله لاحقًا من المخزن.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>اسم المنتج</Label>
            <Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="مثال: أسورة نحاس" className="mt-1" data-testid="quick-product-name" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={withVariants} onChange={e => setWithVariants(e.target.checked)} data-testid="quick-product-with-variants" />
            المنتج له تركيبات (أنواع / ألوان / مقاسات)
          </label>
          {!withVariants ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>السعر (ج.م)</Label>
                <Input type="number" min="0" value={price} onChange={e => setPrice(e.target.value)} placeholder="0" className="mt-1" dir="ltr" data-testid="quick-product-price" />
              </div>
              <div>
                <Label>المخزون الافتتاحي</Label>
                <Input type="number" min="0" value={stock} onChange={e => setStock(e.target.value)} className="mt-1" dir="ltr" data-testid="quick-product-stock" />
              </div>
            </div>
          ) : (
            <div className="space-y-2" data-testid="quick-product-variants">
              {variants.map((v, i) => (
                <div key={i} className="grid grid-cols-[1fr_80px_80px_auto] items-end gap-2">
                  <div>
                    {i === 0 && <Label className="text-xs">اسم التركيبة</Label>}
                    <Input value={v.name} onChange={e => setVariants(rows => rows.map((r, j) => j === i ? { ...r, name: e.target.value } : r))} placeholder="مثال: سادة" className="mt-1 h-9" />
                  </div>
                  <div>
                    {i === 0 && <Label className="text-xs">السعر</Label>}
                    <Input type="number" min="0" value={v.price} onChange={e => setVariants(rows => rows.map((r, j) => j === i ? { ...r, price: e.target.value } : r))} className="mt-1 h-9" dir="ltr" />
                  </div>
                  <div>
                    {i === 0 && <Label className="text-xs">المخزون</Label>}
                    <Input type="number" min="0" value={v.currentStock} onChange={e => setVariants(rows => rows.map((r, j) => j === i ? { ...r, currentStock: e.target.value } : r))} className="mt-1 h-9" dir="ltr" />
                  </div>
                  <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-destructive" disabled={variants.length === 1}
                    onClick={() => setVariants(rows => rows.filter((_, j) => j !== i))} aria-label="حذف التركيبة">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setVariants(rows => [...rows, emptyVariant()])}>
                <Plus className="h-4 w-4 ml-1" /> تركيبة أخرى
              </Button>
            </div>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>إلغاء</Button>
          <Button onClick={submit} disabled={busy} data-testid="quick-product-save">{busy ? "جاري الحفظ..." : "حفظ المنتج"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
