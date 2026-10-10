import { useMemo, useRef, useState } from "react";
import { Crown, History, Pencil, Plus, Power, ShieldAlert, UserMinus, UserPlus, Users } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { operationIdFor } from "@/lib/operationId";
import { usePermissions } from "@/hooks/usePermission";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  ConfirmDialog, Drawer, ErrorState, LoadingSkeleton, PageHeader, PermissionDeniedState, ResponsiveDataTable, SectionCard, StatusBadge, toast, type Column,
} from "@/components/shared";
import { TeamsUnavailable } from "@/components/teams/TeamsStates";
import { MemberShiftsList, type MemberShift } from "@/components/teams/MemberShifts";
import { TOUCH, fmtNum, formatMs, serverErrorText, useWritesBlocked } from "@/components/teams/teamsUi";

/**
 * إدارة الفرق — للمالك/الإدارة داخل DashboardLayout (0044، خلف TEAMS_ENABLED).
 *  • العرض teams.view_all، الكتابة teams.manage (من يملك العرض فقط لا يرى أزرار الكتابة). السيرفر يتحقق من نفس الصلاحيات.
 *  • التغييرات تسري «من الآن» بتوقيت قاعدة البيانات — لا تواريخ سريان من الواجهة. لا Seed ولا فرق تلقائية.
 *  • كل كتابة بمعرّف عملية ثابت لنفس الفعل (Replay على السيرفر) وزرها معطّل أثناء التنفيذ؛ سبب الرفض يُعرض بالعربي.
 */
type TeamRow = { id: number; businessId: number; businessName: string; name: string; isActive: boolean; version: number; activatedMs: number; deactivatedMs: number | null; leaderEmployeeId: number | null; leaderName: string | null; activeMembers: number };

export default function Teams() {
  const status = trpc.teams.status.useQuery(undefined, { retry: false, staleTime: 5 * 60_000 });
  const { permissions, isLoading: permsLoading } = usePermissions();
  if (status.isLoading || permsLoading) return <LoadingSkeleton variant="table" rows={5} />;
  if (!status.data?.enabled) return <TeamsUnavailable />;
  if (!permissions.includes("teams.view_all")) return <PermissionDeniedState message="إدارة الفرق تحتاج صلاحية «عرض كل الفرق»." />;
  return <TeamsBoard canManage={permissions.includes("teams.manage")} />;
}

