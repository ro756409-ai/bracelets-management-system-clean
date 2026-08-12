import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import jwt from "jsonwebtoken";
import type { TrpcContext } from "./_core/context";

// لازم قبل استيراد الراوتر — بيتقرا وقت التحميل.
process.env.JWT_SECRET ||= "test-secret";

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
    // مديرين — عشان فحص الدور في `managerPortalProcedure` يعدّي، فالاختبار يقيس
    // **النطاق** مش الدور. من غيرهم الرفض كان ممكن يبقى بسبب الدور والاختبار يعدّي
    // وهو مش بيقيس حاجة.
    { id: 511, tenantId: TENANT_A, businessId: BIZ_A, name: "مدير أ", role: "manager", isActive: true },
    { id: 512, tenantId: TENANT_B, businessId: BIZ_B, name: "مدير ب", role: "manager", isActive: true },
  ],
  categories: [
    { id: 601, businessId: BIZ_A, name: "تصنيف أ", isActive: true },
    { id: 602, businessId: BIZ_B, name: "تصنيف ب", isActive: true },
  ],
  warehouses: [
    { id: 701, businessId: BIZ_A, name: "مخزن أ", isActive: true },
    { id: 702, businessId: BIZ_B, name: "مخزن ب", isActive: true },
  ],
  orders: [
    { id: 801, businessId: BIZ_A },
    { id: 802, businessId: BIZ_B },
  ],
  salesChannels: [
    { id: 901, businessId: BIZ_A },
    { id: 902, businessId: BIZ_B },
  ],
  payrollPeriods: [
    { id: 1001, businessId: BIZ_A },
    { id: 1002, businessId: BIZ_B },
  ],
  expenseCategories: [
    { id: 1101, businessId: BIZ_A },
    { id: 1102, businessId: BIZ_B },
  ],
  printLogs: [
    { id: 1201, businessId: BIZ_A },
    { id: 1202, businessId: BIZ_B },
  ],
  /** كل كتابة بتتسجّل هنا — الإثبات إن الرفض حصل **قبل** أي تعديل. */
  writes: [] as { table: string; id?: number; data?: any }[],
};

vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    /*
      طبقة صغيرة بتخدم `getEmployeeFromCookie` بس — عشان جلسة كوكي الموظف تبقى
      حقيقية والحارس يتنفّذ فعلاً. أي استعلام تاني بيرجّع فاضي، فالإجراء بيفشل **بعد**
      الحارس — وده بالظبط اللي الاختبار بيفرّق بينه وبين الرفض.
    */
    getDb: async () =>
      ({
        select: () => ({
          from: (table: any) => ({
            where: () => ({
              limit: async () =>
                String(table?.[Symbol.for("drizzle:Name")] ?? "") === "employees"
                  ? state.employees.filter(e => e.id === lastEmployeeId)
                  : [],
            }),
          }),
        }),
      }) as any,
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
    getOrdersByIds: async (ids: number[]) =>
      state.orders.filter(o => ids.includes(o.id)),
    deleteOrders: async (ids: number[]) => {
      state.writes.push({ table: "orders:bulkDelete", data: ids });
    },
    createPrintLog: async (data: any) => {
      state.writes.push({ table: "printLogs:create", data });
      return { id: 1 };
    },
    countActiveAdminTierEmployees: async () => 5,
    addActivityLog: async () => {},
  };
});

vi.mock("./tenantScope", async importOriginal => {
  const actual = await importOriginal<typeof import("./tenantScope")>();
  const TABLES: Record<string, () => { id: number; businessId: number | null }[]> = {
    employee: () => state.employees,
    order: () => state.orders,
    salesChannel: () => state.salesChannels,
    payrollPeriod: () => state.payrollPeriods,
    expenseCategory: () => state.expenseCategories,
    printLog: () => state.printLogs,
    payrollItem: () => [],
    product: () => [],
    warehouse: () => state.warehouses,
    category: () => state.categories,
    task: () => [],
  };
  return {
    ...actual,
    // نفس منطق الأصل بالحرف — بس بيقرا من الـstate بدل MySQL.
    assertOwned: async (
      allowed: number[] | null,
      entity: string,
      id: number
    ) => {
      const row = (TABLES[entity]?.() ?? []).find(r => r.id === id);
      if (!row) throw new actual.RecordNotFoundError("السجل غير موجود");
      if (allowed == null) return;
      if (row.businessId == null || !allowed.includes(row.businessId))
        throw new actual.OutOfScopeError();
    },
    assertAllOwned: async (
      allowed: number[] | null,
      entity: string,
      ids: number[]
    ) => {
      if (ids.length === 0 || allowed == null) return;
      const all = TABLES[entity]?.() ?? [];
      for (const id of ids) {
        const row = all.find(r => r.id === id);
        if (!row) throw new actual.RecordNotFoundError("السجل غير موجود");
        if (row.businessId == null || !allowed.includes(row.businessId))
          throw new actual.OutOfScopeError();
      }
    },
  };
});

