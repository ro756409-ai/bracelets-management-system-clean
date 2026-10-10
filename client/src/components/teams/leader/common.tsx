import { ErrorState, OfflineState, PermissionDeniedState } from "@/components/shared";
import { errorCode, serverErrorText } from "../teamsUi";

/** فريق يقوده الموظف الآن (من myTeams على السيرفر) — كل تبويب يستقبله، لا من الرابط. */
export type LedTeam = { teamId: number; businessId: number; name: string };
export type LeaderPerms = { has: (p: string) => boolean };

/** خطأ استعلام: بلا اتصال ⇒ Offline، رفض صلاحية/قيادة ⇒ PermissionDenied، غير ذلك ⇒ Error بسبب السيرفر بالعربي. */
export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return <OfflineState onRetry={onRetry} />;
  if (errorCode(error) === "FORBIDDEN") return <PermissionDeniedState message={serverErrorText(error)} />;
  return <ErrorState message={serverErrorText(error)} onRetry={onRetry} />;
}

/** فجوة في الخادم: لا مسار يقدّم هذه البيانات بعد — نقولها صراحة بدل حساب أو تخمين في الواجهة. */
export function ServerGap({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return <p className="rounded-[var(--radius-brand-md)] border border-dashed border-border px-3 py-2 text-sm text-muted-foreground" data-testid={testId}>غير متاح من الخادم — {children}</p>;
}
