import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import { drizzle } from "drizzle-orm/mysql2";
import { appRouter } from "./routers";
import { createContext } from "./_core/context";
import { __setDbForTests, createEmployee } from "./db";
import { activateLedgerV3 } from "./ledgerV3.service";
import { createTempSchema, type TempSchema } from "./testTempSchema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { splitMigrationStatements } from "../shared/ledgerV3Spec";
import { businessDateKey } from "../shared/businessTime";
import { cairoToday } from "../client/src/pages/ledger/ledgerUi";

/**
 * التوقيت: وقت الحدث والفترة المحاسبية صحيحان سواء شُغّل Node بتوقيت UTC أو القاهرة — قبل وبعد منتصف الليل وعند حد الشهر.
 *  • وقت حدث الإقفال/الفتح = نفس اللحظة المخزنة في القاعدة (UNIX_TIMESTAMP) — Date حقيقي لا نص بلا منطقة زمنية.
 *  • الفترة من تاريخ الحركة النصي (YYYY-MM-DD) — لا تتحرك بتوقيت Node.
 *  • «اليوم/الشهر الجاري» بتوقيت القاهرة من لحظة مطلقة — لا من توقيت الجهاز.
 * لا تعديل لأي وقت مخزن في بيانات حقيقية: الأوقات هنا لصفوف قاعدة اختبار مؤقتة فقط.
 */
const CAN = Boolean(process.env.TEST_DATABASE_URL && process.env.JWT_SECRET);
const sign = (employeeId: number) => jwt.sign({ employeeId }, process.env.JWT_SECRET as string);
const res = { cookie: () => {}, clearCookie: () => {} } as any;
const call = async (id: number) => (await appRouter.createCaller(await createContext({ req: { protocol: "https", headers: {}, cookies: { employee_token: sign(id) } }, res } as any))).ledger;
const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
const ORIGINAL_TZ = process.env.TZ;
const setTz = (tz: string) => { process.env.TZ = tz; };
const cairo = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d);
const TZS = ["UTC", "Africa/Cairo"] as const;
let seq = 0;
const op = () => `tz${Date.now().toString(36)}${++seq}xx`;

describe("🕒 التوقيت بدون قاعدة: اليوم/الشهر بتوقيت القاهرة لا يتبع توقيت Node", () => {
  afterEach(() => { vi.useRealTimers(); setTz(ORIGINAL_TZ ?? ""); if (ORIGINAL_TZ === undefined) delete process.env.TZ; });
  // [لحظة UTC، تاريخ القاهرة المتوقع]: أكتوبر 2026 = UTC+3 (توقيت صيفي)، ديسمبر = UTC+2
  const CASES: [string, string][] = [
    ["2026-09-30T20:59:59.999Z", "2026-09-30"], ["2026-09-30T21:00:00.000Z", "2026-10-01"],
    ["2026-12-31T21:59:59.999Z", "2026-12-31"], ["2026-12-31T22:00:00.000Z", "2027-01-01"],
  ];
  for (const tz of TZS) {
    it(`Node بتوقيت ${tz}: businessDateKey وcairoToday عند منتصف الليل وحد الشهر والسنة`, () => {
      setTz(tz);
      // تحقق أن تغيير التوقيت فعّال في هذه العملية (وإلا فالاختبار لا يثبت شيئًا)
      expect(new Date("2026-09-30T21:30:00Z").getHours()).toBe(tz === "UTC" ? 21 : 0);
      for (const [instant, day] of CASES) {
        expect(businessDateKey(new Date(instant), "Africa/Cairo")).toBe(day);
        vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(instant));
        expect(cairoToday()).toBe(day);
        vi.useRealTimers();
      }
    });
  }
});

