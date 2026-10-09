import { Lock, LogOut } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { useTenantAccess } from "@/contexts/TenantAccessContext";

/**
 * حالة وصول الشركة (TENANT_ACCESS_ENFORCEMENT_ENABLED) — العرض فقط؛ الحارس الحقيقي على السيرفر.
 *  • العلم معطل أو بلا جلسة ⇒ enforced:false ⇒ لا شيء إطلاقًا (لا شاشة قبل جاهزية الحارس).
 *  • read_only ⇒ شريط ثابت: الدخول والقراءة والتصدير وإعدادات الاشتراك متاحة، بلا كتابة.
 *  • blocked ⇒ شاشة كاملة بالسبب وزر خروج فقط.
 */
export function TenantAccessNotice() {
  // المصدر الموحّد (TenantAccessProvider) — لا استعلام ثانٍ هنا.
  const data = useTenantAccess();
  const ownerLogout = trpc.auth.logout.useMutation();
  if (!data.enforced || data.level === "full") return null;

  // الخروج مسموح في كل المستويات (auth.logout في قائمة المسموح، و/api/employee مستثنى من الحارس).
  const logout = async () => {
    await Promise.allSettled([
      fetch("/api/employee/logout", { method: "POST", credentials: "include" }),
      ownerLogout.mutateAsync(),
    ]);
    try { localStorage.removeItem("employee_session"); } catch { /* تخزين غير متاح */ }
    window.location.href = "/";
  };

  if (data.level === "blocked")
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/95 p-4" dir="rtl" data-readonly-safe role="alertdialog" aria-modal="true" aria-labelledby="tenant-blocked-title" data-testid="tenant-access-blocked">
        <div className="w-full max-w-md space-y-4 rounded-[var(--radius-brand-lg)] border border-border bg-card p-6 text-center shadow-[var(--shadow-card)]">
          <Lock className="mx-auto h-10 w-10 text-destructive" aria-hidden="true" />
          <h1 id="tenant-blocked-title" className="text-lg font-bold">الحساب غير متاح</h1>
          <p className="text-sm text-muted-foreground">{data.message}</p>
          <Button className="min-h-11 w-full" variant="outline" onClick={logout}><LogOut className="h-4 w-4" aria-hidden="true" /> تسجيل الخروج</Button>
        </div>
      </div>
    );

  return (
    <div className="sticky top-0 z-[60] border-b border-[var(--warning)]/40 bg-[var(--warning)]/15 px-4 py-2 text-center text-sm text-foreground" dir="rtl" role="status" data-readonly-safe data-testid="tenant-access-readonly">
      <span className="font-semibold">وضع القراءة فقط — </span>{data.message}
      {data.until ? <span className="text-muted-foreground"> ({new Date(data.until).toLocaleDateString("ar-EG")})</span> : null}
      <span className="text-muted-foreground"> · الدخول والقراءة والتصدير متاحة، والتعديل متوقف.</span>
    </div>
  );
}
