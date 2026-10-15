import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldCheck, Eye, EyeOff, Loader2 } from "lucide-react";

/**
 * دخول Platform Admin — منفصل تمامًا عن دخول العملاء. بيكلّم /api/platform/auth/login
 * (كوكي platform_admin_session المستقلة). مش مرئي/مربوط بأي صفحة عميل.
 * المرحلة 7H (عرض فقط): نفس الطلب والتحقق؛ `<main>` واحد، حقول معنونة 44px، خلفية من tokens بدل hex.
 */
export default function PlatformAdminLogin() {
  const [, setLocation] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!username.trim() || !password) { setError("أدخل اسم المستخدم وكلمة المرور"); return; }
    setIsLoading(true);
    try {
      const res = await fetch("/api/platform/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) { setError(data.error || "بيانات الدخول غير صحيحة"); return; }
      setLocation("/platform-admin");
    } catch {
      setError("تعذر الاتصال بالخادم");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main dir="rtl" className="flex min-h-screen items-center justify-center p-4" style={{ background: "linear-gradient(135deg, var(--brand-surface-strong) 0%, var(--sidebar, var(--foreground)) 100%)" }} data-testid="platform-login">
      <div className="w-full max-w-sm">
        <div className="rounded-[var(--radius-brand-lg,var(--radius-brand-md))] bg-card shadow-[var(--shadow-card)] outline outline-[var(--auth-card-border)] -outline-offset-1">
          <div className="px-6 pb-4 pt-8 text-center">
            <div className="mb-3 flex justify-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden="true">
                <ShieldCheck className="h-6 w-6" />
              </div>
            </div>
            <h1 className="text-lg font-bold">لوحة إدارة المنصة</h1>
            <p className="mt-1 text-sm text-muted-foreground">دخول مسؤول المنصة فقط</p>
          </div>
          <div className="px-6 pb-8">
            <form onSubmit={handleLogin} className="space-y-4" noValidate>
              <div>
                <Label htmlFor="platform-username" className="text-sm font-medium">اسم المستخدم</Label>
                <Input id="platform-username" value={username} onChange={e => setUsername(e.target.value)} className="mt-1.5 min-h-11" dir="ltr" autoComplete="username" />
              </div>
              <div>
                <Label htmlFor="platform-password" className="text-sm font-medium">كلمة المرور</Label>
                <div className="relative mt-1.5">
                  <Input id="platform-password" type={showPassword ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} className="min-h-11 pl-12" dir="ltr" autoComplete="current-password" />
                  <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute left-0 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground" aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"} aria-pressed={showPassword}>
                    {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                  </button>
                </div>
              </div>
              {error && <div className="rounded-[var(--radius-brand-md)] border border-destructive/20 bg-destructive/10 p-3 text-center text-sm text-destructive" role="alert">{error}</div>}
              <Button type="submit" className="h-11 w-full font-semibold" disabled={isLoading}>
                {isLoading ? <span className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> جاري الدخول...</span> : "دخول"}
              </Button>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
