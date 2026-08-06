import { useState } from "react";
import {
  Wallet, HandCoins, Receipt, Megaphone, Users, PackagePlus,
  TrendingUp, CalendarRange, Clock, Boxes, AlertCircle, RefreshCw,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/shared";

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
  tone: string;
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
    { label: "رصيد الخزنة", period: "الرصيد الحالي", value: d?.treasuryBalance, icon: Wallet, tone: "var(--info)" },
    { label: "التحصيلات", period: "اليوم", value: d?.collectionsToday, icon: HandCoins, tone: "var(--success)" },
    { label: "المصروفات", period: "اليوم", value: d?.expensesToday, icon: Receipt, tone: "var(--destructive)",
      hint: "من غير الإعلانات والمرتبات — كل واحد ليه كارت لوحده" },
    { label: "الإعلانات", period: "اليوم", value: d?.advertisingToday, icon: Megaphone, tone: "var(--purple)" },
    { label: "المرتبات", period: "اليوم", value: d?.salariesToday, icon: Users, tone: "var(--warning)" },
    { label: "تكلفة البضاعة", period: "اليوم", value: d?.inventoryCostToday, icon: PackagePlus, tone: "var(--info)",
      hint: "قيمة اللي دخل المخزن — مش فلوس خرجت من الخزنة" },
    { label: "صافي الربح", period: "اليوم", value: d?.netProfitToday, icon: TrendingUp, tone: "var(--success)", signed: true },
    { label: "صافي الربح", period: "الشهر", value: d?.netProfitMonth, icon: CalendarRange, tone: "var(--success)", signed: true },
    { label: "مستحق للورشة", period: "مستحق", value: d?.supplierDue, icon: Clock, tone: "var(--warning)",
      hint: "مش محدود باليوم — اللي عليك لسه عليك" },
    { label: "قيمة المخزون", period: "الرصيد الحالي", value: d?.inventoryValue, icon: Boxes, tone: "var(--purple)" },
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
          return (
            <div key={`${c.label}-${c.period}`} className="rounded-lg border bg-card p-3">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: c.tone }} />
                <span className="truncate">{c.label}</span>
                {/* الفترة جنب الاسم دايمًا — رقم من غير فترة مالوش معنى */}
                <span className="ms-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px]">
                  {c.period}
                </span>
              </div>
              <p className="mt-1.5 text-lg font-black tabular-nums">
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
    </div>
  );
}
