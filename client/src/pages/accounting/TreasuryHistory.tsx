import { useState } from "react";
import { AlertCircle, ArrowDownCircle, ArrowUpCircle, RefreshCw } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/shared";

/**
 * سجل الخزنة — صفحة المراجعة.
 *
 * كل سطر بيقول الرصيد قبل الحركة وبعدها، فالمحاسب يقدر يمشي بعينه من فوق لتحت ويتأكد إن
 * كل حركة بدأت من حيث انتهت اللي قبلها. `balanceBefore` محسوب على السيرفر مش مخزّن:
 * الرصيد بعد الحركة محفوظ والاتجاه معروف، فاللي قبلها هو الفرق.
 *
 * قراءة بحتة. مفيش تعديل ولا حذف من هنا — الخزنة مابتتلمسش إلا من المسار اللي عملها.
 */

const egp = (n: number | null | undefined) =>
  Number(n ?? 0).toLocaleString("ar-EG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const TYPE_LABEL: Record<string, string> = {
  collection: "تحصيل",
  refund: "مرتجع",
  expense: "مصروف",
  deposit: "إيداع",
  withdrawal: "سحب",
  adjustment: "تسوية",
};

const REF_LABEL: Record<string, string> = {
  order: "أوردر",
  expense: "مصروف",
  return: "مرتجع",
  manual: "يدوي",
};

function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** أول يوم في الشهر الحالي بتوقيت القاهرة. */
function cairoMonthStart(): string {
  return `${cairoToday().slice(0, 7)}-01`;
}

export default function TreasuryHistory() {
  const { currentBusinessIds } = useBusinessContext();
  const [dateFrom, setDateFrom] = useState(cairoMonthStart);
  const [dateTo, setDateTo] = useState(cairoToday);

  const q = trpc.accounting.treasuryHistory.useQuery(
    {
      ...(currentBusinessIds?.length ? { businessIds: currentBusinessIds } : {}),
      dateFrom: new Date(`${dateFrom}T00:00:00`),
      // نهاية اليوم المختار داخلة في النطاق — المستخدم بيقصد اليوم كله
      dateTo: new Date(new Date(`${dateTo}T00:00:00`).getTime() + 86_400_000),
      limit: 200,
    },
    { retry: false }
  );

  const rows = q.data ?? [];

  return (
    <div className="space-y-4" dir="rtl">
      <SectionCard>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs">من</Label>
            <Input type="date" className="mt-1 h-10" value={dateFrom}
              max={dateTo} onChange={e => setDateFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">إلى</Label>
            <Input type="date" className="mt-1 h-10" value={dateTo}
              min={dateFrom} max={cairoToday()} onChange={e => setDateTo(e.target.value)} />
          </div>
          <Button variant="outline" className="ms-auto h-10 gap-1.5"
            onClick={() => q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
            تحديث
          </Button>
        </div>
      </SectionCard>

      {q.isError && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <p className="font-bold text-destructive">مش قادر أجيب سجل الخزنة</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{q.error?.message}</p>
            <Button size="sm" variant="outline" className="mt-2 h-8" onClick={() => q.refetch()}>
              جرّب تاني
            </Button>
          </div>
        </div>
      )}

      <SectionCard>
        {q.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map(i => <div key={i} className="h-11 animate-pulse rounded bg-muted" />)}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            مفيش حركات خزنة في الفترة دي.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b text-right text-xs text-muted-foreground">
                  <th className="p-2">التاريخ والوقت</th>
                  <th className="p-2">النوع</th>
                  <th className="p-2">الاتجاه</th>
                  <th className="p-2">المبلغ</th>
                  <th className="p-2">الرصيد قبل</th>
                  <th className="p-2">الرصيد بعد</th>
                  <th className="p-2">المرجع</th>
                  <th className="p-2">ملاحظات</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => {
                  const isIn = r.direction === "in";
                  const when = new Date(r.transactionDate);
                  return (
                    <tr key={r.id} className="border-b last:border-0 align-top">
                      <td className="p-2 whitespace-nowrap tabular-nums">
                        {when.toLocaleDateString("ar-EG")}
                        <span className="block text-xs text-muted-foreground">
                          {when.toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </td>
                      <td className="p-2 whitespace-nowrap">{TYPE_LABEL[r.type] ?? r.type}</td>
                      <td className="p-2 whitespace-nowrap">
                        <span
                          className="inline-flex items-center gap-1 text-xs font-bold"
                          style={{ color: isIn ? "var(--success)" : "var(--destructive)" }}
                        >
                          {isIn ? <ArrowDownCircle className="h-3.5 w-3.5" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
                          {isIn ? "داخل" : "خارج"}
                        </span>
                      </td>
                      <td className="p-2 whitespace-nowrap font-bold tabular-nums">
                        {isIn ? "+" : "−"}{egp(r.amount)}
                      </td>
                      <td className="p-2 whitespace-nowrap tabular-nums text-muted-foreground">
                        {egp(r.balanceBefore)}
                      </td>
                      <td className="p-2 whitespace-nowrap tabular-nums font-semibold">
                        {egp(r.balanceAfter)}
                      </td>
                      <td className="p-2 whitespace-nowrap text-xs">
                        {REF_LABEL[r.referenceType] ?? r.referenceType}
                        {r.referenceId ? ` #${r.referenceId}` : ""}
                        <span className="block text-muted-foreground">{r.description}</span>
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">{r.notes || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
