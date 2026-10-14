/**
 * Matjarak 2.0 — المرحلة 0 (قياس فقط): قراءة tokens الألوان من `client/src/index.css` كما هي وحساب تباين WCAG 2.x.
 * لا يغيّر أي لون — يقيس الواجهة الحالية لتكون مرجعًا قبل الهوية الجديدة.
 */
export type Rgba = { r: number; g: number; b: number; a: number };
export type TokenMap = Record<string, string>;

/** الكتل التي نقيسها: الفاتح، الداكن، وكل لون بديل للمستخدم بالوضعين (تُدمج فوق الأساس). */
export function parseThemeBlocks(css: string): Record<string, TokenMap> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Record<string, TokenMap> = {};
  const re = /(^|\n)\s*(:root(?:\[data-accent="([a-z]+)"\])?|\.dark(?:\[data-accent="([a-z]+)"\])?)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const sel = m[2];
    const name = sel.startsWith(":root") ? (m[3] ? `light:${m[3]}` : "light") : (m[4] ? `dark:${m[4]}` : "dark");
    const vars = blocks[name] ?? {};
    for (const decl of m[5].split(";")) {
      const d = decl.match(/^\s*(--[a-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/i);
      if (d) vars[d[1]] = d[2];
    }
    blocks[name] = vars;
  }
  return blocks;
}

/** الثيمات الفعلية كما يراها المستخدم: الأساس + كتلة اللون البديل فوقه. */
export function resolvedThemes(css: string): Record<string, TokenMap> {
  const b = parseThemeBlocks(css);
  const out: Record<string, TokenMap> = { light: { ...b.light }, dark: { ...b.light, ...b.dark } };
  for (const key of Object.keys(b)) {
    const [mode, accent] = key.split(":");
    if (!accent) continue;
    out[key] = mode === "light" ? { ...b.light, ...b[key] } : { ...b.light, ...b.dark, ...b[key] };
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
