#!/usr/bin/env node
// مشغّل للنسخة المبنية (dist/scripts/*.mjs) — يعمل بـnode العادي داخل صورة النشر بلا tsx ولا devDependencies.
// المصدر: scripts/migrate-0040-ledger-v3.ts — يُبنى ضمن `pnpm run build` (نفس طريقة dist/index.js).
const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");
const built = path.join(__dirname, "..", "dist", "scripts", "migrate-0040-ledger-v3.mjs");
if (!fs.existsSync(built)) {
  console.error("النسخة المبنية غير موجودة (dist/scripts/migrate-0040-ledger-v3.mjs) — شغّل `pnpm run build` أولًا أو استخدم صورة نشر مبنية.");
  process.exit(2);
}
import(pathToFileURL(built).href).catch(err => { console.error("فشل التشغيل:", err && err.message ? err.message : String(err)); process.exit(2); });
