import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  authorizeProductionMigration,
  readApprovalFile,
  isProductionAuthorization,
  productionConfirmPhrase,
  productionGate,
  runProductionMigration,
  PRODUCTION_MIGRATION_ENABLE_ENV,
  type MigrationTarget,
  type MigrationTargets,
} from "./productionMigration";

/** B1 — المسار المحمي لـProduction: كل بوابة ترفض وحدها، والإذن لا يُزوَّر، والمسار الكامل بمنفّذ وهمي (بلا قاعدة). */
const NOW = new Date("2026-10-22T10:00:00Z");
const UUID = "0d9c2f3e-1a2b-11ef-9c3d-0242ac120002";
const SHA = "16b8551f1e2d3fdc25fc8d6e02d4ffb3e05923dde254612afdad519ed5d36443";
const URL_OK = "mysql://migrator:S3cret@db.prod.internal:3306/default";
const target: MigrationTarget = {
  id: "prod-main", host: "db.prod.internal", port: 3306, database: "default", serverUuid: UUID,
  migrations: ["0040", "0041", "0045", "0052"], approvedBy: "owner", approvalRef: "REL-UNIFIED-1",
  approvedAt: "2026-10-22T06:00:00Z", expiresAt: "2026-10-22T20:00:00Z",
  backupSha256: SHA, backupRestoreVerifiedAt: "2026-10-22T08:00:00Z",
};
const targets = (t: Partial<MigrationTarget> = {}): MigrationTargets => ({ version: 1, targets: [{ ...target, ...t }] });
const env = { [PRODUCTION_MIGRATION_ENABLE_ENV]: "1", DEPLOY_ENV: "production" };
const ok = { env, databaseUrl: URL_OK, migrationId: "0041" as const, mode: "apply" as const, confirm: productionConfirmPhrase("0041", "apply", "default", "REL-UNIFIED-1"), backupSha256: SHA, targets: targets(), now: NOW };

describe("بوابات قبل أي اتصال", () => {
  it("المسار السليم يصدر إذنًا للهدف الموثّق", () => {
    const a = authorizeProductionMigration(ok);
    expect(isProductionAuthorization(a)).toBe(true);
    expect(a.confirm).toBe("APPLY 0041 TO default ON PRODUCTION REL-UNIFIED-1");
    expect(a.confirm).not.toContain(UUID.slice(0, 8));
    expect(Object.isFrozen(a)).toBe(true);
  });
  it.each([
    ["الافتراضي: بلا تفعيل صريح", { env: { DEPLOY_ENV: "production" } }, /معطّل افتراضيًا/],
    ["التفعيل بقيمة غير 1", { env: { ...env, [PRODUCTION_MIGRATION_ENABLE_ENV]: "true" } }, /معطّل افتراضيًا/],
    ["DEPLOY_ENV ليس production", { env: { ...env, DEPLOY_ENV: "staging" } }, /DEPLOY_ENV/],
    ["ملف الأهداف الملتزَم (فارغ)", { targets: JSON.parse(fs.readFileSync("scripts/migration-targets.json", "utf-8")) }, /غير موثّق/],
    ["مضيف مختلف", { databaseUrl: "mysql://m:x@db2.prod.internal:3306/default" }, /غير موثّق/],
    ["منفذ مختلف", { databaseUrl: "mysql://m:x@db.prod.internal:3307/default" }, /غير موثّق/],
    ["قاعدة مختلفة", { databaseUrl: "mysql://m:x@db.prod.internal:3306/default2" }, /غير موثّق/],
    ["migration خارج الموافقة", { migrationId: "0055" as const, confirm: productionConfirmPhrase("0055", "apply", "default", "REL-UNIFIED-1") }, /لا تشمل 0055/],
    ["موافقة بلا مرجع", { targets: targets({ approvalRef: "" }) }, /approvalRef/],
    ["موافقة بلا serverUuid صالح", { targets: targets({ serverUuid: "default" }) }, /serverUuid/],
    ["موافقة منتهية", { now: new Date("2026-10-22T21:00:00Z") }, /منتهية/],
    ["موافقة لم تبدأ", { now: new Date("2026-10-22T05:00:00Z") }, /لم تبدأ/],
    ["نافذة أطول من 24 ساعة", { targets: targets({ expiresAt: "2026-10-24T06:00:00Z" }) }, /أطول من 24 ساعة/],
    ["بلا بصمة نسخة احتياطية", { backupSha256: null }, /بصمة النسخة الاحتياطية لا تطابق/],
    ["بصمة نسخة احتياطية مختلفة", { backupSha256: SHA.replace(/^16/, "17") }, /بصمة النسخة الاحتياطية لا تطابق/],
    ["الموافقة بلا بصمة صالحة", { targets: targets({ backupSha256: "abc" }) }, /بلا بصمة نسخة احتياطية صالحة/],
    ["اختبار الاستعادة غير مسجّل", { targets: targets({ backupRestoreVerifiedAt: "" }) }, /اختبار استعادة/],
    ["اختبار الاستعادة أقدم من 24 ساعة", { targets: targets({ backupRestoreVerifiedAt: "2026-10-20T08:00:00Z" }) }, /اختبار استعادة/],
    ["عبارة تأكيد بلا ON PRODUCTION", { confirm: "APPLY 0041 TO default" }, /عبارة التأكيد/],
    ["عبارة تأكيد بمرجع موافقة آخر", { confirm: "APPLY 0041 TO default ON PRODUCTION REL-OTHER" }, /عبارة التأكيد/],
    ["approvalRef بصيغة غير صالحة", { targets: targets({ approvalRef: "a b" }) }, /approvalRef صالح/],
    ["rollback بلا allowRollback", { mode: "rollback" as const, confirm: productionConfirmPhrase("0041", "rollback", "default", "REL-UNIFIED-1") }, /rollback على Production غير مسموح/],
  ])("يرفض: %s", (_n, over, re) => { expect(() => authorizeProductionMigration({ ...ok, ...(over as any) })).toThrow(re as RegExp); });
  it("rollback مسموح فقط لو الموافقة تنص عليه", () => {
    const a = authorizeProductionMigration({ ...ok, mode: "rollback", confirm: productionConfirmPhrase("0041", "rollback", "default", "REL-UNIFIED-1"), targets: targets({ allowRollback: true }) });
    expect(a.mode).toBe("rollback");
  });
});

