import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * سجل حظر/رفع الكتابات القديمة (0051) دائم: لا مسار UPDATE/DELETE له في كود التطبيق أو السكربتات، ولا تعريف Drizzle له (فلا
 * `.update()`/`.delete()` عبر الـORM)، والإدراج في موضعين فقط (الاستعادة، وإعادة الحظر داخل التفعيل)، ولا Router يكشف الرفع.
 */
const ROOT = path.resolve(__dirname, "..");
const T = "ledger_legacy_archive_events";
function files(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? (d.name === "node_modules" ? [] : files(path.join(dir, d.name))) : /\.(ts|tsx|mjs|cjs|js)$/.test(d.name) && !/\.test\.tsx?$/.test(d.name) ? [path.join(dir, d.name)] : []);
}
const SOURCES = [...files("server"), ...files("scripts"), ...files("shared"), ...files("drizzle"), ...files("client/src")];

describe("🧾 سجل الأرشيف (0051) للإضافة فقط", () => {
  it("لا UPDATE ولا DELETE ولا TRUNCATE ولا REPLACE على الجدول في أي ملف غير اختبار", () => {
    const bad = SOURCES.filter(f => new RegExp(`(UPDATE|DELETE\\s+FROM|TRUNCATE(\\s+TABLE)?|REPLACE\\s+INTO)\\s+\`?${T}`, "i").test(fs.readFileSync(path.join(ROOT, f), "utf-8")));
    expect(bad).toEqual([]);
  });

  it("لا تعريف Drizzle للجدول، والإدراج في الاستعادة وإعادة الحظر فقط، ولا Router يكشفهما", () => {
    expect(SOURCES.filter(f => f.startsWith("drizzle") && fs.readFileSync(path.join(ROOT, f), "utf-8").includes(`"${T}"`))).toEqual([]);
    const inserts = SOURCES.filter(f => new RegExp(`INSERT\\s+INTO\\s+\`?${T}`, "i").test(fs.readFileSync(path.join(ROOT, f), "utf-8"))).sort();
    expect(inserts).toEqual([path.join("server", "legacyFinanceArchive.ts"), path.join("server", "legacyRecovery.service.ts")]);
    const routers = SOURCES.filter(f => /router/i.test(f) && /legacyRecovery|takeStopSnapshot|recoverLegacyFromSnapshot/.test(fs.readFileSync(path.join(ROOT, f), "utf-8")));
    expect(routers).toEqual([]);
  });
});
