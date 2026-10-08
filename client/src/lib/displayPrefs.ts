/**
 * تخصيص العرض لكل مستخدم (المرحلة 5) — منطق نقي بلا DOM ولا شبكة:
 *   • النموذج والقيم المسموحة + الافتراضيات (النحاسي، 100%، حسب الجهاز، مريحة، حسب الجهاز).
 *   • هوية الجلسة → مفتاح تخزين **منفصل** لكل مستخدم: `matjarak:display-prefs:v1:<identity>`
 *       المالك الحقيقي `u:<userId>` · الموظف `e:<employeeId>` · الجلسة الصناعية `s:<employeeId>`.
 *     الزائر غير المسجل بلا مفتاح → لا حفظ. لا مفتاح عام مشترك، ولا tenantId (لا تعديل على auth.me).
 *   • لوحات اللون الأربعة (Light + Dark) مع حساب تباين WCAG الذي تُثبّته الاختبارات.
 *   • تطبيق الإعدادات على العنصر الجذري: `--font-scale` · `data-density` · `data-accent` · `data-reduce-motion`.
 * تفضيلات واجهة فقط: لا صلاحيات، لا بيانات نشاط، لا API.
 */

export const FONT_SCALES = [0.9, 1, 1.1, 1.25] as const;
export type FontScale = (typeof FONT_SCALES)[number];
export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];
export const ACCENT_IDS = ["copper", "teal", "indigo", "olive"] as const;
export type AccentId = (typeof ACCENT_IDS)[number];
export const DENSITIES = ["comfortable", "compact"] as const;
export type DensityPref = (typeof DENSITIES)[number];
export const MOTION_PREFS = ["system", "reduce", "allow"] as const;
export type MotionPref = (typeof MOTION_PREFS)[number];

export interface DisplayPrefs {
  fontScale: FontScale;
  theme: ThemeMode;
  accent: AccentId;
  density: DensityPref;
  motion: MotionPref;
}

export const DEFAULT_PREFS: DisplayPrefs = Object.freeze({
  fontScale: 1,
  theme: "system",
  accent: "copper",
  density: "comfortable",
  motion: "system",
}) as DisplayPrefs;

export const FONT_SCALE_LABELS: Record<FontScale, string> = { 0.9: "90%", 1: "100%", 1.1: "110%", 1.25: "125%" };
export const THEME_LABELS: Record<ThemeMode, string> = { light: "فاتح", dark: "داكن", system: "حسب الجهاز" };
export const DENSITY_LABELS: Record<DensityPref, string> = { comfortable: "مريحة", compact: "مدمجة" };
export const MOTION_LABELS: Record<MotionPref, string> = { system: "حسب الجهاز", reduce: "مفعّل", allow: "غير مفعّل" };

/** لوحة لون رئيسي واحدة لوضع واحد — القيم نفسها التي تُكتب في Tokens (index.css). */
export interface AccentPalette {
  primary: string;
  primaryForeground: string;
  primaryText: string;
  primaryDark: string;
  primarySoft: string;
  accent: string;
  accentForeground: string;
}
export interface AccentDef { label: string; light: AccentPalette; dark: AccentPalette }

/**
 * أربعة ألوان آمنة متوافقة مع الهوية (النحاسي الافتراضي). الحالات الدلالية (نجاح/تحذير/خطر/معلومة)
 * لا تتغير مع اللون الرئيسي — هذه اللوحات تمسّ primary/accent/ring فقط.
 * التباين (محسوب في الاختبار): نص الزر الرئيسي ≥ 4.5:1 · اللون على الخلفية (حدود/تركيز) ≥ 3:1 ·
 * primary-text على الخلفية والسطح الناعم ≥ 4.5:1 — في الوضعين.
 */
