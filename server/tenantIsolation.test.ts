import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import type { TrpcContext } from "./_core/context";

/**
 * عزل الشركات — جلستين حقيقيتين على الراوتر الحقيقي.
 *
 * الاختبارات دي **مش** بتقرا نص الكود. بتعمل tenant أ وtenant ب، وبتنادي الإجراءات
 * بجلسة كل واحد، وبتتأكد إن أ مايشوفش ومايعدّلش حاجة تخص ب — حتى لما يبعت الـid بإيده.
 *
 * قاعدة البيانات متبدّلة بطبقة في الذاكرة عشان الاختبار يشتغل من غير MySQL. الطبقة دي
 * بتنفّذ اللي الحُرّاس بيعتمدوا عليه بالظبط: `businesses.tenantId` هو مصدر النطاق،
 * والقراءة بترجّع الصفوف المطابقة للشرط. لو حارس اتشال، النداء بيعدّي والاختبار بيقع.
 */

// ── بيانات وهمية: نشاطين، كل واحد لـtenant مختلف ─────────────────────────
const TENANT_A = 1;
const TENANT_B = 2;
const BIZ_A = 10;
const BIZ_B = 20;

const state = {
  businesses: [
    { id: BIZ_A, tenantId: TENANT_A, name: "شركة أ", slug: "a", groupId: 100, isActive: true },
    { id: BIZ_B, tenantId: TENANT_B, name: "شركة ب", slug: "b", groupId: 200, isActive: true },
  ],
  groups: [
    { id: 100, tenantId: TENANT_A, name: "مجموعة أ", slug: "ga", isActive: true },
    { id: 200, tenantId: TENANT_B, name: "مجموعة ب", slug: "gb", isActive: true },
  ],
  employees: [
    { id: 501, tenantId: TENANT_A, businessId: BIZ_A, name: "موظف أ", role: "agent", isActive: true },
    { id: 502, tenantId: TENANT_B, businessId: BIZ_B, name: "موظف ب", role: "agent", isActive: true },
  ],
  categories: [
    { id: 601, businessId: BIZ_A, name: "تصنيف أ", isActive: true },
    { id: 602, businessId: BIZ_B, name: "تصنيف ب", isActive: true },
  ],
  warehouses: [
    { id: 701, businessId: BIZ_A, name: "مخزن أ", isActive: true },
    { id: 702, businessId: BIZ_B, name: "مخزن ب", isActive: true },
  ],
  /** كل كتابة بتتسجّل هنا — الإثبات إن الرفض حصل **قبل** أي تعديل. */
  writes: [] as { table: string; id?: number; data?: any }[],
};

vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getDb: async () => null,
    getBusinessIdsForTenant: async (tenantId: number) =>
      state.businesses.filter(b => b.tenantId === tenantId).map(b => b.id),
    getAllBusinesses: async (ids?: number[]) =>
      ids ? state.businesses.filter(b => ids.includes(b.id)) : state.businesses,
    getActiveBusinesses: async (ids?: number[]) =>
      ids && ids.length > 0
        ? state.businesses.filter(b => ids.includes(b.id))
        : state.businesses,
    getActiveBusinessGroups: async () => state.groups,
    getBusinessGroupsWithBusinesses: async () =>
      state.groups.map(g => ({
        ...g,
        businesses: state.businesses.filter(b => b.groupId === g.id),
      })),
    getBusinessById: async (id: number) => state.businesses.find(b => b.id === id),
    updateBusiness: async (id: number, data: any) => {
      state.writes.push({ table: "businesses", id, data });
    },
    getEmployeeById: async (id: number) => state.employees.find(e => e.id === id),
    getAllEmployees: async () => state.employees,
    updateEmployee: async (id: number, data: any) => {
      state.writes.push({ table: "employees", id, data });
    },
    getCategoryById: async (id: number) => state.categories.find(c => c.id === id),
    createCategory: async (data: any) => {
      state.writes.push({ table: "categories", data });
    },
    updateCategory: async (id: number, data: any) => {
      state.writes.push({ table: "categories", id, data });
    },
    getWarehouseById: async (id: number) => state.warehouses.find(w => w.id === id),
    createWarehouse: async (data: any) => {
      state.writes.push({ table: "warehouses", data });
    },
    updateWarehouse: async (id: number, data: any) => {
      state.writes.push({ table: "warehouses", id, data });
    },
    countActiveAdminTierEmployees: async () => 5,
    addActivityLog: async () => {},
  };
});

