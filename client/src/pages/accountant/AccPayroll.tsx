import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, X, UserPlus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  AccCard, AccSectionTitle, AccField, AccInput, AccSelect, AccButton, AccTable, accMoney,
} from "./ui";

const MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

/**
 * المرتبات — عرض مبسّط: الموظف/الوظيفة/الأساسي/السلف/البونص/الصافي + إضافة سلفة أو بونص.
 * محافظ: المحاسب يشوف ويسجّل السلف/البونص فقط. تعديل سطر المرتب وإلغاء الدورة للمالك.
 */
export default function AccPayroll({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);

  const range = useMemo(() => ({
    from: new Date(year, month - 1, 1),
    to: new Date(year, month, 0, 23, 59, 59),
  }), [year, month]);

  const summary = trpc.payroll.salarySummary.useQuery({ businessId, from: range.from, to: range.to }, { retry: false });
  const employees = trpc.employees.list.useQuery({ isActive: true });

  const roleByEmp = useMemo(() => {
    const m = new Map<number, string>();
    (employees.data ?? []).forEach((e: any) => m.set(e.id, e.jobTitle || e.role || ""));
    return m;
  }, [employees.data]);

  const rows: any[] = summary.data ?? [];
  const totals = rows.reduce((s, r) => ({
    base: s.base + Number(r.baseSalary || 0),
    adv: s.adv + Number(r.totalAdvances || 0),
    bonus: s.bonus + Number(r.totalBonuses || 0),
    net: s.net + Number(r.netSalary || 0),
  }), { base: 0, adv: 0, bonus: 0, net: 0 });

  // فورم إضافة سلفة/بونص/موظف
  const [kind, setKind] = useState<"" | "advance" | "bonus" | "employee">("");
  const [employeeId, setEmployeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  // فورم موظف جديد
  const [empName, setEmpName] = useState("");
  const [empJob, setEmpJob] = useState("");
  const [empBase, setEmpBase] = useState("");
  const [empPhone, setEmpPhone] = useState("");
  const [empStart, setEmpStart] = useState(() => new Date().toISOString().slice(0, 10));

  const refresh = () => Promise.all([
    utils.payroll.salarySummary.invalidate(),
    utils.employees.list.invalidate(),
    utils.accountingV2.accountantSummary.invalidate(),
  ]);
  const closeForm = () => {
    setKind(""); setEmployeeId(""); setAmount(""); setReason("");
    setEmpName(""); setEmpJob(""); setEmpBase(""); setEmpPhone(""); setEmpStart(new Date().toISOString().slice(0, 10));
  };

  const advance = trpc.payroll.advanceCreate.useMutation();
  const bonus = trpc.payroll.bonusCreate.useMutation();
  const addEmployee = trpc.payroll.payrollEmployeeCreate.useMutation();

  const submitEmployee = async () => {
    const base = Number(empBase);
    if (empName.trim().length < 2) return toast.error("اسم الموظف مطلوب");
    if (!(base >= 0)) return toast.error("المرتب الأساسي لازم يكون رقم صحيح");
    try {
      await addEmployee.mutateAsync({
        businessId,
        name: empName.trim(),
        jobTitle: empJob.trim() || undefined,
        baseSalary: base,
        phone: empPhone.trim() || undefined,
        startDate: new Date(empStart),
      });
      toast.success("اتضاف الموظف");
      closeForm();
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "خطأ");
    }
  };

  const submit = async () => {
    const value = Number(amount);
    if (!employeeId) return toast.error("اختار الموظف");
    if (!(value > 0)) return toast.error("المبلغ لازم يكون أكبر من صفر");
    try {
      if (kind === "advance") {
        await advance.mutateAsync({
          businessId, employeeId: Number(employeeId), amount: value,
          advanceDate: new Date(), reason: reason.trim() || undefined,
        });
      } else {
        await bonus.mutateAsync({
          businessId, employeeId: Number(employeeId), amount: String(value),
          bonusDate: new Date(), reason: reason.trim() || undefined,
        });
      }
      toast.success(kind === "advance" ? "اتسجّلت السلفة" : "اتسجّل البونص");
      closeForm();
      await refresh();
    } catch (e: any) {
      toast.error(e?.message ?? "خطأ");
    }
  };

  const staff: any[] = employees.data ?? [];
  const busy = advance.isPending || bonus.isPending;
  const empBusy = addEmployee.isPending;

  return (
    <div className="space-y-5">
      <AccCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <AccSectionTitle className="mb-0">مرتبات الشهر</AccSectionTitle>
          <div className="flex flex-wrap gap-2">
            <AccSelect value={String(month)} onChange={e => setMonth(Number(e.target.value))} className="w-32">
              {MONTHS.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
            </AccSelect>
            <AccSelect value={String(year)} onChange={e => setYear(Number(e.target.value))} className="w-24">
              {[now.getFullYear(), now.getFullYear() - 1].map(y => <option key={y} value={y}>{y}</option>)}
            </AccSelect>
            <AccButton onClick={() => setKind("employee")}><UserPlus className="h-4 w-4" /> إضافة موظف</AccButton>
            <AccButton variant="ghost" onClick={() => setKind("advance")}><Plus className="h-4 w-4" /> سلفة</AccButton>
            <AccButton variant="ghost" onClick={() => setKind("bonus")}><Plus className="h-4 w-4" /> بونص</AccButton>
          </div>
        </div>

        {(kind === "advance" || kind === "bonus") && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-semibold text-slate-700">
                {kind === "advance" ? "تسجيل سلفة" : "تسجيل بونص"}
              </span>
              <button onClick={closeForm} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <AccField label="الموظف" required>
                <AccSelect value={employeeId} onChange={e => setEmployeeId(e.target.value)}>
                  <option value="">— اختار —</option>
                  {staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </AccSelect>
              </AccField>
              <AccField label="المبلغ" required>
                <AccInput type="number" min="0" step="0.01" dir="ltr" value={amount}
                  onChange={e => setAmount(e.target.value)} placeholder="0.00" />
              </AccField>
              <AccField label="السبب">
                <AccInput value={reason} onChange={e => setReason(e.target.value)} placeholder="اختياري" />
              </AccField>
            </div>
            <div className="mt-3 flex justify-end">
              <AccButton onClick={submit} disabled={busy}>{busy ? "جاري الحفظ..." : "حفظ"}</AccButton>
            </div>
          </div>
        )}

        {kind === "employee" && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="font-semibold text-slate-700">إضافة موظف</span>
              <button onClick={closeForm} className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <AccField label="الاسم" required>
                <AccInput value={empName} onChange={e => setEmpName(e.target.value)} placeholder="اسم الموظف" />
              </AccField>
              <AccField label="الوظيفة">
                <AccInput value={empJob} onChange={e => setEmpJob(e.target.value)} placeholder="مثال: عامل ورشة" />
              </AccField>
              <AccField label="المرتب الأساسي" required>
                <AccInput type="number" min="0" step="0.01" dir="ltr" value={empBase}
                  onChange={e => setEmpBase(e.target.value)} placeholder="0.00" />
              </AccField>
              <AccField label="الهاتف">
                <AccInput dir="ltr" value={empPhone} onChange={e => setEmpPhone(e.target.value)} placeholder="اختياري" />
              </AccField>
              <AccField label="تاريخ البداية" required>
                <AccInput type="date" value={empStart} onChange={e => setEmpStart(e.target.value)} />
              </AccField>
            </div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <span className="text-xs text-slate-400">موظف رواتب فقط — بدون صلاحية دخول؛ المالك يكمّلها لو حب.</span>
              <AccButton onClick={submitEmployee} disabled={empBusy}>{empBusy ? "جاري الحفظ..." : "إضافة الموظف"}</AccButton>
            </div>
          </div>
        )}
      </AccCard>

      <AccCard>
        <AccTable head={["الموظف", "الوظيفة", "الأساسي", "السلف", "البونص", "الصافي"]}
          empty={summary.isLoading ? "جاري التحميل..." : "مفيش مرتبات في الشهر ده."}>
          {rows.map(r => (
            <tr key={r.employeeId} className="border-b border-slate-100 last:border-0">
              <td className="px-3 py-2.5 font-medium text-slate-800">{r.employeeName}</td>
              <td className="px-3 py-2.5 text-slate-500">{roleByEmp.get(r.employeeId) || "—"}</td>
              <td className="px-3 py-2.5 tabular-nums">{accMoney(r.baseSalary)}</td>
              <td className="px-3 py-2.5 tabular-nums text-amber-600">
                {Number(r.totalAdvances) ? `− ${accMoney(r.totalAdvances)}` : "—"}
              </td>
              <td className="px-3 py-2.5 tabular-nums text-emerald-600">
                {Number(r.totalBonuses) ? `+ ${accMoney(r.totalBonuses)}` : "—"}
              </td>
              <td className="px-3 py-2.5 font-bold tabular-nums">{accMoney(r.netSalary)}</td>
            </tr>
          ))}
          {rows.length > 0 && (
            <tr className="border-t-2 border-slate-200 font-bold">
              <td className="px-3 py-2.5" colSpan={2}>الإجمالي ({rows.length})</td>
              <td className="px-3 py-2.5 tabular-nums">{accMoney(totals.base)}</td>
              <td className="px-3 py-2.5 tabular-nums">{accMoney(totals.adv)}</td>
              <td className="px-3 py-2.5 tabular-nums">{accMoney(totals.bonus)}</td>
              <td className="px-3 py-2.5 tabular-nums">{accMoney(totals.net)}</td>
            </tr>
          )}
        </AccTable>
        <p className="mt-3 text-xs text-slate-400">
          صافي المرتب = الأساسي + البونص − السلف. تعديل سطر المرتب أو إلغاء الدورة قرار إداري للمالك.
        </p>
      </AccCard>
    </div>
  );
}
