import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * Item 5 — تأكيد أن إصلاح العزل (a31e54e) غيّر **مصدر فلتر النشاط فقط** (businessId → businessIds
 * من الـsession) بدون تغيير شكل الاستجابة ولا pagination ولا باقي الفلاتر المعتادة.
 */
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const db = fs.readFileSync("server/db.ts", "utf-8");

describe("🔑 شكل الاستجابة/الفلاتر لم يتغيّر", () => {
  it("🔑 returns.list لسه بيمرّر كل الفلاتر/الصفحات (...input) — بس businessId بقى من الجلسة", () => {
    expect(routers).toContain("getReturnsList({ ...input, businessId: undefined, businessIds })");
  });
  it("🔑 activityLog.list لسه بيمرّر page/limit/action/entityType/entityId/performedBy/dateFrom/dateTo", () => {
    const b = routers.slice(routers.indexOf("activityLog: router({"), routers.indexOf("activityLog: router({") + 1200);
    for (const f of ["page:", "limit:", "action:", "entityType:", "entityId:", "performedBy:", "dateFrom:", "dateTo:"])
      expect(b).toContain(f);
    expect(b).toContain("businessIds,"); // المصدر الجديد للعزل
  });
  it("🔑 salesChannels.list لسه بيحترم includeInactive", () => {
    expect(routers).toContain("includeInactive: input?.includeInactive ?? true");
  });
  it("🔑 دوال الـDB لسه بترجّع نفس الشكل (items/total للمرتجعات والأنشطة)", () => {
    const ret = db.slice(db.indexOf("export async function getReturnsList"), db.indexOf("export async function getReturnsStats"));
    expect(ret).toContain("return { items");
    expect(ret).toContain("total");
    const act = db.slice(db.indexOf("export async function getActivityLogs"), db.indexOf("export async function getActivityLogs") + 2000);
    expect(act).toContain("items");
    expect(act).toContain("total");
  });
  it("🔑 القوائم لسه بترجّع مصفوفات (sales channels/employees) — مش شكل جديد", () => {
    // getAllSalesChannels/getActiveSalesChannels: Promise<SafeSalesChannel[]> — لسه مصفوفة.
    expect(db).toContain("Promise<SafeSalesChannel[]>");
    // الفلتر الوحيد المضاف داخلي (inArray) — مش تغيير في الإرجاع.
    expect(db).toContain("scopedBusinessFilter(salesChannels.businessId, businessIds)");
  });
});
