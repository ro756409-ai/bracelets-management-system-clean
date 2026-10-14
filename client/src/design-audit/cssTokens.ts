/**
 * Matjarak 2.0 — المرحلة 0 (قياس فقط): قراءة tokens الألوان من `client/src/index.css` كما هي وحساب تباين WCAG 2.x.
 * لا يغيّر أي لون — يقيس الواجهة الحالية لتكون مرجعًا قبل الهوية الجديدة.
 */
export type Rgba = { r: number; g: number; b: number; a: number };
export type TokenMap = Record<string, string>;

/**
 * الكتل التي نقيسها: الفاتح، الداكن، وكل لون بديل للمستخدم بالوضعين، والهوية الجديدة (data-brand="v2") بالوضعين.
 * أسماء الكتل: light · dark · light:<accent> · dark:<accent> · light:v2 · dark:v2.
 */
export function parseThemeBlocks(css: string): Record<string, TokenMap> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Record<string, TokenMap> = {};
  const re = /(^|\n)\s*(:root|\.dark)(?:\[data-(accent|brand)="([a-z0-9]+)"\])?\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const mode = m[2] === ":root" ? "light" : "dark";
    const name = m[4] ? `${mode}:${m[4]}` : mode;
    const vars = blocks[name] ?? {};
    for (const decl of m[5].split(";")) {
      const d = decl.match(/^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i);
      if (d) vars[d[1]] = d[2];
    }
    blocks[name] = vars;
  }
  return blocks;
}

export const ACCENT_IDS = ["teal", "indigo", "olive"] as const;

/**
 * الثيمات الفعلية كما يراها المستخدم، بنفس ترتيب التتالي في index.css (كل الكتل بالسمة لها نفس الأولوية، فالأحدث يغلب):
 * :root ← .dark ← v2 فاتح ← v2 داكن ← اللون البديل فاتح ← اللون البديل داكن.
 */
export function resolvedThemes(css: string): Record<string, TokenMap> {
  const b = parseThemeBlocks(css);
  const out: Record<string, TokenMap> = { light: { ...b.light }, dark: { ...b.light, ...b.dark } };
  for (const a of ACCENT_IDS) {
    if (!b[`light:${a}`] && !b[`dark:${a}`]) continue;
    out[`light:${a}`] = { ...b.light, ...b[`light:${a}`] };
    out[`dark:${a}`] = { ...b.light, ...b.dark, ...b[`light:${a}`], ...b[`dark:${a}`] };
  }
  if (b["light:v2"] || b["dark:v2"]) {
    out["light:v2"] = { ...b.light, ...b["light:v2"] };
    out["dark:v2"] = { ...b.light, ...b.dark, ...b["light:v2"], ...b["dark:v2"] };
    for (const a of ACCENT_IDS) {
      if (!b[`light:${a}`] && !b[`dark:${a}`]) continue;
      out[`light:v2:${a}`] = { ...b.light, ...b["light:v2"], ...b[`light:${a}`] };
      out[`dark:v2:${a}`] = { ...b.light, ...b.dark, ...b["light:v2"], ...b["dark:v2"], ...b[`light:${a}`], ...b[`dark:${a}`] };
    }
  }
  return out;
}

export function parseColor(value: string, tokens: TokenMap, depth = 0): Rgba | null {
  const v = value.trim();
  const ref = v.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (ref) return depth > 8 || tokens[ref[1]] == null ? null : parseColor(tokens[ref[1]], tokens, depth + 1);
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) return { r: parseInt(hex[1].slice(0, 2), 16), g: parseInt(hex[1].slice(2, 4), 16), b: parseInt(hex[1].slice(4, 6), 16), a: 1 };
  const rgba = v.match(/^rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (rgba) {
    const a = rgba[4] == null ? 1 : rgba[4].endsWith("%") ? parseFloat(rgba[4]) / 100 : parseFloat(rgba[4]);
    return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a };
  }
  return null;
}

/** لون شبه شفاف فوق خلفية معتمة (نفس ما يرسمه المتصفح). */
export const over = (top: Rgba, base: Rgba): Rgba => ({
  r: top.r * top.a + base.r * (1 - top.a), g: top.g * top.a + base.g * (1 - top.a), b: top.b * top.a + base.b * (1 - top.a), a: 1,
});

const channel = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (c: Rgba) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
export const contrast = (a: Rgba, b: Rgba) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

/** CIE L*a*b* (D65) ومسافة ΔE*ab (CIE76) — لقياس تمييز لونين بالعين (البراند مقابل الخطأ)، لا للتباين. */
function toLab(c: Rgba): [number, number, number] {
  const lin = [c.r, c.g, c.b].map(v => { const s = v / 255; return s > 0.04045 ? ((s + 0.055) / 1.055) ** 2.4 : s / 12.92; });
  const X = (lin[0] * 0.4124 + lin[1] * 0.3576 + lin[2] * 0.1805) / 0.95047;
  const Y = lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
  const Z = (lin[0] * 0.0193 + lin[1] * 0.1192 + lin[2] * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
export const deltaE = (a: Rgba, b: Rgba) => { const [p, q] = [toLab(a), toLab(b)]; return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
