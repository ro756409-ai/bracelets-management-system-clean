import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  TrendingUp, Wallet, Receipt, RotateCcw, Truck, Package, Banknote, Clock, ArrowLeftRight,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";
import { PageHeader, StatCard, LoadingSkeleton, EmptyState } from "@/components/shared";
import { formatMoney, formatMoneyCompact } from "@/lib/money";

/**
 * لوحة الحسابات — المرحلة الثانية من وحدة الحسابات.
 *
 * كل رقم هنا محسوب على السيرفر من الجداول الموجودة (`accounting.dashboard`)، مفيش حساب
 * مالي في الواجهة: لو الصفحة حسبت صافي الربح بنفسها كانت هتبقى تعريف تاني للربح ينفع
 * يختلف عن أي تقرير تاني في النظام.
 */
export default function Accounting() {
  const [, navigate] = useLocation();
  const { currentBusinessIds } = useBusinessContext();
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });

  const { data, isLoading } = trpc.accounting.dashboard.useQuery({
    businessIds: currentBusinessIds,
    dateFrom: dateRange.from ?? undefined,
    dateTo: dateRange.to ?? undefined,
  });

  // إجمالي التكاليف — يُعرض كسياق تحت صافي الربح، لأن الربح لوحده مايقولش
  // التكلفة جات منين.
  const totalCost = useMemo(() => {
    if (!data) return 0;
    return data.productCost + data.shippingCost + data.totalExpenses + data.totalReturns;
  }, [data]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="الحسابات"
        description="المبيعات والتحصيلات والمصروفات ورصيد الخزنة"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <DateRangePicker value={dateRange} onChange={setDateRange} />
            <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => navigate("/treasury")}>
              <Wallet className="h-4 w-4" /> الخزنة
            </Button>
            <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => navigate("/expenses")}>
              <Receipt className="h-4 w-4" /> المصروفات
            </Button>
            <Button variant="outline" size="sm" className="h-9 gap-1.5" onClick={() => navigate("/collections")}>
              <Banknote className="h-4 w-4" /> التحصيلات
            </Button>
          </div>
        }
      />

      {/* نفس نمط شريط الإحصائيات في صفحة الأوردرات: يتمرّر جوه نفسه على الموبايل،
          جريد على الشاشات الأوسع. */}
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-4 lg:overflow-visible [&>*]:min-w-[168px] [&>*]:snap-start lg:[&>*]:min-w-0">
        <StatCard
          label="إجمالي المبيعات" tone="primary" loading={isLoading}
          value={formatMoneyCompact(data?.totalSales)}
          hint={data ? formatMoney(data.totalSales) : undefined}
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <StatCard
          label="إجمالي التحصيلات" tone="success" loading={isLoading}
          value={formatMoneyCompact(data?.totalCollected)}
          hint={data ? formatMoney(data.totalCollected) : undefined}
          icon={<Banknote className="h-5 w-5" />}
        />
        <StatCard
          label="رصيد الخزنة"
          tone={data && data.treasuryBalance < 0 ? "danger" : "primary"}
          loading={isLoading}
          value={formatMoneyCompact(data?.treasuryBalance)}
          hint={data ? formatMoney(data.treasuryBalance) : undefined}
          icon={<Wallet className="h-5 w-5" />}
        />
        <StatCard
          label="صافي الربح"
          tone={data && data.netProfit < 0 ? "danger" : "success"}
          loading={isLoading}
          value={formatMoneyCompact(data?.netProfit)}
          hint={data ? formatMoney(data.netProfit) : undefined}
          icon={<ArrowLeftRight className="h-5 w-5" />}
        />
      </div>

      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0 lg:grid lg:grid-cols-4 lg:overflow-visible [&>*]:min-w-[168px] [&>*]:snap-start lg:[&>*]:min-w-0">
        <StatCard
          label="تكلفة المنتجات" tone="warning" loading={isLoading}
          value={formatMoneyCompact(data?.productCost)}
          hint={data ? formatMoney(data.productCost) : undefined}
          icon={<Package className="h-5 w-5" />}
        />
        <StatCard
          label="تكلفة الشحن" tone="info" loading={isLoading}
          value={formatMoneyCompact(data?.shippingCost)}
          hint={data ? formatMoney(data.shippingCost) : undefined}
          icon={<Truck className="h-5 w-5" />}
        />
        <StatCard
          label="إجمالي المصروفات" tone="warning" loading={isLoading}
          value={formatMoneyCompact(data?.totalExpenses)}
          hint={data ? formatMoney(data.totalExpenses) : undefined}
          icon={<Receipt className="h-5 w-5" />}
        />
        <StatCard
          label="إجمالي المرتجعات" tone="danger" loading={isLoading}
          value={formatMoneyCompact(data?.totalReturns)}
          hint={data ? formatMoney(data.totalReturns) : undefined}
          icon={<RotateCcw className="h-5 w-5" />}
        />
      </div>

      {/* المعلّق: الفرق بين المبيعات والكاش الفعلي. بيقف جنب الربح عشان الرقمين
          يتقروا مع بعض — ربح دفتري كبير ومعلّق كبير معناهم إن الفلوس لسه بره. */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="shadow-[var(--shadow-card)]">
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="type-subheading flex items-center gap-1.5">
              <Clock className="h-4 w-4 text-[var(--warning)]" /> مبالغ معلّقة
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {isLoading ? (
              <LoadingSkeleton variant="form" rows={2} />
            ) : (
              <>
                <p className="text-[26px] font-bold leading-none tabular-nums text-[var(--warning)]">
                  {formatMoney(data?.pendingCollection)}
                </p>
                <p className="type-caption">
                  المتوقع ناقص المحصّل للأوردرات اللي لسه مع شركة الشحن
                </p>
                <Button
                  variant="outline" size="sm" className="mt-2 h-8 w-full"
                  onClick={() => navigate("/collections")}
                >
                  متابعة التحصيلات
                </Button>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="shadow-[var(--shadow-card)] lg:col-span-2">
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="type-subheading">تركيب التكاليف</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <LoadingSkeleton variant="form" rows={4} />
            ) : totalCost === 0 ? (
              <p className="type-caption py-4 text-center">لا توجد تكاليف مسجّلة في هذه الفترة</p>
            ) : (
              <div className="space-y-2.5">
                {([
                  { label: "تكلفة المنتجات", value: data!.productCost, color: "var(--warning)" },
                  { label: "تكلفة الشحن", value: data!.shippingCost, color: "var(--info)" },
                  { label: "المصروفات", value: data!.totalExpenses, color: "var(--purple)" },
                  { label: "المرتجعات", value: data!.totalReturns, color: "var(--destructive)" },
                ]).map(row => {
                  const pct = totalCost > 0 ? (row.value / totalCost) * 100 : 0;
                  return (
                    <div key={row.label}>
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="font-medium">{row.label}</span>
                        <span className="tabular-nums">
                          {formatMoney(row.value)}
                          <span className="type-caption mr-1.5">
                            {pct.toLocaleString("ar-EG", { maximumFractionDigits: 0 })}%
                          </span>
                        </span>
                      </div>
                      {/* شريط نسبة بسيط بدل مكتبة رسم: الرقم هو المعلومة، والشريط
                          بيساعد العين تقارن بس. */}
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: row.color }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <FinancialMovementChart data={data?.movementByDay ?? []} loading={isLoading} />
    </div>
  );
}

/**
 * الحركة المالية بالأيام — داخل/خارج.
 *
 * SVG مكتوب باليد مش مكتبة رسم: الحزمة فيها صفر مكتبات charts حاليًا، وإضافة واحدة
 * لرسم عمودين كانت هتزوّد الـbundle أكتر من فايدتها. الأعمدة بتتقاس بالنسبة لأكبر قيمة
 * في الفترة، فالشكل بيفضل مقروء مهما كان مقياس الأرقام.
 */
function FinancialMovementChart({
  data, loading,
}: {
  data: { day: string; inflow: number; outflow: number }[];
  loading?: boolean;
}) {
  const max = useMemo(
    () => Math.max(1, ...data.flatMap(d => [d.inflow, d.outflow])),
    [data]
  );

  return (
    <Card className="shadow-[var(--shadow-card)]">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="type-subheading">الحركة المالية</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <LoadingSkeleton variant="form" rows={4} />
        ) : data.length === 0 ? (
          <EmptyState
            icon={<ArrowLeftRight className="h-6 w-6" />}
            title="لا توجد حركات مالية"
            description="أول تحصيل أو مصروف هيظهر هنا"
          />
        ) : (
          <>
            <div className="mb-3 flex items-center gap-4 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-[var(--success)]" /> داخل
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm bg-destructive" /> خارج
              </span>
            </div>
            {/* الحاوية بتتمرّر لوحدها: ٦٠ يوم × عمودين مش بيدخلوا في عرض الشاشة،
                والتمرير هنا أحسن من ضغط الأعمدة لدرجة إنها تبقى خطوط. */}
            <div className="-mx-2 overflow-x-auto px-2">
              <div className="flex min-w-max items-end gap-2" dir="ltr">
                {data.map(d => (
                  <div key={d.day} className="flex w-11 shrink-0 flex-col items-center gap-1">
                    <div className="flex h-32 items-end gap-0.5">
                      <div
                        className="w-4 rounded-t bg-[var(--success)]"
                        style={{ height: `${Math.max(2, (d.inflow / max) * 100)}%` }}
                        title={`داخل: ${formatMoney(d.inflow)}`}
                      />
                      <div
                        className="w-4 rounded-t bg-destructive"
                        style={{ height: `${Math.max(2, (d.outflow / max) * 100)}%` }}
                        title={`خارج: ${formatMoney(d.outflow)}`}
                      />
                    </div>
                    <span className="type-caption whitespace-nowrap tabular-nums" dir="rtl">
                      {new Date(d.day).toLocaleDateString("ar-EG", { day: "numeric", month: "short" })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
