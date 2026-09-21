import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { appRouter } from "./routers";
import { getDb, createEmployee, createBusiness, getEmployeeById } from "./db";
import { businessConfigurationValues, businesses, employees } from "../drizzle/schema";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { registerBrandingRoutes } from "./brandingUpload";
import { BRANDING_NAMESPACE, brandInitial, isOwnedLogoUrl, logoUrlTenant, parseLogoUrl } from "../shared/branding";

/**
 * هوية النشاط (اسم البراند + اللوجو) لكل نشاط — بلا Migration، بعزل التينانت والنطاق.
 */

const CAN = !!process.env.TEST_DATABASE_URL;

// ── نقي ──
describe("🔑 branding — قواعد نقية", () => {
  it("🔑 أول حرف من اسم البراند", () => {
    expect(brandInitial("متجر النور")).toBe("م");
    expect(brandInitial("  afandy kids ")).toBe("A");
    expect(brandInitial("")).toBe("؟");
    expect(brandInitial(null)).toBe("؟");
  });
  it("🔒 مرجع اللوجو لازم يكون مسارنا وبنفس التينانت", () => {
    const ok = "/api/branding/files/t7-logo-0f3a1c2e-1111-2222-3333-444444444444.png";
    expect(logoUrlTenant(ok)).toBe(7);
    expect(isOwnedLogoUrl(ok, 7)).toBe(true);
    expect(isOwnedLogoUrl(ok, 8)).toBe(false); // tenant تاني
    expect(isOwnedLogoUrl("https://evil.example/x.png", 7)).toBe(false);
    expect(isOwnedLogoUrl("/api/evidence/files/t7-abc.png", 7)).toBe(false); // مسار مرفقات مش لوجو
    expect(isOwnedLogoUrl("/api/branding/files/t7-logo-x.svg", 7)).toBe(false); // امتداد غير مسموح
    expect(parseLogoUrl(JSON.stringify(ok))).toBe(ok);
    expect(parseLogoUrl(JSON.stringify(null))).toBeNull();
    expect(parseLogoUrl("garbage")).toBeNull();
  });
});

