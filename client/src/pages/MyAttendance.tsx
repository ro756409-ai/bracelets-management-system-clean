import { useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { operationIdFor } from "@/lib/operationId";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmployeeShell } from "@/components/shell/EmployeeShell";
import { businessDateKey } from "@shared/businessTime";
import { CORRECTION_REQUEST_TYPES, type CorrectionRequestType } from "@shared/attendanceSpec";
import {
  CLOCK_ACTION_LABELS, DAY_STATUS_LABELS, REQUEST_STATUS_LABELS, REQUEST_TYPE_LABELS, availableClockActions, formatClock, formatMinutes, localTimeToIso, type ClockActionKey,
} from "@shared/attendanceLabels";
import { EmptyState, ErrorState, LoadingSkeleton, SectionCard, StatusBadge, toast } from "@/components/shared";

/**
 * «حضوري» لموظف البوابة — هوية كوكي الموظف فقط (employeePortal.attendance*)، لا employeeId من الواجهة.
 *  • كل زر يحمل operationId ثابتًا للعملية (لا جديد مع كل نقرة) ومعطل أثناء التنفيذ؛ السيرفر يعيد Replay.
 *  • الأوقات تُعرض بتوقيت اليوم (IANA) وتُرسل ISO UTC؛ الحساب كله على السيرفر.
 *  • العلم معطل ⇒ «غير مفعّل بعد» بلا أي طلب كتابة.
 */
const TZ = "Africa/Cairo";
const TOUCH = "min-h-11 md:min-h-9";
const today = () => businessDateKey(new Date(), TZ);
const daysAgo = (n: number) => businessDateKey(new Date(Date.now() - n * 86_400_000), TZ);
const TIME_TYPES: CorrectionRequestType[] = ["missing_clock_in", "missing_clock_out", "wrong_time"];

