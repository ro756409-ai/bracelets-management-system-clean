import type { ReactNode } from "react";
import {
  AlertTriangle, Archive, Ban, CheckCircle2, CircleDot, Clock, Info, Package, PackageCheck, PhoneOff, Printer, Sparkles, Truck, Undo2, XCircle,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PartnerLogo, type PartnerId } from "@/components/brand/PartnerLogo";

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
 *
 * Copper Signature (Theme Spec §8): الحالة = لون + **أيقونة دلالية** + نص دائمًا — لا اعتماد على
 * اللون وحده (WCAG 1.4.1). الأيقونة زخرفية (`aria-hidden`) لأن النص هو المعنى، والشارة تحمل
 * `data-status`/`data-tone` و`title` للمعلومة الكاملة عند الاقتطاع.
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

/** أيقونة احتياطية لكل نغمة — تُستخدم عندما لا تملك الحالة أيقونتها الخاصة. */
const TONE_ICON: Record<StatusTone, LucideIcon> = {
  neutral: CircleDot, primary: Sparkles, success: CheckCircle2, warning: AlertTriangle, danger: XCircle, info: Info,
  purple: CircleDot, cyan: Truck, amber: Clock, orange: Clock, delivered: PackageCheck,
};

type StatusDef = { label: string; tone: StatusTone; icon?: LucideIcon; /** شعار رسمي محلي (المرحلة 6) — للمصادر فقط، والاسم يبقى مكتوبًا بجواره */ logo?: PartnerId };

/**
 * Canonical order statuses. Labels match the wording staff already read on screen.
 *
 * Colors (2026 Orders redesign): new=blue(info), confirmed=green(success), no_answer=yellow
 * (amber), postponed=orange, cancelled/returned=red(danger), shipped=cyan, delivered=dark
 * green. printed/preparing stay neutral — genuine pipeline stages, not one of the eight
 * meaningful colors, so they don't compete for attention with the statuses that need it.
 */
export const ORDER_STATUS: Record<string, StatusDef> = {
  new: { label: "جديد", tone: "info", icon: Sparkles },
  confirmed: { label: "مؤكد", tone: "success", icon: CheckCircle2 },
  printed: { label: "مطبوع", tone: "neutral", icon: Printer },
  preparing: { label: "قيد التحضير", tone: "neutral", icon: Package },
  shipped: { label: "تم الشحن", tone: "cyan", icon: Truck },
  delivered: { label: "تم التوصيل", tone: "delivered", icon: PackageCheck },
  postponed: { label: "مؤجل", tone: "orange", icon: Clock },
  no_answer: { label: "لم يرد", tone: "amber", icon: PhoneOff },
  cancelled: { label: "ملغي", tone: "danger", icon: Ban },
  returned: { label: "مرتجع", tone: "danger", icon: Undo2 },
};

/** Where an order came from. Deliberately neutral — source is context, not a warning. */
export const ORDER_SOURCE: Record<string, StatusDef> = {
  easyorder: { label: "Easy Order", tone: "neutral", logo: "easyorders" },
  easyorder_farhat: { label: "Easy Order — فرحات", tone: "neutral", logo: "easyorders" },
  easyorder_ataba: { label: "Easy Order — عتبة", tone: "neutral", logo: "easyorders" },
  facebook: { label: "فيسبوك", tone: "neutral", logo: "facebook" },
  whatsapp: { label: "واتساب", tone: "neutral", logo: "whatsapp" },
  shopify: { label: "Shopify", tone: "neutral" },
  manual: { label: "يدوي", tone: "neutral" },
  import: { label: "استيراد", tone: "neutral" },
};

/** الشعار الرسمي لمصدر أوردر (إن وُجد) — لعرضه بجوار اسم المصدر في أي صفحة. */
export const sourceLogo = (source: string | null | undefined): PartnerId | undefined => (source ? ORDER_SOURCE[source]?.logo : undefined);

/** Stock health, shared by the inventory page and its variant rows. */
export const STOCK_STATUS: Record<string, StatusDef> = {
  available: { label: "متوفر", tone: "success", icon: CheckCircle2 },
  low: { label: "منخفض", tone: "warning", icon: AlertTriangle },
  out: { label: "نفد", tone: "danger", icon: XCircle },
  archived: { label: "مؤرشف", tone: "neutral", icon: Archive },
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
  /** أيقونة مخصصة (تُحلّ محلّ أيقونة الحالة/النغمة). `null` = نقطة لونية فقط. */
  icon?: ReactNode | null;
  className?: string;
};

const MAPS = { order: ORDER_STATUS, source: ORDER_SOURCE, stock: STOCK_STATUS };

export function StatusBadge({
  status,
  kind = "order",
  label,
  tone,
  size = "md",
  icon,
  className,
}: StatusBadgeProps) {
  const def = MAPS[kind][status];
  // An unmapped status shows its raw value rather than disappearing — silently rendering
  // nothing would hide a real data problem from whoever is looking at the screen.
  const text = label ?? def?.label ?? status;
  const resolvedTone = tone ?? def?.tone ?? "neutral";
  // المصدر (kind=source) سياق لا حالة → نقطة فقط؛ غير ذلك أيقونة الحالة أو احتياطي النغمة
  const Icon = icon === undefined ? (def?.icon ?? (kind === "source" ? undefined : TONE_ICON[resolvedTone])) : undefined;
  const iconSize = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-brand-pill)] border font-semibold whitespace-nowrap",
        size === "sm" ? "px-2.5 py-0.5 text-[11px]" : "px-3 py-1 text-xs",
        TONE_CLASS[resolvedTone],
        className
      )}
      data-status={status}
      data-tone={resolvedTone}
      title={text}
    >
      {icon !== undefined && icon !== null ? (
        <span className={cn("inline-flex shrink-0 [&>svg]:h-full [&>svg]:w-full", iconSize)} aria-hidden="true">{icon}</span>
      ) : icon === undefined && def?.logo ? (
        <PartnerLogo partner={def.logo} size="xs" decorative className={size === "sm" ? "!h-3" : "!h-3.5"} />
      ) : Icon ? (
        <Icon className={cn("shrink-0", iconSize)} aria-hidden="true" />
      ) : (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      )}
      {text}
    </span>
  );
}
