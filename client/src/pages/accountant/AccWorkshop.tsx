import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, RotateCcw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  AccCard, AccSectionTitle, AccField, AccInput, AccSelect, AccButton, AccTable, accMoney,
} from "./ui";

const today = () => new Date().toISOString().slice(0, 10);

/**
 * حساب الورشة — بيعيد استخدام حساب المصانع الموجود (supplierLedger)، مفيش ledger جديد.
 * الورشة = مصنع/مورد؛ بنختاره من القايمة ونعرض التلات أرقام + دفعة + سجل + إلغاء آمن.
 */
export default function AccWorkshop({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const suppliers = trpc.suppliers.list.useQuery({ businessId });
  const [supplierKey, setSupplierKey] = useState("");

  // افتراضيًا أول مصنع (الورشة غالبًا واحدة).
  useEffect(() => {
    const rows = suppliers.data ?? [];
    if (!supplierKey && rows.length > 0) setSupplierKey(rows[0].key);
  }, [suppliers.data, supplierKey]);

  const statement = trpc.suppliers.statement.useQuery(
    { businessId, supplierKey },
    { enabled: Boolean(supplierKey) }
  );

  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");

  const refresh = () => Promise.all([
    utils.suppliers.statement.invalidate(),
    utils.suppliers.summaries.invalidate(),
    utils.accountingV2.accountantSummary.invalidate(),
  ]);

  const pay = trpc.suppliers.payment.useMutation({
    onSuccess: async () => { toast.success("اتسجّلت الدفعة"); setAmount(""); setNotes(""); await refresh(); },
    onError: e => toast.error(e.message),
  });
  const reverse = trpc.suppliers.reverseMovement.useMutation({
    onSuccess: async () => { toast.success("اتلغت الحركة (عكسية)"); await refresh(); },
    onError: e => toast.error(e.message),
  });

  const list: any[] = suppliers.data ?? [];
  const totals = statement.data?.totals;
  const rows: any[] = statement.data?.rows ?? [];
  const balance = Number(totals?.balance ?? 0);

  const submitPay = () => {
    const value = Number(amount);
    if (!supplierKey) return toast.error("اختار الورشة");
    if (!(value > 0)) return toast.error("المبلغ لازم يكون أكبر من صفر");
    pay.mutate({
      businessId, supplierKey, amount: value, paidAt: new Date(date),
      notes: notes.trim() || undefined,
    });
  };

  const doReverse = (r: any) => {
    const reason = window.prompt("سبب إلغاء الحركة؟");
    if (!reason?.trim()) return;
    reverse.mutate({ businessId, supplierKey, eventId: r.id, reason: reason.trim() });
  };

  return (
    <div className="space-y-5">
      {/* اختيار الورشة */}
      <AccCard>
        <AccField label="الورشة / المصنع">
          <AccSelect value={supplierKey} onChange={e => setSupplierKey(e.target.value)}>
            <option value="">— اختار —</option>
            {list.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
          </AccSelect>
        </AccField>
      </AccCard>

      {/* التلات أرقام */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <AccCard className="text-center">
          <p className="text-sm text-slate-500">قيمة البضاعة للورشة</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-slate-800">{accMoney(totals?.goodsReceived)}</p>
        </AccCard>
        <AccCard className="text-center">
          <p className="text-sm text-slate-500">المحوّل للورشة</p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-slate-800">{accMoney(totals?.paid)}</p>
        </AccCard>
        <AccCard className="text-center">
          <p className="text-sm text-slate-500">{balance >= 0 ? "المتبقي للورشة" : "ليك عند الورشة"}</p>
          <p className={`mt-1 text-2xl font-bold tabular-nums ${balance >= 0 ? "text-amber-600" : "text-emerald-600"}`}>
            {accMoney(Math.abs(balance))}
          </p>
        </AccCard>
      </div>

      {/* تسجيل دفعة */}
      <AccCard>
        <AccSectionTitle>تسجيل دفعة للورشة</AccSectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <AccField label="التاريخ" required>
            <AccInput type="date" value={date} onChange={e => setDate(e.target.value)} />
          </AccField>
          <AccField label="المبلغ" required>
            <AccInput type="number" min="0" step="0.01" dir="ltr" value={amount}
              onChange={e => setAmount(e.target.value)} placeholder="0.00" />
          </AccField>
          <AccField label="ملاحظة">
            <AccInput value={notes} onChange={e => setNotes(e.target.value)} placeholder="اختياري" />
          </AccField>
        </div>
        <div className="mt-4 flex justify-end">
          <AccButton onClick={submitPay} disabled={pay.isPending || !supplierKey}>
            <Plus className="h-4 w-4" /> {pay.isPending ? "جاري الحفظ..." : "تسجيل الدفعة"}
          </AccButton>
        </div>
      </AccCard>

      {/* سجل الحركات */}
      <AccCard>
        <AccSectionTitle>سجل الحركات</AccSectionTitle>
        <AccTable head={["التاريخ", "الحركة", "القيمة", "الرصيد بعدها", "إجراء"]}
          empty={statement.isLoading ? "جاري التحميل..." : "مفيش حركات."}>
          {rows.map(r => (
            <tr key={r.id} className="border-b border-slate-100 last:border-0">
              <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-slate-600">
                {new Date(r.occurredAt).toLocaleDateString("ar-EG")}
              </td>
              <td className="px-3 py-2.5">{r.label ?? r.description}</td>
              <td className="px-3 py-2.5 tabular-nums font-medium"
                style={{ color: Number(r.signedAmount) < 0 ? "#dc2626" : "#0f766e" }}>
                {accMoney(r.signedAmount)}
              </td>
              <td className="px-3 py-2.5 tabular-nums text-slate-600">{accMoney(r.balanceAfter)}</td>
              <td className="px-3 py-2.5">
                {r.type === "adjustment" ? (
                  <span className="text-[11px] text-slate-400">تسوية</span>
                ) : (
                  <AccButton variant="danger" className="px-2 py-1.5" disabled={reverse.isPending}
                    onClick={() => doReverse(r)}>
                    <RotateCcw className="h-3.5 w-3.5" /> إلغاء
                  </AccButton>
                )}
              </td>
            </tr>
          ))}
        </AccTable>
        <p className="mt-3 text-xs text-slate-400">
          الإلغاء بيتسجّل كحركة عكسية موثّقة بسبب — مفيش حذف نهائي لأي حركة مالية.
        </p>
      </AccCard>
    </div>
  );
}