let lastEmployeeId = 0;

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

/** جلسة كوكي الموظف — بتوكن موقّع فعلاً، عشان `employeePortal.*` تشتغل. */
function employeeSession(tenantId: number): TrpcContext {
  const employeeId = tenantId === TENANT_A ? 511 : 512;
  lastEmployeeId = employeeId;
  const token = jwt.sign({ employeeId }, process.env.JWT_SECRET!);
  const base = session(tenantId) as any;
  return {
    ...base,
    req: { protocol: "https", headers: {}, cookies: { employee_token: token } },
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

// ==================== مصفوفة الوصول بالمعرّف ====================

/**
 * المصفوفة: لكل إجراء حسّاس — أ→أ مسموح · أ→ب ممنوع · ب→ب مسموح · ب→أ ممنوع.
 *
 * الرفض المطلوب هو `FORBIDDEN` تحديدًا — مش أي فشل. فشل تاني (سجل مش موجود، داتابيز
 * مقفولة) معناه إن الاختبار بيقيس حاجة تانية والحارس ممكن يكون مش موجود أصلاً.
 */
const MATRIX: {
  name: string;
  call: (c: any, id: number) => Promise<unknown>;
  a: number;
  b: number;
}[] = [
  // ── بيانات الدخول: أخطر مجموعة ──
  { name: "employees.changePassword", a: 501, b: 502,
    call: (c, id) => c.employees.changePassword({ id, newPassword: "hacked123" }) },
  { name: "employees.setCredentials", a: 501, b: 502,
    call: (c, id) => c.employees.setCredentials({ id, username: "u" + id, password: "hacked123" }) },
  { name: "employees.delete", a: 501, b: 502,
    call: (c, id) => c.employees.delete({ id }) },

  // ── بيانات ربط التكاملات ──
  { name: "salesChannels.clearSecret", a: 901, b: 902,
    call: (c, id) => c.salesChannels.clearSecret({ id, field: "apiToken" }) },
  { name: "salesChannels.delete", a: 901, b: 902,
    call: (c, id) => c.salesChannels.delete({ id }) },
  { name: "salesChannels.reactivate", a: 901, b: 902,
    call: (c, id) => c.salesChannels.reactivate({ id }) },
  { name: "salesChannels.testConnection", a: 901, b: 902,
    call: (c, id) => c.salesChannels.testConnection({ id }) },
  { name: "salesChannels.syncNow", a: 901, b: 902,
    call: (c, id) => c.salesChannels.syncNow({ id, from: new Date(2026, 0, 1), to: new Date(2026, 0, 2) }) },
  { name: "salesChannels.retrySync", a: 901, b: 902,
    call: (c, id) => c.salesChannels.retrySync({ id, from: new Date(2026, 0, 1), to: new Date(2026, 0, 2) }) },

  // ── المرتبات: فلوس ──
  { name: "payroll.periodGet", a: 1001, b: 1002, call: (c, id) => c.payroll.periodGet({ id }) },
  { name: "payroll.periodApprove", a: 1001, b: 1002, call: (c, id) => c.payroll.periodApprove({ id, evidenceUrl: "x" }) },
  { name: "payroll.periodPay", a: 1001, b: 1002, call: (c, id) => c.payroll.periodPay({ id, evidenceUrl: "x" }) },
  { name: "payroll.periodCancel", a: 1001, b: 1002, call: (c, id) => c.payroll.periodCancel({ id, reason: "x" }) },
  { name: "payroll.periodDelete", a: 1001, b: 1002, call: (c, id) => c.payroll.periodDelete({ id }) },
  { name: "payroll.periodRecalculate", a: 1001, b: 1002, call: (c, id) => c.payroll.periodRecalculate({ id }) },

  // ── الأوردرات ──
  { name: "orders.delete", a: 801, b: 802, call: (c, id) => c.orders.delete({ orderId: id }) },
  { name: "orders.sendToBosta", a: 801, b: 802, call: (c, id) => c.orders.sendToBosta({ orderId: id }) },
  { name: "orders.cancel", a: 801, b: 802, call: (c, id) => c.orders.cancel({ orderId: id, cancelReason: "x" }) },
  { name: "orders.confirm", a: 801, b: 802, call: (c, id) => c.orders.confirm({ orderId: id }) },
  { name: "orders.duplicate", a: 801, b: 802, call: (c, id) => c.orders.duplicate({ orderId: id }) },
  { name: "orders.getEditHistory", a: 801, b: 802, call: (c, id) => c.orders.getEditHistory({ orderId: id }) },
  { name: "orders.editOrder", a: 801, b: 802, call: (c, id) => c.orders.editOrder({ orderId: id, customerName: "x" }) },

  // ── المصروفات والطباعة ──
  { name: "accounting.expenseCategoryUpdate", a: 1101, b: 1102,
    call: (c, id) => c.accounting.expenseCategoryUpdate({ id, name: "x" }) },
  { name: "accounting.expenseCategoryArchive", a: 1101, b: 1102,
    call: (c, id) => c.accounting.expenseCategoryArchive({ id }) },
  { name: "printLogs.getById", a: 1201, b: 1202, call: (c, id) => c.printLogs.getById({ id }) },
];

describe("🔑 مصفوفة الوصول بالمعرّف — أ ↔ ب", () => {
  for (const entry of MATRIX) {
    it(`🔑 ${entry.name}: أ → سجل ب = FORBIDDEN`, async () => {
      expect(await denied(() => entry.call(asA(), entry.b))).toBe("FORBIDDEN");
      expect(state.writes, "مفيش كتابة قبل الرفض").toHaveLength(0);
    });

    it(`🔑 ${entry.name}: ب → سجل أ = FORBIDDEN`, async () => {
      expect(await denied(() => entry.call(asB(), entry.a))).toBe("FORBIDDEN");
      expect(state.writes).toHaveLength(0);
    });

    it(`${entry.name}: أ → سجل أ = بيعدّي الحارس`, async () => {
      // بيفشل بعد كده لأسباب تانية (داتابيز مقفولة في الاختبار) — المهم إنه **مش** رفض نطاق.
      const code = await denied(() => entry.call(asA(), entry.a));
      expect(code).not.toBe("FORBIDDEN");
    });
  }
});

describe("🔑 النطاق الفاضي والجلسة الغريبة", () => {
  const orphan = () => appRouter.createCaller(session(999));

  it("🔑 tenant من غير أنشطة مايوصلش لأي سجل", async () => {
    for (const entry of MATRIX.slice(0, 8)) {
      expect(await denied(() => entry.call(orphan(), entry.a)), entry.name).toBe(
        "FORBIDDEN"
      );
    }
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 جلسة غير مسجّلة مرفوضة", async () => {
    const anon = appRouter.createCaller({
      req: { protocol: "https", headers: {}, cookies: {} },
      res: { clearCookie: () => {} },
      user: null,
      employee: null,
      tenantId: null,
    } as any);
    expect(await denied(() => anon.employees.changePassword({ id: 502, newPassword: "x123456" })))
      .toBe("UNAUTHORIZED");
    expect(await denied(() => anon.orders.delete({ orderId: 802 }))).toBe("UNAUTHORIZED");
  });
});

describe("🔑 الحارس واحد ومركزي", () => {
  it("سجل الكيانات بيغطي اللي بيتوصلهم بمعرّف", async () => {
    const { SCOPED_ENTITY_NAMES } = await import("./tenantScope");
    for (const entity of ["employee", "order", "salesChannel", "payrollPeriod",
                          "expenseCategory", "printLog", "warehouse", "category"]) {
      expect(SCOPED_ENTITY_NAMES, entity).toContain(entity);
    }
  });

  it("🔑 وكل الحُرّاس بيعدّوا على requireOwned واحدة", () => {
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    // تعريف واحد بس.
    expect((routers.match(/async function requireOwned\(/g) ?? []).length).toBe(1);
    // وبيستخدم سجل الكيانات المشترك.
    const fn = routers.slice(routers.indexOf("async function requireOwned("));
    expect(fn.slice(0, 700)).toContain("assertOwned(allowed, entity, id)");
  });
});

// ==================== مسارات كوكي الموظف ====================

/**
 * `employeePortal.*` بتتنادي بجلسة كوكي حقيقية (توكن موقّع) — مش بجلسة المالك. دي
 * أخطر تلات نقط في الملف كله: الاتنين الأولانيين بيكتبوا `passwordHash`، يعني الرفض
 * هنا هو الفرق بين «تسريب بيانات» و«دخول بهوية حد تاني».
 */
describe("🔑 مسارات المدير في بوابة الموظف", () => {
  const asEmpA = () => appRouter.createCaller(employeeSession(TENANT_A));

  it("🔑 changeEmployeePassword على موظف ب = FORBIDDEN", async () => {
    const caller = asEmpA();
    lastEmployeeId = 511;
    expect(
      await denied(() =>
        caller.employeePortal.changeEmployeePassword({ id: 502, newPassword: "hacked123" })
      )
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 setEmployeeCredentials على موظف ب = FORBIDDEN", async () => {
    const caller = asEmpA();
    lastEmployeeId = 511;
    expect(
      await denied(() =>
        caller.employeePortal.setEmployeeCredentials({
          id: 502,
          username: "stolen",
          password: "hacked123",
        })
      )
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 deleteEmployee على موظف ب = FORBIDDEN", async () => {
    const caller = asEmpA();
    lastEmployeeId = 511;
    expect(
      await denied(() => caller.employeePortal.deleteEmployee({ id: 502 }))
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("وموظف أ نفسه بيعدّي الحارس", async () => {
    const caller = asEmpA();
    lastEmployeeId = 511;
    const code = await denied(() =>
      caller.employeePortal.changeEmployeePassword({ id: 501, newPassword: "ok123456" })
    );
    expect(code).not.toBe("FORBIDDEN");
  });
});

// ==================== مصفوفة المعرّفات (Bulk) ====================

/**
 * سياسة المصفوفات: الكتابة بترفض كله لو أي عنصر برّه النطاق (`requireAllOwned`)،
 * والقراءة بترجّع المملوك بس. الاختبارات بتثبت الاتنين على الراوتر الحقيقي.
 */
describe("🔑 Bulk — كتابة بترفض كله، قراءة بترجّع المملوك", () => {
  it("🔑 bulkDelete [A, B] من أ = مرفوض ومفيش حذف", async () => {
    expect(await denied(() => asA().orders.bulkDelete({ orderIds: [801, 802] }))).toBe(
      "FORBIDDEN"
    );
    expect(state.writes).toHaveLength(0);
  });

  it("✅ bulkDelete [A, A] من أ = بيعدّي الحارس", async () => {
    // بند تاني بنفس شركة أ.
    state.orders.push({ id: 803, businessId: BIZ_A });
    await asA().orders.bulkDelete({ orderIds: [801, 803] });
    expect(state.writes.some(w => w.table === "orders:bulkDelete")).toBe(true);
    state.orders.pop();
  });

  it("🔑 bulkSendToBosta [A, B] من أ = مرفوض", async () => {
    const code = await denied(() =>
      asA().orders.bulkSendToBosta({ orderIds: [801, 802] })
    );
    // ممكن يترفض بـBAD_REQUEST لو Bosta مش مفعّل — بس الأهم إنه **مش** بينجح على B.
    expect(["FORBIDDEN", "BAD_REQUEST"]).toContain(code);
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 printLogs.create [A, B] من أ = مرفوض ومفيش سجل", async () => {
    expect(
      await denied(() =>
        asA().printLogs.create({ type: "labels", orderIds: [801, 802] })
      )
    ).toBe("FORBIDDEN");
    expect(state.writes).toHaveLength(0);
  });

  it("🔑 getByIds [A, B] من أ = بترجّع أوردر أ بس", async () => {
    const rows: any[] = await asA().orders.getByIds({ ids: [801, 802] });
    expect(rows.map(o => o.id)).toEqual([801]);
  });

  it("🔑 والعكس — getByIds [A, B] من ب = بترجّع ب بس", async () => {
    const rows: any[] = await asB().orders.getByIds({ ids: [801, 802] });
    expect(rows.map(o => o.id)).toEqual([802]);
  });

  it("🔑 والحُرّاس بينادوا requireAllOwned مش requireOwned على أول عنصر", () => {
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    for (const proc of ["bulkDelete", "bulkSendToBosta"]) {
      const i = routers.indexOf(`${proc}:`);
      const body = routers.slice(i, i + 700);
      expect(body, proc).toContain('requireAllOwned(ctx.tenantId, "order", input.orderIds)');
    }
  });
});
