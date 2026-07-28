import { cn } from "@/lib/utils";

/**
 * Order status presentation, in one place.
 *
 * Four pages each carried their own STATUS_LABELS/STATUS_COLORS map, drifting in both
 * wording and colour — "ملغي" was red on one page and orange on another, and the raw
 * Tailwind palette classes ignored the brand tokens and broke in dark mode.
 *
 * Tones are semantic, not decorative: a status the user must act on reads warning, a
 * finished-well status reads success, a failure reads danger. Statuses that are merely
 * stages in a healthy pipeline stay neutral so the screen is not a wall of colour.
 */
export type StatusTone =
  | "neutral" | "primary" | "success" | "warning" | "danger" | "info"
  // Extra order-status hues — used only for the specific statuses that need to be visually
  // distinct from one another (new/no_answer/postponed/shipped/delivered no longer share a
  // color the way they used to under the original 6-tone set).
  | "purple" | "cyan" | "amber" | "orange" | "delivered";

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  primary: "bg-accent text-accent-foreground border-primary/30",
  success: "bg-[var(--success)]/10 text-[var(--success)] border-[var(--success)]/30",
  warning: "bg-[var(--warning)]/10 text-[var(--warning)] border-[var(--warning)]/30",
  danger: "bg-destructive/10 text-destructive border-destructive/30",
  info: "bg-[var(--info)]/10 text-[var(--info)] border-[var(--info)]/30",
  purple: "bg-[var(--purple)]/10 text-[var(--purple)] border-[var(--purple)]/30",
  cyan: "bg-[var(--cyan)]/10 text-[var(--cyan)] border-[var(--cyan)]/30",
  amber: "bg-[var(--amber)]/10 text-[var(--amber)] border-[var(--amber)]/30",
  orange: "bg-[var(--orange)]/10 text-[var(--orange)] border-[var(--orange)]/30",
  delivered: "bg-[var(--delivered)]/10 text-[var(--delivered)] border-[var(--delivered)]/30",
};

/** The dot uses the solid tone colour (not the 10%-opacity background) so it stays a
 *  clear anchor even for two statuses that share a tone (e.g. "مؤجل"/"لم يرد" both warning). */
const TONE_DOT_CLASS: Record<StatusTone, string> = {
  neutral: "bg-muted-foreground",
  primary: "bg-primary",
  success: "bg-[var(--success)]",
  warning: "bg-[var(--warning)]",
  danger: "bg-destructive",
  info: "bg-[var(--info)]",
  purple: "bg-[var(--purple)]",
  cyan: "bg-[var(--cyan)]",
  amber: "bg-[var(--amber)]",
  orange: "bg-[var(--orange)]",
  delivered: "bg-[var(--delivered)]",
};

type StatusDef = { label: string; tone: StatusTone };

/**
 * Canonical order statuses. Labels match the wording staff already read on screen.
 *
 * Colors (2026 Orders redesign): new=blue(info), confirmed=green(success), no_answer=yellow
 * (amber), postponed=orange, cancelled/returned=red(danger), shipped=cyan, delivered=dark
 * green. printed/preparing stay neutral — genuine pipeline stages, not one of the eight
 * meaningful colors, so they don't compete for attention with the statuses that need it.
 */
export const ORDER_STATUS: Record<string, StatusDef> = {
  new: { label: "جديد", tone: "info" },
  confirmed: { label: "مؤكد", tone: "success" },
  printed: { label: "مطبوع", tone: "neutral" },
  preparing: { label: "قيد التحضير", tone: "neutral" },
  shipped: { label: "تم الشحن", tone: "cyan" },
  delivered: { label: "تم التوصيل", tone: "delivered" },
  postponed: { label: "مؤجل", tone: "orange" },
  no_answer: { label: "لم يرد", tone: "amber" },
  cancelled: { label: "ملغي", tone: "danger" },
  returned: { label: "مرتجع", tone: "danger" },
};

/** Where an order came from. Deliberately neutral — source is context, not a warning. */
export const ORDER_SOURCE: Record<string, StatusDef> = {
  easyorder: { label: "Easy Order", tone: "neutral" },
  easyorder_farhat: { label: "Easy Order — فرحات", tone: "neutral" },
  easyorder_ataba: { label: "Easy Order — عتبة", tone: "neutral" },
  facebook: { label: "فيسبوك", tone: "neutral" },
  whatsapp: { label: "واتساب", tone: "neutral" },
  shopify: { label: "Shopify", tone: "neutral" },
  manual: { label: "يدوي", tone: "neutral" },
  import: { label: "استيراد", tone: "neutral" },
};

/** Stock health, shared by the inventory page and its variant rows. */
export const STOCK_STATUS: Record<string, StatusDef> = {
  available: { label: "متوفر", tone: "success" },
  low: { label: "منخفض", tone: "warning" },
  out: { label: "نفد", tone: "danger" },
  archived: { label: "مؤرشف", tone: "neutral" },
};

export type StatusBadgeProps = {
  /** Raw value from the API (e.g. "no_answer"). */
  status: string;
  /** Which vocabulary to read the status from. */
  kind?: "order" | "source" | "stock";
  /** Overrides the looked-up label — for a status not in the map. */
  label?: string;
  tone?: StatusTone;
  size?: "sm" | "md";
  className?: string;
};

const MAPS = { order: ORDER_STATUS, source: ORDER_SOURCE, stock: STOCK_STATUS };

export function StatusBadge({
  status,
  kind = "order",
  label,
  tone,
  size = "md",
  className,
}: StatusBadgeProps) {
  const def = MAPS[kind][status];
  // An unmapped status shows its raw value rather than disappearing — silently rendering
  // nothing would hide a real data problem from whoever is looking at the screen.
  const text = label ?? def?.label ?? status;
  const resolvedTone = tone ?? def?.tone ?? "neutral";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-brand-pill)] border font-semibold whitespace-nowrap",
        size === "sm" ? "px-2.5 py-0.5 text-[11px]" : "px-3 py-1 text-xs",
        TONE_CLASS[resolvedTone],
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", TONE_DOT_CLASS[resolvedTone])} />
      {text}
    </span>
  );
}
