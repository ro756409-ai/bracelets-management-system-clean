if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
process.env.NODE_ENV = "test";
process.env.DISABLE_MAINTENANCE_SCHEDULER = "true";
// النظام المحاسبي مجمّد في التطبيق (الافتراضي)، لكن الاختبارات بتفعّله عشان تفضل تتحقّق من
// المنطق الداخلي المحفوظ للنظام القادم. اختبار التجميد المخصّص بيطفّيه صراحةً ويتحقّق.
if (process.env.ACCOUNTING_MODULE_ENABLED === undefined) {
  process.env.ACCOUNTING_MODULE_ENABLED = "true";
}
