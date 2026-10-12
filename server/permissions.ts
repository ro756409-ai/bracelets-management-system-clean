/**
 * Bootstrap role → permission mapping. Tenant overrides are loaded from the
 * database by hasTenantPermission(), so daily permission changes need no deploy.
 *
 * "admin"/"super_admin"/"manager" employees are treated as full-access,
 * matching the existing behavior where a manager-role employee already gets
 * a synthetic full-admin session (see server/_core/context.ts). The other
 * roles below have a real, distinct permission set defined here, but are
 * only enforced today on the employee-management endpoints themselves
 * (see server/routers.ts `employees` router) — wiring them into every other
 * existing procedure (orders, reports, etc.) is future System Administration
 * work, not part of this release. Documented as a known limitation.
 */

export const ALL_PERMISSIONS = [
  "dashboard.view",
  "orders.view",
  "orders.create",
  "orders.update",
  // تعديل **محتوى** الأوردر — الأصناف وأنواع الحفر والكميات: إضافة قطعة، حذف قطعة،
  // تغيير المنتج أو الـvariant.
  //
  // مفصولة عن `orders.update` عن قصد. `orders.update` هي تعديل بيانات العميل: الاسم،
  // التليفون، العنوان، المحافظة، الملاحظات. اللي جوه الصندوق مسؤولية تانية خالص —
  // بيحرّك مخزون، وبيغيّر اللي بيتبعت لبوسطة، وبيتطبع على البوليصة. الفصل بيخلّي
  // المالك يدّي موظف حق تصحيح عنوان من غير حق يغيّر الطلب نفسه.
  //
  // الأدوار اللي بتأكد الأوردرات (`order_confirmation` و`agent`) واخداها افتراضيًا،
  // لأن ده شغلها اليومي: العميل بيتكلم في التليفون ويغيّر النقش أو يزوّد قطعة.
  "orders.edit_items",
  "orders.confirm",
  "orders.cancel",
  "orders.export",
  "orders.import",
  "employees.view",
  "employees.manage",
  // مهامي في البوابة: مهامه + المهام العامة لنشاطه، عرض وتحديث الحالة فقط (لا إنشاء ولا حذف).
  "tasks.view_own",
  // المخزون التشغيلي (الكميات والحركات) — منفصل عن التكلفة: adjust لا يعني رؤية التكلفة (inventory_costing.view).
  "inventory.view",
  "inventory.adjust",
  "settings.view",
  "settings.manage",
  "audit.view",
  // وحدة الحسابات. مفصولة لـview/manage لأن قراءة الأرقام ودخول حركة على الخزنة
  // مسؤوليتين مختلفتين: المدير بيبص، المحاسب بيسجّل.
  "accounting.view",
  "accounting.manage",
  "closing.view",
  "closing.create",
  "closing.submit",
  "closing.approve",
  "closing.adjust",
  "closing.lock",
  "closing.export",
  "financial_accounts.view",
  "financial_accounts.manage",
  "shipping_finance.view",
  "shipping_finance.manage",
  "shipping_finance.approve",
  "inventory_costing.view",
  "inventory_costing.manage",
  "inventory_costing.approve",
  "ad_spend.view",
  "ad_spend.manage",
  // شاشات تشغيل الشحن (شحنات اليوم، جدول توزيع المسارات). منفصلة عن shipping_finance
  // لأن دي تشغيل يومي بيعمله موظف الشحن، وتلك فلوس وتسويات. موظف التأكيدات مالوش
  // الاتنين — بيشوف بيانات الشحن جوه الأوردر بتاعه وبس.
  "shipping_ops.view",
  // ==================== الحسابات — الطبقة الدقيقة ====================
  // `accounting.view/manage` كانت خشنة زيادة: «manage» كانت بتعني إدخال حركة وإقفال يوم
  // واعتماد تسوية في نفس الوقت. الفصل ده بيخلّي المالك يدّي مدير الحسابات حق الإدخال من
  // غير حق الاعتماد — وده أهم حاجز إداري في نظام بيحرّك فلوس كل يوم.
  "accounting.create",
  "accounting.approve",
  // التحويل بين الخزنة والبنك بيحرّك فلوس حقيقية بين حسابين، فمنفصل عن مجرد تسجيل مصروف.
  "treasury.transfer",
  "settlements.create",
  // رؤية الأرباح قرار منفصل عن رؤية الحركات: ممكن محاسب يسجّل من غير ما يشوف الهامش.
  "reports.view_profit",
  // الرواتب. أربع صلاحيات مش واحدة عشان فصل المهام يبقى ممكن: المحاسب يجهّز ويدفع،
  // والاعتماد يفضل للإدارة — وده أهم حاجز إداري في وحدة بتحرّك فلوس شهريًا.
  "payroll.view",
  "payroll.manage",
  "payroll.approve",
  "payroll.pay",
  // دفتر الحسابات V3 — بلا دور جديد: التوزيع الافتراضي أدناه، والمنح/المنع لكل tenant عبر
  // tenant_role_permissions (المحاسب يأخذ view/post بمنح المالك).
  "ledger.view",
  "ledger.post",
  "ledger.reverse",
  "ledger.manage_accounts",
  "ledger.period.lock",
  "ledger.period.reopen",
  "ledger.activate",
  // ==================== أداء الموظفين (سجل الأحداث 0041) ====================
  // view_self: الموظف يرى نفسه فقط. view_all: مقارنة الموظفين (المالك/الأدمن افتراضيًا، المدير بالمنح).
  // export: تصدير التقرير. لا Leaderboard عام. view_team مؤجّل (لا نموذج فريق).
  "employee_performance.view_self",
  "employee_performance.view_all",
  "employee_performance.export",
  // ==================== الحضور والانصراف (0042) ====================
  // self: الموظف نفسه. الإدارة: المالك/الأدمن افتراضيًا، المدير والمحاسب بالمنح. view_team مؤجّل.
  "attendance.clock_self",
  "attendance.view_self",
  "attendance.request_correction",
  "attendance.view_all",
  "attendance.manage_shifts",
  "attendance.correct",
  "attendance.approve_corrections",
  "attendance.manage_leaves",
  "attendance.export",
  // ==================== مركز الرسائل (0043) ====================
  // use: المحادثات والخاص والقراءة والتفاعل. voice: تسجيل الصوت ورفعه. announce: النشر في الإعلانات.
  // manage_groups: إنشاء المجموعات. view_private: اطلاع المالك على المحادثات الخاصة (قراءة فقط ومسجَّل) —
  // **مقفولة**: لا يأخذها أي دور افتراضيًا (ولا المالك)، وتُفتح للمالك فقط بمنح صريح لشركته.
  "messages.use",
  "messages.voice",
  "messages.announce",
  "messages.manage_groups",
  "messages.view_private",
  // ==================== الفرق والقيادة المؤرخة (0044) ====================
  // بلا Role جديد: القيادة = صف عضوية 'leader' فعّال. view_all/manage للمالك والأدمن افتراضيًا (المدير بالمنح).
  // view_own و team_* للمشرف والمدير افتراضيًا — **لا أثر لها بدون قيادة فعّالة**: كل إجراء قائد يفرض الصلاحية
  // **و** قيادة فعّالة لنفس الفريق في نفس الشركة (غير القائد = صفر بيانات أو FORBIDDEN).
  "teams.view_own",
  "teams.view_all",
  "teams.manage",
  "team_performance.view",
  "team_attendance.view",
  "team_tasks.manage",
  "team_orders.view",
  "team_orders.assign",
] as const;

