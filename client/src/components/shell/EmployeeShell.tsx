import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { ArrowRight, LogOut, type LucideIcon } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";

/**
 * قشرة خفيفة لجلسة موظف غير إداري (`auth.me` = null، صلاحياته من `auth.myPermissions`) على صفحات
 * كانت تُغلَّف بـ`DashboardLayout` فتعرض له «يرجى تسجيل الدخول» رغم أن الـendpoints تصرّح له
 * (نفس فكرة `EmployeeLedgerShell` للمحاسب). Mobile-first: عنوان + اسم الموظف + رجوع + خروج.
 * لا صلاحية جديدة ولا backend: الحارس الحقيقي يبقى على السيرفر (`permissionProcedure`).
 */
export function EmployeeShell({ title, icon: Icon, backTo = "/employee-dashboard", children }: { title: string; icon?: LucideIcon; backTo?: string; children: ReactNode }) {
  const [, setLocation] = useLocation();
  const me = trpc.employeePortal.me.useQuery(undefined, { retry: false, staleTime: 5 * 60 * 1000 });

  const logout = async () => {
    try { await fetch("/api/employee/logout", { method: "POST", credentials: "include" }); } catch { /* الكوكي قد يكون منتهيًا أصلًا */ }
    setLocation("/employee-login");
  };

  return (
    <div className="min-h-screen bg-background" dir="rtl" data-testid="employee-shell" style={{ ["--bottom-nav-h" as string]: "0px" } as React.CSSProperties}>
      <header data-readonly-safe className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Button data-readonly-safe variant="ghost" className="min-h-11 min-w-11 shrink-0 px-2" onClick={() => setLocation(backTo)} aria-label="رجوع" data-testid="employee-shell-back">
              <ArrowRight className="h-5 w-5" aria-hidden="true" />
            </Button>
            {Icon && (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)] bg-accent text-accent-foreground" aria-hidden="true"><Icon className="h-5 w-5" /></span>
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{title}</p>
              {me.data?.name && <p className="truncate text-xs text-muted-foreground" data-testid="employee-shell-user">{me.data.name}</p>}
            </div>
          </div>
          <Button data-readonly-safe variant="ghost" size="sm" onClick={logout} className="min-h-11 shrink-0" data-testid="employee-shell-logout">
            <LogOut className="h-4 w-4 ml-1" aria-hidden="true" /> خروج
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-3 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">{children}</main>
    </div>
  );
}
