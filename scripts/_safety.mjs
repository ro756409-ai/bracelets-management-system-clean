/**
 * حارس مشترك لأي سكربت بيكتب على قاعدة البيانات.
 *
 * السكربتات القديمة كانت بتتصل بـ`DATABASE_URL` وتحذف/تعدّل على طول — من غير معاينة،
 * من غير تأكيد، من غير ما تقول على أنهي قاعدة بيانات. تشغيلة واحدة بالغلط على الإنتاج
 * = بيانات ضاعت. الحارس ده بيقفل الاحتمال ده من مكان واحد.
 *
 * الاستخدام في أول أي سكربت كاتب:
 *
 *   import { assertScriptSafety } from "./_safety.mjs";
 *   const { apply } = assertScriptSafety({ name: "cleanup-duplicates", destructive: true });
 *   if (!apply) { ...اطبع المعاينة واخرج... }
 *
 * القواعد:
 *   ١. لازم `--apply` صريح — من غيره معاينة بس.
 *   ٢. بيطبع الـhost واسم قاعدة البيانات قبل أي حاجة — عشان تشوف إنت رايح على فين.
 *   ٣. السكربت المدمّر على قاعدة إنتاج بيطلب `--i-understand-production` كمان.
 *   ٤. غياب `DATABASE_URL` بيوقف فورًا.
 */

function parseTarget(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, database: u.pathname.replace(/^\//, "") || "?" };
  } catch {
    return { host: "?", database: "?" };
  }
}

/** تخمين محافظ: أي حاجة مش localhost/127.0.0.1/test بتتعامل كإنتاج. */
function looksLikeProduction(host, database) {
  const local = /^(localhost|127\.0\.0\.1|::1)$/.test(host);
  const test = /test/i.test(database);
  return !local && !test;
}

export function assertScriptSafety({ name, destructive = false }) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(`[${name}] ❌ DATABASE_URL مش مضبوط — إيقاف.`);
    process.exit(1);
  }
  const { host, database } = parseTarget(url);
  const prod = looksLikeProduction(host, database);
  const apply = process.argv.includes("--apply");

  console.log("\n════════════════════════════════════════════");
  console.log(`  سكربت: ${name}${destructive ? "  ⚠️ مدمّر" : ""}`);
  console.log(`  القاعدة: ${database} @ ${host}${prod ? "   ← يبدو إنتاج" : ""}`);
  console.log(`  الوضع: ${apply ? "تنفيذ (--apply)" : "معاينة"}`);
  console.log("════════════════════════════════════════════\n");

  if (apply && destructive && prod && !process.argv.includes("--i-understand-production")) {
    console.error(
      `[${name}] ❌ سكربت مدمّر على قاعدة إنتاج.\n` +
        `    خُد Backup اختبرت استرجاعه، وبعدين زوّد --i-understand-production.`
    );
    process.exit(1);
  }

  return { apply, host, database, isProduction: prod };
}