/** صلاحيات دفتر V3 التي يملكها المالك وحده افتراضيًا (لا يأخذها admin إلا بمنح صريح لكل tenant). */
export const LEDGER_OWNER_ONLY_PERMISSIONS: readonly Permission[] = ["ledger.period.reopen", "ledger.activate"];
/**
 * صلاحيات دفتر V3 مقصورة على أدوار بعينها (قرار المالك 2026-10-11): لا يمنحها تجاوز الشركة لأي دور آخر،
 * ولا يأخذها الأدمن افتراضيًا. عكس الحركة للمالك ومدير الحسابات فقط — لا للمحاسب ولا للأدمن ولا للمدير.
 */
export const LEDGER_ROLE_RESTRICTED: Readonly<Partial<Record<string, readonly string[]>>> = {
  "ledger.reverse": ["super_admin", "accounts_manager"],
};
/** مرفوضة لهذا الدور مهما كانت التجاوزات؟ */
export const isRoleRestrictedDenied = (role: string | null | undefined, permission: string) => {
  const allowed = LEDGER_ROLE_RESTRICTED[permission];
  return !!allowed && !allowed.includes(role ?? "");
};
const LEDGER_PERMISSIONS: readonly Permission[] = [
  "ledger.view", "ledger.post", "ledger.reverse", "ledger.manage_accounts", "ledger.period.lock", "ledger.period.reopen", "ledger.activate",
];

