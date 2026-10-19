import { useI18n } from "@/i18n";
import type { MessageKey } from "@/i18n/messages";

/**
 * مساحة عرض النظام في الـHero (لابتوب + موبايل) — **رسم HTML مصغّر** لشكل لوحة التحكم وقائمة الطلبات، مش لقطة شاشة.
 * كل الأرقام هنا **بيانات توضيحية ثابتة** ومكتوب تحتها كده صراحةً (مش إحصائيات حقيقية ولا عدد عملاء).
 * زخرفي لقارئ الشاشة (role=img + وصف واحد)، وأرقام غربية دايمًا.
 */
const DEMO_STATS: Array<{ key: MessageKey; value: string; tone: string }> = [
  { key: "demo.delivered", value: "136", tone: "bg-[var(--success)]/12 text-[var(--success)]" },
  { key: "demo.shipped", value: "32", tone: "bg-[var(--info)]/12 text-[var(--info)]" },
  { key: "demo.preparing", value: "48", tone: "bg-[var(--warning)]/15 text-[var(--warning-foreground,#8a5a00)]" },
  { key: "demo.new", value: "28", tone: "bg-primary/10 text-primary" },
];
const DEMO_ORDERS: Array<{ id: string; amount: string; status: MessageKey; tone: string }> = [
  { id: "#1024", amount: "320", status: "demo.new", tone: "bg-primary/10 text-primary" },
  { id: "#1023", amount: "450", status: "demo.preparing", tone: "bg-[var(--warning)]/15 text-[var(--warning-foreground,#8a5a00)]" },
  { id: "#1022", amount: "280", status: "demo.shipped", tone: "bg-[var(--info)]/12 text-[var(--info)]" },
  { id: "#1021", amount: "620", status: "demo.delivered", tone: "bg-[var(--success)]/12 text-[var(--success)]" },
];
const CHART = [18, 26, 22, 34, 30, 42, 38, 52, 47, 60];

function MiniChart() {
  const w = 220, h = 70, max = 64;
  const pts = CHART.map((v, i) => [(i / (CHART.length - 1)) * w, h - (v / max) * h] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="mj-showcase-area" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${line} ${w},${h}`} fill="url(#mj-showcase-area)" />
      <polyline points={line} fill="none" stroke="var(--primary)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function ProductShowcase() {
  const { t } = useI18n();
  return (
    <figure className="relative mx-auto w-full max-w-[640px] select-none" data-testid="product-showcase">
      <div role="img" aria-label={t("showcase.demoAria")} className="relative pb-6 sm:pb-10">
        {/* اللابتوب */}
        <div className="relative rounded-t-[18px] border border-[#2c2930] bg-[#1f1d22] p-2 shadow-[0_30px_60px_-30px_rgba(46,17,24,0.55)] sm:p-3">
          <div className="flex h-[230px] overflow-hidden rounded-[10px] bg-background sm:h-[320px]" dir="rtl">
            <div className="hidden w-[22%] shrink-0 flex-col gap-1.5 border-s border-border bg-card p-2.5 sm:flex">
              <div className="mb-2 flex items-center gap-1.5">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">M</span>
                <span className="text-[10px] font-bold text-foreground">{t("brand.name")}</span>
              </div>
              {(["demo.nav.home", "demo.nav.orders", "demo.nav.bosta", "demo.nav.inventory", "demo.nav.reports"] as const).map((k, i) => (
                <span key={k} className={`rounded-md px-2 py-1 text-[9px] ${i === 0 ? "bg-accent font-bold text-accent-foreground" : "text-muted-foreground"}`}>{t(k)}</span>
              ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2 p-2.5 sm:gap-3 sm:p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-foreground sm:text-xs">{t("demo.welcome")}</span>
                <span className="h-4 w-20 rounded-full bg-muted" />
              </div>
              <div className="grid grid-cols-4 gap-1.5 sm:gap-2">
                {DEMO_STATS.map(s => (
                  <div key={s.key} className="rounded-lg border border-border bg-card p-1.5 sm:p-2">
                    <span className={`mb-1 inline-block h-3.5 w-3.5 rounded ${s.tone}`} />
                    <div dir="ltr" className="text-end font-en text-[12px] font-extrabold tabular-nums text-foreground sm:text-sm">{s.value}</div>
                    <div className="truncate text-[8px] text-muted-foreground sm:text-[9px]">{t(s.key)}</div>
                  </div>
                ))}
              </div>
              <div className="grid min-h-0 flex-1 grid-cols-5 gap-2">
                <div className="col-span-3 flex min-h-0 flex-col rounded-lg border border-border bg-card p-2">
                  <span className="text-[9px] text-muted-foreground">{t("demo.sales")}</span>
                  <span dir="ltr" className="text-end font-en text-sm font-extrabold tabular-nums text-foreground">12,450</span>
                  <div className="mt-1 min-h-0 flex-1"><MiniChart /></div>
                </div>
                <div className="col-span-2 flex min-h-0 flex-col gap-1 rounded-lg border border-border bg-card p-2">
                  <span className="text-[9px] font-bold text-foreground">{t("demo.recent")}</span>
                  {DEMO_ORDERS.map(o => (
                    <div key={o.id} className="flex items-center justify-between gap-1 border-t border-border/70 pt-1">
                      <span dir="ltr" className="font-en text-[9px] font-bold tabular-nums">{o.id}</span>
                      <span className={`truncate rounded-full px-1.5 text-[8px] font-bold ${o.tone}`}>{t(o.status)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="-mx-[4%] h-3 rounded-b-[14px] bg-gradient-to-b from-[#d9d5d6] to-[#bdb7b9]" />

        {/* الموبايل */}
        <div className="absolute -bottom-2 end-[-4px] w-[30%] max-w-[150px] rounded-[22px] border-[5px] border-[#1f1d22] bg-background p-1.5 shadow-[0_20px_40px_-20px_rgba(46,17,24,0.6)] sm:end-[-16px]" dir="rtl">
          <div className="mx-auto mb-1.5 h-1 w-8 rounded-full bg-[#1f1d22]/80" />
          <div className="mb-1.5 flex items-center justify-between px-1">
            <span className="text-[9px] font-bold text-foreground">{t("demo.nav.orders")}</span>
            <span dir="ltr" className="font-en text-[9px] font-extrabold tabular-nums text-primary">156</span>
          </div>
          <div className="space-y-1">
            {DEMO_ORDERS.map(o => (
              <div key={o.id} className="rounded-lg border border-border bg-card px-1.5 py-1">
                <div className="flex items-center justify-between">
                  <span dir="ltr" className="font-en text-[8px] font-bold tabular-nums">{o.id}</span>
                  <span dir="ltr" className="font-en text-[8px] tabular-nums text-muted-foreground">{o.amount}</span>
                </div>
                <span className={`mt-0.5 inline-block rounded-full px-1 text-[7px] font-bold ${o.tone}`}>{t(o.status)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      <figcaption className="mt-3 text-center text-xs text-muted-foreground" data-testid="showcase-demo-note">{t("showcase.demoNote")}</figcaption>
    </figure>
  );
}
