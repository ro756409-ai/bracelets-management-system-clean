import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  getAllSalesChannels, getActiveSalesChannels, getSyncLogs,
  getAllEmployees, getActiveEmployees, searchEmployees,
  getPrintLogs, getReturnsList, getReturnsStats, getActivityLogs,
  getSalesChannelByWebhookSecret,
  createSalesChannel, createEmployee, addActivityLog,
} from "./db";
import { salesChannels, employees } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";

/**
 * Security Blocker — عزل قوائم القراءة بين التينانتات. كان غياب businessId من العميل بيرجّع
 * **كل صفوف النظام** (scopeBusinessId المفرد → undefined → getX(undefined) = الكل). الإصلاح:
 * الـrouter يمرّر businessIds من الـsession، وطبقة الـDB fail-closed (فاضي → صفر، مش الكل).
 */

// ── حراس مصدر: الـendpoints المتأثرة بتستخدم scopeBusinessIds (الجمع) مش المفرد ──
const routers = fs.readFileSync("server/routers.ts", "utf-8");
const db = fs.readFileSync("server/db.ts", "utf-8");

describe("🔑 حراس المصدر — fail-closed scoping", () => {
  it("🔑 db فيه scopedBusinessFilter (فاضي → [-1])", () => {
    expect(db).toContain("function scopedBusinessFilter");
    expect(db).toContain("inArray(column, businessIds.length ? businessIds : [-1])");
  });
  it("🔑 salesChannels list/activeList بيمرّروا businessIds (مش businessId المفرد)", () => {
    const block = routers.slice(routers.indexOf("salesChannels: router({"), routers.indexOf("salesChannels: router({") + 2600);
    expect(block).toContain("getAllSalesChannels(undefined, {");
    expect(block).toContain("getActiveSalesChannels(undefined, businessIds)");
    expect(block).toContain("scopeBusinessIds(ctx, input ?? {})");
  });
  it("🔑 employees/returns/printLogs/activityLog بيمرّروا businessIds", () => {
    expect(routers).toContain("getActiveEmployees(undefined, businessIds)");
    expect(routers).toContain("getReturnsList({ ...input, businessId: undefined, businessIds })");
    expect(routers).toContain("getPrintLogs(input?.limit ?? 50, undefined, businessIds)");
    expect(routers).toContain("businessIds,\n        });"); // getActivityLogs
  });
});

// ── سلوكي فعلي cross-tenant (matjarak_test) ──
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("🔑 عزل A ≠ B فعلي", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const secretA = `secA-${tag}`, secretB = `secB-${tag}`;
  const cleanup = { channelIds: [] as number[], empIds: [] as number[] };

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    A = await createCoreTestFixture("iso-a");
    B = await createCoreTestFixture("iso-b");
    const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
    // قنوات بيع
    cleanup.channelIds.push((await createSalesChannel({ businessId: A.businessId, name: `chA-${tag}`, platform: "easyorder", webhookSecret: secretA } as any)).id);
    cleanup.channelIds.push((await createSalesChannel({ businessId: B.businessId, name: `chB-${tag}`, platform: "easyorder", webhookSecret: secretB } as any)).id);
    // موظفين
    cleanup.empIds.push(insId(await createEmployee({ name: "empA", role: "agent", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `empA_${tag}` } as any)));
    cleanup.empIds.push(insId(await createEmployee({ name: "empB", role: "agent", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `empB_${tag}` } as any)));
    // سجل أنشطة
    await addActivityLog({ action: "test", entityType: "x", description: "A", performedBy: 1, businessId: A.businessId } as any);
    await addActivityLog({ action: "test", entityType: "x", description: "B", performedBy: 1, businessId: B.businessId } as any);
  });

  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (cleanup.channelIds.length) await d.delete(salesChannels).where(inArray(salesChannels.id, cleanup.channelIds));
    if (cleanup.empIds.length) await d.delete(employees).where(inArray(employees.id, cleanup.empIds));
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 getAllSalesChannels([A]) → قنوات A فقط، مش B", async () => {
    const rows = await getAllSalesChannels(undefined, { includeInactive: true }, [A.businessId]);
    expect(rows.some(c => c.businessId === A.businessId)).toBe(true);
    expect(rows.some(c => c.businessId === B.businessId)).toBe(false);
  });
  it("🔑 نطاق فاضي [] → صفر قنوات (fail-closed، مش الكل)", async () => {
    expect((await getAllSalesChannels(undefined, { includeInactive: true }, [])).length).toBe(0);
    expect((await getActiveSalesChannels(undefined, [])).length).toBe(0);
  });
  it("🔑 getActiveSalesChannels([A]) → A فقط", async () => {
    const rows = await getActiveSalesChannels(undefined, [A.businessId]);
    expect(rows.every(c => c.businessId === A.businessId)).toBe(true);
  });
  it("🔑 employees: [A] → موظفي A فقط؛ [] → صفر", async () => {
    const all = await getAllEmployees(undefined, [A.businessId]);
    expect(all.some(e => e.businessId === B.businessId)).toBe(false);
    expect((await getAllEmployees(undefined, [])).length).toBe(0);
    expect((await getActiveEmployees(undefined, [])).length).toBe(0);
    const s = await searchEmployees({ businessIds: [A.businessId] });
    expect(s.some(e => e.businessId === B.businessId)).toBe(false);
    expect((await searchEmployees({ businessIds: [] })).length).toBe(0);
  });
  it("🔑 activityLogs: [A] مايشملش B؛ [] → صفر", async () => {
    const a = await getActivityLogs({ businessIds: [A.businessId], limit: 100 });
    expect(a.items.some((x: any) => x.businessId === B.businessId)).toBe(false);
    expect((await getActivityLogs({ businessIds: [], limit: 100 })).items.length).toBe(0);
  });
  it("🔑 printLogs/returns/syncLogs: نطاق فاضي → صفر (fail-closed)", async () => {
    expect((await getPrintLogs(50, undefined, [])).length).toBe(0);
    expect((await getReturnsList({ businessIds: [], limit: 100 })).items.length).toBe(0);
    expect((await getReturnsStats(undefined, undefined, undefined, [])).total).toBe(0);
    expect((await getSyncLogs({ channelIds: [] })).length).toBe(0);
  });
  it("🔑 (item 7) webhook secret A يربط بنشاط A فقط — مش B", async () => {
    const chA = await getSalesChannelByWebhookSecret(secretA);
    expect(chA?.businessId).toBe(A.businessId);
    expect(chA?.businessId).not.toBe(B.businessId);
  });
});