export type Permission = (typeof ALL_PERMISSIONS)[number];

/**
 * صلاحيات **مقفولة للمالك**: خارج كل الأدوار افتراضيًا (حتى super_admin)، ولا تُحتسب إلا لدور المالك
 * وبمنح صريح في tenant_role_permissions لشركته. منحها لأي دور آخر مرفوض عند الحفظ ومتجاهَل عند التقييم.
 */
export const LOCKED_OWNER_PERMISSIONS: readonly Permission[] = ["messages.view_private"];
export const isLockedOwnerPermission = (p: string) => (LOCKED_OWNER_PERMISSIONS as readonly string[]).includes(p);
/** الرسائل لكل موظف: المحادثة والصوت. الإعلانات والمجموعات للإدارة افتراضيًا (وتُمنح لغيرها لكل شركة). */
const MESSAGING_BASIC: readonly Permission[] = ["messages.use", "messages.voice"];

/** صلاحيات لا يأخذها المدير افتراضيًا — تُمنح له لكل شركة عبر tenant_role_permissions (قرار المالك). */
export const MANAGER_GRANT_ONLY_PERMISSIONS: readonly Permission[] = [
  "employee_performance.view_all",
  "employee_performance.export",
  "attendance.view_all",
  "attendance.manage_shifts",
  "attendance.correct",
  "attendance.approve_corrections",
  "attendance.manage_leaves",
  "attendance.export",
  "teams.view_all",
  "teams.manage",
];
/** صلاحيات القائد — تُفعَّل فقط مع قيادة فعّالة (المشرف والمدير افتراضيًا، غيرهما بالمنح). */
export const TEAM_LEADER_PERMISSIONS: readonly Permission[] = [
  "teams.view_own", "team_performance.view", "team_attendance.view", "team_tasks.manage", "team_orders.view", "team_orders.assign",
];
/** «أدائي» + حضوري (تسجيل/عرض/طلب تصحيح) لكل دور تشغيلي (ما عدا viewer). */
const SELF_PERFORMANCE: readonly Permission[] = [
  "employee_performance.view_self",
  "attendance.clock_self", "attendance.view_self", "attendance.request_correction",
  "tasks.view_own",
];

/**
 * الصلاحيات **المالية** — الأقسام اللي بتحرّك فلوس أو بتوريها: الحسابات، المصاريف،
 * التحصيلات، المرتبات، مدفوعات الموردين، الخزنة، الإقفالات، الأرباح.
 *
 * ليه موجودة كـset منفصل: المدير (`manager`) دوره تشغيلي بحت — بيدير الأوردرات والموظفين
 * والمخازن، لكن **مايشوفش ولا يلمس أي حاجة مالية**. المدير بياخد جلسة admin صناعية
 * (context.ts) عشان تشغيله يفضل شغّال، فالحجب المالي بيتفرض هنا صراحةً في البوابة
 * (`permissionProcedure`) مش من خريطة الصلاحيات. المالك الحقيقي والمحاسب بس بيوصلوا.
 *
 * ملاحظة: `inventory_costing.*` **مش** هنا عن قصد — استلام البضاعة كحركة مخزون
 * ومرتجعات الورشة شغل «عدّ قطع» تشغيلي، والمدفوعات المالية للمورد متغطّية بـ`accounting.*`.
 */
export const FINANCIAL_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  "accounting.view", "accounting.manage", "accounting.create", "accounting.approve",
  "closing.view", "closing.create", "closing.submit", "closing.approve",
  "closing.adjust", "closing.lock", "closing.export",
  "financial_accounts.view", "financial_accounts.manage",
  "shipping_finance.view", "shipping_finance.manage", "shipping_finance.approve",
  "ad_spend.view", "ad_spend.manage",
  "treasury.transfer", "settlements.create", "reports.view_profit",
  "payroll.view", "payroll.manage", "payroll.approve", "payroll.pay",
  "ledger.view", "ledger.post", "ledger.reverse", "ledger.manage_accounts", "ledger.period.lock", "ledger.period.reopen", "ledger.activate",
]);

