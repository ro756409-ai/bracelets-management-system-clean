import { useMemo, useState } from "react";
import { Factory } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePermissions } from "@/hooks/usePermission";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, PageHeader, SectionCard, StatusBadge } from "@/components/shared";
import { toast } from "sonner";
import { cairoToday, expenseAccounts, inventoryAccounts, money, newOperationId, type UiAccount } from "./ledgerUi";

/**
 * «الموردون والورشة» (المرحلة 6) — للمالك ومدير الحسابات: هوية مورد بكود، فواتير/دفعات/مقدّم/تطبيق/مرتجع بقيد لكل مستند،
 * إلغاء بالعكس بسبب، كشف وأعمار؛ والورشة: دفعات بعهدة كمية وقيمة، استلام جزئي، عجز (على الورشة أو خسارة باختيار صريح)، تصليح.
 */
const DOC_LABEL: Record<string, string> = { invoice: "فاتورة", payment: "دفعة", advance: "دفعة مقدمة", advance_application: "تطبيق مقدّم", return_credit: "مرتجع للمورد" };
const AGING: [string, string][] = [["notDue", "غير مستحق"], ["d1_30", "1–30 يوم"], ["d31_60", "31–60"], ["d61_90", "61–90"], ["d90plus", "+90"]];
const EV_LABEL: Record<string, string> = { send: "إرسال", receive: "استلام", shortage: "عجز", repair_cost: "تصليح" };
const select = "mt-1 block min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm";