export const ACCENTS: Record<AccentId, AccentDef> = {
  copper: {
    label: "نحاسي",
    light: { primary: "#B4532A", primaryForeground: "#FFFFFF", primaryText: "#9A421D", primaryDark: "#9A421D", primarySoft: "#F7EBE4", accent: "#F7EBE4", accentForeground: "#9A421D" },
    dark: { primary: "#E07A4B", primaryForeground: "#121211", primaryText: "#F29C70", primaryDark: "#C96A3E", primarySoft: "#3A2A22", accent: "#392921", accentForeground: "#F29C70" },
  },
  teal: {
    label: "تركوازي",
    light: { primary: "#0E6E78", primaryForeground: "#FFFFFF", primaryText: "#0B5A62", primaryDark: "#0B5A62", primarySoft: "#E3F2F3", accent: "#E3F2F3", accentForeground: "#0B5A62" },
    dark: { primary: "#4FC3CF", primaryForeground: "#121211", primaryText: "#7FD8E0", primaryDark: "#3AA9B5", primarySoft: "#1A3236", accent: "#1A3236", accentForeground: "#7FD8E0" },
  },
  indigo: {
    label: "نيلي",
    light: { primary: "#3D52B5", primaryForeground: "#FFFFFF", primaryText: "#2F4094", primaryDark: "#2F4094", primarySoft: "#E8EBF8", accent: "#E8EBF8", accentForeground: "#2F4094" },
    dark: { primary: "#9DB0F4", primaryForeground: "#121211", primaryText: "#B9C7F7", primaryDark: "#7F95E8", primarySoft: "#252B45", accent: "#252B45", accentForeground: "#B9C7F7" },
  },
  olive: {
    label: "زيتوني",
    light: { primary: "#4F6B23", primaryForeground: "#FFFFFF", primaryText: "#3F561B", primaryDark: "#3F561B", primarySoft: "#ECF1E0", accent: "#ECF1E0", accentForeground: "#3F561B" },
    dark: { primary: "#A9C45A", primaryForeground: "#121211", primaryText: "#C3D985", primaryDark: "#8FAA45", primarySoft: "#2A3220", accent: "#2A3220", accentForeground: "#C3D985" },
  },
};

/** خلفيات الوضعين كما في index.css — مرجع حساب التباين. */
export const MODE_BACKGROUNDS = { light: { background: "#F5F5F3", card: "#FFFFFF" }, dark: { background: "#121211", card: "#1B1B1A" } } as const;

// ---------------------------------------------------------------- الهوية والتخزين
export type SessionIdentity = { kind: "u" | "e" | "s"; id: number };

/**
 * هوية الجلسة من مصادر العميل الموجودة فقط:
 *   • `auth.me` يرجّع المستخدم: id موجب = مالك حقيقي (`u`)؛ id سالب = الجلسة الصناعية لموظف إداري
 *     (السيرفر يبنيها بـ `id: -employeeId`) → `s:<employeeId>`.
 *   • لا مستخدم لكن `employee_session` محلي (بوابة الموظف) → `e:<employeeId>`.
 *   • غير ذلك: زائر → null (لا حفظ).
 */
export function resolveIdentity(
  user: { id: number; loginMethod?: string | null } | null | undefined,
  employeeSession: { employeeId: number } | null | undefined
): SessionIdentity | null {
  if (user && Number.isInteger(user.id)) {
    if (user.id > 0) return { kind: "u", id: user.id };
    if (user.id < 0) return { kind: "s", id: -user.id };
  }
  if (employeeSession && Number.isInteger(employeeSession.employeeId) && employeeSession.employeeId > 0) return { kind: "e", id: employeeSession.employeeId };
  return null;
}

export const PREFS_KEY_PREFIX = "matjarak:display-prefs:v1:";
export function identityTag(identity: SessionIdentity): string { return `${identity.kind}:${identity.id}`; }
export function storageKey(identity: SessionIdentity | null): string | null { return identity ? `${PREFS_KEY_PREFIX}${identityTag(identity)}` : null; }

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function defaultStorage(): StorageLike | null { try { return typeof localStorage !== "undefined" ? localStorage : null; } catch { return null; } }

