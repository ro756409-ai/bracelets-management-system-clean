import { useMemo, useState } from "react";
import { CalendarClock, Download } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { operationIdFor } from "@/lib/operationId";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { usePermissions } from "@/hooks/usePermission";
import { businessDateKey } from "@shared/businessTime";
import { ASSIGNMENT_TARGETS, SHIFT_FORM_SUGGESTIONS, WEEKDAYS, daysFromMask, type AssignmentTarget, type CorrectionRequestType, type WeekdayKey } from "@shared/attendanceSpec";
import { ASSIGNMENT_TARGET_LABELS, CLOCK_ACTION_LABELS, DAY_STATUS_LABELS, REQUEST_TYPE_LABELS, formatClock, formatMinutes, localTimeToIso } from "@shared/attendanceLabels";
import { ROLE_LABELS } from "@shared/permissionLabels";
import {
  PageHeader, SectionCard, StatusBadge, ResponsiveDataTable, EmptyState, LoadingSkeleton, PermissionDeniedState, UnderlineTabs, toast, type Column,
} from "@/components/shared";

/**
 * الحضور والانصراف — لوحة المالك/الإدارة (0042، خلف ATTENDANCE_ENABLED).
 *  • كل تبويب بصلاحيته: اللوحة view_all، المراجعة approve_corrections/manage_leaves، الورديات والتعيينات manage_shifts،
 *    التصحيح الإداري correct، التصدير export. السيرفر يتحقق من نفس الصلاحيات (الواجهة لا تُخفي فقط).
 *  • لا ورديات افتراضية: النموذج فارغ، والدقائق «اقتراح» قابل للتعديل (قرارات المالك). لا أيام عمل محددة مسبقًا.
 *  • لا خصم ولا رواتب: الاستراحة الزائدة والخروج المبكر والإضافي تُسجَّل للمراجعة فقط.
 */
const TZ = "Africa/Cairo";
const TOUCH = "min-h-11 md:min-h-9";
const dayKey = (d: Date) => businessDateKey(d, TZ);
const daysAgo = (n: number) => dayKey(new Date(Date.now() - n * 86_400_000));
type Tab = "board" | "requests" | "shifts" | "assignments";

type DayRow = { id: number; employeeId: number; employeeName: string; workDate: string; status: string; workedMinutes: number; breakMinutes: number; excessBreakMinutes: number; lateMinutes: number; earlyLeaveMinutes: number; overtimeMinutes: number; requiresReview: number; reviewReason: string | null; firstInMs: number | null; lastOutMs: number | null; timezone: string };

const S: Record<keyof typeof SHIFT_FORM_SUGGESTIONS, number> = SHIFT_FORM_SUGGESTIONS;
const blankShift = () => ({
  id: null as number | null, version: 0, name: "", businessId: null as number | null, startTime: "", endTime: "", workDays: [] as WeekdayKey[],
  graceMinutes: S.graceMinutes, allowedBreakMinutes: S.allowedBreakMinutes, overtimeStartsAfterMinutes: S.overtimeStartsAfterMinutes,
  earlyClockInLimitMinutes: S.earlyClockInLimitMinutes, earlyLeaveToleranceMinutes: S.earlyLeaveToleranceMinutes,
  timezone: TZ, effectiveFrom: dayKey(new Date()), effectiveTo: "",
});

