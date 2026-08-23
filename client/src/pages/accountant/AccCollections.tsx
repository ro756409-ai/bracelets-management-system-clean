import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Ban, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  AccCard, AccSectionTitle, AccField, AccInput, AccTextarea, AccSelect,
  AccButton, AccTable, accMoney, AccStatus,
} from "./ui";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * التحصيلات — تسجيل تحصيل شركة الشحن + جدول + إلغاء آمن (حركة عكسية، مش حذف).
 * التعديل = إلغاء آمن للأصل + تسجيل سجل جديد (بيحافظ على الأثر).
 */
export default function AccCollections({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const config = trpc.accountingV2.shippingConfiguration.useQuery({ businessId });
  const list = trpc.accountingV2.dailySettlementList.useQuery({ businessId, limit: 100 });

  const carriers: any[] = (config.data?.providers ?? []).filter((p: any) => p.isActive);

  const [carrierId, setCarrierId] = useState("");
  const [date, setDate] = useState(today);
  const [ordersCount, setOrdersCount] = useState("");
  const [gross, setGross] = useState("");
  const [charges, setCharges] = useState("0");
  const [notes, setNotes] = useState("");
  /** لو موجود: التعديل بيلغي السجل ده أول ما السجل الجديد يتسجّل. */
  const [replacingId, setReplacingId] = useState<number | null>(null);

  const net = useMemo(() => {
    const g = Number(gross), c = Number(charges);
    if (!Number.isFinite(g) || !Number.isFinite(c)) return null;
    return g - c;
  }, [gross, charges]);

  const reset = () => {
    setCarrierId(""); setDate(today()); setOrdersCount(""); setGross(""); setCharges("0");
    setNotes(""); setReplacingId(null);
  };
  const refresh = () => Promise.all([
    utils.accountingV2.dailySettlementList.invalidate(),
    utils.accountingV2.accountantSummary.invalidate(),
  ]);

  const record = trpc.accountingV2.dailySettlementRecord.useMutation();
  const voidM = trpc.accountingV2.dailySettlementVoid.useMutation();

  const rows: any[] = list.data ?? [];

  const submit = async () => {
    const g = Number(gross), c = Number(charges), oc = Number(ordersCount);
    const effectiveCarrier = carriers.length === 1 ? String(carriers[0].id) : carrierId;
    if (!effectiveCarrier) return toast.error("اختار شركة الشحن");
    if (!(g > 0)) return toast.error("إجمالي التحصيل لازم يكون أكبر من صفر");
    if (c < 0) return toast.error("رسوم الشحن ما تكونش بالسالب");
    if (c > g) return toast.error("رسوم الشحن أكبر من الإجمالي");
    if (!Number.isInteger(oc) || oc < 1) return toast.error("عدد الأوردرات لازم يكون واحد على الأقل");
    try {
      if (replacingId != null) {
        await voidM.mutateAsync({ businessId, settlementId: replacingId, reason: "تعديل — استبدال بسجل جديد" });
      }
      await record.mutateAsync({
        businessId,
        businessShippingProviderId: Number(effectiveCarrier),
        statementDate: new Date(date),
        ordersCount: oc,
        grossCollected: String(g),
        totalCharges: String(c),
        notes: notes.trim() || undefined,
      });
      toast.success(replacingId != null ? "اتعدّل (إلغاء + تسجيل جديد)" : "اتسجّل التحصيل");
      reset();
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "خطأ");
      await refresh();
    }
  };

  const startEdit = (r: any) => {
    setReplacingId(r.id);
    setCarrierId(String(carriers.find(c => c.displayName === r.carrierName)?.id ?? ""));
    setDate(new Date(r.statementDate).toISOString().slice(0, 10));
    setOrdersCount(r.ordersCount ? String(r.ordersCount) : "");
    setGross(String(Number(r.grossCollected)));
    setCharges(String(Number(r.totalCharges)));
    setNotes(r.notes ?? "");
  };

  const doVoid = (r: any) => {
    const reason = window.prompt("سبب الإلغاء؟");
    if (!reason?.trim()) return;
    voidM.mutate(
      { businessId, settlementId: r.id, reason: reason.trim() },
      { onSuccess: async () => { toast.success("اتلغى (حركة عكسية)"); await refresh(); }, onError: e => toast.error(e.message) }
    );
  };

  const busy = record.isPending || voidM.isPending;

  return (
    <div className="space-y-5">
      <AccCard>
        <AccSectionTitle>{replacingId != null ? "تعديل تحصيل" : "تسجيل تحصيل"}</AccSectionTitle>
        {carriers.length === 0 ? (
          <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">
            مفيش شركة شحن متسجّلة. تضاف من إعدادات الشحن.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <AccField label="التاريخ" required>
                <AccInput type="date" value={date} onChange={e => setDate(e.target.value)} />
              </AccField>
              <AccField label="شركة الشحن" required>
                {carriers.length === 1 ? (
                  <AccInput value={carriers[0].displayName} disabled />
                ) : (
                  <AccSelect value={carrierId} onChange={e => setCarrierId(e.target.value)}>
                    <option value="">— اختار —</option>
                    {carriers.map(c => <option key={c.id} value={c.id}>{c.displayName}</option>)}
                  </AccSelect>
                )}
              </AccField>
              <AccField label="عدد الأوردرات" required>
                <AccInput type="number" min="1" dir="ltr" value={ordersCount}
                  onChange={e => setOrdersCount(e.target.value)} />
              </AccField>
              <AccField label="إجمالي التحصيل" required>
                <AccInput type="number" min="0" step="0.01" dir="ltr" value={gross}
                  onChange={e => setGross(e.target.value)} placeholder="0.00" />
              </AccField>
              <AccField label="رسوم / خصومات الشحن">
                <AccInput type="number" min="0" step="0.01" dir="ltr" value={charges}
                  onChange={e => setCharges(e.target.value)} />
              </AccField>
              <AccField label="الصافي (بيدخل الخزنة)">
                <AccInput dir="ltr" disabled value={net == null ? "" : accMoney(net)} />
              </AccField>
              <AccField label="ملاحظات">
                <AccInput value={notes} onChange={e => setNotes(e.target.value)} placeholder="اختياري" />
              </AccField>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              {replacingId != null && (
                <AccButton variant="ghost" onClick={reset}><X className="h-4 w-4" /> إلغاء</AccButton>
              )}
              <AccButton onClick={submit} disabled={busy}>
                <Plus className="h-4 w-4" /> {busy ? "جاري الحفظ..." : replacingId != null ? "حفظ التعديل" : "تسجيل"}
              </AccButton>
            </div>
          </>
        )}
      </AccCard>

      <AccCard>
        <AccSectionTitle>سجل التحصيلات</AccSectionTitle>
        <AccTable head={["التاريخ", "الشركة", "الأوردرات", "الإجمالي", "الرسوم", "الصافي", "الحالة", "إجراء"]}
          empty={list.isLoading ? "جاري التحميل..." : "مفيش تحصيلات."}>
          {rows.map(r => {
            const voided = r.status === "voided";
            return (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-slate-600">
                  {new Date(r.statementDate).toLocaleDateString("ar-EG")}
                </td>
                <td className="px-3 py-2.5">{r.carrierName ?? "—"}</td>
                <td className="px-3 py-2.5 tabular-nums">{r.ordersCount ?? "—"}</td>
                <td className="px-3 py-2.5 tabular-nums">{accMoney(r.grossCollected)}</td>
                <td className="px-3 py-2.5 tabular-nums text-slate-500">{accMoney(r.totalCharges)}</td>
                <td className="px-3 py-2.5 font-semibold tabular-nums">{accMoney(r.netTransferred)}</td>
                <td className="px-3 py-2.5">
                  {voided ? <AccStatus tone="rose">ملغي</AccStatus> : <AccStatus tone="green">مُسجّل</AccStatus>}
                </td>
                <td className="px-3 py-2.5">
                  {voided ? <span className="text-[11px] text-slate-400">—</span> : (
                    <div className="flex gap-1">
                      <AccButton variant="ghost" className="px-2 py-1.5" onClick={() => startEdit(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </AccButton>
                      <AccButton variant="danger" className="px-2 py-1.5" disabled={busy} onClick={() => doVoid(r)}>
                        <Ban className="h-3.5 w-3.5" />
                      </AccButton>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </AccTable>
        <p className="mt-3 text-xs text-slate-400">
          الإلغاء بيتسجّل كحركة عكسية بترجّع الفلوس من الخزنة — الأصل بيفضل في السجل، مفيش حذف نهائي.
        </p>
      </AccCard>
    </div>
  );
}
