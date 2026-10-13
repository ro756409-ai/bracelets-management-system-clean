import { describe, it, expect } from "vitest";
import { isUniqueKeyCollision, MAX_NUMBER_ATTEMPTS, numberSource, UniqueNumberExhaustedError, withFreshNumber } from "./uniqueNumber";

/** إعادة توليد الرقم عند تصادم قيده الفريد فقط — 3 محاولات إجمالًا، وأي خطأ آخر يخرج كما هو من أول محاولة. */
const dup = (key: string) => Object.assign(new Error("Failed query: insert into `orders` …"), {
  cause: Object.assign(new Error(`Duplicate entry 'X' for key '${key}'`), { code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000", sqlMessage: `Duplicate entry 'X' for key '${key}'` }),
});
const KEY = "orders_orderNumber_unique";
const isOrderDup = (e: unknown) => isUniqueKeyCollision(e, KEY);

describe("🔢 withFreshNumber", () => {
  it("الصيغة والطول كما هما: FB-<13 رقمًا>-<3 أرقام> = 20 حرفًا (حد العمود)، وWS- بنفس الشكل", () => {
    expect(numberSource.fbOrder()).toMatch(/^FB-\d{13}-\d{3}$/);
    expect(numberSource.fbOrder()).toHaveLength(20);
    expect(numberSource.workshopReference()).toMatch(/^WS-\d{13}-\d{3}$/);
  });

  it("يتعرّف على التصادم ملفوفًا، وعلى القيد المحدد فقط", () => {
    expect(isOrderDup(dup("orders.orders_orderNumber_unique"))).toBe(true);
    expect(isOrderDup(dup("orders.orders_easyorder_unique"))).toBe(false);
    expect(isOrderDup(new Error("Duplicate entry"))).toBe(false);
  });

  it("تصادم ثم نجاح: رقم جديد ومعاملة جديدة لكل محاولة", async () => {
    const numbers = ["N1", "N2"]; const tried: string[] = [];
    const r = await withFreshNumber(() => numbers.shift()!, async n => { tried.push(n); if (n === "N1") throw dup(KEY); return 7; }, isOrderDup);
    expect(r).toEqual({ number: "N2", value: 7, attempts: 2 });
    expect(tried).toEqual(["N1", "N2"]);
  });

  it("استنفاد المحاولات: 3 بالضبط ثم CONFLICT بالخطأ الأصلي في cause", async () => {
    let calls = 0;
    const err = await withFreshNumber(() => `N${++calls}`, async () => { throw dup(KEY); }, isOrderDup).catch(e => e);
    expect(calls).toBe(MAX_NUMBER_ATTEMPTS);
    expect(err).toBeInstanceOf(UniqueNumberExhaustedError);
    expect([err.code, err.attempts, err.lastNumber]).toEqual(["CONFLICT", 3, "N3"]);
    expect(isOrderDup(err.cause)).toBe(true);
  });

  it("أي خطأ آخر (حتى تصادم قيد آخر) يخرج كما هو بلا إعادة", async () => {
    for (const boom of [new Error("validation"), dup("orders.other_unique"), Object.assign(new Error("Deadlock"), { code: "ER_LOCK_DEADLOCK", errno: 1213 })]) {
      let calls = 0;
      await expect(withFreshNumber(() => `N${++calls}`, async () => { throw boom; }, isOrderDup)).rejects.toBe(boom);
      expect(calls).toBe(1);
    }
  });
});
