import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandLogo } from "@/components/BrandLogo";
import { Eye, EyeOff, Lock, User, Loader2 } from "lucide-react";

/**
 * تسجيل دخول لوحة الإدارة — نفس /api/auth/login ونفس التحقق وإعادة التحميل الكاملة بعد النجاح.
 * المرحلة 7H (عرض فقط): `<main>` واحد، حقول معنونة 44px، زر إظهار كلمة المرور 44px، الخطأ role=alert،
 * وبلا ألوان خام (التدرّج من tokens الهوية).
 */
export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError("يرجى إدخال اسم المستخدم أو البريد الإلكتروني وكلمة المرور");
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: username.trim(), password }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        setError(data.error || "حدث خطأ، حاول مرة أخرى");
        return;
      }

      // Full reload so the tRPC context re-reads the new session cookie.
      window.location.href = "/dashboard";
    } catch {
      setError("تعذر الاتصال بالخادم، حاول مرة أخرى");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main
      dir="rtl"
      className="flex min-h-screen items-center justify-center p-4"
      style={{ background: "linear-gradient(135deg, var(--brand-surface) 0%, var(--brand-surface-strong) 100%)" }}
      data-testid="login-page"
    >
      <div className="relative w-full max-w-sm">
        <div className="rounded-[var(--radius-brand-lg,var(--radius-brand-md))] border-0 bg-card/95 shadow-[var(--shadow-card)] backdrop-blur">
          <div className="px-6 pb-4 pt-8 text-center">
            <div className="mb-4 flex justify-center">
              <BrandLogo variant="vertical" size="xl" showEnglishName />
            </div>
            <h1 className="text-sm text-muted-foreground">تسجيل دخول لوحة الإدارة</h1>
          </div>

          <div className="px-6 pb-8">
            <form onSubmit={handleLogin} className="space-y-4" noValidate>
              <div>
                <Label htmlFor="login-username" className="text-sm font-medium">اسم المستخدم أو البريد الإلكتروني</Label>
                <div className="relative mt-1.5">
                  <User className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    id="login-username"
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="أدخل اسم المستخدم أو البريد الإلكتروني"
                    className="min-h-11 pr-10 text-right"
                    autoComplete="username"
                    dir="ltr"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor="login-password" className="text-sm font-medium">كلمة المرور</Label>
                <div className="relative mt-1.5">
                  <Lock className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    id="login-password"
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

              {error && (
                <div className="rounded-[var(--radius-brand-md)] border border-destructive/20 bg-destructive/10 p-3 text-center text-sm text-destructive" role="alert">
                  {error}
                </div>
              )}

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

            <div className="mt-6 space-y-2 text-center">
              <p className="text-xs text-muted-foreground">
                تاجر جديد؟{" "}
                <a href="/signup" className="inline-flex min-h-11 items-center font-medium text-primary hover:underline md:min-h-0">إنشاء حساب</a>
              </p>
              <p className="text-xs text-muted-foreground">
                موظف؟{" "}
                <a href="/employee-login" className="inline-flex min-h-11 items-center font-medium text-primary hover:underline md:min-h-0">دخول الموظفين</a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
