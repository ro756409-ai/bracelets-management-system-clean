import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandLogo } from "@/components/BrandLogo";
import { Eye, EyeOff, CheckCircle2, Loader2 } from "lucide-react";
import { activeBrand } from "@/lib/brandFlag";
import { useDocumentLang, useI18n } from "@/i18n";
import { LanguageToggle } from "@/components/public/LanguageToggle";

/**
 * صفحة إنشاء حساب تاجر جديد (عام). بتبعت طلب pending لـ/api/signup — الحساب مايتفعّلش إلا
 * بعد موافقة إدارة المنصة. مفيش businessId/tenantId من العميل إطلاقًا.
 * المرحلة 7H (عرض فقط): `<main>` واحد، حقول معنونة 44px، حالة «قيد المراجعة» واضحة بعد الإرسال،
 * الخطأ role=alert، وبلا ألوان خام. نفس التحقق ونفس الـpayload.
 * v2: عربي/إنجليزي (RTL/LTR) + سطر «مجاني وبدون كارت». v1: نفس النصوص والشكل بالظبط.
 */
export default function Register() {
  const v2 = activeBrand() === "v2";
  useDocumentLang();
  const { lang, dir, t } = useI18n();
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
      setError(t("reg.error.required"));
      return;
    }
    if (form.password.length < 12) {
      setError(t("reg.error.length"));
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError(t("reg.error.mismatch"));
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
        setError(lang === "ar" ? data.error || t("reg.error.generic") : t("reg.error.generic"));
        return;
      }
      setDone(true);
    } catch {
      setError(t("reg.error.network"));
    } finally {
      setIsLoading(false);
    }
  };

  const field = "mt-1.5 min-h-11";

  return (
    <main
      dir={dir}
      lang={lang}
      // v2: خلفية الصفحة الثابتة (#FAF9F7) زي باقي الواجهة، والكارت أبيض بحد؛ v1: نفس التدرّج الحالي.
      className={v2 ? "flex min-h-screen items-center justify-center bg-background p-4 py-10" : "flex min-h-screen items-center justify-center p-4"}
      style={v2 ? undefined : { background: "linear-gradient(135deg, var(--brand-surface) 0%, var(--brand-surface-strong) 100%)" }}
      data-testid="register-page"
    >
      <div className="relative w-full max-w-md">
        {v2 && <div className="mb-3 flex justify-end"><LanguageToggle /></div>}
        <div className={v2 ? "rounded-[var(--radius-brand-xl,1.5rem)] border border-border bg-card shadow-[var(--shadow-card)]" : "rounded-[var(--radius-brand-lg,var(--radius-brand-md))] border-0 bg-card/95 shadow-[var(--shadow-card)] backdrop-blur outline outline-[var(--auth-card-border)] -outline-offset-1"}>
          <div className="px-6 pb-4 pt-8 text-center">
            <div className="mb-4 flex justify-center">
              <BrandLogo variant="vertical" size="xl" showEnglishName />
            </div>
            <h1 className="text-sm text-muted-foreground">{t("reg.title")}</h1>
            {v2 && <p className="mt-1 text-xs text-muted-foreground" data-testid="register-free-note">{t("reg.note")}</p>}
          </div>

          <div className="px-6 pb-8">
            {done ? (
              <div className="flex flex-col items-center gap-3 py-6 text-center" role="status" data-testid="register-pending">
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[var(--success)]/10 text-[var(--success)]" aria-hidden="true"><CheckCircle2 className="h-8 w-8" /></span>
                <h2 className="text-lg font-semibold text-foreground">{t("reg.done.title")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t("reg.done.body")}
                </p>
                <a href="/login" className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline">{t("reg.done.back")}</a>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-3" noValidate>
                <div>
                  <Label htmlFor="reg-owner" className="text-sm font-medium">{t("reg.owner")}</Label>
                  <Input id="reg-owner" value={form.ownerName} onChange={set("ownerName")} placeholder={t("reg.owner.placeholder")} className={`${field} ${dir === "rtl" ? "text-right" : "text-left"}`} autoComplete="name" />
                </div>
                <div>
                  <Label htmlFor="reg-business" className="text-sm font-medium">{t("reg.business")}</Label>
                  <Input id="reg-business" value={form.businessName} onChange={set("businessName")} placeholder={t("reg.business.placeholder")} className={`${field} ${dir === "rtl" ? "text-right" : "text-left"}`} autoComplete="organization" />
                </div>
                <div>
                  <Label htmlFor="reg-phone" className="text-sm font-medium">{t("reg.phone")}</Label>
                  <Input id="reg-phone" value={form.phone} onChange={set("phone")} placeholder="01xxxxxxxxx" className={field} dir="ltr" autoComplete="tel" inputMode="tel" />
                </div>
                <div>
                  <Label htmlFor="reg-email" className="text-sm font-medium">{t("reg.email")}</Label>
                  <Input id="reg-email" type="email" value={form.email} onChange={set("email")} placeholder="you@example.com" className={field} dir="ltr" autoComplete="email" inputMode="email" />
                </div>
                <div>
                  <Label htmlFor="reg-username" className="text-sm font-medium">{t("reg.username")}</Label>
                  <Input id="reg-username" value={form.username} onChange={set("username")} placeholder="username" className={field} dir="ltr" autoComplete="username" />
                </div>
                <div>
                  <Label htmlFor="reg-password" className="text-sm font-medium">{t("reg.password")}</Label>
                  <div className="relative">
                    <Input
                      id="reg-password"
                      type={showPassword ? "text" : "password"}
                      value={form.password}
                      onChange={set("password")}
                      placeholder={t("reg.password.placeholder")}
                      className={`${field} ${dir === "rtl" ? "pl-12 text-right" : "pr-12 text-left"}`}
                      dir="ltr"
                      autoComplete="new-password"
                    />
                    <button type="button" onClick={() => setShowPassword(v => !v)}
                      className={`absolute ${dir === "rtl" ? "left-0" : "right-0"} top-[calc(50%+0.1875rem)] flex h-11 w-11 -translate-y-1/2 items-center justify-center text-muted-foreground hover:text-foreground`}
                      aria-label={showPassword ? t("login.password.hide") : t("login.password.show")} aria-pressed={showPassword}>
                      {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                    </button>
                  </div>
                </div>
                <div>
                  <Label htmlFor="reg-confirm" className="text-sm font-medium">{t("reg.confirm")}</Label>
                  <Input id="reg-confirm" type={showPassword ? "text" : "password"} value={form.confirmPassword} onChange={set("confirmPassword")} placeholder={t("reg.confirm.placeholder")} className={`${field} ${dir === "rtl" ? "text-right" : "text-left"}`} dir="ltr" autoComplete="new-password" />
                </div>

                {error && (
                  <div className="rounded-[var(--radius-brand-md)] border border-destructive/20 bg-destructive/10 p-3 text-center text-sm text-destructive" role="alert">
                    {error}
                  </div>
                )}

                <Button type="submit" className="mt-2 h-11 w-full text-base font-semibold" disabled={isLoading}>
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      {t("reg.loading")}
                    </span>
                  ) : t("reg.submit")}
                </Button>
              </form>
            )}

            {!done && (
              <div className="mt-6 text-center">
                <p className="text-xs text-muted-foreground">
                  {t("reg.haveAccount")}{" "}
                  <a href="/login" className="inline-flex min-h-11 items-center font-medium text-primary hover:underline md:min-h-0">{t("reg.login")}</a>
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
