import { contrast, over, parseColor, type TokenMap } from "./cssTokens";

/**
 * أزواج النص/الخلفية والعناصر كما تستخدمها المكونات المشتركة فعلًا (StatusBadge = اللون نفسه فوق صبغة 10% منه على البطاقة).
 * text = 4.5:1 (نص عادي، WCAG 1.4.3) · ui = 3:1 (حدود الحقول والـfocus والرسوم، WCAG 1.4.11) · info = للتقرير فقط بلا حد.
 */
export type PairKind = "text" | "ui" | "info";
export type Pair = { id: string; fg: string; bg: string; kind: PairKind; tint?: number };

const TEXT_ON_SURFACES: Pair[] = [
  ...["background", "card", "surface-2", "muted", "secondary"].map(bg => ({ id: `foreground/${bg}`, fg: "foreground", bg, kind: "text" as const })),
  { id: "card-foreground/card", fg: "card-foreground", bg: "card", kind: "text" },
  { id: "popover-foreground/popover", fg: "popover-foreground", bg: "popover", kind: "text" },
  ...["background", "card"].map(bg => ({ id: `text-2/${bg}`, fg: "text-2", bg, kind: "text" as const })),
  ...["background", "card", "muted", "surface-2"].map(bg => ({ id: `muted-foreground/${bg}`, fg: "muted-foreground", bg, kind: "text" as const })),
  { id: "secondary-foreground/secondary", fg: "secondary-foreground", bg: "secondary", kind: "text" },
  { id: "primary-foreground/primary", fg: "primary-foreground", bg: "primary", kind: "text" },
  ...["background", "card", "primary-soft"].map(bg => ({ id: `primary-text/${bg}`, fg: "primary-text", bg, kind: "text" as const })),
  { id: "accent-foreground/accent", fg: "accent-foreground", bg: "accent", kind: "text" },
  ...["destructive", "success", "warning", "info", "error", "rx-good"].map(c => ({ id: `${c}-foreground/${c}`, fg: `${c}-foreground`, bg: c, kind: "text" as const })),
  { id: "ai-foreground/ai", fg: "ai-foreground", bg: "ai", kind: "text" },
];

/** شارات الحالة: النص باللون نفسه فوق صبغة 10% منه على البطاقة (`bg-[var(--x)]/10 text-[var(--x)]` في StatusBadge). */
const STATUS_BADGES: Pair[] = ["success", "warning", "destructive", "info", "purple", "cyan", "amber", "orange", "delivered", "rx-good"]
  .map(c => ({ id: `badge:${c}`, fg: c, bg: c, kind: "text" as const, tint: 0.1 }));

const SIDEBAR: Pair[] = [
  { id: "sidebar-foreground/sidebar", fg: "sidebar-foreground", bg: "sidebar", kind: "text" },
  { id: "sidebar-accent-foreground/sidebar-accent", fg: "sidebar-accent-foreground", bg: "sidebar-accent", kind: "text" },
  { id: "sidebar-primary-foreground/sidebar-primary", fg: "sidebar-primary-foreground", bg: "sidebar-primary", kind: "text" },
  { id: "sidebar-primary/sidebar", fg: "sidebar-primary", bg: "sidebar", kind: "ui" },
];

const UI: Pair[] = [
  ...["background", "card"].map(bg => ({ id: `ring/${bg}`, fg: "ring", bg, kind: "ui" as const })),
  ...["background", "card"].map(bg => ({ id: `primary/${bg}`, fg: "primary", bg, kind: "ui" as const })),
  ...["background", "card"].map(bg => ({ id: `input/${bg}`, fg: "input", bg, kind: "ui" as const })),
  ...["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"].map(c => ({ id: `${c}/card`, fg: c, bg: "card", kind: "ui" as const })),
  ...["background", "card"].map(bg => ({ id: `border/${bg}`, fg: "border", bg, kind: "info" as const })),
];

export const CONTRAST_PAIRS: Pair[] = [...TEXT_ON_SURFACES, ...STATUS_BADGES, ...SIDEBAR, ...UI];
export const THRESHOLD: Record<PairKind, number> = { text: 4.5, ui: 3, info: 0 };

export type Measured = { theme: string; id: string; kind: PairKind; ratio: number | null; ok: boolean };

export function measure(theme: string, tokens: TokenMap): Measured[] {
  const card = parseColor(tokens["--card"] ?? "#FFFFFF", tokens) ?? { r: 255, g: 255, b: 255, a: 1 };
  return CONTRAST_PAIRS.map(p => {
    const fgRaw = tokens[`--${p.fg}`], bgRaw = tokens[`--${p.bg}`];
    const fg0 = fgRaw ? parseColor(fgRaw, tokens) : null, bg0 = bgRaw ? parseColor(bgRaw, tokens) : null;
    if (!fg0 || !bg0) return { theme, id: p.id, kind: p.kind, ratio: null, ok: p.kind === "info" };
    const bgSolid = over(bg0, card);
    const bg = p.tint != null ? over({ ...bg0, a: p.tint }, card) : bgSolid;
    const fg = over(fg0, bg);
    const ratio = Math.round(contrast(fg, bg) * 100) / 100;
    return { theme, id: p.id, kind: p.kind, ratio, ok: ratio >= THRESHOLD[p.kind] };
  });
}
