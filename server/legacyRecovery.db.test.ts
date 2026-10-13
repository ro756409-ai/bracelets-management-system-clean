import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { drizzle } from "drizzle-orm/mysql2";
import { __setDbForTests, createEmployee, createExpense, addTreasuryTransactionInTransaction, getDb } from "./db";
import { postFinancialTransactionInTransaction } from "./accountingV2.service";
import { confirmPhrase, runHandMigration } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { LEDGER_LEGACY_ARCHIVE_MIGRATION } from "./ledgerPhaseMigrations";
import { activateLedgerV3, disableLedgerV3, postLedgerTransaction } from "./ledgerV3.service";
import { ensureDailyAccounts } from "./ledgerDaily.service";
import { assertLegacyFinanceWritable } from "./legacyFinanceArchive";
import { recoverLegacyFromSnapshot, recoveryConfirmPhrase, takeStopSnapshot, type RecoveryPlan, type ZeroTarget } from "./legacyRecovery.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";

/**
 * 0051 + خطة الرجوع «توقف ومطابقة» على قاعدة مؤقتة محلية فقط:
 *  • الصورة والاستعادة للمالك الفعّال من نفس الشركة فقط، وأثناء توقف الشركة (suspended + الإيقاف مُطبَّق) وV3 مطفأ.
 *  • الاستعادة: بصمة الصورة (المخزنة/المحسوبة/الممرّرة) وأرقام V3 بلا حركة منذها، خريطة كاملة، **الفرق فقط** فوق أرصدة V1/V2
 *    القائمة (بلا تضاعف ولا حذف تاريخ)، تحقق بعد الإدخال، وأي فشل = rollback كامل (لا رفع، الحظر قائم، الشركة متوقفة).
 *  • منع التكرار والتزامن: replay بلا كتابة؛ استعادتان متزامنتان = تنفيذ واحد.
 *  • إعادة التفعيل بعد الرفع تعيد الحظر داخل معاملتها، ولا يتغلب رفع قديم حتى مع نفس enabledAt.
 *  • السكربت نفسه (tsx) على القاعدة المؤقتة: dry-run، وبوابات عبارة التأكيد والهدف الإنتاجي.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? e?.name ?? "ERR"; } }

describe.runIf(CAN)("♻️ 0051 — حظر الكتابات القديمة ورفعه بالاستعادة المضبوطة", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture, C: CoreTestFixture;
  const e: Record<string, number> = {};
  const acc: Record<string, number> = {};
  let v2Main = 0, v2Old = 0;
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const n = async (s: string, p: unknown[] = []) => Number((await q(s, p))[0].n);
  const prevEnforce = process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED;
  const events = () => n("SELECT COUNT(*) n FROM ledger_legacy_archive_events WHERE tenantId = ? AND action IN ('lift','recovery')", [A.tenantId]);
  const legacyRows = async () => (await n("SELECT COUNT(*) n FROM treasury_transactions WHERE businessId = ?", [A.businessId])) + (await n("SELECT COUNT(*) n FROM financial_transactions WHERE businessId = ?", [A.businessId]));
  const banned = async () => (await code(async () => assertLegacyFinanceWritable((await getDb())!, A.businessId))) !== "ok";
  const v1Balance = async () => String((await q("SELECT balanceAfter b FROM treasury_transactions WHERE businessId = ? ORDER BY id DESC LIMIT 1", [A.businessId]))[0].b);
  const v2Balance = async (id: number) => String((await q("SELECT currentBalance b FROM financial_accounts WHERE id = ?", [id]))[0].b);
  const v3Expense = (date: string, amount: string, key: string) => postLedgerTransaction({ tenantId: A.tenantId, sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: key, effectiveDate: date, currency: "EGP",
    actor: { type: "employee", employeeId: e.ownerA }, description: "إيجار", sourceType: null, sourceReference: null,
    entries: [{ accountId: acc.EXP_RENT, side: "debit", amount, businessId: A.businessId }, { accountId: acc.OFFICE_CASH, side: "credit", amount, businessId: A.businessId }] } as any);
  const plan = (snapshotEventId: number, figuresHash: string, over: Partial<RecoveryPlan> = {}): RecoveryPlan => ({
    snapshotEventId, figuresHash,
    cash: [{ code: "OFFICE_CASH", target: { kind: "v1_treasury", businessId: A.businessId } }, { code: "BANK_MAIN", target: { kind: "v2_account", accountId: v2Main } }],
    acknowledgedNonCash: ["EXP_RENT", "OPENING_EQUITY"], zeroTargets: [zeroOld()], ...over,
  });
  const zeroOld = (over: Partial<ZeroTarget> = {}): ZeroTarget => ({ target: { kind: "v2_account", accountId: v2Old }, reconciledBalance: "50", explanation: "محفظة قديمة أُغلقت قبل التفعيل ولم تُنقل إلى V3",
    evidenceRef: "محضر جرد 2026-09-01 رقم 7", approvedByEmployeeId: e.ownerA, ...over });
  const recover = (snapId: number, hash: string, over: Partial<RecoveryPlan> = {}, actor = e.ownerA, extra: Record<string, unknown> = {}) =>
    recoverLegacyFromSnapshot({ tenantId: A.tenantId, actorEmployeeId: actor, reason: "توقف ومطابقة بعد عطل", plan: plan(snapId, hash, over), apply: true, ...extra });

  beforeAll(async () => {
    process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED = "true";
    tmp = await createTempSchema("legacy_rec");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    expect((await runHandMigration(LEDGER_LEGACY_ARCHIVE_MIGRATION, { databaseUrl: tmp.url, mode: "apply", sqlText: fs.readFileSync("drizzle/0051_ledger_legacy_archive.sql", "utf-8"), deployEnv: "test", confirm: confirmPhrase("0051", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("lr-a"); B = await createCoreTestFixture("lr-b"); C = await createCoreTestFixture("lr-c");
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-lr`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("amA", "accounts_manager", A); await mk("accA", "accountant", A); await mk("ownerB", "super_admin", B); await mk("ownerC", "super_admin", C);
    // تاريخ V1/V2 قبل التفعيل: خزنة V1 = 1000، حساب V2 رئيسي = 500، ومحفظة V2 قديمة = 50 بلا مقابل في V3
    const db = await getDb();
    await db!.transaction(tx => addTreasuryTransactionInTransaction(tx, { businessId: A.businessId, type: "deposit", direction: "in", amount: "1000", description: "رصيد قديم", performedBy: e.ownerA, performedByName: "مالك" } as any));
    const v2 = async (code: string) => insId(await q("INSERT INTO financial_accounts (businessId, code, name, accountType, isCashEquivalent, allowNegativeBalance, currencyCode, openingBalance, currentBalance) VALUES (?, ?, ?, 'bank', 1, 0, 'EGP', 0, 0)", [A.businessId, code, code]));
    v2Main = await v2("BANK-OLD"); v2Old = await v2("WALLET-OLD");
    for (const [id, amount] of [[v2Main, "500"], [v2Old, "50"]] as const)
      await db!.transaction(tx => postFinancialTransactionInTransaction(tx, { businessId: A.businessId, transactionType: "deposit", targetAccountId: id, amount, currencyCode: "EGP", description: "قديم", evidenceUrl: "old", occurredAt: new Date(), actor: { id: e.ownerA, name: "مالك" } }));
    await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-09-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-08-31T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-08-31T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "5000", BANK_MAIN: "800" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] } } as any);
    await ensureDailyAccounts({ tenantId: A.tenantId, businessIds: [A.businessId], actor: { type: "employee", employeeId: e.ownerA } });
    for (const r of await q("SELECT id, code FROM ledger_accounts WHERE tenantId = ?", [A.tenantId])) acc[r.code] = r.id;
    await v3Expense("2026-09-10", "300", "lr-exp-1");
  }, 300_000);
  afterAll(async () => {
    if (prevEnforce === undefined) delete process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED; else process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED = prevEnforce;
    __setDbForTests(null); await tmp?.drop();
  }, 120_000);

  it("التفعيل يسجّل reapply داخل معاملته؛ الإطفاء لا يرفع الحظر؛ والصورة مرفوضة قبل التوقف الكامل ولغير المالك ولشركة لم تُفعّل", async () => {
    expect(await n("SELECT COUNT(*) n FROM ledger_legacy_archive_events WHERE tenantId = ? AND action = 'reapply'", [A.tenantId])).toBe(1);
    expect(await banned()).toBe(true);
    const snap = (actor = e.ownerA, tenantId = A.tenantId) => code(() => takeStopSnapshot({ tenantId, actorEmployeeId: actor, reason: "توقف للمطابقة", apply: true }));
    expect(await snap()).toBe("v3Enabled");
    await disableLedgerV3({ tenantId: A.tenantId, actor: { type: "employee", employeeId: e.ownerA }, reason: "عطل — توقف ومطابقة" });
    expect(await banned()).toBe(true);
    expect(await snap()).toBe("notSuspended");
    await q("UPDATE tenants SET status = 'suspended' WHERE id = ?", [A.tenantId]);
    process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED = "false";
    expect(await snap()).toBe("enforcement");
    process.env.TENANT_ACCESS_ENFORCEMENT_ENABLED = "true";
    expect(await snap(e.amA)).toBe("actor");
    expect(await snap(e.accA)).toBe("actor");
    expect(await snap(e.ownerB)).toBe("actor");                 // مالك شركة أخرى (FK وحده لا يكفي — الفحص بالشركة والدور)
    expect(await snap(e.ownerC, C.tenantId)).toBe("neverActivated");
    expect(await n("SELECT COUNT(*) n FROM ledger_legacy_archive_events WHERE action = 'stop_snapshot'")).toBe(0);
    // شركة لم تُفعّل: السلوك القديم كما هو
    await createExpense({ businessId: C.businessId, amount: "10", description: "شركة لم تفعّل", expenseDate: new Date(), createdBy: e.ownerC, createdByName: "مالك" } as any);
  });

  it("الصورة: dry-run بلا كتابة، apply مرة واحدة ببصمة، ونفس الأرقام = replay؛ والاستعادة ترفض البصمة الخاطئة والتلاعب وحركة V3 بعد الصورة", async () => {
    const dry = await takeStopSnapshot({ tenantId: A.tenantId, actorEmployeeId: e.ownerA, reason: "توقف للمطابقة", apply: false });
    expect([dry.applied, dry.snapshotEventId]).toEqual([false, null]);
    expect(dry.figures.balances.find(b => b.code === "OFFICE_CASH")?.balance).toBe("4700.0000");
    const s1 = await takeStopSnapshot({ tenantId: A.tenantId, actorEmployeeId: e.ownerA, reason: "توقف للمطابقة", apply: true });
    expect(s1.figuresHash).toBe(dry.figuresHash);
    const again = await takeStopSnapshot({ tenantId: A.tenantId, actorEmployeeId: e.ownerA, reason: "توقف للمطابقة", apply: true });
    expect([again.replay, again.snapshotEventId]).toEqual([true, s1.snapshotEventId]);
    const rows0 = await legacyRows();
    expect(await code(() => recover(s1.snapshotEventId!, "0".repeat(64)))).toBe("hashMismatch");
    // تلاعب بالـJSON المخزن (محاكاة على مستوى القاعدة — التطبيق لا يملك مسار تعديل) ⇒ البصمة لا تطابق
    const orig = (await q("SELECT figuresJson j FROM ledger_legacy_archive_events WHERE id = ?", [s1.snapshotEventId]))[0].j;
    await q("UPDATE ledger_legacy_archive_events SET figuresJson = JSON_SET(figuresJson, '$.lastTransactionId', 999999) WHERE id = ?", [s1.snapshotEventId]);
    expect(await code(() => recover(s1.snapshotEventId!, s1.figuresHash))).toBe("hashMismatch");
    await q("UPDATE ledger_legacy_archive_events SET figuresJson = ? WHERE id = ?", [typeof orig === "string" ? orig : JSON.stringify(orig), s1.snapshotEventId]);
    // حركة V3 بعد الصورة (تشغيل مؤقت للعلم مباشرة ثم إطفاؤه) ⇒ الأرقام تغيّرت
    await q("UPDATE ledger_tenant_flags SET ledgerV3Enabled = 1 WHERE tenantId = ?", [A.tenantId]);
    await v3Expense("2026-09-12", "200", "lr-exp-2");
    await q("UPDATE ledger_tenant_flags SET ledgerV3Enabled = 0 WHERE tenantId = ?", [A.tenantId]);
    expect(await code(() => recover(s1.snapshotEventId!, s1.figuresHash))).toBe("v3Moved");
    expect([await events(), await legacyRows(), await banned()]).toEqual([0, rows0, true]);
  });

  it("الخريطة الكاملة إلزامية، والمدير/المحاسب لا يرفعان الحظر — كل رفض بلا أي أثر", async () => {
    const s2 = await takeStopSnapshot({ tenantId: A.tenantId, actorEmployeeId: e.ownerA, reason: "صورة بعد التحقيق", apply: true });
    const rows0 = await legacyRows();
    const h = s2.figuresHash, id = s2.snapshotEventId!;
    expect(await code(() => recover(id, h, {}, e.amA))).toBe("actor");
    expect(await code(() => recover(id, h, {}, e.accA))).toBe("actor");
    expect(await code(() => recover(id, h, {}, e.ownerB))).toBe("actor");
    expect(await code(() => recover(id, h, { cash: [{ code: "OFFICE_CASH", target: { kind: "v1_treasury", businessId: A.businessId } }] }))).toBe("mapping");                       // بنك بلا هدف
    expect(await code(() => recover(id, h, { acknowledgedNonCash: ["OPENING_EQUITY"] }))).toBe("mapping");                                                                       // مصروف غير مُقرّ به
    expect(await code(() => recover(id, h, { acknowledgedNonCash: ["EXP_RENT", "OPENING_EQUITY", "BANK_MAIN"] }))).toBe("mapping");                                           // إقرار بنقدي
    // تصفير هدف قديم لا يُقبل لمجرد غياب مقابل في V3: غير المحسوم يمنع التنفيذ
    expect(await code(() => recover(id, h, { zeroTargets: [] }))).toBe("unresolved");                                                     // خارج الخريطة
    expect(await code(() => recover(id, h, { zeroTargets: [zeroOld({ explanation: "قديم" })] }))).toBe("unresolved");                     // بلا تفسير موثّق
    expect(await code(() => recover(id, h, { zeroTargets: [zeroOld({ evidenceRef: "" })] }))).toBe("unresolved");                         // بلا مرجع مطابقة
    expect(await code(() => recover(id, h, { zeroTargets: [zeroOld({ reconciledBalance: "40" })] }))).toBe("unresolved");                 // مطابقة لا تساوي الرصيد الحالي
    expect(await code(() => recover(id, h, { zeroTargets: [zeroOld({ reconciledBalance: undefined as any })] }))).toBe("unresolved");     // بلا رصيد مطابَق
    expect(await code(() => recover(id, h, { zeroTargets: [zeroOld({ approvedByEmployeeId: e.amA })] }))).toBe("unresolved");             // اعتماد مدير الحسابات
    expect(await code(() => recover(id, h, { zeroTargets: [zeroOld({ approvedByEmployeeId: e.ownerB })] }))).toBe("unresolved");          // اعتماد مالك شركة أخرى
    expect(await code(() => recover(id, h, { zeroTargets: [zeroOld({ approvedByEmployeeId: undefined as any })] }))).toBe("unresolved");  // بلا اعتماد
    expect(await code(() => recover(id, h, { cash: [{ code: "OFFICE_CASH", target: { kind: "v2_account", accountId: v2Main } }, { code: "BANK_MAIN", target: { kind: "v2_account", accountId: v2Main } }] }))).toBe("mapping"); // هدف مكرر
    expect(await code(() => recover(id, h, { cash: [{ code: "OFFICE_CASH", target: { kind: "v1_treasury", businessId: B.businessId } }, { code: "BANK_MAIN", target: { kind: "v2_account", accountId: v2Main } }] }))).toBe("mapping"); // نشاط شركة أخرى
    expect([await events(), await legacyRows(), await banned()]).toEqual([0, rows0, true]);
    // V1 بأكثر من منزلتين: حركة V3 بكسور ثم صورة جديدة
    await q("UPDATE ledger_tenant_flags SET ledgerV3Enabled = 1 WHERE tenantId = ?", [A.tenantId]);
    await v3Expense("2026-09-13", "0.005", "lr-exp-3");
    await q("UPDATE ledger_tenant_flags SET ledgerV3Enabled = 0 WHERE tenantId = ?", [A.tenantId]);
    const s3 = await takeStopSnapshot({ tenantId: A.tenantId, actorEmployeeId: e.ownerA, reason: "صورة بكسور", apply: true });
    expect(await code(() => recover(s3.snapshotEventId!, s3.figuresHash))).toBe("mapping");
    // كسر ثانٍ يُكمل المنزلتين (4499.99) — لا تعديل ولا حذف لأي قيد
    await q("UPDATE ledger_tenant_flags SET ledgerV3Enabled = 1 WHERE tenantId = ?", [A.tenantId]);
    await v3Expense("2026-09-13", "0.005", "lr-exp-4");
    await q("UPDATE ledger_tenant_flags SET ledgerV3Enabled = 0 WHERE tenantId = ?", [A.tenantId]);
  });

  it("فشل أثناء الإدخال (بعد الترحيل وقبل التحقق) = rollback كامل: لا رفع، لا حركة V1/V2، الحظر قائم، والشركة متوقفة", async () => {
    const s = await takeStopSnapshot({ tenantId: A.tenantId, actorEmployeeId: e.ownerA, reason: "صورة نهائية", apply: true });
    const rows0 = await legacyRows();
    const before = [await v1Balance(), await v2Balance(v2Main), await v2Balance(v2Old)];
    expect(await code(() => recover(s.snapshotEventId!, s.figuresHash, {}, e.ownerA, { __afterPostingForTests: async () => { throw new Error("انقطاع محاكى"); } }))).toBe("Error");
    expect([await events(), await legacyRows(), await banned()]).toEqual([0, rows0, true]);
    expect([await v1Balance(), await v2Balance(v2Main), await v2Balance(v2Old)]).toEqual(before);
    expect((await q("SELECT status FROM tenants WHERE id = ?", [A.tenantId]))[0].status).toBe("suspended");
  });

  it("النجاح: استعادتان متزامنتان = تنفيذ واحد؛ الفرق فقط فوق V1/V2 القائمة بلا حذف تاريخ؛ الأرصدة = الصورة؛ الحظر مرفوع والشركة ما زالت متوقفة؛ replay بلا كتابة", async () => {
    const s = await takeStopSnapshot({ tenantId: A.tenantId, actorEmployeeId: e.ownerA, reason: "صورة نهائية", apply: true });
    expect(s.replay).toBe(true); // نفس أرقام الاختبار السابق (لم يُكتب شيء بعدها)
    const cash = s.figures.balances.find(b => b.code === "OFFICE_CASH")!.balance, bank = s.figures.balances.find(b => b.code === "BANK_MAIN")!.balance;
    expect([cash, bank]).toEqual(["4499.9900", "800.0000"]);
    const oldV1 = await q("SELECT id, amount, balanceAfter FROM treasury_transactions WHERE businessId = ? ORDER BY id", [A.businessId]);
    const oldV2 = await q("SELECT id, amount FROM financial_transactions WHERE businessId = ? ORDER BY id", [A.businessId]);
    const [r1, r2] = await Promise.all([recover(s.snapshotEventId!, s.figuresHash), recover(s.snapshotEventId!, s.figuresHash)]);
    expect([r1.replay, r2.replay].sort()).toEqual([false, true]);
    expect(await n("SELECT COUNT(*) n FROM ledger_legacy_archive_events WHERE tenantId = ? AND action = 'lift'", [A.tenantId])).toBe(1);
    expect(await n("SELECT COUNT(*) n FROM ledger_legacy_archive_events WHERE tenantId = ? AND action = 'recovery'", [A.tenantId])).toBe(1);
    // V1: 1000 قائمة + فرق 3499.99 (لا 4499.99 فوقها) ⇒ 4499.99؛ V2: 500 + 300 ⇒ 800؛ المحفظة القديمة 50 − 50 ⇒ 0
    expect(await v1Balance()).toBe("4499.99");
    expect([await v2Balance(v2Main), await v2Balance(v2Old)]).toEqual(["800.0000", "0.0000"]);
    const newV1 = await q("SELECT id, amount, balanceAfter, type, direction FROM treasury_transactions WHERE businessId = ? ORDER BY id", [A.businessId]);
    expect(newV1.slice(0, oldV1.length)).toEqual(oldV1.map((r: any) => expect.objectContaining(r)));
    expect(newV1.slice(oldV1.length).map((r: any) => [r.type, r.direction, r.amount])).toEqual([["adjustment", "in", "3499.9900"]]);
    const newV2 = await q("SELECT id, amount, transactionType t, sourceAccountId s, targetAccountId g, evidenceUrl ev FROM financial_transactions WHERE businessId = ? ORDER BY id", [A.businessId]);
    expect(newV2.slice(0, oldV2.length).map((r: any) => ({ id: r.id, amount: r.amount }))).toEqual(oldV2);
    expect(newV2.slice(oldV2.length).map((r: any) => [r.t, r.amount, r.s, r.g])).toEqual(expect.arrayContaining([["recovery_adjustment", "300.0000", null, v2Main], ["recovery_adjustment", "50.0000", v2Old, null]]));
    expect(newV2.slice(oldV2.length).every((r: any) => r.ev === `ledger-v3-recovery:snapshot:${s.snapshotEventId}`)).toBe(true);
    expect(await banned()).toBe(false);
    expect((await q("SELECT status FROM tenants WHERE id = ?", [A.tenantId]))[0].status).toBe("suspended");
    // التصفير مسجّل في حدث الاستعادة بتفسيره ومرجعه واعتماده
    const [rec] = await q("SELECT figuresJson j FROM ledger_legacy_archive_events WHERE tenantId = ? AND action = 'recovery'", [A.tenantId]);
    const recJson = typeof rec.j === "string" ? JSON.parse(rec.j) : rec.j;
    expect(recJson.zeroed).toEqual([expect.objectContaining({ target: `v2:${v2Old}`, reconciledBalance: "50.0000", evidenceRef: "محضر جرد 2026-09-01 رقم 7", approvedByEmployeeId: e.ownerA })]);
    const rows = await legacyRows();
    const again = await recover(s.snapshotEventId!, s.figuresHash);
    expect([again.replay, await legacyRows()]).toEqual([true, rows]);
    // صورة أخرى (أرقام مختلفة) لنفس التفعيل بعد الرفع ⇒ لا استعادة ثانية
    await q("UPDATE ledger_tenant_flags SET ledgerV3Enabled = 1 WHERE tenantId = ?", [A.tenantId]);
    await v3Expense("2026-09-14", "1", "lr-exp-5");
    await q("UPDATE ledger_tenant_flags SET ledgerV3Enabled = 0 WHERE tenantId = ?", [A.tenantId]);
    const s2 = await takeStopSnapshot({ tenantId: A.tenantId, actorEmployeeId: e.ownerA, reason: "صورة لاحقة", apply: true });
    expect(await code(() => recover(s2.snapshotEventId!, s2.figuresHash))).toBe("alreadyLifted");
  });

  it("السكربت على القاعدة المؤقتة: dry-run يطبع البصمة؛ apply بلا عبارة/بعبارة خاطئة/بلا DEPLOY_ENV أو هدف يبدو إنتاجًا مرفوض؛ recover المنفّذ = replay", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-rec-"));
    const planFile = path.join(dir, "plan.json");
    const run = (args: string[], url = tmp.url, extra: Record<string, string> = {}) => spawnSync(path.resolve("node_modules/.bin/tsx"), ["--tsconfig", path.resolve("tsconfig.json"), path.resolve("scripts/legacy-recovery.ts"), ...args],
      { cwd: dir, env: { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), DATABASE_URL: url, TENANT_ACCESS_ENFORCEMENT_ENABLED: "true", ...extra }, encoding: "utf-8", timeout: 60_000 });
    const base = ["--tenant", String(A.tenantId), "--actor", String(e.ownerA), "--reason", "توقف ومطابقة"];
    try {
      const dry = run(["snapshot", ...base]);
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toMatch(/البصمة [0-9a-f]{64}/);
      expect(dry.stdout).toContain("dry-run");
      const snaps = await n("SELECT COUNT(*) n FROM ledger_legacy_archive_events WHERE tenantId = ? AND action = 'stop_snapshot'", [A.tenantId]);
      expect(run(["snapshot", ...base, "--apply"], tmp.url, { DEPLOY_ENV: "test" }).status).toBe(3);
      expect(run(["snapshot", ...base, "--apply", "--confirm", recoveryConfirmPhrase("snapshot", A.tenantId, "other")], tmp.url, { DEPLOY_ENV: "test" }).status).toBe(3);
      expect(run(["snapshot", ...base, "--apply", "--confirm", recoveryConfirmPhrase("snapshot", A.tenantId, tmp.name)]).status).toBe(3); // بلا DEPLOY_ENV
      const u = new URL(tmp.url); u.hostname = "10.1.2.3"; u.pathname = "/matjarak";
      const prod = run(["snapshot", ...base], u.toString());
      expect([prod.status, prod.stderr]).toEqual([3, expect.stringContaining("إنتاج")]);
      expect(await n("SELECT COUNT(*) n FROM ledger_legacy_archive_events WHERE tenantId = ? AND action = 'stop_snapshot'", [A.tenantId])).toBe(snaps);
      const [ev] = await q("SELECT e.snapshotEventId s, x.figuresHash h FROM ledger_legacy_archive_events e JOIN ledger_legacy_archive_events x ON x.id = e.snapshotEventId WHERE e.tenantId = ? AND e.action = 'recovery'", [A.tenantId]);
      fs.writeFileSync(planFile, JSON.stringify(plan(Number(ev.s), String(ev.h))));
      const rows = await legacyRows();
      const r = run(["recover", ...base, "--plan", planFile, "--apply", "--confirm", recoveryConfirmPhrase("recover", A.tenantId, tmp.name)], tmp.url, { DEPLOY_ENV: "test" });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("replay");
      expect(await legacyRows()).toBe(rows);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);

  it("إعادة التفعيل بعد الرفع: الحظر يعود داخل معاملة التفعيل، ولا يتغلب الرفع القديم حتى مع نفس enabledAt، والإطفاء لا يرفعه", async () => {
    expect(await banned()).toBe(false);
    await q("UPDATE tenants SET status = 'active' WHERE id = ?", [A.tenantId]); // مدير المنصة يرفع الإيقاف بعد النجاح
    await activateLedgerV3({ tenantId: A.tenantId, goLiveDate: "2026-11-01", currency: "EGP", actor: { type: "employee", employeeId: e.ownerA },
      reconciliation: { reportGeneratedAt: "2026-10-31T20:00:00Z", approvedByEmployeeId: e.ownerA, approvedAt: "2026-10-31T21:00:00Z" },
      openingBalances: {}, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId] } } as any);
    expect(await banned()).toBe(true);
    // نفس الثانية: enabledAt الجديد = activationAt للرفع القديم ⇒ آخر حدث reapply ⇒ محظور
    const [lift] = await q("SELECT id, activationAt a FROM ledger_legacy_archive_events WHERE tenantId = ? AND action = 'lift'", [A.tenantId]);
    await q("UPDATE ledger_tenant_flags SET enabledAt = (SELECT activationAt FROM ledger_legacy_archive_events WHERE id = ?) WHERE tenantId = ?", [lift.id, A.tenantId]);
    expect(await banned()).toBe(true);
    await disableLedgerV3({ tenantId: A.tenantId, actor: { type: "employee", employeeId: e.ownerA }, reason: "إطفاء بعد إعادة التفعيل" });
    expect(await banned()).toBe(true);
    await expect(createExpense({ businessId: A.businessId, amount: "10", description: "قديم", expenseDate: new Date(), createdBy: e.ownerA, createdByName: "مالك" } as any)).rejects.toThrow(/أرشيف للقراءة فقط/);
    // صورة لم تُستعد (s2) لا تُستخدم بعد إعادة التفعيل؛ الاستعادة المنفّذة سابقًا = replay بلا كتابة
    await q("UPDATE tenants SET status = 'suspended' WHERE id = ?", [A.tenantId]);
    const [old] = await q("SELECT id, figuresHash h FROM ledger_legacy_archive_events WHERE tenantId = ? AND action = 'stop_snapshot' ORDER BY id DESC LIMIT 1", [A.tenantId]);
    expect(await code(() => recover(Number(old.id), String(old.h)))).toBe("snapshotStale");
  });
});
