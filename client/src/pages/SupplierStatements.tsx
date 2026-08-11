import { Fragment, useMemo, useState } from "react";
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
import {
  Factory,
  ArrowRight,
  Link2,
  PackagePlus,
  Trash2,
  Wrench,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  Kpi,
  Panel,
  ScreenHeader,
  TableScroll,
  toneColor,
  TABLE_CLASS,
  TABLE_HEAD_CLASS,
} from "@/components/accounting/Surface";
import { SupplierPaymentDrawer } from "@/components/accounting/SupplierPaymentDrawer";
import GoodsReceipt from "./GoodsReceipt";

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

/**
 * كشف حساب ورشة واحدة.
 *
 * فوق **تلات أرقام بس**: سلّمني كام، حوّلت كام، وباقي كام. الست كروت اللي كانت هنا
 * (افتتاحي · بضاعة · مدفوع · مرتجعات · تشطيب · رصيد) كانت بتخلي التاجر يقرا ست أرقام
 * عشان يطلع بواحد — وهو داخل عشان الواحد ده. المرتجعات والتشطيب مش اختفوا: هما جوه
 * كشف الحركات تحت، وداخلين في «الباقي» زي ما هما.
 *
 * والباقي هو نفسه `totals.balance` الجاي من نفس المحرّك — مفيش معادلة تانية اتكتبت هنا.
 */
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
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

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
  const balance = totals?.balance ?? 0;
  const supplierName = data?.supplier?.name ?? "الورشة";

  const refresh = async () => {
    await Promise.all([
      utils.suppliers.statement.invalidate(),
      utils.suppliers.summaries.invalidate(),
      utils.suppliers.receipts.invalidate(),
      utils.accounting.controlCenter.invalidate(),
      utils.accounting.treasuryHistory.invalidate(),
    ]);
  };

  return (
    <div className="space-y-4">
      <ScreenHeader
        title={supplierName}
        subtitle="الشغل اللي استلمته، اللي حوّلته، والباقي"
        action={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setPayOpen(true)}>
              + دفعة للورشة
            </Button>
            <Button variant="outline" size="sm" onClick={onBack}>
              رجوع للقايمة
            </Button>
          </div>
        }
      />

      {/*
        تلات أرقام. اللون مشتق من المعنى مش متبعت: الباقي أحمر لما يكون عليك، وأخضر
        لما يكون ليك — والعنوان نفسه بيتغيّر عشان الرقم مايفضلش ملبّس.
      */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi
          label="الورشة سلمتني"
          value={formatMoney(totals?.goodsReceived ?? 0)}
          tone="neutral"
          hint="قيمة الشغل المستلم والمعتمد"
        />
        <Kpi
          label="حولت للورشة"
          value={formatMoney(totals?.paid ?? 0)}
          tone="out"
          hint="إجمالي الدفعات"
        />
        <Kpi
          label={balance >= 0 ? "المتبقي للورشة" : "ليك عند الورشة"}
          value={formatMoney(Math.abs(balance))}
          tone={Math.abs(balance) < 0.01 ? "neutral" : balance > 0 ? "out" : "in"}
          hint={
            Math.abs(balance) < 0.01
              ? "الحساب متعادل"
              : "بعد المرتجعات وإعادة التشطيب والتسويات"
          }
        />
      </div>

      <SupplierPaymentDrawer
        businessId={businessId}
        supplierKey={supplierKey}
        supplierName={supplierName}
        open={payOpen}
        onClose={() => setPayOpen(false)}
        onSaved={refresh}
      />

      <SupplierReceipts
        businessId={businessId}
        supplierKey={supplierKey}
        supplierName={supplierName}
        onDone={refresh}
      />

      {/*
        إذن الاستلام الحقيقي — نفس المكوّن اللي في صفحة «إذن استلام بضاعة»، مش نسخة
        مصغّرة منه. الاستلام بيزوّد المخزون **و**حساب الورشة؛ فورم مبسّط كان هيسجّل
        الحساب من غير مخزون.
      */}
      <details className="rounded-lg border bg-card" open={receiptOpen}>
        <summary
          className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 text-sm font-medium"
          onClick={event => {
            event.preventDefault();
            setReceiptOpen(open => !open);
          }}
        >
          <PackagePlus className="h-4 w-4 text-[var(--success)]" />
          تسجيل استلام جديد من {supplierName}
        </summary>
        <div className="border-t p-4">
          <GoodsReceipt
            embeddedBusinessId={businessId}
            lockedSupplierName={data?.supplier?.name}
            onSaved={refresh}
          />
          <p className="mt-3 rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            الحفظ لوحده مايحرّكش الحساب — <strong>الاعتماد</strong> هو اللي بيزوّد
            المخزون ويسجّل القيمة على الورشة.
          </p>
        </div>
      </details>

      {/*
        باقي الحركات — مرتجعات وإعادة تشطيب وتسويات ورصيد افتتاحي.

        مطويّة عن قصد: دي حاجات بتحصل مرة كل فترة، والصفحة المفروض تفتح على الشغل
        والفلوس مش على أدوات التسوية.
      */}
      <details className="rounded-lg border bg-card" open={moreOpen}>
        <summary
          className="flex cursor-pointer select-none items-center gap-2 px-4 py-3 text-sm font-medium"
          onClick={event => {
            event.preventDefault();
            setMoreOpen(open => !open);
          }}
        >
          <Wrench className="h-4 w-4 text-[var(--warning)]" />
          مرتجعات · إعادة تشطيب · تسويات
        </summary>
        <div className="border-t p-4">
          <SupplierActions
            businessId={businessId}
            supplierKey={supplierKey}
            onDone={refresh}
          />
        </div>
      </details>

      <Panel title="كل حركات الحساب">
        <div className="mb-3 flex flex-wrap gap-2">
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
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
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

        {(data?.rows.length ?? 0) === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            مفيش حركات في الفترة دي.
          </p>
        ) : (
          <TableScroll>
            <table className={`${TABLE_CLASS} min-w-[52rem]`}>
              <thead>
                <tr className={TABLE_HEAD_CLASS}>
                  <th>التاريخ والوقت</th>
                  <th>نوع الحركة</th>
                  <th>المرجع</th>
                  <th>البيان</th>
                  <th>القيمة</th>
                  <th>الرصيد قبل</th>
                  <th>الرصيد بعد</th>
                  <th className="text-left">الإجراءات</th>
                </tr>
              </thead>
              <tbody>
                {data!.rows.map(row => (
                  <MovementRow
                    key={row.id}
                    row={row}
                    businessId={businessId}
                    supplierKey={supplierKey}
                    onDone={refresh}
                  />
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>
    </div>
  );
}

/**
 * سطر حركة ومعاه إجراءاته.
 *
 * **«حذف» هنا معناه حركة عكسية.** الحركات دي كلها أثّرت على الحساب — وبعضها على
 * الخزنة كمان — فمسحها من الجدول كان بيغيّر رصيد الشهر اللي فات من غير ما حد يعرف.
 * العكسية بتخلي الرقم يرجع صح والسطرين الاتنين يفضلوا مكتوبين.
 *
 * الاستلام مالوش زرار هنا: مساره في جدول الاستلامات فوق، لأن إلغاءه بيمس المخزون كمان.
 */
function MovementRow({
  row,
  businessId,
  supplierKey,
  onDone,
}: {
  row: any;
  businessId: number;
  supplierKey: string;
  onDone: () => Promise<void>;
}) {
  const reverse = trpc.suppliers.reverseMovement.useMutation({
    onSuccess: async () => {
      toast.success("اتسجّلت حركة عكسية — الرصيد اترجع");
      await onDone();
    },
    onError: error => toast.error(error.message),
  });

  // الاستلام والإلغاء والتسوية العكسية مالهمش إلغاء من هنا.
  const canReverse =
    row.type === "payment" ||
    row.type === "return_credit" ||
    row.type === "rework_fee" ||
    row.type === "opening_balance";

  const onReverse = () => {
    const reason = window.prompt(
      `الحركة دي أثّرت على الحساب. حذفها هيعمل حركة عكسية ويحافظ على السجل.\n\nاكتب السبب:`
    );
    if (reason === null) return;
    if (!reason.trim()) return toast.error("السبب مطلوب");
    reverse.mutate({ businessId, supplierKey, eventId: row.id, reason: reason.trim() });
  };

  return (
    <tr className="border-b last:border-0">
      <td className="whitespace-nowrap text-xs">
        {new Date(row.occurredAt).toLocaleString("ar-EG", {
          dateStyle: "short",
          timeStyle: "short",
        })}
      </td>
      <td className="whitespace-nowrap">{row.label}</td>
      <td className="text-muted-foreground">{row.reference ?? "—"}</td>
      <td className="text-muted-foreground">{row.description || "—"}</td>
      <td
        className="whitespace-nowrap font-semibold tabular-nums"
        style={{ color: toneColor(row.signedAmount > 0 ? "out" : "in") }}
      >
        {row.signedAmount > 0 ? "+" : "−"}
        {formatMoney(Math.abs(row.signedAmount))}
      </td>
      <td className="tabular-nums text-muted-foreground">
        {formatMoney(row.balanceBefore)}
      </td>
      <td className="font-medium tabular-nums">{formatMoney(row.balanceAfter)}</td>
      <td className="text-left">
        {canReverse ? (
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={reverse.isPending}
            onClick={onReverse}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

// ───────────────────────── الشغل المستلم ─────────────────────────

/**
 * «الشغل اللي استلمته من الورشة».
 *
 * جدول واحد كل سطر فيه استلام حقيقي — مش خليط من حركات محاسبية. الاستلام اللي فيه
 * أكتر من صنف بيتفتح على بنوده بدل ما يتفرد في الجدول ويضيّع الصف الواحد.
 *
 * الإجمالي تحت بيجمع **المعتمد بس**، عشان يساوي «الورشة سلمتني» فوق بالحرف. المسودة
 * بتبان بعلامة إنها لسه مش داخلة في الحساب — إخفاؤها كان بيخلي إذن اتكتب ومااتعتمدش
 * يختفي من غير أثر.
 */
function SupplierReceipts({
  businessId,
  supplierKey,
  supplierName,
  onDone,
}: {
  businessId: number;
  supplierKey: string;
  supplierName: string;
  onDone: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const receipts = trpc.suppliers.receipts.useQuery({ businessId, supplierKey });
  const rows = receipts.data ?? [];

  const voidReceipt = trpc.accountingV2.purchaseReceiptVoid.useMutation({
    onSuccess: async (result: any) => {
      toast.success(
        result?.reversed
          ? "اتسجّل إلغاء الاستلام — المخزون والحساب اترجعوا"
          : "اتلغى الاستلام (كان لسه مسودة)"
      );
      await onDone();
    },
    onError: (error: { message: string }) => toast.error(error.message),
  });

  const approvedTotal = rows
    .filter(row => row.countsInBalance)
    .reduce((sum, row) => sum + row.totalAmount, 0);

  const toggle = (id: number) =>
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const onVoid = (row: (typeof rows)[number]) => {
    const approved = row.countsInBalance;
    const message = approved
      ? "الحركة دي أثرت على الحساب. حذفها هيعمل حركة عكسية ويحافظ على السجل. متأكد؟\n\nاكتب السبب:"
      : "الاستلام ده لسه مسودة ومأثرش على أي حساب. اكتب سبب الإلغاء:";
    const reason = window.prompt(message);
    if (reason === null) return;
    if (!reason.trim()) return toast.error("السبب مطلوب");
    voidReceipt.mutate({ businessId, receiptId: row.id, reason: reason.trim() });
  };

  return (
    <Panel title={`الشغل اللي استلمته من ${supplierName}`}>
      {receipts.isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">جاري التحميل...</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          مفيش استلامات لسه من الورشة دي.
        </p>
      ) : (
        <TableScroll>
          <table className={`${TABLE_CLASS} min-w-[52rem]`}>
            <thead>
              <tr className={TABLE_HEAD_CLASS}>
                <th>التاريخ</th>
                <th>بيان الشغل</th>
                <th>الصنف</th>
                <th>النوع / الحفر</th>
                <th>الكمية</th>
                <th>سعر القطعة</th>
                <th>إجمالي الاستلام</th>
                <th>ملاحظات</th>
                <th className="text-left">الإجراءات</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const single = row.items.length === 1 ? row.items[0] : null;
                const isOpen = expanded.has(row.id);
                return (
                  <Fragment key={row.id}>
                    <tr className="border-b last:border-0">
                      <td className="whitespace-nowrap text-xs">
                        {new Date(row.receiptDate).toLocaleDateString("ar-EG")}
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{row.reference ?? `استلام #${row.id}`}</span>
                          {!row.countsInBalance && (
                            <span
                              className="rounded-full bg-muted px-2 py-0.5 text-[10px]"
                              style={{ color: toneColor("due") }}
                            >
                              {row.status === "voided" ? "ملغي" : "لسه مش معتمد"}
                            </span>
                          )}
                        </div>
                      </td>
                      {single ? (
                        <>
                          <td>{single.productName}</td>
                          <td className="text-[var(--info)]">{single.variantName ?? "—"}</td>
                          <td className="tabular-nums">{single.quantity} قطعة</td>
                          <td className="tabular-nums">{formatMoney(single.unitCost)}</td>
                        </>
                      ) : (
                        <>
                          <td colSpan={3}>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => toggle(row.id)}
                            >
                              {isOpen ? (
                                <ChevronUp className="ml-1 h-3.5 w-3.5" />
                              ) : (
                                <ChevronDown className="ml-1 h-3.5 w-3.5" />
                              )}
                              {row.items.length} أصناف · {row.totalQuantity} قطعة
                            </Button>
                          </td>
                          <td className="text-muted-foreground">—</td>
                        </>
                      )}
                      <td className="font-semibold tabular-nums">
                        {formatMoney(row.totalAmount)}
                      </td>
                      <td className="max-w-[12rem] truncate text-muted-foreground" title={row.notes ?? ""}>
                        {row.notes || "—"}
                      </td>
                      <td className="text-left">
                        {row.status === "voided" ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive"
                            disabled={voidReceipt.isPending}
                            onClick={() => onVoid(row)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </td>
                    </tr>
                    {!single && isOpen && (
                      <tr className="bg-muted/30">
                        <td colSpan={9} className="p-0">
                          <table className={`${TABLE_CLASS} w-full`}>
                            <tbody>
                              {row.items.map(item => (
                                <tr key={item.id} className="border-b last:border-0">
                                  <td className="w-[18rem] ps-8">{item.productName}</td>
                                  <td className="text-[var(--info)]">{item.variantName ?? "—"}</td>
                                  <td className="tabular-nums">{item.quantity} قطعة</td>
                                  <td className="tabular-nums">{formatMoney(item.unitCost)}</td>
                                  <td className="tabular-nums font-medium">
                                    {formatMoney(item.lineTotal)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 font-bold">
                <td colSpan={6} className="text-right">
                  إجمالي الشغل المستلم
                </td>
                <td className="tabular-nums">{formatMoney(approvedTotal)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </TableScroll>
      )}
    </Panel>
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
