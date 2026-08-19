import { useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useBrandOptions } from "@/hooks/useBrandOptions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatMoney } from "@/lib/money";
import { netFromComponents } from "@shared/payrollCalc";
import {
  Kpi,
  KpiRow,
  Panel,
  TableScroll,
  toneColor,
  TABLE_CLASS,
  TABLE_HEAD_CLASS,
  type Tone,
} from "@/components/accounting/Surface";
import { Users, Pencil, Trash2, Wallet } from "lucide-react";

/**
 * مرتبات الموظفين — مين بياخد كام.
 *
 * الشاشة دي مكانتش موجودة خالص. `payroll.profileCreate` كان في السيرفر من غير أي طريق
 * ليه من الواجهة، فالمالك مكانش يقدر يقول «أحمد راتبه ٥٠٠٠» — ومن غير الرقم ده، تجهيز
 * المرتبات مالوش حاجة يحسب عليها وبيطلع فاضي. ده كان سبب إن صفحة المرتبات تبان مكسورة.
 *
 * التعديل بيعمل **إصدار جديد** مش بيغيّر القديم: `effectiveFrom` بيخلي دورة فبراير
 * تفضل محسوبة بمرتب فبراير حتى لو المرتب اتزوّد في مارس. فرفع المرتب مابيعيدش كتابة
 * التاريخ.
 */

const SALARY_TYPES = [
  ["monthly", "شهري"],
  ["daily", "باليومية"],
  ["commission", "بالعمولة"],
  ["mixed", "أساسي + عمولة"],
] as const;

const COMMISSION_TYPES = [
  ["per_order", "مبلغ ثابت لكل أوردر"],
  ["percentage", "نسبة من قيمة الأوردر"],
] as const;

const COMMISSION_BASIS = [
  ["delivered", "الأوردر اللي اتسلّم"],
  ["shipped", "الأوردر اللي اتشحن"],
  ["prepared", "الأوردر اللي اتجهّز"],
  ["confirmed", "الأوردر اللي اتأكد"],
] as const;

const label = (list: readonly (readonly [string, string])[], key: string) =>
  list.find(row => row[0] === key)?.[1] ?? key;

const todayKey = () => new Date().toISOString().slice(0, 10);

type Draft = {
  employeeId: string;
  salaryType: "monthly" | "daily" | "commission" | "mixed";
  baseSalary: string;
  dailyRate: string;
  commissionType: "per_order" | "percentage";
  commissionValue: string;
  commissionBasis: "confirmed" | "prepared" | "shipped" | "delivered";
  effectiveFrom: string;
  notes: string;
};

const emptyDraft = (): Draft => ({
  employeeId: "",
  salaryType: "monthly",
  baseSalary: "",
  dailyRate: "",
  commissionType: "per_order",
  commissionValue: "",
  commissionBasis: "delivered",
  effectiveFrom: todayKey(),
  notes: "",
});

