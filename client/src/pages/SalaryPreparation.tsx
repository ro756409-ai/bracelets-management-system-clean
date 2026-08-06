import { useEffect, useMemo, useState } from "react";
import {
  Users, Save, RefreshCw, AlertCircle, Lock, CalendarDays, Wallet, CheckCircle2,
} from "lucide-react";
import { Link } from "wouter";
import { trpc } from "@/lib/trpc";
import { useBrandOptions } from "@/hooks/useBrandOptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageHeader, SectionCard } from "@/components/shared";
import { netFromComponents, toNumber } from "@shared/payrollCalc";
import { toast } from "sonner";

/**
 * تجهيز المرتبات.
 *
 * بتحضّر سطور `payroll_items` للشهر المختار وبس. **مابتعملش أي حركة مالية** — الدفع
 * الشهري من شاشة المرتبات هو المسار الوحيد اللي بينزّل قيود محاسبية وبيظهر في مركز
 * التسجيل اليومي.
 *
 * السبب إن `payroll_periods` عليه قيد `UNIQUE(businessId, year, month)` — دورة واحدة
 * للشهر — و`payPayrollPeriodV2` بيدفع الدورة كلها بحركة واحدة ومفتاح تكرار
 * `payroll-period:{id}:paid`. يعني دفع موظف واحد لوحده مالوش مكان في المخطط، ولو
 * اتعمل بحركة مستقلة كان هيبقى مسار فلوس تاني للمرتبات — وده اللي بيخلي نفس المرتب
 * يتخصم مرتين من غير ما حد ياخد باله.
 */

const MONTHS = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

const money = (n: number) =>
  Number(n || 0).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  draft: { text: "مسودة", tone: "var(--muted-foreground)" },
  approved: { text: "معتمدة", tone: "var(--info)" },
  paid: { text: "مدفوعة", tone: "var(--success)" },
  cancelled: { text: "ملغية", tone: "var(--destructive)" },
};

/** The fields this screen may edit. Advances are deliberately absent. */
type Draft = {
  baseSalary: string;
  bonuses: string;
  commissions: string;
  deductions: string;
  notes: string;
};

