import { useState } from "react";
import { LineChart } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, SectionCard, StatCard, EmptyState, LoadingSkeleton } from "@/components/shared";
import { cairoToday, money } from "./ledgerUi";

/**
 * «قائمة الدخل والأرباح» (المرحلة 7) — من دفتر V3 وحده: قائمة الدخل للفترة، الربح حسب النشاط (قيود الشركة غير الموزعة
 * منفصلة)، والربح حسب المنتج (الأوردرات غير القابلة للتوزيع منفصلة — لا تقسيم مخمّن). الصفحة كلها خلف reports.view_profit
 * (المسار والسيرفر)؛ رفض السيرفر يظهر كرسالة لا كأصفار.
 */
const monthStart = () => `${cairoToday().slice(0, 7)}-01`;

export default function LedgerStatements() {
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(cairoToday);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const enabled = status.data?.enabled === true && valid;
  const stmt = trpc.ledger.reports.incomeStatement.useQuery({ from, to }, { enabled, retry: false });
  const byBiz = trpc.ledger.reports.profitByBusiness.useQuery({ from, to }, { enabled, retry: false });
  const byProd = trpc.ledger.reports.profitByProduct.useQuery({ from, to }, { enabled, retry: false });
  const orderCost = trpc.ledger.reports.orderCost.useQuery({ from, to }, { enabled, retry: false });

  if (status.data && !status.data.enabled) return <EmptyState title="دفتر الحسابات غير مفعّل لهذه الشركة" description="التقارير تبدأ بعد التفعيل." className="m-4" />;
  const s = stmt.data;

  return (
    <div className="space-y-4" dir="rtl" data-testid="ledger-statements">
      <PageHeader title="قائمة الدخل والأرباح" description="من دفتر الحسابات وحده — الإيراد والتكلفة والمصروفات والربح للفترة" icon={<LineChart className="h-5 w-5" aria-hidden="true" />} />
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1 sm:flex-none"><Label htmlFor="st-from" className="text-xs">من</Label><Input id="st-from" type="date" value={from} onChange={e => setFrom(e.target.value)} className="min-h-11 md:min-h-9" dir="ltr" data-testid="statements-from" /></div>
        <div className="min-w-0 flex-1 sm:flex-none"><Label htmlFor="st-to" className="text-xs">إلى</Label><Input id="st-to" type="date" value={to} onChange={e => setTo(e.target.value)} className="min-h-11 md:min-h-9" dir="ltr" data-testid="statements-to" /></div>
      </div>
      {!valid ? <p className="text-sm text-destructive" role="alert">اختر فترة صحيحة (من ≤ إلى)</p>
        : stmt.isLoading ? <LoadingSkeleton variant="cards" rows={4} />
        : stmt.error ? <p className="text-sm text-destructive" role="alert" data-testid="statements-error">{stmt.error.message}</p>
        : s ? (
          <>
            <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="ملخص قائمة الدخل" data-testid="statements-cards">
              <StatCard label="الإيراد" value={`${money(s.revenue.total)} ج.م`} />
              <StatCard label="تكلفة المبيعات" value={`${money(s.cogs)} ج.م`} />
              <StatCard label="مجمل الربح" value={`${money(s.grossProfit)} ج.م`} />
              <StatCard label="صافي الربح" value={`${money(s.netProfit)} ج.م`} tone={Number(s.netProfit) < 0 ? "danger" : "success"} />
            </section>
            <SectionCard title="قائمة الدخل" testId="statements-income">
              <ul className="divide-y divide-border text-sm">
                {s.revenue.lines.map(l => <li key={l.code} className="flex justify-between gap-2 py-1.5"><span>{l.name}</span><span className="tabular-nums">{money(l.amount)}</span></li>)}
                <li className="flex justify-between gap-2 py-1.5 font-medium"><span>تكلفة المبيعات</span><span className="tabular-nums">({money(s.cogs)})</span></li>
                <li className="flex justify-between gap-2 py-1.5 font-semibold"><span>مجمل الربح</span><span className="tabular-nums">{money(s.grossProfit)}</span></li>
                {s.expenses.lines.map(l => <li key={l.code} className="flex justify-between gap-2 py-1.5" data-testid={`statements-expense-${l.code}`}><span>{l.name}</span><span className="tabular-nums">({money(l.amount)})</span></li>)}
                {(s.otherIncome?.lines ?? []).length > 0 && <li className="flex justify-between gap-2 py-1.5 font-semibold" data-testid="statements-other-income"><span>إيرادات أخرى</span><span className="tabular-nums">{money(s.otherIncome.total)}</span></li>}
                {(s.otherIncome?.lines ?? []).map(l => <li key={l.code} className="flex justify-between gap-2 py-1.5" data-testid={`statements-other-${l.code}`}><span>{l.name}</span><span className="tabular-nums">{money(l.amount)}</span></li>)}
                <li className="flex justify-between gap-2 py-1.5 font-bold"><span>صافي الربح</span><span className="tabular-nums">{money(s.netProfit)}</span></li>
              </ul>
            </SectionCard>
            <SectionCard title="الربح حسب النشاط" testId="statements-business">
              <ul className="divide-y divide-border text-sm">
                {(byBiz.data ?? []).map(b => <li key={b.businessId ?? "company"} className="flex flex-wrap justify-between gap-2 py-1.5"><span>{b.name}</span><span className="tabular-nums">إيراد {money(b.revenue.total)} · صافي {money(b.netProfit)}</span></li>)}
              </ul>
            </SectionCard>
            <SectionCard title="الربح حسب المنتج (أوردرات مُسلَّمة)" testId="statements-product">
              <ul className="divide-y divide-border text-sm">
                {(byProd.data?.products ?? []).map(p => <li key={`${p.productId}:${p.name}`} className="flex flex-wrap justify-between gap-2 py-1.5"><span>{p.name} × {p.quantity}</span><span className="tabular-nums">إيراد {money(p.revenue)} · تكلفة {money(p.cogs)} · مجمل {money(p.grossProfit)}</span></li>)}
              </ul>
              {(byProd.data?.unallocated.orders ?? 0) > 0 && <p className="mt-2 text-xs text-muted-foreground" data-testid="statements-unallocated">{byProd.data!.unallocated.orders} أوردر متعدد البنود بلا أسعار بنود كاملة — غير موزّع على المنتجات (إيراد {money(byProd.data!.unallocated.revenue)}).</p>}
            </SectionCard>
            {orderCost.data && (
              <SectionCard title={`تكلفة الأوردرات المسلَّمة (${orderCost.data.count})`} testId="statements-order-cost">
                <p className="text-xs text-muted-foreground">الإيراد − تكلفة البضاعة والتغليف − رسوم الشحن الفعلية من الكشف وأثر المرتجع. الإعلانات والمصروفات العامة لا تُوزَّع على الأوردرات.</p>
                <p className="mt-1 text-sm" data-testid="order-cost-totals">إيراد <b className="tabular-nums">{money(orderCost.data.totals.revenue)}</b> · تكلفة <b className="tabular-nums">{money(orderCost.data.totals.cost)}</b> · مصروفات مرتبطة <b className="tabular-nums">{money(orderCost.data.totals.expenses)}</b> · مساهمة <b className="tabular-nums">{money(orderCost.data.totals.contribution)}</b></p>
                <ul className="mt-2 max-h-96 divide-y divide-border overflow-y-auto text-sm">
                  {orderCost.data.orders.slice(0, 200).map((o: any) => (
                    <li key={o.orderId} className="flex flex-wrap justify-between gap-2 py-1.5" data-testid={`order-cost-${o.orderId}`}>
                      <span dir="ltr">{o.orderNumber}{o.returned ? " ↩" : ""}</span>
                      <span className="tabular-nums">{money(o.revenue)} − {money(o.cost)} − {money(o.expenses)} = <b>{money(o.contribution)}</b></span>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            )}
          </>
        ) : null}
    </div>
  );
}
