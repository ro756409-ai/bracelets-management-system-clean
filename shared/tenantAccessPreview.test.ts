import { describe, it, expect } from "vitest";
import { buildTenantAccessPreview, formatTenantAccessPreview } from "./tenantAccessPreview";

const NOW = new Date("2026-10-10T12:00:00.000Z");
const DAY = 86_400_000;

describe("معاينة الإنفاذ — أقسام التحذير قبل التفعيل", () => {
  const p = buildTenantAccessPreview([
    { id: 1, name: "نشطة", status: "active", trialEndsMs: null },
    { id: 2, name: "تجربة بلا تاريخ", status: "trialing", trialEndsMs: null },
    { id: 3, name: "تجربة سارية", status: "trialing", trialEndsMs: NOW.getTime() + DAY },
    { id: 4, name: "متأخرة بلا فترة", status: "past_due", trialEndsMs: null },
    { id: 5, name: "متأخرة في المهلة", status: "past_due", trialEndsMs: null },
    { id: 6, name: "موقوفة", status: "suspended", trialEndsMs: null },
  ], new Map([[5, NOW.getTime() - 2 * DAY]]), NOW);

  it("قسمان مستقلان بالأسماء والمعرّفات، والباقي خارجهما", () => {
    expect(p.warnings.trialWithoutEndDate.map(r => r.tenantId)).toEqual([2]);
    expect(p.warnings.pastDueWithoutPeriod.map(r => r.tenantId)).toEqual([4]);
    expect(p.counts).toEqual({ full: 3, read_only: 2, blocked: 1 });
  });
  it("الطباعة: التحذيران قبل القائمة الكاملة، وتذكير بعدم التفعيل قبل المراجعة، وأن الحالة لم تتغير", () => {
    const text = formatTenantAccessPreview(p);
    const w1 = text.indexOf("⚠️ تحذير — trialing بلا trialEndsAt");
    const w2 = text.indexOf("⚠️ تحذير — past_due بلا فترة اشتراك معروفة");
    const all = text.indexOf("كل الشركات:");
    expect(w1).toBeGreaterThan(-1); expect(w2).toBeGreaterThan(w1); expect(all).toBeGreaterThan(w2);
    expect(text.slice(w1, w2)).toContain("#2 تجربة بلا تاريخ");
    expect(text.slice(w2, all)).toContain("#4 متأخرة بلا فترة");
    expect(text).toContain("لا تفعّل TENANT_ACCESS_ENFORCEMENT_ENABLED قبل مراجعة هذه النتيجة يدويًا");
    expect(text).toContain("لم تغيّر حالة أي شركة");
  });
});