describe("بوابة الـrunner: الإذن لا يُزوَّر ولا يُنقل", () => {
  const a = authorizeProductionMigration(ok);
  it("الإذن الصادر لنفس الهدف والـmigration والوضع والعبارة يمر", () => { expect(productionGate(a, "0041", "apply", URL_OK, a.confirm)).toBeNull(); });
  it.each([
    ["كائن بنفس الحقول (ليس صادرًا)", () => productionGate(JSON.parse(JSON.stringify(a)), "0041", "apply", URL_OK, a.confirm), /غير صالح/],
    ["نسخة spread من الإذن", () => productionGate({ ...a }, "0041", "apply", URL_OK, a.confirm), /غير صالح/],
    ["migration أخرى", () => productionGate(a, "0042", "apply", URL_OK, a.confirm), /لا يخص/],
    ["وضع آخر", () => productionGate(a, "0041", "rollback", URL_OK, a.confirm), /لا يخص/],
    ["هدف آخر", () => productionGate(a, "0041", "apply", "mysql://m:x@other:3306/default", a.confirm), /لهدف آخر/],
    ["عبارة مختلفة", () => productionGate(a, "0041", "apply", URL_OK, "APPLY 0041 TO default"), /عبارة التأكيد/],
    ["undefined", () => productionGate(undefined, "0041", "apply", URL_OK, a.confirm), /غير صالح/],
  ])("يرفض: %s", (_n, f, re) => { expect(f()).toMatch(re as RegExp); });
});

