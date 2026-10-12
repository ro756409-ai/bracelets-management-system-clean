import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { confirmPhrase } from "./handMigration.service";
import { runRoleEnumMigration } from "./roleEnumMigration.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements, LEDGER_V3_TABLES } from "../shared/ledgerV3Spec";
import { parseOpeningFile } from "../shared/ledgerV3Activation";

/**
 * تجهيز الأرصدة الافتتاحية (المالك فقط): التحقق قراءة فقط — لا صف في أي جدول دفتر ولا تفعيل؛ الملف الناتج يمرّ
 * بنفس محلل سكربت التفعيل؛ ذمة COD منفصلة عن النقدية المتاحة؛ الأدلة إلزامية لكل مبلغ غير صفري؛ لا أرقام من V1/V2.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
async function code(fn: () => Promise<any>): Promise<string> { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } }
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const MONEY = ["OFFICE_CASH", "BANK_MAIN", "COD_BOSTA", "VF_CASH", "INSTAPAY"];
const ev = (reference: string) => ({ reference, countedBy: "المالكة سارة", note: "يوم Go-live" });

describe.runIf(CAN)("🧾 تجهيز الأرصدة الافتتاحية", () => {
  let tmp: TempSchema; let A: CoreTestFixture, B: CoreTestFixture;
  const e: Record<string, number> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];
  const ledgerRows = async () => { const out: Record<string, number> = {}; for (const t of LEDGER_V3_TABLES) out[t] = Number((await q(`SELECT COUNT(*) n FROM \`${t}\``))[0].n); return out; };
  const draft = (o: Record<string, unknown> = {}) => ({
    goLiveDate: "2026-11-01",
    balances: { OFFICE_CASH: "12500.00", BANK_MAIN: "84210.75", COD_BOSTA: "3300.50" },
    evidence: { OFFICE_CASH: ev("محضر جرد الخزنة 1"), BANK_MAIN: ev("كشف البنك 31/10"), COD_BOSTA: ev("كشف تسوية بوسطة") },
    acknowledgeV2Differences: false, ...o,
  });

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_open");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    expect((await runRoleEnumMigration({ databaseUrl: tmp.url, mode: "apply", deployEnv: "test", confirm: confirmPhrase("0045", "apply", tmp.name) })).ok).toBe(true);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("op-a"); B = await createCoreTestFixture("op-b");
    await q("INSERT INTO businesses (tenantId, name, slug) VALUES (?, 'فرحات', ?)", [A.tenantId, `op2-${tmp.name}`.slice(0, 50)]);
    const mk = async (k: string, role: string, f: CoreTestFixture) => { e[k] = insId(await createEmployee({ name: `${k}-op`, role, isActive: true, tenantId: f.tenantId, businessId: f.businessId, username: `${k}_${tmp.name}`.slice(0, 50) } as any)); };
    await mk("ownerA", "super_admin", A); await mk("adminA", "admin", A); await mk("amA", "accounts_manager", A); await mk("accountantA", "accountant", A); await mk("ownerB", "super_admin", B);
  }, 300_000);
  afterAll(async () => { __setDbForTests(null); await tmp?.drop(); }, 120_000);

  it("المالك: تحقق ناجح بلا أي كتابة؛ COD منفصلة عن النقدية؛ الملف يمرّ بمحلل سكربت التفعيل حرفيًا", async () => {
    const before = await ledgerRows();
    const r = await (await call(e.ownerA)).opening.validate(draft());
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.totals).toEqual({ cashAvailable: "96710.7500", codReceivable: "3300.5000", openingEquity: expect.any(String) });
    expect(r.accounts.find((a: any) => a.code === "COD_BOSTA")?.group).toBe("cod_receivable");
    expect(r.accounts.filter((a: any) => a.group === "cash_available").map((a: any) => a.code)).toEqual(["OFFICE_CASH", "BANK_MAIN", "VF_CASH", "INSTAPAY"]);
    expect(r.ledgerEnabled).toBe(false);
    expect(await ledgerRows()).toEqual(before); // صفر كتابة في كل جداول الدفتر
    expect(Object.values(before).every(n => n === 0)).toBe(true);
    // الملف: نفس عقد السكربت (مفاتيح معروفة أو تعليقات _)، مبالغ نصية، والأرصدة غير المذكورة صفر لا تخمين
    const file = r.file as any;
    const parsed = parseOpeningFile(JSON.parse(JSON.stringify(file)), MONEY);
    expect(parsed.ok).toBe(true);
    expect(file.openingBalances).toEqual({ OFFICE_CASH: "12500.00", BANK_MAIN: "84210.75", COD_BOSTA: "3300.50", VF_CASH: "0", INSTAPAY: "0" });
    expect(file.openingEquity).toBe(r.totals.openingEquity);
    expect(Object.keys(file).filter(k => !k.startsWith("_")).sort()).toEqual(["currency", "goLiveDate", "openingBalances", "openingEquity", "reconciliation"]);
    expect(file._evidence.BANK_MAIN).toEqual(ev("كشف البنك 31/10"));
    expect(file._source).toMatch(/بلا أي رقم من V1\/V2/);
    expect(file.reconciliation).toMatchObject({ approvedByEmployeeId: e.ownerA, acknowledgedDifferences: false });
    expect(JSON.stringify(file)).not.toMatch(/\d+\.\d{5,}/); // لا أثر float
  });

  it("رفض واضح بلا كتابة: مبلغ بلا دليل، حساب مجهول، مبلغ رقمي/بصيغة خاطئة، مفتاح زائد، تاريخ خاطئ", async () => {
    const before = await ledgerRows();
    const o = await call(e.ownerA);
    const noEvidence = await o.opening.validate(draft({ evidence: { OFFICE_CASH: ev("محضر 1"), BANK_MAIN: ev("كشف") } }));
    expect(noEvidence.ok).toBe(false); expect(noEvidence.file).toBeNull();
    expect(noEvidence.errors.join(" ")).toMatch(/COD_BOSTA/);
    expect(await code(() => o.opening.validate(draft({ evidence: { OFFICE_CASH: ev("م") } })))).toBe("BAD_REQUEST"); // مرجع أقصر من حرفين
    const unknown2 = await o.opening.validate(draft({ balances: { OFFICE_CASH: "1", PETTY: "5" }, evidence: { OFFICE_CASH: ev("محضر"), PETTY: ev("محضر") } }));
    expect(unknown2.ok).toBe(false); expect(unknown2.errors.join(" ")).toMatch(/PETTY/);
    expect(await code(() => o.opening.validate(draft({ balances: { OFFICE_CASH: 12500 } }) as any))).toBe("BAD_REQUEST");
    expect(await code(() => o.opening.validate(draft({ balances: { OFFICE_CASH: "1,500" } })))).toBe("BAD_REQUEST");
    expect(await code(() => o.opening.validate(draft({ balances: { OFFICE_CASH: "1.12345" } })))).toBe("BAD_REQUEST");
    expect(await code(() => o.opening.validate({ ...draft(), tenantId: B.tenantId } as any))).toBe("BAD_REQUEST");
    expect(await code(() => o.opening.validate(draft({ goLiveDate: "2026-02-30" })))).toBe("BAD_REQUEST");
    expect(await ledgerRows()).toEqual(before);
  });

  it("المالك فقط: الأدمن ومدير الحسابات والمحاسب مرفوضون؛ والشركة من الجلسة فقط", async () => {
    for (const id of [e.adminA, e.amA, e.accountantA]) expect(await code(async () => (await call(id)).opening.validate(draft()))).toBe("FORBIDDEN");
    const b = await (await call(e.ownerB)).opening.validate(draft());
    expect(b.businessCoverage.every((x: any) => x.id === B.businessId)).toBe(true);
    expect(b.file?.reconciliation?.approvedByEmployeeId ?? e.ownerB).toBe(e.ownerB);
  });
});
