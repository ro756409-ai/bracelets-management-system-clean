import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Send, Pencil, Trash2, X, Save } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { variantLabel, type CatalogVariant } from "@/components/orders/OrderItemsEditor";
import {
  AccCard, AccSectionTitle, AccField, AccInput, AccSelect, AccButton, AccTable, accMoney, AccStatus,
} from "./ui";

const today = () => new Date().toISOString().slice(0, 10);

/** الاسم المعتمد لمورد الورشة — مُعرّف ثابت (مفيش flag «workshop» في نموذج الموردين). */
const WORKSHOP_SUPPLIER = "الورشة";

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
  /** لو موجود: بنعدّل مسودة قايمة بدل ما ننشئ جديدة. */
  const [editId, setEditId] = useState<number | null>(null);

  useEffect(() => {
    const ws = (warehouses.data ?? []).filter((w: any) => w.isActive);
    if (!warehouseId && ws.length > 0) setWarehouseId(String(ws[0].id));
  }, [warehouses.data, warehouseId]);

  // المورد بيتحدد بالاسم المعتمد «الورشة» — **مش** أول مورد نشط (عشان مايربطش الاستلام
  // بمورد تاني بالخطأ لمجرد ترتيب القايمة). لو مش موجود أو inactive بنضمنه عند الحفظ.
  const workshopSup: any = (suppliers.data ?? []).find((s: any) => s.name === WORKSHOP_SUPPLIER);
  useEffect(() => {
    if (editId == null && !supplierName) setSupplierName(WORKSHOP_SUPPLIER);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editId]);
  const effectiveSupplier = supplierName.trim() || WORKSHOP_SUPPLIER;

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

  const receiptItems: any[] = control.data?.receiptItems ?? [];

  const create = trpc.accountingV2.purchaseReceiptCreate.useMutation();
  const submit = trpc.accountingV2.purchaseReceiptSubmit.useMutation();
  const update = trpc.accountingV2.purchaseReceiptDraftUpdate.useMutation();
  const del = trpc.accountingV2.purchaseReceiptDraftDelete.useMutation();
  // لإنشاء ملف المورد «الورشة» مرة واحدة لو مفيش أي مورد — upsert بالمسار الحالي، مفيش duplicate.
  const saveSupplier = trpc.suppliers.save.useMutation();

  const reset = () => {
    setSupplierName(""); setProductId(""); setVariantId(""); setQty(""); setUnitCost(""); setNotes("");
    setEditId(null);
  };

  const save = async (thenSubmit: boolean) => {
    const q = Number(qty), u = Number(unitCost);
    if (!warehouseId) return toast.error("اختار المخزن");
    if (!productId) return toast.error("اختار الصنف");
    if (!(q > 0) || !Number.isInteger(q)) return toast.error("الكمية لازم تكون رقم صحيح أكبر من صفر");
    if (!(u > 0)) return toast.error("سعر القطعة لازم يكون أكبر من صفر");
    // نفس بنية البند للإنشاء والتعديل — الحقل اسمه items زي ما الـschema مستنيه.
    const items = [{
      productId: Number(productId),
      variantId: variantId ? Number(variantId) : undefined,
      quantity: q,
      unitCost: String(u),
    }];
    try {
      // نضمن ملف «الورشة» موجود ونشط قبل الإيصال — ينشئه لو غايب، أو يعيد تنشيطه لو inactive.
      // upsert بالاسم (مفتاح ثابت) فمفيش duplicate، وبيتعمل حتى لو فيه موردين آخرين نشطين.
      if (effectiveSupplier === WORKSHOP_SUPPLIER && (!workshopSup || !workshopSup.isActive)) {
        await saveSupplier.mutateAsync({ businessId, name: WORKSHOP_SUPPLIER, isActive: true });
      }
      if (editId != null) {
        await update.mutateAsync({
          businessId,
          receiptId: editId,
          warehouseId: Number(warehouseId),
          supplierName: effectiveSupplier,
          receiptDate: new Date(date),
          reason: notes.trim() || undefined,
          items,
        });
        toast.success("اتعدّلت المسودة");
      } else {
        const res: any = await create.mutateAsync({
          businessId,
          warehouseId: Number(warehouseId),
          receiptType: "purchase",
          supplierName: effectiveSupplier,
          receiptDate: new Date(date),
          reason: notes.trim() || undefined,
          items,
        });
        const receiptId = Number(res?.receiptId ?? res?.id);
        if (thenSubmit && receiptId) {
          await submit.mutateAsync({ businessId, receiptId });
          toast.success("اتسجّلت وأُرسلت للاعتماد");
        } else {
          toast.success("اتسجّلت كمسودة");
        }
      }
      reset();
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "خطأ");
    }
  };

  const startEdit = (r: any) => {
    const its = receiptItems.filter(it => it.receiptId === r.id);
    const first = its[0];
    setEditId(r.id);
    setWarehouseId(String(r.warehouseId ?? ""));
    setSupplierName(r.supplierName ?? "");
    setDate(new Date(r.receiptDate).toISOString().slice(0, 10));
    setNotes(r.reason ?? "");
    setProductId(first ? String(first.productId) : "");
    setVariantId(first?.variantId ? String(first.variantId) : "");
    setQty(first ? String(first.quantity) : "");
    setUnitCost(first ? String(Number(first.unitCost)) : "");
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const doDelete = (r: any) => {
    if (!confirm(`تحذف المسودة عند «${r.supplierName}»؟`)) return;
    del.mutate({ businessId, receiptId: r.id }, {
      onSuccess: async () => { toast.success("اتحذفت المسودة"); if (editId === r.id) reset(); await refresh(); },
      onError: e => toast.error(e.message),
    });
  };

  const ws: any[] = (warehouses.data ?? []).filter((w: any) => w.isActive);
  const busy = create.isPending || submit.isPending || update.isPending;

  return (
    <div className="space-y-5">
      <AccCard>
        <div className="mb-4 flex items-center justify-between">
          <AccSectionTitle className="mb-0">
            {editId != null ? "تعديل مسودة استلام" : "تسجيل استلام بضاعة"}
          </AccSectionTitle>
          {editId != null && (
            <button onClick={reset} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AccField label="المخزن" required>
            <AccSelect value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
              <option value="">— اختار —</option>
              {ws.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </AccSelect>
          </AccField>
          <AccField label="المورد">
            {/* المورد بيتحدد تلقائيًا (أول مورد نشط، أو «الورشة») — المحاسب مابيختارش. */}
            <AccInput value={effectiveSupplier} disabled />
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
          {editId != null ? (
            <AccButton onClick={() => save(false)} disabled={busy}>
              <Save className="h-4 w-4" /> {busy ? "جاري الحفظ..." : "حفظ التعديل"}
            </AccButton>
          ) : (
            <>
              <AccButton variant="ghost" onClick={() => save(false)} disabled={busy}>
                <Plus className="h-4 w-4" /> حفظ كمسودة
              </AccButton>
              <AccButton onClick={() => save(true)} disabled={busy}>
                <Send className="h-4 w-4" /> {busy ? "جاري الحفظ..." : "حفظ وإرسال للاعتماد"}
              </AccButton>
            </>
          )}
        </div>
        <p className="mt-3 text-xs text-slate-400">
          {editId != null
            ? "التعديل بيحدّث نفس المسودة — مابيعملش سجل جديد ومابيحرّكش مخزون."
            : "الاعتماد وإضافة الكمية للمخزون بيتمّوا من المالك — المحاسب بيسجّل ويرسل بس."}
        </p>
      </AccCard>

      <AccCard>
        <AccSectionTitle>الفواتير المسجّلة</AccSectionTitle>
        <AccTable head={["التاريخ", "المورد", "الإجمالي", "الحالة", "إجراء"]}
          empty={control.isLoading ? "جاري التحميل..." : "مفيش فواتير."}>
          {receipts.map((r: any) => {
            const st = STATUS[r.status] ?? { label: r.status, tone: "slate" as const };
            const isDraft = r.status === "draft";
            return (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-slate-600">
                  {r.receiptDate ? new Date(r.receiptDate).toLocaleDateString("ar-EG") : "—"}
                </td>
                <td className="px-3 py-2.5">{r.supplierName}</td>
                <td className="px-3 py-2.5 font-semibold tabular-nums">{accMoney(r.totalAmount)}</td>
                <td className="px-3 py-2.5"><AccStatus tone={st.tone}>{st.label}</AccStatus></td>
                <td className="px-3 py-2.5">
                  {isDraft ? (
                    <div className="flex gap-1">
                      <AccButton variant="ghost" className="px-2 py-1.5" onClick={() => startEdit(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </AccButton>
                      <AccButton variant="danger" className="px-2 py-1.5" disabled={del.isPending}
                        onClick={() => doDelete(r)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </AccButton>
                    </div>
                  ) : (
                    // بعد المسودة: مفيش حذف للمحاسب — الإلغاء (void) قرار المالك.
                    <span className="text-[11px] text-slate-400">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </AccTable>
      </AccCard>
    </div>
  );
}
