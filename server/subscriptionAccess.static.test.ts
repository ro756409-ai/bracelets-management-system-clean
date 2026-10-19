import { describe, it, expect } from "vitest";
import fs from "fs";
import { RESTRICTED_ALLOWED_MUTATIONS } from "@shared/tenantAccess";

/** كل مسار في قائمة restricted موجود فعلًا كـmutation في الراوتر (مفيش اسم غلط يفتح/يقفل حاجة غير المقصودة)، وتأجيل Easy Order موصّل. */
describe("restricted — مطابقة الراوتر", () => {
  it("كل مسار mutation حقيقي", async () => {
    process.env.JWT_SECRET ||= "static-test-secret-".padEnd(48, "z");
    const { appRouter } = await import("./routers");
    const procs = (appRouter as any)._def.procedures as Record<string, any>;
    for (const p of RESTRICTED_ALLOWED_MUTATIONS) {
      expect(procs[p], `missing ${p}`).toBeTruthy();
      const d = procs[p]._def;
      expect(d.type ?? (d.mutation ? "mutation" : d.query ? "query" : "?"), p).toBe("mutation");
    }
  }, 60_000);
  it("Easy Order: الأوردر الجديد بيتأجل لما acceptsNewOrders=false، وتحديث الحالة لأ", () => {
    const src = fs.readFileSync("server/easyorderWebhook.ts", "utf-8");
    expect(src).toMatch(/isStatusUpdate = req\.body\?\.event_type === "order-status-update"/);
    expect(src).toMatch(/!access\.processWebhooks \|\| \(!isStatusUpdate && !acceptsNewOrders\(access\)\)/);
  });
});
