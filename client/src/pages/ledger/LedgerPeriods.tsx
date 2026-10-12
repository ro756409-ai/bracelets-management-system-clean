import { useState } from "react";
import { CalendarCheck, Lock, LockOpen, Undo2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePermissions } from "@/hooks/usePermission";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, SectionCard, StatusBadge, EmptyState, LoadingSkeleton } from "@/components/shared";
import { PeriodDialog } from "./LedgerTransactions";
import { accountKindLabel, cairoToday, money } from "./ledgerUi";

/**
 * «مراجعة الشهر وإقفاله» — الحركات تُرحّل فورًا عند إدخالها؛ الاعتماد = مراجعة حركة الشهر ثم إقفاله بملاحظة مراجعة
 * إلزامية تُسجَّل باسم الفاعل. إعادة الفتح للمالك فقط بسبب مسجّل. كل الأرقام من period.review (نطاق القراءة على
 * السيرفر) — لا علامة «معتمدة» ولا «لم تُراجع» لكل حركة لأن لا مصدر بيانات لها.
 */
type Review = {
  period: string; status: "open" | "locked";
  events: { action: "lock" | "reopen"; reason: string; actorName: string | null; createdAt: string | Date }[];
  accounts: { accountId: number; code: string; name: string; kind: string; debit: string; credit: string; transactions: number }[];
  businesses: { businessId: number | null; name: string | null; debit: string; credit: string }[];
  transactionsCount: number;
  reversals: { transactionId: number; reversalOfTransactionId: number | null; description: string; effectiveDate: string; actorName: string | null }[];
};
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const fmtDateTime = (d: string | Date) => new Date(d).toLocaleString("ar-EG", { timeZone: "Africa/Cairo", dateStyle: "medium", timeStyle: "short" });

