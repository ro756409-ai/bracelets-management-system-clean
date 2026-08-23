import { useState } from "react";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, X } from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  AccCard, AccSectionTitle, AccField, AccInput, AccSelect, AccButton, AccTable, accMoney, AccStatus,
} from "./ui";

const today = () => new Date().toISOString().slice(0, 10);

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "rose" | "slate" }> = {
  draft: { label: "مسودة", tone: "slate" },
  pending_approval: { label: "بانتظار الاعتماد", tone: "amber" },
  accrued: { label: "مستحق", tone: "amber" },
  partially_paid: { label: "مدفوع جزئيًا", tone: "amber" },
  paid: { label: "مدفوع", tone: "green" },
  voided: { label: "ملغي", tone: "rose" },
};

/**
 * المصاريف — إضافة مصروف بسيط + جدول + تعديل + حذف آمن (المسودة فقط؛ المُرحّل ماينحذفش).
 */
export default function AccExpenses({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const categories = trpc.accounting.expenseCategories.useQuery({ businessIds: [businessId] });
  const list = trpc.accounting.expenseList.useQuery({ businessIds: [businessId], limit: 100 });

  const [date, setDate] = useState(today);
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [payNow, setPayNow] = useState("now"); // now | later
  const [editId, setEditId] = useState<number | null>(null);

  const cats: any[] = categories.data ?? [];
  const rows: any[] = list.data?.expenses ?? [];

  const refresh = () => Promise.all([
    utils.accounting.expenseList.invalidate(),
    utils.accountingV2.accountantSummary.invalidate(),
  ]);
  const reset = () => {
    setDate(today()); setCategoryId(""); setAmount(""); setDescription(""); setPayNow("now"); setEditId(null);
  };

  const create = trpc.accountingV2.expenseRecordSimple.useMutation();
  const update = trpc.accounting.expenseUpdate.useMutation();
  const del = trpc.accounting.expenseDelete.useMutation();

  const submit = async () => {
    const value = Number(amount);
    if (!(value > 0)) return toast.error("المبلغ لازم يكون أكبر من صفر");
    if (!description.trim()) return toast.error("البيان مطلوب");
    try {
      if (editId != null) {
        await update.mutateAsync({
          id: editId,
          amount: value,
          description: description.trim(),
          expenseDate: new Date(date),
          categoryId: categoryId ? Number(categoryId) : undefined,
        });
        toast.success("اتعدّل المصروف");
      } else {
        await create.mutateAsync({
          businessId,
          amount: String(value),
          description: description.trim(),
          expenseDate: date,
          categoryId: categoryId ? Number(categoryId) : undefined,
          payNow: payNow === "now",
        });
        toast.success("اتسجّل المصروف");
      }
      reset();
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "خطأ");
    }
  };

  const startEdit = (r: any) => {
    setEditId(r.id);
    setDate(new Date(r.expenseDate).toISOString().slice(0, 10));
    setCategoryId(r.categoryId ? String(r.categoryId) : "");
    setAmount(String(Number(r.amount)));
    setDescription(r.description ?? "");
  };

  const remove = (r: any) => {
    if (!confirm(`تحذف مصروف «${r.description}»؟`)) return;
    del.mutate({ id: r.id }, {
      onSuccess: async () => { toast.success("اتحذف"); await refresh(); },
      onError: e => toast.error(e.message),
    });
  };

  const busy = create.isPending || update.isPending;

  return (
    <div className="space-y-5">
      <AccCard>
        <div className="mb-4 flex items-center justify-between">
          <AccSectionTitle className="mb-0">{editId != null ? "تعديل مصروف" : "إضافة مصروف"}</AccSectionTitle>
          {editId != null && (
            <button onClick={reset} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <AccField label="التاريخ" required>
            <AccInput type="date" value={date} onChange={e => setDate(e.target.value)} />
          </AccField>
          <AccField label="نوع المصروف">
            <AccSelect value={categoryId} onChange={e => setCategoryId(e.target.value)}>
              <option value="">— بدون —</option>
              {cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </AccSelect>
          </AccField>
          <AccField label="المبلغ" required>
            <AccInput type="number" min="0" step="0.01" dir="ltr" value={amount}
              onChange={e => setAmount(e.target.value)} placeholder="0.00" />
          </AccField>
          {editId == null && (
            <AccField label="طريقة الدفع">
              <AccSelect value={payNow} onChange={e => setPayNow(e.target.value)}>
                <option value="now">نقدًا الآن (من الخزنة)</option>
                <option value="later">آجل (مستحق)</option>
              </AccSelect>
            </AccField>
          )}
          <AccField label="البيان" required>
            <AccInput value={description} onChange={e => setDescription(e.target.value)}
              placeholder="وصف المصروف" />
          </AccField>
        </div>
        <div className="mt-4 flex justify-end">
          <AccButton onClick={submit} disabled={busy}>
            <Plus className="h-4 w-4" /> {busy ? "جاري الحفظ..." : editId != null ? "حفظ التعديل" : "إضافة"}
          </AccButton>
        </div>
      </AccCard>

      <AccCard>
        <AccSectionTitle>سجل المصاريف</AccSectionTitle>
        <AccTable head={["التاريخ", "النوع", "المبلغ", "البيان", "الحالة", "بواسطة", "إجراء"]}
          empty={list.isLoading ? "جاري التحميل..." : "مفيش مصاريف."}>
          {rows.map(r => {
            const st = STATUS[r.status] ?? { label: r.status, tone: "slate" as const };
            const deletable = r.status === "draft";
            return (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-slate-600">
                  {new Date(r.expenseDate).toLocaleDateString("ar-EG")}
                </td>
                <td className="px-3 py-2.5 text-slate-600">{r.categoryName ?? "—"}</td>
                <td className="px-3 py-2.5 font-semibold tabular-nums">{accMoney(r.amount)}</td>
                <td className="px-3 py-2.5">{r.description}</td>
                <td className="px-3 py-2.5"><AccStatus tone={st.tone}>{st.label}</AccStatus></td>
                <td className="px-3 py-2.5 text-slate-500">{r.createdByName ?? "—"}</td>
                <td className="px-3 py-2.5">
                  {r.status === "voided" ? <span className="text-[11px] text-slate-400">—</span> : (
                    <div className="flex gap-1">
                      <AccButton variant="ghost" className="px-2 py-1.5" onClick={() => startEdit(r)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </AccButton>
                      {deletable && (
                        <AccButton variant="danger" className="px-2 py-1.5" disabled={del.isPending}
                          onClick={() => remove(r)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </AccButton>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </AccTable>
        <p className="mt-3 text-xs text-slate-400">
          الحذف متاح للمسودة فقط — المصروف المُرحّل للحسابات مايتحذفش (يتعدّل أو يُلغى من المالك) حفاظًا على الأثر.
        </p>
      </AccCard>
    </div>
  );
}
