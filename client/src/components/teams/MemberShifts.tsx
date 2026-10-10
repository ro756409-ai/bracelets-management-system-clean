import { AlertTriangle, Moon } from "lucide-react";
import { StatusBadge } from "@/components/shared";

/**
 * ورديات أعضاء الفريق اليوم — كما يطبّقها الحضور فعلًا (teams.memberShifts / employeePortal.team.memberShifts).
 * لا حساب في الواجهة: الحالة none/active/conflict والوردية والمتعارضات كلها من السيرفر. بلا معرّفات خام.
 */
export type MemberShift = {
  employeeId: number;
  employeeName: string;
  membershipRole: "member" | "leader";
  status: "none" | "active" | "conflict";
  shift: { name: string; startTime: string; endTime: string; crossesMidnight: boolean; timezone: string; workDays: string[]; worksOnDate: boolean } | null;
  conflictingShiftNames: string[];
};

const DAY: Record<string, string> = { sat: "السبت", sun: "الأحد", mon: "الاثنين", tue: "الثلاثاء", wed: "الأربعاء", thu: "الخميس", fri: "الجمعة" };
const STATUS = {
  none: { label: "بلا وردية", tone: "warning" as const },
  active: { label: "وردية سارية", tone: "success" as const },
  conflict: { label: "تعارض ورديات", tone: "danger" as const },
};

export function MemberShiftsList({ workDate, timeZone, members }: { workDate: string; timeZone: string; members: MemberShift[] }) {
  const warnings = members.filter(m => m.status !== "active").length;
  return (
    <div className="space-y-2" data-testid="member-shifts">
      <p className="text-xs text-muted-foreground">
        اليوم <span className="tabular-nums" dir="ltr">{workDate}</span> بتوقيت <span dir="ltr">{timeZone}</span> ·
        {warnings ? <> تحذيرات: <span className="tabular-nums">{warnings}</span></> : " لا تحذيرات"}
      </p>
      {members.length === 0 ? <p className="text-sm text-muted-foreground">لا أعضاء حاليًا.</p> : (
        <ul className="grid gap-2 md:grid-cols-2">
          {members.map(m => {
            const s = STATUS[m.status];
            return (
              <li key={m.employeeId} className="space-y-1 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-status={m.status}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{m.employeeName}{m.membershipRole === "leader" ? " (قائد)" : ""}</span>
                  <StatusBadge status={m.status} label={s.label} tone={s.tone} size="sm" />
                </div>
                {m.shift ? (
                  <p className="text-sm">
                    {m.shift.name}: <span className="tabular-nums" dir="ltr">{m.shift.startTime}–{m.shift.endTime}</span>
                    {m.shift.crossesMidnight && <span className="ms-2 inline-flex items-center gap-1 text-xs text-muted-foreground"><Moon className="h-3 w-3" aria-hidden="true" /> ليلية (تنتهي اليوم التالي)</span>}
                  </p>
                ) : <p className="text-sm text-muted-foreground">لا وردية سارية اليوم — الحضور لن يحسب تأخيرًا أو انصرافًا مبكرًا.</p>}
                {m.shift && (
                  <p className="text-xs text-muted-foreground">
                    أيام العمل: {m.shift.workDays.map(d => DAY[d] ?? d).join("، ") || "—"} · {m.shift.worksOnDate ? "يعمل اليوم" : "ليس يوم عمله"}
                  </p>
                )}
                {m.status === "conflict" && (
                  <p className="flex items-start gap-1 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                    تعيينات متعادلة: {m.conflictingShiftNames.join("، ")} — يُطبَّق «{m.shift?.name ?? "—"}». راجع تعيينات الورديات في صفحة الحضور.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