export default function LedgerPeriods() {
  const { has } = usePermissions();
  const [period, setPeriod] = useState(() => cairoToday().slice(0, 7));
  const [dialog, setDialog] = useState<"lock" | "reopen" | null>(null);
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const enabled = status.data?.enabled === true;
  const valid = PERIOD_RE.test(period);
  const review = trpc.ledger.period.review.useQuery({ period }, { enabled: enabled && valid, retry: false });
  const periods = trpc.ledger.periods.list.useQuery(undefined, { enabled, retry: false });
  const r = review.data as unknown as Review | undefined;
  const canLock = has("ledger.period.lock");
  const canReopen = has("ledger.period.reopen");

  if (status.data && !status.data.tablesPresent) return <EmptyState title="دفتر الحسابات غير مهيأ بعد" description="جداول الدفتر لم تُنشأ على هذه البيئة (الترحيلة 0040)." className="m-4" />;
  if (status.data && !status.data.enabled) return <EmptyState title="دفتر الحسابات غير مفعّل لهذه الشركة" description="مراجعة الشهور تبدأ بعد التفعيل من المالك." className="m-4" />;

  const recorded = ((periods.data ?? []) as unknown as { period: string; status: "open" | "locked" }[]).slice(0, 12);

  return (
    <div className="space-y-4" dir="rtl" data-testid="ledger-periods-page">
      <PageHeader title="مراجعة الشهر وإقفاله" description="الحركات تُرحّل فورًا عند إدخالها — الاعتماد هو مراجعة الشهر ثم إقفاله بملاحظة تُسجَّل باسمك" icon={<CalendarCheck className="h-5 w-5" aria-hidden="true" />} />

      <p className="rounded-[var(--radius-brand-md)] border border-border bg-muted/40 p-3 text-xs leading-6 text-muted-foreground" data-testid="ledger-periods-explainer">
        كل حركة تُرحّل فور إدخالها وتظهر في الأرصدة مباشرة. راجع حركة الشهر أدناه، ثم اقفله بملاحظة مراجعة إلزامية — بعد الإقفال لا تُسجَّل حركات بتاريخ داخله. إعادة فتح شهر مقفل للمالك فقط وبسبب يُسجَّل مع اسمه.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 sm:flex-none">
          <Label htmlFor="ledger-review-period" className="text-xs">الشهر</Label>
          <Input id="ledger-review-period" type="month" value={period} onChange={e => setPeriod(e.target.value)} className="min-h-11 md:min-h-9" dir="ltr" data-testid="ledger-review-period" />
        </div>
        {recorded.length > 0 && (
          <div className="flex min-w-0 flex-wrap gap-1" aria-label="شهور مسجّلة">
            {recorded.map(p => (
              <button key={p.period} type="button" onClick={() => setPeriod(p.period)} aria-pressed={p.period === period}
                className={`inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-brand-pill)] border px-3 text-xs md:min-h-8 ${p.period === period ? "border-primary text-primary" : "border-border text-muted-foreground"}`}
                data-testid={`ledger-review-chip-${p.period}`}>
                {p.status === "locked" ? <Lock className="h-3 w-3" aria-hidden="true" /> : <LockOpen className="h-3 w-3" aria-hidden="true" />}<span dir="ltr">{p.period}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!valid ? <p className="text-sm text-destructive" role="alert">اختر الشهر بصيغة YYYY-MM</p>
        : review.isLoading ? <LoadingSkeleton variant="table" rows={4} />
        : review.error ? <p className="text-sm text-destructive" role="alert">{review.error.message}</p>
        : r ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid="ledger-review-summary">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono font-semibold" dir="ltr">{r.period}</span>
                <StatusBadge status={r.status} label={r.status === "locked" ? "مقفل" : "مفتوح"} tone={r.status === "locked" ? "warning" : "success"} size="sm"
                  icon={r.status === "locked" ? <Lock className="h-3 w-3" aria-hidden="true" /> : <LockOpen className="h-3 w-3" aria-hidden="true" />} />
                <span className="text-muted-foreground" data-testid="ledger-review-count">{r.transactionsCount} حركة</span>
                <span className="text-muted-foreground">· {r.reversals.length} عكس</span>
              </div>
              <div className="flex gap-2">
                {r.status === "open" && canLock && <Button className="min-h-11 md:min-h-9" onClick={() => setDialog("lock")} data-testid="ledger-review-lock"><Lock className="h-4 w-4 ml-1" aria-hidden="true" /> مراجعة وإقفال</Button>}
                {r.status === "locked" && canReopen && <Button variant="outline" className="min-h-11 md:min-h-9" onClick={() => setDialog("reopen")} data-testid="ledger-review-reopen"><LockOpen className="h-4 w-4 ml-1" aria-hidden="true" /> إعادة فتح</Button>}
              </div>
            </div>

            <SectionCard title="حركة الحسابات في الشهر" testId="ledger-review-accounts">
              {r.accounts.length === 0 ? <EmptyState title="لا حركات في هذا الشهر ضمن نطاقك" /> : (
                <>
                  {/* الهاتف: صف لكل حساب بلا تمرير أفقي */}
                  <ul className="divide-y divide-border text-sm sm:hidden">
                    {r.accounts.map(a => (
                      <li key={a.accountId} className="py-2" data-testid={`ledger-review-account-${a.code}`}>
                        <div className="flex items-baseline justify-between gap-2"><span className="font-medium">{a.name}</span><span className="text-xs text-muted-foreground">{a.transactions} حركة</span></div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs tabular-nums text-muted-foreground"><span>مدين {money(a.debit)}</span><span>دائن {money(a.credit)}</span><span>{accountKindLabel(a.kind)}</span></div>
                      </li>
                    ))}
                  </ul>
                  <table className="hidden w-full text-sm sm:table">
                    <thead><tr className="border-b border-border text-xs text-muted-foreground"><th className="px-1 py-2 text-start font-medium">الحساب</th><th className="px-1 py-2 text-end font-medium">مدين</th><th className="px-1 py-2 text-end font-medium">دائن</th><th className="px-1 py-2 text-end font-medium">حركات</th></tr></thead>
                    <tbody>
                      {r.accounts.map(a => (
                        <tr key={a.accountId} className="border-b border-border last:border-0">
                          <td className="px-1 py-2"><span className="font-medium">{a.name}</span> <span className="text-xs text-muted-foreground">{accountKindLabel(a.kind)}</span></td>
                          <td className="whitespace-nowrap px-1 py-2 text-end tabular-nums">{money(a.debit)}</td>
                          <td className="whitespace-nowrap px-1 py-2 text-end tabular-nums">{money(a.credit)}</td>
                          <td className="px-1 py-2 text-end tabular-nums">{a.transactions}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </SectionCard>

            {r.businesses.length > 0 && (
              <SectionCard title="حسب النشاط" testId="ledger-review-businesses">
                <ul className="divide-y divide-border text-sm">
                  {r.businesses.map(b => (
                    <li key={b.businessId ?? "company"} className="flex flex-wrap items-center justify-between gap-2 py-2">
                      <span>{b.businessId == null ? "مستوى الشركة" : b.name ?? "نشاط"}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">مدين {money(b.debit)} · دائن {money(b.credit)}</span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}

            <SectionCard title={<span className="inline-flex items-center gap-2"><Undo2 className="h-4 w-4" aria-hidden="true" /> العكوس في الشهر</span>} testId="ledger-review-reversals">
              {r.reversals.length === 0 ? <p className="text-sm text-muted-foreground">لا عكوس في هذا الشهر.</p> : (
                <ul className="divide-y divide-border text-sm">
                  {r.reversals.map(x => (
                    <li key={x.transactionId} className="py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{x.description}</span><span className="text-xs tabular-nums text-muted-foreground" dir="ltr">{x.effectiveDate}</span></div>
                      <p className="text-xs text-muted-foreground">الحركة #{x.transactionId}{x.reversalOfTransactionId != null ? ` تعكس #${x.reversalOfTransactionId}` : ""} · {x.actorName ?? "النظام"}</p>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title="سجل الإقفال وإعادة الفتح" testId="ledger-review-events">
              {r.events.length === 0 ? <p className="text-sm text-muted-foreground">لم يُقفل هذا الشهر بعد.</p> : (
                <ol className="space-y-2 text-sm">
                  {r.events.map((ev, i) => (
                    <li key={i} className="rounded-[var(--radius-brand-md)] border border-border p-2" data-testid={`ledger-review-event-${i}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{ev.action === "lock" ? "إقفال" : "إعادة فتح"} — {ev.actorName ?? "غير معروف"}</span>
                        <span className="text-xs text-muted-foreground">{fmtDateTime(ev.createdAt)}</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{ev.action === "lock" ? "ملاحظة المراجعة" : "السبب"}: {ev.reason}</p>
                    </li>
                  ))}
                </ol>
              )}
            </SectionCard>
          </>
        ) : null}

      {dialog && r && <PeriodDialog period={r.period} action={dialog} onClose={() => setDialog(null)} onDone={async () => { await Promise.all([review.refetch(), periods.refetch()]); }} />}
    </div>
  );
}
