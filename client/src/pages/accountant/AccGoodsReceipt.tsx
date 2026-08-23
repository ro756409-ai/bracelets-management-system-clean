import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Send } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { variantLabel, type CatalogVariant } from "@/components/orders/OrderItemsEditor";
import {
  AccCard, AccSectionTitle, AccField, AccInput, AccSelect, AccButton, AccTable, accMoney, AccStatus,
} from "./ui";

const today = () => new Date().toISOString().slice(0, 10);

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "rose" | "slate" }> = {
  draft: { label: "مسودة", tone: "slate" },
  pending_approval: { label: "بانتظار الاعتماد", tone: "amber" },
  approved: { label: "دخل المخزون", tone: "green" },
  voided: { label: "ملغي", tone: "rose" },
};

/**
 * استلام البضاعة — المحاسب بينشئ مسودة ويرسلها للاعتماد فقط. الاعتماد وتحريك المخزون
 * للمالك (inventory_costing.approve). نفس workflow الاستلام الحالي، مفيش منطق مخزون مكرّر.
 */
export default function AccGoodsReceipt({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const warehouses = trpc.businesses.warehouses.useQuery({ businessId });
  const suppliers = trpc.suppliers.list.useQuery({ businessId });
  const { data: products } = trpc.products.list.useQuery({ businessIds: [businessId] });
  const { data: variants } = trpc.variants.all.useQuery({ businessIds: [businessId] });
  const control = trpc.accountingV2.inventoryControlData.useQuery({ businessId });

  const [warehouseId, setWarehouseId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [productId, setProductId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [qty, setQty] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [date, setDate] = useState(today);
  const [notes, setNotes] = useState("");

  useEffect(() => {
    const ws = (warehouses.data ?? []).filter((w: any) => w.isActive);
    if (!warehouseId && ws.length > 0) setWarehouseId(String(ws[0].id));
  }, [warehouses.data, warehouseId]);

  const variantsFor = (pid: string) =>
    ((variants ?? []) as CatalogVariant[]).filter(v => v.productId === Number(pid));

  const total = useMemo(() => {
    const q = Number(qty), u = Number(unitCost);
    return Number.isFinite(q) && Number.isFinite(u) ? q * u : 0;
  }, [qty, unitCost]);

  const receipts: any[] = useMemo(
    () => [...(control.data?.receipts ?? [])].reverse(),
    [control.data?.receipts]
  );

  const refresh = () => Promise.all([
    utils.accountingV2.inventoryControlData.invalidate(),
    utils.accountingV2.accountantSummary.invalidate(),
  ]);

  const create = trpc.accountingV2.purchaseReceiptCreate.useMutation();
  const submit = trpc.accountingV2.purchaseReceiptSubmit.useMutation();

  const reset = () => {
    setSupplierName(""); setProductId(""); setVariantId(""); setQty(""); setUnitCost(""); setNotes("");
  };

  const save = async (thenSubmit: boolean) => {
    const q = Number(qty), u = Number(unitCost);
    if (!warehouseId) return toast.error("اختار المخزن");
    if (!supplierName.trim()) return toast.error("اختار المورد");
    if (!productId) return toast.error("اختار الصنف");
    if (!(q > 0) || !Number.isInteger(q)) return toast.error("الكمية لازم تكون رقم صحيح أكبر من صفر");
    if (!(u > 0)) return toast.error("سعر القطعة لازم يكون أكبر من صفر");
    try {
      const res: any = await create.mutateAsync({
        businessId,
        warehouseId: Number(warehouseId),
        receiptType: "purchase",
        supplierName: supplierName.trim(),
        receiptDate: new Date(date),
        reason: notes.trim() || undefined,
        lines: [{
          productId: Number(productId),
          variantId: variantId ? Number(variantId) : undefined,
          quantity: q,
          unitCost: String(u),
        }],
      } as any);
      const receiptId = Number(res?.receiptId ?? res?.id);
      if (thenSubmit && receiptId) {
        await submit.mutateAsync({ businessId, receiptId });
        toast.success("اتسجّلت وأُرسلت للاعتماد");
      } else {
        toast.success("اتسجّلت كمسودة");
      }
      reset();
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "خطأ");
    }
  };

  const ws: any[] = (warehouses.data ?? []).filter((w: any) => w.isActive);
  const sups: any[] = suppliers.data ?? [];
  const busy = create.isPending || submit.isPending;

  return (
    <div className="space-y-5">
      <AccCard>
        <AccSectionTitle>تسجيل استلام بضاعة</AccSectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AccField label="المخزن" required>
            <AccSelect value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
              <option value="">— اختار —</option>
              {ws.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </AccSelect>
          </AccField>
          <AccField label="المورد" required>
            <AccSelect value={supplierName} onChange={e => setSupplierName(e.target.value)}>
              <option value="">— اختار —</option>
              {sups.map(s => <option key={s.key} value={s.name}>{s.name}</option>)}
            </AccSelect>
          </AccField>
          <AccField label="التاريخ" required>
            <AccInput type="date" value={date} onChange={e => setDate(e.target.value)} />
          </AccField>
          <AccField label="الصنف" required>
            <AccSelect value={productId} onChange={e => { setProductId(e.target.value); setVariantId(""); }}>
              <option value="">— اختار —</option>
              {(products ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </AccSelect>
          </AccField>
          <AccField label="نوع الحفر">
            <AccSelect value={variantId} onChange={e => setVariantId(e.target.value)}
              disabled={variantsFor(productId).length === 0}>
              <option value="">
                {variantsFor(productId).length ? "— اختار —" : "مفيش أنواع"}
              </option>
              {variantsFor(productId).map(v => <option key={v.id} value={v.id}>{variantLabel(v)}</option>)}
            </AccSelect>
          </AccField>
          <AccField label="الكمية" required>
            <AccInput type="number" min="1" dir="ltr" value={qty} onChange={e => setQty(e.target.value)} />
          </AccField>
          <AccField label="سعر القطعة" required>
            <AccInput type="number" min="0" step="0.01" dir="ltr" value={unitCost}
              onChange={e => setUnitCost(e.target.value)} placeholder="0.00" />
          </AccField>
          <AccField label="الإجمالي">
            <AccInput dir="ltr" disabled value={accMoney(total)} />
          </AccField>
          <AccField label="ملاحظات">
            <AccInput value={notes} onChange={e => setNotes(e.target.value)} placeholder="اختياري" />
          </AccField>
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <AccButton variant="ghost" onClick={() => save(false)} disabled={busy}>
            <Plus className="h-4 w-4" /> حفظ كمسودة
          </AccButton>
          <AccButton onClick={() => save(true)} disabled={busy}>
            <Send className="h-4 w-4" /> {busy ? "جاري الحفظ..." : "حفظ وإرسال للاعتماد"}
          </AccButton>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          الاعتماد وإضافة الكمية للمخزون بيتمّوا من المالك — المحاسب بيسجّل ويرسل بس.
        </p>
      </AccCard>

      <AccCard>
        <AccSectionTitle>الفواتير المسجّلة</AccSectionTitle>
        <AccTable head={["التاريخ", "المورد", "الإجمالي", "الحالة"]}
          empty={control.isLoading ? "جاري التحميل..." : "مفيش فواتير."}>
          {receipts.map((r: any) => {
            const st = STATUS[r.status] ?? { label: r.status, tone: "slate" as const };
            return (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-slate-600">
                  {r.receiptDate ? new Date(r.receiptDate).toLocaleDateString("ar-EG") : "—"}
                </td>
                <td className="px-3 py-2.5">{r.supplierName}</td>
                <td className="px-3 py-2.5 font-semibold tabular-nums">{accMoney(r.totalAmount)}</td>
                <td className="px-3 py-2.5"><AccStatus tone={st.tone}>{st.label}</AccStatus></td>
              </tr>
            );
          })}
        </AccTable>
      </AccCard>
    </div>
  );
}