export default function Attendance() {
  const { has, isLoading: permsLoading } = usePermissions();
  const { currentBusinessIds, businesses } = useBusinessContext();
  const canView = has("attendance.view_all"), canExport = has("attendance.export"), canShifts = has("attendance.manage_shifts");
  const canReview = has("attendance.approve_corrections") || has("attendance.manage_leaves"), canCorrect = has("attendance.correct");
  const tabs = [
    canView && { key: "board", label: "لوحة الحضور" },
    canView && canReview && { key: "requests", label: "طلبات التصحيح" },
    canShifts && { key: "shifts", label: "الورديات" },
    canShifts && { key: "assignments", label: "التعيينات" },
  ].filter(Boolean) as { key: Tab; label: string }[];
  const [tabState, setTab] = useState<Tab | null>(null);
  const tab = tabState && tabs.some(t => t.key === tabState) ? tabState : tabs[0]?.key;

  const [range, setRange] = useState({ dateFrom: daysAgo(6), dateTo: daysAgo(0) });
  const validRange = /^\d{4}-\d{2}-\d{2}$/.test(range.dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(range.dateTo) && range.dateFrom <= range.dateTo;
  const status = trpc.attendance.status.useQuery(undefined, { retry: false });
  const enabled = status.data?.enabled === true;
  const team = trpc.attendance.team.useQuery({ ...range, businessIds: currentBusinessIds }, { enabled: enabled && canView && validRange, retry: false });
  const shifts = trpc.attendance.shifts.useQuery(undefined, { enabled: enabled && canShifts, retry: false });
  const assignments = trpc.attendance.assignments.useQuery(undefined, { enabled: enabled && canShifts && tab === "assignments", retry: false });
  const employees = trpc.employees.activeList.useQuery(undefined, { enabled: enabled && canShifts && tab === "assignments" });
  const utils = trpc.useUtils();
  const onErr = (e: { message: string }) => toast.error(e.message);
  const review = trpc.attendance.review.useMutation({ onSuccess: r => { toast.success(r.status === "approved" ? "تم الاعتماد" : "تم الرفض"); utils.attendance.team.invalidate(); setReviewing(null); }, onError: onErr });
  const createShift = trpc.attendance.createShift.useMutation({ onSuccess: () => { toast.success("تم حفظ الوردية"); utils.attendance.shifts.invalidate(); setShift(null); }, onError: onErr });
  const updateShift = trpc.attendance.updateShift.useMutation({ onSuccess: () => { toast.success("تم تعديل الوردية"); utils.attendance.shifts.invalidate(); setShift(null); }, onError: onErr });
  const setActive = trpc.attendance.setShiftActive.useMutation({ onSuccess: () => utils.attendance.shifts.invalidate(), onError: onErr });
  const assign = trpc.attendance.assign.useMutation({ onSuccess: r => { toast.success(r.replaced ? `تم التعيين واستبدال ${r.replaced}` : "تم التعيين"); utils.attendance.assignments.invalidate(); setAsg(null); }, onError: onErr });
  const endAssignment = trpc.attendance.endAssignment.useMutation({ onSuccess: () => utils.attendance.assignments.invalidate(), onError: onErr });
  const adminCorrect = trpc.attendance.adminCorrect.useMutation({ onSuccess: r => { toast.success(r.replay ? "مسجّل بالفعل" : "تم التصحيح"); utils.attendance.team.invalidate(); setCorrecting(null); }, onError: onErr });

  const [reviewing, setReviewing] = useState<{ id: number; decision: "approve" | "reject"; reason: string } | null>(null);
  const [shift, setShift] = useState<ReturnType<typeof blankShift> | null>(null);
  const [asg, setAsg] = useState<{ shiftId: string; targetType: AssignmentTarget | ""; employeeId: string; role: string; businessId: string; effectiveFrom: string; effectiveTo: string; replaceExisting: boolean } | null>(null);
  const [correcting, setCorrecting] = useState<{ row: DayRow; punchType: keyof typeof CLOCK_ACTION_LABELS; time: string; nextDay: boolean; reason: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  const teamData = team.data && team.data.enabled ? team.data : null;
  const days = (teamData?.days ?? []) as DayRow[];
  const pending = (teamData?.pending ?? []) as any[];
  const shiftRows = (shifts.data?.rows ?? []) as any[];
  const bizName = (id: number | null | undefined) => (id == null ? "كل الأنشطة" : businesses.find(b => b.id === id)?.name ?? `#${id}`);

  const exportCsv = async () => {
    if (exporting || !validRange) return;
    setExporting(true);
    try {
      const r = await utils.attendance.exportCsv.fetch({ ...range, businessIds: currentBusinessIds });
      if (!r.enabled) return;
      const url = URL.createObjectURL(new Blob([r.csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a"); a.href = url; a.download = `attendance-${range.dateFrom}-${range.dateTo}.csv`; a.click(); URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  };

  const shiftCrosses = shift && /^\d{2}:\d{2}$/.test(shift.startTime) && /^\d{2}:\d{2}$/.test(shift.endTime) && shift.endTime < shift.startTime;
  const shiftError = !shift ? null
    : !shift.name.trim() ? "اكتب اسم الوردية"
    : !/^\d{2}:\d{2}$/.test(shift.startTime) || !/^\d{2}:\d{2}$/.test(shift.endTime) ? "حدد البداية والنهاية"
    : shift.startTime === shift.endTime ? "البداية والنهاية لا يمكن أن تتساويا"
    : shift.workDays.length === 0 ? "اختر يوم عمل واحدًا على الأقل"
    : shift.effectiveTo && shift.effectiveTo < shift.effectiveFrom ? "نهاية السريان قبل بدايته" : null;
  const saveShift = () => {
    if (!shift || shiftError) return;
    const { id, version, ...rest } = shift;
    const body = { ...rest, name: rest.name.trim(), effectiveTo: rest.effectiveTo || null };
    if (id) updateShift.mutate({ id, version, shift: body }); else createShift.mutate(body);
  };

  const asgError = !asg ? null : !asg.shiftId ? "اختر الوردية" : !asg.targetType ? "اختر الهدف"
    : asg.targetType === "employee" && !asg.employeeId ? "اختر الموظف" : asg.targetType === "role" && !asg.role ? "اختر الدور"
    : asg.targetType === "business" && !asg.businessId ? "اختر النشاط" : asg.effectiveTo && asg.effectiveTo < asg.effectiveFrom ? "نهاية السريان قبل بدايته" : null;
  const saveAsg = () => {
    if (!asg || asgError || !asg.targetType) return;
    assign.mutate({
      shiftId: Number(asg.shiftId), targetType: asg.targetType, effectiveFrom: asg.effectiveFrom, effectiveTo: asg.effectiveTo || null, replaceExisting: asg.replaceExisting,
      employeeId: asg.targetType === "employee" ? Number(asg.employeeId) : null, role: asg.targetType === "role" ? asg.role : null,
      businessId: (asg.targetType === "business" || asg.targetType === "role") && asg.businessId ? Number(asg.businessId) : null,
    });
  };

  const correctIso = correcting ? localTimeToIso(correcting.row.workDate, correcting.time, correcting.row.timezone, correcting.nextDay) : null;
  const saveCorrect = () => {
    if (!correcting || !correctIso || correcting.reason.trim().length < 3 || adminCorrect.isPending) return;
    adminCorrect.mutate({ employeeId: correcting.row.employeeId, workDate: correcting.row.workDate, punchType: correcting.punchType, at: correctIso, reason: correcting.reason.trim(), operationId: operationIdFor(`attendance-correct:${correcting.row.id}:${correcting.punchType}:${correctIso}`) });
  };

  const dayColumns: Column<DayRow>[] = [
    { id: "employee", header: "الموظف", alwaysVisible: true, cell: r => <span className="font-medium">{r.employeeName}</span> },
    { id: "date", header: "اليوم", cell: r => <span className="tabular-nums">{r.workDate}</span> },
    { id: "status", header: "الحالة", alwaysVisible: true, cell: r => { const s = DAY_STATUS_LABELS[r.status as keyof typeof DAY_STATUS_LABELS]; return <StatusBadge status={r.status} label={s?.label ?? r.status} tone={s?.tone} size="sm" />; } },
    { id: "in", header: "الحضور", cell: r => <span className="tabular-nums">{formatClock(r.firstInMs, r.timezone)}</span> },
    { id: "out", header: "الانصراف", cell: r => <span className="tabular-nums">{formatClock(r.lastOutMs, r.timezone)}</span> },
    { id: "worked", header: "العمل", numeric: true, cell: r => <span className="tabular-nums">{formatMinutes(r.workedMinutes)}</span> },
    { id: "late", header: "تأخير", numeric: true, cell: r => <span className="tabular-nums">{formatMinutes(r.lateMinutes)}</span> },
    { id: "excess", header: "استراحة زائدة", numeric: true, cell: r => <span className="tabular-nums">{formatMinutes(r.excessBreakMinutes)}</span> },
    { id: "early", header: "خروج مبكر", numeric: true, cell: r => <span className="tabular-nums">{formatMinutes(r.earlyLeaveMinutes)}</span> },
    { id: "overtime", header: "إضافي (يحتاج اعتمادًا)", numeric: true, cell: r => <span className="tabular-nums">{formatMinutes(r.overtimeMinutes)}</span> },
    { id: "review", header: "مراجعة", cell: r => (Number(r.requiresReview) ? <span className="text-xs text-[var(--warning)]">{r.reviewReason}</span> : <span className="text-muted-foreground">—</span>) },
    ...(canCorrect ? [{ id: "act", header: "", cell: (r: DayRow) => <Button variant="ghost" className={TOUCH} onClick={() => setCorrecting({ row: r, punchType: "clock_out", time: "", nextDay: false, reason: "" })}>تصحيح</Button> }] : []),
  ];

  const header = (
    <PageHeader
      title="الحضور والانصراف"
      description="الأوقات بتوقيت الوردية؛ التخزين UTC. لا خصومات ولا رواتب — الاستثناءات للمراجعة فقط."
      icon={<CalendarClock className="h-5 w-5" aria-hidden="true" />}
      actions={canExport && enabled && tab === "board" ? <Button data-readonly-safe variant="outline" className={TOUCH} onClick={exportCsv} disabled={exporting || !validRange}><Download className="h-4 w-4" aria-hidden="true" /> تصدير CSV</Button> : undefined}
    />
  );

  if (permsLoading || status.isLoading) return <div className="space-y-6" dir="rtl">{header}<LoadingSkeleton variant="cards" rows={3} /></div>;
  if (!tabs.length) return <div className="space-y-6" dir="rtl" data-testid="attendance-page">{header}<PermissionDeniedState message="إدارة الحضور تحتاج صلاحية «عرض حضور الفريق» أو «إدارة الورديات»." /></div>;
  if (!enabled) return <div className="space-y-6" dir="rtl" data-testid="attendance-page">{header}<div data-testid="attendance-disabled"><EmptyState title="الحضور والانصراف غير مفعّل بعد" description="يُفعَّل بعد تطبيق جداول الحضور وتشغيله لشركتك." /></div></div>;

  return (
    <div className="space-y-6" dir="rtl" data-testid="attendance-page">
      {header}
      <UnderlineTabs tabs={tabs.map(t => ({ ...t, count: t.key === "requests" ? pending.length : null }))} value={tab!} onChange={k => setTab(k as Tab)} ariaLabel="أقسام الحضور" />

      {(tab === "board" || tab === "requests") && (
        <SectionCard title="الفترة" testId="attendance-range">
          <div className="flex flex-wrap items-end gap-2">
            <div><Label htmlFor="att-from">من</Label><Input id="att-from" type="date" className={TOUCH} value={range.dateFrom} onChange={e => setRange(r => ({ ...r, dateFrom: e.target.value }))} /></div>
            <div><Label htmlFor="att-to">إلى</Label><Input id="att-to" type="date" className={TOUCH} value={range.dateTo} onChange={e => setRange(r => ({ ...r, dateTo: e.target.value }))} /></div>
          </div>
          {!validRange && <p className="mt-2 text-sm text-destructive" role="alert">نطاق التاريخ غير صالح.</p>}
        </SectionCard>
      )}

      {tab === "board" && (
        <SectionCard title="لوحة الحضور" description="كل يوم مرة واحدة لكل موظف؛ «يحتاج مراجعة» لا يعني خصمًا." flush testId="attendance-board">
          <ResponsiveDataTable<DayRow>
            rows={days} columns={dayColumns} rowKey={r => r.id} loading={team.isLoading}
            error={team.isError ? (team.error?.message ?? "تعذّر تحميل الحضور") : null} onRetry={() => team.refetch()}
            empty={{ title: "لا أيام مسجلة في هذه الفترة", description: "تظهر الأيام بعد أول تسجيل حضور." }}
            cardsBelow="md"
            mobileRow={r => {
              const s = DAY_STATUS_LABELS[r.status as keyof typeof DAY_STATUS_LABELS];
              return (
                <article className="space-y-2 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`attendance-card-${r.id}`}>
                  <div className="flex items-center justify-between gap-2"><span className="font-semibold">{r.employeeName}</span><StatusBadge status={r.status} label={s?.label ?? r.status} tone={s?.tone} size="sm" /></div>
                  <div className="flex justify-between text-sm tabular-nums"><span>{r.workDate}</span><span>{formatClock(r.firstInMs, r.timezone)} – {formatClock(r.lastOutMs, r.timezone)}</span></div>
                  <div className="text-xs text-muted-foreground tabular-nums">عمل {formatMinutes(r.workedMinutes)} · تأخير {formatMinutes(r.lateMinutes)} · إضافي {formatMinutes(r.overtimeMinutes)}</div>
                  {Number(r.requiresReview) ? <p className="text-xs text-[var(--warning)]">{r.reviewReason}</p> : null}
                  {canCorrect && <Button variant="outline" className={`${TOUCH} w-full`} onClick={() => setCorrecting({ row: r, punchType: "clock_out", time: "", nextDay: false, reason: "" })}>تصحيح</Button>}
                </article>
              );
            }}
          />
        </SectionCard>
      )}

      {tab === "requests" && (
        <SectionCard title="طلبات التصحيح المعلقة" description="لا يمكن مراجعة طلبك أنت. الإجازة والمأمورية تحتاج «إدارة الإجازات»." flush testId="attendance-requests">
          {team.isLoading ? <div className="p-4"><LoadingSkeleton variant="cards" rows={2} /></div> : pending.length === 0 ? <div className="p-4"><EmptyState title="لا طلبات معلقة" description="الطلبات الجديدة من الموظفين تظهر هنا." /></div> : (
            <ul className="divide-y divide-border">
              {pending.map(r => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 p-3 text-sm" data-testid={`attendance-request-${r.id}`}>
                  <span className="font-medium">{r.employeeName}</span>
                  <span className="tabular-nums text-muted-foreground">{r.workDate}</span>
                  <span>{REQUEST_TYPE_LABELS[r.requestType as CorrectionRequestType] ?? r.requestType}</span>
                  <span className="w-full text-muted-foreground">{r.reason}</span>
                  <div className="flex w-full gap-2 sm:w-auto">
                    <Button className={TOUCH} disabled={review.isPending} onClick={() => setReviewing({ id: Number(r.id), decision: "approve", reason: "" })}>اعتماد</Button>
                    <Button variant="outline" className={TOUCH} disabled={review.isPending} onClick={() => setReviewing({ id: Number(r.id), decision: "reject", reason: "" })}>رفض</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "shifts" && (
        <SectionCard title="الورديات" description="لا ورديات جاهزة — أنشئ ما يناسب شركتك. تعديل الوردية لا يغيّر الأيام السابقة." testId="attendance-shifts"
          action={<Button className={TOUCH} onClick={() => setShift(blankShift())} data-testid="shift-new">وردية جديدة</Button>}>
          {shifts.isLoading ? <LoadingSkeleton variant="cards" rows={2} /> : shiftRows.length === 0 ? <EmptyState title="لا ورديات بعد" description="مثال: 11:00 إلى 18:00 من السبت للخميس — تحدده أنت." /> : (
            <ul className="divide-y divide-border">
              {shiftRows.map(s => (
                <li key={s.id} className="flex flex-wrap items-center gap-2 py-3 text-sm" data-testid={`shift-${s.id}`}>
                  <span className="font-medium">{s.name}</span>
                  <span className="tabular-nums">{String(s.startTime).slice(0, 5)}–{String(s.endTime).slice(0, 5)}</span>
                  {Number(s.crossesMidnight) ? <StatusBadge status="night" label="ليلية" tone="info" size="sm" icon={null} /> : null}
                  {!Number(s.isActive) && <StatusBadge status="inactive" label="موقوفة" tone="neutral" size="sm" icon={null} />}
                  <span className="text-muted-foreground">{daysFromMask(Number(s.workDaysMask)).map(k => WEEKDAYS.find(w => w.key === k)!.label).join("، ")}</span>
                  <span className="text-muted-foreground">{bizName(s.businessId)} · {s.timezone}</span>
                  <div className="ms-auto flex gap-2">
                    <Button variant="ghost" className={TOUCH} onClick={() => setShift({
                      id: Number(s.id), version: Number(s.version), name: s.name, businessId: s.businessId == null ? null : Number(s.businessId), startTime: String(s.startTime).slice(0, 5), endTime: String(s.endTime).slice(0, 5),
                      workDays: daysFromMask(Number(s.workDaysMask)), graceMinutes: Number(s.graceMinutes), allowedBreakMinutes: Number(s.allowedBreakMinutes), overtimeStartsAfterMinutes: Number(s.overtimeStartsAfterMinutes),
                      earlyClockInLimitMinutes: Number(s.earlyClockInLimitMinutes), earlyLeaveToleranceMinutes: Number(s.earlyLeaveToleranceMinutes), timezone: s.timezone, effectiveFrom: s.effectiveFrom, effectiveTo: s.effectiveTo ?? "",
                    })}>تعديل</Button>
                    <Button variant="ghost" className={TOUCH} disabled={setActive.isPending} onClick={() => setActive.mutate({ id: Number(s.id), isActive: !Number(s.isActive) })}>{Number(s.isActive) ? "إيقاف" : "تفعيل"}</Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      {tab === "assignments" && (
        <SectionCard title="التعيينات" description="الأولوية: موظف ← دور داخل نشاط ← نشاط ← دور على الشركة ← افتراضي الشركة." testId="attendance-assignments"
          action={<Button className={TOUCH} disabled={!shiftRows.some(s => Number(s.isActive))} onClick={() => setAsg({ shiftId: "", targetType: "", employeeId: "", role: "", businessId: "", effectiveFrom: dayKey(new Date()), effectiveTo: "", replaceExisting: false })} data-testid="assignment-new">تعيين جديد</Button>}>
          {assignments.isLoading ? <LoadingSkeleton variant="cards" rows={2} /> : !(assignments.data?.rows ?? []).length ? <EmptyState title="لا تعيينات" description="بلا تعيين يُسجَّل الحضور «بلا وردية» ويُعلَّم للمراجعة." /> : (
            <ul className="divide-y divide-border">
              {(assignments.data!.rows as any[]).map(a => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 py-3 text-sm">
                  <span className="font-medium">{a.shiftName}</span>
                  <span>{ASSIGNMENT_TARGET_LABELS[a.targetType as AssignmentTarget]}{a.targetType === "employee" ? `: ${a.employeeName}` : a.targetType === "role" ? `: ${ROLE_LABELS[a.role] ?? a.role}${a.businessId ? ` · ${bizName(Number(a.businessId))}` : ""}` : a.targetType === "business" ? `: ${bizName(Number(a.businessId))}` : ""}</span>
                  <span className="tabular-nums text-muted-foreground">{a.effectiveFrom} → {a.effectiveTo ?? "مفتوح"}</span>
                  <Button variant="ghost" className={`${TOUCH} ms-auto`} disabled={endAssignment.isPending} onClick={() => endAssignment.mutate({ id: Number(a.id) })}>إنهاء</Button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}

      <Dialog open={!!reviewing} onOpenChange={o => !o && setReviewing(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>{reviewing?.decision === "approve" ? "اعتماد الطلب" : "رفض الطلب"}</DialogTitle></DialogHeader>
          <Label htmlFor="rev-reason">ملاحظة للموظف (اختياري)</Label>
          <Textarea id="rev-reason" value={reviewing?.reason ?? ""} maxLength={500} onChange={e => setReviewing(r => r && { ...r, reason: e.target.value })} />
          <DialogFooter>
            <Button className={TOUCH} disabled={review.isPending} onClick={() => reviewing && review.mutate({ requestId: reviewing.id, decision: reviewing.decision, reviewReason: reviewing.reason.trim() || null })}>{review.isPending ? "جارٍ الحفظ…" : "تأكيد"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!shift} onOpenChange={o => !o && setShift(null)}>
        <DialogContent dir="rtl" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{shift?.id ? "تعديل وردية" : "وردية جديدة"}</DialogTitle></DialogHeader>
          {shift && (
            <div className="grid gap-3 sm:grid-cols-2" data-testid="shift-form">
              <div className="sm:col-span-2"><Label htmlFor="sh-name">الاسم</Label><Input id="sh-name" className={TOUCH} value={shift.name} maxLength={80} onChange={e => setShift({ ...shift, name: e.target.value })} placeholder="مثال: الصباحية" /></div>
              <div><Label htmlFor="sh-start">البداية</Label><Input id="sh-start" type="time" className={TOUCH} value={shift.startTime} onChange={e => setShift({ ...shift, startTime: e.target.value })} /></div>
              <div><Label htmlFor="sh-end">النهاية</Label><Input id="sh-end" type="time" className={TOUCH} value={shift.endTime} onChange={e => setShift({ ...shift, endTime: e.target.value })} /></div>
              {shiftCrosses && <p className="text-sm text-[var(--info)] sm:col-span-2">وردية ليلية — تنتهي في اليوم التالي، ويُنسب اليوم لتاريخ البداية.</p>}
              <fieldset className="sm:col-span-2">
                <legend className="mb-1 text-sm font-medium">أيام العمل</legend>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map(w => (
                    <label key={w.key} className="flex min-h-11 items-center gap-1.5 rounded-[var(--radius-brand-md)] border border-border px-2 text-sm">
                      <Checkbox checked={shift.workDays.includes(w.key)} onCheckedChange={v => setShift({ ...shift, workDays: v === true ? [...shift.workDays, w.key] : shift.workDays.filter(k => k !== w.key) })} /> {w.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <div className="sm:col-span-2">
                <Label htmlFor="sh-biz">النشاط</Label>
                <Select value={shift.businessId == null ? "all" : String(shift.businessId)} onValueChange={v => setShift({ ...shift, businessId: v === "all" ? null : Number(v) })}>
                  <SelectTrigger id="sh-biz" className={TOUCH}><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="all">كل الأنشطة</SelectItem>{businesses.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {([
                ["graceMinutes", "سماح التأخير (د)"], ["allowedBreakMinutes", "الاستراحة المسموحة (د)"], ["overtimeStartsAfterMinutes", "الإضافي يبدأ بعد (د)"],
                ["earlyClockInLimitMinutes", "أقصى حضور مبكر (د)"], ["earlyLeaveToleranceMinutes", "سماح الخروج المبكر (د)"],
              ] as const).map(([k, label]) => (
                <div key={k}><Label htmlFor={`sh-${k}`}>{label} <span className="text-xs text-muted-foreground">اقتراح: {SHIFT_FORM_SUGGESTIONS[k]}</span></Label>
                  <Input id={`sh-${k}`} type="number" min={0} inputMode="numeric" className={TOUCH} value={shift[k]} onChange={e => setShift({ ...shift, [k]: Math.max(0, Math.trunc(Number(e.target.value) || 0)) })} /></div>
              ))}
              <div><Label htmlFor="sh-tz">المنطقة الزمنية</Label><Input id="sh-tz" dir="ltr" className={TOUCH} value={shift.timezone} onChange={e => setShift({ ...shift, timezone: e.target.value })} /></div>
              <div><Label htmlFor="sh-from">يسري من</Label><Input id="sh-from" type="date" className={TOUCH} value={shift.effectiveFrom} onChange={e => setShift({ ...shift, effectiveFrom: e.target.value })} /></div>
              <div><Label htmlFor="sh-to">حتى (اختياري)</Label><Input id="sh-to" type="date" className={TOUCH} value={shift.effectiveTo} onChange={e => setShift({ ...shift, effectiveTo: e.target.value })} /></div>
              {shiftError && <p className="text-sm text-destructive sm:col-span-2" role="alert">{shiftError}</p>}
            </div>
          )}
          <DialogFooter><Button className={TOUCH} disabled={!!shiftError || createShift.isPending || updateShift.isPending} onClick={saveShift} data-testid="shift-save">{createShift.isPending || updateShift.isPending ? "جارٍ الحفظ…" : "حفظ"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!asg} onOpenChange={o => !o && setAsg(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>تعيين وردية</DialogTitle></DialogHeader>
          {asg && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2"><Label htmlFor="as-shift">الوردية</Label>
                <Select value={asg.shiftId} onValueChange={v => setAsg({ ...asg, shiftId: v })}><SelectTrigger id="as-shift" className={TOUCH}><SelectValue placeholder="اختر الوردية" /></SelectTrigger>
                  <SelectContent>{shiftRows.filter(s => Number(s.isActive)).map(s => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}</SelectContent></Select></div>
              <div className="sm:col-span-2"><Label htmlFor="as-target">الهدف</Label>
                <Select value={asg.targetType} onValueChange={v => setAsg({ ...asg, targetType: v as AssignmentTarget })}><SelectTrigger id="as-target" className={TOUCH}><SelectValue placeholder="اختر الهدف" /></SelectTrigger>
                  <SelectContent>{ASSIGNMENT_TARGETS.map(t => <SelectItem key={t} value={t}>{ASSIGNMENT_TARGET_LABELS[t]}</SelectItem>)}</SelectContent></Select></div>
              {asg.targetType === "employee" && (
                <div className="sm:col-span-2"><Label htmlFor="as-emp">الموظف</Label>
                  <Select value={asg.employeeId} onValueChange={v => setAsg({ ...asg, employeeId: v })}><SelectTrigger id="as-emp" className={TOUCH}><SelectValue placeholder="اختر الموظف" /></SelectTrigger>
                    <SelectContent>{((employees.data ?? []) as any[]).map(e => <SelectItem key={e.id} value={String(e.id)}>{e.name}</SelectItem>)}</SelectContent></Select></div>
              )}
              {asg.targetType === "role" && (
                <div><Label htmlFor="as-role">الدور</Label>
                  <Select value={asg.role} onValueChange={v => setAsg({ ...asg, role: v })}><SelectTrigger id="as-role" className={TOUCH}><SelectValue placeholder="اختر الدور" /></SelectTrigger>
                    <SelectContent>{Object.entries(ROLE_LABELS).filter(([r]) => r !== "super_admin").map(([r, l]) => <SelectItem key={r} value={r}>{l}</SelectItem>)}</SelectContent></Select></div>
              )}
              {(asg.targetType === "role" || asg.targetType === "business") && (
                <div><Label htmlFor="as-biz">النشاط{asg.targetType === "role" ? " (اختياري)" : ""}</Label>
                  <Select value={asg.businessId || "all"} onValueChange={v => setAsg({ ...asg, businessId: v === "all" ? "" : v })}><SelectTrigger id="as-biz" className={TOUCH}><SelectValue /></SelectTrigger>
                    <SelectContent>{asg.targetType === "role" && <SelectItem value="all">كل الأنشطة</SelectItem>}{businesses.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}</SelectContent></Select></div>
              )}
              <div><Label htmlFor="as-from">يسري من</Label><Input id="as-from" type="date" className={TOUCH} value={asg.effectiveFrom} onChange={e => setAsg({ ...asg, effectiveFrom: e.target.value })} /></div>
              <div><Label htmlFor="as-to">حتى (اختياري)</Label><Input id="as-to" type="date" className={TOUCH} value={asg.effectiveTo} onChange={e => setAsg({ ...asg, effectiveTo: e.target.value })} /></div>
              <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2"><Checkbox checked={asg.replaceExisting} onCheckedChange={v => setAsg({ ...asg, replaceExisting: v === true })} /> استبدال أي تعيين متداخل لنفس الهدف</label>
              {asgError && <p className="text-sm text-destructive sm:col-span-2" role="alert">{asgError}</p>}
            </div>
          )}
          <DialogFooter><Button className={TOUCH} disabled={!!asgError || assign.isPending} onClick={saveAsg}>{assign.isPending ? "جارٍ الحفظ…" : "تعيين"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!correcting} onOpenChange={o => !o && setCorrecting(null)}>
        <DialogContent dir="rtl">
          <DialogHeader><DialogTitle>تصحيح إداري — {correcting?.row.employeeName} ({correcting?.row.workDate})</DialogTitle></DialogHeader>
          {correcting && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div><Label htmlFor="co-type">التسجيل</Label>
                <Select value={correcting.punchType} onValueChange={v => setCorrecting({ ...correcting, punchType: v as keyof typeof CLOCK_ACTION_LABELS })}><SelectTrigger id="co-type" className={TOUCH}><SelectValue /></SelectTrigger>
                  <SelectContent>{(Object.keys(CLOCK_ACTION_LABELS) as (keyof typeof CLOCK_ACTION_LABELS)[]).map(k => <SelectItem key={k} value={k}>{CLOCK_ACTION_LABELS[k]}</SelectItem>)}</SelectContent></Select></div>
              <div><Label htmlFor="co-time">الوقت ({correcting.row.timezone})</Label><Input id="co-time" type="time" className={TOUCH} value={correcting.time} onChange={e => setCorrecting({ ...correcting, time: e.target.value })} /></div>
              <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2"><Checkbox checked={correcting.nextDay} onCheckedChange={v => setCorrecting({ ...correcting, nextDay: v === true })} /> بعد منتصف الليل</label>
              <div className="sm:col-span-2"><Label htmlFor="co-reason">السبب (يُحفظ في السجل)</Label><Textarea id="co-reason" value={correcting.reason} maxLength={200} onChange={e => setCorrecting({ ...correcting, reason: e.target.value })} /></div>
              <p className="text-xs text-muted-foreground sm:col-span-2">التصحيح حدث جديد في السجل — لا يُحذف ولا يُعدَّل الأصل.</p>
            </div>
          )}
          <DialogFooter><Button className={TOUCH} disabled={!correctIso || (correcting?.reason.trim().length ?? 0) < 3 || adminCorrect.isPending} onClick={saveCorrect}>{adminCorrect.isPending ? "جارٍ الحفظ…" : "حفظ التصحيح"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
