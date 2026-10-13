import { useMemo, useState } from "react";
import { Users } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader, SectionCard, StatusBadge } from "@/components/shared";
import { toast } from "sonner";
import { cairoToday, money, newOperationId, type UiAccount } from "./ledgerUi";

/**
 * «المرتبات والسلف» (المرحلة 5) — للمالك ومدير الحسابات (السيرفر يرفض نطاق النشاط الواحد؛ المحاسب لا يرى المرتبات):
 * مسودة لكل شهر محسوبة من ملف الراتب والحضور المعتمد والعمولة وأقساط السلف، بونص/خصم بسبب، اعتماد بمدير آخر غير المُنشئ
 * (أو المالك)، صرف من خزنة، وإلغاء بالعكس بسبب مكتوب للدورة الأحدث فقط. والسلف بأقساط ورصيد.
 */
const RUN_STATUS: Record<string, { label: string; tone: "success" | "info" | "warning" | "danger" }> = {
  draft: { label: "مسودة", tone: "info" }, approved: { label: "معتمدة — لم تُصرف", tone: "warning" }, paid: { label: "مصروفة", tone: "success" }, cancelled: { label: "ملغاة", tone: "danger" },
};
const ADV_STATUS: Record<string, string> = { active: "جارية", settled: "مسددة", cancelled: "ملغاة" };
const thisMonth = () => cairoToday().slice(0, 7);

