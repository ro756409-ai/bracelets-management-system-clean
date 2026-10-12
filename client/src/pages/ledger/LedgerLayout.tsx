import { Link, useLocation } from "wouter";
import { MessagesEntryButton } from "@/components/messaging/MessagesEntryButton";
import { BookOpen, CalendarCheck, History, Landmark, LogOut } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";

/**
 * غلاف صفحات دفتر V3:
 *   • جلسة مالك/أدمن (`auth.me` يرجّع user) → لوحة التحكم الكاملة كما هي.
 *   • جلسة موظف غير إداري (المحاسب: `user` = null لكن صلاحياته من `auth.myPermissions`) → قشرة خفيفة
 *     Mobile-first: عنوان + تبويبات (يومية/سجل/حسابات/مراجعة الشهر، قابلة للتمرير أفقيًا) + خروج. بدون هذا كان `DashboardLayout` يعرض له «يرجى تسجيل الدخول»
 *     رغم أن الـendpoints تصرّح له. الحارس الحقيقي يبقى على السيرفر (`ledgerProcedure`).
 * المرحلة 7E (عرض فقط): القشرة على tokens الهوية، تبويبات 44px مع aria-current، و`--bottom-nav-h: 0`
 * لأن لا شريط سفلي هنا — نفس الاستعلام (employeePortal.me) ونفس الخروج.
 */
export default function LedgerLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (user) return <DashboardLayout>{children}</DashboardLayout>;
  return <EmployeeLedgerShell>{children}</EmployeeLedgerShell>;
}

const TABS = [
  { path: "/ledger", label: "الحسابات اليومية", icon: BookOpen },
  { path: "/ledger/transactions", label: "سجل الحركات", icon: History },
  { path: "/ledger/accounts", label: "الحسابات", icon: Landmark },
  { path: "/ledger/periods", label: "مراجعة الشهر", icon: CalendarCheck },
] as const;
const tabTestId = (path: string) => `ledger-tab-${path === "/ledger" ? "daily" : path.slice("/ledger/".length)}`;

export function EmployeeLedgerShell({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const me = trpc.employeePortal.me.useQuery(undefined, { retry: false, staleTime: 5 * 60 * 1000 });

  const logout = async () => {
    try { await fetch("/api/employee/logout", { method: "POST", credentials: "include" }); } catch { /* الكوكي قد يكون منتهيًا أصلًا */ }
    setLocation("/employee-login");
  };

  return (
    <div className="min-h-screen bg-background" dir="rtl" data-testid="ledger-employee-shell" style={{ ["--bottom-nav-h" as string]: "0px" } as React.CSSProperties}>
      <header className="sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)] bg-accent text-accent-foreground" aria-hidden="true"><BookOpen className="h-5 w-5" /></span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">دفتر الحسابات</p>
              {me.data?.name && <p className="truncate text-xs text-muted-foreground" data-testid="ledger-shell-user">{me.data.name}</p>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <MessagesEntryButton via="portal" className="shrink-0" />
            <Button data-readonly-safe variant="ghost" size="sm" onClick={logout} className="min-h-11 shrink-0" data-testid="ledger-shell-logout">
              <LogOut className="h-4 w-4 ml-1" aria-hidden="true" /> خروج
            </Button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-5xl overflow-x-auto" aria-label="تبويبات الدفتر">
          {TABS.map(t => {
            const active = location === t.path;
            return (
              <Link
                key={t.path}
                href={t.path}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-11 flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap border-b-2 px-3 text-sm transition-colors duration-[var(--duration-fast)] ${active ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                data-testid={tabTestId(t.path)}
              >
                <t.icon className="h-4 w-4" aria-hidden="true" />{t.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-3 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">{children}</main>
    </div>
  );
}
