import { useMemo, useState } from "react";
import { Landmark, Plus, Settings2, Wallet } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePermissions } from "@/hooks/usePermission";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageHeader, SectionCard, StatusBadge, EmptyState, LoadingSkeleton } from "@/components/shared";
import { toast } from "sonner";
import {
  ACCOUNT_CODE_RE, CREATABLE_ACCOUNT_KINDS, accountKindLabel, availableCash, balanceText, codReceivableTotal, groupAccounts, isActiveAccount, normalSideForKind, suggestAccountCode,
  type CreatableAccountKind, type UiAccount,
} from "./ledgerUi";

/**
 * «الحسابات وأرصدتها» — قائمة حسابات الدفتر داخل نطاق القراءة من السيرفر (المحاسب: حسابات أنشطته فقط؛ مدير الحسابات
 * والمالك: الشركة كلها). النقدية المتاحة منفصلة عن ذمة COD. الإدارة (إضافة/تسمية/إيقاف/ربط نشاط) خلف
 * ledger.manage_accounts ويحكمها السيرفر؛ حسابات النظام لا تُوقف. لا حذف ولا تعديل رصيد مباشر.
 */
type Account = UiAccount & { businesses: { businessId: number; canPost: boolean }[] };

export default function LedgerAccounts() {
  const { has } = usePermissions();
  const status = trpc.ledger.status.useQuery(undefined, { retry: false });
  const enabled = status.data?.enabled === true;
  const list = trpc.ledger.accounts.list.useQuery(undefined, { enabled, retry: false });
  const businessesQuery = trpc.ledger.businesses.list.useQuery(undefined, { enabled, retry: false, staleTime: 60_000 });
  const businesses = businessesQuery.data ?? [];
  const bizName = useMemo(() => new Map(businesses.map(b => [b.id, b.name])), [businesses]);
  const canManage = has("ledger.manage_accounts");
  const [creating, setCreating] = useState(false);
  const [managingId, setManagingId] = useState<number | null>(null);
  const accounts = (list.data ?? []) as unknown as Account[];
  const managing = accounts.find(a => a.id === managingId) ?? null;

  if (status.data && !status.data.tablesPresent) return <EmptyState title="دفتر الحسابات غير مهيأ بعد" description="جداول الدفتر لم تُنشأ على هذه البيئة (الترحيلة 0040)." className="m-4" />;
  if (status.data && !status.data.enabled) return <EmptyState title="دفتر الحسابات غير مفعّل لهذه الشركة" description="الحسابات تظهر بعد التفعيل من المالك يوم Go-live." className="m-4" />;

  return (
    <div className="space-y-4" dir="rtl" data-testid="ledger-accounts">
      <PageHeader title="الحسابات وأرصدتها" description="الأرصدة محسوبة من الحركات المرحّلة — لا تعديل مباشر للرصيد" icon={<Landmark className="h-5 w-5" aria-hidden="true" />}
        actions={canManage ? <Button className="min-h-11 md:min-h-9" onClick={() => setCreating(true)} data-testid="ledger-account-new"><Plus className="h-4 w-4 ml-1" aria-hidden="true" /> إضافة حساب</Button> : undefined} />

      {list.isLoading || status.isLoading ? <LoadingSkeleton variant="table" rows={5} /> : list.error ? (
        <p className="text-sm text-destructive" role="alert">{list.error.message}</p>
      ) : accounts.length === 0 ? (
        <EmptyState title="لا توجد حسابات مرتبطة بنطاقك" description="الحسابات تظهر لك عند ربطها بنشاطك." />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="ledger-accounts-totals">
            <div className="rounded-[var(--radius-brand-md)] border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground">النقدية المتاحة (خزن + بنوك + محافظ)</p>
              <p className="mt-1 text-lg font-bold tabular-nums" data-testid="ledger-accounts-cash-total">{balanceText(availableCash(accounts))}</p>
            </div>
            <div className="rounded-[var(--radius-brand-md)] border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground">ذمة COD على شركات الشحن — ليست نقدية متاحة</p>
              <p className="mt-1 text-lg font-bold tabular-nums" data-testid="ledger-accounts-cod-total">{balanceText(codReceivableTotal(accounts))}</p>
            </div>
          </div>
          {accounts.some(a => a.currentBalance == null) && (
            <p className="rounded-[var(--radius-brand-md)] border border-border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="ledger-accounts-hidden-note">
              بعض الحسابات مشتركة مع أنشطة خارج نطاقك أو عليها قيود على مستوى الشركة، فرصيدها وإجمالياتها تظهر للمالك ومدير الحسابات فقط.
            </p>
          )}
          {groupAccounts(accounts).map(g => (
            <SectionCard key={g.key} title={g.title} testId={`ledger-accounts-group-${g.key}`}>
              <ul className="divide-y divide-border">
                {g.accounts.map(a => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5" data-testid={`ledger-account-${a.code}`}>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{a.name}</span>
                        <span className="font-mono text-xs text-muted-foreground" dir="ltr">{a.code}</span>
                        {!isActiveAccount(a) && <StatusBadge status="inactive" label="موقوف" tone="neutral" size="sm" icon={null} />}
                        {a.isSystem && <StatusBadge status="system" label="حساب نظام" tone="info" size="sm" icon={null} />}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1 text-xs text-muted-foreground">
                        <span>{accountKindLabel(a.kind)}</span>
                        {a.businesses.filter(b => b.canPost).map(b => (
                          <span key={b.businessId} className="rounded-[var(--radius-brand-pill)] bg-muted px-2 py-0.5">{bizName.get(b.businessId) ?? "نشاط"}</span>
                        ))}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="font-semibold tabular-nums" data-testid={`ledger-account-balance-${a.code}`}>{balanceText(a.currentBalance)}</span>
                      {canManage && <Button variant="ghost" size="sm" className="min-h-11 md:min-h-9" onClick={() => setManagingId(a.id)} aria-label={`إدارة ${a.name}`} data-testid={`ledger-account-manage-${a.code}`}><Settings2 className="h-4 w-4" aria-hidden="true" /></Button>}
                    </div>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ))}
        </>
      )}

      {accounts.length > 0 && <PositionSection />}

      {creating && <CreateAccountDialog onClose={() => setCreating(false)} onDone={async () => { await list.refetch(); }} />}
      {managing && <ManageAccountDialog account={managing} businesses={businesses} onClose={() => setManagingId(null)} onDone={async () => { await list.refetch(); }} />}
    </div>
  );
}

/** إضافة حساب — الكود المقترح ثابت طوال فتح النافذة (إعادة الإرسال = replay لا حساب مكرر)، وطلب واحد أثناء التنفيذ. */
export function CreateAccountDialog({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> | void }) {
  const [kind, setKind] = useState<CreatableAccountKind>("expense");
  const [name, setName] = useState("");
  const [code, setCode] = useState(() => suggestAccountCode("expense"));
  const [codeEdited, setCodeEdited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const create = trpc.ledger.account.create.useMutation();
  const pending = submitting || create.isPending;
  const submit = async () => {
    if (pending) return;
    if (!name.trim()) return toast.error("اكتب اسم الحساب");
    if (!ACCOUNT_CODE_RE.test(code)) return toast.error("الكود: حروف لاتينية كبيرة وأرقام و_ (يبدأ بحرف)");
    setSubmitting(true);
    try {
      const r = await create.mutateAsync({ code, name: name.trim(), kind, normalSide: normalSideForKind(kind) });
      toast.success(r.replay ? "الحساب موجود بالفعل بنفس الكود" : `أُضيف الحساب «${name.trim()}»`);
      await onDone();
      onClose();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSubmitting(false); }
  };
  return (
    <Dialog open onOpenChange={o => { if (!o && !submitting) onClose(); }}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-md p-0" dir="rtl" data-testid="ledger-account-create-dialog">
        <DialogHeader className="border-b py-3 pl-4 pr-16 text-start md:pr-14">
          <DialogTitle>إضافة حساب</DialogTitle>
          <DialogDescription>الحساب الجديد يبدأ برصيد صفر؛ الرصيد يتكوّن من الحركات فقط. اربطه بالأنشطة بعد الإضافة.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-4 py-4">
          <div>
            <Label htmlFor="ledger-account-kind">النوع</Label>
            <select id="ledger-account-kind" value={kind} onChange={e => { const k = e.target.value as CreatableAccountKind; setKind(k); if (!codeEdited) setCode(suggestAccountCode(k)); }}
              className="mt-1 block min-h-11 w-full rounded-md border border-input bg-background px-3 text-sm" data-testid="ledger-account-kind">
              {CREATABLE_ACCOUNT_KINDS.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </div>
          <div><Label htmlFor="ledger-account-name">الاسم</Label><Input id="ledger-account-name" value={name} onChange={e => setName(e.target.value)} maxLength={120} className="mt-1 min-h-11" placeholder="مثال: إيجار المخزن" data-testid="ledger-account-name" /></div>
          <div>
            <Label htmlFor="ledger-account-code">الكود (لاتيني، لا يتغير بعد الإضافة)</Label>
            <Input id="ledger-account-code" value={code} onChange={e => { setCode(e.target.value.toUpperCase()); setCodeEdited(true); }} maxLength={50} className="mt-1 min-h-11 font-mono" dir="ltr" data-testid="ledger-account-code" />
          </div>
        </div>
        <div className="flex gap-2 border-t px-4 py-3">
          <Button className="min-h-12 flex-1" onClick={submit} disabled={pending} data-testid="ledger-account-create-confirm">{pending ? "جارٍ الإضافة…" : "إضافة الحساب"}</Button>
          <Button variant="outline" className="min-h-12" onClick={onClose} disabled={submitting}>إلغاء</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** إدارة حساب: تسمية، إيقاف/تشغيل (حسابات النظام لا تُوقف)، وربط/فك ربط الأنشطة داخل نطاق الجلسة — طلب واحد في كل مرة. */
export function ManageAccountDialog({ account, businesses, onClose, onDone }: { account: Account; businesses: { id: number; name: string }[]; onClose: () => void; onDone: () => Promise<void> | void }) {
  const [name, setName] = useState(account.name);
  const [busy, setBusy] = useState<string | null>(null);
  const rename = trpc.ledger.account.updateName.useMutation();
  const setActive = trpc.ledger.account.setActive.useMutation();
  const grant = trpc.ledger.account.grantBusiness.useMutation();
  const revoke = trpc.ledger.account.revokeBusiness.useMutation();
  const active = isActiveAccount(account);
  const linked = new Set(account.businesses.filter(b => b.canPost).map(b => b.businessId));
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    if (busy) return; // طلب واحد في كل مرة
    setBusy(key);
    try { await fn(); toast.success(ok); await onDone(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(null); }
  };
  return (
    <Dialog open onOpenChange={o => { if (!o && !busy) onClose(); }}>
      <DialogContent className="flex max-h-[92dvh] w-[calc(100vw-1.5rem)] max-w-md flex-col gap-0 overflow-hidden p-0" dir="rtl" data-testid="ledger-account-manage-dialog">
        <DialogHeader className="border-b py-3 pl-4 pr-16 text-start md:pr-14">
          <DialogTitle>{account.name}</DialogTitle>
          <DialogDescription>{accountKindLabel(account.kind)} · <span dir="ltr" className="font-mono">{account.code}</span> — الكود والنوع لا يتغيران، والرصيد من الحركات فقط.</DialogDescription>
        </DialogHeader>
        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div>
            <Label htmlFor="ledger-account-rename">الاسم</Label>
            <div className="mt-1 flex gap-2">
              <Input id="ledger-account-rename" value={name} onChange={e => setName(e.target.value)} maxLength={120} className="min-h-11 flex-1" data-testid="ledger-account-rename" />
              <Button variant="outline" className="min-h-11" disabled={!!busy || !name.trim() || name.trim() === account.name}
                onClick={() => run("rename", () => rename.mutateAsync({ accountId: account.id, name: name.trim() }), "حُفظ الاسم")} data-testid="ledger-account-rename-save">حفظ</Button>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-brand-md)] border border-border p-3">
            <div className="min-w-0 text-sm">
              <p className="font-medium">{active ? "الحساب يعمل" : "الحساب موقوف"}</p>
              <p className="text-xs text-muted-foreground">{account.isSystem ? "حساب نظام — لا يُوقف." : "الإيقاف يمنع الحركات الجديدة فقط؛ التاريخ والرصيد يبقيان."}</p>
            </div>
            {!account.isSystem && (
              <Button variant="outline" className="min-h-11" disabled={!!busy}
                onClick={() => run("active", () => setActive.mutateAsync({ accountId: account.id, isActive: !active }), active ? "أُوقف الحساب" : "أُعيد تشغيل الحساب")} data-testid="ledger-account-toggle-active">
                {active ? "إيقاف" : "تشغيل"}
              </Button>
            )}
          </div>
          <div>
            <p className="text-sm font-medium">الأنشطة المسموح لها بالترحيل على الحساب</p>
            {businesses.length === 0 ? <p className="mt-1 text-xs text-muted-foreground">لا أنشطة في نطاقك.</p> : (
              <ul className="mt-2 divide-y divide-border rounded-[var(--radius-brand-md)] border border-border">
                {businesses.map(b => {
                  const on = linked.has(b.id);
                  return (
                    <li key={b.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm" data-testid={`ledger-account-biz-${b.id}`}>
                      <span className="min-w-0 truncate">{b.name}</span>
                      <Button variant={on ? "outline" : "default"} size="sm" className="min-h-11 md:min-h-9" disabled={!!busy}
                        onClick={() => run(`biz-${b.id}`, () => (on ? revoke : grant).mutateAsync({ accountId: account.id, businessId: b.id }), on ? `فُك ربط ${b.name}` : `رُبط ${b.name}`)}
                        data-testid={`ledger-account-biz-toggle-${b.id}`}>
                        {busy === `biz-${b.id}` ? "جارٍ…" : on ? "فك الربط" : "ربط"}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
        <div className="flex gap-2 border-t px-4 py-3">
          <Button variant="outline" className="min-h-12 flex-1" onClick={onClose} disabled={!!busy}><Wallet className="h-4 w-4 ml-1" aria-hidden="true" /> إغلاق</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** ما لنا وما علينا (المرحلة 7): النقدية منفصلة عن الذمم والالتزامات — المحجوب يبقى «محجوب عن نطاقك». */
export function PositionSection() {
  const position = trpc.ledger.reports.position.useQuery(undefined, { retry: false });
  const p = position.data;
  if (!p) return null;
  const block = (title: string, g: { total: string | null; rows: { code: string; name: string; balance: string | null }[] }, testId: string) => (
    <div className="rounded-[var(--radius-brand-md)] border border-border p-3" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="mt-1 font-bold tabular-nums">{g.rows.length === 0 ? "لا حسابات" : balanceText(g.total)}</p>
    </div>
  );
  return (
    <SectionCard title="ما لنا وما علينا" testId="ledger-position">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {block("النقدية المتاحة", p.cash, "ledger-position-cash")}
        {block("لنا عند الغير (ذمم — ليست نقدية)", p.receivables, "ledger-position-receivables")}
        {block("علينا للغير (التزامات)", p.payables, "ledger-position-payables")}
        {(p as any).inventory && block("المخزون (بضاعة/خامات/تغليف/عهدة/قيد الفحص)", (p as any).inventory, "ledger-position-inventory")}
      </div>
    </SectionCard>
  );
}
