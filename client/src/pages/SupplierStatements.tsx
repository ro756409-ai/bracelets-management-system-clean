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
import {
  describeBalance,
  MOVEMENT_LABELS,
  quickRange,
  type SupplierMovementType,
} from "@shared/supplierLedger";
import { Factory, ArrowRight, Link2 } from "lucide-react";

/**
 * كشف حساب الموردين.
 *
 * الأرقام كلها مشتقّة من نفس الأحداث اللي المخزون والخزنة بيتحركوا بيها — مفيش رصيد
 * متخزّن في أي مكان. الشاشة دي عرض، والحساب في `shared/supplierLedger.ts`.
 *
 * اللغة قرار مش تفصيلة: التاجر بيقرا «عليك للمصنع ٣٥٬٠٠٠» مش «رصيد دائن ٣٥٬٠٠٠». الرقم
 * لوحده ملبّس — بيحتمل إنه ليه أو عليه — والجملة بتقفل الاحتمال.
 */

const today = () => new Date().toISOString().slice(0, 10);

const QUICK: { key: Parameters<typeof quickRange>[0]; label: string }[] = [
  { key: "today", label: "اليوم" },
  { key: "week", label: "هذا الأسبوع" },
  { key: "month", label: "هذا الشهر" },
  { key: "last_month", label: "الشهر الماضي" },
  { key: "all", label: "الكل" },
];

export default function SupplierStatements() {
  const { brands, selected, setSelected, selectedId, needsChoice, isEmpty } =
    useBrandOptions();
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div dir="rtl" className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold">كشف حساب الموردين</h1>
        <p className="text-sm text-muted-foreground">
          كل مصنع وحسابه الجاري — البضاعة اللي استلمتها، اللي دفعته، والباقي.
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

      {selectedId != null &&
        (openKey ? (
          <SupplierStatement
            businessId={selectedId}
            supplierKey={openKey}
            onBack={() => setOpenKey(null)}
          />
        ) : (
          <>
            <SupplierList businessId={selectedId} onOpen={setOpenKey} />
            <HistoricalNames businessId={selectedId} />
          </>
        ))}
    </div>
  );
}

// ───────────────────────── قايمة المصانع ─────────────────────────

