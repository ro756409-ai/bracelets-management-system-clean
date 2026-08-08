import { useState } from "react";
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

      {selectedId != null && <ProfilesSection businessId={selectedId} />}
      {selectedId != null && <AdvancesSection businessId={selectedId} />}
    </div>
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