describe.runIf(CAN)("🕒 التوقيت على قاعدة حقيقية: وقت الحدث والفترة بتوقيت UTC والقاهرة", () => {
  let tmp: TempSchema; let A: CoreTestFixture;
  let owner = 0;
  const acc: Record<string, number> = {};
  const q = async (s: string, p: unknown[] = []) => ((await tmp.raw.query(s, p)) as any)[0];

  beforeAll(async () => {
    tmp = await createTempSchema("ledger_tz");
    for (const stmt of splitMigrationStatements(fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8"))) await tmp.raw.query(stmt);
    __setDbForTests(drizzle(tmp.url));
    A = await createCoreTestFixture("tz-a");
    owner = insId(await createEmployee({ name: "مالك التوقيت", role: "super_admin", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `tzowner_${tmp.name}`.slice(0, 50) } as any));
    const r = await activateLedgerV3({
      tenantId: A.tenantId, goLiveDate: "2026-09-01", currency: "EGP", actor: { type: "employee", employeeId: owner },
      reconciliation: { reportGeneratedAt: "2026-08-31T20:00:00Z", approvedByEmployeeId: owner, approvedAt: "2026-08-31T21:00:00Z" },
      openingBalances: { OFFICE_CASH: "100" }, businessIds: [A.businessId], safeGrants: { OFFICE_CASH: [A.businessId], BANK_MAIN: [A.businessId], COD_BOSTA: [A.businessId] },
    } as any);
    Object.assign(acc, r.accounts);
    // حدثان حول منتصف ليل القاهرة عند حد الشهر (قاعدة مؤقتة فقط): 23:59:59 يوم 30/9 و00:30 يوم 1/10 بتوقيت القاهرة
    const l = await call(owner);
    await l.period.lock({ period: "2026-09", reason: "إقفال قبل منتصف الليل" });
    await l.period.reopen({ period: "2026-09", reason: "فتح بعد منتصف الليل" });
    const [period] = await q("SELECT id FROM ledger_periods WHERE tenantId = ? AND period = '2026-09'", [A.tenantId]);
    await q("UPDATE ledger_period_events SET createdAt = FROM_UNIXTIME(?) WHERE periodId = ? AND action = 'lock'", [Date.parse("2026-09-30T20:59:59Z") / 1000, period.id]);
    await q("UPDATE ledger_period_events SET createdAt = FROM_UNIXTIME(?) WHERE periodId = ? AND action = 'reopen'", [Date.parse("2026-09-30T21:30:00Z") / 1000, period.id]);
  }, 300_000);
  afterAll(async () => { setTz(ORIGINAL_TZ ?? ""); if (ORIGINAL_TZ === undefined) delete process.env.TZ; __setDbForTests(null); await tmp?.drop(); }, 120_000);

  for (const tz of TZS) {
    it(`Node بتوقيت ${tz}: وقت حدث الإقفال/الفتح = اللحظة المخزنة (مراجعة الشهر وقائمة الفترات)، وبالقاهرة 23:59:59 ثم 00:30`, async () => {
      setTz(tz);
      expect(new Date("2026-09-30T21:30:00Z").getHours()).toBe(tz === "UTC" ? 21 : 0);
      const truth = (await q("SELECT action, ROUND(UNIX_TIMESTAMP(createdAt) * 1000) AS ms FROM ledger_period_events WHERE tenantId = ? ORDER BY id", [A.tenantId]))
        .map((r: any) => [r.action, Number(r.ms)]);
      expect(truth).toEqual([["lock", Date.parse("2026-09-30T20:59:59Z")], ["reopen", Date.parse("2026-09-30T21:30:00Z")]]);
      const l = await call(owner);
      const review = await l.period.review({ period: "2026-09" });
      for (const [i, ev] of review.events.entries()) {
        expect(ev.createdAt).toBeInstanceOf(Date);
        expect((ev.createdAt as Date).getTime()).toBe(truth[i][1]);
      }
      expect(review.events.map((ev: any) => cairo(ev.createdAt))).toEqual(["2026-09-30, 23:59:59", "2026-10-01, 00:30:00"]);
      const listed = (await l.periods.list()).find((p: any) => p.period === "2026-09");
      expect(listed.events.map((ev: any) => (ev.createdAt as Date).getTime())).toEqual(truth.map((t: any) => t[1]));
    });

    it(`Node بتوقيت ${tz}: الفترة من تاريخ الحركة — آخر يوم في الشهر وأول يوم في التالي`, async () => {
      setTz(tz);
      const l = await call(owner);
      const post = (date: string) => l.post({ sourceBusinessId: A.businessId, kind: "expense", idempotencyKey: op(), effectiveDate: date, description: `حد ${date} ${tz}`,
        entries: [{ accountId: acc.EXPENSE, side: "debit", amount: "1" }, { accountId: acc.OFFICE_CASH, side: "credit", amount: "1" }] });
      const last = await post("2026-09-30"); const first = await post("2026-10-01");
      expect([last.postingPeriod, first.postingPeriod]).toEqual(["2026-09", "2026-10"]);
      for (const [id, date, period] of [[last.transactionId, "2026-09-30", "2026-09"], [first.transactionId, "2026-10-01", "2026-10"]] as const) {
        const got = await l.transaction.get({ transactionId: id });
        expect([got.effectiveDate, got.postingPeriod]).toEqual([date, period]);
        const row = (await l.transactions.list({ from: date, to: date })).rows.find((r: any) => r.id === id);
        expect([row?.effectiveDate, row?.postingPeriod]).toEqual([date, period]);
      }
      const sept = await l.period.review({ period: "2026-09" });
      expect(sept.reversals).toEqual([]);
      expect(sept.accounts.find((a: any) => a.code === "EXPENSE")?.debit).toBe(tz === "UTC" ? "1.0000" : "2.0000"); // تراكمي: حركة 30/9 من كل دورة فقط
    });
  }
});
