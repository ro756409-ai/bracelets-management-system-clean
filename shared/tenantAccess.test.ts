import { describe, it, expect } from "vitest";
import { computeTenantAccess, trpcCallAllowed, httpRequestAllowed, PAST_DUE_GRACE_DAYS, TENANT_ACCESS_MESSAGES } from "./tenantAccess";

const NOW = new Date("2026-10-09T12:00:00.000Z");
const ms = (d: Date, delta: number) => new Date(d.getTime() + delta);
const DAY = 86_400_000;
const lvl = (status: string, trialEndsAt: Date | null = null, pastDueSince: Date | null = null, now = NOW) => computeTenantAccess({ status, trialEndsAt }, pastDueSince, now).level;

describe("قرار وصول الشركة — كل حالة وحدودها", () => {
  it("trialing: قبل النهاية full؛ عندها وبعدها read_only؛ بلا تاريخ read_only بسبب مستقل للمراجعة", () => {
    expect(lvl("trialing", ms(NOW, 1))).toBe("full");
    expect(lvl("trialing", NOW)).toBe("read_only");
    expect(lvl("trialing", ms(NOW, -1))).toBe("read_only");
    expect(lvl("trialing", null)).toBe("read_only");
    expect(computeTenantAccess({ status: "trialing", trialEndsAt: null }, null, NOW).reason).toBe("trial_no_end_date");
    expect(computeTenantAccess({ status: "trialing", trialEndsAt: ms(NOW, -1) }, null, NOW).reason).toBe("trial_ended");
    expect(computeTenantAccess({ status: "trialing", trialEndsAt: ms(NOW, DAY) }, null, NOW).reason).toBe("trial");
  });
  it("active: full", () => expect(lvl("active")).toBe("full"));
  it(`past_due: full خلال ${PAST_DUE_GRACE_DAYS} أيام ثم read_only؛ بلا بداية read_only`, () => {
    const since = ms(NOW, -PAST_DUE_GRACE_DAYS * DAY);
    expect(lvl("past_due", null, ms(since, 1))).toBe("full");
    expect(lvl("past_due", null, since)).toBe("read_only");
    expect(lvl("past_due", null, ms(NOW, -DAY))).toBe("full");
    expect(lvl("past_due", null, null)).toBe("read_only");
    expect(computeTenantAccess({ status: "past_due", trialEndsAt: null }, null, NOW).reason).toBe("past_due_unknown_period");
    expect(computeTenantAccess({ status: "past_due", trialEndsAt: null }, ms(NOW, -30 * DAY), NOW).reason).toBe("past_due_ended");
  });
  it("expired: read_only؛ suspended/canceled: blocked؛ غير معروف أو بلا شركة: blocked", () => {
    expect(lvl("expired")).toBe("read_only");
    expect(lvl("suspended")).toBe("blocked");
    expect(lvl("canceled")).toBe("blocked");
    expect(lvl("weird")).toBe("blocked");
    expect(computeTenantAccess(null, null, NOW).level).toBe("blocked");
  });
  it("الويبهوك والمهام تعمل فقط في full", () => {
    for (const s of ["trialing", "active", "past_due", "expired", "suspended", "canceled"]) {
      const a = computeTenantAccess({ status: s, trialEndsAt: ms(NOW, DAY) }, ms(NOW, -DAY), NOW);
      expect(a.processWebhooks, s).toBe(a.level === "full");
      expect(a.runJobs, s).toBe(a.level === "full");
    }
  });
  it("كل سبب له رسالة عربية", () => {
    for (const r of ["trial", "trial_ended", "trial_no_end_date", "active", "past_due_grace", "past_due_ended", "past_due_unknown_period", "expired", "suspended", "canceled", "unknown"] as const) expect(TENANT_ACCESS_MESSAGES[r]).toBeTruthy();
  });
});

describe("ما يُسمح به لكل مستوى", () => {
  const ro = computeTenantAccess({ status: "expired", trialEndsAt: null }, null, NOW);
  const bl = computeTenantAccess({ status: "suspended", trialEndsAt: null }, null, NOW);
  const full = computeTenantAccess({ status: "active", trialEndsAt: null }, null, NOW);
  it("tRPC: read_only = كل القراءات + الخروج + إعدادات الاشتراك فقط", () => {
    expect(trpcCallAllowed(ro, "query", "orders.list")).toBe(true);
    expect(trpcCallAllowed(ro, "mutation", "orders.update")).toBe(false);
    expect(trpcCallAllowed(ro, "mutation", "auth.logout")).toBe(true);
    expect(trpcCallAllowed(ro, "mutation", "subscription.update")).toBe(true);
    expect(trpcCallAllowed(full, "mutation", "orders.update")).toBe(true);
  });
  it("tRPC: blocked = الهوية وحالة الوصول والخروج فقط", () => {
    expect(trpcCallAllowed(bl, "query", "orders.list")).toBe(false);
    for (const p of ["auth.me", "auth.logout", "employeePortal.me", "tenantAccess.status"]) expect(trpcCallAllowed(bl, p === "auth.logout" ? "mutation" : "query", p), p).toBe(true);
  });
  it("HTTP: read_only قراءة/تصدير فقط، blocked لا شيء", () => {
    expect(httpRequestAllowed(ro, "GET")).toBe(true);
    expect(httpRequestAllowed(ro, "POST")).toBe(false);
    expect(httpRequestAllowed(bl, "GET")).toBe(false);
    expect(httpRequestAllowed(full, "POST")).toBe(true);
  });
});
