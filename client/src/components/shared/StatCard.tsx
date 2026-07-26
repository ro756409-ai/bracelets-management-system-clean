import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Semantic tone. Every colour comes from a token — never a raw Tailwind palette class. */
export type StatTone = "default" | "primary" | "success" | "warning" | "danger" | "info";

const TONE_TEXT: Record<StatTone, string> = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-[var(--success)]",
  warning: "text-[var(--warning)]",
  danger: "text-destructive",
  info: "text-[var(--info)]",
};

const TONE_ICON_BG: Record<StatTone, string> = {
  default: "bg-muted text-muted-foreground",
  primary: "bg-accent text-accent-foreground",
  success: "bg-[var(--success)]/10 text-[var(--success)]",
  warning: "bg-[var(--warning)]/10 text-[var(--warning)]",
  danger: "bg-destructive/10 text-destructive",
  info: "bg-[var(--info)]/10 text-[var(--info)]",
};

export type StatCardProps = {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  tone?: StatTone;
  /** Small caption under the value (e.g. a comparison or unit). */
  hint?: string;
  loading?: boolean;
  /** Makes the whole card a button — used for stat tiles that apply a filter. */
  onClick?: () => void;
  /** Renders the card as visually selected; pairs with `onClick` filter tiles. */
  active?: boolean;
  /**
   * `compact` trims padding/icon size/font size for dense stat rows (7+ tiles across a
   * page header) without touching any existing caller — defaults to the original size.
   */
  size?: "default" | "compact";
  className?: string;
};

/**
 * One number with a label. Six different stat-card styles existed across the app; this
 * is the single one. Numbers use tabular figures so columns of cards line up in RTL.
 */
export function StatCard({
  label,
  value,
  icon,
  tone = "default",
  hint,
  loading = false,
  onClick,
  active = false,
  size = "default",
  className,
}: StatCardProps) {
  const interactive = typeof onClick === "function";
  const compact = size === "compact";

  const body = (
    <CardContent className={cn("flex items-center gap-3", compact ? "p-3" : "p-4")}>
      {icon && (
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-[var(--radius-brand-md)]",
            compact ? "h-8 w-8" : "h-10 w-10",
            TONE_ICON_BG[tone]
          )}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0 space-y-0.5 text-right">
        {loading ? (
          <Skeleton className={compact ? "h-5 w-12" : "h-7 w-16"} />
        ) : (
          <p className={cn(
            "font-bold tabular-nums leading-tight",
            compact ? "text-lg" : "text-2xl",
            TONE_TEXT[tone]
          )}>
            {value}
          </p>
        )}
        <p className={cn("text-muted-foreground", compact ? "text-[11px]" : "text-xs")}>{label}</p>
        {hint && !loading && (
          <p className="text-[11px] text-muted-foreground/80">{hint}</p>
        )}
      </div>
    </CardContent>
  );

  if (!interactive) {
    return (
      <Card className={cn("shadow-[var(--shadow-card)]", className)}>{body}</Card>
    );
  }

  return (
    <Card
      role="button"
      tabIndex={0}
      aria-pressed={active}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "cursor-pointer shadow-[var(--shadow-card)] transition-colors",
        "hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        active && "border-primary ring-1 ring-primary",
        className
      )}
    >
      {body}
    </Card>
  );
}