function SupplierList({
  businessId,
  onOpen,
}: {
  businessId: number;
  onOpen: (key: string) => void;
}) {
  const utils = trpc.useUtils();
  const summaries = trpc.suppliers.summaries.useQuery({ businessId });
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [returnMode, setReturnMode] = useState<"credit" | "rework">("credit");

  const save = trpc.suppliers.save.useMutation({
    onSuccess: async () => {
      toast.success("اتضاف المصنع");
      setName("");
      setPhone("");
      await utils.suppliers.summaries.invalidate();
    },
    onError: error => toast.error(error.message),
  });

  const rows = summaries.data ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Factory className="h-5 w-5 text-orange-600" />
            المصانع
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="rounded-md border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
              مفيش مصانع لسه. ضيف مصنع تحت وابدأ تسجّل عليه.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[54rem] text-sm">
                <thead>
                  <tr className="border-b text-right text-xs text-muted-foreground">
                    <th className="p-2">اسم المصنع</th>
                    <th className="p-2">إجمالي البضاعة</th>
                    <th className="p-2">إجمالي المدفوع</th>
                    <th className="p-2">المرتجعات</th>
                    <th className="p-2">إعادة التشطيب</th>
                    <th className="p-2">الرصيد الحالي</th>
                    <th className="p-2">آخر حركة</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => {
                    const state = describeBalance(row.balance);
                    return (
                      <tr key={row.key} className="border-b last:border-0">
                        <td className="p-2 font-medium">{row.name}</td>
                        <td className="p-2 tabular-nums">
                          {formatMoney(row.goodsReceived)}
                        </td>
                        <td className="p-2 tabular-nums">{formatMoney(row.paid)}</td>
                        <td className="p-2 tabular-nums">
                          {formatMoney(row.returns)}
                        </td>
                        <td className="p-2 tabular-nums">
                          {formatMoney(row.reworkFees)}
                        </td>
                        <td
                          className="p-2 font-semibold"
                          style={{
                            color:
                              state.tone === "owed"
                                ? "var(--destructive)"
                                : state.tone === "credit"
                                  ? "var(--success)"
                                  : "var(--muted-foreground)",
                          }}
                        >
                          {state.text}
                        </td>
                        <td className="p-2 whitespace-nowrap text-muted-foreground">
                          {row.lastMovementAt
                            ? new Date(row.lastMovementAt).toLocaleDateString("ar-EG")
                            : "—"}
                        </td>
                        <td className="p-2 text-left">
                          <Button size="sm" variant="ghost" onClick={() => onOpen(row.key)}>
                            الكشف
                            <ArrowRight className="mr-1 h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">إضافة مصنع</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-4">
            <div className="sm:col-span-2">
              <Label>اسم المصنع *</Label>
              <Input
                className="mt-1"
                placeholder="مصنع النحاس"
                value={name}
                onChange={e => setName(e.target.value)}
              />
            </div>
            <div>
              <Label>التليفون</Label>
              <Input
                className="mt-1"
                dir="ltr"
                placeholder="اختياري"
                value={phone}
                onChange={e => setPhone(e.target.value)}
              />
            </div>
            <div>
              <Label>المرتجع الافتراضي</Label>
              <Select
                value={returnMode}
                onValueChange={v => setReturnMode(v as "credit" | "rework")}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="credit">يخصم من الحساب</SelectItem>
                  <SelectItem value="rework">إعادة تشطيب</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            ده الافتراضي بس — تقدر تغيّره على كل مرتجع لوحده.
          </p>
          <Button
            className="mt-3"
            disabled={save.isPending}
            onClick={() => {
              if (!name.trim()) return toast.error("اكتب اسم المصنع");
              save.mutate({
                businessId,
                name: name.trim(),
                phone: phone.trim() || undefined,
                returnMode,
              });
            }}
          >
            إضافة
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ───────────────────────── ربط الأسماء القديمة ─────────────────────────

/**
 * الأسماء اللي في الإذونات القديمة.
 *
 * **مفيش مطابقة تلقائية هنا خالص.** «مصنع النحاس» و«مصنع نحاس» ممكن يكونوا نفس المصنع
 * وممكن لأ، ومحدش يعرف غير المالك. الشاشة بتعرض كل اسم لوحده وهو اللي بيقرر — والقرار
 * بيتخزّن ويتستخدم بعد كده.
 */
function HistoricalNames({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const names = trpc.suppliers.historicalNames.useQuery({ businessId });
  const suppliers = trpc.suppliers.list.useQuery({ businessId });
  const [choice, setChoice] = useState<Record<string, string>>({});

  const map = trpc.suppliers.mapHistoricalName.useMutation({
    onSuccess: async () => {
      toast.success("اتربط");
      await Promise.all([
        utils.suppliers.historicalNames.invalidate(),
        utils.suppliers.summaries.invalidate(),
      ]);
    },
    onError: error => toast.error(error.message),
  });

  const rows = (names.data ?? []).filter(row => !row.isMapped);
  if (rows.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Link2 className="h-5 w-5 text-amber-600" />
          أسماء مصانع قديمة محتاجة ربط ({rows.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
          الأسماء دي مكتوبة بإيد في إذونات قديمة. النظام <strong>مش هيخمّن</strong> إن
          «مصنع النحاس» و«مصنع نحاس» نفس المصنع — إنت اللي بتقرر. الاسم اللي متربطش
          مابيدخلش في أي كشف.
        </p>
        {rows.map(row => (
          <div
            key={row.historicalName}
            className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-end"
          >
            <div className="flex-1">
              <p className="font-medium">{row.historicalName}</p>
              <p className="text-xs text-muted-foreground">
                {row.receipts} إذن · {formatMoney(row.totalValue)}
              </p>
            </div>
            <div className="w-full sm:w-64">
              <Label className="text-xs">اربطه بمصنع</Label>
              <Select
                value={choice[row.historicalName] ?? ""}
                onValueChange={v =>
                  setChoice({ ...choice, [row.historicalName]: v })
                }
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="اختار المصنع" />
                </SelectTrigger>
                <SelectContent>
                  {(suppliers.data ?? []).map(supplier => (
                    <SelectItem key={supplier.key} value={supplier.key}>
                      {supplier.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              variant="outline"
              disabled={map.isPending || !choice[row.historicalName]}
              onClick={() =>
                map.mutate({
                  businessId,
                  historicalName: row.historicalName,
                  supplierKey: choice[row.historicalName],
                })
              }
            >
              اربط
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ───────────────────────── الكشف التفصيلي ─────────────────────────

function SupplierStatement({
  businessId,
  supplierKey,
  onBack,
}: {
  businessId: number;
  supplierKey: string;
  onBack: () => void;
}) {
  const utils = trpc.useUtils();
  const [range, setRange] = useState<Parameters<typeof quickRange>[0]>("all");
  const [movementType, setMovementType] = useState<string>("all");
  const [search, setSearch] = useState("");

  const dates = useMemo(() => quickRange(range, new Date()), [range]);
  const statement = trpc.suppliers.statement.useQuery({
    businessId,
    supplierKey,
    ...(dates.from ? { dateFrom: dates.from } : {}),
    ...(dates.to ? { dateTo: dates.to } : {}),
    ...(movementType !== "all"
      ? { movementType: movementType as SupplierMovementType }
      : {}),
    ...(search.trim() ? { search: search.trim() } : {}),
  });

  const data = statement.data;
  const totals = data?.totals;
  const state = describeBalance(totals?.balance ?? 0);

  const refresh = async () => {
    await Promise.all([
      utils.suppliers.statement.invalidate(),
      utils.suppliers.summaries.invalidate(),
      utils.accounting.controlCenter.invalidate(),
      utils.accounting.treasuryHistory.invalidate(),
    ]);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-bold">{data?.supplier?.name ?? "المصنع"}</h2>
          <p className="text-sm" style={{ color: state.tone === "owed" ? "var(--destructive)" : "var(--success)" }}>
            {state.text}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onBack}>
          رجوع للقايمة
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="الرصيد الافتتاحي" value={totals?.openingBalance ?? 0} />
        <Stat label="إجمالي البضاعة" value={totals?.goodsReceived ?? 0} />
        <Stat label="إجمالي المدفوع" value={totals?.paid ?? 0} />
        <Stat label="إجمالي المرتجعات" value={totals?.returns ?? 0} />
        <Stat label="إعادة التشطيب" value={totals?.reworkFees ?? 0} />
        <Stat label="الرصيد الحالي" value={totals?.balance ?? 0} strong />
      </div>

      <SupplierActions businessId={businessId} supplierKey={supplierKey} onDone={refresh} />

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            {QUICK.map(item => (
              <Button
                key={item.key}
                size="sm"
                variant={range === item.key ? "default" : "outline"}
                onClick={() => setRange(item.key)}
              >
                {item.label}
              </Button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label>نوع الحركة</Label>
              <Select value={movementType} onValueChange={setMovementType}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">الكل</SelectItem>
                  {Object.entries(MOVEMENT_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>بحث بالمرجع</Label>
              <Input
                className="mt-1"
                placeholder="رقم إذن أو مرجع تحويل"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4">
          {(data?.rows.length ?? 0) === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              مفيش حركات في الفترة دي.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[56rem] text-sm">
                <thead>
                  <tr className="border-b text-right text-xs text-muted-foreground">
                    <th className="p-2">التاريخ والوقت</th>
                    <th className="p-2">نوع الحركة</th>
                    <th className="p-2">المرجع</th>
                    <th className="p-2">البيان</th>
                    <th className="p-2">القيمة</th>
                    <th className="p-2">الرصيد قبل</th>
                    <th className="p-2">الرصيد بعد</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.rows.map(row => (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="p-2 whitespace-nowrap text-xs">
                        {new Date(row.occurredAt).toLocaleString("ar-EG", {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </td>
                      <td className="p-2 whitespace-nowrap">{row.label}</td>
                      <td className="p-2 text-muted-foreground">{row.reference ?? "—"}</td>
                      <td className="p-2 text-muted-foreground">{row.description || "—"}</td>
                      <td
                        className="p-2 tabular-nums font-semibold whitespace-nowrap"
                        style={{
                          color:
                            row.signedAmount > 0
                              ? "var(--destructive)"
                              : "var(--success)",
                        }}
                      >
                        {row.signedAmount > 0 ? "+" : "−"}
                        {formatMoney(Math.abs(row.signedAmount))}
                      </td>
                      <td className="p-2 tabular-nums text-muted-foreground">
                        {formatMoney(row.balanceBefore)}
                      </td>
                      <td className="p-2 tabular-nums font-medium">
                        {formatMoney(row.balanceAfter)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({
  label,
  value,
  strong,
}: {
  label: string;
  value: number;
  strong?: boolean;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`mt-1 tabular-nums ${strong ? "text-lg font-bold" : "font-semibold"}`}>
          {formatMoney(value)}
        </p>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── تسجيل الحركات ─────────────────────────

function SupplierActions({
  businessId,
  supplierKey,
  onDone,
}: {
  businessId: number;
  supplierKey: string;
  onDone: () => Promise<void>;
}) {
  const [kind, setKind] = useState<
    "payment" | "returnCredit" | "reworkFee" | "openingBalance"
  >("payment");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [direction, setDirection] = useState<"owed" | "credit">("owed");

  const done = async () => {
    toast.success("اتسجّلت الحركة");
    setAmount("");
    setReference("");
    setNotes("");
    await onDone();
  };
  const fail = (error: any) => toast.error(error.message);

  const payment = trpc.suppliers.payment.useMutation({ onSuccess: done, onError: fail });
  const returnCredit = trpc.suppliers.returnCredit.useMutation({ onSuccess: done, onError: fail });
  const reworkFee = trpc.suppliers.reworkFee.useMutation({ onSuccess: done, onError: fail });
  const opening = trpc.suppliers.openingBalance.useMutation({ onSuccess: done, onError: fail });

  const pending =
    payment.isPending || returnCredit.isPending || reworkFee.isPending || opening.isPending;

  const submit = () => {
    const value = Number(amount);
    if (!(value > 0)) return toast.error("المبلغ لازم يكون أكبر من صفر");
    const when = new Date(`${date}T12:00:00`);
    const common = {
      businessId,
      supplierKey,
      reference: reference.trim() || undefined,
      notes: notes.trim() || undefined,
    };
    if (kind === "payment") payment.mutate({ ...common, amount: value, paidAt: when });
    else if (kind === "returnCredit")
      returnCredit.mutate({ ...common, amount: value, occurredAt: when });
    else if (kind === "reworkFee")
      reworkFee.mutate({ ...common, amount: value, occurredAt: when });
    else
      opening.mutate({
        businessId,
        supplierKey,
        // الاتجاه بيتحوّل لإشارة هنا: عليّا موجب، ليّا سالب.
        amount: direction === "owed" ? value : -value,
        occurredAt: when,
        notes: notes.trim() || undefined,
      });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">تسجيل حركة</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-4">
          {[
            ["payment", "دفعة للمصنع"],
            ["returnCredit", "مرتجع يخصم من الحساب"],
            ["reworkFee", "تكلفة إعادة تشطيب"],
            ["openingBalance", "رصيد افتتاحي"],
          ].map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={kind === key ? "default" : "outline"}
              onClick={() => setKind(key as any)}
            >
              {label}
            </Button>
          ))}
        </div>

        {kind === "openingBalance" && (
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant={direction === "owed" ? "default" : "outline"}
              onClick={() => setDirection("owed")}
            >
              عليا للمصنع
            </Button>
            <Button
              variant={direction === "credit" ? "default" : "outline"}
              onClick={() => setDirection("credit")}
            >
              ليا عند المصنع
            </Button>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
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
            <Label>التاريخ *</Label>
            <Input
              className="mt-1"
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
            />
          </div>
          {kind !== "openingBalance" && (
            <div>
              <Label>المرجع</Label>
              <Input
                className="mt-1"
                placeholder="اختياري"
                value={reference}
                onChange={e => setReference(e.target.value)}
              />
            </div>
          )}
          <div className="sm:col-span-3">
            <Label>ملاحظات</Label>
            <Input
              className="mt-1"
              placeholder="اختياري"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>
        </div>

        <Button className="w-full" disabled={pending} onClick={submit}>
          {pending ? "جاري التسجيل..." : "تسجيل"}
        </Button>

        <p className="text-xs text-muted-foreground">
          {kind === "payment"
            ? "الدفعة بتنقّص حساب المصنع وبتخرج من «الخزنة الرئيسية» — مرة واحدة. ومابتتحسبش مصروف تشغيلي، لأن تكلفة البضاعة اتسجّلت خلاص وقت الاستلام."
            : kind === "reworkFee"
              ? "تحويل القطع للمصنع مابيغيّرش الحساب — الرسم ده هو اللي بيزوّده، ولما يستحق بس."
              : kind === "returnCredit"
                ? "المرتجع ده بيخصم من حساب المصنع. لو البضاعة راجعة للتشطيب مش للخصم، استخدم «تكلفة إعادة تشطيب» بدلها."
                : "الرصيد الافتتاحي بيتسجّل مرة واحدة لكل مصنع. مابيخلقش بضاعة ولا فلوس — بس بيقول الحساب بدأ منين."}
        </p>
      </CardContent>
    </Card>
  );
}
