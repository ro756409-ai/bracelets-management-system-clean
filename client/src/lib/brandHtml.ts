/**
 * Matjarak 2.0 — المرحلة 1C-3B: خطوط v2 كلها مستضافة ذاتيًا (client/public/fonts)، فروابط Google Fonts في
 * client/index.html (تعليقها + preconnect ×2 + stylesheet) طلبات شبكة بلا فائدة تحت v2. تُشال وقت البناء من HTML
 * بتاع v2 فقط عبر brandHtmlPlugin في vite.config.ts — v1 لا يمر من هنا فيبقى HTML بتاعه كما هو بالبايت.
 */

/** تعليق HTML واحد يذكر Google Fonts (بلا عبور حدود تعليق آخر)، أو وسم <link> يشير لـfonts.googleapis/gstatic — بسطره. */
const GOOGLE_FONTS_PARTS =
  /[ \t]*<!--(?:(?!-->)[\s\S])*?Google Fonts(?:(?!-->)[\s\S])*?-->[ \t]*\r?\n|[ \t]*<link\b[^>]*https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>[ \t]*\r?\n/g;

export function stripGoogleFonts(html: string): string {
  return html.replace(GOOGLE_FONTS_PARTS, "");
}

/** يرمي لو بقي أي أثر لـGoogle Fonts — يحمي v2 من تغيير صامت في index.html يُفلت من الإزالة. */
export function assertNoGoogleFonts(html: string): void {
  const left = html.split("\n").map(l => l.trim()).filter(l => /fonts\.(?:googleapis|gstatic)\.com/.test(l));
  if (left.length) {
    throw new Error(
      "brand v2: Google Fonts links remain in client/index.html after stripGoogleFonts — v2 must not load Google Fonts.\n" +
      left.map(l => `  leftover: ${l.slice(0, 160)}`).join("\n") +
      "\nFix: remove that link from client/index.html, or extend the pattern in client/src/lib/brandHtml.ts (and its test).",
    );
  }
}
