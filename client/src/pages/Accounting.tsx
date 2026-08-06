import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  TrendingUp,
  Wallet,
  Receipt,
  RotateCcw,
  Truck,
  Package,
  Banknote,
  Clock,
  ArrowLeftRight,
  CalendarDays,
  Percent,
  PiggyBank,
  Users,
  LockKeyhole,
  Settings2,
  PackageCheck,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";
import {
  PageHeader,
  SectionHeader,
  StatCard,
  LoadingSkeleton,
  EmptyState,
} from "@/components/shared";
import { formatMoney, formatMoneyCompact } from "@/lib/money";
import { ExpensesSection } from "./Expenses";
import { CollectionsSection } from "./Collections";
import { PayrollSection } from "./Payroll";
import { ClosingsSection } from "./Closings";
import { AccountingSettingsSection } from "./AccountingSettings";
import { ShippingFinanceSection } from "./ShippingFinance";
import ControlCenter from "./accounting/ControlCenter";
import TreasuryHistory from "./accounting/TreasuryHistory";

/**
 * مركز الحسابات.
 *
 * التابات بقت الأقسام اللي التاجر بيشتغل فيها كل يوم، مش الأقسام اللي المحاسبة بتتقسم
 * بيها. الشاشات القديمة **ما اتحذفتش** — التقفيلات والشحن والتسويات والإعدادات لسه
 * جداولها وخدماتها ومساراتها شغّالة، بس اتشالت من الشريط عشان مين بيفتح الصفحة كل صبح
 * مايبصّش على تمن تابات تمانيتهم مش اللي محتاجه.
 *
 * `HIDDEN_TABS` مكتوبة صراحة بدل ما تتمسح: أي حد بيقرا الملف بعد كده يعرف إن الشاشة
 * موجودة ومخفية عن قصد، ويعرف رابطها.
 *
 * التاب في الـURL مش في الـstate: الرفريش بيفضل على نفس التاب، والرابط ينفع يتبعت،
 * والمسارات القديمة لسه شغّالة وبتفتح التاب بتاعها بدل ما تبوظ.
 */
const TABS = [
  { key: "overview", label: "اللوحة", path: "/accounting", icon: TrendingUp },
  { key: "collections", label: "التحصيلات", path: "/collections", icon: Banknote },
  { key: "inventory", label: "المخزون", path: "/goods-receipt", icon: PackageCheck },
  { key: "expenses", label: "المصروفات", path: "/expenses", icon: Receipt },
  { key: "advertising", label: "الإعلانات", path: "/advertising", icon: TrendingUp },
  { key: "payroll", label: "المرتبات", path: "/payroll", icon: Users },
  { key: "treasury", label: "سجل الخزنة", path: "/treasury", icon: Wallet },
] as const;

/**
 * شاشات شغّالة ومخفية من الشريط — مش محذوفة.
 *
 * كل واحدة فيهم لسه ليها مسار وجداول وخدمات. التقفيلات بالذات فيها لقطات معتمدة
 * والأرباح التاريخية مبنية عليها، فحذفها بيقطع السلسلة.
 */
const HIDDEN_TABS = [
  { key: "closings", label: "التقفيلات", path: "/closings", icon: LockKeyhole },
  { key: "shipping-finance", label: "الشحن والتسويات", path: "/shipping-finance", icon: PackageCheck },
  { key: "settings", label: "الإعدادات", path: "/accounting-settings", icon: Settings2 },
] as const;

