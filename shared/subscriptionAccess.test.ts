import { describe, it, expect } from "vitest";
import { acceptsNewOrders, computeTenantAccess, httpRequestAllowed, RESTRICTED_ALLOWED_MUTATIONS, trpcCallAllowed, TENANT_ACCESS_MESSAGES } from "./tenantAccess";
import type { BillingStatus } from "./billing";

const now = new Date("2026-05-01T00:00:00Z");
const st = (state: BillingStatus["state"]): BillingStatus => ({ state, paidUntil: state === "pending_payment" ? null : new Date("2026-04-30T00:00:00Z"), graceEndsAt: state === "pending_payment" ? null : new Date("2026-05-03T00:00:00Z") });
const active = { status: "active", trialEndsAt: null };

describe("وصول شركة على نموذج الاشتراك", () => {
  it("بلا billing ⇒ نفس السلوك القديم حرفيًا (بلا acceptNewOrders)", () => {
    expect(computeTenantAccess(active, null, now)).toEqual({ level: "full", reason: "active", processWebhooks: true, runJobs: true, until: null });
    expect(computeTenantAccess({ status: "trialing", trialEndsAt: new Date("2026-04-01") }, null, now).level).toBe("read_only");
    expect(computeTenantAccess(active, null, now, null).reason).toBe("active");
  });
  it("active/grace ⇒ full؛ pending_payment/expired ⇒ restricted (ويبهوك أيوه، مهام لأ، أوردرات جديدة لأ)", () => {
    expect(computeTenantAccess(active, null, now, st("active"))).toMatchObject({ level: "full", reason: "subscription_active" });
    expect(computeTenantAccess(active, null, now, st("grace"))).toMatchObject({ level: "full", reason: "subscription_grace" });
    for (const s of ["pending_payment", "expired"] as const) {
      const a = computeTenantAccess(active, null, now, st(s));
      expect(a).toMatchObject({ level: "restricted", reason: `subscription_${s}`, processWebhooks: true, runJobs: false, acceptNewOrders: false });
      expect(acceptsNewOrders(a)).toBe(false);
    }
  });
  it("حالة الشركة من المنصة تسبق الدفع: suspended/canceled ⇒ blocked حتى لو مدفوع؛ trialing/expired القديمة مابتأثرش", () => {
    expect(computeTenantAccess({ status: "suspended", trialEndsAt: null }, null, now, st("active")).level).toBe("blocked");
    expect(computeTenantAccess({ status: "canceled", trialEndsAt: null }, null, now, st("active")).level).toBe("blocked");
    expect(computeTenantAccess({ status: "trialing", trialEndsAt: new Date("2026-01-01") }, null, now, st("active")).level).toBe("full");
  });
  it("restricted: القراءة + التصحيح + الاشتراك؛ لا إنشاء ولا تأكيد ولا إرسال لبوسطة ولا رفع", () => {
    const a = computeTenantAccess(active, null, now, st("expired"));
    expect(trpcCallAllowed(a, "query", "orders.list")).toBe(true);
    for (const p of ["orders.cancel", "returns.markAsReturned", "printLogs.create", "orders.bostaLinkShipment", "variants.updateStock", "subscription.status", "auth.logout"])
      expect(trpcCallAllowed(a, "mutation", p), p).toBe(true);
    for (const p of ["orders.create", "orders.confirm", "orders.sendToBosta", "orders.bulkSendToBosta", "orders.duplicate", "facebookEntry.create", "orders.update"])
      expect(trpcCallAllowed(a, "mutation", p), p).toBe(false);
    expect(httpRequestAllowed(a, "GET")).toBe(true);
    expect(httpRequestAllowed(a, "POST")).toBe(false);
  });
  it("القائمة مابتشملش أي إنشاء/تأكيد/إرسال، وكل سبب له رسالة", () => {
    expect(RESTRICTED_ALLOWED_MUTATIONS.filter(p => /create$|confirm|sendToBosta|import|duplicate/i.test(p) && p !== "printLogs.create" && p !== "accountingV2.stocktakeCreate")).toEqual([]);
    for (const r of ["subscription_active", "subscription_grace", "subscription_pending_payment", "subscription_expired"] as const) expect(TENANT_ACCESS_MESSAGES[r]).toBeTruthy();
  });
});