export function isFinancialPermission(permission: Permission): boolean {
  return FINANCIAL_PERMISSIONS.has(permission);
}

/**
 * تجميد النظام المحاسبي الحالي (قرار: إعادة بنائه لاحقًا بطريقة مختلفة). كل عمليات الكتابة
 * المحاسبية للمستخدم (مصروفات، مرتبات، تحصيلات، خزن وحسابات مالية، إقفالات، إعلانات) متوقّفة
 * عبر نقطة واحدة في `permissionProcedure`. مقصود إنها كتابة بس — القراءات (view و export)
 * والمخزون (inventory_costing) والشحن التشغيلي (shipping_finance و shipping_ops) والإعدادات
 * والأوردرات مش مجمّدة عشان تشغيل الأوردرات والمخزون وبوسطة يفضل شغّال. الدوال الداخلية
 * (services) اللي بيستدعيها تأكيد الأوردر أو بوسطة أو التكلفة مش بتعدّي من هنا.
 */
export const FROZEN_ACCOUNTING_WRITE_PERMISSIONS: ReadonlySet<Permission> =
  new Set<Permission>([
    "accounting.manage", "accounting.create", "accounting.approve",
    "financial_accounts.manage",
    "closing.create", "closing.submit", "closing.approve", "closing.adjust", "closing.lock",
    "ad_spend.manage",
    "payroll.manage", "payroll.approve", "payroll.pay",
    "treasury.transfer", "settlements.create",
  ]);

/**
 * النظام المحاسبي مُفعَّل؟ الافتراضي **لأ** (مجمّد) في التطبيق. الاختبارات بتفعّله عشان
 * تفضل تتحقّق من المنطق الداخلي المحفوظ (مش محذوف) للنظام القادم.
 */
export function isAccountingModuleEnabled(): boolean {
  return process.env.ACCOUNTING_MODULE_ENABLED === "true";
}

/** هل الصلاحية دي عملية كتابة محاسبية متوقّفة حاليًا (والنظام مجمّد)؟ */
export function isFrozenAccountingWrite(permission: Permission): boolean {
  return (
    !isAccountingModuleEnabled() &&
    FROZEN_ACCOUNTING_WRITE_PERMISSIONS.has(permission)
  );
}

/** رسالة موحّدة للمستخدم عند محاولة عملية محاسبية أثناء التجميد. */
export const ACCOUNTING_FROZEN_MESSAGE =
  "النظام المحاسبي قيد إعادة التطوير حاليًا";

/** Every employees.role enum value (existing + new) — single source of truth for both the TS type and the runtime array (used by z.enum() in routers.ts). */
export const EMPLOYEE_ROLE_VALUES = [
  "agent", "warehouse", "manager", "facebook_entry", "scanner",
  "super_admin", "admin", "data_entry", "order_confirmation", "shipping", "accountant", "viewer",
  // مودريتور — مشرف تشغيلي أوسع من التأكيدات (بيوزّع أوردرات ويتابع)، لكن بدون أي صلاحية مالية.
  "moderator",
  // مدير الحسابات (0045) — يراجع ويقفل الشهر ويعكس الحركات في دفتر V3 فقط، على كل أنشطة شركته داخل الدفتر وحده.
  // جلسة موظف غير إدارية: لا أوردرات ولا موظفين ولا صلاحيات المالك. يعيّنه المالك فقط. يتطلب 0045 في القاعدة.
  "accounts_manager",
] as const;

export type EmployeeRole = (typeof EMPLOYEE_ROLE_VALUES)[number];

/** Roles treated as full-access, equivalent to the existing "manager acts as admin" behavior. */
export const ADMIN_TIER_ROLES: readonly EmployeeRole[] = ["super_admin", "admin", "manager"];

export function isAdminTierRole(role: string | null | undefined): boolean {
  return ADMIN_TIER_ROLES.includes(role as EmployeeRole);
}

