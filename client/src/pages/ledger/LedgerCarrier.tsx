import { useMemo, useState } from "react";
import { Truck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader, SectionCard, EmptyState, StatusBadge } from "@/components/shared";
import { toast } from "sonner";
import { parseSettlementCsv } from "@shared/carrierSettlement";
import { cairoToday, money, type UiAccount } from "./ledgerUi";

/**
 * «تسوية شركة الشحن» (المرحلة 3) — للمالك ومدير الحسابات (السيرفر يرفض نطاق النشاط الواحد):
 * كشف بصيغة موحّدة (shipment,cod,fees,net) → معاينة محلية بنفس محلل السيرفر → تسوية كل شحنة مرة واحدة (مفتاح دائم)،
 * والرسوم منفصلة، والغامض للمراجعة بلا قيد. ثم «التحويل الفعلي» بمبلغ يكتبه المستخدم من كشف البنك ويُقبل فقط إن ساوى الصافي.
 */
const STATUS_LABEL: Record<string, { label: string; tone: "success" | "info" | "warning" | "danger" }> = {
  posted: { label: "سُوّيت", tone: "success" }, replay: { label: "مسجّلة بالفعل", tone: "info" },
  already_settled: { label: "مسوّاة من قبل", tone: "warning" }, review: { label: "مراجعة", tone: "danger" },
};

export default function LedgerCarrier() {
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const accounts = trpc.ledger.accounts.list.useQuery(undefined, { enabled: status.data?.enabled === true, retry: false });
  const settle = trpc.ledger.carrier.settle.useMutation();
  const payout = trpc.ledger.carrier.payout.useMutation();
  const [ref, setRef] = useState("");
  const [date, setDate] = useState(cairoToday());
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [payDate, setPayDate] = useState(cairoToday());
  const [payAmount, setPayAmount] = useState("");
  const [payAccount, setPayAccount] = useState("BANK_MAIN");
  const preview = useMemo(() => (csv.trim() ? parseSettlementCsv(csv) : null), [csv]);
  const cashAccounts = ((accounts.data ?? []) as unknown as UiAccount[]).filter(a => ["cash", "bank", "wallet"].includes(a.kind));

  if (status.data && !status.data.enabled) return <EmptyState title="دفتر الحسابات غير مفعّل لهذه الشركة" description="التسوية تبدأ بعد التفعيل." className="m-4" />;

  const runSettle = async () => {
    if (busy || settle.isPending) return;
    if (!preview || preview.lines.length === 0) return toast.error("لا أسطر صالحة في الكشف");
    setBusy(true);
    try { const r = await settle.mutateAsync({ statementRef: ref.trim(), statementDate: date, csv }); setResult(r); toast.success("عولج الكشف — راجع حالة كل سطر"); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const runPayout = async () => {
    if (busy || payout.isPending) return;
    setBusy(true);
    try { const r = await payout.mutateAsync({ statementRef: ref.trim(), receivedOn: payDate, amount: payAmount.trim(), accountCode: payAccount }); toast.success(r.replay ? "التحويل مسجّل بالفعل" : "سُجّل التحويل الفعلي"); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-4" dir="rtl" data-testid="ledger-carrier">
      <PageHeader title="تسوية شركة الشحن" description="كل شحنة تُسوّى مرة واحدة؛ الرسوم مصروف منفصل؛ والتحويل الفعلي خطوة مستقلة بمبلغ مطابق" icon={<Truck className="h-5 w-5" aria-hidden="true" />} />
      <SectionCard title="الكشف" testId="carrier-form">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><Label htmlFor="carrier-ref">مرجع الكشف</Label><Input id="carrier-ref" value={ref} onChange={e => setRef(e.target.value)} className="mt-1 min-h-11" dir="ltr" placeholder="BOSTA-2026-10-15" data-testid="carrier-ref" /></div>
          <div><Label htmlFor="carrier-date">تاريخ الكشف</Label><Input id="carrier-date" type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1 min-h-11" dir="ltr" data-testid="carrier-date" /></div>
        </div>
        <Label htmlFor="carrier-csv" className="mt-3 block">الأسطر (shipment,cod,fees,net)</Label>
        <Textarea id="carrier-csv" value={csv} onChange={e => { setCsv(e.target.value); setResult(null); }} rows={6} className="mt-1 font-mono text-xs" dir="ltr" placeholder={"shipment,cod,fees,net\n12345678,750,50,700"} data-testid="carrier-csv" />
        {preview && <p className="mt-2 text-xs text-muted-foreground" data-testid="carrier-preview">{preview.lines.length} سطر صالح · {preview.errors.length} سطر مرفوض{preview.errors.length ? `: ${preview.errors.map(e => `سطر ${e.row} (${e.reason})`).join("، ")}` : ""}</p>}
        <Button className="mt-3 min-h-12 w-full sm:w-auto" onClick={runSettle} disabled={busy || settle.isPending || !ref.trim() || !preview?.lines.length} data-testid="carrier-settle">{busy && settle.isPending ? "جارٍ التسوية…" : "تسوية الكشف"}</Button>
      </SectionCard>

      {result && (
        <SectionCard title={`نتيجة الكشف ${result.statementRef}`} testId="carrier-result">
          <ul className="divide-y divide-border text-sm">
            {result.outcomes.map((o: any) => (
              <li key={o.row} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`carrier-line-${o.row}`}>
                <span className="font-mono text-xs" dir="ltr">{o.shipment}</span>
                <span className="flex items-center gap-2"><StatusBadge status={o.status} label={STATUS_LABEL[o.status]?.label ?? o.status} tone={STATUS_LABEL[o.status]?.tone ?? "info"} size="sm" icon={null} />{o.reason && <span className="text-xs text-muted-foreground">{o.reason}</span>}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm" data-testid="carrier-expected">صافي الكشف المسجّل: <b className="tabular-nums">{result.expectedPayout == null ? "غير متاح" : `${money(result.expectedPayout)} ج.م`}</b>{result.negativeNet ? ` · رسوم تزيد عن التحصيل بمقدار ${money(result.negativeNet)} ج.م` : ""}</p>
        </SectionCard>
      )}

      {result && result.lines > 0 && !result.payoutTransactionId && (
        <SectionCard title="التحويل الفعلي" testId="carrier-payout">
          <p className="text-xs text-muted-foreground">اكتب المبلغ كما وصل في كشف البنك/المحفظة — يُقبل فقط إن ساوى صافي الكشف.</p>
          <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div><Label htmlFor="pay-date">تاريخ الاستلام</Label><Input id="pay-date" type="date" value={payDate} onChange={e => setPayDate(e.target.value)} className="mt-1 min-h-11" dir="ltr" /></div>
            <div><Label htmlFor="pay-amount">المبلغ المستلم</Label><Input id="pay-amount" inputMode="decimal" value={payAmount} onChange={e => setPayAmount(e.target.value)} className="mt-1 min-h-11" dir="ltr" data-testid="carrier-pay-amount" /></div>
            <div><Label htmlFor="pay-account">حساب الاستلام</Label>
              <select id="pay-account" value={payAccount} onChange={e => setPayAccount(e.target.value)} className="mt-1 block min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm" data-testid="carrier-pay-account">
                {cashAccounts.map(a => <option key={a.id} value={a.code}>{a.name}</option>)}
              </select>
            </div>
          </div>
          <Button className="mt-3 min-h-12 w-full sm:w-auto" onClick={runPayout} disabled={busy || payout.isPending || !payAmount.trim()} data-testid="carrier-pay-run">تسجيل التحويل</Button>
        </SectionCard>
      )}
    </div>
  );
}
