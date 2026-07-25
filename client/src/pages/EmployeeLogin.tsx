import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { BrandLogo } from "@/components/BrandLogo";
import { Eye, EyeOff, Lock, User } from "lucide-react";
import { toast } from "sonner";

export default function EmployeeLogin() {
  const [, setLocation] = useLocation();
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
      toast.success(`أهلاً ${data.employee.name}!`);
      
      // Redirect based on role
      if (data.employee.role === 'manager') {
        setLocation("/dashboard");
      } else if (data.employee.role === 'facebook_entry') {
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
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{
        background: "linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%)",
      }}
    >
      {/* Background pattern */}
      <div
        className="absolute inset-0 opacity-5"
        style={{
          backgroundImage: `repeating-linear-gradient(
            45deg,
            transparent,
            transparent 20px,
            rgba(91,61,245,0.3) 20px,
            rgba(91,61,245,0.3) 21px
          )`,
        }}
      />

      <div className="relative w-full max-w-sm">
        <Card className="border-0 shadow-2xl bg-card/95 backdrop-blur">
          <CardHeader className="pb-4 pt-8 text-center">
            {/* Logo */}
            <div className="flex justify-center mb-4">
              <BrandLogo variant="vertical" size="xl" showEnglishName />
            </div>
            <p className="text-sm text-muted-foreground">تسجيل دخول الموظف</p>
          </CardHeader>

          <CardContent className="pb-8 px-6">
            <form onSubmit={handleLogin} className="space-y-4">
              {/* Username */}
              <div>
                <Label className="text-sm font-medium">اسم المستخدم</Label>
                <div className="relative mt-1.5">
                  <User className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder="أدخل اسم المستخدم"
                    className="pr-10 text-right"
                    autoComplete="username"
                    dir="ltr"
                  />
                </div>
              </div>

              {/* Password */}
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

              {/* Error */}
              {error && (
                <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-sm text-destructive text-center">
                  {error}
                </div>
              )}

              {/* Submit */}
              <Button
                type="submit"
                className="w-full h-11 text-base font-semibold mt-2"
                style={{ background: "linear-gradient(135deg, var(--primary), var(--primary-dark))" }}
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

            {/* Admin link */}
            <div className="mt-6 text-center">
              <p className="text-xs text-muted-foreground">
                أنت مدير؟{" "}
                <a
                  href="/dashboard"
                  className="text-primary hover:underline font-medium"
                >
                  دخول لوحة التحكم
                </a>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
