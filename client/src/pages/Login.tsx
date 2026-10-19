import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BrandLogo } from "@/components/BrandLogo";
import { Eye, EyeOff, Lock, User, Loader2, Mail, MessageCircle, LayoutList, Boxes, Truck, BarChart3, UsersRound } from "lucide-react";
import { activeBrand } from "@/lib/brandFlag";
import { useDocumentLang, useI18n } from "@/i18n";
import { LanguageToggle } from "@/components/public/LanguageToggle";
import { SUPPORT } from "@/config/support";

/**
 * تسجيل دخول لوحة الإدارة — نفس /api/auth/login ونفس التحقق وإعادة التحميل الكاملة بعد النجاح.
 * المرحلة 7H (عرض فقط): `<main>` واحد، حقول معنونة 44px، زر إظهار كلمة المرور 44px، الخطأ role=alert،
 * وبلا ألوان خام (التدرّج من tokens الهوية).
 *
 * v2: تخطيط مقسوم (لوحة الهوية + النموذج)، عربي/إنجليزي، «افتكرني» (rememberMe=false ⇒ كوكي جلسة تنتهي بقفل المتصفح؛
 * الافتراضي true = نفس السلوك الحالي)، «نسيت كلمة المرور» كشرح صادق (مفيش استرجاع تلقائي)، وروابط الدعم لو متضبطة.
 * مفيش دخول بجوجل — مفيش OAuth في النظام، فمش هنعرض زر مزيف. v1: نفس الشكل الحالي بالظبط.
 */