export default function LedgerPayroll() {
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const runs = trpc.ledger.payroll.runs.useQuery(undefined, { retry: false });
  const [selected, setSelected] = useState<number | null>(null);
  if (status.data && !status.data.enabled) return <EmptyState title="دفتر الحسابات غير مفعّل لهذه الشركة" description="المرتبات تبدأ بعد التفعيل." className="m-4" />;
  if (runs.error) return <EmptyState title="المرتبات على مستوى الشركة" description={runs.error.message} className="m-4" />;
  if (runs.data && !runs.data.available) return <EmptyState title="المرتبات غير متاحة بعد" description={`تحتاج تطبيق ${runs.data.reason === "0046" ? "أنواع الحسابات (0046)" : "جداول المرتبات (0048)"} أولًا.`} className="m-4" />;
  const list = (runs.data?.runs ?? []) as any[];
  return (
    <div className="space-y-4" dir="rtl" data-testid="ledger-payroll">
      <PageHeader title="المرتبات والسلف" description="الحساب من ملف الراتب والحضور المعتمد؛ الاعتماد قيد استحقاق، والصرف قيد منفصل، والإلغاء بالعكس فقط" icon={<Users className="h-5 w-5" aria-hidden="true" />} />
      <SetupCard />
      <NewRunCard onCreated={id => setSelected(id)} />
      <SectionCard title="الدورات" testId="payroll-runs">
        {list.length === 0 ? <p className="text-sm text-muted-foreground">لا دورات بعد.</p> : (
          <ul className="divide-y divide-border text-sm">
            {list.map(r => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`payroll-run-${r.id}`}>
                <span><b dir="ltr">{r.period}</b> · صافي <span className="tabular-nums">{money(r.net)}</span> ج.م</span>
                <span className="flex items-center gap-2">
                  <StatusBadge status={r.status} label={RUN_STATUS[r.status]?.label ?? r.status} tone={RUN_STATUS[r.status]?.tone ?? "info"} size="sm" icon={null} />
                  <Button size="sm" variant="outline" className="min-h-11" onClick={() => setSelected(r.id)} data-testid={`payroll-open-${r.id}`}>التفاصيل</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      {selected != null && <RunDetail runId={selected} />}
      <AdvancesSection />
    </div>
  );
}

function SetupCard() {
  const ensure = trpc.ledger.payroll.ensureAccounts.useMutation();
  const [done, setDone] = useState(false);
  if (done) return null;
  const run = async () => {
    try { const r = await ensure.mutateAsync(); toast.success(r.created.length ? `جُهّزت: ${r.created.join("، ")}` : "حسابات المرتبات جاهزة بالفعل"); setDone(true); }
    catch (e) { toast.error((e as Error).message); }
  };
  return (
    <SectionCard title="حسابات المرتبات" testId="payroll-setup">
      <p className="text-xs text-muted-foreground">مرتبات وأجور، عمولات، سلف الموظفين، رواتب مستحقة — تُنشأ مرة واحدة وتُرحَّل آليًا فقط.</p>
      <Button className="mt-2 min-h-11" onClick={run} disabled={ensure.isPending} data-testid="payroll-ensure">تجهيز/تحقق</Button>
    </SectionCard>
  );
}

function NewRunCard({ onCreated }: { onCreated: (id: number) => void }) {
  const utils = trpc.useUtils();
  const create = trpc.ledger.payroll.create.useMutation();
  const [period, setPeriod] = useState(thisMonth());
  const [opId, setOpId] = useState(newOperationId);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try { const r = await create.mutateAsync({ period, operationId: opId }); toast.success(r.replay ? "الدورة موجودة" : "أُنشئت المسودة"); setOpId(newOperationId()); await utils.ledger.payroll.runs.invalidate(); onCreated(r.runId); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <SectionCard title="دورة جديدة" testId="payroll-new">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div><Label htmlFor="pr-period">الشهر</Label><Input id="pr-period" type="month" value={period} max={thisMonth()} onChange={e => setPeriod(e.target.value)} className="mt-1 min-h-11" dir="ltr" data-testid="payroll-period" /></div>
        <Button className="min-h-11" onClick={run} disabled={busy || !/^\d{4}-\d{2}$/.test(period)} data-testid="payroll-create">إنشاء مسودة</Button>
      </div>
    </SectionCard>
  );
}

type Adj = { label: string; amount: string };

function RunDetail({ runId }: { runId: number }) {
  const utils = trpc.useUtils();
  const q = trpc.ledger.payroll.run.useQuery({ runId }, { retry: false });
  const accounts = trpc.ledger.accounts.list.useQuery(undefined, { retry: false });
  const recompute = trpc.ledger.payroll.recompute.useMutation();
  const approve = trpc.ledger.payroll.approve.useMutation();
  const pay = trpc.ledger.payroll.pay.useMutation();
  const cancel = trpc.ledger.payroll.cancel.useMutation();
  const adjust = trpc.ledger.payroll.adjust.useMutation();
  const [busy, setBusy] = useState(false);
  const [paidOn, setPaidOn] = useState(cairoToday());
  const [fromAccount, setFromAccount] = useState("");
  const [reason, setReason] = useState("");
  const [editing, setEditing] = useState<{ employeeId: number; bonuses: Adj[]; deductions: Adj[] } | null>(null);
  const cash = useMemo(() => ((accounts.data ?? []) as unknown as UiAccount[]).filter(a => ["cash", "bank", "wallet"].includes(a.kind)), [accounts.data]);
  if (q.error) return <SectionCard title="الدورة" testId="payroll-detail"><p className="text-sm text-destructive" role="alert">{q.error.message}</p></SectionCard>;
  if (!q.data) return null;
  const { run, lines } = q.data as any;
  const from = cash.some(a => a.code === fromAccount) ? fromAccount : cash[0]?.code ?? "";
  const refresh = async () => { await utils.ledger.payroll.run.invalidate({ runId }); await utils.ledger.payroll.runs.invalidate(); };
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); toast.success(ok); await refresh(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const reviewCount = lines.filter((l: any) => l.result.status !== "ok").length;
  return (
    <SectionCard title={`دورة ${run.period}`} testId="payroll-detail">
      <p className="text-sm">الإجمالي <b className="tabular-nums">{money(run.gross)}</b> · الخصومات <b className="tabular-nums">{money(run.totalDeductions)}</b> · الصافي <b className="tabular-nums">{money(run.net)}</b> ج.م</p>
      {reviewCount > 0 && <p className="mt-1 text-sm text-destructive" role="alert" data-testid="payroll-review-count">{reviewCount} سطر يحتاج مراجعة — لا اعتماد قبل حلها</p>}
      <ul className="mt-2 divide-y divide-border text-sm">
        {lines.map((l: any) => (
          <li key={l.employeeId} className="py-2" data-testid={`payroll-line-${l.employeeId}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <b>{l.employeeName}</b>
              {l.result.status === "ok"
                ? <span className="tabular-nums">{money(l.gross)} − {money(l.totalDeductions)} = <b>{money(l.net)}</b></span>
                : <span className="text-destructive">{l.result.reason}</span>}
            </div>
            {l.result.status === "ok" && (
              <p className="mt-1 text-xs text-muted-foreground">
                {[...l.result.earnings.map((x: any) => `+ ${x.label} ${money(x.amount)}`), ...l.result.deductions.map((x: any) => `− ${x.label} ${money(x.amount)}`)].join(" · ")}
              </p>
            )}
            {run.status === "draft" && (editing && editing.employeeId === l.employeeId ? (
              <AdjustEditor value={editing} onChange={setEditing} onCancel={() => setEditing(null)} busy={busy}
                onSave={() => { const v = editing; act(() => adjust.mutateAsync({ runId, employeeId: l.employeeId, bonuses: v.bonuses, deductions: v.deductions }).then(() => setEditing(null)), "حُفظ البونص/الخصم"); }} />
            ) : (
              <Button size="sm" variant="ghost" className="mt-1 min-h-11" onClick={() => setEditing({ employeeId: l.employeeId, bonuses: l.inputs.adjustments?.bonuses ?? [], deductions: l.inputs.adjustments?.deductions ?? [] })} data-testid={`payroll-adjust-${l.employeeId}`}>بونص/خصم</Button>
            ))}
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {run.status === "draft" && <Button variant="outline" className="min-h-11" disabled={busy} onClick={() => act(() => recompute.mutateAsync({ runId }), "أُعيد الحساب")} data-testid="payroll-recompute">إعادة الحساب</Button>}
        {run.status === "draft" && <Button className="min-h-11" disabled={busy || reviewCount > 0} onClick={() => act(() => approve.mutateAsync({ runId }), "اعتُمدت الدورة (قيد استحقاق)")} data-testid="payroll-approve">اعتماد</Button>}
      </div>
      {run.status === "approved" && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div><Label htmlFor="pr-paid">تاريخ الصرف</Label><Input id="pr-paid" type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)} className="mt-1 min-h-11" dir="ltr" /></div>
          <div><Label htmlFor="pr-from">من</Label>
            <select id="pr-from" value={from} onChange={e => setFromAccount(e.target.value)} className="mt-1 block min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm" data-testid="payroll-from">
              {cash.map(a => <option key={a.id} value={a.code}>{a.name}</option>)}
            </select>
          </div>
          <div className="flex items-end"><Button className="min-h-11 w-full" disabled={busy || !from} onClick={() => act(() => pay.mutateAsync({ runId, paidOn, fromAccountCode: from }), "صُرفت المرتبات")} data-testid="payroll-pay">صرف {money(run.net)} ج.م</Button></div>
        </div>
      )}
      {run.status !== "cancelled" && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input aria-label="سبب الإلغاء" value={reason} onChange={e => setReason(e.target.value)} placeholder="سبب الإلغاء (إلزامي) — الإلغاء بقيود عكسية" className="min-h-11" data-testid="payroll-cancel-reason" />
          <Button variant="destructive" className="min-h-11" disabled={busy || reason.trim().length < 3} onClick={() => act(() => cancel.mutateAsync({ runId, reason: reason.trim() }).then(() => setReason("")), "أُلغيت الدورة بالعكس")} data-testid="payroll-cancel">إلغاء الدورة</Button>
        </div>
      )}
    </SectionCard>
  );
}

function AdjustEditor({ value, onChange, onSave, onCancel, busy }: { value: { employeeId: number; bonuses: Adj[]; deductions: Adj[] }; onChange: (v: any) => void; onSave: () => void; onCancel: () => void; busy: boolean }) {
  const valid = [...value.bonuses, ...value.deductions].every(x => x.label.trim().length >= 3 && /^\d{1,14}(\.\d{1,4})?$/.test(x.amount.trim()) && Number(x.amount) > 0);
  const row = (kind: "bonuses" | "deductions", i: number, x: Adj) => (
    <div key={`${kind}-${i}`} className="flex gap-2">
      <Input aria-label={kind === "bonuses" ? "سبب البونص" : "سبب الخصم"} value={x.label} onChange={e => onChange({ ...value, [kind]: value[kind].map((y, j) => j === i ? { ...y, label: e.target.value } : y) })} placeholder="السبب" className="min-h-11" />
      <Input aria-label={kind === "bonuses" ? "مبلغ البونص" : "مبلغ الخصم"} inputMode="decimal" value={x.amount} onChange={e => onChange({ ...value, [kind]: value[kind].map((y, j) => j === i ? { ...y, amount: e.target.value } : y) })} className="min-h-11 w-28" dir="ltr" />
      <Button variant="ghost" className="min-h-11" onClick={() => onChange({ ...value, [kind]: value[kind].filter((_, j) => j !== i) })}>حذف</Button>
    </div>
  );
  return (
    <div className="mt-2 space-y-2 rounded-md border border-border p-3" data-testid="payroll-adjust-editor">
      {value.bonuses.map((x, i) => row("bonuses", i, x))}
      {value.deductions.map((x, i) => row("deductions", i, x))}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="min-h-11" onClick={() => onChange({ ...value, bonuses: [...value.bonuses, { label: "", amount: "" }] })} data-testid="payroll-add-bonus">+ بونص</Button>
        <Button variant="outline" className="min-h-11" onClick={() => onChange({ ...value, deductions: [...value.deductions, { label: "", amount: "" }] })} data-testid="payroll-add-deduction">+ خصم</Button>
        <Button className="min-h-11" disabled={busy || !valid} onClick={onSave} data-testid="payroll-adjust-save">حفظ</Button>
        <Button variant="ghost" className="min-h-11" onClick={onCancel}>إلغاء</Button>
      </div>
    </div>
  );
}

function AdvancesSection() {
  const utils = trpc.useUtils();
  const list = trpc.ledger.payroll.advances.list.useQuery(undefined, { retry: false });
  const emps = trpc.employees.list.useQuery({ isActive: true }, { retry: false });
  const accounts = trpc.ledger.accounts.list.useQuery(undefined, { retry: false });
  const issue = trpc.ledger.payroll.advances.issue.useMutation();
  const cancel = trpc.ledger.payroll.advances.cancel.useMutation();
  const [f, setF] = useState({ employeeId: 0, principal: "", installments: "3", firstDue: thisMonth(), issuedOn: cairoToday(), from: "" });
  const [opId, setOpId] = useState(newOperationId);
  const [busy, setBusy] = useState(false);
  const [cancelFor, setCancelFor] = useState<{ id: number; reason: string } | null>(null);
  if (list.error || !list.data?.available) return null;
  const employees = ((emps.data ?? []) as any[]).map(e => ({ id: Number(e.id), name: String(e.name) }));
  const cash = ((accounts.data ?? []) as unknown as UiAccount[]).filter(a => ["cash", "bank", "wallet"].includes(a.kind));
  const employeeId = employees.some(e => e.id === f.employeeId) ? f.employeeId : employees[0]?.id ?? 0;
  const from = cash.some(a => a.code === f.from) ? f.from : cash[0]?.code ?? "";
  const n = Number(f.installments);
  const valid = employeeId > 0 && from && /^\d{1,14}(\.\d{1,4})?$/.test(f.principal.trim()) && Number(f.principal) > 0 && Number.isInteger(n) && n >= 1 && n <= 60 && /^\d{4}-\d{2}$/.test(f.firstDue);
  const run = async (fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); toast.success(ok); after?.(); await utils.ledger.payroll.advances.list.invalidate(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <SectionCard title="السلف" testId="payroll-advances">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div><Label htmlFor="adv-emp">الموظف</Label>
          <select id="adv-emp" value={employeeId} onChange={e => setF({ ...f, employeeId: Number(e.target.value) })} className="mt-1 block min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm" data-testid="adv-emp">
            {employees.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <div><Label htmlFor="adv-amount">المبلغ</Label><Input id="adv-amount" inputMode="decimal" value={f.principal} onChange={e => setF({ ...f, principal: e.target.value })} className="mt-1 min-h-11" dir="ltr" data-testid="adv-amount" /></div>
        <div><Label htmlFor="adv-n">عدد الأقساط</Label><Input id="adv-n" inputMode="numeric" value={f.installments} onChange={e => setF({ ...f, installments: e.target.value })} className="mt-1 min-h-11" dir="ltr" data-testid="adv-n" /></div>
        <div><Label htmlFor="adv-due">أول قسط</Label><Input id="adv-due" type="month" value={f.firstDue} onChange={e => setF({ ...f, firstDue: e.target.value })} className="mt-1 min-h-11" dir="ltr" /></div>
        <div><Label htmlFor="adv-on">تاريخ الصرف</Label><Input id="adv-on" type="date" value={f.issuedOn} onChange={e => setF({ ...f, issuedOn: e.target.value })} className="mt-1 min-h-11" dir="ltr" /></div>
        <div><Label htmlFor="adv-from">من</Label>
          <select id="adv-from" value={from} onChange={e => setF({ ...f, from: e.target.value })} className="mt-1 block min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm">
            {cash.map(a => <option key={a.id} value={a.code}>{a.name}</option>)}
          </select>
        </div>
      </div>
      <Button className="mt-2 min-h-11" disabled={busy || !valid} data-testid="adv-issue"
        onClick={() => run(() => issue.mutateAsync({ employeeId, principal: f.principal.trim(), issuedOn: f.issuedOn, installmentsCount: n, firstDueMonth: f.firstDue, fromAccountCode: from, operationId: opId }), "صُرفت السلفة", () => { setOpId(newOperationId()); setF({ ...f, principal: "" }); })}>صرف سلفة</Button>
      <ul className="mt-3 divide-y divide-border text-sm">
        {(list.data.advances as any[]).map(a => (
          <li key={a.id} className="py-2" data-testid={`adv-${a.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>{a.employeeName} · <span className="tabular-nums">{money(a.principal)}</span> على {a.installmentsCount} · المتبقي <b className="tabular-nums">{money(a.balance)}</b>{a.nextDue ? ` · القسط التالي ${a.nextDue}` : ""}</span>
              <span className="flex items-center gap-2">
                <StatusBadge status={a.status} label={ADV_STATUS[a.status] ?? a.status} tone={a.status === "cancelled" ? "danger" : a.status === "settled" ? "success" : "info"} size="sm" icon={null} />
                {a.status === "active" && a.repaid === "0.0000" && <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setCancelFor({ id: a.id, reason: "" })}>إلغاء</Button>}
              </span>
            </div>
            {cancelFor && cancelFor.id === a.id && (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <Input aria-label="سبب إلغاء السلفة" value={cancelFor.reason} onChange={e => setCancelFor({ id: a.id, reason: e.target.value })} placeholder="السبب (إلزامي)" className="min-h-11" />
                <Button variant="destructive" className="min-h-11" disabled={busy || cancelFor.reason.trim().length < 3} onClick={() => { const why = cancelFor.reason.trim(); run(() => cancel.mutateAsync({ advanceId: a.id, reason: why }), "أُلغيت السلفة بالعكس", () => setCancelFor(null)); }}>تأكيد الإلغاء</Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
