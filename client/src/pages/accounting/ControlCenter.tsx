import { useState } from "react";
import { useLocation } from "wouter";
import {
  Wallet, HandCoins, Receipt, Megaphone, Users, PackagePlus,
  TrendingUp, CalendarRange, Clock, Boxes, AlertCircle, RefreshCw,
  Factory,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/shared";
import { moneyTone, toneColor, type Tone } from "@/components/accounting/Surface";

/**
 * لوحة مركز الحسابات.
 *
 * قراءة بحتة — مفيش زرار هنا بيكتب حاجة، فمفيش حركة خزنة ممكن تتولّد منها لا مرة ولا
 * مرتين. كل الأرقام بتيجي من نداء واحد (`accounting.controlCenter`) عشان تبقى من نفس
 * اللحظة؛ لو كل كارت نادى لوحده كانوا هيرجعوا من لحظات مختلفة والمجموع مايطلعش صح.
 *
 * والمصروفات مقسومة لتلاتة مانعة للتداخل على السيرفر: إعلانات ← مرتبات ← باقي المصروفات.
 * الإعلان بيتسجّل كمصروف والمرتب كمان، فلو اتعرضوا كأرقام مستقلة من غير فصل كان اللي
 * يجمعهم هيعدّ نفس الجنيه تلاتة مرات.
 */

/** الجنيه المصري بالعربي. الصفر بيتعرض صفر — مش شرطة ولا خانة فاضية. */
const egp = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString("ar-EG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** يوم القاهرة، مش يوم المتصفح. */
function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

type Period = "اليوم" | "الشهر" | "الرصيد الحالي" | "مستحق";

type Card = {
  label: string;
  period: Period;
  value: number | undefined;
  icon: typeof Wallet;
  /**
   * النغمة **معنى** مش لون. `signed` معناها إن الاتجاه بيتقرر من إشارة الرقم نفسه
   * وقت العرض — زي صافي الربح: أخضر لما يكون موجب وأحمر لما يكون سالب.
   */
  tone: Tone;
  signed?: boolean;
  hint?: string;
};

export default function ControlCenter() {
  const { currentBusinessIds } = useBusinessContext();
  const [dateKey, setDateKey] = useState(cairoToday);

  const q = trpc.accounting.controlCenter.useQuery(
    {
      ...(currentBusinessIds?.length ? { businessIds: currentBusinessIds } : {}),
      dateKey,
    },
    { retry: false }
  );

  const d = q.data;
  const isToday = dateKey === cairoToday();

  const cards: Card[] = [
    { label: "رصيد الخزنة", period: "الرصيد الحالي", value: d?.treasuryBalance, icon: Wallet, tone: "neutral" },
    { label: "التحصيلات", period: "اليوم", value: d?.collectionsToday, icon: HandCoins, tone: "in" },
    { label: "المصروفات", period: "اليوم", value: d?.expensesToday, icon: Receipt, tone: "out",
      hint: "من غير الإعلانات والمرتبات — كل واحد ليه كارت لوحده" },
    { label: "الإعلانات", period: "اليوم", value: d?.advertisingToday, icon: Megaphone, tone: "out" },
    { label: "المرتبات", period: "اليوم", value: d?.salariesToday, icon: Users, tone: "out" },
    { label: "تكلفة البضاعة", period: "اليوم", value: d?.inventoryCostToday, icon: PackagePlus, tone: "neutral",
      hint: "قيمة اللي دخل المخزن — مش فلوس خرجت من الخزنة" },
    { label: "صافي الربح", period: "اليوم", value: d?.netProfitToday, icon: TrendingUp, tone: "neutral", signed: true },
    { label: "صافي الربح", period: "الشهر", value: d?.netProfitMonth, icon: CalendarRange, tone: "neutral", signed: true },
    { label: "مستحق للورشة", period: "مستحق", value: d?.supplierDue, icon: Clock, tone: "due",
      hint: "مش محدود باليوم — اللي عليك لسه عليك" },
    { label: "قيمة المخزون", period: "الرصيد الحالي", value: d?.inventoryValue, icon: Boxes, tone: "neutral" },
    // أرقام المصانع مشتقّة من نفس محرّك كشف الحساب — مفيش رصيد تاني متخزّن للوحة.
    { label: "عليك للمصانع", period: "الرصيد الحالي", value: d?.suppliers?.owedToFactories, icon: Factory, tone: "out",
      hint: "مجموع اللي عليك لكل المصانع" },
    { label: "ليك عند المصانع", period: "الرصيد الحالي", value: d?.suppliers?.owedByFactories, icon: Factory, tone: "in",
      hint: "مصانع دفعتلها زيادة أو رجّعتلها بضاعة" },
    { label: "صافي المصانع", period: "الرصيد الحالي", value: d?.suppliers?.net, icon: Factory, tone: "neutral", signed: true },
  ];

  return (
    <div className="space-y-4" dir="rtl">
      <SectionCard>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[10rem]">
            <Label className="text-xs">اليوم</Label>
            <Input
              type="date"
              className="mt-1 h-10"
              value={dateKey}
              max={cairoToday()}
              onChange={e => setDateKey(e.target.value || cairoToday())}
            />
          </div>
          {!isToday && (
            <Button variant="outline" className="h-10" onClick={() => setDateKey(cairoToday())}>
              ارجع للنهاردة
            </Button>
          )}
          <Button
            variant="outline"
            className="ms-auto h-10 gap-1.5"
            onClick={() => q.refetch()}
            disabled={q.isFetching}
          >
            <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
            تحديث
          </Button>
        </div>
      </SectionCard>

      {/* الخطأ بيتقال، مابيتبلعش. من غير ده الشاشة كانت هتعرض أصفار وكأنها الحقيقة. */}
      {q.isError && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-bold text-destructive">مش قادر أجيب أرقام اليوم</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{q.error?.message}</p>
            <Button size="sm" variant="outline" className="mt-2 h-8" onClick={() => q.refetch()}>
              جرّب تاني
            </Button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {cards.map(c => {
          const Icon = c.icon;
          const v = Number(c.value ?? 0);
          // الرقم اللي ليه اتجاه بياخد لونه من إشارته؛ الباقي بياخد نغمته المعلنة.
          const tone = c.signed ? moneyTone(v) : c.tone;
          return (
            <div key={`${c.label}-${c.period}`} className="rounded-lg border bg-card p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: toneColor(tone) }} />
                <span className="truncate">{c.label}</span>
                {/* الفترة جنب الاسم دايمًا — رقم من غير فترة مالوش معنى */}
                <span className="ms-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]">
                  {c.period}
                </span>
              </div>
              <p
                className="mt-1.5 text-lg font-black tabular-nums"
                style={{ color: toneColor(tone) }}
              >
                {q.isLoading ? (
                  <span className="inline-block h-5 w-24 animate-pulse rounded bg-muted" />
                ) : q.isError ? (
                  <span className="text-sm font-normal text-muted-foreground">—</span>
                ) : (
                  <>
                    {c.signed && v > 0 ? "+" : ""}
                    {egp(v)}
                    <span className="ms-1 text-xs font-normal text-muted-foreground">ج.م</span>
                  </>
                )}
              </p>
              {c.hint && !q.isLoading && (
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{c.hint}</p>
              )}
            </div>
          );
        })}
      </div>

      {/* إثبات إن التقسيم مانع للتداخل، معروض للمحاسب مش مخبّي في اختبار */}
      {!q.isLoading && !q.isError && d && (
        <p className="text-xs text-muted-foreground">
          إجمالي المدفوع النهاردة{" "}
          <strong className="tabular-nums text-foreground">{egp(d.expensesTotalPaidToday)}</strong> ج.م
          {" = "}مصروفات {egp(d.expensesToday)} + إعلانات {egp(d.advertisingToday)} + مرتبات{" "}
          {egp(d.salariesToday)}
        </p>
      )}

      <ActionItems />
      <RecentMovements />
    </div>
  );
}

// ───────────────────────── محتاج إجراء ─────────────────────────

/**
 * البنود اللي مستنية منك تصرّف.
 *
 * **مش كروت إحصائية.** كل سطر هنا معناه «افتح ده واعمل حاجة»، ولو مفيش حاجة مستنية
 * القسم بيختفي خالص — القايمة الفاضية خبر كويس مش مساحة فاضية تتملي.
 *
 * الأصفار مابتتعرضش عن قصد: «مصروف مستحق: ٠» بند بيطلب منك تعمل ولا حاجة.
 */
function ActionItems() {
  const [, navigate] = useLocation();
  const { currentBusinessIds } = useBusinessContext();
  const q = trpc.accounting.actionItems.useQuery(
    currentBusinessIds?.length ? { businessIds: currentBusinessIds } : {}
  );
  const suppliers = trpc.suppliers.dashboardTotals.useQuery(
    currentBusinessIds?.length ? { businessIds: currentBusinessIds } : {}
  );

  // **السلسلة الآمنة كاملة.** `q.data?.unpaidExpenses.count` بتحمي `q.data` بس —
  // ولو الرد رجع من غير `unpaidExpenses`، القراءة بتوقّع اللوحة كلها بشاشة بيضا.
  // ده نفس الغلط اللي وقّع صفحة الحسابات قبل كده، ووقع هنا تاني.
  const items = [
    q.data?.unpaidExpenses?.count
      ? {
          key: "expenses",
          label: `${q.data?.unpaidExpenses?.count} مصروف مستحق`,
          detail: `${egp(q.data?.unpaidExpenses?.amount)} ج.م لسه ماخرجتش من الخزنة`,
          to: "/expenses",
        }
      : null,
    suppliers.data?.owedToFactories
      ? {
          key: "factories",
          label: "مصانع ليها مستحقات",
          detail: `${egp(suppliers.data.owedToFactories)} ج.م عليك`,
          to: "/supplier-statements",
        }
      : null,
    q.data?.unfinishedPayroll?.count
      ? {
          key: "payroll",
          label: `${q.data?.unfinishedPayroll?.count} دورة مرتبات مش مكتملة`,
          detail: `${egp(q.data?.unfinishedPayroll?.amount)} ج.م`,
          to: "/salary-preparation",
        }
      : null,
  ].filter(Boolean) as { key: string; label: string; detail: string; to: string }[];

  if (q.isLoading || items.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card">
      <h2 className="border-b px-4 py-3 text-sm font-bold">محتاج إجراء</h2>
      <ul className="divide-y">
        {items.map(item => (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => navigate(item.to)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3 text-right hover:bg-muted/50"
            >
              <span>
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="block text-xs text-muted-foreground">{item.detail}</span>
              </span>
              {/* كهرماني: مستحق ومحتاج إجراء — مش أحمر، دي مش كارثة. */}
              <span
                className="shrink-0 rounded-full px-2 py-1 text-[11px]"
                style={{ background: "var(--warning-soft, #fef3c7)", color: "var(--warning, #92400e)" }}
              >
                افتح
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ───────────────────────── آخر الحركات ─────────────────────────

/**
 * تايم‌لاين بسيط لآخر حركات الفلوس.
 *
 * نفس مصدر «سجل الخزنة» — مفيش استعلام تاني ومفيش تعريف تاني لـ«حركة». الفرق إن ده
 * آخر عشرة بس، عشان اللوحة تقول «إيه اللي حصل» من غير ما تبقى جدول تاني.
 */
function RecentMovements() {
  const { currentBusinessIds } = useBusinessContext();
  const q = trpc.accounting.treasuryHistory.useQuery({
    ...(currentBusinessIds?.length ? { businessIds: currentBusinessIds } : {}),
    limit: 10,
  });
  const rows = q.data ?? [];
  if (q.isLoading || rows.length === 0) return null;

  return (
    <section className="rounded-lg border bg-card">
      <h2 className="border-b px-4 py-3 text-sm font-bold">آخر الحركات</h2>
      <ul className="divide-y">
        {rows.map((row: any) => {
          const isIn = row.direction === "in";
          return (
            <li key={row.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="min-w-0">
                <span className="block truncate text-sm">{row.description}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {new Date(row.transactionDate).toLocaleString("ar-EG", {
                    day: "numeric",
                    month: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </span>
              <span className="shrink-0 text-left">
                {/* أخضر داخل، أحمر خارج — قاعدة واحدة في كل الشاشات. */}
                <span
                  className="block text-sm font-bold tabular-nums"
                  style={{ color: isIn ? "var(--success)" : "var(--destructive)" }}
                >
                  {isIn ? "+" : "−"}
                  {egp(Number(row.amount))}
                </span>
                <span className="block text-[11px] tabular-nums text-muted-foreground">
                  الرصيد {egp(Number(row.balanceAfter))}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
