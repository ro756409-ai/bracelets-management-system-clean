import { Link, useLocation } from "wouter";
import { BookOpen, History, LogOut } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Button } from "@/components/ui/button";

/**
 * غلاف صفحات دفتر V3:
 *   • جلسة مالك/أدمن (`auth.me` يرجّع user) → لوحة التحكم الكاملة كما هي.
 *   • جلسة موظف غير إداري (المحاسب: `user` = null لكن صلاحياته من `auth.myPermissions`) → قشرة خفيفة
 *     Mobile-first: عنوان + تبويبان + خروج. بدون هذا كان `DashboardLayout` يعرض له «يرجى تسجيل الدخول»
 *     رغم أن الـendpoints تصرّح له. الحارس الحقيقي يبقى على السيرفر (`ledgerProcedure`).
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
] as const;

export function EmployeeLedgerShell({ children }: { children: React.ReactNode }) {
  const [location, setLocation] = useLocation();
  const me = trpc.employeePortal.me.useQuery(undefined, { retry: false, staleTime: 5 * 60 * 1000 });

  const logout = async () => {
    try { await fetch("/api/employee/logout", { method: "POST", credentials: "include" }); } catch { /* الكوكي قد يكون منتهيًا أصلًا */ }
    setLocation("/employee-login");
  };

  return (
    <div className="min-h-screen bg-background" dir="rtl" data-testid="ledger-employee-shell">
      <header className="sticky top-0 z-20 border-b bg-card/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><BookOpen className="h-5 w-5" /></span>
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">دفتر الحسابات</p>
              {me.data?.name && <p className="truncate text-xs text-muted-foreground" data-testid="ledger-shell-user">{me.data.name}</p>}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={logout} className="min-h-11 shrink-0" data-testid="ledger-shell-logout">
            <LogOut className="h-4 w-4 ml-1" /> خروج
          </Button>
        </div>
        <nav className="mx-auto grid max-w-5xl grid-cols-2" aria-label="تبويبات الدفتر">
          {TABS.map(t => {
            const active = location === t.path;
            return (
              <Link key={t.path} href={t.path} className={`flex min-h-11 items-center justify-center gap-1.5 border-b-2 text-sm ${active ? "border-primary font-semibold text-primary" : "border-transparent text-muted-foreground"}`} data-testid={`ledger-tab-${t.path === "/ledger" ? "daily" : "transactions"}`}>
                <t.icon className="h-4 w-4" />{t.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-3 py-4">{children}</main>
    </div>
  );
}
