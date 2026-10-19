import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandLogo } from "@/components/BrandLogo";
import { activeBrand } from "@/lib/brandFlag";
import { Eye, EyeOff, Lock, User, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { readEmployeeScope, resetEmployeeClientState } from "@/lib/employeeScope";

/**
 * تسجيل دخول الموظف — نفس /api/employee/login ونفس التوجيه بحسب الدور ونفس مسح حالة الجهاز.
 * المرحلة 7I (عرض فقط): `<main>` واحد، حقول معنونة 44px، زر إظهار كلمة المرور 44px، الخطأ role=alert،
 * وإزالة نقش الهوية القديمة (البنفسجي rgba) — الخلفية من tokens الهوية فقط.
 */
export default function EmployeeLogin() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError("يرجى إدخال اسم المستخدم وكلمة المرور");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const res = await fetch("/api/employee/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: username.trim(), password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "حدث خطأ، حاول مرة أخرى");
        return;
      }

      // Store employee info in localStorage
      localStorage.setItem("employee_session", JSON.stringify(data.employee));
      // **تغيّرت الهوية → امسح كل حالة الحساب السابق على الجهاز.** من غير السطر ده
      // كان كتالوج الموظف اللي قبله (المخزّن في react-query بمفتاح بلا هوية) ومسودته
      // بيظهروا للموظف الجديد — بيانات نشاط تاني في شاشة إدخاله.
      resetEmployeeClientState(queryClient, readEmployeeScope());
      toast.success(`أهلاً ${data.employee.name}!`);

      // Redirect based on role
      if (data.employee.role === 'manager') {
        setLocation("/dashboard");
      } else if (data.employee.role === 'accountant') {
        // المحاسب → دفتر الحسابات V3؛ لو مش ممنوح `ledger.view` حارس المسار بيحوّله لصفحة
        // «قيد إعادة التطوير» الآمنة (النظام المحاسبي القديم مجمّد).
        setLocation("/ledger");
      } else if (data.employee.role === 'accounts_manager') {
        // مدير الحسابات → دفتر الحسابات V3 (مراجعة الشهر والإقفال وإدارة الحسابات).
        setLocation("/ledger");
      } else if (
        data.employee.role === 'facebook_entry' ||
        data.employee.role === 'data_entry'
      ) {
        // إدخال البيانات = شاشة إدخال أوردر يدوي (نفس شاشة facebook-entry) — مش بوابة التأكيدات.
        setLocation("/facebook-entry");
      } else if (data.employee.role === 'warehouse') {
        setLocation("/warehouse-dashboard");
      } else {
        setLocation("/employee-dashboard");
      }
    } catch {
      setError("تعذر الاتصال بالخادم، حاول مرة أخرى");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main
      dir="rtl"
      // v2: خلفية الصفحة الثابتة (#FAF9F7) زي باقي الواجهة؛ v1: نفس التدرّج الحالي.
      className={activeBrand() === "v2" ? "flex min-h-screen items-center justify-center bg-background p-4" : "flex min-h-screen items-center justify-center p-4"}
      style={activeBrand() === "v2" ? undefined : { background: "linear-gradient(135deg, var(--brand-surface) 0%, var(--brand-surface-strong) 100%)" }}
      data-testid="employee-login-page"
    >
      <div className="relative w-full max-w-sm">
        <div className={activeBrand() === "v2" ? "rounded-[var(--radius-brand-xl,1.5rem)] border border-border bg-card shadow-[var(--shadow-card)]" : "rounded-[var(--radius-brand-lg,var(--radius-brand-md))] border-0 bg-card/95 shadow-[var(--shadow-card)] backdrop-blur outline outline-[var(--auth-card-border)] -outline-offset-1"}>
          <div className="px-6 pb-4 pt-8 text-center">
            {/* Logo */}
            <div className="mb-4 flex justify-center">
              <BrandLogo variant="vertical" size="xl" showEnglishName />
            </div>
            <h1 className="text-sm text-muted-foreground">تسجيل دخول الموظف</h1>
          </div>

          <div className="px-6 pb-8">
            <form onSubmit={handleLogin} className="space-y-4" noValidate>
              {/* Username */}
              <div>
                <Label htmlFor="emp-login-username" className="text-sm font-medium">اسم المستخدم</Label>
                <div className="relative mt-1.5">
                  <User className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    id="emp-login-username"
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="أدخل اسم المستخدم"
                    className="min-h-11 pr-10 text-right"
                    autoComplete="username"
                    dir="ltr"
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <Label htmlFor="emp-login-password" className="text-sm font-medium">كلمة المرور</Label>
                <div className="relative mt-1.5">
                  <Lock className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    id="emp-login-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="أدخل كلمة المرور"
                    className="min-h-11 pl-12 pr-10 text-right"
                    autoComplete="current-password"
                    dir="ltr"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute left-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-muted-foreground transition-colors duration-[var(--duration-fast)] hover:text-foreground"
                    aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"}
                    aria-pressed={showPassword}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </button>
                </div>
              </div>

              {/* Error */}
              {error && (
                <div className="rounded-[var(--radius-brand-md)] border border-destructive/20 bg-destructive/10 p-3 text-center text-sm text-destructive" role="alert">
                  {error}
                </div>
              )}

              {/* Submit */}
              <Button
                type="submit"
                className="mt-2 h-11 w-full text-base font-semibold"
                disabled={isLoading}
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    جاري تسجيل الدخول...
                  </span>
                ) : (
                  "تسجيل الدخول"
                )}
              </Button>
            </form>

            {/* Admin link */}
            <div className="mt-6 text-center">
              <p className="text-xs text-muted-foreground">
                أنت مدير؟{" "}
                <a
                  href="/dashboard"
                  className="inline-flex min-h-11 items-center font-medium text-primary hover:underline md:min-h-0"
                >
                  دخول لوحة التحكم
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
