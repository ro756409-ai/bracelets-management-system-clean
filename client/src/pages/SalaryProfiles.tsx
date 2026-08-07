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
import { Users, Pencil } from "lucide-react";

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
    </div>
  );
}

function ProfilesSection({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const employees = trpc.employees.list.useQuery({ businessId, isActive: true });
  const profiles = trpc.payroll.profileListByBusiness.useQuery({ businessId });
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [open, setOpen] = useState(false);

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
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {open && (
        <Card>
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
