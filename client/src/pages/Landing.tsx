import { ArrowLeft, ArrowRight, Boxes, ClipboardList, KeyRound, LayoutList, Lock, Printer, ScrollText, ShieldCheck, Truck, UsersRound, BarChart3, Mail, MessageCircle, Check, PlayCircle } from "lucide-react";
import { BrandLogo } from "@/components/BrandLogo";
import { PartnerLogo } from "@/components/brand/PartnerLogo";
import { LanguageToggle } from "@/components/public/LanguageToggle";
import { VideoSlot } from "@/components/public/VideoSlot";
import { PricingCards } from "@/components/public/PricingCards";
import { ProductShowcase } from "@/components/public/ProductShowcase";
import { useDocumentLang, useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";
import { LANDING_VIDEOS, validYoutubeId } from "@/config/landingVideos";
import { SUPPORT } from "@/config/support";

/**
 * الصفحة الرئيسية العامة (هوية v2) — header، hero (عنوان + CTA + رسم توضيحي للنظام ببيانات تجريبية)، شريط المميزات، المميزات،
 * Easy Order/بوسطة، جولة الفيديو، الأسعار (من shared/billing)، الأمان، الأسئلة، CTA، footer.
 * خلفية واحدة ثابتة للصفحة كلها (--background = #FAF9F7) — مفيش أشرطة بألوان مختلفة؛ الفصل بخطوط حدود، والكروت بيضا.
 * محتوى حقيقي بس: مفيش آراء عملاء ولا أعداد مستخدمين ولا شعارات شركاء مش موثّقة. عربي/إنجليزي مع RTL/LTR. شبكة 8px.
 */
type FeatureKey = "orders" | "team" | "inventory" | "shipping" | "print" | "reports";
const FEATURES: Array<{ icon: typeof LayoutList; key: FeatureKey }> = [
  { icon: LayoutList, key: "orders" }, { icon: UsersRound, key: "team" }, { icon: Boxes, key: "inventory" },
  { icon: Truck, key: "shipping" }, { icon: Printer, key: "print" }, { icon: BarChart3, key: "reports" },
];
const SECURITY: Array<{ icon: typeof Lock; key: "isolation" | "permissions" | "audit" | "secrets" | "cards" }> = [
  { icon: ShieldCheck, key: "isolation" }, { icon: KeyRound, key: "permissions" }, { icon: ScrollText, key: "audit" },
  { icon: Lock, key: "secrets" }, { icon: ClipboardList, key: "cards" },
];
const FAQ = [1, 2, 3, 4, 5, 6] as const;

const SECTION = "mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8";
const H2 = "text-2xl font-bold leading-tight text-foreground sm:text-[2rem]";
const EYEBROW = "text-sm font-semibold text-primary";
const FOCUS = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";
const BTN_PRIMARY = `inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius-brand-md)] bg-primary px-6 text-base font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-[var(--primary-dark,var(--primary))] ${FOCUS}`;
const BTN_OUTLINE = `inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius-brand-md)] border border-border bg-card px-6 text-base font-semibold text-foreground transition-colors hover:bg-muted ${FOCUS}`;

export default function Landing() {
  useDocumentLang();
  const { lang, dir, t } = useI18n();
  const Arrow = dir === "rtl" ? ArrowLeft : ArrowRight;
  const year = new Date().getFullYear();
  const hasTour = LANDING_VIDEOS.some(v => validYoutubeId(v.youtubeId));
  const signup = (extra = "", label: string = t("cta.signup")) => (
    <a href="/signup" className={`${BTN_PRIMARY} ${extra}`} data-testid="cta-signup">
      {label} <Arrow className="h-4 w-4" aria-hidden="true" />
    </a>
  );

  return (
    <div lang={lang} dir={dir} className="min-h-screen bg-background text-foreground" data-testid="landing-page">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2">{t("nav.skip")}</a>

      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur-md">
        <nav className={`${SECTION} flex h-16 items-center justify-between gap-4 sm:h-[72px]`} aria-label={t("brand.name")}>
          <a href="/" className={`flex shrink-0 items-center rounded-md ${FOCUS}`} aria-label={t("brand.name")}><BrandLogo variant="horizontal" size="md" /></a>
          <ul className="hidden items-center gap-8 text-sm font-medium text-muted-foreground lg:flex">
            {(["features", "pricing", "security", "faq"] as const).map(k => (
              <li key={k}><a href={`#${k}`} className="transition-colors hover:text-foreground">{t(`nav.${k}` as MessageKey)}</a></li>
            ))}
          </ul>
          <div className="flex items-center gap-2">
            <LanguageToggle />
            <a href="/login" className={`hidden min-h-11 items-center rounded-[var(--radius-brand-md)] border border-primary/30 px-4 text-sm font-semibold text-primary transition-colors hover:bg-accent sm:inline-flex ${FOCUS}`} data-testid="nav-login">{t("nav.login")}</a>
            <a href="/signup" className={`hidden min-h-11 items-center rounded-[var(--radius-brand-md)] bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-[var(--primary-dark,var(--primary))] md:inline-flex ${FOCUS}`}>{t("header.signup")}</a>
            <a href="/login" className={`inline-flex min-h-11 items-center px-2 text-sm font-semibold text-primary sm:hidden ${FOCUS}`}>{t("nav.login")}</a>
          </div>
        </nav>
      </header>

      <main id="main">
        <section className="relative overflow-hidden" aria-labelledby="hero-title">
                    <div className={`${SECTION} relative grid items-center gap-12 py-12 md:py-16 lg:grid-cols-[1fr_1.1fr] lg:gap-16 lg:py-24`}>
            <div>
              <p className="mb-4 inline-flex rounded-full border border-primary/20 bg-accent px-3 py-1 text-xs font-semibold text-accent-foreground">{t("hero.eyebrow")}</p>
              <h1 id="hero-title" className="text-[2.25rem] font-extrabold leading-[1.2] tracking-tight text-foreground sm:text-5xl lg:text-[3.5rem]">
                {t("hero.title")} <span className="block text-primary">{t("hero.titleAccent")}</span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-8 text-muted-foreground sm:text-lg">{t("hero.subtitle")}</p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
                {signup()}
                {hasTour
                  ? <a href="#tour" className={BTN_OUTLINE}><PlayCircle className="h-5 w-5" aria-hidden="true" />{t("hero.watch")}</a>
                  : <a href="#pricing" className={BTN_OUTLINE}>{t("hero.secondary")}</a>}
              </div>
              <p className="mt-4 text-sm text-muted-foreground">{t("cta.signup.note")}</p>
            </div>
            <ProductShowcase />
          </div>
        </section>

        <section className={`${SECTION} -mt-2 pb-8`} aria-label={t("nav.features")}>
          <ul className="grid grid-cols-2 gap-3 rounded-[var(--radius-brand-xl,1.5rem)] border border-border bg-card p-4 shadow-[var(--shadow-card)] sm:grid-cols-3 sm:p-6 lg:grid-cols-6">
            {FEATURES.map(f => (
              <li key={f.key} className="flex flex-col items-center gap-2 p-2 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden="true"><f.icon className="h-5 w-5" /></span>
                <span className="text-sm font-semibold text-foreground">{t(`feature.${f.key}.title` as MessageKey)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section id="features" className="scroll-mt-24 py-16 sm:py-20" aria-labelledby="features-title">
          <div className={SECTION}>
            <p className={EYEBROW}>{t("nav.features")}</p>
            <h2 id="features-title" className={`${H2} mt-2`}>{t("features.title")}</h2>
            <p className="mt-3 max-w-2xl text-base text-muted-foreground">{t("features.subtitle")}</p>
            <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(f => (
                <li key={f.key} className="rounded-[var(--radius-brand-lg,1rem)] border border-border bg-card p-6 shadow-[var(--shadow-card)] transition-shadow hover:shadow-[0_12px_32px_-20px_rgba(37,35,41,0.35)]">
                  <span className="flex h-11 w-11 items-center justify-center rounded-[var(--radius-brand-md)] bg-accent text-accent-foreground" aria-hidden="true"><f.icon className="h-5 w-5" /></span>
                  <h3 className="mt-4 text-lg font-bold">{t(`feature.${f.key}.title` as MessageKey)}</h3>
                  <p className="mt-2 text-sm leading-7 text-muted-foreground">{t(`feature.${f.key}.desc` as MessageKey)}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="border-y border-border/70 py-16 sm:py-20" aria-labelledby="integrations-title">
          <div className={SECTION}>
            <h2 id="integrations-title" className={H2}>{t("integrations.title")}</h2>
            <div className="mt-10 grid gap-6 md:grid-cols-2">
              {(["easyorder", "bosta"] as const).map(k => (
                <article key={k} className="flex gap-4 rounded-[var(--radius-brand-lg,1rem)] border border-border bg-card p-6 shadow-[var(--shadow-card)]">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)] border border-border bg-background">
                    <PartnerLogo partner={k === "easyorder" ? "easyorders" : "bosta"} size="md" decorative />
                  </span>
                  <div>
                    <h3 className="text-lg font-bold">{t(`integrations.${k}.title` as MessageKey)}</h3>
                    <p className="mt-2 text-sm leading-7 text-muted-foreground">{t(`integrations.${k}.desc` as MessageKey)}</p>
                  </div>
                </article>
              ))}
            </div>
            <p className="mt-6 text-sm text-muted-foreground">{t("integrations.note")}</p>
          </div>
        </section>

        <section id="tour" className={`${SECTION} scroll-mt-24 py-16 sm:py-20`} aria-labelledby="showcase-title">
          <h2 id="showcase-title" className={H2}>{t("showcase.title")}</h2>
          <p className="mt-3 text-base text-muted-foreground">{t("showcase.subtitle")}</p>
          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {LANDING_VIDEOS.map(v => <VideoSlot key={v.slot} video={v} className={v.slot === "hero" ? "md:col-span-2" : ""} />)}
          </div>
        </section>

        <section id="pricing" className="scroll-mt-24 border-y border-border/70 py-16 sm:py-20" aria-labelledby="pricing-title">
          <div className={SECTION}>
            <div className="mx-auto max-w-2xl text-center">
              <p className={EYEBROW}>{t("nav.pricing")}</p>
              <h2 id="pricing-title" className={`${H2} mt-2`}>{t("pricing.title")}</h2>
              <p className="mt-3 text-base text-muted-foreground">{t("pricing.subtitle")}</p>
            </div>
            <div className="mt-14">
              <PricingCards action={code => (
                <a href="/signup" className={`${code === "month_12" ? BTN_PRIMARY : BTN_OUTLINE} w-full`} data-testid={`plan-cta-${code}`}>
                  {t("pricing.choose", { plan: t(`pricing.plan.${code}` as MessageKey) })}
                </a>
              )} />
            </div>
            <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-muted-foreground" data-testid="pricing-note">{t("pricing.note")}</p>
            <ul className="mx-auto mt-6 flex max-w-3xl flex-wrap justify-center gap-x-6 gap-y-2 text-sm text-foreground">
              {([2, 3, 4] as const).map(i => (
                <li key={i} className="flex items-center gap-2"><Check className="h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden="true" />{t(`pricing.included.${i}` as MessageKey)}</li>
              ))}
            </ul>
          </div>
        </section>

        <section id="security" className={`${SECTION} scroll-mt-24 py-16 sm:py-20`} aria-labelledby="security-title">
          <h2 id="security-title" className={H2}>{t("security.title")}</h2>
          <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {SECURITY.map(s => (
              <li key={s.key} className="flex gap-4 rounded-[var(--radius-brand-lg,1rem)] border border-border bg-card p-6">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden="true"><s.icon className="h-5 w-5" /></span>
                <div>
                  <h3 className="text-base font-bold">{t(`security.${s.key}.title` as MessageKey)}</h3>
                  <p className="mt-1 text-sm leading-7 text-muted-foreground">{t(`security.${s.key}.desc` as MessageKey)}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section id="faq" className="scroll-mt-24 border-t border-border/70 py-16 sm:py-20" aria-labelledby="faq-title">
          <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
            <h2 id="faq-title" className={`${H2} text-center`}>{t("faq.title")}</h2>
            <div className="mt-10 divide-y divide-border rounded-[var(--radius-brand-lg,1rem)] border border-border bg-card shadow-[var(--shadow-card)]">
              {FAQ.map(i => (
                <details key={i} className="group px-6 py-4 [&_summary::-webkit-details-marker]:hidden">
                  <summary className={`flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-md text-base font-semibold ${FOCUS}`}>
                    {t(`faq.q${i}` as MessageKey)}
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-lg text-accent-foreground transition-transform group-open:rotate-45" aria-hidden="true">+</span>
                  </summary>
                  <p className="mt-2 pb-2 text-sm leading-7 text-muted-foreground">{t(`faq.a${i}` as MessageKey)}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section className={`${SECTION} py-16 sm:py-20`} aria-labelledby="final-title">
          <div className="relative overflow-hidden rounded-[var(--radius-brand-xl,1.5rem)] px-6 py-14 text-center text-[var(--brand-on-surface)] sm:px-12" style={{ backgroundImage: "var(--gradient-brand)" }}>
            <h2 id="final-title" className="text-2xl font-bold sm:text-[2rem]">{t("final.title")}</h2>
            <p className="mx-auto mt-4 max-w-xl text-base opacity-90">{t("final.subtitle")}</p>
            <a href="/signup" className="mt-8 inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius-brand-md)] bg-card px-6 text-base font-semibold text-primary transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-card focus-visible:ring-offset-2 focus-visible:ring-offset-primary">
              {t("cta.signup")} <Arrow className="h-4 w-4" aria-hidden="true" />
            </a>
            <p className="mt-4 text-sm opacity-80">{t("cta.signup.note")}</p>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/70">
        <div className={`${SECTION} grid gap-10 py-12 sm:grid-cols-2 lg:grid-cols-4`}>
          <div className="lg:col-span-2">
            <BrandLogo variant="horizontal" size="md" />
            <p className="mt-4 max-w-sm text-sm leading-7 text-muted-foreground">{t("footer.tagline")}</p>
          </div>
          <nav aria-label={t("footer.product")}>
            <h2 className="text-sm font-bold text-foreground">{t("footer.product")}</h2>
            <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
              {(["features", "pricing", "security", "faq"] as const).map(k => (
                <li key={k}><a href={`#${k}`} className="inline-flex min-h-11 items-center hover:text-foreground">{t(`nav.${k}` as MessageKey)}</a></li>
              ))}
            </ul>
          </nav>
          <nav aria-label={t("footer.account")}>
            <h2 className="text-sm font-bold text-foreground">{t("footer.account")}</h2>
            <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
              <li><a href="/signup" className="inline-flex min-h-11 items-center hover:text-foreground">{t("cta.signup")}</a></li>
              <li><a href="/login" className="inline-flex min-h-11 items-center hover:text-foreground">{t("nav.login")}</a></li>
              <li><a href="/employee-login" className="inline-flex min-h-11 items-center hover:text-foreground">{t("footer.employee")}</a></li>
              {SUPPORT.whatsappUrl && <li><a href={SUPPORT.whatsappUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center gap-1.5 hover:text-foreground"><MessageCircle className="h-4 w-4" aria-hidden="true" />{t("support.whatsapp")}</a></li>}
              {SUPPORT.email && <li><a href={`mailto:${SUPPORT.email}`} className="inline-flex min-h-11 items-center gap-1.5 hover:text-foreground"><Mail className="h-4 w-4" aria-hidden="true" />{t("support.email")}</a></li>}
            </ul>
          </nav>
        </div>
        <div className="border-t border-border/70">
          <p className={`${SECTION} py-6 text-sm text-muted-foreground`}>{t("footer.rights", { year })}</p>
        </div>
      </footer>
    </div>
  );
}
