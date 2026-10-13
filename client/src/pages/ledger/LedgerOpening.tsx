import { useState } from "react";
import { ClipboardList, Download, ShieldCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, SectionCard } from "@/components/shared";
import { toast } from "sonner";
import { OPENING_ACCOUNTS, buildOpeningDraft, emptyOpeningRow, money, openingFileDownload, openingGroupTotals, type OpeningRow } from "./ledgerUi";

/**
 * «تجهيز الأرصدة الافتتاحية» (المالك فقط — ledger.activate على السيرفر).
 *
 *  • المسودة في حالة الصفحة فقط: لا localStorage ولا حفظ على السيرفر؛ تُمسح بالخروج من الصفحة أو تغيير الجلسة/الشركة
 *    (المكوّن الداخلي مربوط بمفتاح الجلسة فيُعاد إنشاؤه فارغًا).
 *  • الأرقام من جرد ومطابقة فعلية يوم Go-live فقط — لا تعبئة من V1/V2؛ كل مبلغ غير صفري يحتاج مرجعًا والقائم بالعد.
 *  • ذمة COD منفصلة عن النقدية المتاحة.
 *  • «تحقق» = ledger.opening.validate (قراءة فقط داخل معاملة READ ONLY) — لا يكتب صفًا ولا يفعّل الدفتر.
 *  • التنزيل = ملف JSON كما أعاده السيرفر حرفيًا (عقد سكربت التفعيل)، ومتاح فقط لنتيجة تحقق ناجحة لنفس المسودة.
 */
export default function LedgerOpening() {
  const { user } = useAuth();
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const sessionKey = `${(user as any)?.id ?? "emp"}:${(user as any)?.tenantId ?? ""}`;
  // بعد التفعيل: الأرصدة النقدية سُجّلت بأداة التفعيل؛ يبقى المخزون الافتتاحي من جرد يوم Go-live (المرحلة 4)
  if (status.data?.enabled) return <InventoryOpeningSection />;
  return <OpeningDraftForm key={sessionKey} />;
}

type Candidate = { stocktakeId: number; businessName: string; warehouseName: string; approvedDay: string; value: string | null; postedFromStocktakeId: number | null };

/** المخزون الافتتاحي من جرد فعلي معتمد يوم Go-live (أو السابق) — مرة واحدة لكل مخزن؛ لا أرقام من أرصدة قديمة. */
export function InventoryOpeningSection() {
  const candidates = trpc.ledger.inventory.openingCandidates.useQuery(undefined, { retry: false });
  const post = trpc.ledger.inventory.openingFromStocktake.useMutation();
  const [busy, setBusy] = useState<number | null>(null);
  const rows = (candidates.data?.rows ?? []) as Candidate[];
  const run = async (stocktakeId: number) => {
    if (busy != null || post.isPending) return;
    setBusy(stocktakeId);
    try {
      const r = await post.mutateAsync({ stocktakeId });
      toast.success(r.replay ? "مسجّل بالفعل — لم يتكرر" : "سُجّلت قيمة المخزون الافتتاحية من الجرد");
      await candidates.refetch();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };
  return (
    <div className="space-y-4" dir="rtl" data-testid="ledger-inventory-opening">
      <PageHeader title="المخزون الافتتاحي" description={`الدفتر مفعّل (بداية العمل ${candidates.data?.goLiveDate ?? "—"}). الأرصدة النقدية سُجّلت عند التفعيل؛ قيمة المخزون من جرد فعلي معتمد يوم Go-live فقط.`} icon={<ClipboardList className="h-5 w-5" aria-hidden="true" />} />
      <SectionCard title="جرود يوم Go-live" testId="ledger-inventory-opening-list">
        {candidates.isLoading ? <p className="text-sm text-muted-foreground">جارٍ التحميل…</p>
          : candidates.error ? <p className="text-sm text-destructive" role="alert">{candidates.error.message}</p>
          : rows.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="ledger-inventory-opening-empty">لا جرد معتمد يوم Go-live أو اليوم السابق له. اعتمد جردًا فعليًا لكل مخزن أولًا.</p>
          : (
            <ul className="divide-y divide-border text-sm">
              {rows.map(r => {
                const posted = r.postedFromStocktakeId != null;
                return (
                  <li key={r.stocktakeId} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`ledger-inventory-opening-${r.stocktakeId}`}>
                    <div className="min-w-0">
                      <p className="font-medium">{r.businessName} — {r.warehouseName}</p>
                      <p className="text-xs text-muted-foreground"><span dir="ltr">{r.approvedDay}</span> · {r.value == null ? "تكلفة بند غير مثبتة — لا يُعتمد" : `${money(r.value)} ج.م`}</p>
                    </div>
                    {posted
                      ? <span className="text-xs text-muted-foreground">{r.postedFromStocktakeId === r.stocktakeId ? "مسجّل من هذا الجرد" : "مخزون هذا المخزن مسجّل من جرد آخر"}</span>
                      : <Button className="min-h-11" disabled={r.value == null || busy != null || post.isPending} onClick={() => run(r.stocktakeId)} data-testid={`ledger-inventory-opening-post-${r.stocktakeId}`}>{busy === r.stocktakeId ? "جارٍ التسجيل…" : "اعتماد كمخزون افتتاحي"}</Button>}
                  </li>
                );
              })}
            </ul>
          )}
      </SectionCard>
      {candidates.data?.goLiveDate && <PackagingOpeningCard goLiveDate={candidates.data.goLiveDate} />}
    </div>
  );
}

