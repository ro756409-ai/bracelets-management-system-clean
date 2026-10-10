import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { builtinModules } from "module";
import { build } from "esbuild";

/**
 * سكربتات النشر تعمل بـ`node dist/scripts/<x>.mjs` فقط — بلا npx/tsx/devDependencies.
 *  • القائمة من أمر build في package.json نفسه (مصدر واحد)، وتُبنى بنفس خيارات esbuild.
 *  • كل bundle لا يستورد إلا وحدات node المدمجة أو dependencies الإنتاج (لا devDependencies).
 *  • كل سكربت يُشغَّل بـnode من مجلد عمل محايد بلا DATABASE_URL ⇒ يصل لرسالة التحقق المتوقعة (exit 2)،
 *    لا خطأ import ولا module missing.
 *  • سكربتات 0041/0042/0044 تجد ملف SQL نسبةً لمكانها (dist/scripts/../../drizzle) حتى من مجلد عمل آخر.
 * لا اتصال بأي قاعدة حقيقية: لا DATABASE_URL، وفحص SQL يستخدم منفذًا محليًا مغلقًا فقط.
 */
const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const buildCmd: string = pkg.scripts.build;
const scriptsPart = buildCmd.slice(buildCmd.lastIndexOf("esbuild scripts/"));
const ENTRIES = scriptsPart.split(/\s+/).filter(t => /^scripts\/[\w-]+\.ts$/.test(t));
const OUT = path.join(ROOT, "node_modules", ".cache", "matjarak-dist-scripts-guard");
const PROD = new Set(Object.keys(pkg.dependencies));
const BUILTIN = new Set([...builtinModules, ...builtinModules.map(m => `node:${m}`)]);

/** الملفات المطلوبة للنشر (0041/0042/0044/Tenant Access) — يجب أن تكون ضمن أمر build. */
export const DEPLOY_SCRIPTS = [
  "migrate-0041-order-events", "verify-order-events", "preview-order-events-backfill",
  "migrate-0042-attendance", "verify-attendance", "reconcile-attendance",
  "migrate-0044-teams", "verify-teams",
  "preview-tenant-access",
] as const;

/** وسائط تجاوز فحص الوسائط الأول لسكربتات 0040 (خارج هذه المرحلة) حتى تصل لفحص DATABASE_URL — لا اتصال. */
const ARGS: Record<string, string[]> = {
  "activate-ledger-v3": ["--tenant", "1"], "verify-ledger-v3-runtime": ["--tenant", "1"], "disable-ledger-v3": ["--tenant", "1", "--actor", "1"],
};
const runNode = (file: string, env: Record<string, string>, cwd: string, args: string[] = []) =>
  spawnSync(process.execPath, [file, ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), ...env }, encoding: "utf-8", timeout: 30_000 });

describe("📦 سكربتات النشر — node فقط", () => {
  beforeAll(async () => {
    fs.rmSync(OUT, { recursive: true, force: true });
    await build({ entryPoints: ENTRIES.map(e => path.join(ROOT, e)), platform: "node", packages: "external", bundle: true, format: "esm", outdir: OUT, outExtension: { ".js": ".mjs" }, logLevel: "silent", absWorkingDir: ROOT });
  }, 120_000);

  it("أمر build يتضمن كل سكربتات 0041/0042/0044/Tenant Access", () => {
    for (const s of DEPLOY_SCRIPTS) expect(ENTRIES, s).toContain(`scripts/${s}.ts`);
    expect(buildCmd).toContain("--outdir=dist/scripts --out-extension:.js=.mjs");
  });

  it("لا bundle يستورد devDependency أو حزمة غير مصرّح بها", () => {
    for (const e of ENTRIES) {
      const code = fs.readFileSync(path.join(OUT, `${path.basename(e, ".ts")}.mjs`), "utf-8");
      const specs = [...code.matchAll(/(?:^|\n)\s*import\s+(?:[^"']*?from\s+)?["']([^"']+)["']/g), ...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1]);
      for (const s of specs) {
        if (s.startsWith(".") || s.startsWith("/")) throw new Error(`${e}: استيراد نسبي متبقٍ ${s}`);
        const name = s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0];
        expect(BUILTIN.has(s) || BUILTIN.has(name) || PROD.has(name), `${e} → ${s}`).toBe(true);
      }
    }
  });

  it("كل سكربت يعمل بـnode بلا DATABASE_URL ⇒ رسالة التحقق المتوقعة، لا خطأ تحميل", () => {
    const neutral = fs.mkdtempSync(path.join(os.tmpdir(), "mj-scripts-"));
    for (const e of ENTRIES) {
      const r = runNode(path.join(OUT, `${path.basename(e, ".ts")}.mjs`), {}, neutral, ARGS[path.basename(e, ".ts")]);
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out, e).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package|SyntaxError|ReferenceError/);
      expect(out, e).toContain("DATABASE_URL غير مضبوط");
      expect(r.status, e).toBe(2);
    }
  }, 120_000);

  it("0041/0042/0044 تجد ملف SQL نسبةً لمكان السكربت حتى من مجلد عمل آخر (منفذ محلي مغلق، لا قاعدة حقيقية)", () => {
    const neutral = fs.mkdtempSync(path.join(os.tmpdir(), "mj-scripts-"));
    const distLike = path.join(ROOT, "dist", "scripts");
    for (const s of ["migrate-0041-order-events", "migrate-0042-attendance", "migrate-0044-teams"]) {
      // نفس موضع النشر (dist/scripts) حتى يكون ../../drizzle هو جذر المشروع.
      fs.mkdirSync(distLike, { recursive: true });
      const target = path.join(distLike, `__guard-${s}.mjs`);
      fs.copyFileSync(path.join(OUT, `${s}.mjs`), target);
      try {
        const r = runNode(target, { DATABASE_URL: "mysql://guard:guard@127.0.0.1:9/none" }, neutral);
        const out = `${r.stdout}\n${r.stderr}`;
        expect(out, s).not.toContain("غير موجود — شغّل الأمر من جذر المشروع");
        expect(out, s).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find module/);
        expect(r.status, s).not.toBe(0);
      } finally { fs.rmSync(target, { force: true }); }
    }
  }, 120_000);
});
