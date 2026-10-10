import { useEffect, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { UserCheck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { operationIdFor } from "@/lib/operationId";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ORDER_STATUS, ResponsiveDataTable, SearchInput, SectionCard, StatusBadge, toast, type Column } from "@/components/shared";
import { TOUCH, fmtNum, formatMs, serverErrorText, useWritesBlocked } from "../teamsUi";
import { QueryError, type LedTeam, type LeaderPerms } from "./common";

/**
 * أوردرات نشاط الفريق كلها، ومنها غير المسندة (team.orders.list) — بفلاتر العقد القائم فقط (الحالة، غير المسندة،
 * المسند إليه، البحث، الصفحات). الإسناد (team.orders.assign) لعضو فعّال فقط عبر المسار القائم الذي يكتب سجل
 * الأحداث — بلا أي منطق حالة جديد. معرّف عملية ثابت لكل (أوردر، عضو) + قفل لكل أوردر ⇒ الضغط المزدوج لا يسند مرتين.
 */
const LIMIT = 25;
const ALL = "__all";
type Order = { id: number; orderNumber: string; customerName: string; governorate?: string | null; status: string; assignedEmployeeId: number | null; createdAt: string | Date };

export function OrdersTab({ team, perms }: { team: LedTeam; perms: LeaderPerms }) {
  const [status, setStatus] = useState(ALL);
  const [assignee, setAssignee] = useState(ALL); // ALL | "none" | employeeId
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  useEffect(() => { const t = setTimeout(() => setDebounced(search.trim().slice(0, 100)), 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => { setPage(1); }, [status, assignee, debounced]);
  const members = trpc.employeePortal.team.members.useQuery({ teamId: team.teamId }, { retry: false });
  const memberList: { employeeId: number; employeeName: string }[] = members.data?.enabled ? (members.data.members as any[]) : [];
  const names = new Map(memberList.map(m => [m.employeeId, m.employeeName]));
  const q = trpc.employeePortal.team.orders.list.useQuery({
    teamId: team.teamId, page, limit: LIMIT,
    ...(status !== ALL ? { status } : {}),
    ...(assignee === "none" ? { unassignedOnly: true } : assignee !== ALL ? { assignedEmployeeId: Number(assignee) } : {}),
    ...(debounced ? { search: debounced } : {}),
  }, { retry: false, placeholderData: keepPreviousData });
  const canAssign = perms.has("team_orders.assign");

  const orders: Order[] = q.data?.enabled ? ((q.data as any).orders as Order[]) : [];
  const total: number = q.data?.enabled ? Number((q.data as any).total) : 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const who = (o: Order) => (o.assignedEmployeeId == null ? <span className="text-muted-foreground">غير مسند</span> : names.get(o.assignedEmployeeId) ?? <span className="text-muted-foreground">خارج الفريق</span>);
  const statusBadge = (o: Order) => <StatusBadge status={o.status} size="sm" />;
  const columns: Column<Order>[] = [
    { id: "number", header: "الأوردر", cell: o => <bdi className="tabular-nums font-medium" dir="ltr">{o.orderNumber}</bdi> },
    { id: "customer", header: "العميل", cell: o => o.customerName },
    { id: "status", header: "الحالة", cell: statusBadge },
    { id: "assignee", header: "المسند إليه", cell: who },
    { id: "created", header: "التاريخ", cell: o => formatMs(new Date(o.createdAt).getTime()) },
    ...(canAssign ? [{ id: "assign", header: "إسناد", alwaysVisible: true, cell: (o: Order) => <AssignControl team={team} order={o} members={memberList} /> } as Column<Order>] : []),
  ];

  if (q.isLoading) return <SectionCard title="أوردرات الفريق"><p className="text-sm text-muted-foreground">جارٍ التحميل…</p></SectionCard>;
  if (q.error && !q.data) return <QueryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.enabled) return <p className="rounded-[var(--radius-brand-md)] border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">غير متاح حاليًا.</p>;
  return (
    <SectionCard title={`أوردرات نشاط الفريق (${fmtNum(total)})`} description="كل أوردرات النشاط ومنها غير المسندة. الإسناد لأعضاء الفريق الحاليين فقط ويُسجَّل في سجل الأحداث.">
      <div className="grid gap-2 sm:grid-cols-3" data-readonly-safe data-testid="leader-orders-filters">
        <SearchInput value={search} onChange={setSearch} placeholder="بحث بالاسم أو الهاتف أو رقم الأوردر" />
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="min-h-11 w-full" aria-label="الحالة"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="min-h-11">كل الحالات</SelectItem>
            {Object.entries(ORDER_STATUS).map(([k, v]) => <SelectItem key={k} value={k} className="min-h-11">{v.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={assignee} onValueChange={setAssignee}>
          <SelectTrigger className="min-h-11 w-full" aria-label="المسند إليه"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL} className="min-h-11">كل الأوردرات</SelectItem>
            <SelectItem value="none" className="min-h-11">غير المسندة فقط</SelectItem>
            {memberList.map(m => <SelectItem key={m.employeeId} value={String(m.employeeId)} className="min-h-11">{m.employeeName}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      {q.error && <p className="mt-2 text-sm text-destructive" role="alert">{serverErrorText(q.error)}</p>}
      <div className="mt-3" aria-busy={q.isFetching} data-testid="leader-orders">
        <ResponsiveDataTable
          rows={orders}
          columns={columns}
          rowKey={o => o.id}
          empty={{ title: "لا أوردرات مطابقة", description: "غيّر الفلاتر أو البحث." }}
          mobileRow={o => (
            <div className="space-y-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3">
              <div className="flex items-center gap-2"><bdi className="tabular-nums font-medium" dir="ltr">{o.orderNumber}</bdi><span className="min-w-0 flex-1 truncate text-sm">{o.customerName}</span>{statusBadge(o)}</div>
              <p className="text-xs text-muted-foreground">المسند إليه: {who(o)} · {formatMs(new Date(o.createdAt).getTime())}</p>
              {canAssign && <AssignControl team={team} order={o} members={memberList} />}
            </div>
          )}
        />
      </div>
      <div className="mt-3 flex items-center justify-between gap-2" data-readonly-safe>
        <Button variant="outline" className={TOUCH} disabled={page <= 1 || q.isFetching} onClick={() => setPage(p => p - 1)}>السابق</Button>
        <span className="text-sm text-muted-foreground">صفحة <span className="tabular-nums">{page}</span> من <span className="tabular-nums">{pages}</span></span>
        <Button variant="outline" className={TOUCH} disabled={page >= pages || q.isFetching} onClick={() => setPage(p => p + 1)}>التالي</Button>
      </div>
    </SectionCard>
  );
}

function AssignControl({ team, order, members }: { team: LedTeam; order: Order; members: { employeeId: number; employeeName: string }[] }) {
  const utils = trpc.useUtils();
  const assign = trpc.employeePortal.team.orders.assign.useMutation();
  const writes = useWritesBlocked();
  const [to, setTo] = useState<string>("");
  const lock = useRef(false);
  const options = members.filter(m => m.employeeId !== order.assignedEmployeeId);
  const submit = () => {
    if (lock.current || assign.isPending || !to) return;
    lock.current = true;
    const employeeId = Number(to);
    assign.mutate({ teamId: team.teamId, orderId: order.id, employeeId, operationId: operationIdFor(`team-assign:${team.teamId}:${order.id}:${employeeId}`) }, {
      onSuccess: () => { toast.success(`أُسند الأوردر إلى ${members.find(m => m.employeeId === employeeId)?.employeeName ?? "العضو"}`); setTo(""); utils.employeePortal.team.orders.list.invalidate(); },
      onError: e => { toast.error(serverErrorText(e)); utils.employeePortal.team.orders.list.invalidate(); },
      onSettled: () => { lock.current = false; },
    });
  };
  return (
    <div className="flex items-center gap-1.5" data-testid={`assign-${order.id}`}>
      <Select value={to} onValueChange={setTo} disabled={writes.blocked || assign.isPending}>
        <SelectTrigger className="min-h-11 min-w-0 flex-1 md:min-h-9 md:w-36" aria-label={`إسناد الأوردر ${order.orderNumber} إلى`}><SelectValue placeholder="اختر عضوًا" /></SelectTrigger>
        <SelectContent>{options.map(m => <SelectItem key={m.employeeId} value={String(m.employeeId)} className="min-h-11">{m.employeeName}</SelectItem>)}</SelectContent>
      </Select>
      <Button size="sm" className={TOUCH} onClick={submit} disabled={writes.blocked || !to || assign.isPending} title={writes.reason ?? undefined} data-testid={`assign-submit-${order.id}`}>
        <UserCheck className="h-4 w-4" aria-hidden="true" /> {assign.isPending ? "جارٍ…" : "إسناد"}
      </Button>
    </div>
  );
}