/** يقبل أي كائن ويعيد تفضيلات صالحة فقط (القيم غير المعروفة → الافتراضي لذلك الحقل). */
export function sanitizePrefs(raw: unknown): DisplayPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fs = Number(r.fontScale);
  return {
    fontScale: (FONT_SCALES as readonly number[]).includes(fs) ? (fs as FontScale) : DEFAULT_PREFS.fontScale,
    theme: (THEME_MODES as readonly unknown[]).includes(r.theme) ? (r.theme as ThemeMode) : DEFAULT_PREFS.theme,
    accent: (ACCENT_IDS as readonly unknown[]).includes(r.accent) ? (r.accent as AccentId) : DEFAULT_PREFS.accent,
    density: (DENSITIES as readonly unknown[]).includes(r.density) ? (r.density as DensityPref) : DEFAULT_PREFS.density,
    motion: (MOTION_PREFS as readonly unknown[]).includes(r.motion) ? (r.motion as MotionPref) : DEFAULT_PREFS.motion,
  };
}

export function loadPrefs(identity: SessionIdentity | null, storage: StorageLike | null = defaultStorage()): DisplayPrefs {
  const key = storageKey(identity);
  if (!key || !storage) return { ...DEFAULT_PREFS };
  try {
    const raw = storage.getItem(key);
    return raw ? sanitizePrefs(JSON.parse(raw)) : { ...DEFAULT_PREFS };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** يحفظ لهوية مسجلة فقط؛ الزائر → false ولا يُكتب شيء. */
export function savePrefs(identity: SessionIdentity | null, prefs: DisplayPrefs, storage: StorageLike | null = defaultStorage()): boolean {
  const key = storageKey(identity);
  if (!key || !storage) return false;
  try { storage.setItem(key, JSON.stringify(sanitizePrefs(prefs))); return true; } catch { return false; }
}

export function clearPrefs(identity: SessionIdentity | null, storage: StorageLike | null = defaultStorage()): void {
  const key = storageKey(identity);
  if (!key || !storage) return;
  try { storage.removeItem(key); } catch { /* مقفول */ }
}

// ---------------------------------------------------------------- التطبيق على الجذر
export function resolveTheme(mode: ThemeMode, systemDark: boolean): "light" | "dark" {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}
export function resolveReduceMotion(pref: MotionPref, systemReduce: boolean): boolean {
  return pref === "system" ? systemReduce : pref === "reduce";
}

export interface ApplyEnv { systemDark: boolean; systemReduce: boolean; isDesktop: boolean }

/**
 * يكتب الإعدادات على العنصر الجذري فتظهر فورًا بلا إعادة تحميل:
 *   `.dark` + `data-theme` · `--font-scale` (+ `data-font-scale`) · `data-density` (المدمجة على الديسكتوب فقط —
 *   على الموبايل تبقى «مريحة» فتبقى أهداف اللمس 44px) · `data-accent` · `data-reduce-motion` (on/off بعد حلّ «حسب الجهاز»).
 */
export function applyPrefsToRoot(root: HTMLElement, prefs: DisplayPrefs, env: ApplyEnv): void {
  const theme = resolveTheme(prefs.theme, env.systemDark);
  root.classList.toggle("dark", theme === "dark");
  root.setAttribute("data-theme", theme);
  root.setAttribute("data-theme-pref", prefs.theme);
  root.style.setProperty("--font-scale", String(prefs.fontScale));
  root.setAttribute("data-font-scale", String(prefs.fontScale));
  root.setAttribute("data-density", env.isDesktop ? prefs.density : "comfortable");
  root.setAttribute("data-accent", prefs.accent);
  root.setAttribute("data-reduce-motion", resolveReduceMotion(prefs.motion, env.systemReduce) ? "on" : "off");
}

// ---------------------------------------------------------------- التباين (WCAG 2.x)
export function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map(i => parseInt(full.substr(i, 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** جدول التباين لكل لون ووضع — يُستخدم في الاختبار وفي التقرير. */
export function accentContrastTable() {
  return ACCENT_IDS.flatMap(id => (["light", "dark"] as const).map(mode => {
    const p = ACCENTS[id][mode]; const bg = MODE_BACKGROUNDS[mode];
    return {
      accent: id, mode,
      buttonText: contrastRatio(p.primary, p.primaryForeground),
      primaryOnBackground: contrastRatio(p.primary, bg.background),
      primaryOnCard: contrastRatio(p.primary, bg.card),
      primaryTextOnBackground: contrastRatio(p.primaryText, bg.background),
      primaryTextOnSoft: contrastRatio(p.primaryText, p.primarySoft),
    };
  }));
}
