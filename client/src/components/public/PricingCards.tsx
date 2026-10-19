import { Check, Sparkles } from "lucide-react";
import { BEST_VALUE_PLAN, SUBSCRIPTION_PLANS, SUBSCRIPTION_PLAN_CODES, type SubscriptionPlanCode } from "@shared/billing";
import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";

/**
 * بطاقات الأسعار — المصدر shared/billing (نفس أرقام السيرفر)؛ المتوسط الشهري والتوفير محسوبين.
 * الأرقام دايمًا غربية (0–9) بتنسيق en-US وdir="ltr" على عنصر الرقم بس — النص العربي حواليه بيفضل RTL.
 * البطاقات بارتفاع واحد، والزر في آخر كل بطاقة (mt-auto) فالأزرار على خط واحد.
 */
export function planMath(code: SubscriptionPlanCode) {
  const p = SUBSCRIPTION_PLANS[code];
  const monthly = SUBSCRIPTION_PLANS.month_1.amount;
  return { ...p, perMonth: Math.round((p.amount / p.months) * 100) / 100, savings: monthly * p.months - p.amount };
}

/** أرقام غربية دايمًا (حتى في الواجهة العربية). */
export const formatNumber = (n: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 }).format(n);
const savingsPercent = (code: SubscriptionPlanCode) => {
  const m = planMath(code);
  return Math.round((m.savings / (SUBSCRIPTION_PLANS.month_1.amount * m.months)) * 100);
};

const Num = ({ children, className = "" }: { children: React.ReactNode; className?: string }) => (
  <bdi dir="ltr" className={`font-en tabular-nums ${className}`}>{children}</bdi>
);

export function PricingCards({ action, compact = false }: { action?: (code: SubscriptionPlanCode) => React.ReactNode; compact?: boolean }) {
  const { t } = useI18n();
  return (
    <ul className="grid items-stretch gap-6 md:grid-cols-3" data-testid="pricing-cards">
      {SUBSCRIPTION_PLAN_CODES.map(code => {
        const m = planMath(code);
        const best = code === BEST_VALUE_PLAN;
        return (
          <li key={code} data-testid={`plan-${code}`} data-best={best || undefined}
            className={`relative flex h-full flex-col rounded-[var(--radius-brand-xl,1.5rem)] border bg-card p-6 transition-shadow sm:p-8 ${best
              ? "border-primary shadow-[0_16px_40px_-20px_color-mix(in_oklab,var(--primary)_55%,transparent)] ring-1 ring-primary"
              : "border-border shadow-[var(--shadow-card)] hover:shadow-[0_12px_32px_-20px_rgba(37,35,41,0.35)]"}`}>
            {best && (
              <span className="absolute inset-x-0 -top-3.5 mx-auto inline-flex w-fit items-center gap-1 whitespace-nowrap rounded-full bg-primary px-3.5 py-1 text-xs font-bold text-primary-foreground shadow-sm">
                <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{t("pricing.bestValue")}
              </span>
            )}
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-lg font-bold text-foreground">{t(`pricing.plan.${code}` as MessageKey)}</h3>
              {m.savings > 0 && (
                <span className="rounded-full bg-[var(--success)]/10 px-2.5 py-0.5 text-xs font-bold text-[var(--success)]">
                  {t("pricing.savePercent")} <Num>{savingsPercent(code)}%</Num>
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{t(`pricing.duration.${code}` as MessageKey)}</p>

            <p className="mt-6 flex items-baseline gap-2" data-testid={`plan-price-${code}`}>
              <Num className="text-5xl font-extrabold leading-none tracking-tight text-foreground">{formatNumber(m.amount)}</Num>
              <span className="text-base font-semibold text-muted-foreground">{t("currency")}</span>
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              {t("pricing.perMonthPrefix")} <Num className="font-semibold text-foreground">{formatNumber(m.perMonth)}</Num> {t("pricing.perMonthSuffix")}
            </p>
            <p className={`mt-1 min-h-5 text-sm font-medium ${m.savings > 0 ? "text-[var(--success)]" : "text-muted-foreground"}`}>
              {m.savings > 0
                ? <>{t("pricing.savePrefix")} <Num>{formatNumber(m.savings)}</Num> {t("pricing.saveSuffix")}</>
                : t("pricing.noSavings")}
            </p>

            {!compact && (
              <ul className="mt-6 space-y-2.5 border-t border-border pt-6 text-sm text-foreground">
                {([1, 2, 3] as const).map(i => (
                  <li key={i} className="flex items-start gap-2"><Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />{t(`pricing.included.${i}` as MessageKey)}</li>
                ))}
              </ul>
            )}
            {action && <div className="mt-auto pt-8">{action(code)}</div>}
          </li>
        );
      })}
    </ul>
  );
}