/** رصيد مخزون التغليف الافتتاحي من عدّ فعلي يوم Go-live — مرة لكل نشاط (السيرفر يرفض التكرار وأي تاريخ آخر). */
function PackagingOpeningCard({ goLiveDate }: { goLiveDate: string }) {
  const businesses = trpc.ledger.businesses.list.useQuery(undefined, { retry: false });
  const post = trpc.ledger.inventory.packagingOpening.useMutation();
  const [businessId, setBusinessId] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const list = (businesses.data ?? []) as { id: number; name: string }[];
  const chosen = businessId ?? list[0]?.id ?? null;
  const run = async () => {
    if (busy || chosen == null) return;
    setBusy(true);
    try { const r = await post.mutateAsync({ businessId: chosen, amount: amount.trim(), countedOn: goLiveDate }); toast.success(r.replay ? "مسجّل بالفعل — لم يتكرر" : "سُجّل رصيد التغليف الافتتاحي"); setAmount(""); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <SectionCard title="مخزون مواد التغليف الافتتاحي" testId="ledger-packaging-opening">
      <p className="text-xs text-muted-foreground">قيمة ما عُدّ فعليًا من مواد التغليف يوم <span dir="ltr">{goLiveDate}</span> — مرة واحدة لكل نشاط. بعدها يُشترى التغليف كمخزون، ويُحمَّل على الأوردر عند تسليمه لمندوب الشحن.</p>
      <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div><Label htmlFor="pk-biz">النشاط</Label>
          <select id="pk-biz" value={chosen ?? ""} onChange={e => setBusinessId(Number(e.target.value))} className="mt-1 block min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm" data-testid="pk-biz">
            {list.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div><Label htmlFor="pk-amount">القيمة المعدودة</Label><Input id="pk-amount" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} className="mt-1 min-h-11" dir="ltr" data-testid="pk-amount" /></div>
        <div className="flex items-end"><Button className="min-h-11 w-full" onClick={run} disabled={busy || chosen == null || !/^\d{1,14}(\.\d{1,4})?$/.test(amount.trim())} data-testid="pk-run">تسجيل</Button></div>
      </div>
    </SectionCard>
  );
}

type ValidateResult = {
  ok: boolean; errors: string[]; blockers: string[]; warnings: string[];
  totals: { cashAvailable: string; codReceivable: string; openingEquity: string | null };
  businessCoverage: { id: number; name: string; active: boolean; inPlan: boolean; result: string }[];
  v2Reconciliation: { generatedAt: string; ok: boolean; differences: number } | null;
  ledgerEnabled: boolean;
  file: ({ goLiveDate: string } & Record<string, unknown>) | null;
};

function OpeningDraftForm() {
  const [goLiveDate, setGoLiveDate] = useState("");
  const [rows, setRows] = useState<Record<string, OpeningRow>>(() => Object.fromEntries(OPENING_ACCOUNTS.map(a => [a.code, emptyOpeningRow()])));
  const [ack, setAck] = useState(false);
  const [result, setResult] = useState<{ key: string; data: ValidateResult } | null>(null);
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const validate = trpc.ledger.opening.validate.useMutation();
  const pending = submitting || validate.isPending;
  const built = buildOpeningDraft(goLiveDate, rows, ack);
  const draftKey = JSON.stringify(built.draft);
  const current = result && result.key === draftKey ? result.data : null; // أي تعديل بعد التحقق يُبطل النتيجة والتنزيل
  const totals = openingGroupTotals(rows);

  const setRow = (code: string, patch: Partial<OpeningRow>) => setRows(prev => ({ ...prev, [code]: { ...prev[code], ...patch } }));
  const runValidate = async () => {
    if (pending) return;
    setLocalErrors(built.errors);
    if (built.errors.length) return;
    setSubmitting(true);
    try {
      const data = (await validate.mutateAsync(built.draft)) as unknown as ValidateResult;
      setResult({ key: draftKey, data });
      if (data.ok) toast.success("المسودة سليمة — يمكنك تنزيل ملف التفعيل"); else toast.error("المسودة تحتاج تصحيحًا — راجع الملاحظات");
    } catch (e) { toast.error((e as Error).message); }
    finally { setSubmitting(false); }
  };
  const download = () => {
    if (!current?.ok || !current.file) return;
    const { filename, json } = openingFileDownload(current.file);
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const group = (g: "cash_available" | "cod_receivable") => OPENING_ACCOUNTS.filter(a => a.group === g);
  // دالة عرض (لا مكوّن داخلي) كي لا يُعاد إنشاء الحقول ويضيع التركيز مع كل حرف
  const accountFields = (code: string, name: string) => {
    const r = rows[code];
    return (
      <fieldset key={code} className="space-y-2 rounded-[var(--radius-brand-md)] border border-border p-3" data-testid={`ledger-opening-row-${code}`}>
        <legend className="px-1 text-sm font-medium">{name} <span className="font-mono text-xs text-muted-foreground" dir="ltr">{code}</span></legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div><Label htmlFor={`op-amount-${code}`} className="text-xs">المبلغ بعد الجرد (ج.م)</Label><Input id={`op-amount-${code}`} inputMode="decimal" value={r.amount} onChange={e => setRow(code, { amount: e.target.value.trim() })} className="mt-1 min-h-11 tabular-nums" dir="ltr" placeholder="0.00" data-testid={`ledger-opening-amount-${code}`} /></div>
          <div><Label htmlFor={`op-ref-${code}`} className="text-xs">مرجع الجرد / الكشف</Label><Input id={`op-ref-${code}`} value={r.reference} onChange={e => setRow(code, { reference: e.target.value })} maxLength={160} className="mt-1 min-h-11" placeholder="مثال: محضر جرد الخزنة" data-testid={`ledger-opening-ref-${code}`} /></div>
          <div><Label htmlFor={`op-by-${code}`} className="text-xs">القائم بالعد</Label><Input id={`op-by-${code}`} value={r.countedBy} onChange={e => setRow(code, { countedBy: e.target.value })} maxLength={100} className="mt-1 min-h-11" data-testid={`ledger-opening-by-${code}`} /></div>
          <div><Label htmlFor={`op-note-${code}`} className="text-xs">ملاحظة (اختيارية)</Label><Input id={`op-note-${code}`} value={r.note} onChange={e => setRow(code, { note: e.target.value })} maxLength={300} className="mt-1 min-h-11" data-testid={`ledger-opening-note-${code}`} /></div>
        </div>
      </fieldset>
    );
  };

  return (
    <div className="space-y-4" dir="rtl" data-testid="ledger-opening">
      <PageHeader title="تجهيز الأرصدة الافتتاحية" description="مسودة للمالك من جرد ومطابقة فعلية يوم Go-live — لا تفعيل ولا كتابة من هنا" icon={<ClipboardList className="h-5 w-5" aria-hidden="true" />} />

      <ul className="list-disc space-y-1 rounded-[var(--radius-brand-md)] border border-border bg-muted/40 p-3 ps-6 text-xs leading-6 text-muted-foreground" data-testid="ledger-opening-rules">
        <li>المسودة في هذه الصفحة فقط ولا تُحفظ في أي مكان — تُمسح عند الخروج أو تغيير الشركة.</li>
        <li>الأرقام من جرد الخزن وكشوف البنك والمحافظ وكشف تسوية بوسطة يوم Go-live — لا أرقام من النظام القديم.</li>
        <li>«تحقق» يقرأ فقط ولا يكتب أي صف ولا يفعّل الدفتر. التفعيل خطوة منفصلة بملف التنزيل يوم Go-live.</li>
      </ul>

      <div className="max-w-xs"><Label htmlFor="ledger-opening-date">تاريخ Go-live</Label><Input id="ledger-opening-date" type="date" value={goLiveDate} onChange={e => setGoLiveDate(e.target.value)} className="mt-1 min-h-11" dir="ltr" data-testid="ledger-opening-date" /></div>

      <SectionCard title="النقدية المتاحة — خزن وبنوك ومحافظ" description={`الإجمالي: ${money(totals.cashAvailable)} ج.م`} testId="ledger-opening-cash">
        <div className="space-y-3">{group("cash_available").map(a => accountFields(a.code, a.name))}</div>
      </SectionCard>
      <SectionCard title="ذمة COD على شركة الشحن — ليست نقدية متاحة" description={`الإجمالي: ${money(totals.codReceivable)} ج.م`} testId="ledger-opening-cod">
        <div className="space-y-3">{group("cod_receivable").map(a => accountFields(a.code, a.name))}</div>
      </SectionCard>

      <label className="flex min-h-11 items-start gap-2 text-sm" htmlFor="ledger-opening-ack">
        <input id="ledger-opening-ack" type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} className="mt-1 h-5 w-5 accent-[var(--primary)]" data-testid="ledger-opening-ack" />
        <span>راجعت فروق تقرير مطابقة النظام القديم (للمقارنة فقط) وأعتمد أرقام الجرد الفعلي بدلًا منها.</span>
      </label>

      {localErrors.length > 0 && (
        <ul className="space-y-1 rounded-[var(--radius-brand-md)] border border-destructive/40 p-3 text-sm text-destructive" role="alert" data-testid="ledger-opening-local-errors">
          {localErrors.map(e => <li key={e}>{e}</li>)}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        <Button className="min-h-12 flex-1 sm:flex-none" onClick={runValidate} disabled={pending} data-testid="ledger-opening-validate"><ShieldCheck className="h-4 w-4 ml-1" aria-hidden="true" /> {pending ? "جارٍ التحقق…" : "تحقق من المسودة"}</Button>
        <Button variant="outline" className="min-h-12 flex-1 sm:flex-none" onClick={download} disabled={!current?.ok || !current.file} data-testid="ledger-opening-download"><Download className="h-4 w-4 ml-1" aria-hidden="true" /> تنزيل ملف التفعيل (JSON)</Button>
      </div>
      {result && !current && <p className="text-xs text-muted-foreground" data-testid="ledger-opening-stale">عدّلت المسودة بعد آخر تحقق — تحقق مرة أخرى قبل التنزيل.</p>}

      {current && (
        <SectionCard title={current.ok ? "نتيجة التحقق: سليمة" : "نتيجة التحقق: تحتاج تصحيحًا"} testId="ledger-opening-result">
          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <p>النقدية المتاحة: <b className="tabular-nums">{money(current.totals.cashAvailable)}</b> ج.م</p>
              <p>ذمة COD: <b className="tabular-nums">{money(current.totals.codReceivable)}</b> ج.م</p>
              <p>رأس المال الافتتاحي: <b className="tabular-nums">{current.totals.openingEquity != null ? money(current.totals.openingEquity) : "—"}</b> ج.م</p>
            </div>
            {current.ledgerEnabled && <p className="text-[var(--warning)]">الدفتر مفعّل بالفعل لهذه الشركة.</p>}
            {[...current.errors, ...current.blockers].length > 0 && (
              <ul className="list-disc space-y-1 ps-5 text-destructive" data-testid="ledger-opening-errors">{[...current.errors, ...current.blockers].map(e => <li key={e}>{e}</li>)}</ul>
            )}
            {current.warnings.length > 0 && <ul className="list-disc space-y-1 ps-5 text-[var(--warning)]" data-testid="ledger-opening-warnings">{current.warnings.map(w => <li key={w}>{w}</li>)}</ul>}
            {current.v2Reconciliation && (
              <p className="text-xs text-muted-foreground" data-testid="ledger-opening-v2">تقرير مطابقة النظام القديم (للمقارنة فقط، لا تُؤخذ منه أرقام): {current.v2Reconciliation.ok ? "بلا فروق" : `${current.v2Reconciliation.differences} فرق`}.</p>
            )}
            {current.businessCoverage.length > 0 && (
              <div>
                <p className="text-xs text-muted-foreground">الأنشطة المشمولة بالتفعيل:</p>
                <ul className="mt-1 flex flex-wrap gap-1 text-xs">{current.businessCoverage.map(b => <li key={b.id} className="rounded-[var(--radius-brand-pill)] bg-muted px-2 py-0.5">{b.name}{b.inPlan ? "" : " (خارج الخطة)"}</li>)}</ul>
              </div>
            )}
          </div>
        </SectionCard>
      )}
    </div>
  );
}