function TeamsBoard({ canManage }: { canManage: boolean }) {
  const list = trpc.teams.list.useQuery({ includeInactive: true }, { retry: false });
  const businesses = trpc.businesses.activeList.useQuery(undefined, { enabled: canManage, retry: false });
  const writes = useWritesBlocked();
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const rows: TeamRow[] = list.data?.enabled ? (list.data.rows as TeamRow[]) : [];
  const activeBusinessIds = new Set(rows.filter(r => r.isActive).map(r => r.businessId));
  const freeBusinesses = (businesses.data ?? []).filter((b: any) => !activeBusinessIds.has(Number(b.id)));
  const canWrite = canManage && !writes.blocked;

  const columns: Column<TeamRow>[] = [
    { id: "name", header: "الفريق", cell: r => <span className="font-semibold">{r.name}</span> },
    { id: "business", header: "النشاط", cell: r => r.businessName },
    { id: "leader", header: "القائد الحالي", cell: r => r.leaderName ?? <span className="text-muted-foreground">بلا قائد</span> },
    { id: "members", header: "الأعضاء", numeric: true, cell: r => <span className="tabular-nums">{fmtNum(r.activeMembers)}</span> },
    { id: "status", header: "الحالة", cell: r => <StatusBadge status={r.isActive ? "active" : "inactive"} label={r.isActive ? "نشط" : "موقوف"} tone={r.isActive ? "success" : "neutral"} /> },
    { id: "open", header: <span className="sr-only">إدارة</span>, cell: r => <Button variant="outline" size="sm" className={TOUCH} onClick={() => setOpenId(r.id)} data-readonly-safe>عرض</Button> },
  ];

  return (
    <div className="space-y-4" dir="rtl" data-testid="teams-page">
      <PageHeader
        title="الفرق"
        description="فريق لكل نشاط، بقائد وأعضاء. كل تغيير يسري من الآن، والتاريخ محفوظ بلا حذف."
        icon={<Users className="h-5 w-5" />}
        primaryAction={canManage ? (
          <Button className={TOUCH} onClick={() => setCreating(true)} disabled={!canWrite || freeBusinesses.length === 0} data-testid="team-create-open">
            <Plus className="h-4 w-4" aria-hidden="true" /> فريق جديد
          </Button>
        ) : undefined}
      />
      {writes.blocked && <p className="rounded-[var(--radius-brand-md)] border border-border bg-muted px-3 py-2 text-sm text-muted-foreground" role="status">{writes.reason}</p>}
      <ResponsiveDataTable
        rows={rows}
        columns={columns}
        rowKey={r => r.id}
        loading={list.isLoading}
        error={list.error ? serverErrorText(list.error) : null}
        onRetry={() => list.refetch()}
        empty={{ title: "لا توجد فرق بعد", description: canManage ? "أنشئ فريقًا لنشاط ليس له فريق نشط." : "لم تُنشأ فرق بعد." }}
        mobileRow={r => (
          <button type="button" className="flex min-h-14 w-full items-center gap-3 rounded-[var(--radius-brand-md)] border border-border bg-card p-3 text-start" onClick={() => setOpenId(r.id)} data-readonly-safe data-testid={`team-card-${r.id}`}>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">{r.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{r.businessName} · القائد: {r.leaderName ?? "بلا قائد"}</span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              <StatusBadge status={r.isActive ? "active" : "inactive"} label={r.isActive ? "نشط" : "موقوف"} tone={r.isActive ? "success" : "neutral"} size="sm" />
              <span className="text-xs tabular-nums text-muted-foreground">{fmtNum(r.activeMembers)} عضو</span>
            </span>
          </button>
        )}
      />
      {creating && <CreateTeamDialog businesses={freeBusinesses} onClose={() => setCreating(false)} onCreated={id => { setCreating(false); setOpenId(id); }} />}
      {openId != null && <TeamDrawer teamId={openId} canManage={canManage} canWrite={canWrite} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function CreateTeamDialog({ businesses, onClose, onCreated }: { businesses: any[]; onClose: () => void; onCreated: (id: number) => void }) {
  const utils = trpc.useUtils();
  const create = trpc.teams.create.useMutation();
  const [businessId, setBusinessId] = useState<string>(businesses[0] ? String(businesses[0].id) : "");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const submit = () => {
    if (busy.current || create.isPending || !businessId || name.trim().length < 2) return;
    busy.current = true; setError(null);
    create.mutate({ businessId: Number(businessId), name: name.trim(), operationId: operationIdFor(`team-create:${businessId}:${name.trim()}`) }, {
      onSuccess: r => { utils.teams.list.invalidate(); toast.success("أُنشئ الفريق"); onCreated(r.id); },
      onError: e => setError(serverErrorText(e)),
      onSettled: () => { busy.current = false; },
    });
  };
  return (
    <Dialog open onOpenChange={o => { if (!o && !create.isPending) onClose(); }}>
      <DialogContent dir="rtl" className="max-w-md">
        <DialogHeader>
          <DialogTitle>فريق جديد</DialogTitle>
          <DialogDescription>لنشاط ليس له فريق نشط. يبدأ الفريق من الآن بلا أعضاء؛ أضف الأعضاء والقائد بعد الإنشاء.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="team-business">النشاط</Label>
            <Select value={businessId} onValueChange={setBusinessId}>
              <SelectTrigger id="team-business" className="min-h-11 w-full" data-testid="team-business"><SelectValue placeholder="اختر النشاط" /></SelectTrigger>
              <SelectContent>{businesses.map(b => <SelectItem key={b.id} value={String(b.id)} className="min-h-11">{b.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="team-name">اسم الفريق</Label>
            <Input id="team-name" value={name} onChange={e => setName(e.target.value)} maxLength={80} className="min-h-11" data-testid="team-name" />
          </div>
          {error && <p className="text-sm text-destructive" role="alert" data-testid="team-error">{error}</p>}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="min-h-11" onClick={onClose} disabled={create.isPending} data-readonly-safe>إلغاء</Button>
          <Button className="min-h-11" onClick={submit} disabled={create.isPending || !businessId || name.trim().length < 2} data-testid="team-create">{create.isPending ? "جارٍ الإنشاء…" : "إنشاء"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** نافذة الفريق: الأعضاء الحاليون، والإجراءات (للإدارة)، والسجل الكامل، وتحذيرات الورديات (قراءة فقط). */
function TeamDrawer({ teamId, canManage, canWrite, onClose }: { teamId: number; canManage: boolean; canWrite: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const team = trpc.teams.get.useQuery({ teamId }, { retry: false });
  const history = trpc.teams.history.useQuery({ teamId }, { retry: false });
  const shifts = trpc.teams.memberShifts.useQuery({ teamId }, { retry: false });
  const data = team.data?.enabled ? team.data : null;
  const t = data?.team;
  const members = data?.members ?? [];
  const writable = canWrite && Boolean(t?.isActive);
  const employees = trpc.employees.activeList.useQuery(t ? { businessId: t.businessId } : undefined, { enabled: canManage && Boolean(t), retry: false });

  const refresh = () => Promise.all([utils.teams.get.invalidate({ teamId }), utils.teams.history.invalidate({ teamId }), utils.teams.memberShifts.invalidate({ teamId }), utils.teams.list.invalidate()]);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  const run = (key: string, fn: (done: () => void) => void) => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key); setError(null);
    fn(() => inFlight.current.delete(key));
  };
  const onErr = (e: unknown) => { const m = serverErrorText(e); setError(m); toast.error(m); };

  const rename = trpc.teams.rename.useMutation();
  const deactivate = trpc.teams.deactivate.useMutation();
  const addMember = trpc.teams.addMember.useMutation();
  const endMembership = trpc.teams.endMembership.useMutation();
  const setLeader = trpc.teams.setLeader.useMutation();
  const endLeadership = trpc.teams.endLeadership.useMutation();
  const pending = rename.isPending || deactivate.isPending || addMember.isPending || endMembership.isPending || setLeader.isPending || endLeadership.isPending;

  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [newMember, setNewMember] = useState<string>("");
  const memberIds = new Set(members.map(m => m.employeeId));
  const candidates = (employees.data ?? []).filter((e: any) => !memberIds.has(Number(e.id)));
  const leader = members.find(m => m.membershipRole === "leader");

  const doRename = () => run("rename", done => {
    const name = (renaming ?? "").trim();
    if (!t || name.length < 2) return done();
    rename.mutate({ teamId, name, expectedVersion: t.version, operationId: operationIdFor(`team-rename:${teamId}:${t.version}:${name}`) }, {
      onSuccess: () => { setRenaming(null); toast.success("تم تغيير الاسم"); refresh(); }, onError: onErr, onSettled: done,
    });
  });
  const doDeactivate = () => new Promise<void>(resolve => run("deactivate", done => {
    deactivate.mutate({ teamId, operationId: operationIdFor(`team-deactivate:${teamId}`) }, {
      onSuccess: r => { setConfirmOff(false); toast.success(`أُوقف الفريق — أُغلقت ${r.closedMemberships} عضوية`); refresh(); },
      onError: onErr, onSettled: () => { done(); resolve(); },
    });
  }));
  const doAdd = () => run("add", done => {
    if (!newMember) return done();
    addMember.mutate({ teamId, employeeId: Number(newMember), operationId: operationIdFor(`team-add:${teamId}:${newMember}`) }, {
      onSuccess: () => { setNewMember(""); toast.success("أُضيف العضو من الآن"); refresh(); }, onError: onErr, onSettled: done,
    });
  });
  const doEnd = (membershipId: number) => run(`end:${membershipId}`, done => {
    endMembership.mutate({ membershipId, operationId: operationIdFor(`team-end:${membershipId}`) }, {
      onSuccess: () => { toast.success("انتهت العضوية من الآن"); refresh(); }, onError: onErr, onSettled: done,
    });
  });
  const doLead = (employeeId: number) => run(`lead:${employeeId}`, done => {
    setLeader.mutate({ teamId, employeeId, operationId: operationIdFor(`team-lead:${teamId}:${employeeId}:${leader?.employeeId ?? 0}`) }, {
      onSuccess: () => { toast.success("تم تعيين القائد من الآن"); refresh(); }, onError: onErr, onSettled: done,
    });
  });
  const doEndLead = () => run("endlead", done => {
    endLeadership.mutate({ teamId, operationId: operationIdFor(`team-endlead:${teamId}:${leader?.id ?? 0}`) }, {
      onSuccess: () => { toast.success("انتهت القيادة من الآن — عاد القائد عضوًا"); refresh(); }, onError: onErr, onSettled: done,
    });
  });

  return (
    <Drawer
      open
      onOpenChange={o => { if (!o && !pending) onClose(); }}
      width="lg"
      title={t ? <span className="flex items-center gap-2">{t.name} <StatusBadge status={t.isActive ? "active" : "inactive"} label={t.isActive ? "نشط" : "موقوف"} tone={t.isActive ? "success" : "neutral"} size="sm" /></span> : "الفريق"}
      description={t ? `منذ ${formatMs(t.activatedMs)}${t.deactivatedMs ? ` · أُوقف ${formatMs(t.deactivatedMs)}` : ""}` : undefined}
    >
      {team.isLoading ? <LoadingSkeleton variant="form" rows={4} /> : team.error ? <ErrorState message={serverErrorText(team.error)} onRetry={() => team.refetch()} /> : t && (
        <div className="space-y-4" data-testid="team-drawer">
          {canManage && !t.isActive && <p className="rounded-[var(--radius-brand-md)] bg-muted px-3 py-2 text-sm text-muted-foreground" role="status">الفريق موقوف نهائيًا — لا تعديل عليه. سجلّه محفوظ أدناه.</p>}
          {error && <p className="rounded-[var(--radius-brand-md)] border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="team-drawer-error">{error}</p>}

          {canManage && t.isActive && (
            <SectionCard title="الإجراءات">
              <div className="flex flex-wrap gap-2">
                {renaming == null ? (
                  <Button variant="outline" className={TOUCH} onClick={() => setRenaming(t.name)} disabled={!writable || pending} data-testid="team-rename-open"><Pencil className="h-4 w-4" aria-hidden="true" /> تغيير الاسم</Button>
                ) : (
                  <form className="flex w-full flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); doRename(); }}>
                    <Input value={renaming} onChange={e => setRenaming(e.target.value)} maxLength={80} className="min-h-11 min-w-0 flex-1" aria-label="الاسم الجديد" data-testid="team-rename-input" />
                    <Button type="submit" className={TOUCH} disabled={!writable || rename.isPending || (renaming ?? "").trim().length < 2} data-testid="team-rename-save">{rename.isPending ? "جارٍ الحفظ…" : "حفظ"}</Button>
                    <Button type="button" variant="ghost" className={TOUCH} onClick={() => setRenaming(null)} data-readonly-safe>إلغاء</Button>
                  </form>
                )}
                {leader && <Button variant="outline" className={TOUCH} onClick={doEndLead} disabled={!writable || pending} data-testid="team-endlead"><Crown className="h-4 w-4" aria-hidden="true" /> إنهاء القيادة</Button>}
                <Button variant="outline" className={`${TOUCH} text-destructive`} onClick={() => setConfirmOff(true)} disabled={!writable || pending} data-testid="team-deactivate-open"><Power className="h-4 w-4" aria-hidden="true" /> إيقاف الفريق</Button>
              </div>
            </SectionCard>
          )}

          <SectionCard title={`الأعضاء الحاليون (${fmtNum(members.length)})`}>
            {members.length === 0 ? <p className="text-sm text-muted-foreground">لا أعضاء حاليًا.</p> : (
              <ul className="divide-y divide-border" data-testid="team-members">
                {members.map(m => (
                  <li key={m.id} className="space-y-1 py-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{m.employeeName}</span>
                        <span className="block text-xs text-muted-foreground">منذ {formatMs(m.fromMs)}</span>
                      </span>
                      <StatusBadge status={m.membershipRole} label={m.membershipRole === "leader" ? "قائد" : "عضو"} tone={m.membershipRole === "leader" ? "primary" : "neutral"} icon={m.membershipRole === "leader" ? <Crown className="h-3 w-3" aria-hidden="true" /> : undefined} size="sm" />
                    </div>
                    {canManage && t.isActive && m.membershipRole !== "leader" && (
                      <div className="flex flex-wrap gap-2">
                        <Button variant="ghost" size="sm" className={TOUCH} onClick={() => doLead(m.employeeId)} disabled={!writable || pending} data-testid={`team-lead-${m.employeeId}`}><Crown className="h-4 w-4" aria-hidden="true" /> {leader ? "تغيير القائد إليه" : "تعيين قائدًا"}</Button>
                        <Button variant="ghost" size="sm" className={`${TOUCH} text-destructive`} onClick={() => doEnd(m.id)} disabled={!writable || pending} data-testid={`team-end-${m.id}`}><UserMinus className="h-4 w-4" aria-hidden="true" /> إنهاء العضوية</Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {canManage && t.isActive && (
              <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3">
                <div className="min-w-0 flex-1 space-y-1">
                  <Label htmlFor="team-add">إضافة عضو من موظفي النشاط</Label>
                  <Select value={newMember} onValueChange={setNewMember}>
                    <SelectTrigger id="team-add" className="min-h-11 w-full" data-testid="team-add-select"><SelectValue placeholder={employees.isLoading ? "جارٍ التحميل…" : candidates.length ? "اختر موظفًا" : "لا موظفين متاحين"} /></SelectTrigger>
                    <SelectContent>{candidates.map((e: any) => <SelectItem key={e.id} value={String(e.id)} className="min-h-11">{e.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <Button className={TOUCH} onClick={doAdd} disabled={!writable || !newMember || addMember.isPending} data-testid="team-add"><UserPlus className="h-4 w-4" aria-hidden="true" /> {addMember.isPending ? "جارٍ الإضافة…" : "إضافة"}</Button>
              </div>
            )}
            {canManage && t.isActive && <p className="mt-2 text-xs text-muted-foreground">كل إضافة/إنهاء/تعيين يسري من الآن، ولا تواريخ سابقة أو مستقبلية.</p>}
          </SectionCard>

          <SectionCard title="الورديات والتحذيرات (قراءة فقط)">
            {shifts.isLoading ? <LoadingSkeleton variant="cards" rows={2} />
              : shifts.error ? <ErrorState message={serverErrorText(shifts.error)} onRetry={() => shifts.refetch()} />
              : !shifts.data?.enabled ? (
                <p className="flex items-start gap-2 text-sm text-muted-foreground" data-testid="team-shift-warnings">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" /> غير متاح حاليًا — نظام الحضور غير مفعّل.
                </p>
              ) : <MemberShiftsList workDate={shifts.data.workDate} timeZone={shifts.data.timeZone} members={shifts.data.members as MemberShift[]} />}
          </SectionCard>

          <SectionCard title="سجل العضويات والقيادة">
            {history.isLoading ? <LoadingSkeleton variant="table" rows={3} /> : history.error ? <ErrorState message={serverErrorText(history.error)} onRetry={() => history.refetch()} /> : (
              (history.data?.enabled ? history.data.history : []).length === 0 ? <p className="text-sm text-muted-foreground">لا سجل بعد.</p> :
              <ul className="space-y-2" data-testid="team-history">
                {(history.data?.enabled ? history.data.history : []).map((h: any) => (
                  <li key={h.id} className="rounded-[var(--radius-brand-md)] border border-border p-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <History className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                      <span className="font-medium">{h.employeeName}</span>
                      <StatusBadge status={h.membershipRole} label={h.membershipRole === "leader" ? "قائد" : "عضو"} tone={h.membershipRole === "leader" ? "primary" : "neutral"} size="sm" />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      من {formatMs(h.fromMs)} ({h.assignedByName}) · {h.toMs ? `حتى ${formatMs(h.toMs)}${h.endedByName ? ` (${h.endedByName})` : ""}` : "مستمرة"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>
        </div>
      )}
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={o => { if (!o && !deactivate.isPending) setConfirmOff(false); }}
        title="إيقاف الفريق نهائيًا"
        description={<>سيتوقف «{t?.name}» من الآن وتُغلق كل عضوياته وقيادته الحالية ({fmtNum(members.length)}). لا يمكن التعديل عليه بعد ذلك، ويبقى سجلّه محفوظًا. لإنشاء فريق جديد لنفس النشاط بعدها استخدم «فريق جديد».</>}
        confirmLabel="إيقاف نهائي"
        tone="destructive"
        requireTypedConfirmation={t?.name}
        pending={deactivate.isPending}
        onConfirm={doDeactivate}
      />
    </Drawer>
  );
}