export default function MyAttendance() {
  const range = useMemo(() => ({ dateFrom: daysAgo(30), dateTo: today() }), []);
  const q = trpc.employeePortal.attendanceMine.useQuery(range, { retry: false, refetchInterval: 60_000 });
  const utils = trpc.useUtils();
  const refresh = () => utils.employeePortal.attendanceMine.invalidate();
  const clock = trpc.employeePortal.attendanceClock.useMutation({
    onSuccess: r => { toast.success(r.replay ? "مسجّل بالفعل" : "تم التسجيل"); refresh(); },
    onError: e => toast.error(e.message),
  });
  const request = trpc.employeePortal.attendanceRequestCorrection.useMutation({
    onSuccess: () => { toast.success("تم إرسال الطلب للمراجعة"); setForm(blankForm()); refresh(); },
    onError: e => toast.error(e.message),
  });
  const cancel = trpc.employeePortal.attendanceCancelRequest.useMutation({ onSuccess: () => { toast.success("تم إلغاء الطلب"); refresh(); }, onError: e => toast.error(e.message) });

  const blankForm = () => ({ workDate: today(), requestType: "" as CorrectionRequestType | "", at: "", start: "", end: "", nextDay: false, reason: "" });
  const [form, setForm] = useState(blankForm);

  const data = q.data && q.data.enabled ? q.data : null;
  const open = data?.open ?? null;
  const tz = (open?.timezone as string | undefined) ?? TZ;

  const doClock = (action: ClockActionKey) => {
    if (clock.isPending) return;
    clock.mutate({ action, operationId: operationIdFor(`attendance:${action}:${open?.id ?? "new"}:${open?.version ?? 0}`), source: window.matchMedia?.("(max-width: 767px)").matches ? "mobile_web" : "web" });
  };

  const formTz = (data?.days.find((d: any) => d.workDate === form.workDate)?.timezone as string | undefined) ?? TZ;
  const requestedValue = (): Record<string, string> | null => {
    if (!form.requestType) return null;
    if (TIME_TYPES.includes(form.requestType)) { const at = localTimeToIso(form.workDate, form.at, formTz, form.nextDay); return at ? { at } : null; }
    if (form.requestType === "break_fix") {
      const start = localTimeToIso(form.workDate, form.start, formTz, form.nextDay), end = localTimeToIso(form.workDate, form.end, formTz, form.nextDay);
      return start && end && start < end ? { start, end } : null;
    }
    return {};
  };
  const value = requestedValue();
  const canSubmit = !!form.requestType && value != null && form.reason.trim().length >= 3 && !request.isPending;
  const submit = () => {
    if (!canSubmit || !form.requestType) return;
    request.mutate({ workDate: form.workDate, requestType: form.requestType, requestedValue: value!, reason: form.reason.trim(), operationId: operationIdFor(`attendance-request:${form.workDate}:${form.requestType}`) });
  };

  return (
    <EmployeeShell title="حضوري" icon={Clock}>
      <div className="mx-auto max-w-3xl space-y-4" dir="rtl" data-testid="my-attendance">
        {q.isLoading ? <LoadingSkeleton variant="cards" rows={2} />
          : q.isError ? <ErrorState message={q.error?.message ?? "تعذّر تحميل حضورك"} onRetry={() => q.refetch()} />
          : !data ? <div data-testid="my-attendance-disabled"><EmptyState title="«حضوري» غير مفعّل بعد" description="يظهر هنا بعد تفعيل الحضور والانصراف لشركتك." /></div>
          : (
            <>
              <SectionCard title="الآن" description={open ? `يوم ${open.workDate} — بتوقيت ${tz}` : "لا يوجد يوم مفتوح"} testId="my-attendance-now">
                <div className="space-y-3">
                  {open && (
                    <div className="flex flex-wrap items-center gap-3 text-sm">
                      <StatusBadge status={open.status} label={DAY_STATUS_LABELS[open.status as keyof typeof DAY_STATUS_LABELS]?.label ?? open.status} tone={DAY_STATUS_LABELS[open.status as keyof typeof DAY_STATUS_LABELS]?.tone} />
                      <span>الحضور: <b className="tabular-nums">{formatClock(open.firstInMs, tz)}</b></span>
                      {open.scheduledStartMs != null && <span className="text-muted-foreground">الوردية: <span className="tabular-nums">{formatClock(open.scheduledStartMs, tz)}–{formatClock(open.scheduledEndMs, tz)}</span></span>}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2" role="group" aria-label="تسجيل الحضور">
                    {availableClockActions(open).map(a => (
                      <Button key={a} className={TOUCH} variant={a === "clock_out" ? "outline" : "default"} disabled={clock.isPending} aria-busy={clock.isPending && clock.variables?.action === a} onClick={() => doClock(a)} data-testid={`clock-${a}`}>
                        {clock.isPending && clock.variables?.action === a ? "جارٍ التسجيل…" : CLOCK_ACTION_LABELS[a]}
                      </Button>
                    ))}
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="آخر 30 يومًا" flush testId="my-attendance-days">
                {data.days.length === 0 ? <div className="p-4"><EmptyState title="لا أيام مسجلة بعد" description="سجّل حضورك ليظهر يومك هنا." /></div> : (
                  <ul className="divide-y divide-border">
                    {data.days.map((d: any) => {
                      const st = DAY_STATUS_LABELS[d.status as keyof typeof DAY_STATUS_LABELS];
                      return (
                        <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm" data-testid={`my-day-${d.workDate}`}>
                          <span className="font-medium tabular-nums">{d.workDate}</span>
                          <StatusBadge status={d.status} label={st?.label ?? d.status} tone={st?.tone} size="sm" />
                          <span className="tabular-nums">{formatClock(d.firstInMs, d.timezone)} – {formatClock(d.lastOutMs, d.timezone)}</span>
                          <span className="tabular-nums text-muted-foreground">عمل {formatMinutes(d.workedMinutes)}{Number(d.lateMinutes) ? ` · تأخير ${formatMinutes(d.lateMinutes)}` : ""}{Number(d.excessBreakMinutes) ? ` · استراحة زائدة ${formatMinutes(d.excessBreakMinutes)}` : ""}</span>
                          {Number(d.requiresReview) ? <span className="w-full text-xs text-[var(--warning)]">{d.reviewReason}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </SectionCard>

              <SectionCard title="طلب تصحيح" description="الطلب يُراجع من الإدارة — لا يغيّر يومك قبل الاعتماد." testId="my-attendance-request">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><Label htmlFor="req-date">اليوم</Label><Input id="req-date" type="date" className={TOUCH} value={form.workDate} max={today()} onChange={e => setForm(f => ({ ...f, workDate: e.target.value }))} /></div>
                  <div>
                    <Label htmlFor="req-type">النوع</Label>
                    <Select value={form.requestType} onValueChange={v => setForm(f => ({ ...f, requestType: v as CorrectionRequestType }))}>
                      <SelectTrigger id="req-type" className={TOUCH}><SelectValue placeholder="اختر نوع الطلب" /></SelectTrigger>
                      <SelectContent>{CORRECTION_REQUEST_TYPES.map(t => <SelectItem key={t} value={t}>{REQUEST_TYPE_LABELS[t]}</SelectItem>)}</SelectContent>
                    </Select>
                  </div>
                  {form.requestType && TIME_TYPES.includes(form.requestType) && (
                    <div><Label htmlFor="req-at">الوقت الصحيح</Label><Input id="req-at" type="time" className={TOUCH} value={form.at} onChange={e => setForm(f => ({ ...f, at: e.target.value }))} /></div>
                  )}
                  {form.requestType === "break_fix" && (
                    <>
                      <div><Label htmlFor="req-start">بداية الاستراحة</Label><Input id="req-start" type="time" className={TOUCH} value={form.start} onChange={e => setForm(f => ({ ...f, start: e.target.value }))} /></div>
                      <div><Label htmlFor="req-end">نهاية الاستراحة</Label><Input id="req-end" type="time" className={TOUCH} value={form.end} onChange={e => setForm(f => ({ ...f, end: e.target.value }))} /></div>
                    </>
                  )}
                  {form.requestType && (TIME_TYPES.includes(form.requestType) || form.requestType === "break_fix") && (
                    <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2"><Checkbox checked={form.nextDay} onCheckedChange={v => setForm(f => ({ ...f, nextDay: v === true }))} /> الوقت بعد منتصف الليل (وردية ليلية)</label>
                  )}
                  <div className="sm:col-span-2"><Label htmlFor="req-reason">السبب</Label><Textarea id="req-reason" value={form.reason} maxLength={500} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} placeholder="اكتب السبب باختصار" /></div>
                </div>
                <div className="mt-3 flex justify-end"><Button className={TOUCH} disabled={!canSubmit} onClick={submit} data-testid="request-submit">{request.isPending ? "جارٍ الإرسال…" : "إرسال الطلب"}</Button></div>
              </SectionCard>

              <SectionCard title="طلباتي" flush testId="my-attendance-requests">
                {data.requests.length === 0 ? <div className="p-4"><EmptyState title="لا طلبات" description="طلبات التصحيح التي ترسلها تظهر هنا." /></div> : (
                  <ul className="divide-y divide-border">
                    {data.requests.map((r: any) => {
                      const st = REQUEST_STATUS_LABELS[r.status] ?? { label: r.status, tone: "neutral" as const };
                      return (
                        <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                          <span className="tabular-nums">{r.workDate}</span>
                          <span>{REQUEST_TYPE_LABELS[r.requestType as CorrectionRequestType] ?? r.requestType}</span>
                          <StatusBadge status={r.status} label={st.label} tone={st.tone} size="sm" />
                          {r.status === "pending" && <Button variant="ghost" className={TOUCH} disabled={cancel.isPending} onClick={() => cancel.mutate({ requestId: Number(r.id) })}>إلغاء</Button>}
                          {r.reviewReason && <span className="w-full text-xs text-muted-foreground">رد المراجع: {r.reviewReason}</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </SectionCard>
            </>
          )}
      </div>
    </EmployeeShell>
  );
}