// ── حراس المصدر ──
describe("🔒 حراس المصدر — الهوية والمبدّل", () => {
  const read = (p: string) => fs.readFileSync(p, "utf8");
  it("🔒 مفيش اسم نشاط أو businessId ثابت في مكوّنات الهوية", () => {
    for (const p of [
      "client/src/components/shell/BusinessSwitcher.tsx",
      "client/src/components/BusinessAvatar.tsx",
      "client/src/components/BusinessLogoField.tsx",
      "client/src/contexts/BusinessContext.tsx",
      "client/src/lib/activeBusiness.ts",
      "shared/branding.ts",
      "server/brandingUpload.ts",
    ]) {
      const src = read(p);
      expect(src, p).not.toMatch(/afandy|أفندي|الأساور|أسورة|اساور/i);
      expect(src, p).not.toMatch(/businessId\s*(===?|==)\s*\d/);
      expect(src, p).not.toMatch(/businessId:\s*1\b/);
    }
  });
  it("🔒 رأس السايدبار وشريط الموبايل بيعرضوا هوية النشاط (BusinessSwitcher) مش لوجو المنصة", () => {
    const layout = read("client/src/components/DashboardLayout.tsx");
    const header = layout.slice(layout.indexOf("<SidebarHeader"), layout.indexOf("</SidebarHeader>"));
    expect(header).toContain('<BusinessSwitcher variant="sidebar" collapsed={isCollapsed} />');
    expect(header).not.toContain("<BrandLogo");
    const topbar = layout.slice(layout.indexOf("<header"), layout.indexOf("</header>"));
    expect(topbar).toContain('{isMobile && <BusinessSwitcher variant="topbar" />}');
  });
  it("🔒 الاسم واللوجو من القاعدة: activeList بيرجّع logoUrl والمبدّل بيقرأ activeBusiness", () => {
    const routers = read("server/routers.ts");
    const block = routers.slice(routers.indexOf("activeList: authenticatedProcedure"), routers.indexOf("setLogo: adminProcedure"));
    expect(block).toContain("withBusinessLogos(");
    expect(block).toContain("sessionBusinessIds(ctx)");
    const sw = read("client/src/components/shell/BusinessSwitcher.tsx");
    expect(sw).toContain("activeBusiness?.name");
    expect(sw).toContain("activeBusiness.logoUrl");
    expect(sw).toContain("businesses.length <= 1) return face"); // نشاط واحد → بلا قائمة
  });
  it("🔒 setLogo: أدمن + نطاق + مرجع مملوك للتينانت", () => {
    const routers = read("server/routers.ts");
    const block = routers.slice(routers.indexOf("setLogo: adminProcedure"), routers.indexOf("setLogo: adminProcedure") + 900);
    expect(block).toContain("scopeBusinessId(ctx, input.businessId)");
    expect(block).toContain("isOwnedLogoUrl(input.logoUrl, ctx.tenantId)");
  });
  it("🔒 الرفع للمالك/الأدمن فقط، ملف ≤ 2MB بتوقيع محتوى، وعرض بنفس التينانت — بلا Base64 في القاعدة", () => {
    const up = read("server/brandingUpload.ts");
    expect(up).toContain("isAdminTierRole(emp.role)");
    expect(up).toContain("hasValidSignature(");
    expect(up).toContain("2 * 1024 * 1024");
    expect(up).toContain("Number(m[1]) !== scope.tenantId");
    expect(up).toContain("putObject(");
    expect(read("server/db.ts")).not.toMatch(/base64/i);
  });
  it("🔒 تبديل النشاط بيمسح cache والمسودات، ونشاط واحد بيتحدد تلقائيًا", () => {
    const ctx = read("client/src/contexts/BusinessContext.tsx");
    expect(ctx).toContain("resetForBusinessSwitch(queryClient, id)");
    expect(ctx).toContain("resolveActiveBusinessId(businesses, currentBusinessId)");
    const fe = read("client/src/pages/FacebookEntry.tsx");
    expect(fe).toContain("activeDraftKey(draftKey(readEmployeeScope()), activeBusinessId, entryMode)");
  });
  it("🔒 نافذة Bosta: نشاط واحد → النموذج مباشرة؛ عدة أنشطة بلا اختيار → اختيار النشاط أولًا", () => {
    const d = read("client/src/components/BostaConnectDialog.tsx");
    expect(d).not.toContain("اختر نشاطًا واحدًا من أعلى الصفحة");
    expect(d).toContain("const needsPick = !businessId && businesses.length > 1");
    expect(d).toContain("setCurrentBusinessId(Number(v))");
  });
});

// ── سلوكي على DB ──
function pngBuffer(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
}

