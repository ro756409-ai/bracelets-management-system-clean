import { useRef } from "react";
import { CreditCard, Landmark, Info } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { PageHeader, SectionCard, StatusBadge, EmptyState, ErrorState, LoadingSkeleton, type StatusTone } from "@/components/shared";
import { PricingCards } from "@/components/public/PricingCards";
import { useDocumentLang, useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import type { BillingState, SubscriptionPlanCode } from "@shared/billing";
import { AR_LOCALE } from "@/lib/format";

/**
 * صفحة الاشتراك للمالك (subscription.status) — عرض فقط + بدء دفع أونلاين **لو** فيه مزوّد شغال (حاليًا لأ: Paymob/Fawry BLOCKED)،
 * وإلا تعليمات الدفع بالتحويل. التفعيل نفسه من أدمن المنصة بعد التأكد. العلم مقفول ⇒ رسالة إن مفيش أي إجراء مطلوب.
 */
const STATE_TONE: Record<BillingState, StatusTone> = { pending_payment: "warning", active: "success", grace: "amber", expired: "danger" };
const PAY_TONE: Record<string, StatusTone> = { pending: "warning", succeeded: "success", failed: "danger", refunded: "neutral" };

export default function Subscription() {
  useDocumentLang();
  const { lang, dir, t } = useI18n();
  const q = trpc.subscription.status.useQuery(undefined, { retry: false });
  const checkout = trpc.subscription.createCheckout.useMutation();
  const keys = useRef(new Map<SubscriptionPlanCode, string>());
  const date = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleString(lang === "ar" ? AR_LOCALE : "en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");
  const money = (minor: number) => `${new Intl.NumberFormat(lang === "ar" ? AR_LOCALE : "en-US").format(minor / 100)} ${t("currency")}`;

  const pay = async (code: SubscriptionPlanCode) => {
    // نفس المفتاح لإعادة الضغط على نفس الخطة في نفس الزيارة ⇒ نفس الدفع (مفيش دفعين).
    if (!keys.current.has(code)) keys.current.set(code, crypto.randomUUID());
    try {
      const r = await checkout.mutateAsync({ planCode: code, idempotencyKey: keys.current.get(code)! });
      const url = r.checkout && "redirectUrl" in r.checkout ? r.checkout.redirectUrl : undefined;
      if (url && /^https:\/\//.test(url)) window.location.href = url;
      else { toast.success(t("sub.payment.pending")); q.refetch(); }
    } catch (e: any) { toast.error(e?.message ?? t("sub.error")); }
  };

  const body = (() => {
    if (q.isLoading) return <LoadingSkeleton variant="cards" rows={2} />;
    if (q.error?.data?.code === "FORBIDDEN") return <EmptyState title={t("sub.ownerOnly")} icon={<Info className="h-6 w-6" />} />;
    if (q.error || !q.data) return <ErrorState title={t("sub.error")} onRetry={() => q.refetch()} retrying={q.isFetching} />;
    const d = q.data;
    if (!d.enabled) return <SectionCard testId="sub-disabled"><p className="text-sm text-muted-foreground">{t("sub.disabled")}</p></SectionCard>;
    if (!d.enrolled || !d.status) return <SectionCard testId="sub-not-enrolled"><p className="text-sm text-muted-foreground">{t("sub.notEnrolled")}</p></SectionCard>;
    const s = d.status;
    const stateDesc = t(`sub.state.${s.state}.desc` as MessageKey, { date: date(s.paidUntil), grace: date(s.graceEndsAt) });
    return (
      <div className="space-y-5">
        <SectionCard testId="sub-state" title={<span className="flex items-center gap-2">{t("sub.title")} <StatusBadge status={s.state} label={t(`sub.state.${s.state}` as MessageKey)} tone={STATE_TONE[s.state]} /></span>}>
          <p className="text-sm text-foreground" role="status">{stateDesc}</p>
          <p className="mt-2 text-xs text-muted-foreground">{t("sub.renewRule")}</p>
        </SectionCard>

        <SectionCard title={t("sub.plans.title")} testId="sub-plans">
          <PricingCards action={code => d.online
            ? <Button className="min-h-11 w-full" onClick={() => pay(code)} disabled={checkout.isPending}><CreditCard className="h-4 w-4" aria-hidden="true" />{t("sub.pay.online")}</Button>
            : null} />
          <div className="mt-5 flex gap-3 rounded-[var(--radius-brand-md)] border border-border bg-muted p-4" data-testid="sub-manual">
            <Landmark className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">{t("sub.pay.manual.title")}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t("sub.pay.manual.body")}</p>
              {!d.online && <p className="mt-1 text-xs text-muted-foreground">{t("sub.pay.online.unavailable")}</p>}
            </div>
          </div>
        </SectionCard>

        <SectionCard title={t("sub.history.title")} testId="sub-history" flush>
          {d.payments.length === 0
            ? <p className="p-5 text-sm text-muted-foreground">{t("sub.history.empty")}</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="bg-muted/60 text-xs text-muted-foreground">
                    <tr>{(["date", "plan", "amount", "status", "reference"] as const).map(c => <th key={c} scope="col" className="px-4 py-2.5 text-start font-medium">{t(`sub.col.${c}` as MessageKey)}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {d.payments.map(p => (
                      <tr key={p.id}>
                        <td className="px-4 py-3 tabular-nums">{date(p.succeededAt ?? p.createdAt)}</td>
                        <td className="px-4 py-3">{t(`pricing.plan.${p.planCode}` as MessageKey)}</td>
                        <td className="px-4 py-3 tabular-nums">{money(p.amountMinor)}</td>
                        <td className="px-4 py-3"><StatusBadge status={p.status} label={t(`sub.payment.${p.status}` as MessageKey)} tone={PAY_TONE[p.status] ?? "neutral"} size="sm" /></td>
                        <td className="px-4 py-3 font-en" dir="ltr">{p.paymentReference ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </SectionCard>
      </div>
    );
  })();

  return (
    <div lang={lang} dir={dir} className="space-y-6" data-testid="subscription-page">
      <PageHeader title={t("sub.title")} description={t("sub.subtitle")} icon={<CreditCard className="h-5 w-5" />} />
      {body}
    </div>
  );
}
