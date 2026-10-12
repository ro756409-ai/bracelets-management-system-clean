import { useMemo, useState } from "react";
import { FileText, Undo2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePermissions } from "@/hooks/usePermission";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, SectionCard, StatCard, EmptyState, LoadingSkeleton, StatusBadge } from "@/components/shared";
import { ReverseDialog } from "./LedgerTransactions";
import { balanceText, cairoToday, kindLabel, money, transactionAmount } from "./ledgerUi";

/**
 * «التقرير اليومي» (المرحلة 2) — كل الأرقام من ledger.reports.daily داخل نطاق القراءة على السيرفر:
 * الإيراد، المصروفات حسب التصنيف (بعد صافي العكس)، المشتريات (أصل مخزون — ليست مصروفًا)، التحويلات، والنقدية المتاحة
 * وذمة COD حتى نهاية اليوم. الربح يظهر فقط لمن يملك reports.view_profit — وإلا لا بطاقة ربح أصلًا (لا صفر).
 * الرصيد المحجوب عن نطاقك يظهر «محجوب عن نطاقك»، وما قبل Go-live «غير متاح». الإلغاء بقيد عكسي (ledger.reverse) فقط.
 */
type Row = { id: number; effectiveDate: string; kind: string; description: string; sourceBusinessId: number | null; actorName: string | null; actorType: string;
  reversalOfTransactionId: number | null; reversedByTransactionId: number | null; entries: { accountId: number; side: "debit" | "credit"; amount: string; code: string; name: string }[] };