/**
 * Owner tier — the narrow set of destructive, unrecoverable actions (permanently
 * deleting orders, locking a closing period, rewriting the tenant permission map).
 *
 * This used to be expressed in routers.ts as "the session has no employee row",
 * which was unreachable: every branch of createContext() attaches an employee
 * row, including the /login owner session. So the owner-only procedures were
 * denied to *everyone*. The tier is now a role, which makes it assignable from
 * the employees screen and visible to the person using the system.
 *
 * Deliberately narrower than ADMIN_TIER_ROLES: "manager" runs the business day
 * to day and must not be able to permanently destroy records.
 */
export const OWNER_ROLES: readonly EmployeeRole[] = ["super_admin"];

export function isOwnerRole(role: string | null | undefined): boolean {
  return OWNER_ROLES.includes(role as EmployeeRole);
}

const ROLE_PERMISSIONS: Record<EmployeeRole, readonly Permission[]> = {
  super_admin: ALL_PERMISSIONS.filter(p => !isLockedOwnerPermission(p)),
  // admin: كل شيء عدا ما هو للمالك وحده في دفتر V3 (إعادة فتح الفترة والتفعيل).
  admin: ALL_PERMISSIONS.filter(p => !LEDGER_OWNER_ONLY_PERMISSIONS.includes(p) && !isLockedOwnerPermission(p)),
  // المدير تشغيلي: كل الصلاحيات القديمة كما كانت، وبلا أي صلاحية على دفتر V3 (مالي).
  manager: ALL_PERMISSIONS.filter(p => !LEDGER_PERMISSIONS.includes(p) && !MANAGER_GRANT_ONLY_PERMISSIONS.includes(p) && !isLockedOwnerPermission(p)),
  // المحاسب هو الدور الوحيد غير الإداري اللي بيدخل حركات على الخزنة — الدور كان موجود
  // في القائمة من غير أي صلاحية محاسبية، فكان بيشوف الأوردرات وبس.
  accountant: [
    "dashboard.view", "orders.view", "orders.export", "settings.view", "audit.view",
    "accounting.view", "accounting.manage",
    "closing.view", "closing.create", "closing.submit", "closing.adjust", "closing.export",
    "financial_accounts.view", "financial_accounts.manage",
    "shipping_finance.view", "shipping_finance.manage",
    // المحاسب بيسجّل مسودة استلام بضاعة (manage) — لكن **مش** بيعتمدها ولا بيحرّك المخزون:
    // الاعتماد على `inventory_costing.approve` المنفصلة، واللي المحاسب مش واخدها. فاصل أمان.
    "inventory_costing.view", "inventory_costing.manage",
    "ad_spend.view", "ad_spend.manage",
    // بيجهّز الدورة ويدفعها، لكن مش بيعتمدها — الاعتماد قرار إداري
    "payroll.view", "payroll.manage", "payroll.pay",
    // الطبقة الدقيقة: بيدخّل ويحوّل ويسجّل تسويات، لكن **مش** بيعتمد ولا بيشوف الأرباح.
    // الاتنين دول (`accounting.approve` و`reports.view_profit`) بيمنحهم المالك يدويًا لو
    // حب — عن طريق tenant_role_permissions من غير أي Deploy.
    "accounting.create", "treasury.transfer", "settlements.create",
    // دفتر V3: لا شيء افتراضيًا هنا — القراءة تُضاف مع حراسة نطاق القراءة على السيرفر، والترحيل بمنح صريح، ولا عكس أبدًا.
    ...SELF_PERFORMANCE, ...MESSAGING_BASIC,
  ],
  // مدير الحسابات: الدفتر فقط (قراءة وترحيل وعكس وإدارة الحسابات وإقفال الشهر). لا فتح الشهر ولا التفعيل (للمالك)،
  // ولا الأرباح (reports.view_profit) ولا الأوردرات ولا الموظفين ولا الحسابات القديمة V1/V2.
  accounts_manager: [
    "ledger.view", "ledger.post", "ledger.reverse", "ledger.manage_accounts", "ledger.period.lock",
    ...SELF_PERFORMANCE, ...MESSAGING_BASIC,
  ],
  viewer: ["dashboard.view", "orders.view", ...MESSAGING_BASIC],
  // مشرف تشغيلي: بيشوف ويشتغل على كل الأوردرات ويصدّر ويستورد ويتابع الموظفين والشحن —
  // من غير أي صلاحية مالية (مفيش accounting/payroll/treasury/... خالص).
  moderator: [
    "dashboard.view",
    "orders.view", "orders.create", "orders.update", "orders.edit_items",
    "orders.confirm", "orders.cancel", "orders.export", "orders.import",
    "employees.view", "audit.view",
    ...SELF_PERFORMANCE, ...MESSAGING_BASIC, ...TEAM_LEADER_PERMISSIONS,
  ],
  order_confirmation: ["dashboard.view", "orders.view", "orders.confirm", "orders.cancel", "orders.update", "orders.edit_items", ...SELF_PERFORMANCE, ...MESSAGING_BASIC],
  agent: ["dashboard.view", "orders.view", "orders.confirm", "orders.cancel", "orders.update", "orders.edit_items", ...SELF_PERFORMANCE, ...MESSAGING_BASIC],
  data_entry: ["orders.view", "orders.create", ...SELF_PERFORMANCE, ...MESSAGING_BASIC],
  facebook_entry: ["orders.view", "orders.create", ...SELF_PERFORMANCE, ...MESSAGING_BASIC],
  shipping: ["orders.view", "orders.export", "shipping_ops.view", ...SELF_PERFORMANCE, ...MESSAGING_BASIC],
  scanner: ["orders.view", ...SELF_PERFORMANCE, ...MESSAGING_BASIC],
  warehouse: ["dashboard.view", "orders.view", "inventory.view", "inventory.adjust", ...SELF_PERFORMANCE, ...MESSAGING_BASIC],
};