export default function Login() {
  const v2 = activeBrand() === "v2";
  useDocumentLang();
  const { lang, dir, t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [showForgot, setShowForgot] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError(t("login.error.required"));
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username: username.trim(), password, rememberMe }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        // رسائل السيرفر عربي — في الإنجليزي رسالة عامة (من غير ما نكشف أي تفاصيل زيادة).
        setError(lang === "ar" ? data.error || t("login.error.generic") : t("login.error.generic"));
        return;
      }

      // Full reload so the tRPC context re-reads the new session cookie.
      window.location.href = "/dashboard";
    } catch {
      setError(t("login.error.network"));
    } finally {
      setIsLoading(false);
    }
  };

  const iconSide = dir === "rtl" ? "right-3" : "left-3";
  const fields = (
    <>
      <div>
        <Label htmlFor="login-username" className="text-sm font-medium">{t("login.username")}</Label>
        <div className="relative mt-1.5">
          <User className={`pointer-events-none absolute ${iconSide} top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground`} aria-hidden="true" />
          <Input
            id="login-username"
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder={t("login.username.placeholder")}
            className={`min-h-11 ${dir === "rtl" ? "pr-10 text-right" : "pl-10 text-left"}`}
            autoComplete="username"
            dir="ltr"
          />
        </div>
      </div>

      <div>
        <Label htmlFor="login-password" className="text-sm font-medium">{t("login.password")}</Label>
        <div className="relative mt-1.5">
          <Lock className={`pointer-events-none absolute ${iconSide} top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground`} aria-hidden="true" />
          <Input
            id="login-password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder={t("login.password.placeholder")}
            className={`min-h-11 ${dir === "rtl" ? "pl-12 pr-10 text-right" : "pr-12 pl-10 text-left"}`}
            autoComplete="current-password"
            dir="ltr"
          />
          <button
            type="button"
            onClick={() => setShowPassword(!showPassword)}
            className={`absolute ${dir === "rtl" ? "left-0" : "right-0"} top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center text-muted-foreground transition-colors duration-[var(--duration-fast)] hover:text-foreground`}
            aria-label={showPassword ? t("login.password.hide") : t("login.password.show")}
            aria-pressed={showPassword}
          >
            {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </div>
    </>
  );

  const errorBox = error && (
    <div className="rounded-[var(--radius-brand-md)] border border-destructive/20 bg-destructive/10 p-3 text-center text-sm text-destructive" role="alert">
      {error}
    </div>
  );

  const submit = (
    <Button type="submit" className="mt-2 h-11 w-full text-base font-semibold" disabled={isLoading}>
      {isLoading ? (
        <span className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t("login.loading")}
        </span>
      ) : (
        t("login.submit")
      )}
    </Button>
  );

  // <main> واحد للصفحة؛ خصائصه وتخطيطه حسب الهوية (v1 = نفس الكارت الحالي بالظبط، v2 = مقسوم).
  const mainProps = v2
    ? { lang, dir, className: "grid min-h-screen bg-background lg:grid-cols-2", "data-layout": "split" }
    : { dir: "rtl" as const, className: "flex min-h-screen items-center justify-center p-4", style: { background: "linear-gradient(135deg, var(--brand-surface) 0%, var(--brand-surface-strong) 100%)" } };

  const v1Card = (
        <div className="relative w-full max-w-sm">
          <div className="rounded-[var(--radius-brand-lg,var(--radius-brand-md))] border-0 bg-card/95 shadow-[var(--shadow-card)] backdrop-blur outline outline-[var(--auth-card-border)] -outline-offset-1">
            <div className="px-6 pb-4 pt-8 text-center">
              <div className="mb-4 flex justify-center">
                <BrandLogo variant="vertical" size="xl" showEnglishName />
              </div>
              <h1 className="text-sm text-muted-foreground">{t("login.subtitle")}</h1>
            </div>

            <div className="px-6 pb-8">
              <form onSubmit={handleLogin} className="space-y-4" noValidate>
                {fields}
                {errorBox}
                {submit}
              </form>

              <div className="mt-6 space-y-2 text-center">
                <p className="text-xs text-muted-foreground">
                  {t("login.newMerchant")}{" "}
                  <a href="/signup" className="inline-flex min-h-11 items-center font-medium text-primary hover:underline md:min-h-0">{t("login.signup")}</a>
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("login.employee")}{" "}
                  <a href="/employee-login" className="inline-flex min-h-11 items-center font-medium text-primary hover:underline md:min-h-0">{t("login.employee.link")}</a>
                </p>
              </div>
            </div>
          </div>
        </div>
  );

  // v2: النموذج أولًا (يمين في العربي، وأول حاجة على الموبايل)، ولوحة الهوية Oxblood جنبه على الشاشات الكبيرة بس.
  const v2Split = (
    <>
      <div className="flex flex-col bg-background px-4 py-6 sm:px-8 lg:px-12">
        <div className="flex items-center justify-between gap-3">
          <a href="/" className="rounded-md lg:invisible" aria-label={t("brand.name")}><BrandLogo variant="horizontal" size="md" /></a>
          <LanguageToggle />
        </div>
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-10">
          <div className="rounded-[var(--radius-brand-xl,1.5rem)] border border-border bg-card p-6 shadow-[var(--shadow-card)] sm:p-8">
          <h1 className="text-center text-2xl font-bold text-foreground sm:text-[1.75rem]">{t("login.welcome")}</h1>
          <p className="mt-2 text-center text-sm text-muted-foreground">{t("login.welcome.sub")}</p>

          <form onSubmit={handleLogin} className="mt-8 space-y-5" noValidate>
            {fields}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm text-foreground">
                <input type="checkbox" checked={rememberMe} onChange={e => setRememberMe(e.target.checked)} className="h-4 w-4 accent-[var(--primary)]" aria-describedby="login-remember-hint" data-testid="login-remember" />
                {t("login.remember")}
              </label>
              <button type="button" onClick={() => setShowForgot(v => !v)} aria-expanded={showForgot} aria-controls="login-forgot-help" className="inline-flex min-h-11 items-center text-sm font-medium text-primary hover:underline" data-testid="login-forgot">
                {t("login.forgot")}
              </button>
            </div>
            <p id="login-remember-hint" className="-mt-2 text-xs text-muted-foreground">{t("login.remember.hint")}</p>
            {showForgot && (
              <div id="login-forgot-help" className="rounded-[var(--radius-brand-md)] border border-border bg-muted p-3 text-sm text-foreground" role="note" data-testid="login-forgot-help">
                {t("login.forgot.help")}
                {(SUPPORT.whatsappUrl || SUPPORT.email) && (
                  <span className="mt-2 flex flex-wrap gap-3">
                    {SUPPORT.whatsappUrl && <a href={SUPPORT.whatsappUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1 font-medium text-primary hover:underline"><MessageCircle className="h-4 w-4" aria-hidden="true" />{t("support.whatsapp")}</a>}
                    {SUPPORT.email && <a href={`mailto:${SUPPORT.email}`} className="inline-flex min-h-11 items-center gap-1 font-medium text-primary hover:underline"><Mail className="h-4 w-4" aria-hidden="true" />{t("support.email")}</a>}
                  </span>
                )}
              </div>
            )}
            {errorBox}
            {submit}
          </form>

          <div className="mt-8 space-y-1 border-t border-border pt-6 text-sm text-muted-foreground">
            <p>
              {t("login.newMerchant")}{" "}
              <a href="/signup" className="inline-flex min-h-11 items-center font-semibold text-primary hover:underline">{t("cta.signup")}</a>
            </p>
            <p>
              {t("login.employee")}{" "}
              <a href="/employee-login" className="inline-flex min-h-11 items-center font-medium text-primary hover:underline">{t("login.employee.link")}</a>
            </p>
            {(SUPPORT.whatsappUrl || SUPPORT.email) && (
              <p className="flex flex-wrap items-center gap-x-3">
                {t("support.title")}:
                {SUPPORT.whatsappUrl && <a href={SUPPORT.whatsappUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center font-medium text-primary hover:underline" data-testid="login-support-whatsapp">{t("support.whatsapp")}</a>}
                {SUPPORT.email && <a href={`mailto:${SUPPORT.email}`} className="inline-flex min-h-11 items-center font-medium text-primary hover:underline" data-testid="login-support-email">{t("support.email")}</a>}
              </p>
            )}
          </div>
          </div>
        </div>
      </div>

      <aside className="relative hidden flex-col items-center justify-center overflow-hidden px-12 py-16 text-center text-[var(--brand-on-surface)] lg:flex" style={{ backgroundImage: "var(--gradient-brand)" }} aria-label={t("login.side.title")}>
        <span className="pointer-events-none absolute -end-24 -top-24 h-72 w-72 rounded-full bg-white/5" aria-hidden="true" />
        <span className="pointer-events-none absolute -bottom-32 -start-20 h-80 w-80 rounded-full bg-white/5" aria-hidden="true" />
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-white text-3xl font-extrabold text-primary shadow-lg" aria-hidden="true">M</span>
        <p className="mt-4 text-3xl font-extrabold">{t("brand.name")}</p>
        <p className="mt-2 text-lg opacity-90">{t("login.side.tagline")}</p>
        <ul className="mt-10 w-full max-w-xs space-y-4 text-start text-base">
          {([["login.side.point1", LayoutList], ["login.side.point2", Boxes], ["login.side.point3", Truck], ["login.side.point4", BarChart3], ["login.side.point5", UsersRound]] as const).map(([k, Icon]) => (
            <li key={k} className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)] border border-white/25 bg-white/10" aria-hidden="true"><Icon className="h-4 w-4" /></span>
              {t(k)}
            </li>
          ))}
        </ul>
        <p className="absolute bottom-6 text-sm opacity-75">{t("footer.rights", { year: new Date().getFullYear() })}</p>
      </aside>
    </>
  );

  return <main {...mainProps} data-testid="login-page">{v2 ? v2Split : v1Card}</main>;
}
