import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { BrandLogo } from "@/components/BrandLogo";
import { Eye, EyeOff, CheckCircle2 } from "lucide-react";

/**
 * صفحة إنشاء حساب تاجر جديد (عام). بتبعت طلب pending لـ/api/signup — الحساب مايتفعّلش إلا
 * بعد موافقة إدارة المنصة. مفيش businessId/tenantId من العميل إطلاقًا.
 */
export default function Register() {
  const [form, setForm] = useState({
    ownerName: "", businessName: "", phone: "", email: "", username: "", password: "", confirmPassword: "",
  });
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    // تحقق مبدئي في الواجهة (السيرفر هو الحكم النهائي).
    if (!form.ownerName.trim() || !form.businessName.trim() || !form.phone.trim() ||
        !form.email.trim() || !form.username.trim() || !form.password) {
      setError("يرجى تعبئة كل الحقول");
      return;
    }
    if (form.password.length < 12) {
      setError("كلمة المرور يجب ألا تقل عن 12 حرفًا");
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError("كلمتا المرور غير متطابقتين");
      return;
    }

    setIsLoading(true);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerName: form.ownerName.trim(),
          businessName: form.businessName.trim(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          username: form.username.trim(),
          password: form.password,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "تعذّر إنشاء الطلب، حاول مرة أخرى");
        return;
      }
      setDone(true);
    } catch {
      setError("تعذر الاتصال بالخادم، حاول مرة أخرى");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: "linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%)" }}
    >
      <div className="relative w-full max-w-md">
        <Card className="border-0 shadow-2xl bg-card/95 backdrop-blur">
          <CardHeader className="pb-4 pt-8 text-center">
            <div className="flex justify-center mb-4">
              <BrandLogo variant="vertical" size="xl" showEnglishName />
            </div>
            <p className="text-sm text-muted-foreground">إنشاء حساب تاجر جديد</p>
          </CardHeader>

          <CardContent className="pb-8 px-6">
            {done ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center">
                <CheckCircle2 className="h-12 w-12 text-[var(--success)]" />
                <h2 className="text-lg font-semibold text-foreground">تم استلام طلبك</h2>
                <p className="text-sm text-muted-foreground">
                  حسابك قيد المراجعة من إدارة المنصة. هيتم إبلاغك عند التفعيل، وبعدها تقدر تسجّل الدخول.
                </p>
                <a href="/login" className="text-primary hover:underline text-sm font-medium mt-2">العودة لتسجيل الدخول</a>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-3">
                <div>
                  <Label className="text-sm font-medium">اسم صاحب النشاط</Label>
                  <Input value={form.ownerName} onChange={set("ownerName")} placeholder="الاسم الكامل" className="mt-1.5 text-right" autoComplete="name" />
                </div>
                <div>
                  <Label className="text-sm font-medium">اسم النشاط</Label>
                  <Input value={form.businessName} onChange={set("businessName")} placeholder="مثال: متجر النور" className="mt-1.5 text-right" />
                </div>
                <div>
                  <Label className="text-sm font-medium">رقم الهاتف</Label>
                  <Input value={form.phone} onChange={set("phone")} placeholder="01xxxxxxxxx" className="mt-1.5" dir="ltr" autoComplete="tel" inputMode="tel" />
                </div>
                <div>
                  <Label className="text-sm font-medium">البريد الإلكتروني</Label>
                  <Input type="email" value={form.email} onChange={set("email")} placeholder="you@example.com" className="mt-1.5" dir="ltr" autoComplete="email" />
                </div>
                <div>
                  <Label className="text-sm font-medium">اسم المستخدم</Label>
                  <Input value={form.username} onChange={set("username")} placeholder="username" className="mt-1.5" dir="ltr" autoComplete="username" />
                </div>
                <div>
                  <Label className="text-sm font-medium">كلمة المرور</Label>
                  <div className="relative mt-1.5">
                    <Input
                      type={showPassword ? "text" : "password"}
                      value={form.password}
                      onChange={set("password")}
                      placeholder="12 حرفًا على الأقل"
                      className="pl-10 text-right"
                      dir="ltr"
                      autoComplete="new-password"
                    />
                    <button type="button" onClick={() => setShowPassword(v => !v)}
                      className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
                <div>
                  <Label className="text-sm font-medium">تأكيد كلمة المرور</Label>
                  <Input type={showPassword ? "text" : "password"} value={form.confirmPassword} onChange={set("confirmPassword")} placeholder="أعد كتابة كلمة المرور" className="mt-1.5 text-right" dir="ltr" autoComplete="new-password" />
                </div>

                {error && (
                  <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-3 text-sm text-destructive text-center">
                    {error}
                  </div>
                )}

                <Button type="submit" className="w-full h-11 text-base font-semibold mt-2" disabled={isLoading}>
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      جاري الإرسال...
                    </span>
                  ) : "إنشاء الحساب"}
                </Button>
              </form>
            )}

            {!done && (
              <div className="mt-6 text-center">
                <p className="text-xs text-muted-foreground">
                  عندك حساب بالفعل؟{" "}
                  <a href="/login" className="text-primary hover:underline font-medium">تسجيل الدخول</a>
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