export default function SalaryProfiles() {
  const { brands, selected, setSelected, selectedId, needsChoice, isEmpty } =
    useBrandOptions();

  return (
    <div dir="rtl" className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold">مرتبات الموظفين</h1>
        <p className="text-sm text-muted-foreground">
          مين بياخد كام. الأرقام دي هي اللي «تجهيز المرتبات» بيحسب عليها.
        </p>
      </div>

      {brands.length > 1 && (
        <div className="max-w-xs">
          <Label>النشاط</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="اختار النشاط" />
            </SelectTrigger>
            <SelectContent>
              {brands.map(brand => (
                <SelectItem key={brand.id} value={String(brand.id)}>
                  {brand.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {isEmpty && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            مفيش أنشطة متاحة لحسابك.
          </CardContent>
        </Card>
      )}

      {needsChoice && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            اختار النشاط الأول عشان تبدأ.
          </CardContent>
        </Card>
      )}

      {/*
        مساحة واحدة: دورة الشهر فوق (اللي بتفتحها كل شهر)، والمرتبات الثابتة والسُلف
        تحتها. قبل كده كانوا تلات صفحات، والتاجر لازم يتنقّل بينهم عشان يقفل شهر واحد.
      */}
      {selectedId != null && <NetSalarySummary businessId={selectedId} />}
      {selectedId != null && <PeriodWorkspace businessId={selectedId} />}
      {selectedId != null && <ProfilesSection businessId={selectedId} />}
      {selectedId != null && <AdvancesSection businessId={selectedId} />}
      {selectedId != null && <BonusesSection businessId={selectedId} />}
    </div>
  );
}

// ───────────────────────── ملخص صافي المرتب ─────────────────────────

const MONTH_NAMES = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

/**
 * ملخص بسيط لكل موظف: الأساسي + البونص − السُلف = الصافي.
 *
 * الصافي محسوب على السيرفر بدالة واحدة (`computeNetSalary`) — الشاشة مابتحسبش، بتعرض.
 * الفلتر بالشهر بيطبّق على البونص والسُلف؛ الأساسي من الملف الساري.
 */
function NetSalarySummary({ businessId }: { businessId: number }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 0 = كل الفترات
  const range = useMemo(() => {
    if (month === 0) return { from: undefined, to: undefined };
    return {
      from: new Date(year, month - 1, 1),
      to: new Date(year, month, 0, 23, 59, 59),
    };
  }, [year, month]);

  const summary = trpc.payroll.salarySummary.useQuery(
    { businessId, from: range.from, to: range.to },
    { retry: false }
  );
  const rows = summary.data ?? [];
  const totals = rows.reduce(
    (s, r) => ({
      base: s.base + r.baseSalary,
      bonuses: s.bonuses + r.totalBonuses,
      advances: s.advances + r.totalAdvances,
      net: s.net + r.netSalary,
    }),
    { base: 0, bonuses: 0, advances: 0, net: 0 }
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-5 w-5 text-emerald-700" />
            صافي المرتب = الأساسي + البونص − السُلف
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
              <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="0">كل الفترات</SelectItem>
                {MONTH_NAMES.map((name, i) => (
                  <SelectItem key={name} value={String(i + 1)}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
              <SelectTrigger className="h-9 w-24"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[now.getFullYear(), now.getFullYear() - 1].map(y => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="rounded-md border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
            مفيش مرتبات في الفترة دي. سجّل مرتب أساسي للموظف تحت الأول.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-right text-xs text-muted-foreground">
                  <th className="p-2">الموظف</th>
                  <th className="p-2">الأساسي</th>
                  <th className="p-2">البونص</th>
                  <th className="p-2">السُلف</th>
                  <th className="p-2">الصافي المستحق</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.employeeId} className="border-b last:border-0">
                    <td className="p-2 font-medium">{r.employeeName}</td>
                    <td className="p-2 tabular-nums">{formatMoney(r.baseSalary)}</td>
                    <td className="p-2 tabular-nums text-emerald-700">
                      {r.totalBonuses ? `+ ${formatMoney(r.totalBonuses)}` : "—"}
                    </td>
                    <td className="p-2 tabular-nums text-amber-700">
                      {r.totalAdvances ? `− ${formatMoney(r.totalAdvances)}` : "—"}
                    </td>
                    <td className="p-2 text-base font-bold tabular-nums">
                      {formatMoney(r.netSalary)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-bold">
                  <td className="p-2">الإجمالي ({rows.length})</td>
                  <td className="p-2 tabular-nums">{formatMoney(totals.base)}</td>
                  <td className="p-2 tabular-nums">{formatMoney(totals.bonuses)}</td>
                  <td className="p-2 tabular-nums">{formatMoney(totals.advances)}</td>
                  <td className="p-2 tabular-nums">{formatMoney(totals.net)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProfilesSection({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  // **من غير فلتر نشاط عن قصد.** `employees.businessId` عمود nullable — الموظفين
  // اللي مااتربطوش بنشاط صراحةً بيبقى NULL، والفلترة عليه كانت بتخفيهم كلهم وتسيب
  // اللي متربط بس. التاجر شاف موظف واحد في القايمة وهو عنده عشرة.
  const employees = trpc.employees.list.useQuery({ isActive: true });
  const profiles = trpc.payroll.profileListByBusiness.useQuery({ businessId });
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [open, setOpen] = useState(false);

  const [newName, setNewName] = useState("");
  const addPerson = trpc.employees.create.useMutation({
    onSuccess: async (created: any) => {
      toast.success("اتضاف");
      setNewName("");
      await utils.employees.list.invalidate();
      if (created?.id) setDraft(d => ({ ...d, employeeId: String(created.id) }));
    },
    onError: error => toast.error(error.message),
  });

  const remove = trpc.payroll.profileDelete.useMutation({
    onSuccess: async () => {
      toast.success("اتشال");
      await utils.payroll.profileListByBusiness.invalidate();
    },
    onError: error => toast.error(error.message),
  });

  const create = trpc.payroll.profileCreate.useMutation({
    onSuccess: async () => {
      toast.success("اتسجّل المرتب");
      setDraft(emptyDraft());
      setOpen(false);
      await utils.payroll.profileListByBusiness.invalidate();
    },
    onError: error => toast.error(error.message),
  });

  const rows = profiles.data ?? [];
  // `searchEmployees` بترجّع مصفوفة مباشرة، والاستعلام مفلتر على النشاط والنشطين بس.
  const active: any[] = employees.data ?? [];

  const needsBase = draft.salaryType === "monthly" || draft.salaryType === "mixed";
  const needsDaily = draft.salaryType === "daily";
  const needsCommission =
    draft.salaryType === "commission" || draft.salaryType === "mixed";

  const submit = () => {
    if (!draft.employeeId) return toast.error("اختار الموظف");
    if (!draft.effectiveFrom) return toast.error("اختار التاريخ");
    const base = Number(draft.baseSalary);
    const daily = Number(draft.dailyRate);
    const commission = Number(draft.commissionValue);
    if (needsBase && !(base > 0))
      return toast.error("اكتب الراتب الأساسي");
    if (needsDaily && !(daily > 0)) return toast.error("اكتب أجر اليوم");
    if (needsCommission && !(commission > 0))
      return toast.error("اكتب قيمة العمولة");
    if (
      needsCommission &&
      draft.commissionType === "percentage" &&
      commission > 100
    )
      return toast.error("النسبة ماتزيدش عن ١٠٠٪");

    create.mutate({
      businessId,
      employeeId: Number(draft.employeeId),
      salaryType: draft.salaryType,
      ...(needsBase ? { baseSalary: base } : {}),
      ...(needsDaily ? { dailyRate: daily } : {}),
      ...(needsCommission
        ? {
            commissionType: draft.commissionType,
            commissionValue: commission,
            commissionBasis: draft.commissionBasis,
          }
        : {}),
      effectiveFrom: new Date(`${draft.effectiveFrom}T12:00:00`),
      notes: draft.notes.trim() || undefined,
    });
  };

  const startEdit = (row: any) => {
    setDraft({
      employeeId: String(row.employeeId),
      salaryType: row.salaryType,
      baseSalary: row.baseSalary ? String(Number(row.baseSalary)) : "",
      dailyRate: row.dailyRate ? String(Number(row.dailyRate)) : "",
      commissionType: row.commissionType ?? "per_order",
      commissionValue: row.commissionValue
        ? String(Number(row.commissionValue))
        : "",
      commissionBasis: row.commissionBasis ?? "delivered",
      // النهاردة مش تاريخ الإصدار القديم: ده تغيير جديد بيسري من دلوقتي.
      effectiveFrom: todayKey(),
      notes: "",
    });
    setOpen(true);
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="h-5 w-5 text-emerald-700" />
              المرتبات الحالية
            </CardTitle>
            <Button size="sm" onClick={() => { setDraft(emptyDraft()); setOpen(true); }}>
              + موظف
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="rounded-md border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
              لسه مافيش مرتبات متسجّلة. دوس «+ موظف» وحدّد مين بياخد كام — من غير كده
              «تجهيز المرتبات» مالوش أرقام يحسب عليها.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-right text-muted-foreground">
                    <th className="py-2 font-medium">الموظف</th>
                    <th className="py-2 font-medium">نوع الراتب</th>
                    <th className="py-2 font-medium">القيمة</th>
                    <th className="py-2 font-medium">ساري من</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-2 font-medium">{row.employeeName}</td>
                      <td className="py-2">{label(SALARY_TYPES, row.salaryType)}</td>
                      <td className="py-2">
                        <SalaryValue row={row} />
                      </td>
                      <td className="py-2 text-muted-foreground">
                        {new Date(row.effectiveFrom).toLocaleDateString("ar-EG")}
                      </td>
                      <td className="py-2 text-left">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => startEdit(row)}
                        >
                          <Pencil className="ml-1 h-3.5 w-3.5" />
                          تعديل
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={remove.isPending}
                          onClick={() => {
                            if (
                              !confirm(
                                `تشيل مرتب «${row.employeeName}»؟ كشوف الرواتب المتحسبة قبل كده مابتتغيّرش.`
                              )
                            )
                              return;
                            remove.mutate({ businessId, profileId: row.id });
                          }}
                        >
                          <Trash2 className="ml-1 h-3.5 w-3.5" />
                          حذف
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/*
        نافذة فوق الشاشة مش كارت تحت الجدول.

        كانت بتترسم بعد الجدول. مع تمنتاشر موظف الجدول بقى أطول من الشاشة، فالتاجر
        بيدوس «تعديل» والنموذج بيفتح تحت خارج المنظر — وشكله إن الزرار مش شغّال.
        النافذة بتظهر في نص الشاشة مهما كان مكان السكرول.
      */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
          onClick={() => setOpen(false)}
        >
          <Card
            className="my-8 w-full max-w-2xl"
            onClick={event => event.stopPropagation()}
          >
          <CardHeader className="pb-3">
            <CardTitle className="text-base">مرتب موظف</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>الموظف *</Label>
                <Select
                  value={draft.employeeId}
                  onValueChange={value => setDraft({ ...draft, employeeId: value })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="اختار الموظف" />
                  </SelectTrigger>
                  <SelectContent>
                    {active.map((row: any) => (
                      <SelectItem key={row.id} value={String(row.id)}>
                        {row.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/*
                  الاسم مابيتكتبش هنا عن قصد: المرتب بيتربط بموظف موجود بـid، عشان
                  السُلف والعمولات وكشف الراتب كلهم يشاوروا على نفس الشخص. لو الاسم
                  اتكتب حر، كل شاشة كانت هتبقى عندها نسخة من «أحمد».
                */}
                {/*
                  الإضافة هنا عن قصد. الموظف اللي بياخد مرتب مش لازم يكون عنده حساب
                  دخول — `username` و`passwordHash` عمودين nullable، و`employees.create`
                  مش بيطلب غير الاسم. فبدل ما التاجر يسيب الشاشة ويروح لصفحة الموظفين
                  عشان يعمل حساب لواحد مش هيدخل النظام أصلاً، بيكتب الاسم هنا.
                */}
                <div className="mt-2 flex gap-2">
                  <Input
                    placeholder="أو اكتب اسم جديد..."
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key !== "Enter") return;
                      e.preventDefault();
                      if (newName.trim().length < 2) return;
                      addPerson.mutate({ name: newName.trim(), role: "viewer" });
                    }}
                  />
                  <Button
                    variant="outline"
                    disabled={addPerson.isPending || newName.trim().length < 2}
                    onClick={() =>
                      addPerson.mutate({ name: newName.trim(), role: "viewer" })
                    }
                  >
                    إضافة
                  </Button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  مش لازم يبقى ليه حساب دخول — الاسم كفاية عشان تحسبله مرتب.
                </p>
              </div>

              <div>
                <Label>نوع الراتب *</Label>
                <Select
                  value={draft.salaryType}
                  onValueChange={value =>
                    setDraft({ ...draft, salaryType: value as Draft["salaryType"] })
                  }
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SALARY_TYPES.map(([key, text]) => (
                      <SelectItem key={key} value={key}>
                        {text}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {needsBase && (
                <div>
                  <Label>الراتب الأساسي في الشهر *</Label>
                  <Input
                    className="mt-1"
                    dir="ltr"
                    inputMode="decimal"
                    value={draft.baseSalary}
                    onChange={e => setDraft({ ...draft, baseSalary: e.target.value })}
                  />
                </div>
              )}

              {needsDaily && (
                <div>
                  <Label>أجر اليوم *</Label>
                  <Input
                    className="mt-1"
                    dir="ltr"
                    inputMode="decimal"
                    value={draft.dailyRate}
                    onChange={e => setDraft({ ...draft, dailyRate: e.target.value })}
                  />
                </div>
              )}

              {needsCommission && (
                <>
                  <div>
                    <Label>العمولة *</Label>
                    <Select
                      value={draft.commissionType}
                      onValueChange={value =>
                        setDraft({
                          ...draft,
                          commissionType: value as Draft["commissionType"],
                        })
                      }
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {COMMISSION_TYPES.map(([key, text]) => (
                          <SelectItem key={key} value={key}>
                            {text}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>
                      {draft.commissionType === "percentage"
                        ? "النسبة ٪ *"
                        : "المبلغ لكل أوردر *"}
                    </Label>
                    <Input
                      className="mt-1"
                      dir="ltr"
                      inputMode="decimal"
                      value={draft.commissionValue}
                      onChange={e =>
                        setDraft({ ...draft, commissionValue: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <Label>العمولة بتتحسب على</Label>
                    <Select
                      value={draft.commissionBasis}
                      onValueChange={value =>
                        setDraft({
                          ...draft,
                          commissionBasis: value as Draft["commissionBasis"],
                        })
                      }
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {COMMISSION_BASIS.map(([key, text]) => (
                          <SelectItem key={key} value={key}>
                            {text}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </>
              )}

              <div>
                <Label>ساري من *</Label>
                <Input
                  className="mt-1"
                  type="date"
                  value={draft.effectiveFrom}
                  onChange={e =>
                    setDraft({ ...draft, effectiveFrom: e.target.value })
                  }
                />
              </div>

              <div className="sm:col-span-2">
                <Label>ملاحظات</Label>
                <Input
                  className="mt-1"
                  placeholder="اختياري"
                  value={draft.notes}
                  onChange={e => setDraft({ ...draft, notes: e.target.value })}
                />
              </div>
            </div>

            <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              التعديل بيعمل نسخة جديدة سارية من التاريخ اللي فوق — الدورات المتحسبة قبله
              مابتتغيّرش. يعني لو رفعت المرتب النهاردة، مرتب الشهر اللي فات يفضل زي ما هو.
            </p>

            <div className="flex gap-2">
              <Button className="flex-1" disabled={create.isPending} onClick={submit}>
                {create.isPending ? "جاري الحفظ..." : "حفظ"}
              </Button>
              <Button variant="outline" onClick={() => setOpen(false)}>
                إلغاء
              </Button>
            </div>
          </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function SalaryValue({ row }: { row: any }) {
  const parts: string[] = [];
  if (row.baseSalary && Number(row.baseSalary) > 0)
    parts.push(`${formatMoney(Number(row.baseSalary))} / شهر`);
  if (row.dailyRate && Number(row.dailyRate) > 0)
    parts.push(`${formatMoney(Number(row.dailyRate))} / يوم`);
  if (row.commissionValue && Number(row.commissionValue) > 0) {
    parts.push(
      row.commissionType === "percentage"
        ? `${Number(row.commissionValue)}٪ عمولة`
        : `${formatMoney(Number(row.commissionValue))} لكل أوردر`
    );
  }
  return <span>{parts.length ? parts.join(" + ") : "—"}</span>;
}

// ───────────────────────── السُلف ─────────────────────────

/**
 * السُلف اللي الموظف أخدها ولسه ماتخصمتش.
 *
 * السُلفة **فلوس خرجت من الدُرج فعلًا** — فبتنزّل حركة خزنة خارجة وقت الصرف، وبتتسجّل
 * دَيْن على الموظف في نفس الوقت. لما ييجي كشف الراتب، المبلغ ده بيتخصم من الإجمالي.
 * عشان كده هي معروضة هنا جنب المرتبات مش في شاشة لوحدها: التاجر اللي بيقرّر يدّي سُلفة
 * بيبص على مرتب الشهر الأول.
 *
 * التكلفة **مابتتحسبش مرتين**: السُلفة مصروف وقت صرفها، وسطر «السُلف» في كشف الراتب
 * عرضي بحت بيفسّر ليه الصافي أقل من الإجمالي.
 */
function AdvancesSection({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const employees = trpc.employees.list.useQuery({ isActive: true });
  const advances = trpc.payroll.advanceList.useQuery({
    status: "pending",
    page: 1,
    limit: 50,
  });

  const [employeeId, setEmployeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);

  const give = trpc.payroll.advanceCreate.useMutation({
    onSuccess: async () => {
      toast.success("اتصرفت السُلفة — والخزنة نقصت");
      setAmount("");
      setReason("");
      setEmployeeId("");
      setOpen(false);
      await Promise.all([
        utils.payroll.advanceList.invalidate(),
        utils.accounting.controlCenter.invalidate(),
        utils.accounting.treasuryHistory.invalidate(),
      ]);
    },
    onError: error => toast.error(error.message),
  });

  const rows: any[] = (advances.data as any)?.advances ?? advances.data ?? [];
  const staff: any[] = employees.data ?? [];
  const total = rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-5 w-5 text-amber-600" />
            السُلف اللي لسه ماتخصمتش
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            + سُلفة
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <p className="rounded-md border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
            مفيش سُلف مستحقة.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-right text-xs text-muted-foreground">
                  <th className="p-2">الموظف</th>
                  <th className="p-2">المبلغ</th>
                  <th className="p-2">التاريخ</th>
                  <th className="p-2">السبب</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="p-2 font-medium">{row.employeeName}</td>
                    <td className="p-2">{formatMoney(Number(row.amount))}</td>
                    <td className="p-2 text-muted-foreground">
                      {new Date(row.advanceDate).toLocaleDateString("ar-EG")}
                    </td>
                    <td className="p-2 text-muted-foreground">{row.reason ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-bold">
                  <td className="p-2">الإجمالي ({rows.length})</td>
                  <td className="p-2">{formatMoney(total)}</td>
                  <td className="p-2" colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          السُلفة بتخرج من «الخزنة الرئيسية» وقت صرفها، وبتتخصم من الراتب في كشف الشهر.
          مابتتحسبش تكلفة مرتين.
        </p>

        {open && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setOpen(false)}
          >
            <Card
              className="w-full max-w-md"
              onClick={event => event.stopPropagation()}
            >
              <CardHeader className="pb-3">
                <CardTitle className="text-base">صرف سُلفة</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label>الموظف *</Label>
                  <Select value={employeeId} onValueChange={setEmployeeId}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="اختار الموظف" />
                    </SelectTrigger>
                    <SelectContent>
                      {staff.map(row => (
                        <SelectItem key={row.id} value={String(row.id)}>
                          {row.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>المبلغ *</Label>
                  <Input
                    className="mt-1"
                    dir="ltr"
                    inputMode="decimal"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                  />
                </div>
                <div>
                  <Label>السبب</Label>
                  <Input
                    className="mt-1"
                    placeholder="اختياري"
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={give.isPending}
                    onClick={() => {
                      if (!employeeId) return toast.error("اختار الموظف");
                      const value = Number(amount);
                      if (!(value > 0))
                        return toast.error("المبلغ لازم يكون أكبر من صفر");
                      give.mutate({
                        businessId,
                        employeeId: Number(employeeId),
                        amount: value,
                        advanceDate: new Date(),
                        reason: reason.trim() || undefined,
                      });
                    }}
                  >
                    {give.isPending ? "جاري الصرف..." : "اصرف من الخزنة"}
                  </Button>
                  <Button variant="outline" onClick={() => setOpen(false)}>
                    إلغاء
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────── البونص ─────────────────────────

/**
 * بونص الموظف — بيتضاف لصافي المرتب (عكس السُلفة).
 *
 * على عكس السُلفة، البونص **مابيلمسش الخزنة** لحظة تسجيله: هو مبلغ بيتحسب ضمن صافي
 * المرتب اللي بيتدفع آخر الشهر. فمفيش حركة خزنة هنا — مجرد تسجيل. الصرف بيحصل وقت الدفع.
 */
function BonusesSection({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const employees = trpc.employees.list.useQuery({ isActive: true });
  const bonuses = trpc.payroll.bonusList.useQuery({ businessId });

  const [employeeId, setEmployeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState(false);

  const give = trpc.payroll.bonusCreate.useMutation({
    onSuccess: async () => {
      toast.success("اتسجّل البونص");
      setAmount("");
      setReason("");
      setEmployeeId("");
      setOpen(false);
      await Promise.all([
        utils.payroll.bonusList.invalidate(),
        utils.payroll.salarySummary.invalidate(),
      ]);
    },
    onError: error => toast.error(error.message),
  });
  const remove = trpc.payroll.bonusDelete.useMutation({
    onSuccess: async () => {
      toast.success("اتشال");
      await Promise.all([
        utils.payroll.bonusList.invalidate(),
        utils.payroll.salarySummary.invalidate(),
      ]);
    },
    onError: error => toast.error(error.message),
  });

  const rows: any[] = bonuses.data ?? [];
  const staff: any[] = employees.data ?? [];
  const total = rows.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="h-5 w-5 text-emerald-600" />
            البونص
          </CardTitle>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            + بونص
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <p className="rounded-md border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
            مفيش بونص متسجّل.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-right text-xs text-muted-foreground">
                  <th className="p-2">الموظف</th>
                  <th className="p-2">المبلغ</th>
                  <th className="p-2">التاريخ</th>
                  <th className="p-2">السبب</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="p-2 font-medium">{row.employeeName}</td>
                    <td className="p-2 tabular-nums">{formatMoney(Number(row.amount))}</td>
                    <td className="p-2 text-muted-foreground">
                      {new Date(row.bonusDate).toLocaleDateString("ar-EG")}
                    </td>
                    <td className="p-2 text-muted-foreground">{row.reason ?? "—"}</td>
                    <td className="p-2 text-left">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={remove.isPending}
                        onClick={() => {
                          if (!confirm(`تشيل بونص «${row.employeeName}»؟`)) return;
                          remove.mutate({ businessId, bonusId: row.id });
                        }}
                      >
                        <Trash2 className="ml-1 h-3.5 w-3.5" />
                        حذف
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 font-bold">
                  <td className="p-2">الإجمالي ({rows.length})</td>
                  <td className="p-2 tabular-nums">{formatMoney(total)}</td>
                  <td className="p-2" colSpan={3} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          البونص بيتضاف لصافي المرتب، ومابيخرجش من الخزنة إلا وقت دفع المرتب.
        </p>

        {open && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
            onClick={() => setOpen(false)}
          >
            <Card className="w-full max-w-md" onClick={event => event.stopPropagation()}>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">تسجيل بونص</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label>الموظف *</Label>
                  <Select value={employeeId} onValueChange={setEmployeeId}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="اختار الموظف" />
                    </SelectTrigger>
                    <SelectContent>
                      {staff.map(row => (
                        <SelectItem key={row.id} value={String(row.id)}>
                          {row.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>المبلغ *</Label>
                  <Input
                    className="mt-1"
                    dir="ltr"
                    inputMode="decimal"
                    value={amount}
                    onChange={e => setAmount(e.target.value)}
                  />
                </div>
                <div>
                  <Label>السبب</Label>
                  <Input
                    className="mt-1"
                    placeholder="اختياري"
                    value={reason}
                    onChange={e => setReason(e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    disabled={give.isPending}
                    onClick={() => {
                      if (!employeeId) return toast.error("اختار الموظف");
                      const value = Number(amount);
                      if (!(value > 0)) return toast.error("المبلغ لازم يكون أكبر من صفر");
                      give.mutate({
                        businessId,
                        employeeId: Number(employeeId),
                        amount: String(value),
                        bonusDate: new Date(),
                        reason: reason.trim() || undefined,
                      });
                    }}
                  >
                    {give.isPending ? "جاري الحفظ..." : "سجّل البونص"}
                  </Button>
                  <Button variant="outline" onClick={() => setOpen(false)}>
                    إلغاء
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────── دورة الشهر ─────────────────────────

const MONTHS = [
  "يناير","فبراير","مارس","أبريل","مايو","يونيو",
  "يوليو","أغسطس","سبتمبر","أكتوبر","نوفمبر","ديسمبر",
];

/**
 * دورة مرتبات الشهر — الجدول اللي التاجر بيشتغل عليه.
 *
 * **المحرّك زي ما هو.** كل زرار هنا بينادي نفس الـendpoint اللي «تجهيز المرتبات» كان
 * بيناديه: `periodCreate` · `periodRecalculate` · `itemUpdate` · `periodApprove` ·
 * `periodPay`. اللي اتغيّر إن الأربعة بقوا في مكان واحد بدل ما التاجر يتنقّل بين
 * صفحات عشان يقفل شهر.
 *
 * البونص والخصم بيتعدّلوا في الجدول على طول: دول أكتر حقلين بيتغيّروا كل شهر، وفتح
 * نافذة لكل موظف كان بيخلي قفل الشهر رحلة.
 */
/**
 * دورة المرتب — ملخص فوق، وجدول متابعة تحت.
 *
 * **السلفة بتتخصم لوحدها.** كانت بتفضل صفر في المسودة وماتظهرش غير بعد الاعتماد،
 * فالتاجر بيبص على «المستحق» ويلاقيه أكبر من اللي هيدفعه فعلًا. الجدول هنا بيقرا
 * السُلف المعلّقة للموظف ويعرضها ويخصمها في المعاينة — من غير خانة إدخال، عشان
 * مايحصلش خصم مرتين: مرة يدوي ومرة تلقائي وقت الاعتماد.
 *
 * والمعاينة بتستخدم `netFromComponents` — نفس الدالة اللي السيرفر بيحسب بيها. لو
 * الشاشة كتبت المعادلة عندها، أول تعديل في واحدة بيخلي المعروض غير المصروف.
 */
function PeriodWorkspace({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [payOpen, setPayOpen] = useState(false);

  const periods = trpc.payroll.periodList.useQuery(
    { businessIds: [businessId], year },
    { retry: false }
  );
  const period = (periods.data?.periods ?? []).find(
    (p: any) => p.year === year && p.month === month
  );
  const detail = trpc.payroll.periodGet.useQuery(
    { id: period?.id ?? 0 },
    { enabled: period?.id != null, retry: false }
  );
  const items: any[] = detail.data?.items ?? [];

  /*
    السُلف المعلّقة — اللي اتصرفت من الخزنة ولسه ماتسوّتش على مرتب.

    بتتقرا هنا عشان المسودة توري الرقم قبل الاعتماد. الاعتماد نفسه هو اللي بيكتبها
    على السطر ويعلّمها «مُسوّاة» — والكتابة دي بتستبدل مش بتزوّد، فمفيش خصم مرتين.
  */
  const pendingAdvances = trpc.payroll.advanceList.useQuery(
    { businessIds: [businessId], status: "pending", limit: 500 },
    { retry: false }
  );
  const pendingByEmployee = useMemo(() => {
    const map = new Map<number, number>();
    for (const row of (pendingAdvances.data?.advances ?? []) as any[]) {
      map.set(row.employeeId, (map.get(row.employeeId) ?? 0) + Number(row.amount ?? 0));
    }
    return map;
  }, [pendingAdvances.data]);

  const refresh = async () => {
    await Promise.all([
      utils.payroll.periodList.invalidate(),
      utils.payroll.periodGet.invalidate(),
      utils.payroll.advanceList.invalidate(),
      utils.accounting.controlCenter.invalidate(),
      utils.accounting.treasuryHistory.invalidate(),
    ]);
  };
  const onError = (error: any) => toast.error(error.message);

  const create = trpc.payroll.periodCreate.useMutation({
    onSuccess: async () => { toast.success("اتفتحت دورة الشهر"); await refresh(); },
    onError,
  });
  const recalc = trpc.payroll.periodRecalculate.useMutation({
    onSuccess: async () => { toast.success("اتحسبت من الأول"); await refresh(); },
    onError,
  });
  const updateItem = trpc.payroll.itemUpdate.useMutation({
    onSuccess: refresh,
    onError,
  });
  const approve = trpc.payroll.periodApprove.useMutation({
    onSuccess: async () => { toast.success("اتعتمدت"); setPayOpen(false); await refresh(); },
    onError,
  });
  const pay = trpc.payroll.periodPay.useMutation({
    onSuccess: async () => { toast.success("اتصرفت — والخزنة نقصت"); setPayOpen(false); await refresh(); },
    onError,
  });

  const isPaid = period?.status === "paid";
  const isDraft = period?.status === "draft";

  /** السطر بأرقامه المعروضة — السلفة الفعلية والمستحق بعدها. */
  const rows = useMemo(
    () =>
      items.map(row => {
        // بعد الاعتماد السطر نفسه بيحمل السلفة؛ قبل كده المعلّق هو المصدر.
        const stored = Number(row.advances ?? 0);
        const advances = stored > 0 ? stored : (pendingByEmployee.get(row.employeeId) ?? 0);
        const due =
          stored > 0
            ? Number(row.netSalary ?? 0)
            : netFromComponents({
                baseSalary: Number(row.baseSalary ?? 0),
                overtimeAmount: Number(row.overtimeAmount ?? 0),
                bonuses: Number(row.bonuses ?? 0),
                commissions: Number(row.commissions ?? 0),
                absenceDeduction: Number(row.absenceDeduction ?? 0),
                deductions: Number(row.deductions ?? 0),
                advances,
              });
        const paid = isPaid ? due : 0;
        return { row, advances, due, paid, remaining: due - paid };
      }),
    [items, pendingByEmployee, isPaid]
  );

  const totals = rows.reduce(
    (sum, r) => ({
      base: sum.base + Number(r.row.baseSalary ?? 0),
      advances: sum.advances + r.advances,
      bonuses: sum.bonuses + Number(r.row.bonuses ?? 0),
      deductions: sum.deductions + Number(r.row.deductions ?? 0),
      due: sum.due + r.due,
      paid: sum.paid + r.paid,
      remaining: sum.remaining + r.remaining,
    }),
    { base: 0, advances: 0, bonuses: 0, deductions: 0, due: 0, paid: 0, remaining: 0 }
  );

  const editNumber = (row: any, field: "bonuses" | "deductions", value: string) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return;
    updateItem.mutate({ id: row.id, [field]: amount } as any);
  };

  /** الصفر الهادي — الرقم اللي مالوش معنى مايشدّش العين. */
  const money = (value: number, tone?: Tone) =>
    value === 0 ? (
      <span className="text-muted-foreground/50">—</span>
    ) : (
      <span style={tone ? { color: toneColor(tone) } : undefined}>{formatMoney(value)}</span>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-bold">
          <Users className="h-5 w-5 text-[var(--success)]" />
          دورة {MONTHS[month - 1]} {year}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(month)} onValueChange={v => setMonth(Number(v))}>
            <SelectTrigger className="h-9 w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MONTHS.map((name, index) => (
                <SelectItem key={name} value={String(index + 1)}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(year)} onValueChange={v => setYear(Number(v))}>
            <SelectTrigger className="h-9 w-24"><SelectValue /></SelectTrigger>
            <SelectContent>
              {[now.getFullYear(), now.getFullYear() - 1].map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {!period ? (
        <div className="rounded-lg border bg-muted/40 p-6 text-center">
          <p className="mb-3 text-sm text-muted-foreground">
            لسه مافيش دورة للشهر ده. افتحها وهتتملى لوحدها من مرتبات الموظفين تحت.
          </p>
          <Button
            disabled={create.isPending}
            onClick={() => create.mutate({ businessId, year, month })}
          >
            افتح دورة {MONTHS[month - 1]}
          </Button>
        </div>
      ) : (
        <>
          {/*
            أربع كروت. الرقم اللي التاجر جاي عشانه هو الأخير — «المطلوب دفعه» — وهو
            الصافي بعد السلف والخصومات والبونص وأي مدفوع، مش مجموع المرتبات.
          */}
          <KpiRow>
            <Kpi
              label="إجمالي المرتبات الأساسية"
              value={formatMoney(totals.base)}
              tone="neutral"
              hint={`${rows.length} موظف`}
            />
            <Kpi
              label="إجمالي السلف"
              value={formatMoney(totals.advances)}
              tone="due"
              hint="اتصرفت من الخزنة قبل كده"
            />
            {/*
              رقمين في كارت واحد — من غير «ج.م» مرتين، عشان السطر مايتكسرش. الوحدة
              مكتوبة تحت مرة واحدة.
            */}
            <Kpi
              label="البونص والخصومات"
              value={`${totals.bonuses.toLocaleString("ar-EG")} / ${totals.deductions.toLocaleString("ar-EG")}`}
              tone="neutral"
              hint="بونص / خصم (ج.م)"
            />
            <Kpi
              label="إجمالي المطلوب دفعه للموظفين"
              value={formatMoney(totals.remaining)}
              tone={totals.remaining > 0 ? "out" : "in"}
              hint={isPaid ? "اتصرفت بالكامل" : "بعد السلف والخصومات"}
            />
          </KpiRow>

          <Panel
            title="متابعة الموظفين"
            action={
              <div className="flex flex-wrap gap-2">
                {isDraft && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={recalc.isPending}
                    onClick={() => recalc.mutate({ id: period.id })}
                  >
                    احسب من الأول
                  </Button>
                )}
                {isDraft && (
                  <Button size="sm" variant="outline" onClick={() => setPayOpen(true)}>
                    اعتماد
                  </Button>
                )}
                {period.status === "approved" && (
                  <Button size="sm" onClick={() => setPayOpen(true)}>
                    اصرف {formatMoney(totals.remaining)}
                  </Button>
                )}
                {isPaid && (
                  <span className="text-sm font-semibold" style={{ color: toneColor("in") }}>
                    اتصرفت — {formatMoney(totals.paid)}
                  </span>
                )}
              </div>
            }
          >
            <TableScroll>
              <table className={`${TABLE_CLASS} min-w-[52rem]`}>
                <thead>
                  <tr className={TABLE_HEAD_CLASS}>
                    <th>الموظف</th>
                    <th>المرتب</th>
                    <th>الأيام</th>
                    <th>السلف</th>
                    <th>البونص</th>
                    <th>الخصم</th>
                    <th>المستحق</th>
                    <th>المدفوع</th>
                    <th>المتبقي</th>
                    <th className="text-left">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ row, advances, due, paid, remaining }) => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="font-semibold">{row.employeeName}</td>
                      <td className="tabular-nums">{money(Number(row.baseSalary ?? 0))}</td>
                      <td className="tabular-nums text-muted-foreground">
                        {row.attendanceDays ?? 0}
                        {Number(row.absenceDays) > 0 && (
                          <span style={{ color: toneColor("due") }}> (غياب {row.absenceDays})</span>
                        )}
                      </td>
                      {/* السلفة عرض بس — الإدخال اليدوي هو اللي بيعمل خصم مرتين. */}
                      <td className="tabular-nums" title="بتتخصم لوحدها من السلف المسجّلة">
                        {money(advances, "due")}
                      </td>
                      <td>
                        <Input
                          className="h-8 w-20" dir="ltr" inputMode="decimal"
                          defaultValue={String(Number(row.bonuses ?? 0))}
                          disabled={!isDraft}
                          onBlur={e => editNumber(row, "bonuses", e.target.value)}
                        />
                      </td>
                      <td>
                        <Input
                          className="h-8 w-20" dir="ltr" inputMode="decimal"
                          defaultValue={String(Number(row.deductions ?? 0))}
                          disabled={!isDraft}
                          onBlur={e => editNumber(row, "deductions", e.target.value)}
                        />
                      </td>
                      <td className="font-bold tabular-nums">{money(due)}</td>
                      <td className="tabular-nums">{money(paid, "in")}</td>
                      <td className="text-base font-bold tabular-nums">
                        {money(remaining, remaining > 0 ? "out" : "in")}
                      </td>
                      <td className="text-left text-xs text-muted-foreground">
                        {isPaid ? "اتصرف" : isDraft ? "مسودة" : "معتمد"}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 font-bold">
                    <td>الإجمالي ({rows.length})</td>
                    <td className="tabular-nums">{formatMoney(totals.base)}</td>
                    <td />
                    <td className="tabular-nums" style={{ color: toneColor("due") }}>
                      {formatMoney(totals.advances)}
                    </td>
                    <td className="tabular-nums">{formatMoney(totals.bonuses)}</td>
                    <td className="tabular-nums" style={{ color: toneColor("out") }}>
                      {formatMoney(totals.deductions)}
                    </td>
                    <td className="tabular-nums">{formatMoney(totals.due)}</td>
                    <td className="tabular-nums" style={{ color: toneColor("in") }}>
                      {formatMoney(totals.paid)}
                    </td>
                    <td className="tabular-nums" style={{ color: toneColor(totals.remaining > 0 ? "out" : "in") }}>
                      {formatMoney(totals.remaining)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </TableScroll>
          </Panel>

          <PayrollActionDialog
            open={payOpen}
            mode={isDraft ? "approve" : "pay"}
            amount={totals.remaining}
            pending={approve.isPending || pay.isPending}
            onClose={() => setPayOpen(false)}
            onConfirm={evidenceUrl =>
              isDraft
                ? approve.mutate({ id: period.id, evidenceUrl })
                : pay.mutate({ id: period.id, evidenceUrl })
            }
          />
        </>
      )}
    </div>
  );
}

/**
 * الاعتماد والصرف — درج، مش خانة ثابتة فوق الصفحة.
 *
 * «دليل الصرف» كان حقل مفتوح طول الوقت في أعلى الشاشة، وهو مطلوب عند لحظة واحدة بس.
 * الصفحة الأساسية جدول متابعة؛ الفورم بيظهر لما يحصل الفعل.
 */
function PayrollActionDialog({
  open,
  mode,
  amount,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  mode: "approve" | "pay";
  amount: number;
  pending: boolean;
  onClose: () => void;
  onConfirm: (evidenceUrl: string) => void;
}) {
  const [evidence, setEvidence] = useState("");
  if (!open) return null;
  const isPay = mode === "pay";
  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="my-8 w-full max-w-md rounded-lg border bg-card p-4 shadow-lg"
        onClick={event => event.stopPropagation()}
      >
        <h3 className="mb-1 font-bold">{isPay ? "صرف المرتبات" : "اعتماد الدورة"}</h3>
        <p className="mb-4 text-sm text-muted-foreground">
          {isPay
            ? `هيخرج من الخزنة ${formatMoney(amount)} — الصافي بعد السلف، مش إجمالي المرتبات.`
            : "الاعتماد بيخصم السلف المعلّقة من كل موظف ويقفل الأرقام."}
        </p>
        <div>
          <Label className="text-xs">دليل الصرف *</Label>
          <Input
            className="mt-1"
            placeholder="رقم تحويل أو ملاحظة"
            value={evidence}
            onChange={e => setEvidence(e.target.value)}
          />
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
          <Button
            disabled={pending || !evidence.trim()}
            onClick={() => onConfirm(evidence.trim())}
          >
            {pending ? "..." : isPay ? "اصرف" : "اعتماد"}
          </Button>
        </div>
      </div>
    </div>
  );
}
