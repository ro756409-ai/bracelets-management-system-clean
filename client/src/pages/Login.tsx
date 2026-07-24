import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { BrandMark } from "@/components/BrandMark";
import { Eye, EyeOff, Lock, User } from "lucide-react";

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
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{
        background: "linear-gradient(135deg, var(--primary-dark) 0%, #180C38 40%, var(--primary-dark) 100%)",
      }}
    >
      <div className="relative w-full max-w-sm">
        <Card className="border-0 shadow-2xl bg-card/95 backdrop-blur">
          <CardHeader className="pb-4 pt-8 text-center">
            <div className="flex justify-center mb-4">
              <BrandMark className="w-20 h-20 rounded-2xl shadow-lg" />
            </div>
            <h1 className="text-xl font-bold text-foreground">متجرك</h1>
            <p className="text-sm text-muted-foreground mt-1">تسجيل دخول لوحة الإدارة</p>
          </CardHeader>

          <CardContent className="pb-8 px-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <Label className="text-sm font-medium">اسم المستخدم أو البريد الإلكتروني</Label>
                <div className="relative mt-1.5">
                  <User className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="أدخل اسم المستخدم أو البريد الإلكتروني"
                    className="pr-10 text-right"
                    autoComplete="username"
                    dir="ltr"
                  />
                </div>
              </div>

              <div>
                <Label className="text-sm font-medium">كلمة المرور</Label>
                <div className="relative mt-1.5">
                  <Lock className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="أدخل كلمة المرور"
                    className="pr-10 pl-10 text-right"
                    autoComplete="current-password"
                    dir="ltr"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-sm text-destructive text-center">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                className="w-full h-11 text-base font-semibold mt-2"
                disabled={isLoading}
              >
                {isLoading ? (
                  <span className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    جاري تسجيل الدخول...
                  </span>
                ) : (
                  "تسجيل الدخول"
                )}
              </Button>
            </form>

            <div className="mt-6 text-center">
              <p className="text-xs text-muted-foreground">
                موظف؟{" "}
                <a
                  href="/employee-login"
                  className="text-primary hover:underline font-medium"
                >
                  دخول الموظفين
                </a>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
