import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { build } from "esbuild";

/**
 * حارس صورة النشر: أدوات التشغيل (verify-ledger-v3 / activate-ledger-v3 / verify-ledger-v3-runtime /
 * migrate-0040-ledger-v3 / disable-ledger-v3) يجب أن تعمل داخل صورة Coolify بـ`node` العادي —
 * لا tsx ولا devDependencies. يُثبت ذلك فعليًا: يبني الحزم بنفس أمر build ثم يشغّلها بـnode بلا
 * DATABASE_URL فتتوقف برسالة عربية واضحة (أي أن التحميل كله نجح بلا أدوات تطوير).
 */
const ROOT = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const OPS = ["verify-ledger-v3", "activate-ledger-v3", "verify-ledger-v3-runtime", "migrate-0040-ledger-v3", "disable-ledger-v3"] as const;
const RUNTIME_DEPS = ["mysql2", "drizzle-orm", "jsonwebtoken", "dotenv"];
const codeOnly = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

describe("🚢 أدوات التشغيل داخل صورة النشر (node فقط، بلا tsx/devDependencies)", () => {
  it("build يبني الحزم الخمس إلى dist/scripts/*.mjs بنفس طريقة dist/index.js، والاعتمادات وقت التشغيل في dependencies لا devDependencies", () => {
    // جزء السكربتات داخل build نفسه (لا استدعاء لمدير حزم قد لا يكون على PATH)
    const ops: string = pkg.scripts.build.split("&&").find((p: string) => p.includes("--outdir=dist/scripts")) ?? "";
    expect(ops).not.toBe("");
    for (const name of OPS) expect(ops).toContain(`scripts/${name}.ts`);
    expect(ops).toContain("--packages=external");
    expect(ops).toContain("--format=esm");
    expect(ops).toContain("--outdir=dist/scripts");
    expect(ops).toContain("--out-extension:.js=.mjs");
    for (const d of RUNTIME_DEPS) { expect(pkg.dependencies[d], d).toBeTruthy(); expect(pkg.devDependencies?.[d], `${d} must not be dev-only`).toBeUndefined(); }
    // لا drizzle-kit push/generate في مسار التشغيل (الكود بلا تعليقات)
    for (const name of OPS) expect(codeOnly(fs.readFileSync(path.join(ROOT, `scripts/${name}.ts`), "utf-8"))).not.toMatch(/drizzle-kit/);
  });

  it("المشغّلان scripts/*.cjs يستدعيان النسخة المبنية بـnode العادي ويفشلان برسالة واضحة إن لم تُبنَ", () => {
    for (const name of ["migrate-0040-ledger-v3", "disable-ledger-v3"]) {
      const src = fs.readFileSync(path.join(ROOT, `scripts/${name}.cjs`), "utf-8");
      expect(src).toContain(`"dist", "scripts", "${name}.mjs"`);
      expect(codeOnly(src)).not.toMatch(/tsx|ts-node/);
    }
  });

  it("الحزم الخمس تُبنى فعلًا وتعمل بـnode بلا DATABASE_URL فتتوقف برسالة عربية (رمز 2) بلا أي سر في المخرجات", async () => {
    // داخل المشروع (لا os.tmpdir) حتى تُحلّ الاعتمادات الخارجية من node_modules كما في صورة النشر
    fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
    const out = fs.mkdtempSync(path.join(ROOT, "dist", "guard-"));
    try {
      await build({
        entryPoints: OPS.map(n => path.join(ROOT, `scripts/${n}.ts`)), bundle: true, platform: "node", packages: "external", format: "esm",
        outdir: out, outExtension: { ".js": ".mjs" }, logLevel: "silent", absWorkingDir: ROOT,
      });
      const args: Record<(typeof OPS)[number], string[]> = {
        "verify-ledger-v3": [], "activate-ledger-v3": ["--tenant", "1"], "verify-ledger-v3-runtime": ["--tenant", "1"],
        "migrate-0040-ledger-v3": ["--check"], "disable-ledger-v3": ["--tenant", "1", "--actor", "1", "--reason", "فحص"],
      };
      for (const name of OPS) {
        const bundle = path.join(out, `${name}.mjs`);
        expect(fs.existsSync(bundle), name).toBe(true);
        const r = spawnSync(process.execPath, [bundle, ...args[name]], { cwd: out, encoding: "utf-8", timeout: 60_000, env: { ...process.env, DATABASE_URL: "", TEST_DATABASE_URL: "", NODE_PATH: "", NODE_OPTIONS: "" } });
        const text = `${r.stdout}\n${r.stderr}`;
        expect(r.status, `${name}: ${text}`).toBe(2);
        expect(text).toContain("DATABASE_URL غير مضبوط");
        expect(text).not.toMatch(/mysql:\/\/|password|SyntaxError|Cannot find module/i);
      }
    } finally {
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
