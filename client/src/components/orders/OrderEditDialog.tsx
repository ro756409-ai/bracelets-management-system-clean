import { useEffect, useMemo, useState } from "react";
import {
  Edit2, User, Truck, Package, ShoppingBag, AlertCircle, Save, XCircle,
  RefreshCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/shared";
import { GovernorateCitySelect } from "./GovernorateCitySelect";
import {
  OrderItemsEditor, newLineKey, linesTotal,
  type EditorLine, type CatalogProduct, type CatalogVariant,
} from "./OrderItemsEditor";

/**
 * Editing an order, for whoever is allowed to edit it.
 *
 * There used to be three of these — one inline in Orders.tsx, one in AgentWorkspace.tsx,
 * one in EmployeeDashboard.tsx — and they had drifted apart badly. The owner's copy had no
 * city field at all, read its governorate list from an empty configuration table, and
 * described the whole basket as a single text box, so an order of two engravings plus a
 * third item could not be represented on the screen that owns the data.
 *
 * This component is deliberately presentational: it owns form state, validation, dirty
 * tracking and layout, and knows nothing about tRPC, routers or permissions. Each screen
 * fetches through its own endpoints and hands the results down, which is what keeps the
 * owner's admin-session path and the employee's cookie+ownership path genuinely separate
 * on the server while looking identical to the person using them.
 */

export type OrderEditItem = {
  productId: number | null;
  productName: string;
  variantId: number | null;
  quantity: number;
  unitPrice: string | number | null;
  discount: string | number | null;
};

export type OrderEditItemsData = {
  items: OrderEditItem[];
  derivedFromHeader: boolean;
  shippingFees: string | number;
  totalAmount: string | number;
};

export type OrderEditHeader = {
  customerName: string;
  customerPhone: string;
  customerPhone2: string;
  customerAddress: string;
  governorate: string;
  city: string;
  paymentMethod: string;
  notes: string;
  employeeNotes: string;
};

export type OrderEditSavePayload = {
  orderId: number;
  header: OrderEditHeader;
  headerDirty: boolean;
  items: EditorLine[];
  itemsDirty: boolean;
  shippingFees: number;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The order being edited. `null` while nothing is open. */
  order: any | null;
  items: OrderEditItemsData | undefined;
  itemsLoading?: boolean;
  itemsError?: { message: string } | null;
  products: CatalogProduct[];
  variants: CatalogVariant[];
  /** Governorates the business curated; empty falls back to the full national list. */
  configuredGovernorates?: readonly string[];
  governoratesLoading?: boolean;
  governoratesError?: boolean;
  saving?: boolean;
  /** Resolves on success, throws on failure — the dialog stays open when it throws. */
  onSave: (payload: OrderEditSavePayload) => Promise<void>;
  /** Rendered under the form; used for the owner-only edit history panel. */
  footerSlot?: React.ReactNode;
  /** Hidden for roles with no business seeing internal notes. */
  showEmployeeNotes?: boolean;
};

/**
 * Every header field joined into one string, compared against the same string taken when
 * the dialog opened. Cheaper to maintain than a dirty flag on each of nine onChange
 * handlers — one that gets forgotten silently loses the unsaved-changes warning.
 */
function headerFingerprint(v: OrderEditHeader): string {
  return (Object.keys(v) as (keyof OrderEditHeader)[])
    .sort()
    .map(k => `${k}=${(v[k] ?? "").trim()}`)
    .join("|");
}

/** Egyptian mobile: 11 digits on one of the four live prefixes. */
export function isValidEgyptianMobile(phone: string): boolean {
  return /^01[0125]\d{8}$/.test(phone.replace(/[\s-]/g, ""));
}

const EMPTY_HEADER: OrderEditHeader = {
  customerName: "", customerPhone: "", customerPhone2: "", customerAddress: "",
  governorate: "", city: "", paymentMethod: "cod", notes: "", employeeNotes: "",
};

export function OrderEditDialog({
  open, onOpenChange, order, items, itemsLoading = false, itemsError = null,
  products, variants, configuredGovernorates, governoratesLoading = false,
  governoratesError = false, saving = false, onSave, footerSlot,
  showEmployeeNotes = true,
}: Props) {
  const [header, setHeader] = useState<OrderEditHeader>(EMPTY_HEADER);
  const [baseline, setBaseline] = useState("");
  const [lines, setLines] = useState<EditorLine[]>([]);
  const [linesDirty, setLinesDirty] = useState(false);
  const [shippingFees, setShippingFees] = useState(0);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const patch = (changes: Partial<OrderEditHeader>) =>
    setHeader(h => ({ ...h, ...changes }));

  // Reset from the order every time the dialog opens on a different one. Keyed on the id
  // rather than `open` so a re-render while open never wipes what is being typed.
  useEffect(() => {
    if (!open || !order) return;
    const next: OrderEditHeader = {
      customerName: order.customerName ?? "",
      customerPhone: order.customerPhone ?? "",
      customerPhone2: order.customerPhone2 ?? "",
      customerAddress: order.customerAddress ?? "",
      governorate: order.governorate ?? "",
      city: order.city ?? "",
      paymentMethod: order.paymentMethod ?? "cod",
      notes: order.notes ?? "",
      employeeNotes: order.employeeNotes ?? "",
    };
    setHeader(next);
    setBaseline(headerFingerprint(next));
    setLines([]);
    setLinesDirty(false);
    setShippingFees(Number(order.shippingFees ?? 0));
    setConfirmDiscard(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order?.id]);

  // Hydrate the basket once its query lands. Guarded on `linesDirty` so a slow refetch can
  // never overwrite rows the user is in the middle of typing.
  useEffect(() => {
    if (!open || !items || linesDirty) return;
    setShippingFees(Number(items.shippingFees ?? 0));
    setLines(
      items.items.map(item => {
        const quantity = Math.max(1, item.quantity ?? 1);
        // A legacy line has no unitPrice. Reconstructing it from the order total is the
        // only honest reading: it is what the customer paid per piece.
        const unitPrice =
          item.unitPrice != null
            ? Number(item.unitPrice)
            : Math.max(
                0,
                (Number(items.totalAmount ?? 0) - Number(items.shippingFees ?? 0)) / quantity
              );
        return {
          key: newLineKey(),
          productId: item.productId ?? null,
          productName: item.productName ?? "",
          variantId: item.variantId ?? null,
          quantity,
          unitPrice: Number(unitPrice.toFixed(2)),
          discount: Number(item.discount ?? 0),
        } satisfies EditorLine;
      })
    );
  }, [open, items, linesDirty]);

  const headerDirty = baseline !== "" && baseline !== headerFingerprint(header);
  const dirty = headerDirty || linesDirty;

  const issues = useMemo(() => {
    const out: string[] = [];
    if (!header.customerName.trim()) out.push("اسم العميل مطلوب");
    if (!isValidEgyptianMobile(header.customerPhone))
      out.push("رقم الهاتف غير صحيح (١١ رقم يبدأ بـ010/011/012/015)");
    if (header.customerPhone2.trim() && !isValidEgyptianMobile(header.customerPhone2))
      out.push("التليفون البديل غير صحيح");
    if (!header.governorate.trim()) out.push("المحافظة مطلوبة");
    if (header.customerAddress.trim().length < 5)
      out.push("العنوان قصير جداً (٥ أحرف على الأقل)");
    // Only judge the basket once it has arrived — while the query is in flight `lines` is
    // legitimately empty, and complaining about it flashed a false warning on every open.
    if (!itemsLoading) {
      if (lines.length === 0) out.push("لازم بند واحد على الأقل");
      if (lines.some(l => !l.productId && !l.productName.trim()))
        out.push("فيه بند من غير منتج");
      if (lines.some(l => l.discount > l.quantity * l.unitPrice))
        out.push("فيه بند خصمه أكبر من قيمته");
    }
    return out;
  }, [header, lines, itemsLoading]);

  function close() {
    setConfirmDiscard(false);
    onOpenChange(false);
  }

  function requestClose() {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    close();
  }

  async function handleSave() {
    if (!order || saving) return; // double-submit guard
    if (issues.length > 0) return;
    try {
      await onSave({
        orderId: order.id,
        header,
        headerDirty,
        items: lines,
        itemsDirty: linesDirty,
        shippingFees,
      });
      close();
    } catch {
      // The caller surfaced the message. The dialog deliberately stays open with the
      // typed values intact — a failed save must not cost the user the call they just made.
    }
  }

  return (
    <>
      {/* Three-row grid rather than one scrolling box: on a phone the old version scrolled
          the footer off the bottom, so Save sat below the fold behind the keyboard. */}
      <Dialog open={open} onOpenChange={next => { if (!next) requestClose(); }}>
        <DialogContent
          className="grid max-h-[92dvh] w-[calc(100%-1rem)] max-w-lg grid-rows-[auto_1fr_auto] gap-0 overflow-hidden p-0 sm:w-full"
          dir="rtl"
          onInteractOutside={e => { if (dirty) e.preventDefault(); }}
          onEscapeKeyDown={e => { if (dirty) { e.preventDefault(); requestClose(); } }}
        >
          <DialogHeader className="border-b px-4 py-3 text-start sm:px-6">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Edit2 className="h-5 w-5 shrink-0 text-[var(--info)]" />
              <span className="min-w-0 truncate">
                تعديل بيانات الأوردر
                {order?.orderNumber && (
                  <span className="ms-1.5 font-normal text-muted-foreground">
                    {order.orderNumber}
                  </span>
                )}
              </span>
              {dirty && (
                <span className="ms-auto shrink-0 rounded-full bg-[var(--warning)]/15 px-2 py-0.5 text-[11px] font-semibold text-[var(--warning)]">
                  غير محفوظ
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          {/* overflow-x-hidden: long product names and Arabic addresses were pushing the
              grid sideways at 320px and giving the whole dialog a horizontal scrollbar. */}
          <div className="space-y-4 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-6">
            <section className="rounded-lg border border-[var(--info)]/30 bg-[var(--info)]/10 p-3">
              <p className="mb-3 flex items-center gap-1 text-sm font-semibold text-[var(--info)]">
                <User className="h-4 w-4" />
                بيانات العميل
              </p>
              <div className="space-y-3">
                <div>
                  <Label>اسم العميل <span className="text-destructive">*</span></Label>
                  <Input
                    value={header.customerName}
                    onChange={e => patch({ customerName: e.target.value })}
                    placeholder="اسم العميل..."
                    className={`mt-1 h-10 ${!header.customerName ? "border-destructive/30 bg-destructive/10" : ""}`}
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <Label>رقم التليفون <span className="text-destructive">*</span></Label>
                    <Input
                      value={header.customerPhone}
                      onChange={e => patch({ customerPhone: e.target.value })}
                      placeholder="01xxxxxxxxx"
                      inputMode="tel"
                      dir="ltr"
                      className={`mt-1 h-10 ${!isValidEgyptianMobile(header.customerPhone) ? "border-destructive/30 bg-destructive/10" : ""}`}
                    />
                    {!isValidEgyptianMobile(header.customerPhone) && (
                      <p className="mt-1 text-xs text-destructive">١١ رقم يبدأ بـ 010 / 011 / 012 / 015</p>
                    )}
                  </div>
                  <div>
                    <Label>تليفون بديل</Label>
                    <Input
                      value={header.customerPhone2}
                      onChange={e => patch({ customerPhone2: e.target.value })}
                      placeholder="01xxxxxxxxx"
                      inputMode="tel"
                      dir="ltr"
                      className={`mt-1 h-10 ${header.customerPhone2.trim() && !isValidEgyptianMobile(header.customerPhone2) ? "border-destructive/30 bg-destructive/10" : ""}`}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-[var(--success)]/30 bg-[var(--success)]/10 p-3">
              <p className="mb-3 flex items-center gap-1 text-sm font-semibold text-[var(--success)]">
                <Truck className="h-4 w-4" />
                بيانات الشحن
              </p>
              <div className="space-y-3">
                <GovernorateCitySelect
                  governorate={header.governorate}
                  city={header.city}
                  onGovernorateChange={value =>
                    // City belongs to the old governorate; keeping it would ship a Cairo
                    // district to Aswan. Cleared only when the governorate actually moves.
                    patch(
                      value !== header.governorate
                        ? { governorate: value, city: "" }
                        : { governorate: value }
                    )
                  }
                  onCityChange={city => patch({ city })}
                  configuredGovernorates={configuredGovernorates}
                  isLoading={governoratesLoading}
                  isError={governoratesError}
                />
                <div>
                  <Label>العنوان التفصيلي <span className="text-destructive">*</span></Label>
                  <Textarea
                    value={header.customerAddress}
                    onChange={e => patch({ customerAddress: e.target.value })}
                    placeholder="الشارع، المنطقة، علامة مميزة..."
                    rows={2}
                    className={`mt-1 ${header.customerAddress.trim().length < 5 ? "border-destructive/30 bg-destructive/10" : ""}`}
                  />
                  {header.customerAddress.trim().length < 5 && (
                    <p className="mt-1 text-xs text-destructive">العنوان مطلوب (أكثر من ٥ حروف)</p>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-[var(--purple)]/30 bg-[var(--purple)]/10 p-3">
              <p className="mb-3 flex items-center gap-1 text-sm font-semibold text-[var(--purple)]">
                <Package className="h-4 w-4" />
                بنود الأوردر
              </p>
              {itemsError && (
                <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 p-2">
                  <p className="flex items-start gap-1.5 text-xs text-destructive">
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>تعذّر تحميل بنود الأوردر — {itemsError.message}. اقفل النافذة وافتحها تاني.</span>
                  </p>
                </div>
              )}
              <OrderItemsEditor
                lines={lines}
                onChange={next => { setLines(next); setLinesDirty(true); }}
                products={products}
                variants={variants}
                shippingFees={shippingFees}
                onShippingFeesChange={v => { setShippingFees(v); setLinesDirty(true); }}
                derivedFromHeader={items?.derivedFromHeader ?? false}
                isLoading={itemsLoading && lines.length === 0}
                disabled={saving}
              />
            </section>

            <section className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-3">
              <p className="mb-3 flex items-center gap-1 text-sm font-semibold text-[var(--warning)]">
                <ShoppingBag className="h-4 w-4" />
                ملخص الطلب
              </p>
              <div className="space-y-3">
                <div>
                  <Label>وسيلة الدفع</Label>
                  <Select
                    value={header.paymentMethod}
                    onValueChange={v => patch({ paymentMethod: v })}
                  >
                    <SelectTrigger className="mt-1 w-full"><SelectValue /></SelectTrigger>
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
                    value={header.notes}
                    onChange={e => patch({ notes: e.target.value })}
                    placeholder="ملاحظات من العميل..."
                    rows={2}
                    className="mt-1"
                  />
                </div>
                {showEmployeeNotes && (
                  <div>
                    <Label>ملاحظات الموظف (داخلية)</Label>
                    <Textarea
                      value={header.employeeNotes}
                      onChange={e => patch({ employeeNotes: e.target.value })}
                      placeholder="ملاحظات داخلية..."
                      rows={2}
                      className="mt-1 bg-muted/50"
                    />
                  </div>
                )}
              </div>
            </section>

            {issues.length > 0 && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-2">
                <p className="flex items-center gap-1 text-xs font-semibold text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  بيانات ناقصة — الأوردر مش هيتصدّر في شيت الشحن
                </p>
                <ul className="mt-1 list-inside list-disc text-xs text-destructive">
                  {issues.map(i => <li key={i}>{i}</li>)}
                </ul>
              </div>
            )}

            {footerSlot}
          </div>

          {/* Sticky footer. The running total lives here because on a phone the items list
              is scrolled well past by the time the user reaches Save. */}
          <DialogFooter className="flex-col gap-2 border-t bg-background px-4 py-3 sm:flex-row sm:px-6">
            <div className="flex w-full items-center justify-between text-sm sm:w-auto sm:me-auto">
              <span className="text-muted-foreground">الإجمالي</span>
              <span className="ms-3 text-base font-black tabular-nums">
                {linesTotal(lines, shippingFees).toLocaleString("ar-EG", {
                  minimumFractionDigits: 2, maximumFractionDigits: 2,
                })}
                <span className="ms-1 text-xs font-normal">ج.م</span>
              </span>
            </div>
            <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto">
              <Button variant="outline" className="h-11 gap-1.5" onClick={requestClose} disabled={saving}>
                <XCircle className="h-4 w-4" />
                إلغاء
              </Button>
              <Button
                className="h-11 gap-1.5 bg-[var(--info)] hover:bg-[var(--info)]"
                disabled={saving || issues.length > 0 || !dirty}
                onClick={handleSave}
              >
                {saving
                  ? <><RefreshCw className="h-4 w-4 animate-spin" />جاري الحفظ...</>
                  : <><Save className="h-4 w-4" />حفظ التعديلات</>}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="فيه تعديلات مش محفوظة"
        description="لو قفلت دلوقتي هتضيع التعديلات اللي عملتها على الأوردر ده."
        confirmLabel="اقفل وامسح التعديلات"
        cancelLabel="ارجع للتعديل"
        tone="destructive"
        onConfirm={close}
      />
    </>
  );
}