export default function SalaryPreparation() {
  const { brands, selected: businessId, setSelected: setBusinessId,
          selectedId: chosenBusinessId, isEmpty: noBrands } = useBrandOptions();
  const utils = trpc.useUtils();

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [selectedItemId, setSelectedItemId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft>({
    baseSalary: "", bonuses: "", commissions: "", deductions: "", notes: "",
  });


  const periods = trpc.payroll.periodList.useQuery(
    { businessIds: chosenBusinessId != null ? [chosenBusinessId] : [], year },
    { enabled: chosenBusinessId != null, retry: false }
  );

  /** The period for the chosen month, if the payroll screen has created it. */
  const period = useMemo(
    () => (periods.data?.periods ?? []).find(p => p.year === year && p.month === month),
    [periods.data, year, month]
  );

  const detail = trpc.payroll.periodGet.useQuery(
    { id: period?.id ?? 0 },
    { enabled: period?.id != null, retry: false }
  );

  const items: any[] = detail.data?.items ?? [];
  const selected = items.find(i => i.id === selectedItemId) ?? null;

  // Load the chosen employee's stored values into the form. Keyed on the item id so
  // switching employee refills, but typing does not get overwritten by a refetch.
  useEffect(() => {
    if (!selected) return;
    setDraft({
      baseSalary: String(toNumber(selected.baseSalary)),
      bonuses: String(toNumber(selected.bonuses)),
      commissions: String(toNumber(selected.commissions)),
      deductions: String(toNumber(selected.deductions)),
      notes: selected.notes ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemId]);

  const num = (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };

  /**
   * Uses the same helper the server uses, so this number and the one the payment posts
   * cannot disagree. Overtime and absence come from the stored line — they are calculated
   * from attendance elsewhere and are not this screen's to edit.
   */
  const liveNet = useMemo(() => {
    if (!selected) return 0;
    return netFromComponents({
      baseSalary: num(draft.baseSalary),
      overtimeAmount: toNumber(selected.overtimeAmount),
      bonuses: num(draft.bonuses),
      commissions: num(draft.commissions),
      absenceDeduction: toNumber(selected.absenceDeduction),
      deductions: num(draft.deductions),
      advances: toNumber(selected.advances),
    });
  }, [selected, draft]);

  const locked = period != null && period.status !== "draft";

  const errors = useMemo(() => {
    const out: Partial<Record<keyof Draft, string>> = {};
    for (const f of ["baseSalary", "bonuses", "commissions", "deductions"] as const) {
      const raw = draft[f];
      if (raw.trim() === "") { out[f] = "الحقل مطلوب"; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n)) out[f] = "لازم يكون رقم";
      else if (n < 0) out[f] = "مايصحّش يكون بالسالب";
    }
    return out;
  }, [draft]);

  const hasErrors = Object.keys(errors).length > 0;

  const updateItem = trpc.payroll.itemUpdate.useMutation({
    onError: e => toast.error(e.message),
  });

  async function save() {
    if (!selected || updateItem.isPending || hasErrors || locked) return;
    try {
      await updateItem.mutateAsync({
        id: selected.id,
        baseSalary: num(draft.baseSalary),
        bonuses: num(draft.bonuses),
        commissions: num(draft.commissions),
        deductions: num(draft.deductions),
        notes: draft.notes.trim() || undefined,
        // Sent so the stored line matches what the accountant was shown. The server keeps
        // its own calculation authoritative; this is the same formula, not a second one.
        netSalary: liveNet,
      });
      toast.success(`✅ اتحفظ مرتب ${selected.employeeName}`);
      await utils.payroll.periodGet.invalidate({ id: period!.id });
    } catch {
      // onError already surfaced it; the typed values stay on screen.
    }
  }

  const field = (
    key: keyof Draft,
    label: string,
    opts: { negative?: boolean } = {}
  ) => (
    <div>
      <Label>{label} <span className="text-destructive">*</span></Label>
      <Input
        type="number"
        inputMode="decimal"
        min={0}
        step="0.01"
        disabled={locked}
        value={draft[key]}
        onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
        className={`mt-1 h-11 tabular-nums ${errors[key] ? "border-destructive bg-destructive/10" : ""} ${opts.negative ? "text-destructive" : ""}`}
      />
      {errors[key] && <p className="mt-1 text-xs text-destructive">{errors[key]}</p>}
    </div>
  );

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="تجهيز المرتبات"
        description="بتحضّر سطور الشهر قبل الاعتماد. مفيش أي فلوس بتتحرك من هنا."
      />

      {/* اختيار الشهر والبراند */}
      <SectionCard>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {brands.length > 1 && (
            <div>
              <Label className="text-xs">البراند</Label>
              <Select value={businessId || undefined} onValueChange={v => { setBusinessId(v); setSelectedItemId(null); }}>
                <SelectTrigger className="mt-1 !h-11 w-full"><SelectValue placeholder="اختر البراند..." /></SelectTrigger>
                <SelectContent>
                  {brands.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label className="text-xs">الشهر</Label>
            <Select value={String(month)} onValueChange={v => { setMonth(Number(v)); setSelectedItemId(null); }}>
              <SelectTrigger className="mt-1 !h-11 w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {MONTHS.map((m, i) => <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">السنة</Label>
            <Input
              type="number" min={2020} max={2100} value={year}
              onChange={e => { setYear(Number(e.target.value)); setSelectedItemId(null); }}
              className="mt-1 h-11 tabular-nums"
            />
          </div>
        </div>

        {/* حالة الدورة */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">دورة {MONTHS[month - 1]} {year}:</span>
          {periods.isLoading ? (
            <span className="text-muted-foreground">جاري التحميل...</span>
          ) : !period ? (
            <span className="font-semibold text-[var(--warning)]">لسه مااتعملتش</span>
          ) : (
            <span className="font-bold" style={{ color: STATUS_LABEL[period.status]?.tone }}>
              {STATUS_LABEL[period.status]?.text ?? period.status}
            </span>
          )}
        </div>
      </SectionCard>

      {/* الحالات اللي مافيهاش تجهيز */}
      {chosenBusinessId == null ? (
        <SectionCard>
          <p className="py-6 text-center text-sm text-muted-foreground">
            {noBrands
              ? "مفيش أنشطة متاحة لحسابك — مش هينفع تجهّز مرتبات من غير نشاط."
              : "اختر البراند الأول."}
          </p>
        </SectionCard>
      ) : !period ? (
        <SectionCard>
          <div className="py-8 text-center">
            <CalendarDays className="mx-auto mb-2 h-8 w-8 text-muted-foreground" />
            <p className="font-semibold">دورة {MONTHS[month - 1]} {year} لسه مااتعملتش</p>
            <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
              الدورة وسطورها بتتعمل من شاشة المرتبات — بتتولّد من ملفات رواتب الموظفين
              والسلف المسجّلة. الشاشة دي بتعدّل السطور بعد ما تتعمل.
            </p>
            <Link href="/payroll">
              <Button variant="outline" className="mt-3 h-11 gap-1.5">
                <Wallet className="h-4 w-4" />
                روح لشاشة المرتبات
              </Button>
            </Link>
          </div>
        </SectionCard>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[20rem_1fr]">
          {/* قائمة الموظفين */}
          <SectionCard title="الموظفين" description={`${items.length} موظف`}>
            {detail.isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map(i => <div key={i} className="h-12 animate-pulse rounded bg-muted" />)}
              </div>
            ) : items.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                مفيش سطور في الدورة دي.
              </p>
            ) : (
              <div className="max-h-[28rem] space-y-1 overflow-y-auto">
                {items.map(it => (
                  <button
                    key={it.id}
                    type="button"
                    onClick={() => setSelectedItemId(it.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-md border p-2.5 text-start transition ${
                      it.id === selectedItemId
                        ? "border-[var(--info)] bg-[var(--info)]/10"
                        : "hover:bg-muted/60"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">{it.employeeName}</span>
                      <span className="block text-xs text-muted-foreground">
                        صافي {money(toNumber(it.netSalary))}
                      </span>
                    </span>
                    {toNumber(it.advances) > 0 && (
                      <span className="shrink-0 rounded-full bg-[var(--warning)]/15 px-1.5 py-0.5 text-[10px] font-bold text-[var(--warning)]">
                        سلفة
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </SectionCard>

          {/* النموذج */}
          <SectionCard
            title={selected ? `مرتب ${selected.employeeName}` : "اختر موظف"}
            description={selected ? `${MONTHS[month - 1]} ${year}` : undefined}
          >
            {!selected ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                اختر موظف من القائمة عشان تعدّل مرتبه.
              </p>
            ) : (
              <div className="space-y-4">
                {locked && (
                  <p className="flex items-start gap-1.5 rounded-md bg-[var(--info)]/10 p-2 text-xs text-[var(--info)]">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      الدورة <strong>{STATUS_LABEL[period.status]?.text}</strong> — السطور
                      مقفولة للتعديل. ده بيمنع إن الأرقام تتغيّر بعد ما الشهر يتعتمد.
                    </span>
                  </p>
                )}

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {field("baseSalary", "الراتب الأساسي")}
                  {field("bonuses", "البونص")}
                  {field("commissions", "العمولة")}
                  {field("deductions", "الخصومات", { negative: true })}
                </div>

                {/* السلف — للعرض بس */}
                <div className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--warning)]">
                      <Lock className="h-3.5 w-3.5" />
                      السلف
                    </span>
                    <span className="text-lg font-black tabular-nums text-[var(--warning)]">
                      −{money(toNumber(selected.advances))}
                      <span className="ms-1 text-xs font-normal">ج.م</span>
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    محسوبة من سُلف الموظف المسجّلة، ومش قابلة للتعديل هنا. لو خلّيناها حقل حر
                    ممكن الرقم يختلف عن السلف الحقيقية والفرق يفضل معلّق على الموظف.
                  </p>
                </div>

                <div>
                  <Label>ملاحظات</Label>
                  <Textarea
                    rows={2}
                    disabled={locked}
                    value={draft.notes}
                    onChange={e => setDraft(d => ({ ...d, notes: e.target.value }))}
                    className="mt-1"
                    placeholder="اختياري"
                  />
                </div>

                {/* الصافي */}
                <div className="rounded-lg border-2 border-[var(--success)]/40 bg-[var(--success)]/10 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold">صافي المستحق</span>
                    <span className="text-2xl font-black tabular-nums text-[var(--success)]">
                      {money(liveNet)}
                      <span className="ms-1 text-sm font-normal">ج.م</span>
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    الأساسي {money(num(draft.baseSalary))}
                    {toNumber(selected.overtimeAmount) > 0 && ` + إضافي ${money(toNumber(selected.overtimeAmount))}`}
                    {" + بونص "}{money(num(draft.bonuses))}
                    {" + عمولة "}{money(num(draft.commissions))}
                    {toNumber(selected.absenceDeduction) > 0 && ` − غياب ${money(toNumber(selected.absenceDeduction))}`}
                    {" − خصومات "}{money(num(draft.deductions))}
                    {" − سلف "}{money(toNumber(selected.advances))}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                  <Button
                    className="h-11 gap-1.5"
                    onClick={save}
                    disabled={updateItem.isPending || hasErrors || locked}
                  >
                    {updateItem.isPending
                      ? <><RefreshCw className="h-4 w-4 animate-spin" />جاري الحفظ...</>
                      : <><Save className="h-4 w-4" />حفظ السطر</>}
                  </Button>
                  <Link href="/payroll">
                    <Button variant="outline" className="h-11 gap-1.5">
                      <CheckCircle2 className="h-4 w-4" />
                      الاعتماد والدفع
                    </Button>
                  </Link>
                </div>

                <p className="flex items-start gap-1.5 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    الشاشة دي بتجهّز الأرقام بس — <strong>مفيش أي حركة مالية بتتعمل منها</strong>.
                    الخصم من الخزنة أو البنك بيحصل مرة واحدة وقت دفع الشهر من شاشة المرتبات،
                    وساعتها بيظهر في مركز التسجيل اليومي.
                  </span>
                </p>
              </div>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}
