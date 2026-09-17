import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ShieldCheck, Eye, EyeOff } from "lucide-react";

/**
 * دخول Platform Admin — منفصل تمامًا عن دخول العملاء. بيكلّم /api/platform/auth/login
 * (كوكي platform_admin_session المستقلة). مش مرئي/مربوط بأي صفحة عميل.
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
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)" }}>
      <div className="w-full max-w-sm">
        <Card className="border-0 shadow-2xl">
          <CardHeader className="pb-4 pt-8 text-center">
            <div className="flex justify-center mb-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <ShieldCheck className="h-6 w-6" />
              </div>
            </div>
            <h1 className="text-lg font-bold">لوحة إدارة المنصة</h1>
            <p className="text-sm text-muted-foreground mt-1">دخول مسؤول المنصة فقط</p>
          </CardHeader>
          <CardContent className="pb-8 px-6">
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <Label className="text-sm font-medium">اسم المستخدم</Label>
                <Input value={username} onChange={e => setUsername(e.target.value)} className="mt-1.5" dir="ltr" autoComplete="username" />
              </div>
              <div>
                <Label className="text-sm font-medium">كلمة المرور</Label>
                <div className="relative mt-1.5">
                  <Input type={showPassword ? "text" : "password"} value={password} onChange={e => setPassword(e.target.value)} className="pl-10" dir="ltr" autoComplete="current-password" />
                  <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              {error && <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-sm text-destructive text-center">{error}</div>}
              <Button type="submit" className="w-full h-11 font-semibold" disabled={isLoading}>
                {isLoading ? "جاري الدخول..." : "دخول"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