export default function Accounting() {
  const [location, navigate] = useLocation();
  const all = [...TABS, ...HIDDEN_TABS];
  const active = all.find(t => t.path === location)?.key ?? "overview";

  return (
    <div className="space-y-4">
      <PageHeader
        title="الحسابات"
        description="المبيعات والتحصيلات والمصروفات ورصيد الخزنة"
      />

      {/* نفس شريط التابات المستخدم في صفحة الأوردرات — يتمرّر جوه نفسه على الموبايل */}
      <div className="overflow-x-auto border-b border-border px-1">
        <div className="flex w-max items-center gap-0.5">
          {TABS.map(tab => {
            const isActive = active === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => navigate(tab.path)}
                aria-current={isActive ? "page" : undefined}
                className={`relative flex items-center gap-2 whitespace-nowrap px-3.5 py-3 text-sm transition-colors duration-[var(--duration-fast)] ${
                  isActive
                    ? "font-bold text-primary"
                    : "font-medium text-muted-foreground hover:text-foreground"
                }`}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
                {isActive && (
                  <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {active === "overview" && <ControlCenter />}
      {active === "treasury" && <TreasuryHistory />}
      {active === "expenses" && <ExpensesSection />}
      {active === "collections" && <CollectionsSection />}
      {active === "payroll" && <PayrollSection />}
      {active === "closings" && <ClosingsSection />}
      {active === "shipping-finance" && <ShippingFinanceSection />}
      {active === "settings" && <AccountingSettingsSection />}

      {/* الأقسام المتقدمة — مخفية من الشريط ومتاحة للمالك من هنا */}
      {active === "overview" && (
        <details className="rounded-lg border bg-card p-3">
          <summary className="cursor-pointer text-sm font-semibold text-muted-foreground">
            أقسام متقدمة
          </summary>
          <div className="mt-3">
            <p className="mb-2 text-xs text-muted-foreground">
              لوحة الأرباح التفصيلية — المحقق مقابل المتوقع من أحداث النشاط.
            </p>
            <OverviewSection />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {HIDDEN_TABS.map(t => (
              <button
                key={t.key}
                type="button"
                onClick={() => navigate(t.path)}
                className="flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm hover:bg-muted/60"
              >
                <t.icon className="h-4 w-4" />
                {t.label}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * لوحة الأرباح.
 *
 * كل رقم محسوب على السيرفر من الجداول الموجودة (`accounting.dashboard`)، مفيش حساب مالي
 * في الواجهة: لو الصفحة حسبت صافي الربح بنفسها كانت هتبقى تعريف تاني للربح ينفع يختلف
 * عن أي تقرير تاني في النظام.
 */
function OverviewSection() {
  const [, navigate] = useLocation();
  const { currentBusinessIds } = useBusinessContext();
  const [dateRange, setDateRange] = useState<DateRange>({
    from: null,
    to: null,
  });

  const { data, isLoading } = trpc.accountingV2.dashboard.useQuery({
    businessIds: currentBusinessIds,
    dateFrom: dateRange.from ?? undefined,
    dateTo: dateRange.to ?? undefined,
  });
  const realizedCost = data
    ? data.realized.cogs +
      data.realized.shippingCost +
      data.realized.expenses +
      data.realized.scrapLoss
    : 0;

  return (
    <div className="space-y-4">
      <SectionHeader
        description="Realized من Business Events فقط، وProjected من سنابشوتات الأوردرات المفتوحة"
        actions={<DateRangePicker value={dateRange} onChange={setDateRange} />}
      />
      <div className="grid gap-3 lg:grid-cols-4">
        <StatCard
          label="الإيراد المحقق"
          tone="success"
          loading={isLoading}
          value={formatMoney(data?.realized.revenue)}
          hint="Delivered ناقص عكس المرتجعات"
          icon={<TrendingUp className="h-5 w-5" />}
        />
        <StatCard
          label="الربح المحاسبي المحقق"
          tone={(data?.realized.netProfit ?? 0) < 0 ? "danger" : "success"}
          loading={isLoading}
          value={formatMoney(data?.realized.netProfit)}
          hint="Business Events للفترة"
          icon={<ArrowLeftRight className="h-5 w-5" />}
        />
        <StatCard
          label="هامش الربح المحقق"
          tone={(data?.realized.profitMargin ?? 0) < 0 ? "danger" : "success"}
          loading={isLoading}
          value={`${(data?.realized.profitMargin ?? 0).toLocaleString("ar-EG", { maximumFractionDigits: 2 })}%`}
          hint="الربح المحقق ÷ الإيراد المحقق"
          icon={<Percent className="h-5 w-5" />}
        />
        <StatCard
          label="رصيد الحسابات المالية"
          tone={(data?.cash.balance ?? 0) < 0 ? "danger" : "primary"}
          loading={isLoading}
          value={formatMoney(data?.cash.balance)}
          icon={<PiggyBank className="h-5 w-5" />}
        />
      </div>
      <Card className="border-sky-200 bg-sky-50/50 dark:border-sky-900 dark:bg-sky-950/20">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Projected Profit التشغيلي</span>
            <span className="rounded-full bg-sky-100 px-2 py-1 text-xs text-sky-800 dark:bg-sky-900 dark:text-sky-100">
              غير محاسبي
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="إيراد متوقع"
            tone="primary"
            loading={isLoading}
            value={formatMoney(data?.projected.revenue)}
            hint={data ? `${data.projected.orderCount} أوردر مفتوح` : undefined}
            icon={<CalendarDays className="h-5 w-5" />}
          />
          <StatCard
            label="تكلفة منتج متوقعة"
            tone="warning"
            loading={isLoading}
            value={formatMoney(data?.projected.productCost)}
            hint="Moving Average وقت إنشاء الأوردر"
            icon={<Package className="h-5 w-5" />}
          />
          <StatCard
            label="شحن متوقع"
            tone="info"
            loading={isLoading}
            value={formatMoney(data?.projected.shippingCost)}
            hint="Expected Shipping Snapshot"
            icon={<Truck className="h-5 w-5" />}
          />
          <StatCard
            label="Projected Profit"
            tone={(data?.projected.profit ?? 0) < 0 ? "danger" : "success"}
            loading={isLoading}
            value={formatMoney(data?.projected.profit)}
            hint="يختفي عند الإلغاء أو اكتمال الدورة"
            icon={<TrendingUp className="h-5 w-5" />}
          />
        </CardContent>
      </Card>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="COGS المحقق"
          tone="warning"
          loading={isLoading}
          value={formatMoneyCompact(data?.realized.cogs)}
          hint={data ? formatMoney(data.realized.cogs) : undefined}
          icon={<Package className="h-5 w-5" />}
        />
        <StatCard
          label="مصروف الشحن المستحق"
          tone="info"
          loading={isLoading}
          value={formatMoneyCompact(data?.realized.shippingCost)}
          hint={data ? formatMoney(data.realized.shippingCost) : undefined}
          icon={<Truck className="h-5 w-5" />}
        />
        <StatCard
          label="المصروفات المستحقة"
          tone="warning"
          loading={isLoading}
          value={formatMoneyCompact(data?.realized.expenses)}
          hint={data ? formatMoney(data.realized.expenses) : undefined}
          icon={<Receipt className="h-5 w-5" />}
        />
        <StatCard
          label="Scrap / Loss"
          tone="danger"
          loading={isLoading}
          value={formatMoneyCompact(data?.realized.scrapLoss)}
          hint={data ? formatMoney(data.realized.scrapLoss) : undefined}
          icon={<RotateCcw className="h-5 w-5" />}
        />
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="shadow-[var(--shadow-card)]">
          <CardHeader className="pb-2 pt-3">
            <CardTitle className="type-subheading flex items-center gap-1.5">
              <Clock className="h-4 w-4 text-[var(--warning)]" /> الحركة النقدية
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {isLoading ? (
              <LoadingSkeleton variant="form" rows={2} />
            ) : (
              <>
                <p className="text-[26px] font-bold leading-none tabular-nums text-[var(--warning)]">
                  {formatMoney(
                    (data?.cash.inflow ?? 0) - (data?.cash.outflow ?? 0)
                  )}
                </p>
                <p className="type-caption">
                  داخل {formatMoney(data?.cash.inflow)} · خارج{" "}
                  {formatMoney(data?.cash.outflow)}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2 h-8 w-full"
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
            ) : realizedCost === 0 ? (
              <p className="type-caption py-4 text-center">
                لا توجد تكاليف مسجّلة في هذه الفترة
              </p>
            ) : (
              <div className="space-y-2.5">
                {[
                  {
                    label: "COGS",
                    value: data!.realized.cogs,
                    color: "var(--warning)",
                  },
                  {
                    label: "تكلفة الشحن",
                    value: data!.realized.shippingCost,
                    color: "var(--info)",
                  },
                  {
                    label: "المصروفات",
                    value: data!.realized.expenses,
                    color: "var(--purple)",
                  },
                  {
                    label: "Scrap / Loss",
                    value: data!.realized.scrapLoss,
                    color: "var(--destructive)",
                  },
                ].map(row => {
                  const pct =
                    realizedCost > 0 ? (row.value / realizedCost) * 100 : 0;
                  return (
                    <div key={row.label}>
                      <div className="flex items-baseline justify-between gap-2 text-sm">
                        <span className="font-medium">{row.label}</span>
                        <span className="tabular-nums">
                          {formatMoney(row.value)}
                          <span className="type-caption mr-1.5">
                            {pct.toLocaleString("ar-EG", {
                              maximumFractionDigits: 0,
                            })}
                            %
                          </span>
                        </span>
                      </div>
                      {/* شريط نسبة بسيط بدل مكتبة رسم: الرقم هو المعلومة، والشريط
                          بيساعد العين تقارن بس. */}
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: row.color,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <FinancialMovementChart
        data={data?.movementByDay ?? []}
        loading={isLoading}
      />
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
  data,
  loading,
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
                <span className="h-2.5 w-2.5 rounded-sm bg-[var(--success)]" />{" "}
                داخل
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
                  <div
                    key={d.day}
                    className="flex w-11 shrink-0 flex-col items-center gap-1"
                  >
                    <div className="flex h-32 items-end gap-0.5">
                      <div
                        className="w-4 rounded-t bg-[var(--success)]"
                        style={{
                          height: `${Math.max(2, (d.inflow / max) * 100)}%`,
                        }}
                        title={`داخل: ${formatMoney(d.inflow)}`}
                      />
                      <div
                        className="w-4 rounded-t bg-destructive"
                        style={{
                          height: `${Math.max(2, (d.outflow / max) * 100)}%`,
                        }}
                        title={`خارج: ${formatMoney(d.outflow)}`}
                      />
                    </div>
                    <span
                      className="type-caption whitespace-nowrap tabular-nums"
                      dir="rtl"
                    >
                      {new Date(d.day).toLocaleDateString("ar-EG", {
                        day: "numeric",
                        month: "short",
                      })}
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
