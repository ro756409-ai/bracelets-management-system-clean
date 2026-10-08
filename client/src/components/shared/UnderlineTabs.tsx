import { useEffect, useRef, type KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * تبويبات بخط سفلي نحاسي (Theme Spec §3) — لتبويبات الحالة فوق الجداول.
 *   • `role="tablist"`/`tab` + `aria-selected`، تركيز واحد في ترتيب Tab والأسهم تتنقل (مع مراعاة RTL:
 *     السهم الأيمن يعود للسابق في RTL)، Home/End للطرفين.
 *   • لا تنكمش (`shrink-0`) والتمرير أفقي داخل المكوّن؛ التبويب النشط يُمرَّر إلى مجال الرؤية.
 *   • العدّاد اختياري: `null`/`undefined` = لا عدّاد (لا نخترع صفرًا).
 */
export type UnderlineTab = { key: string; label: string; count?: number | null; icon?: LucideIcon };

export type UnderlineTabsProps = {
  tabs: UnderlineTab[];
  value: string;
  onChange: (key: string) => void;
  ariaLabel?: string;
  className?: string;
};

export function UnderlineTabs({ tabs, value, onChange, ariaLabel = "تبويبات", className }: UnderlineTabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  useEffect(() => {
    const el = refs.current[value];
    if (!el || typeof el.scrollIntoView !== "function") return;
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reduce ? "auto" : "smooth" });
  }, [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = (e.currentTarget.closest("[dir]")?.getAttribute("dir") ?? document.documentElement.dir ?? "rtl") === "rtl";
    const next = (delta: number) => { const i = (index + delta + tabs.length) % tabs.length; onChange(tabs[i].key); refs.current[tabs[i].key]?.focus(); };
    if (e.key === "ArrowRight") { e.preventDefault(); next(rtl ? -1 : 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); next(rtl ? 1 : -1); }
    else if (e.key === "Home") { e.preventDefault(); onChange(tabs[0].key); refs.current[tabs[0].key]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); const last = tabs[tabs.length - 1]; onChange(last.key); refs.current[last.key]?.focus(); }
  };

  return (
    <div className={cn("border-b border-border", className)} data-testid="underline-tabs">
      <div
        role="tablist"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        className="flex items-stretch gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab, i) => {
          const active = tab.key === value;
          return (
            <button
              key={tab.key}
              ref={el => { refs.current[tab.key] = el; }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(tab.key)}
              onKeyDown={e => onKeyDown(e, i)}
              className={cn(
                "relative flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "text-primary-text" : "text-muted-foreground hover:text-foreground"
              )}
              data-testid={`underline-tab-${tab.key}`}
            >
              {tab.icon && <tab.icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
              {tab.label}
              {tab.count != null && (
                <span className={cn("rounded-[var(--radius-brand-pill)] px-1.5 py-0.5 text-[11px] tabular-nums", active ? "bg-primary-soft text-primary-text" : "bg-muted text-muted-foreground")}>
                  {tab.count}
                </span>
              )}
              {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" aria-hidden="true" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