export default function LedgerReport() {
  const { has } = usePermissions();
  const [date, setDate] = useState(cairoToday());
  const [businessId, setBusinessId] = useState<string>("");
  const [reverseTarget, setReverseTarget] = useState<Row | null>(null);
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const enabled = status.data?.enabled === true;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);
  const report = trpc.ledger.reports.daily.useQuery({ date, businessId: businessId ? Number(businessId) : undefined }, { enabled: enabled && validDate, retry: false });
  const businesses = trpc.ledger.businesses.list.useQuery(undefined, { enabled, retry: false, staleTime: 60_000 });
  const bizName = useMemo(() => new Map((businesses.data ?? []).map(b => [b.id, b.name])), [businesses.data]);
  const canReverse = has("ledger.reverse");
  const r = report.data;

  if (status.data && !status.data.tablesPresent) return <EmptyState title="دفتر الحسابات غير مهيأ بعد" description="جداول الدفتر لم تُنشأ على هذه البيئة (الترحيلة 0040)." className="m-4" />;
  if (status.data && !status.data.enabled) return <EmptyState title="دفتر الحسابات غير مفعّل لهذه الشركة" description="التقرير اليومي يبدأ بعد التفعيل من المالك." className="m-4" />;

  const rows = (r?.transactions.rows ?? []) as unknown as Row[];
  const unavailable = r?.beforeGoLive ? "غير متاح (قبل بداية الدفتر)" : null;

  return (
    <div className="space-y-4" dir="rtl" data-testid="ledger-report">
      <PageHeader title="التقرير اليومي" description="حركات اليوم ومصروفاته حسب التصنيف والنقدية المتاحة — من دفتر الحسابات فقط" icon={<FileText className="h-5 w-5" aria-hidden="true" />} />

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 sm:flex-none">
          <Label htmlFor="ledger-report-date" className="text-xs">اليوم</Label>
          <Input id="ledger-report-date" type="date" value={date} onChange={e => setDate(e.target.value)} className="min-h-11 md:min-h-9" dir="ltr" data-testid="ledger-report-date" />
        </div>
        {(businesses.data?.length ?? 0) > 1 && (
          <div className="min-w-0 flex-1 sm:flex-none">
            <Label htmlFor="ledger-report-business" className="text-xs">النشاط</Label>
            <select id="ledger-report-business" value={businessId} onChange={e => setBusinessId(e.target.value)} className="block min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm md:min-h-9" data-testid="ledger-report-business">
              <option value="">كل الأنشطة في نطاقك</option>
              {(businesses.data ?? []).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
      </div>

      {!validDate ? <p className="text-sm text-destructive" role="alert">اختر تاريخًا صحيحًا</p>
        : report.isLoading ? <LoadingSkeleton variant="cards" rows={4} />
        : report.error ? <p className="text-sm text-destructive" role="alert">{report.error.message}</p>
        : r ? (
          <>
            {r.beforeGoLive && <p className="rounded-[var(--radius-brand-md)] border border-border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="ledger-report-before-golive">هذا اليوم قبل بداية العمل بالدفتر — لا أرصدة ولا أرقام دفتر له.</p>}
            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="ملخص اليوم" data-testid="ledger-report-cards">
              <StatCard label="الإيراد" value={`${money(r.revenue)} ج.م`} />
              <StatCard label="المصروفات التشغيلية" value={`${money(r.expenses.total)} ج.م`} hint="بعد صافي الإلغاء بالعكس" />
              <StatCard label="مشتريات بضاعة/خامات" value={`${money(r.purchases)} ج.م`} hint="أصل مخزون — ليست مصروفًا" />
              <StatCard label="تحويلات بين الخزن" value={`${money(r.transfers)} ج.م`} />
              <StatCard label="النقدية المتاحة نهاية اليوم" value={unavailable ?? balanceText(r.availableCash)} hint={r.availableCash == null && !unavailable ? "خزن مشتركة مع أنشطة أخرى — للمالك ومدير الحسابات" : "خزن + بنوك + محافظ"} />
              <StatCard label="ذمة COD نهاية اليوم" value={unavailable ?? balanceText(r.codReceivable)} hint="على شركات الشحن — ليست نقدية" />
              {!r.profitHidden && <StatCard label="صافي اليوم (إيراد − مصروف − تكلفة)" value={r.profit == null ? "غير متاح" : `${money(r.profit)} ج.م`} />}
            </section>

            <SectionCard title="المصروفات حسب التصنيف" testId="ledger-report-categories">
              {r.expenses.byCategory.length === 0 ? <p className="text-sm text-muted-foreground">لا مصروفات في هذا اليوم ضمن نطاقك.</p> : (
                <ul className="divide-y divide-border text-sm">
                  {r.expenses.byCategory.map(c => (
                    <li key={c.accountId} className="flex items-center justify-between gap-2 py-2" data-testid={`ledger-report-category-${c.code}`}>
                      <span>{c.name}</span><span className="font-semibold tabular-nums">{money(c.amount)} ج.م</span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard title={`حركات اليوم (${r.transactions.total})`} testId="ledger-report-transactions">
              {rows.length === 0 ? <p className="text-sm text-muted-foreground">لا حركات في هذا اليوم ضمن نطاقك.</p> : (
                <ul className="divide-y divide-border text-sm">
                  {rows.map(t => (
                    <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`ledger-report-tx-${t.id}`}>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusBadge status={t.kind} label={kindLabel(t.kind)} tone={t.kind === "reversal" ? "warning" : "info"} size="sm" icon={null} />
                          <span className="truncate font-medium">{t.description}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{t.sourceBusinessId != null ? bizName.get(t.sourceBusinessId) ?? "نشاط" : "الشركة"} · {t.actorName ?? "النظام"}{t.reversedByTransactionId != null ? ` · معكوسة بـ #${t.reversedByTransactionId}` : ""}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <span className="font-semibold tabular-nums">{money(transactionAmount(t.entries))} ج.م</span>
                        {canReverse && t.kind !== "reversal" && t.reversedByTransactionId == null && (
                          <Button variant="ghost" size="sm" className="min-h-11 text-destructive md:min-h-9" onClick={() => setReverseTarget(t)} data-testid={`ledger-report-reverse-${t.id}`}><Undo2 className="h-4 w-4 ml-1" aria-hidden="true" /> إلغاء بقيد عكسي</Button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </>
        ) : null}

      {reverseTarget && <ReverseDialog row={reverseTarget as any} onClose={() => setReverseTarget(null)} onDone={async () => { await report.refetch(); }} />}
    </div>
  );
}