describe.runIf(CAN)("🔒 هوية النشاط — سلوكي", () => {
  let A: CoreTestFixture, B: CoreTestFixture;
  const tag = Date.now();
  const ids = { empIds: [] as number[], bizIds: [] as number[] };
  let ownerA = 0, ownerB = 0, empA = 0, empB = 0, secondA = 0;
  const insId = (r: any) => Number((Array.isArray(r) ? r[0] : r)?.insertId ?? r?.id);
  const savedS3 = process.env.S3_BUCKET;
  const uploadedFiles: string[] = [];

  const owner = (tenantId: number, userId: number) => appRouter.createCaller({
    user: { id: userId, role: "admin", name: "owner" }, employee: null, tenantId,
    req: { protocol: "https", headers: {}, cookies: {} }, res: { clearCookie: () => {}, cookie: () => {} },
  } as any);
  // جلسة موظف غير إداري زي ما createContext بيبنيها: `user = null` و`employee` = صفّه
  // (بنشاطه وtenant بتاعه) — المصدر الوحيد لنطاقه على السيرفر.
  const emp = async (employeeId: number) => {
    const row = await getEmployeeById(employeeId);
    return appRouter.createCaller({
      user: null, employee: row, tenantId: row?.tenantId ?? null,
      req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, process.env.JWT_SECRET as string) } },
      res: { clearCookie: () => {}, cookie: () => {} },
    } as any);
  };
  const code = async (fn: () => Promise<any>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } };
  const cookieFor = (employeeId: number) => `employee_token=${jwt.sign({ employeeId }, process.env.JWT_SECRET as string)}`;
  const app = express();
  app.use(cookieParser());
  registerBrandingRoutes(app);

  beforeAll(async () => {
    const d = await getDb(); if (!d) return;
    delete process.env.S3_BUCKET; // قرص محلي في الاختبار
    A = await createCoreTestFixture("brand-a"); B = await createCoreTestFixture("brand-b");
    ownerA = insId(await createEmployee({ name: "owner A", role: "admin", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `brand_oa_${tag}` } as any));
    ownerB = insId(await createEmployee({ name: "owner B", role: "admin", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `brand_ob_${tag}` } as any));
    empA = insId(await createEmployee({ name: "emp A", role: "data_entry", isActive: true, tenantId: A.tenantId, businessId: A.businessId, username: `brand_ea_${tag}` } as any));
    empB = insId(await createEmployee({ name: "emp B", role: "data_entry", isActive: true, tenantId: B.tenantId, businessId: B.businessId, username: `brand_eb_${tag}` } as any));
    ids.empIds.push(ownerA, ownerB, empA, empB);
  });
  afterAll(async () => {
    const d = await getDb(); if (!d) return;
    if (savedS3 != null) process.env.S3_BUCKET = savedS3;
    const allBiz = [A.businessId, B.businessId, ...ids.bizIds];
    await d.delete(businessConfigurationValues).where(and(inArray(businessConfigurationValues.businessId, allBiz), eq(businessConfigurationValues.namespace, BRANDING_NAMESPACE)));
    if (ids.bizIds.length) await d.delete(businesses).where(inArray(businesses.id, ids.bizIds));
    if (ids.empIds.length) await d.delete(employees).where(inArray(employees.id, ids.empIds));
    for (const f of uploadedFiles) { try { fs.unlinkSync(path.resolve(process.cwd(), "uploads", "branding", f)); } catch { /* */ } }
    await B?.cleanup(); await A?.cleanup();
  });

  it("🔑 مالك نشاط واحد: activeList = نشاطه فقط، بلا لوجو → الواجهة بتعرض الحرف الأول", async () => {
    const list = await owner(A.tenantId, ownerA).businesses.activeList();
    expect(list.map(b => b.id)).toEqual([A.businessId]);
    expect(list[0].logoUrl).toBeNull();
    expect(brandInitial(list[0].name)).toBe(Array.from(list[0].name.trim())[0].toUpperCase());
  });

  it("🔒 موظف B لا يرى نشاط A والعكس", async () => {
    const la = (await (await emp(empA)).businesses.activeList());
    const lb = (await (await emp(empB)).businesses.activeList());
    expect(la.map(b => b.id)).toEqual([A.businessId]);
    expect(lb.map(b => b.id)).toEqual([B.businessId]);
  });

  it("🔑 الرفع: الموظف مرفوض (403)، المالك يرفع PNG → مرجع بنفس التينانت؛ محتوى غير مطابق → 415", async () => {
    const asEmp = await request(app).post("/api/branding/upload").set("Cookie", cookieFor(empA)).attach("file", pngBuffer(), { filename: "logo.png", contentType: "image/png" });
    expect(asEmp.status).toBe(403);
    const anon = await request(app).post("/api/branding/upload").attach("file", pngBuffer(), { filename: "logo.png", contentType: "image/png" });
    expect(anon.status).toBe(403);
    const bad = await request(app).post("/api/branding/upload").set("Cookie", cookieFor(ownerA)).attach("file", Buffer.from("not-a-png"), { filename: "logo.png", contentType: "image/png" });
    expect(bad.status).toBe(415);
    const ok = await request(app).post("/api/branding/upload").set("Cookie", cookieFor(ownerA)).attach("file", pngBuffer(), { filename: "logo.png", contentType: "image/png" });
    expect(ok.status).toBe(201);
    expect(ok.body.url).toMatch(new RegExp(`^/api/branding/files/t${A.tenantId}-logo-[a-f0-9-]+\\.png$`));
    uploadedFiles.push(ok.body.url.split("/").pop());
    // العرض: نفس التينانت (حتى الموظف) 200؛ تينانت تاني 404؛ بلا جلسة 404
    expect((await request(app).get(ok.body.url).set("Cookie", cookieFor(empA))).status).toBe(200);
    expect((await request(app).get(ok.body.url).set("Cookie", cookieFor(ownerB))).status).toBe(404);
    expect((await request(app).get(ok.body.url)).status).toBe(404);
    // الربط بالنشاط
    await owner(A.tenantId, ownerA).businesses.setLogo({ businessId: A.businessId, logoUrl: ok.body.url });
    expect((await owner(A.tenantId, ownerA).businesses.activeList())[0].logoUrl).toBe(ok.body.url);
    expect(((await (await emp(empA)).businesses.activeList()))[0].logoUrl).toBe(ok.body.url); // الموظف يرى اللوجو
  });

  it("🔒 تزوير: مرجع لوجو تينانت آخر مرفوض، setLogo على نشاط آخر FORBIDDEN، الموظف FORBIDDEN، تغيير الاسم لنشاط آخر FORBIDDEN", async () => {
    const foreign = `/api/branding/files/t${A.tenantId}-logo-0f3a1c2e-1111-2222-3333-444444444444.png`;
    expect(await code(() => owner(B.tenantId, ownerB).businesses.setLogo({ businessId: B.businessId, logoUrl: foreign }))).toBe("BAD_REQUEST");
    expect(await code(() => owner(B.tenantId, ownerB).businesses.setLogo({ businessId: B.businessId, logoUrl: "https://evil.example/x.png" }))).toBe("BAD_REQUEST");
    expect(await code(() => owner(B.tenantId, ownerB).businesses.setLogo({ businessId: A.businessId, logoUrl: null }))).toBe("FORBIDDEN");
    expect(await code(async () => (await emp(empA)).businesses.setLogo({ businessId: A.businessId, logoUrl: null }))).not.toBe("ok");
    expect(await code(() => owner(B.tenantId, ownerB).businesses.update({ id: A.businessId, name: "hijack" }))).toBe("FORBIDDEN");
    // لوجو A لم يُلمس
    expect((await owner(A.tenantId, ownerA).businesses.activeList())[0].logoUrl).toMatch(/^\/api\/branding\/files\//);
  });

  it("🔑 مالك عدة أنشطة: كل نشاط باسمه ولوجوه، وتعديل الاسم للمالك فقط، والحذف يرجّع الحرف الأول", async () => {
    await createBusiness({ name: `براند ثانٍ ${tag}`, slug: `brand2-${tag}`.slice(0, 50), tenantId: A.tenantId } as any);
    const d = (await getDb())!;
    const [row] = await d.select({ id: businesses.id }).from(businesses).where(eq(businesses.slug, `brand2-${tag}`.slice(0, 50)));
    secondA = row.id; ids.bizIds.push(secondA);
    const list = await owner(A.tenantId, ownerA).businesses.activeList();
    expect(list.map(b => b.id).sort()).toEqual([A.businessId, secondA].sort());
    expect(list.find(b => b.id === secondA)!.logoUrl).toBeNull();
    expect(list.find(b => b.id === A.businessId)!.logoUrl).not.toBeNull(); // منفصل لكل نشاط
    // تعديل اسم البراند
    await owner(A.tenantId, ownerA).businesses.update({ id: secondA, name: `براند معدّل ${tag}` });
    expect((await owner(A.tenantId, ownerA).businesses.activeList()).find(b => b.id === secondA)!.name).toBe(`براند معدّل ${tag}`);
    expect(await code(async () => (await emp(empA)).businesses.update({ id: secondA, name: "x" }))).not.toBe("ok");
    // الموظف A مربوط بنشاط A فقط — النشاط الثاني مش في قايمته
    expect(((await (await emp(empA)).businesses.activeList())).map(b => b.id)).toEqual([A.businessId]);
    // حذف اللوجو
    await owner(A.tenantId, ownerA).businesses.setLogo({ businessId: A.businessId, logoUrl: null });
    expect((await owner(A.tenantId, ownerA).businesses.activeList()).find(b => b.id === A.businessId)!.logoUrl).toBeNull();
  });
});