describe("المسار الكامل بمنفّذ وهمي (الهوية ← القفل ← قبل ← تنفيذ ← بعد ← تدقيق)", () => {
  const exec = (o: { uuid?: string; db?: string; lock?: number } = {}) => {
    const log: string[] = [];
    return { log, open: async () => ({
      async query(sql: string) { log.push(sql);
        if (sql.startsWith("SELECT @@server_uuid")) return [{ uuid: o.uuid ?? UUID, db: o.db ?? "default" }];
        if (sql.startsWith("SELECT GET_LOCK")) return [{ got: o.lock ?? 1 }];
        if (sql.startsWith("SELECT RELEASE_LOCK")) return [{ r: 1 }];
        return [];
      }, async close() {} }) };
  };
  const runner = () => { let state = "not_applied", runs = 0; return {
    check: async () => ({ ok: true, state, refused: null, lines: [`state=${state}`] }),
    run: async () => { runs++; if (state === "not_applied") state = "applied"; return { ok: true, state, refused: null, lines: ["ran"] }; },
    get runs() { return runs; } }; };
  const auth = authorizeProductionMigration(ok);
  it("نجاح: يطبّق مرة واحدة، يتحقق بعدها، يطلق القفل، ويكتب تدقيقًا بلا أسرار", async () => {
    const e = exec(); const r = runner();
    const res = await runProductionMigration({ auth, databaseUrl: URL_OK, check: r.check, run: r.run, rollbackHint: "x", openExecutor: e.open as any });
    expect(res.ok).toBe(true); expect(r.runs).toBe(1);
    expect(res.audit).toMatchObject({ migration: "0041", before: "not_applied", after: "applied", ok: true, approvalRef: "REL-UNIFIED-1", backupVerified: true });
    for (const secret of [UUID, UUID.slice(0, 8), SHA, SHA.slice(0, 16), "db.prod.internal"]) expect(JSON.stringify(res), secret).not.toContain(secret);
    expect(e.log.some(q => q.startsWith("SELECT RELEASE_LOCK"))).toBe(true);
    expect(JSON.stringify(res)).not.toMatch(/S3cret|migrator|mysql:\/\//);
  });
  it("server_uuid مختلف = توقف قبل أي تنفيذ", async () => {
    const e = exec({ uuid: "11111111-2222-3333-4444-555555555555" }); const r = runner();
    const res = await runProductionMigration({ auth, databaseUrl: URL_OK, check: r.check, run: r.run, rollbackHint: "x", openExecutor: e.open as any });
    expect(res.ok).toBe(false); expect(res.refused).toMatch(/server_uuid/); expect(r.runs).toBe(0);
    expect(JSON.stringify(res)).not.toMatch(/11111111|0d9c2f3e/);
    expect(e.log.some(q => q.startsWith("SELECT GET_LOCK"))).toBe(false);
  });
  it("قاعدة مختلفة على نفس الخادم = توقف", async () => {
    const e = exec({ db: "other" }); const r = runner();
    expect((await runProductionMigration({ auth, databaseUrl: URL_OK, check: r.check, run: r.run, rollbackHint: "x", openExecutor: e.open as any })).ok).toBe(false);
    expect(r.runs).toBe(0);
  });
  it("قفل محجوز من تشغيل آخر = توقف قبل أي تنفيذ", async () => {
    const e = exec({ lock: 0 }); const r = runner();
    const res = await runProductionMigration({ auth, databaseUrl: URL_OK, check: r.check, run: r.run, rollbackHint: "x", openExecutor: e.open as any });
    expect(res.refused).toMatch(/قفل/); expect(r.runs).toBe(0);
  });
  it("فحص ما قبل فاشل (partial) = لا تنفيذ", async () => {
    const e = exec(); let runs = 0;
    const res = await runProductionMigration({ auth, databaseUrl: URL_OK, check: async () => ({ ok: false, state: "partial", refused: null, lines: [] }), run: async () => { runs++; return { ok: true, state: "applied", refused: null, lines: [] }; }, rollbackHint: "x", openExecutor: e.open as any });
    expect(res.ok).toBe(false); expect(runs).toBe(0);
  });
  it("الحالة بعد التنفيذ ليست applied = فشل مع أمر التراجع", async () => {
    const e = exec();
    const res = await runProductionMigration({ auth, databaseUrl: URL_OK, check: async () => ({ ok: true, state: "not_applied", refused: null, lines: [] }), run: async () => ({ ok: true, state: "not_applied", refused: null, lines: [] }), rollbackHint: "ROLLBACK-HINT", openExecutor: e.open as any });
    expect(res.ok).toBe(false); expect(res.lines.join("\n")).toContain("ROLLBACK-HINT");
  });
});

describe("ملف الموافقة وقت التشغيل (خارج المستودع، 600)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "b1-approval-"));
  const write = (name: string, body: unknown, mode = 0o600) => { const f = path.join(dir, name); fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body)); fs.chmodSync(f, mode); return f; };
  const repoRoot = process.cwd();
  it("مقبول: مسار مطلق خارج المستودع، 600، موافقة واحدة — ويرجع بصمة الملف لا محتواه", () => {
    const f = write("ok.json", targets());
    const r = readApprovalFile(f, { repoRoot });
    expect(r.targets.targets[0].approvalRef).toBe("REL-UNIFIED-1");
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    const a = authorizeProductionMigration({ ...ok, targets: r.targets, approvalFileSha256: r.sha256 });
    expect(a.approvalFileSha256).toBe(r.sha256);
  });
  it.each([
    ["مفقود (بلا --approval-file)", () => readApprovalFile(undefined, { repoRoot }), /ملف الموافقة مطلوب/],
    ["مسار نسبي", () => readApprovalFile("approval.json", { repoRoot }), /مطلقًا/],
    ["ملف غير موجود", () => readApprovalFile(path.join(dir, "missing.json"), { repoRoot }), /غير موجود/],
    ["داخل المستودع", () => readApprovalFile(path.join(repoRoot, "scripts", "migration-targets.json"), { repoRoot }), /خارج المستودع/],
    ["داخل دليل التشغيل", () => readApprovalFile(write("in-cwd.json", targets()), { repoRoot, cwd: dir }), /خارج المستودع/],
    ["صلاحيات 644", () => readApprovalFile(write("p644.json", targets(), 0o644), { repoRoot }), /صلاحيات ملف الموافقة غير آمنة/],
    ["صلاحيات 640", () => readApprovalFile(write("p640.json", targets(), 0o640), { repoRoot }), /صلاحيات ملف الموافقة غير آمنة/],
    ["صلاحيات 400", () => readApprovalFile(write("p400.json", targets(), 0o400), { repoRoot }), /المطلوب 600/],
    ["symlink لملف 600", () => { const real = write("real.json", targets()); const l = path.join(dir, "link.json"); fs.symlinkSync(real, l); return readApprovalFile(l, { repoRoot }); }, /لا symlink/],
    ["مالك مختلف", () => readApprovalFile(write("owner.json", targets()), { repoRoot, uid: 999_999 }), /غير مملوك/],
    ["JSON غير صالح", () => readApprovalFile(write("bad.json", "{not json"), { repoRoot }), /ليس JSON صالحًا/],
    ["أكثر من موافقة", () => readApprovalFile(write("two.json", { version: 1, targets: [target, target] }), { repoRoot }), /موافقة واحدة/],
  ])("يرفض: %s", (_n, f, re) => { expect(f).toThrow(re as RegExp); });
  it("رسائل الرفض لا تعرض أي جزء من محتوى الملف", () => {
    const secretish = { version: 1, targets: [{ ...target, approvalRef: "SECRET-REF-123", host: "secret-host.internal" }] };
    for (const mode of [0o644, 0o600]) {
      const f = write(`leak-${mode}.json`, mode === 0o600 ? JSON.stringify(secretish).slice(0, -3) : secretish, mode);
      let msg = ""; try { readApprovalFile(f, { repoRoot }); } catch (e) { msg = (e as Error).message; }
      expect(msg).not.toMatch(/SECRET-REF-123|secret-host|0d9c2f3e|16b8551f/);
    }
  });
  it("موافقة منتهية من ملف صالح = رفض", () => {
    const r = readApprovalFile(write("expired.json", targets({ approvedAt: "2026-10-20T06:00:00Z", expiresAt: "2026-10-20T20:00:00Z" })), { repoRoot });
    expect(() => authorizeProductionMigration({ ...ok, targets: r.targets })).toThrow(/منتهية/);
  });
});

