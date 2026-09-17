import { Building2, Globe, Zap, Link2, TestTube2 } from "lucide-react";
import { useLocation } from "wouter";

/**
 * رحلة الإعداد المشتركة عبر صفحات الأنشطة/القنوات/Easy Order — تُعرض أعلى كل صفحة عشان
 * المستخدم يفهم الخطوات وترتيبها. الخطوة الحالية مميّزة، وكل خطوة رابط لصفحتها.
 */
export function SetupJourney({ current }: { current: "business" | "channel" | "easyorder" }) {
  const [, setLocation] = useLocation();
  const steps = [
    { key: "business", icon: Building2, label: "أنشئ نشاطًا", hint: "البراند/الفرع التجاري", path: "/businesses" },
    { key: "channel", icon: Globe, label: "أضِف قناة بيع", hint: "متجر أو موقع", path: "/sales-channels" },
    { key: "platform", icon: Link2, label: "اختر المنصة", hint: "EasyOrder، شوبيفاي…", path: "/sales-channels" },
    { key: "connect", icon: Zap, label: "اربط الحساب", hint: "API / Webhook", path: "/webhook-settings" },
    { key: "test", icon: TestTube2, label: "اختبر الاتصال", hint: "تأكد إن الأوردرات بتوصل", path: "/sales-channels" },
  ] as const;
  const activeIdx = steps.findIndex(s => s.key === current);
  return (
    <div className="rounded-[var(--radius-brand-card,0.75rem)] border border-border bg-muted/30 p-3">
      <p className="mb-2 text-xs font-semibold text-muted-foreground">رحلة الإعداد</p>
      <div className="flex flex-wrap items-center gap-2">
        {steps.map((s, i) => {
          const Icon = s.icon;
          const isActive = i === activeIdx || (current === "channel" && s.key === "platform");
          return (
            <div key={s.key} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setLocation(s.path)}
                title={s.hint}
                className={`inline-flex items-center gap-1.5 rounded-[var(--radius-brand-pill,9999px)] border px-2.5 py-1 text-xs font-medium transition-colors ${
                  isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border bg-card text-muted-foreground hover:bg-muted"
                }`}
              >
                <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-current/10 text-[10px] font-bold">{i + 1}</span>
                <Icon className="h-3.5 w-3.5" />
                {s.label}
              </button>
              {i < steps.length - 1 && <span className="text-muted-foreground/50">←</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