const { appRouter } = await import("./routers");

function session(tenantId: number): TrpcContext {
  return {
    req: { protocol: "https", headers: {}, cookies: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
    user: {
      id: -1,
      openId: `owner-${tenantId}`,
      email: `owner${tenantId}@example.com`,
      name: `مالك ${tenantId}`,
      loginMethod: "employee",
      role: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as any,
    employee: {
      id: tenantId === TENANT_A ? 501 : 502,
      name: "مالك",
      role: "super_admin",
      tenantId,
      businessId: tenantId === TENANT_A ? BIZ_A : BIZ_B,
      isActive: true,
    } as any,
    tenantId,
  } as TrpcContext;
}

const asA = () => appRouter.createCaller(session(TENANT_A));
const asB = () => appRouter.createCaller(session(TENANT_B));

async function denied(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "ALLOWED";
  } catch (error: any) {
    return error?.code ?? String(error?.message ?? error);
  }
}

beforeEach(() => {
  state.writes = [];
});

// ==================== القراءة ====================

describe("🔑 P0-1 · أ مايشوفش أنشطة ولا مجموعات ب", () => {
  it("🔑 activeList بترجّع نشاط أ بس", async () => {
    const list = await asA().businesses.activeList();
    expect(list.map((b: any) => b.id)).toEqual([BIZ_A]);
  });

  it("🔑 list بترجّع نشاط أ بس", async () => {
    const list = await asA().businesses.list();
    expect(list.map((b: any) => b.id)).toEqual([BIZ_A]);
  });

  it("🔑 groupsWithBusinesses — مجموعة أ بس، ومفيش أي نشاط لـب", async () => {
    const groups = await asA().businesses.groupsWithBusinesses();
    expect(groups.map((g: any) => g.id)).toEqual([100]);
    const ids = groups.flatMap((g: any) => g.businesses.map((b: any) => b.id));
    expect(ids).toEqual([BIZ_A]);
    expect(JSON.stringify(groups)).not.toContain("شركة ب");
  });

  it("🔑 groups — مجموعة ب مابتظهرش حتى بالاسم", async () => {
    const groups = await asA().businesses.groups();
    expect(groups.map((g: any) => g.id)).toEqual([100]);
    expect(JSON.stringify(groups)).not.toContain("مجموعة ب");
  });

  it("🔑 والعكس صحيح — ب مايشوفش أ", async () => {
    const groups = await asB().businesses.groupsWithBusinesses();
    expect(groups.map((g: any) => g.id)).toEqual([200]);
    expect(JSON.stringify(groups)).not.toContain("شركة أ");
  });

  it("🔑 businesses.get على نشاط ب ← مرفوض", async () => {
    expect(await denied(() => asA().businesses.get({ id: BIZ_B }))).toBe("FORBIDDEN");
  });

  it("🔑 employees.get على موظف ب ← مرفوض", async () => {
    expect(await denied(() => asA().employees.get({ id: 502 }))).toBe("FORBIDDEN");
  });

  it("وموظف أ نفسه بيتقرا عادي", async () => {
    const employee: any = await asA().employees.get({ id: 501 });
    expect(employee?.id).toBe(501);
  });
});

// ==================== الكتابة ====================

describe("🔑 P0-2 · أ مايعدّلش موظفين ب", () => {
  it("🔑 تعطيل موظف ب ← مرفوض ومفيش كتابة", async () => {
    expect(
      await denied(() => asA().employees.update({ id: 502, isActive: false }))
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 تغيير دور موظف ب ← مرفوض", async () => {
    expect(
      await denied(() => asA().employees.update({ id: 502, role: "warehouse" }))
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 نقل موظف ب لنشاط أ ← مرفوض", async () => {
    expect(
      await denied(() => asA().employees.update({ id: 502, businessId: BIZ_A }))
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 ونقل موظف أ لنشاط ب ← مرفوض كمان (الاتجاه التاني)", async () => {
    expect(
      await denied(() => asA().employees.update({ id: 501, businessId: BIZ_B }))
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("✅ وتعديل موظف أ جوه نطاقه بيعدّي عادي", async () => {
    await asA().employees.update({ id: 501, name: "اسم جديد" });
    expect(state.writes).toEqual([
      { table: "employees", id: 501, data: expect.objectContaining({ name: "اسم جديد" }) },
    ]);
  });
});

describe("🔑 P0-3 · أ مايعطّلش شركة ب", () => {
  it("🔑 isActive:false على نشاط ب ← مرفوض ومفيش كتابة", async () => {
    expect(
      await denied(() => asA().businesses.update({ id: BIZ_B, isActive: false }))
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 وإعادة تسميته ← مرفوض", async () => {
    expect(
      await denied(() => asA().businesses.update({ id: BIZ_B, name: "مخطوف" }))
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("✅ وتعديل نشاط أ بيعدّي", async () => {
    await asA().businesses.update({ id: BIZ_A, name: "اسم جديد" });
    expect(state.writes).toHaveLength(1);
  });
});

describe("🔑 P0-4 · التصنيفات والمخازن", () => {
  it("🔑 إنشاء تصنيف في نشاط ب ← مرفوض", async () => {
    expect(
      await denied(() =>
        asA().businesses.createCategory({ businessId: BIZ_B, name: "تصنيف مدسوس" })
      )
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 تعديل تصنيف تابع لـب ← مرفوض", async () => {
    expect(
      await denied(() => asA().businesses.updateCategory({ id: 602, name: "مخطوف" }))
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 إنشاء مخزن في نشاط ب ← مرفوض", async () => {
    expect(
      await denied(() =>
        asA().businesses.createWarehouse({ businessId: BIZ_B, name: "مخزن مدسوس" })
      )
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 تعطيل مخزن تابع لـب ← مرفوض", async () => {
    expect(
      await denied(() => asA().businesses.updateWarehouse({ id: 702, isActive: false }))
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("✅ وكل ده شغّال عادي جوه نشاط أ", async () => {
    await asA().businesses.createCategory({ businessId: BIZ_A, name: "تصنيف" });
    await asA().businesses.updateCategory({ id: 601, name: "معدّل" });
    await asA().businesses.createWarehouse({ businessId: BIZ_A, name: "مخزن" });
    await asA().businesses.updateWarehouse({ id: 701, name: "معدّل" });
    expect(state.writes).toHaveLength(4);
    // والإنشاء بيتربط بالنشاط المتحقّق مش اللي العميل بعته.
    expect(state.writes[0].data.businessId).toBe(BIZ_A);
    expect(state.writes[2].data.businessId).toBe(BIZ_A);
  });
});

// ==================== P0-5 ====================

describe("🔑 P0-5 · النطاق الفاضي بيمنع، مش بيسمح", () => {
  it("🔑 tenant مالوش أي نشاط مربوط ← مايشوفش حاجة", async () => {
    const orphan = appRouter.createCaller(session(999));
    expect(await orphan.businesses.activeList()).toEqual([]);
    expect(await orphan.businesses.list()).toEqual([]);
    expect(await orphan.businesses.groupsWithBusinesses()).toEqual([]);
    expect(await orphan.businesses.groups()).toEqual([]);
  });

  it("🔑 والحارس مكتوب مرة واحدة — مش متكرر في كل قارئ", () => {
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    expect(routers).toContain("const NO_BUSINESS = -1");
    expect(routers).toContain("function denyWhenEmpty(");
    // `scopeBusinessIds` بيعدّي عليه في المسارين — لما مافيش طلب ولما الترشيح يفضى.
    const fn = routers.slice(
      routers.indexOf("async function scopeBusinessIds("),
      routers.indexOf("async function scopeBusinessId(")
    );
    expect((fn.match(/denyWhenEmpty\(/g) ?? []).length).toBe(2);
  });
});

// ==================== مفيش منطق عزل موازي ====================

describe("🔑 آلية واحدة للعزل", () => {
  it("الحُرّاس الجداد بيعدّوا على scopeBusinessId نفسها", () => {
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    for (const guard of ["assertRecordInScope", "assertEmployeeInScope"]) {
      const start = routers.indexOf(`async function ${guard}`);
      expect(start, guard).toBeGreaterThan(-1);
      const body = routers.slice(start, routers.indexOf("\n}", start));
      expect(body, guard).toContain("scopeBusinessId(");
    }
  });
});