export function permissionsForRole(role: string | null | undefined): readonly Permission[] {
  return ROLE_PERMISSIONS[role as EmployeeRole] ?? [];
}

export function hasPermission(role: string | null | undefined, permission: Permission): boolean {
  if (isLockedOwnerPermission(permission)) return false; // مقفولة افتراضيًا للجميع
  if (isRoleRestrictedDenied(role, permission)) return false;
  return permissionsForRole(role).includes(permission);
}

export async function hasTenantPermission(
  tenantId: number,
  role: string | null | undefined,
  permission: Permission,
): Promise<boolean> {
  const [{ getDb }, { tenantRolePermissions }, { and, eq }] = await Promise.all([
    import("./db"),
    import("../drizzle/schema"),
    import("drizzle-orm"),
  ]);
  if (isLockedOwnerPermission(permission) && !isOwnerRole(role)) return false; // لا تُمنح لغير المالك أبدًا
  if (isRoleRestrictedDenied(role, permission)) return false; // لا يمنحها أي تجاوز لدور غير مسموح
  const db = await getDb();
  if (!db) return hasPermission(role, permission);
  const [override] = await db.select().from(tenantRolePermissions).where(and(
    eq(tenantRolePermissions.tenantId, tenantId),
    eq(tenantRolePermissions.role, role ?? ""),
    eq(tenantRolePermissions.permission, permission),
  )).limit(1);
  return override ? override.isAllowed : hasPermission(role, permission);
}

/**
 * كل صلاحيات دور داخل tenant (الافتراضي + تجاوزات الشركة) **باستعلام واحد** — نفس نتيجة
 * `hasTenantPermission` لكل صلاحية، بدون N استعلام. صلاحيات دفتر V3 الخاصة بالمالك وحده ما بترجعش
 * إلا للمالك (نفس فلتر auth.myPermissions).
 */
export async function tenantPermissionsForRole(
  tenantId: number,
  role: string | null | undefined,
): Promise<Permission[]> {
  const [{ getDb }, { tenantRolePermissions }, { and, eq }] = await Promise.all([
    import("./db"),
    import("../drizzle/schema"),
    import("drizzle-orm"),
  ]);
  const db = await getDb();
  const overrides = new Map<string, boolean>();
  if (db) {
    const rows = await db.select().from(tenantRolePermissions).where(and(
      eq(tenantRolePermissions.tenantId, tenantId),
      eq(tenantRolePermissions.role, role ?? ""),
    ));
    for (const r of rows) overrides.set(r.permission, r.isAllowed);
  }
  return ALL_PERMISSIONS.filter(p => (overrides.has(p) ? overrides.get(p)! : hasPermission(role, p)))
    .filter(p => !LEDGER_OWNER_ONLY_PERMISSIONS.includes(p) || isOwnerRole(role))
    .filter(p => !isLockedOwnerPermission(p) || isOwnerRole(role))
    .filter(p => !isRoleRestrictedDenied(role, p));
}