describe("فحوص ثابتة", () => {
  it("الـCLI يأخذ الموافقة من --approval-file فقط ويفحص التفعيل قبل قراءة الملف", () => {
    const s = fs.readFileSync("scripts/_productionMigrationCli.ts", "utf-8");
    expect(s).toContain('readApprovalFile(opt("--approval-file")');
    expect(s.indexOf("assertProductionEnabled(process.env)")).toBeLessThan(s.indexOf("readApprovalFile(opt("));
    expect(fs.readFileSync("server/productionMigration.ts", "utf-8")).not.toMatch(/serverUuid\.slice|serverUuidPrefix/);
  });
  it("ملف الأهداف المعتمدة الملتزَم فارغ", () => {
    expect(JSON.parse(fs.readFileSync("scripts/migration-targets.json", "utf-8"))).toEqual({ version: 1, targets: [] });
  });
  it("كل سكربت migrate-00XX يمر بالمسار المحمي (لا runner منسي)", () => {
    const scripts = fs.readdirSync("scripts").filter(f => /^migrate-00\d\d-.*\.ts$/.test(f));
    expect(scripts.length).toBe(14);
    for (const f of scripts) {
      const s = fs.readFileSync(`scripts/${f}`, "utf-8");
      expect(s.includes("runHandMigrationCli(") || s.includes("runProductionCli("), f).toBe(true);
    }
  });
  it("كل runner يقبل الإنتاج عبر productionGate فقط، والبوابة القديمة كما هي", () => {
    for (const f of ["server/handMigration.service.ts", "server/ledgerV3Migrate.service.ts", "server/roleEnumMigration.service.ts", "server/ledgerKindsMigration.service.ts"]) {
      const s = fs.readFileSync(f, "utf-8");
      expect(s, f).toMatch(/productionGate\(opts\.production, /);
    }
    expect(fs.readFileSync("server/handMigration.service.ts", "utf-8")).toContain('if (target.production) return "القاعدة تبدو إنتاجًا — مرفوض دائمًا";');
  });
  it("السكربتات لا تقبل ملف أهداف بديلًا ولا تطبع الرابط", () => {
    for (const f of ["scripts/_productionMigrationCli.ts", "scripts/_handMigrationCli.ts", "scripts/migrate-0040-ledger-v3.ts", "scripts/migrate-0045-roles.ts"]) {
      const s = fs.readFileSync(f, "utf-8");
      expect(s, f).not.toMatch(/--targets-file|MIGRATION_TARGETS_PATH|readMigrationTargets/);
      expect(s, f).not.toMatch(/console\.(log|error)\([^)]*\burl\b/);
    }
  });
});