export default function LedgerSuppliers() {
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const list = trpc.ledger.suppliers.list.useQuery(undefined, { retry: false });
  const [selected, setSelected] = useState<number | null>(null);
  if (status.data && !status.data.enabled) return <EmptyState title="دفتر الحسابات غير مفعّل لهذه الشركة" description="الموردون يبدأون بعد التفعيل." className="m-4" />;
  if (list.error) return <EmptyState title="الموردون على مستوى الشركة" description={list.error.message} className="m-4" />;
  if (list.data && !list.data.available) return <EmptyState title="الموردون غير متاحين بعد" description={`تحتاج تطبيق ${list.data.reason === "0046" ? "أنواع الحسابات (0046)" : "جداول الموردين (0049)"} أولًا.`} className="m-4" />;
  const suppliers = (list.data?.suppliers ?? []) as any[];
  return (
    <div className="space-y-4" dir="rtl" data-testid="ledger-suppliers">
      <PageHeader title="الموردون والورشة" description="كل مستند بقيد واحد، والمستحق لكل مورد من قيوده؛ الإلغاء بالعكس فقط" icon={<Factory className="h-5 w-5" aria-hidden="true" />} />
      {list.data && !(list.data as any).accountsReady && <SetupCard />}
      <NewSupplierCard />
      <SectionCard title="الموردون" testId="suppliers-list">
        {suppliers.length === 0 ? <p className="text-sm text-muted-foreground">لا موردين بعد.</p> : (
          <ul className="divide-y divide-border text-sm">
            {suppliers.map(s => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`supplier-${s.id}`}>
                <span><b>{s.name}</b> <span className="font-mono text-xs" dir="ltr">{s.code}</span>{s.isWorkshop && <StatusBadge status="workshop" label="ورشة" tone="info" size="sm" icon={null} />}{!s.isActive && <StatusBadge status="inactive" label="موقوف" tone="warning" size="sm" icon={null} />}</span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">مستحق {money(s.payable ?? "0")}{s.advance && s.advance !== "0.0000" ? ` · مقدّم ${money(s.advance)}` : ""}</span>
                  <Button size="sm" variant="outline" className="min-h-11" onClick={() => setSelected(s.id)} data-testid={`supplier-open-${s.id}`}>الكشف</Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      {selected != null && <SupplierDetail supplierId={selected} />}
    </div>
  );
}

function SetupCard() {
  const utils = trpc.useUtils();
  const ensure = trpc.ledger.suppliers.ensureAccounts.useMutation();
  return (
    <SectionCard title="حسابات الموردين" testId="suppliers-setup">
      <p className="text-xs text-muted-foreground">موردون، دفعات مقدمة، عهدة الورشة، عجز الورشة، التصليح — تُنشأ مرة واحدة وتُرحَّل آليًا فقط.</p>
      <Button className="mt-2 min-h-11" disabled={ensure.isPending} data-testid="suppliers-ensure"
        onClick={async () => { try { await ensure.mutateAsync(); toast.success("جُهّزت حسابات الموردين"); await utils.ledger.suppliers.list.invalidate(); } catch (e) { toast.error((e as Error).message); } }}>تجهيز</Button>
    </SectionCard>
  );
}

function NewSupplierCard() {
  const utils = trpc.useUtils();
  const create = trpc.ledger.suppliers.create.useMutation();
  const [f, setF] = useState({ code: "", name: "", phone: "", isWorkshop: false });
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Za-z0-9_-]{2,40}$/.test(f.code.trim()) && f.name.trim().length >= 2;
  const run = async () => {
    if (busy) return;
    setBusy(true);
    try { await create.mutateAsync({ code: f.code.trim(), name: f.name.trim(), phone: f.phone.trim() || undefined, isWorkshop: f.isWorkshop }); toast.success("أُضيف المورد"); setF({ code: "", name: "", phone: "", isWorkshop: false }); await utils.ledger.suppliers.list.invalidate(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <SectionCard title="مورد جديد" testId="supplier-new">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <div><Label htmlFor="sp-code">الكود</Label><Input id="sp-code" value={f.code} onChange={e => setF({ ...f, code: e.target.value })} className="mt-1 min-h-11" dir="ltr" data-testid="sp-code" /></div>
        <div><Label htmlFor="sp-name">الاسم</Label><Input id="sp-name" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} className="mt-1 min-h-11" data-testid="sp-name" /></div>
        <div><Label htmlFor="sp-phone">الهاتف</Label><Input id="sp-phone" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} className="mt-1 min-h-11" dir="ltr" /></div>
        <label className="flex min-h-11 items-end gap-2 pb-2 text-sm"><input type="checkbox" checked={f.isWorkshop} onChange={e => setF({ ...f, isWorkshop: e.target.checked })} data-testid="sp-workshop" /> ورشة تصنيع</label>
      </div>
      <Button className="mt-2 min-h-11" disabled={busy || !valid} onClick={run} data-testid="sp-create">إضافة</Button>
    </SectionCard>
  );
}

function SupplierDetail({ supplierId }: { supplierId: number }) {
  const { has } = usePermissions();
  const utils = trpc.useUtils();
  const st = trpc.ledger.suppliers.statement.useQuery({ supplierId }, { retry: false });
  const cancel = trpc.ledger.suppliers.cancelDocument.useMutation();
  const [cancelFor, setCancelFor] = useState<{ id: number; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (st.error) return <SectionCard title="كشف المورد" testId="supplier-detail"><p className="text-sm text-destructive" role="alert">{st.error.message}</p></SectionCard>;
  if (!st.data) return null;
  const s = st.data as any;
  const refresh = async () => { await utils.ledger.suppliers.statement.invalidate({ supplierId }); await utils.ledger.suppliers.list.invalidate(); };
  const doCancel = async () => {
    if (!cancelFor || busy) return;
    const { id, reason } = cancelFor;
    setBusy(true);
    try { await cancel.mutateAsync({ documentId: id, reason: reason.trim() }); toast.success("أُلغي المستند بقيد عكسي"); setCancelFor(null); await refresh(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      <SectionCard title={`كشف ${s.supplier.name}`} testId="supplier-detail">
        <p className="text-sm">المستحق له <b className="tabular-nums" data-testid="supplier-payable">{money(s.payable)}</b> ج.م · دفعات مقدمة <b className="tabular-nums">{money(s.advance)}</b> ج.م</p>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-5" data-testid="supplier-aging">
          {AGING.map(([k, label]) => <div key={k} className="rounded-md border border-border p-2"><div className="text-muted-foreground">{label}</div><div className="tabular-nums">{money(s.aging[k])}</div></div>)}
        </div>
        <ul className="mt-3 divide-y divide-border text-sm">
          {s.documents.map((d: any) => (
            <li key={d.id} className="py-2" data-testid={`supplier-doc-${d.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{d.opening && <StatusBadge status="opening" label="افتتاحي" tone="info" size="sm" icon={null} />} {DOC_LABEL[d.docType] ?? d.docType} <b dir="ltr">{d.docNo}</b> · {d.docDate}{d.dueDate ? ` · يستحق ${d.dueDate}` : ""}</span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">{money(d.amount)}</span>
                  {d.cancelled ? <StatusBadge status="cancelled" label="ملغى بالعكس" tone="danger" size="sm" icon={null} />
                    : <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setCancelFor({ id: d.id, reason: "" })}>إلغاء</Button>}
                </span>
              </div>
              {cancelFor && cancelFor.id === d.id && (
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <Input aria-label="سبب الإلغاء" value={cancelFor.reason} onChange={e => setCancelFor({ id: d.id, reason: e.target.value })} placeholder="السبب (إلزامي)" className="min-h-11" data-testid="doc-cancel-reason" />
                  <Button variant="destructive" className="min-h-11" disabled={busy || cancelFor.reason.trim().length < 3} onClick={doCancel} data-testid="doc-cancel-run">تأكيد</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </SectionCard>
      <DocumentForm supplierId={supplierId} advancesOpen={s.advancesOpen} onDone={refresh} />
      {has("ledger.activate") && <SupplierOpeningForm supplierId={supplierId} onDone={refresh} />}
      {s.supplier.isWorkshop && <WorkshopSection supplierId={supplierId} onDone={refresh} />}
    </>
  );
}

/** رصيد افتتاحي لمورد (المالك فقط): لكل فاتورة/دفعة مقدمة قائمة يوم Go-live بمستندها الأصلي ومرجع المطابقة — لا مخزون ولا مصروف. */
function SupplierOpeningForm({ supplierId, onDone }: { supplierId: number; onDone: () => Promise<void> }) {
  const post = trpc.ledger.suppliers.opening.useMutation();
  const [f, setF] = useState({ side: "payable" as "payable" | "advance", docNo: "", date: "", due: "", amount: "", evidence: "" });
  const [busy, setBusy] = useState(false);
  const valid = f.docNo.trim() && /^\d{4}-\d{2}-\d{2}$/.test(f.date) && /^\d{1,14}(\.\d{1,4})?$/.test(f.amount.trim()) && Number(f.amount) > 0 && f.evidence.trim().length >= 5;
  const run = async () => {
    if (busy || !valid) return;
    setBusy(true);
    try {
      const r = await post.mutateAsync({ supplierId, side: f.side, originalDocNo: f.docNo.trim(), originalDate: f.date, dueDate: f.side === "payable" && f.due ? f.due : null, amount: f.amount.trim(), evidenceRef: f.evidence.trim() });
      toast.success(r.replay ? "مسجّل بالفعل — لم يتكرر" : "سُجّل الرصيد الافتتاحي"); setF({ ...f, docNo: "", amount: "", due: "" }); await onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <SectionCard title="رصيد افتتاحي للمورد (المالك)" testId="supplier-opening">
      <p className="text-xs text-muted-foreground">لكل فاتورة أو دفعة مقدمة قائمة يوم Go-live: رقمها وتاريخها الأصليان ومرجع مستند المطابقة (كشف حساب أو إقرار المورد). يُسجَّل بتاريخ Go-live مقابل الرصيد الافتتاحي — لا مخزون ولا مصروف.</p>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div><Label htmlFor="so-side">النوع</Label><select id="so-side" value={f.side} onChange={e => setF({ ...f, side: e.target.value as any })} className={select} data-testid="so-side"><option value="payable">مستحق له</option><option value="advance">دفعة مقدمة له</option></select></div>
        <div><Label htmlFor="so-no">رقم المستند الأصلي</Label><Input id="so-no" value={f.docNo} onChange={e => setF({ ...f, docNo: e.target.value })} className="mt-1 min-h-11" dir="ltr" data-testid="so-no" /></div>
        <div><Label htmlFor="so-amount">المبلغ القائم</Label><Input id="so-amount" inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} className="mt-1 min-h-11" dir="ltr" data-testid="so-amount" /></div>
        <div><Label htmlFor="so-date">تاريخ المستند الأصلي</Label><Input id="so-date" type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} className="mt-1 min-h-11" dir="ltr" data-testid="so-date" /></div>
        {f.side === "payable" && <div><Label htmlFor="so-due">الاستحقاق الأصلي</Label><Input id="so-due" type="date" value={f.due} onChange={e => setF({ ...f, due: e.target.value })} className="mt-1 min-h-11" dir="ltr" /></div>}
        <div><Label htmlFor="so-ev">مرجع المطابقة</Label><Input id="so-ev" value={f.evidence} onChange={e => setF({ ...f, evidence: e.target.value })} className="mt-1 min-h-11" placeholder="كشف حساب المورد بتاريخ…" data-testid="so-ev" /></div>
      </div>
      <Button className="mt-2 min-h-11" disabled={busy || !valid} onClick={run} data-testid="so-post">تسجيل الرصيد الافتتاحي</Button>
    </SectionCard>
  );
}

function DocumentForm({ supplierId, advancesOpen, onDone }: { supplierId: number; advancesOpen: { documentId: number; docNo: string; remaining: string }[]; onDone: () => Promise<void> }) {
  const post = trpc.ledger.suppliers.postDocument.useMutation();
  const accounts = trpc.ledger.accounts.list.useQuery(undefined, { retry: false });
  const businesses = trpc.ledger.businesses.list.useQuery(undefined, { retry: false });
  const [f, setF] = useState({ docType: "invoice", docNo: "", docDate: cairoToday(), dueDate: "", amount: "", businessId: 0, item: "", cash: "", applies: 0, receipt: "" });
  const [busy, setBusy] = useState(false);
  const accs = (accounts.data ?? []) as unknown as UiAccount[];
  const itemList = useMemo(() => f.docType === "invoice" ? [...inventoryAccounts(accs), ...expenseAccounts(accs)] : inventoryAccounts(accs), [accs, f.docType]);
  const cashList = accs.filter(a => ["cash", "bank", "wallet"].includes(a.kind));
  const bizList = (businesses.data ?? []) as { id: number; name: string }[];
  const pick = <T extends { code: string }>(list: T[], v: string) => (list.some(a => a.code === v) ? v : list[0]?.code ?? "");
  const item = pick(itemList, f.item), cash = pick(cashList, f.cash);
  const businessId = bizList.some(b => b.id === f.businessId) ? f.businessId : bizList[0]?.id ?? 0;
  const applies = advancesOpen.some(a => a.documentId === f.applies) ? f.applies : advancesOpen[0]?.documentId ?? 0;
  const needsItem = f.docType === "invoice" || f.docType === "return_credit", needsCash = f.docType === "payment" || f.docType === "advance";
  const valid = f.docNo.trim().length > 0 && /^\d{1,14}(\.\d{1,4})?$/.test(f.amount.trim()) && Number(f.amount) > 0 && (!needsItem || (item && businessId > 0)) && (!needsCash || cash) && (f.docType !== "advance_application" || applies > 0);
  const run = async () => {
    if (busy || !valid) return;
    setBusy(true);
    try {
      await post.mutateAsync({ supplierId, docType: f.docType as any, docNo: f.docNo.trim(), docDate: f.docDate, dueDate: f.docType === "invoice" && f.dueDate ? f.dueDate : null, amount: f.amount.trim(),
        businessId: needsItem ? businessId : null, itemAccountCode: needsItem ? item : undefined, cashAccountCode: needsCash ? cash : undefined,
        appliesToDocumentId: f.docType === "advance_application" ? applies : null, purchaseReceiptId: f.docType === "invoice" && f.receipt.trim() ? Number(f.receipt) : null });
      toast.success("سُجّل المستند"); setF({ ...f, docNo: "", amount: "", receipt: "" }); await onDone();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <SectionCard title="مستند جديد" testId="supplier-doc-form">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div><Label htmlFor="dc-type">النوع</Label>
          <select id="dc-type" value={f.docType} onChange={e => setF({ ...f, docType: e.target.value })} className={select} data-testid="dc-type">
            {Object.entries(DOC_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div><Label htmlFor="dc-no">رقم المستند</Label><Input id="dc-no" value={f.docNo} onChange={e => setF({ ...f, docNo: e.target.value })} className="mt-1 min-h-11" dir="ltr" data-testid="dc-no" /></div>
        <div><Label htmlFor="dc-amount">المبلغ</Label><Input id="dc-amount" inputMode="decimal" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} className="mt-1 min-h-11" dir="ltr" data-testid="dc-amount" /></div>
        <div><Label htmlFor="dc-date">التاريخ</Label><Input id="dc-date" type="date" value={f.docDate} onChange={e => setF({ ...f, docDate: e.target.value })} className="mt-1 min-h-11" dir="ltr" /></div>
        {f.docType === "invoice" && <div><Label htmlFor="dc-due">الاستحقاق</Label><Input id="dc-due" type="date" value={f.dueDate} onChange={e => setF({ ...f, dueDate: e.target.value })} className="mt-1 min-h-11" dir="ltr" /></div>}
        {f.docType === "invoice" && <div><Label htmlFor="dc-rc">رقم إيصال الاستلام (اختياري)</Label><Input id="dc-rc" inputMode="numeric" value={f.receipt} onChange={e => setF({ ...f, receipt: e.target.value.replace(/\D/g, "") })} className="mt-1 min-h-11" dir="ltr" /></div>}
        {needsItem && <div><Label htmlFor="dc-biz">النشاط</Label><select id="dc-biz" value={businessId} onChange={e => setF({ ...f, businessId: Number(e.target.value) })} className={select}>{bizList.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>}
        {needsItem && <div><Label htmlFor="dc-item">{f.docType === "invoice" ? "على حساب" : "من مخزون"}</Label><select id="dc-item" value={item} onChange={e => setF({ ...f, item: e.target.value })} className={select} data-testid="dc-item">{itemList.map(a => <option key={a.id} value={a.code}>{a.name}</option>)}</select></div>}
        {needsCash && <div><Label htmlFor="dc-cash">من</Label><select id="dc-cash" value={cash} onChange={e => setF({ ...f, cash: e.target.value })} className={select} data-testid="dc-cash">{cashList.map(a => <option key={a.id} value={a.code}>{a.name}</option>)}</select></div>}
        {f.docType === "advance_application" && <div><Label htmlFor="dc-adv">الدفعة المقدمة</Label><select id="dc-adv" value={applies} onChange={e => setF({ ...f, applies: Number(e.target.value) })} className={select}>{advancesOpen.map(a => <option key={a.documentId} value={a.documentId}>{a.docNo} — متبقٍ {money(a.remaining)}</option>)}</select></div>}
      </div>
      <Button className="mt-2 min-h-11" disabled={busy || !valid} onClick={run} data-testid="dc-post">تسجيل</Button>
    </SectionCard>
  );
}

function WorkshopSection({ supplierId, onDone }: { supplierId: number; onDone: () => Promise<void> }) {
  const utils = trpc.useUtils();
  const batches = trpc.ledger.suppliers.batches.useQuery({ supplierId }, { retry: false });
  const businesses = trpc.ledger.businesses.list.useQuery(undefined, { retry: false });
  const create = trpc.ledger.suppliers.createBatch.useMutation();
  const event = trpc.ledger.suppliers.workshopEvent.useMutation();
  const reverse = trpc.ledger.suppliers.reverseWorkshopEvent.useMutation();
  const [rev, setRev] = useState<{ eventId: number; reason: string } | null>(null);
  const [nb, setNb] = useState({ reference: "", pieceWage: "", businessId: 0 });
  const [ev, setEv] = useState<{ batchId: number; eventType: "send" | "receive" | "shortage" | "repair_cost"; quantity: string; value: string; chargeTo: "" | "workshop" | "loss"; note: string; date: string } | null>(null);
  const [opId, setOpId] = useState(newOperationId);
  const [busy, setBusy] = useState(false);
  const bizList = (businesses.data ?? []) as { id: number; name: string }[];
  const businessId = bizList.some(b => b.id === nb.businessId) ? nb.businessId : bizList[0]?.id ?? 0;
  const refresh = async () => { await utils.ledger.suppliers.batches.invalidate({ supplierId }); await onDone(); };
  const run = async (fn: () => Promise<unknown>, ok: string, after?: () => void) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); toast.success(ok); after?.(); await refresh(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const evValid = ev && (ev.eventType === "repair_cost" ? /^\d{1,14}(\.\d{1,4})?$/.test(ev.value.trim()) && ev.note.trim().length >= 3
    : Number.isInteger(Number(ev.quantity)) && Number(ev.quantity) > 0 && (ev.eventType !== "send" || /^\d{1,14}(\.\d{1,4})?$/.test(ev.value.trim())) && (ev.eventType !== "shortage" || ev.chargeTo !== ""));
  return (
    <SectionCard title="دفعات الورشة" testId="workshop">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <div><Label htmlFor="wb-ref">مرجع الدفعة</Label><Input id="wb-ref" value={nb.reference} onChange={e => setNb({ ...nb, reference: e.target.value })} className="mt-1 min-h-11" dir="ltr" /></div>
        <div><Label htmlFor="wb-wage">أجر القطعة</Label><Input id="wb-wage" inputMode="decimal" value={nb.pieceWage} onChange={e => setNb({ ...nb, pieceWage: e.target.value })} className="mt-1 min-h-11" dir="ltr" /></div>
        <div><Label htmlFor="wb-biz">النشاط</Label><select id="wb-biz" value={businessId} onChange={e => setNb({ ...nb, businessId: Number(e.target.value) })} className={select}>{bizList.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
        <div className="flex items-end"><Button className="min-h-11 w-full" disabled={busy || nb.reference.trim().length < 2 || !/^\d{1,14}(\.\d{1,4})?$/.test(nb.pieceWage.trim()) || !businessId}
          onClick={() => run(() => create.mutateAsync({ supplierId, businessId, reference: nb.reference.trim(), pieceWage: nb.pieceWage.trim() }), "أُنشئت الدفعة", () => setNb({ reference: "", pieceWage: "", businessId }))} data-testid="wb-create">دفعة جديدة</Button></div>
      </div>
      <ul className="mt-3 divide-y divide-border text-sm">
        {((batches.data ?? []) as any[]).map(b => (
          <li key={b.id} className="py-2" data-testid={`batch-${b.id}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span><b dir="ltr">{b.reference}</b> · أُرسل {b.sentQuantity} · استُلم {b.receivedQuantity} · عجز {b.shortageQuantity} · باقٍ <b>{b.remainingQuantity}</b> بقيمة <span className="tabular-nums">{money(b.remainingValue)}</span></span>
              {b.status === "closed" ? <StatusBadge status="closed" label="مغلقة" tone="success" size="sm" icon={null} /> : (
                <span className="flex flex-wrap gap-1">
                  {(["send", "receive", "shortage", "repair_cost"] as const).map(t => (
                    <Button key={t} size="sm" variant="outline" className="min-h-11" onClick={() => { setEv({ batchId: b.id, eventType: t, quantity: "", value: "", chargeTo: "", note: "", date: cairoToday() }); setOpId(newOperationId()); }} data-testid={`ev-${t}-${b.id}`}>
                      {{ send: "إرسال", receive: "استلام", shortage: "عجز", repair_cost: "تصليح" }[t]}
                    </Button>
                  ))}
                </span>
              )}
            </div>
            {b.events.some((x: any) => x.eventType !== "wage") && (
              <ul className="mt-2 space-y-1 text-xs" data-testid={`batch-events-${b.id}`}>
                {b.events.filter((x: any) => x.eventType !== "wage").map((x: any) => (
                  <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-2 py-1" data-testid={`wev-${x.id}`}>
                    <span className={x.reversal ? "line-through text-muted-foreground" : ""}>{EV_LABEL[x.eventType] ?? x.eventType}{x.quantity ? ` ${x.quantity} قطعة` : ""} · <span className="tabular-nums">{money(x.value)}</span></span>
                    {x.reversal ? <span className="text-muted-foreground">صُحّح بالعكس {x.reversal.date}</span>
                      : <Button size="sm" variant="ghost" className="min-h-11" onClick={() => setRev({ eventId: x.id, reason: "" })} data-testid={`wev-reverse-${x.id}`}>تصحيح بالعكس</Button>}
                    {rev && rev.eventId === x.id && (
                      <div className="flex w-full flex-col gap-2 sm:flex-row">
                        <Input aria-label="سبب التصحيح" value={rev.reason} onChange={e => setRev({ eventId: x.id, reason: e.target.value })} placeholder="سبب التصحيح (إلزامي)" className="min-h-11" data-testid="wev-reason" />
                        <Button variant="destructive" className="min-h-11" disabled={busy || rev.reason.trim().length < 3} data-testid="wev-run"
                          onClick={() => { const why = rev.reason.trim(); run(() => reverse.mutateAsync({ eventId: x.id, reason: why }), "صُحّح الحدث بقيد عكسي", () => setRev(null)); }}>تأكيد</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {ev && ev.batchId === b.id && (
              <div className="mt-2 grid grid-cols-1 gap-2 rounded-md border border-border p-3 sm:grid-cols-3">
                {ev.eventType !== "repair_cost" && <div><Label htmlFor="ev-q">الكمية</Label><Input id="ev-q" inputMode="numeric" value={ev.quantity} onChange={e => setEv({ ...ev, quantity: e.target.value })} className="mt-1 min-h-11" dir="ltr" data-testid="ev-q" /></div>}
                {(ev.eventType === "send" || ev.eventType === "repair_cost") && <div><Label htmlFor="ev-v">{ev.eventType === "send" ? "قيمة الخامات (من سجل المخزون)" : "قيمة التصليح"}</Label><Input id="ev-v" inputMode="decimal" value={ev.value} onChange={e => setEv({ ...ev, value: e.target.value })} className="mt-1 min-h-11" dir="ltr" data-testid="ev-v" /></div>}
                {ev.eventType === "shortage" && (
                  <div role="radiogroup" aria-label="تحميل العجز" className="flex flex-col gap-1 text-sm">
                    <label className="flex min-h-11 items-center gap-2"><input type="radio" name="charge" checked={ev.chargeTo === "workshop"} onChange={() => setEv({ ...ev, chargeTo: "workshop" })} data-testid="ev-charge-workshop" /> على الورشة (يُخصم من مستحقها)</label>
                    <label className="flex min-h-11 items-center gap-2"><input type="radio" name="charge" checked={ev.chargeTo === "loss"} onChange={() => setEv({ ...ev, chargeTo: "loss" })} data-testid="ev-charge-loss" /> خسارة على النشاط</label>
                  </div>
                )}
                {ev.eventType === "repair_cost" && <div><Label htmlFor="ev-note">وصف التصليح</Label><Input id="ev-note" value={ev.note} onChange={e => setEv({ ...ev, note: e.target.value })} className="mt-1 min-h-11" /></div>}
                <div><Label htmlFor="ev-date">التاريخ</Label><Input id="ev-date" type="date" value={ev.date} onChange={e => setEv({ ...ev, date: e.target.value })} className="mt-1 min-h-11" dir="ltr" /></div>
                <div className="flex items-end gap-2 sm:col-span-3">
                  <Button className="min-h-11" disabled={busy || !evValid} data-testid="ev-run"
                    onClick={() => { const x = ev; run(() => event.mutateAsync({ batchId: x.batchId, eventType: x.eventType, quantity: x.eventType === "repair_cost" ? undefined : Number(x.quantity), value: x.value.trim() || undefined,
                      chargeTo: x.chargeTo || undefined, note: x.note.trim() || undefined, date: x.date, operationId: opId }), "سُجّل الحدث", () => setEv(null)); }}>تسجيل</Button>
                  <Button variant="ghost" className="min-h-11" onClick={() => setEv(null)}>إلغاء</Button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
