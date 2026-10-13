import { z } from "zod";
import { assertNoMovementDuringStocktake, handoverOrder, InventoryLedgerError, isInventoryLedgerActive, postReturnInspection, postStocktakeVariance } from "./ledgerInventory.service";
import type { LedgerActor } from "../shared/ledgerV3Core";
import { TRPCError } from "@trpc/server";
import { isUniqueKeyCollision, numberSource, withFreshNumber } from "./uniqueNumber";
import { OPERATION_ID_RE, runIdempotent, type IdemRecord } from "./operationIdempotency.service";
import { createBostaShipment, isBostaEnabledForBusiness, resolveShipmentImagesForOrder, toPublicImageUrl } from "./bosta.service";
import { isPublicImageUrl, packageImageTenant, PACKAGE_IMAGE_URL_PREFIX } from "../shared/packageImages";
import { packageImageExists } from "./packageImageUpload";
import { createLedgerRouter } from "./ledgerV3.router";
import { isOwnedLogoUrl } from "../shared/branding";
import {
  analyzePasteV2,
  signParseToken,
  verifyParseToken,
  rawTextHash as rawTextHashOf,
  canonicalFingerprint,
  canonicalParse,
  finalLinesBlocker,
  classifyFinalLines,
  PARSE_TOKEN_MESSAGES,
} from "./orderParse.service";
import { activeSegmentResolver, rateLimitedResolver } from "./ai/segmentResolver";
import { listInboxEvents } from "./carrierWebhookInbox.service";
import { BOSTA_STATES } from "./bostaEvents";
import { reprocessBostaInboxEvent } from "./bostaWebhook";
import { aiRateKey } from "./ai/aiRateLimit";
import { PRICE_SOURCE, pasteSaveBlockers, parseResultV2Schema } from "../shared/orderParse";
import {
  getCarrierAccountStatus,
  probeBostaKey,
  connectCarrierAccount,
  disconnectCarrierAccount,
  NOT_CONNECTED_MESSAGE,
} from "./carrierAccounts.service";
import { getAccountantSummary } from "./accountantSummary.service";
import {
  createStocktake,
  listStocktakes,
  getStocktake,
  updateStocktakeLine,
  submitStocktake,
  approveStocktake,
} from "./stocktake.service";
import {
  syncOrdersByDateRange,
  testChannelConnection,
} from "./easyorder.service";
import { parseFacebookOrder } from "../shared/facebookOrderParser";
import { matchImportItem } from "./productMatching";
import { analyzePaste } from "./pasteLines";
import { ORDER_ENTRY_MODES, DEFAULT_ORDER_ENTRY_MODE } from "../shared/orderEntryMode";
import { COOKIE_NAME, UNAUTHED_ERR_MSG } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import {
  authenticatedProcedure,
  publicProcedure,
  protectedProcedure,
  permissionProcedure,
  router,
  assertTrpcTenantAccess,
} from "./_core/trpc";
import { resolveTenantAccess, tenantAccessEnforcementEnabled } from "./tenantAccess";
import { TENANT_ACCESS_MESSAGES } from "@shared/tenantAccess";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  getDb,
  cairoParseDateRange,
  cairoTodayRange,
  cairoStartOfDay,
  cairoEndOfDay,
} from "./db";
import {
  markOrderAsReturned,
  getReturnsList,
  getReturnsStats,
  createPrintLog,
  getPrintLogs,
  getPrintLogById,
  addActivityLog,
  getActivityLogs,
  getAllSalesChannels,
  getActiveSalesChannels,
  getSalesChannelById,
  createSalesChannel,
  updateSalesChannel,
  deleteSalesChannel,
  reactivateSalesChannel,
  clearSalesChannelSecret,
  isWebhookSecretTaken,
  isSalesChannelNameTaken,
  getVariantsByProduct,
  getVariantById,
  createVariant,
  updateVariant,
  deleteVariant,
  updateVariantStock,
  addVariantInventoryMovement,
  getAllVariantsWithProduct,
  replaceOrderItems,
  getOrderItems,
  replaceOrderItemsFromEditor,
  getOrderItemsForOrders,
} from "./db";
import { employees } from "../drizzle/schema";
import {
  assertAllOwned,
  assertOwned,
  OutOfScopeError,
  RecordNotFoundError,
  ScopeUnavailableError,
  type ScopedEntity,
} from "./tenantScope";
import { eq, and, gte, lte, desc, sql, inArray, or, isNull } from "drizzle-orm";
import { orderEventsEnabled, type OrderEventContext } from "./orderEvents.service";
import { loadPerformance } from "./employeePerformance.service";
import { buildMessagingRouter, webMessagingIdentity, portalMessagingIdentity } from "./messagingRouter";
import * as attendanceSvc from "./attendance.service";
import * as teamsSvc from "./teams.service";
import { accountsManagerRoleSupported } from "./roleEnumMigration.service";
import { ACCOUNTS_MANAGER_ROLE } from "../shared/employeeRoleEnumSpec";
import * as teamLeaderSvc from "./teamLeader.service";
import { attendanceCsv } from "../shared/attendanceCalc";
import { performanceCsv } from "../shared/employeePerformance";
import {
  broadcastScopeCondition,
  employeeInTeamScope,
  realScopeIds,
  taskScopeCondition,
  type TeamScope,
} from "./teamScope";
import { orders as ordersTable } from "../drizzle/schema";
import { normalizeEgyptianPhone } from "../shared/phone";
import {
  ALL_PERMISSIONS,
  hasTenantPermission,
  isAccountingModuleEnabled,
  ACCOUNTING_FROZEN_MESSAGE,
  isAdminTierRole,
  isOwnerRole,
  hasPermission,
  isFinancialPermission,
  EMPLOYEE_ROLE_VALUES,
  permissionsForRole,
  type Permission,
  LEDGER_OWNER_ONLY_PERMISSIONS,
  isRoleRestrictedDenied,
  isLockedOwnerPermission,
  tenantPermissionsForRole,
} from "./permissions";
import { EMPLOYEE_SETTABLE_ORDER_STATUSES } from "@shared/const";
import { toMinorUnits } from "../shared/accountingMoney";
import {
  accountingClosings,
  businessConfigurationValues,
  businessEvents,
  businesses as businessesTable,
  costCenters,
  expenses as expensesTable,
  tenantRolePermissions,
} from "../drizzle/schema";
import {
  businessDateKey,
  businessDayRange,
  isValidIanaTimeZone,
} from "../shared/businessTime";
import {
  createFinancialAccount,
  getBusinessEventDashboard,
  getFinancialAccounts,
  postFinancialTransaction,
  recordManualTreasuryEntry,
  IdempotencyConflictError,
} from "./accountingV2.service";

/** نفس معرّف العملية ببيانات مختلفة → CONFLICT واضح للعميل بدل 500 غامض. */
async function withIdempotencyGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof IdempotencyConflictError)
      throw new TRPCError({ code: "CONFLICT", message: err.message });
    throw err;
  }
}
import {
  approvePurchaseReceipt,
  approveReturnInspection,
  createPurchaseReceiptDraft,
  updatePurchaseReceiptDraft,
  deletePurchaseReceiptDraft,
  dispatchOrderInventory,
  getInventoryControlData,
  recordOpeningInTransit,
  reserveOrderInventory,
  submitPurchaseReceipt,
  submitReturnInspection,
  listWorkshopReturns,
  transferStock,
  voidPurchaseReceipt,
  getWorkshopSetup,
  setWorkshopWarehouse,
  sendToWorkshop,
  receiveFromWorkshop,
  listWorkshopBatches,
} from "./inventoryV2.service";
import {
  createConfiguredShipment,
  recordShipmentEvent,
} from "./shippingV2.service";
import {
  approveCarrierSettlement,
  getShippingFinanceData,
  importCarrierSettlement,
  listDailySettlements,
  recordDailySettlement,
  voidDailySettlement,
} from "./settlementsV2.service";
import {
  configureBusinessShippingProvider,
  deactivateBusinessShippingProvider,
  createShippingRateVersion,
  listShippingConfiguration,
} from "./shippingConfigV2.service";
import {
  addClosingAdjustment,
  approveClosing,
  createClosingDraft,
  getClosingDetail,
  listClosings,
  lockClosing,
  submitClosing,
} from "./closingV2.service";
import {
  approveExpense,
  createAdSpendDraft,
  updateAdSpendDraft,
  deleteAdSpendDraft,
  createExpenseDraft,
  payExpense,
  recordSimpleExpense,
  submitExpense,
} from "./expensesV2.service";
import {
  approveAndAccruePayrollPeriod,
  payPayrollPeriodV2,
} from "./payrollV2.service";
import {
  cancelEmployeeAdvance,
  issueEmployeeAdvance,
} from "./advancesV2.service";
import {
  issueEmployeeBonus,
  deleteEmployeeBonus,
  listEmployeeBonuses,
  getSalarySummaries,
} from "./bonusesV2.service";
import { confirmOrderPayment, refundOrderPayment } from "./paymentsV2.service";

const EMP_JWT_SECRET = process.env.JWT_SECRET;
const EMP_COOKIE = "employee_token";

async function getEmployeeFromCookie(req: any) {
  const token = req?.cookies?.[EMP_COOKIE];
  if (!token || !EMP_JWT_SECRET) return null;
  try {
    const payload = jwt.verify(token, EMP_JWT_SECRET) as any;
    const db = await getDb();
    if (!db) return null;
    const [emp] = await db
      .select()
      .from(employees)
      .where(eq(employees.id, payload.employeeId))
      .limit(1);
    return emp?.isActive ? emp : null;
  } catch {
    return null;
  }
}

const employeePortalProcedure = publicProcedure.use(async ({ ctx, next, type, path }) => {
  const emp = await getEmployeeFromCookie(ctx.req);
  if (!emp)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "يرجى تسجيل الدخول أولاً",
    });
  // حالة شركة **الموظف** (هوية الكوكي) — لا تعتمد على جلسة مالك مفتوحة. خلف العلم (معطل = لا شيء).
  if (emp.tenantId != null) await assertTrpcTenantAccess(emp.tenantId, type, path);
  return next({ ctx: { ...ctx, employee: emp } });
});

// Manager-tier employee procedure — requires an admin-tier role (super_admin/admin/
// manager), matching requireAdminOrManager's fix in authMiddleware.ts: this used to check
// the literal role "manager" only, wrongly rejecting an admin/super_admin employee.
const managerPortalProcedure = employeePortalProcedure.use(
  async ({ ctx, next }) => {
    const emp = (ctx as any).employee;
    if (!isAdminTierRole(emp.role))
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "هذا الإجراء متاح للمديرين فقط",
      });
    return next({ ctx });
  }
);

/**
 * الحارس **الوحيد** لإجراءات البوابة: هوية كوكي الموظف فقط (لا جلسة مالك) + صلاحية الدور **بتجاوزات
 * الشركة** (`tenant_role_permissions` عبر `hasTenantPermission`) — نفس مصدر `auth.myPermissions` اللي
 * الواجهة بتخفي بيه الروابط. بلا تجاوز = الافتراضي في permissions.ts (نفس السلوك القديم بالظبط)؛ منح
 * الصلاحية لدور بيفتح الإجراء، وسحبها بيمنع السيرفر فورًا في الطلب التالي، ولشركة واحدة بس.
 * (كان فيه `requireEmployeePermission` ثابت بلا تجاوزات — اتوحّد هنا.) المستثنى بهوية فقط: me،
 * myPermissions، activeBroadcast؛ وإجراءات المدير خلف managerPortalProcedure.
 */
function requireEmployeeTenantPermission(permission: Permission) {
  return employeePortalProcedure.use(async ({ ctx, next }) => {
    const emp = (ctx as any).employee;
    const tenantId = requireTenantId(emp);
    if (!(await hasTenantPermission(tenantId, emp.role, permission))) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "ليس لديك صلاحية لتنفيذ هذا الإجراء",
      });
    }
    return next({ ctx });
  });
}

/**
 * لوحة المدير: دور إداري في البوابة (super_admin/admin/manager — بلا توسيع للمشرف) **و** صلاحية التبويب أو
 * الفعل بتجاوزات الشركة. الافتراضي للمدير يشمل كل هذه الصلاحيات (نفس السلوك القديم)، والسحب لشركة يمنع فورًا.
 */
function requireManagerPortalPermission(permission: Permission) {
  return managerPortalProcedure.use(async ({ ctx, next }) => {
    const emp = (ctx as any).employee;
    if (!(await hasTenantPermission(requireTenantId(emp), emp.role, permission)))
      throw new TRPCError({ code: "FORBIDDEN", message: "ليس لديك صلاحية لتنفيذ هذا الإجراء" });
    return next({ ctx });
  });
}

/** التكلفة لا تظهر في البوابة إلا بصلاحية التكلفة — المخزون التشغيلي (view/adjust) لا يعني رؤيتها. */
async function stripCostUnlessAllowed<T extends Record<string, any>>(ctx: any, rows: T[]): Promise<T[]> {
  const emp = (ctx as any).employee;
  if (await hasTenantPermission(requireTenantId(emp), emp.role, "inventory_costing.view")) return rows;
  return rows.map(r => { if (!("costPrice" in r)) return r; const { costPrice: _cost, ...rest } = r; return rest as T; });
}

/**
 * "Is this order yours?" — the per-order half of employee-portal authorization, paired with
 * requireEmployeeTenantPermission's "can your role do this at all?".
 *
 * Admin-tier employees are exempt because they supervise the whole queue. Note this checks
 * the tier, not the literal role "manager": an `admin` or `super_admin` employee is senior
 * to a manager and was previously failing the check that only named "manager".
 *
 * Returns the order so callers don't fetch it twice.
 */
/**
 * تأكيد الأوردر مع تحويل عجز المخزون لرفض واضح (BAD_REQUEST برسالة عربية) بدل خطأ عام.
 * الخصم نفسه ذرّي داخل confirmOrder — الرفض = مفيش أي خصم جزئي.
 */
/** يحوّل رفض السياسة (حذف مؤكد، تأكيد بالتعديل، تسليم بوسطة يدوي، إرجاع للمخزون) لـBAD_REQUEST بدل 500. */
async function withStatusGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof OrderStatusGuardError)
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    throw err;
  }
}

/**
 * تجميد المسارات المالية التي لا تمر بصلاحية من مجموعة التجميد (adminProcedure/ownerProcedure/
 * shipping_finance.*). نفس الرسالة الموحّدة. يُرفع تلقائيًا مع ACCOUNTING_MODULE_ENABLED=true.
 */
const frozenWhileAccountingDisabled = async ({ next }: { next: () => Promise<any> }) => {
  if (!isAccountingModuleEnabled())
    throw new TRPCError({ code: "FORBIDDEN", message: ACCOUNTING_FROZEN_MESSAGE });
  return next();
};

/** صافي الربح وهامشه لمن يملك reports.view_profit فقط — المالك/الأدمن الحقيقي أو موظف بالصلاحية. */
async function canViewProfit(ctx: { user?: { role?: string | null } | null; employee?: { role?: string | null } | null; tenantId?: number | null }): Promise<boolean> {
  if (ctx.employee?.role === "manager") return false; // المدير تشغيلي بحت — نفس قاعدة permissionProcedure للمالي
  if (ctx.user?.role === "admin") return true;
  if (ctx.tenantId == null) return false;
  return hasTenantPermission(ctx.tenantId, ctx.employee?.role, "reports.view_profit");
}

/** مفاتيح الربح في إجماليات الإقفال — تُحجب لمن لا يملك reports.view_profit (باقي الأرقام التشغيلية تبقى). */
const CLOSING_PROFIT_KEYS = ["grossProfit", "netProfit", "adjustedNetProfit", "profitMargin"] as const;
function withoutProfitKeys<T extends Record<string, unknown> | null | undefined>(totals: T): T {
  if (!totals || typeof totals !== "object") return totals;
  const copy: Record<string, unknown> = { ...totals };
  for (const k of CLOSING_PROFIT_KEYS) delete copy[k];
  return copy as T;
}
/** صف إقفال (totalsJson نصي) بلا مفاتيح الربح. */
function redactClosingRow<T extends { totalsJson?: string | null }>(row: T): T {
  if (!row?.totalsJson) return row;
  try { return { ...row, totalsJson: JSON.stringify(withoutProfitKeys(JSON.parse(row.totalsJson))) }; }
  catch { return { ...row, totalsJson: null }; }
}

async function confirmOrderOrReject(orderId: number, updatedBy: number, confirmedByName?: string, eventCtx?: OrderEventContext) {
  try {
    return await confirmOrder(orderId, updatedBy, confirmedByName, eventCtx);
  } catch (err) {
    if (err instanceof StockShortfallError)
      throw new TRPCError({ code: "BAD_REQUEST", message: `المخزون غير كافٍ: ${err.message}` });
    if (err instanceof OrderConfirmBlockedError)
      throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
    if (err instanceof OrderStockInconsistencyError)
      throw new TRPCError({ code: "CONFLICT", message: err.message });
    throw err;
  }
}

async function assertEmployeeOwnsOrder(
  emp: { id: number; role: string; tenantId: number | null; businessId?: number | null },
  orderId: number,
  message: string
) {
  // P0: نطاق الأوردر **قبل** أي استثناء للدور — كان المدير/الأدمن معفيًا من كل فحص، فيقدر يأكّد
  // أو يلغي أوردر tenant تاني بمعرّفه. نفس حارس updateStatus: tenant الموظف + نشاطه.
  await requireOwned(empScope({ employee: emp }), "order", orderId);
  const order = await getOrderById(orderId);
  if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "الأوردر غير موجود" });
  if (!isAdminTierRole(emp.role) && order.assignedEmployeeId !== emp.id) {
    throw new TRPCError({ code: "FORBIDDEN", message });
  }
  return order;
}

/**
 * An employee's tenant, read directly off their own row — never derived, never defaulted.
 * Throws if the employees.tenantId backfill hasn't reached this row yet, exactly like
 * context.ts does for the admin-tier session path (see rejectUnresolvedTenant there).
 */
function requireTenantId(emp: { tenantId: number | null }): number {
  if (emp.tenantId == null) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message:
        "لا يوجد حساب تاجر مرتبط بهذا المستخدم — يرجى مراجعة الدعم الفني",
    });
  }
  return emp.tenantId;
}

/**
 * يبني ScopeCtx من جلسة employeePortal (اللي بتستخدم `(ctx as any).employee`).
 *
 * **`user` مابيتمرّرش عن قصد — نطاق البوابة هو نشاط الموظف وبس.**
 *
 * `employeePortalProcedure` بتحقن `ctx.employee` من كوكي الموظف، لكنها **مابتمسحش**
 * `ctx.user` بتاع جلسة المالك على الويب. فلو نفس المتصفح فيه الاتنين (المالك بيجرّب
 * شاشة الموظف، أو فتح البوابة في تاب جنب لوحته)، كان `sessionBusinessIds` بيلاقي
 * `user.role === "admin"` وبيرجّع **كل أنشطة الـtenant** — يعني قيد `employee.businessId`
 * بيتجاهَل بالكامل، وكتالوج شاشة الإدخال يعرض منتجات أنشطة تانية.
 *
 * التوسعة دي مالهاش أي مبرر في البوابة: الموظف الإداري (manager/admin في جدول
 * `employees`) نطاقه أصلاً `[employee.businessId]` من غير جلسة الويب — فشيل `user`
 * مابيغيّرش سلوكه، بيقفل بس التوسعة العرضية الجاية من جلسة تانية خالص.
 *
 * صلاحيات الأدوار مالهاش دعوة بالنطاق: `requireEmployeeTenantPermission` لسه بتحكم «يعمل
 * إيه»، ودي بتحكم «على أنهي نشاط» — والفصل ده مقصود.
 */
function empScope(ctx: any): ScopeCtx {
  const emp = ctx.employee;
  return { tenantId: requireTenantId(emp), user: null, employee: emp };
}

/**
 * نطاق الرسائل والمهام لجلسة **البوابة** (لوحة المدير/الموظف): tenant من صف الموظف، والأنشطة
 * = نشاط الموظف بس (`empScope`) — نفس نطاق باقي لوحة المدير. موظف/مدير بلا نشاط → `[-1]`.
 */
async function portalTeamScope(ctx: any): Promise<TeamScope> {
  if (!ctx?.employee)
    throw new TRPCError({ code: "UNAUTHORIZED", message: "يرجى تسجيل الدخول أولاً" });
  const scope = empScope(ctx);
  const businessIds = (await scopeBusinessIds(scope, {})) ?? [NO_BUSINESS];
  return { tenantId: scope.tenantId!, businessIds };
}

/** نفس الشيء لجلسة **الويب** (المالك/الأدمن): كل أنشطة tenant الجلسة — ولا نشاط من tenant تاني. */
async function sessionTeamScope(ctx: any): Promise<TeamScope> {
  if (ctx?.tenantId == null)
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  const businessIds = (await scopeBusinessIds(ctx, {})) ?? [NO_BUSINESS];
  return { tenantId: ctx.tenantId, businessIds };
}

const NO_TEAM_BUSINESS_MESSAGE = "لا يوجد نشاط مرتبط بحسابك";

/** آخر رسالة نشطة داخل النطاق — صفر صفوف لو النطاق فاضي. */
async function getScopedActiveBroadcast(scope: TeamScope) {
  const db = await getDb();
  if (!db) return null;
  const { broadcastMessages } = await import("../drizzle/schema");
  const [msg] = await db
    .select()
    .from(broadcastMessages)
    .where(and(eq(broadcastMessages.isActive, true), broadcastScopeCondition(scope)))
    .orderBy(desc(broadcastMessages.createdAt))
    .limit(1);
  return msg ?? null;
}

/** إرسال: إلغاء رسائل النطاق ثم صف لكل نشاط في النطاق — في معاملة واحدة (لا كتابة جزئية). */
async function sendScopedBroadcast(scope: TeamScope, message: string, sentBy: number, sentByName: string) {
  const targets = realScopeIds(scope);
  if (targets.length === 0)
    throw new TRPCError({ code: "FORBIDDEN", message: NO_TEAM_BUSINESS_MESSAGE });
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const { broadcastMessages } = await import("../drizzle/schema");
  await db.transaction(async tx => {
    await tx
      .update(broadcastMessages)
      .set({ isActive: false })
      .where(and(eq(broadcastMessages.isActive, true), broadcastScopeCondition(scope)));
    await tx.insert(broadcastMessages).values(
      targets.map(businessId => ({ businessId, message, sentBy, sentByName, isActive: true }))
    );
  });
  return { success: true };
}

/** إلغاء الرسائل النشطة داخل النطاق بس. */
async function clearScopedBroadcast(scope: TeamScope) {
  if (realScopeIds(scope).length === 0)
    throw new TRPCError({ code: "FORBIDDEN", message: NO_TEAM_BUSINESS_MESSAGE });
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
  const { broadcastMessages } = await import("../drizzle/schema");
  await db
    .update(broadcastMessages)
    .set({ isActive: false })
    .where(and(eq(broadcastMessages.isActive, true), broadcastScopeCondition(scope)));
  return { success: true };
}

/** المهمة موجودة وداخل النطاق؟ NOT_FOUND لو مش موجودة، FORBIDDEN لو تابعة لنطاق تاني. */
async function assertTaskInScope(db: any, tasks: any, taskId: number, owned: any): Promise<void> {
  const [mine] = await db.select({ id: tasks.id }).from(tasks).where(owned).limit(1);
  if (mine) return;
  const [exists] = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!exists) throw new TRPCError({ code: "NOT_FOUND", message: "المهمة غير موجودة" });
  throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك الوصول لهذه المهمة" });
}

/**
 * الحارس الموحّد للوصول بالمعرّف.
 *
 * `adminProcedure` بتقول «إنت أدمن» — مابتقولش «أدمن على إيه». السطر ده هو اللي بيجاوب
 * السؤال التاني، وبيتحط في كل إجراء بياخد معرّف سجل من العميل.
 *
 * السجل نفسه في `tenantScope.ts`، وبياخد نفس `getBusinessIdsForTenant` اللي
 * `scopeBusinessId` بتستخدمها — فمفيش قاعدة عزل تانية، وتغيير القاعدة بيتم في مكان واحد.
 */
async function requireOwned(
  ctx: ScopeCtx,
  entity: ScopedEntity | "variant",
  id: number
): Promise<void> {
  const allowed = await sessionBusinessIds(ctx);
  try {
    await assertOwned(allowed, entity, id);
  } catch (error) {
    if (error instanceof OutOfScopeError)
      throw new TRPCError({ code: "FORBIDDEN", message: error.message });
    if (error instanceof RecordNotFoundError)
      throw new TRPCError({ code: "NOT_FOUND", message: error.message });
    if (error instanceof ScopeUnavailableError)
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
    throw error;
  }
}

/** نفس الحارس لمجموعة معرّفات — الرفض على أول واحد برّه النطاق. */
async function requireAllOwned(
  ctx: ScopeCtx,
  entity: ScopedEntity,
  ids: number[]
): Promise<void> {
  const allowed = await sessionBusinessIds(ctx);
  try {
    await assertAllOwned(allowed, entity, ids);
  } catch (error) {
    if (error instanceof OutOfScopeError)
      throw new TRPCError({ code: "FORBIDDEN", message: error.message });
    if (error instanceof RecordNotFoundError)
      throw new TRPCError({ code: "NOT_FOUND", message: error.message });
    if (error instanceof ScopeUnavailableError)
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: error.message });
    throw error;
  }
}

/**
 * الموظف ده تابع لنطاقي؟
 *
 * الموظف كيان تابع للـtenant (بيتخلق بـ`tenantId: ctx.tenantId`)، فالفحص الأساسي على
 * الـtenant. لكن الصف القديم اللي `tenantId` بتاعه لسه `null` مايتقفلش في وش صاحبه —
 * بيتفحص بنطاق نشاطه بدل ما يترفض. الاتنين مع بعض بيقفلوا الشركة التانية من غير ما
 * يكسروا بيانات قايمة.
 */
async function assertEmployeeInScope<
  T extends { tenantId?: number | null; businessId?: number | null },
>(ctx: ScopeCtx, target: T | null | undefined): Promise<T> {
  if (!target)
    throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
  if (target.tenantId != null && target.tenantId !== ctx.tenantId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "الموظف ده تابع لحساب تاني",
    });
  }
  // النشاط بيتفحص كمان: صف قديم من غير tenant، أو موظف اتنقل لنشاط برّه النطاق.
  if (target.businessId != null) {
    await scopeBusinessId(ctx, target.businessId);
  }
  return target;
}

/**
 * السجل ده تابع لنطاقي؟
 *
 * الحارس اللي كان ناقص على مسارات التعديل. `scopeBusinessId` بتحمي المدخل اللي جاي من
 * العميل، لكن التعديل بالـid بيقرا السجل الأول — ونطاق السجل هو اللي لازم يتفحص، مش
 * اللي العميل بعته. من غير كده أدمن شركة أ يقدر يعدّل صف شركة ب لو عرف رقمه.
 *
 * بتعدّي على **نفس** `scopeBusinessId` عشان مايبقاش فيه منطق عزل موازي: قاعدة واحدة،
 * ورسالة رفض واحدة، ومكان واحد يتغيّر لو القاعدة اتغيّرت.
 *
 * السجل اللي `businessId` بتاعه `null` بيترفض: ده صف مش تابع لحد، والتعديل عليه من
 * جلسة نطاقها محدد قرار مالوش أساس.
 */
async function assertRecordInScope(
  ctx: ScopeCtx,
  record: { businessId?: number | null } | null | undefined,
  notFoundMessage: string
): Promise<void> {
  if (!record) throw new TRPCError({ code: "NOT_FOUND", message: notFoundMessage });
  if (record.businessId == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "السجل ده مش مربوط بنشاط — مش مسموح تعديله من هنا",
    });
  }
  await scopeBusinessId(ctx, record.businessId);
}

/**
 * Multi-tenancy: clamps a client-supplied businessId/businessIds filter to the ids that
 * actually belong to the caller's tenant, so a session can never read another tenant's data
 * just by passing an arbitrary id — the id list must never be trusted as-is from the client.
 * No filter supplied = the full set the tenant owns (today's default "show everything"
 * behaviour, unchanged for the single existing tenant until real multi-tenant signup exists).
 *
 * If the database itself is unreachable, `getBusinessIdsForTenant` returns `null` rather than
 * `[]` — that's "couldn't verify", not "verified: zero businesses". Clamping is skipped in that
 * case (the request falls through to whatever downstream query will fail with its own clear
 * "Database not available" error) instead of asserting a false FORBIDDEN.
 */
/**
 * مُعرّف مستحيل — بيخلي أي فلتر يطابق صفر صفوف.
 *
 * كل قرّاء `db.ts` بيتعاملوا مع المصفوفة الفاضية كـ«من غير فلتر» (`businessIds.length > 0`
 * قبل ما يضيفوا الشرط). يعني جلسة نطاقها **متحقّق وفاضي** — tenant لسه ماتربطش بأي
 * نشاط — كانت بتشوف **كل** بيانات النظام: أوردرات وخزنة ومخزون وكل حاجة.
 *
 * القرّاء ٢٨. تعديلهم واحد واحد معناه ٢٨ فرصة لواحد يتنسي، والنسيان ده هو نفسه اللي
 * عمل الثغرة. بدل كده النطاق الفاضي بيتحوّل هنا لمُعرّف مستحيل: `inArray(id, [-1])`
 * بيطابق ولا صف، وكل قارئ بيفضل زي ما هو ويشتغل صح.
 *
 * `null` (مش `[]`) لسه معناها «الداتابيز مش متاحة فمقدرش أتحقق» — دي حالة تانية
 * بالكامل ومتوثّقة في `getBusinessIdsForTenant`.
 */
const NO_BUSINESS = -1;

/** النطاق المتحقّق — والفاضي منه بيمنع كل حاجة بدل ما يسمح بكل حاجة. */
function denyWhenEmpty(allowed: number[]): number[] {
  return allowed.length > 0 ? allowed : [NO_BUSINESS];
}

/** الشكل اللي دوال النطاق محتاجاه من الـcontext — بيقبل أي ctx أوسع (structural). */
type ScopeCtx = {
  tenantId: number | null;
  user?: { role?: string | null } | null;
  employee?: { businessId?: number | null; role?: string | null } | null;
};

/**
 * أنشطة الجلسة المسموحة — **نقطة العزل الوحيدة** (P0: تقييد الموظف بنشاطه).
 *
 *   • المالك/المدير (جلسة admin: `ctx.user.role === "admin"`) → كل أنشطة الـtenant.
 *   • الموظف غير الإداري (`ctx.user = null`) → نشاطه بس `[employee.businessId]`.
 *   • موظف بلا نشاط (`businessId = null`) → `[]` (يُمنع من كل بيانات النشاط).
 *
 * `null` لسه معناها «الداتابيز مش متاحة» (زي getBusinessIdsForTenant) — بنقيّد الموظف
 * على نشاطه حتى ساعتها بدل ما نفتح.
 */
async function sessionBusinessIds(ctx: ScopeCtx, opts?: { ledgerTenantWide?: boolean }): Promise<number[] | null> {
  // tenantId مفقود = جلسة بلا تينانت — نتعامل معاها زي «مش قادر أتحقق» (null).
  const all = ctx.tenantId == null ? null : await getBusinessIdsForTenant(ctx.tenantId);
  if (ctx.user?.role === "admin") return all; // مالك/مدير: كل الأنشطة
  // مدير الحسابات: كل أنشطة شركته **داخل دفتر V3 فقط** (الدفتر وحده يطلب ledgerTenantWide) — باقي النظام كالمعتاد.
  if (opts?.ledgerTenantWide && ctx.employee?.role === ACCOUNTS_MANAGER_ROLE) return all;
  const bid = ctx.employee?.businessId ?? null;
  if (bid == null) return []; // موظف بلا نشاط → deny
  if (all == null) return [bid]; // DB مش متاحة → نثق في قيد الموظف
  return all.includes(bid) ? [bid] : []; // لازم يكون تابع للـtenant
}

async function scopeBusinessIds(
  ctx: ScopeCtx,
  requested?: { businessId?: number | null; businessIds?: number[] | null }
): Promise<number[] | undefined> {
  const allowed = await sessionBusinessIds(ctx);
  const requestedIds =
    requested?.businessIds && requested.businessIds.length > 0
      ? requested.businessIds
      : requested?.businessId != null
        ? [requested.businessId]
        : undefined;
  // fail-closed: تعذّر تحديد الأنشطة المسموحة (DB مش متاحة / جلسة بلا تينانت) = صفر صفوف،
  // **مش** ثقة في الـids الجاية من العميل. النطاق الفاضي أو الفشل = رفض، مش سماح.
  if (allowed == null) return [NO_BUSINESS];
  if (!requestedIds) return denyWhenEmpty(allowed);
  const allowedSet = new Set(allowed);
  // الترشيح ممكن يطلّع مصفوفة فاضية كمان — نفس الفخ بالظبط.
  return denyWhenEmpty(requestedIds.filter(id => allowedSet.has(id)));
}

/**
 * Same idea for procedures that only accept a single businessId (categories, warehouses,
 * sales channels, print logs, returns stats, activity log). Validates the id belongs to the
 * tenant instead of silently trusting any id; `undefined` (no filter) is left untouched.
 * fail-closed: لو تعذّر تحديد الأنشطة المسموحة (DB مش متاحة / بلا تينانت) نرفض بدل ما نثق
 * في الـid الجاي من العميل.
 */
async function scopeBusinessId(
  ctx: ScopeCtx,
  businessId?: number | null
): Promise<number | undefined> {
  if (businessId == null) return undefined;
  const allowed = await sessionBusinessIds(ctx);
  // fail-closed: تعذّر تحديد الأنشطة المسموحة (DB مش متاحة / بلا tenant) = رفض، مش ثقة في
  // الـid الجاي من العميل. رسالة مميّزة عن رفض الـIDOR عشان تتفرّق عن «الوصول ممنوع».
  if (allowed == null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "تعذّر تحديد نطاق النشاط",
    });
  }
  if (!allowed.includes(businessId)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "لا يمكنك الوصول لبيانات هذا الفرع/النشاط",
    });
  }
  return businessId;
}

/**
 * النشاط اللي هيتبعله موظف جديد — **مايرجعش null أبدًا** (منع تكرار مشكلة
 * `employees.businessId = NULL` اللي كسرت العزل).
 *
 * لو اتحدد نشاط: بيتأكد إنه تابع للتينانت (`scopeBusinessId`). لو مااتحددش (أو المدير
 * اللي بيضيف businessId بتاعه فاضي): بيجيب أنشطة التينانت — واحد بيستخدمه، أكتر من
 * واحد **لازم يتحدد** (مايخمّنش)، صفر بيرفض بوضوح. فمستحيل ينشأ موظف بلا نشاط.
 */
async function resolveEmployeeBusinessId(
  ctx: ScopeCtx,
  requested?: number | null
): Promise<number> {
  if (requested != null) {
    const scoped = await scopeBusinessId(ctx, requested);
    if (scoped == null)
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "النشاط ده مش تابع لحسابك",
      });
    return scoped;
  }
  const allowed = await sessionBusinessIds(ctx);
  if (allowed == null)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "تعذّر تحديد النشاط",
    });
  if (allowed.length === 1) return allowed[0];
  if (allowed.length === 0)
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "مفيش نشاط مرتبط بحسابك — أنشئ نشاطًا الأول",
    });
  throw new TRPCError({
    code: "BAD_REQUEST",
    message: "حدّد النشاط اللي هيتبعله الموظف — عندك أكتر من نشاط",
  });
}

/**
 * أنشطة نشاط الموظف الواحد لكتالوج شاشة الإدخال (منتجات + تركيبات). نطاق **نشاط الموظف
 * فقط** (مش كل الـtenant) — أضمن عزل ممكن: مستحيل تظهر منتجات نشاط تاني (زي الأسورة) حتى لو
 * كانوا في نفس الـtenant. بيمرّ من نفس choke point العزل (`scopeBusinessIds`) اللي بيرجّع
 * `[businessId]` للموظف أو `[-1]` (رفض). فاضي/رفض → صفر منتجات (fail-closed، مش الكل).
 */
async function employeeCatalogBusinessIds(ctx: ScopeCtx): Promise<number[]> {
  const ids = (await scopeBusinessIds(ctx, {})) ?? [];
  return ids.filter(id => id !== NO_BUSINESS);
}

/**
 * نفس `scopeBusinessId` لكن بيرجّع `number` مضمون.
 *
 * `scopeBusinessId` بيرجّع undefined في حالة واحدة بس: لما المدخل نفسه يكون null/undefined
 * (يعني "من غير فلتر"). الإجراءات اللي بتكتب في جدول عموده businessId NOT NULL بيكون
 * الـzod عندها فارض الرقم أصلاً، فالحالة دي مستحيلة عندها — والدالة دي بتوضّح ده للـtypes
 * بدل non-null assertion مبهم في كل سطر.
 */
async function requireScopedBusinessId(
  ctx: ScopeCtx,
  businessId: number
): Promise<number> {
  const scoped = await scopeBusinessId(ctx, businessId);
  if (scoped == null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "النشاط (businessId) مطلوب",
    });
  }
  return scoped;
}
import { loadShippingRouteRows, buildTodayShipments } from "./shippingOperations.service";
import {
  getAllEmployees,
  getActiveEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  searchEmployees,
  countActiveAdminTierEmployees,
  countActiveOwnerEmployees,
  getAllProducts,
  getProductById,
  createProduct,
  createProductWithVariants,
  addVariantsToProduct,
  variantIdentityKey,
  variantIdentityLabel,
  generateVariantSkus,
  getOwnedProductNames,
  buildOrderHeaderName,
  insertOrderWithItems,
  updateOrderWithItems,
  getOrderEntryMode,
  setOrderEntryMode,
  withBusinessLogos,
  setBusinessLogoUrl,
  getDefaultPackageImageUrl,
  setDefaultPackageImageUrl,
  insertOrderParseAudit,
  makeSlug,
  isOrderNumberCollision,
  findTakenSkusInBusiness,
  isSkuTakenInBusiness,
  updateProduct,
  isSkuTaken,
  isVariantNameTaken,
  getSyncLogs,
  getOrdersNeedingReview,
  getMatchCatalog,
  getLowStockProducts,
  addInventoryMovement,
  getInventoryMovements,
  getOrders,
  getOrderStatusCounts,
  getOrderById,
  getOrdersByIds,
  createOrder,
  createOrderWithItems,
  updateOrder,
  getBostaOrders,
  getBostaOrdersSummary,
  assignOrderToEmployee,
  bulkAssignOrders,
  confirmOrder,
  StockShortfallError,
  OrderConfirmBlockedError,
  OrderStockInconsistencyError,
  OrderStatusGuardError,
  postponeOrder,
  cancelOrder,
  editOrderWithInventory,
  deleteOrder,
  deleteOrders,
  generateOrderNumber,
  getDashboardStats,
  getEmployeePerformance,
  getCancellationReasons,
  getDailyOrdersChart,
  seedInitialData,
  getEmployeeInventory,
  reclaimEmployeeOrders,
  getAllBusinesses,
  getActiveBusinesses,
  getBusinessById,
  createBusiness,
  updateBusiness,
  getCategoriesByBusiness,
  createCategory,
  getCategoryById,
  updateCategory,
  getWarehousesByBusiness,
  createWarehouse,
  getWarehouseById,
  updateWarehouse,
  getBusinessGroupsWithBusinesses,
  getBusinessIdsByGroupId,
  getActiveBusinessGroups,
  editOrderFull,
  resolveOrderReviewProduct,
  orderContentChangedAfterShipmentCreation,
  getOrderEditLogs,
  logOrderEdit,
  getAccountingDashboard,
  getTreasuryBalance,
  getTreasuryTransactions,
  addTreasuryTransaction,
  getTreasurySummary,
  getDailyLedgerSummary,
  getAccountingControlCenter,
  getAccountingActionItems,
  getTreasuryHistoryWithBalances,
  listAdCampaigns,
  getExpenseCategories,
  createExpenseCategory,
  updateExpenseCategory,
  archiveExpenseCategory,
  getExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  getCollections,
  recordOrderCollection,
  getOrderCollectionHistory,
  getPayrollSettings,
  upsertPayrollSettings,
  getSalaryProfiles,
  listBusinessSalaryProfiles,
  deleteSalaryProfile,
  createSalaryProfile,
  createPayrollEmployee,
  updateSalaryProfile,
  getAdvances,
  createAdvance,
  cancelAdvance,
  getPayrollPeriods,
  getPayrollPeriod,
  createPayrollPeriod,
  recalculatePayrollPeriod,
  updatePayrollItem,
  approvePayrollPeriod,
  payPayrollPeriod,
  cancelPayrollPeriod,
  deletePayrollPeriod,
  getPayrollSummary,
  scanOrderBySerial,
  getScanLogs,
  getBusinessIdsForTenant,
} from "./db";
import {
  listSuppliers,
  saveSupplier,
  listHistoricalSupplierNames,
  mapHistoricalSupplierName,
  recordSupplierPayment,
  recordSupplierReturnCredit,
  recordReworkFee,
  recordOpeningBalance,
  recordSupplierAdjustment,
  listSupplierReceipts,
  reverseSupplierMovement,
  getSupplierStatement,
  getSupplierSummaries,
  getSupplierDashboardTotals,
} from "./supplierLedger.service";

// Helper: admin check
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin")
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "غير مصرح لك بهذا الإجراء",
    });
  return next({ ctx });
});

// Owner-only procedure: destructive, unrecoverable actions.
//
// The guard used to be `if (ctx.employee) throw` — meant as "reject manager
// employees, allow the real owner". But every branch of createContext() attaches
// an employee row, the /login owner session included, so the condition was always
// true and these procedures were denied to every account that can exist. The tier
// is now the `super_admin` role (labelled "المالك" in the employees screen), which
// is assignable, auditable, and visible to the person running the business.
const ownerProcedure = adminProcedure.use(({ ctx, next }) => {
  if (!isOwnerRole(ctx.employee?.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "هذا الإجراء متاح للمالك فقط",
    });
  }
  return next({ ctx });
});

/**
 * Gate on who may hand out (or take away) the owner tier.
 *
 * Without this the tier would be decorative: every admin-tier account can edit
 * employees, so any manager could promote themselves and inherit the destructive
 * actions the tier exists to withhold.
 *
 * The one exception is bootstrap. A fresh install has no owner (scripts/seed-admin.ts
 * seeds a `manager`), so the first owner has to come from somewhere — while zero
 * active owners exist, any admin may create one. After that it is owner-to-owner only.
 */
async function assertMayAssignOwnerRole(
  ctx: { employee?: { role?: string | null } | null },
  targetRole: string | undefined,
  currentRole: string | null | undefined
): Promise<void> {
  const grants = targetRole !== undefined && isOwnerRole(targetRole);
  const revokes =
    targetRole !== undefined && !isOwnerRole(targetRole) && isOwnerRole(currentRole);
  if (!grants && !revokes) return;
  if (isOwnerRole(ctx.employee?.role)) return;

  if (grants && (await countActiveOwnerEmployees()) === 0) return; // bootstrap

  throw new TRPCError({
    code: "FORBIDDEN",
    message: "صلاحية المالك لا يمنحها أو يسحبها إلا المالك",
  });
}

/**
 * دور مدير الحسابات (0045): يعيّنه **ويديره** المالك فقط — منح الدور، أو سحبه، أو أي تعديل/حذف/تغيير بيانات دخول
 * لموظف يحمله (حسابه يحرّك الدفتر). ومنحه يتطلب أن تقبل القاعدة القيمة (0045 مطبّقة)، وإلا رفض واضح بلا كتابة.
 */
async function assertMayManageAccountsManager(
  ctx: { employee?: { role?: string | null } | null },
  targetRole: string | undefined,
  currentRole: string | null | undefined
): Promise<void> {
  const grants = targetRole === ACCOUNTS_MANAGER_ROLE;
  const touches = currentRole === ACCOUNTS_MANAGER_ROLE;
  if (!grants && !touches) return;
  if (!isOwnerRole(ctx.employee?.role))
    throw new TRPCError({ code: "FORBIDDEN", message: "دور مدير الحسابات يعيّنه ويديره المالك فقط" });
  if (grants && !(await isAccountsManagerRoleSupported()))
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "دور مدير الحسابات غير متاح بعد في قاعدة البيانات (Migration 0045 غير مطبّقة) — لم يُحفظ شيء" });
}

/** هل عمود employees.role يقبل accounts_manager؟ (قراءة فقط من information_schema) */
async function isAccountsManagerRoleSupported(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  return accountsManagerRoleSupported({ query: (q: string) => db.execute(sql.raw(q)) });
}

/**
 * نطاق دفتر V3 فقط: مدير الحسابات يرى ويعمل على **كل أنشطة شركته داخل الدفتر وحده** (المراجعة والإقفال على مستوى
 * الشركة). لا يتغير نطاق جلسته في أي جزء آخر من النظام. باقي الأدوار: نطاق الجلسة المعتاد (المحاسب = نشاطه).
 */
async function ledgerSessionBusinessIds(ctx: ScopeCtx): Promise<number[] | null> {
  return sessionBusinessIds(ctx, { ledgerTenantWide: true });
}
async function ledgerScopeBusinessId(ctx: ScopeCtx, businessId?: number | null): Promise<number | undefined> {
  if (ctx.employee?.role !== ACCOUNTS_MANAGER_ROLE) return scopeBusinessId(ctx, businessId);
  if (businessId == null) return undefined;
  const allowed = await sessionBusinessIds(ctx, { ledgerTenantWide: true });
  if (!allowed || !allowed.includes(businessId)) throw new TRPCError({ code: "FORBIDDEN", message: "النشاط خارج شركتك" });
  return businessId;
}

// Helper: resolve the real employee ID for audit fields
// For manager employees using the admin dashboard, ctx.realEmployeeId has the actual employee ID
// For regular admin/owner, we look up the employee linked to their user ID
async function resolveActingEmployeeId(ctx: any): Promise<number | undefined> {
  if (ctx.realEmployeeId) return ctx.realEmployeeId;
  const emps = await getAllEmployees();
  const emp = emps.find((e: any) => e.userId === ctx.user?.id);
  return emp?.id;
}

/** Same resolution as resolveActingEmployeeId, plus a display name for denormalized
 *  "who did this" fields — falls back to the admin/owner's own account name when the
 *  acting session has no linked employee record. */
async function resolveActingEmployeeIdAndName(
  ctx: any
): Promise<{ id: number | undefined; name: string | undefined }> {
  if (ctx.employee) return { id: ctx.employee.id, name: ctx.employee.name };
  const emps = await getAllEmployees();
  const emp = ctx.realEmployeeId
    ? emps.find((e: any) => e.id === ctx.realEmployeeId)
    : emps.find((e: any) => e.userId === ctx.user?.id);
  return { id: emp?.id, name: emp?.name ?? ctx.user?.name ?? undefined };
}

/** صلاحية فعلية للجلسة (ويب): المدير بالمنح الصريح، المالك/الأدمن الصناعي نعم، غير ذلك خريطة الشركة. */
async function sessionHasPermission(ctx: any, permission: Permission): Promise<boolean> {
  if (ctx.tenantId == null) return false;
  if (ctx.employee?.role === "manager") return hasTenantPermission(ctx.tenantId, "manager", permission);
  if (ctx.user?.role === "admin") return true;
  return hasTenantPermission(ctx.tenantId, ctx.employee?.role, permission);
}
async function requireSessionPermission(ctx: any, permission: Permission): Promise<void> {
  if (!(await sessionHasPermission(ctx, permission)))
    throw new TRPCError({ code: "FORBIDDEN", message: "ليس لديك صلاحية لتنفيذ هذا الإجراء" });
}

/** الفاعل في الحضور من **الجلسة** فقط (ويب): tenant الجلسة + صف الموظف الحقيقي. */
function webAttendanceActor(ctx: any): attendanceSvc.AttendanceActor {
  if (!ctx.employee || ctx.tenantId == null) throw new TRPCError({ code: "FORBIDDEN", message: "تعذّر تحديد الموظف" });
  return { tenantId: ctx.tenantId, employeeId: ctx.employee.id, role: ctx.employee.role ?? null, businessId: ctx.employee.businessId ?? null, name: ctx.employee.name ?? null };
}
/** الفاعل في الفرق (ويب): tenant الجلسة + صف الموظف الحقيقي — الخدمة تتحقق أنه موجب ونشط في نفس الشركة. */
function webTeamsActor(ctx: any): teamsSvc.TeamsActor {
  if (!ctx.employee || ctx.tenantId == null) throw new TRPCError({ code: "FORBIDDEN", message: "تعذّر تحديد الموظف" });
  return { tenantId: ctx.tenantId, employeeId: ctx.employee.id, role: ctx.employee.role ?? null };
}
/** الفاعل في الفرق لجلسة البوابة — كوكي الموظف فقط. */
function portalTeamsActor(ctx: any): teamsSvc.TeamsActor {
  const emp = ctx.employee;
  return { tenantId: requireTenantId(emp), employeeId: emp.id, role: emp.role ?? null };
}
/**
 * حارس القائد في البوابة: الصلاحية (بتجاوزات الشركة، هوية الكوكي فقط) **و** قيادة فعّالة لنفس الفريق في نفس
 * الشركة — الصلاحية وحدها لا تكفي. غير القائد = FORBIDDEN لهذا الفريق.
 */
async function requireTeamLeader(ctx: any, teamId: number): Promise<teamsSvc.LeaderTeam> {
  return teamsSvc.requireLeaderOf(portalTeamsActor(ctx), teamId);
}

/** الفاعل في الحضور لجلسة البوابة — كوكي الموظف فقط (لا صلاحيات جلسة مالك مفتوحة). */
function portalAttendanceActor(ctx: any): attendanceSvc.AttendanceActor {
  const emp = ctx.employee;
  return { tenantId: requireTenantId(emp), employeeId: emp.id, role: emp.role ?? null, businessId: emp.businessId ?? null, name: emp.name ?? null };
}
const attendanceRange = z.object({ dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

/** معرّف العملية من الواجهة (ثابت طوال دورة العملية) — يُستخدم فقط والعلم مفعّل. */
const operationIdInput = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).optional();

/** سياق حدث لجلسة الويب (الإدارة) — undefined والعلم معطل (المسار القديم حرفيًا). */
async function webEventCtx(ctx: any, source: "admin_ui" | "bulk", operationId?: string): Promise<OrderEventContext | undefined> {
  if (!orderEventsEnabled()) return undefined;
  const { id, name } = await resolveActingEmployeeIdAndName(ctx);
  return { actor: { type: "employee", employeeId: id ?? 0, role: ctx.employee?.role ?? null, name: name ?? null }, source, operationId: operationId ?? null };
}

/** سياق حدث لجلسة البوابة — الموظف من الجلسة فقط. */
function portalEventCtx(ctx: any, source: "employee_portal" | "bulk", operationId?: string): OrderEventContext | undefined {
  if (!orderEventsEnabled()) return undefined;
  const emp = ctx.employee;
  return { actor: { type: "employee", employeeId: emp?.id ?? 0, role: emp?.role ?? null, name: emp?.name ?? null }, source, operationId: operationId ?? null };
}

/** Ledger V3 (المرحلة 4): حركة لنفس أصناف الجرد بعد لقطته = رفض الاعتماد قبل أي تغيير (لا فرق مكرر). */
async function stocktakeMovementGuard(businessId: number, stocktakeId: number) {
  try { await assertNoMovementDuringStocktake({ businessId, stocktakeId }); }
  catch (e) { if (e instanceof InventoryLedgerError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message }); throw e; }
}

async function requireActor(ctx: any): Promise<{ id: number; name: string }> {
  const actor = await resolveActingEmployeeIdAndName(ctx);
  const id = actor.id ?? ctx.user?.id;
  if (id == null)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "تعذر تحديد منفذ العملية",
    });
  return { id, name: actor.name ?? "غير معروف" };
}

/**
 * مين بيعدّل محتوى الأوردر — بيشتغل على الجلستين.
 *
 * `orders.editOrderItems` بقت `permissionProcedure`، يعني موظف بصلاحية `orders.edit_items`
 * يقدر يوصلها بكوكي الموظف من غير حساب مالك — وساعتها `ctx.user` بيبقى null. السجل لازم
 * يقول اسم الشخص ودوره الحقيقي، مش «Admin» على طول؛ سجل تدقيق بيسمّي الكل بنفس الاسم
 * مش سجل تدقيق.
 */
function resolveOrderEditor(ctx: any): { id: number; name: string; role: string } {
  const emp = ctx.employee;
  if (emp) return { id: emp.id, name: emp.name, role: emp.role };
  return {
    id: ctx.user?.id ?? 0,
    name: ctx.user?.name ?? "مدير",
    role: ctx.user?.role ?? "admin",
  };
}

async function assertLegacyInventoryMutationAllowed(businessId: number) {
  const db = await getDb();
  if (!db)
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "قاعدة البيانات غير متاحة",
    });
  const [business] = await db
    .select({ accountingGoLiveAt: businessesTable.accountingGoLiveAt })
    .from(businessesTable)
    .where(eq(businessesTable.id, businessId))
    .limit(1);
  if (!business)
    throw new TRPCError({ code: "NOT_FOUND", message: "النشاط غير موجود" });
  if (business.accountingGoLiveAt) {
    throw new TRPCError({
      code: "CONFLICT",
      message:
        "بعد Go-Live استخدم Purchase Receipt أو Reservation/Dispatch من تبويب التكلفة والاستلام",
    });
  }
}

const moneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,4})?$/, "القيمة المالية يجب ألا تتجاوز 4 خانات عشرية");
const positiveMoneyString = moneyString.refine(
  value => Number(value) > 0,
  "القيمة يجب أن تكون أكبر من صفر"
);

/** فاعل Ledger V3 من الجلسة (الموظف الحقيقي) — بلا موظف = فاعل النظام. */
function ledgerActorOf(ctx: any): LedgerActor {
  const id = ctx.employee?.id ?? ctx.realEmployeeId;
  return id ? { type: "employee", employeeId: Number(id) } : { type: "system" };
}
/** ربط V3 بعد إجراء تشغيلي معتمد: لا يُسقط الإجراء — يرجع نتيجة صريحة (posted/skipped/review). */
async function ledgerHookSafely<T>(fn: () => Promise<T>): Promise<T | { status: "review"; reason: string }> {
  try { return await fn(); } catch (e) { return { status: "review", reason: e instanceof Error ? e.message : String(e) }; }
}

export const appRouter = router({
  // المرحلة 4: التسليم لمندوب الشحن بمسح QR — حجز (إن لزم) ثم خروج البضاعة وتثبيت لقطة التكلفة مرة واحدة.
  // فقط لنشاط بتقييم مخزون وشركة دفترها مفعّل؛ الصلاحية inventory.adjust (موظف المخزن) ونطاق الجلسة.
  inventoryLedger: router({
    status: permissionProcedure("inventory.adjust")
      .input(z.object({ businessId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => ({ active: await isInventoryLedgerActive(await requireScopedBusinessId(ctx, input.businessId)) })),
    handover: permissionProcedure("inventory.adjust")
      .input(z.object({ businessId: z.number().int().positive(), orderId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(ctx, input.businessId);
        try { return await handoverOrder({ businessId, orderId: input.orderId, actor: await requireActor(ctx) }); }
        catch (e) { throw new TRPCError({ code: e instanceof InventoryLedgerError ? "PRECONDITION_FAILED" : "BAD_REQUEST", message: (e as Error).message }); }
      }),
  }),

  system: systemRouter,
  // حالة وصول الشركة للواجهة (شاشة/شريط) — العلم معطل ⇒ enforced:false فلا تظهر أي شاشة قبل جاهزية الحارس.
  tenantAccess: router({
    status: publicProcedure.query(async ({ ctx }) => {
      if (!tenantAccessEnforcementEnabled() || ctx.tenantId == null) return { enforced: false as const };
      const a = await resolveTenantAccess(ctx.tenantId);
      return { enforced: true as const, level: a.level, reason: a.reason, message: TENANT_ACCESS_MESSAGES[a.reason], until: a.until };
    }),
  }),
  accountingV2: router({
    dashboard: permissionProcedure("accounting.view")
      .input(
        z
          .object({
            businessIds: z.array(z.number()).optional(),
            dateFrom: z.date().optional(),
            dateTo: z.date().optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const data = await getBusinessEventDashboard({
          businessIds:
            (await scopeBusinessIds(ctx, input ?? {})) ?? [],
          dateFrom: input?.dateFrom,
          dateTo: input?.dateTo,
        });
        // الربح (المحقق والمتوقع) لمن يملك reports.view_profit فقط — الحجب من السيرفر.
        if (await canViewProfit(ctx)) return data;
        const { realized: _r, projected: _p, ...operational } = data;
        return { ...operational, realized: null, projected: null, profitHidden: true as const };
      }),
    /**
     * ملخص لوحة المحاسب — تجميع قراءة فقط من دوال موجودة (شوف accountantSummary.service).
     * محمي بـaccounting.view زي باقي شاشات الحسابات؛ النطاق على أنشطة الجلسة.
     */
    accountantSummary: permissionProcedure("accounting.view")
      .input(z.object({ businessIds: z.array(z.number()).optional() }).optional())
      .query(async ({ ctx, input }) =>
        getAccountantSummary((await scopeBusinessIds(ctx, input ?? {})) ?? [])
      ),
    businessSettings: permissionProcedure("settings.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const db = await getDb();
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "قاعدة البيانات غير متاحة",
          });
        const [business] = await db
          .select({
            id: businessesTable.id,
            baseCurrency: businessesTable.baseCurrency,
            timezone: businessesTable.timezone,
            accountingGoLiveAt: businessesTable.accountingGoLiveAt,
            defaultWarehouseId: businessesTable.defaultWarehouseId,
          })
          .from(businessesTable)
          .where(eq(businessesTable.id, businessId))
          .limit(1);
        return business ?? null;
      }),

    updateBusinessSettings: permissionProcedure("settings.manage")
      .input(
        z.object({
          businessId: z.number(),
          baseCurrency: z
            .string()
            .length(3)
            .transform(value => value.toUpperCase()),
          timezone: z.string().min(1),
          accountingGoLiveAt: z.date(),
          defaultWarehouseId: z.number().int().positive(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        if (!isValidIanaTimeZone(input.timezone))
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "الـ Timezone غير صالح",
          });
        const db = await getDb();
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "قاعدة البيانات غير متاحة",
          });
        const [event] = await db
          .select({ id: businessEvents.id })
          .from(businessEvents)
          .where(eq(businessEvents.businessId, businessId))
          .limit(1);
        const [closing] = await db
          .select({ id: accountingClosings.id })
          .from(accountingClosings)
          .where(eq(accountingClosings.businessId, businessId))
          .limit(1);
        const [currentBiz] = await db
          .select({ accountingGoLiveAt: businessesTable.accountingGoLiveAt })
          .from(businessesTable)
          .where(eq(businessesTable.id, businessId))
          .limit(1);
        // ضبط تاريخ التشغيل المحاسبي يبدّل سلوك المخزون والمرتجعات كلها — مجمَّد مع النظام.
        if (
          !isAccountingModuleEnabled() &&
          (currentBiz?.accountingGoLiveAt?.getTime() ?? null) !== input.accountingGoLiveAt.getTime()
        )
          throw new TRPCError({ code: "FORBIDDEN", message: ACCOUNTING_FROZEN_MESSAGE });
        if (event || closing)
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "إعدادات العملة وتاريخ التشغيل لا تتغير بعد بدء الحركات المحاسبية",
          });
        await db
          .update(businessesTable)
          .set({
            baseCurrency: input.baseCurrency,
            timezone: input.timezone,
            accountingGoLiveAt: input.accountingGoLiveAt,
            defaultWarehouseId: input.defaultWarehouseId,
          })
          .where(eq(businessesTable.id, businessId));
        return { success: true };
      }),

    configurationList: permissionProcedure("settings.view")
      .input(
        z.object({
          businessId: z.number(),
          namespace: z.string().min(1).max(80),
          activeOnly: z.boolean().default(true),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const db = await getDb();
        if (!db) return [];
        return db
          .select()
          .from(businessConfigurationValues)
          .where(
            and(
              eq(businessConfigurationValues.businessId, businessId),
              eq(businessConfigurationValues.namespace, input.namespace),
              ...(input.activeOnly
                ? [eq(businessConfigurationValues.isActive, true)]
                : [])
            )
          )
          .orderBy(
            businessConfigurationValues.sortOrder,
            businessConfigurationValues.displayName
          );
      }),

    configurationListForBusinesses: authenticatedProcedure
      .input(
        z.object({
          businessIds: z.array(z.number()).optional(),
          namespace: z.string().min(1).max(80),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = (await scopeBusinessIds(ctx, input)) ?? [];
        const db = await getDb();
        if (!db || businessIds.length === 0) return [];
        const rows = await db
          .select()
          .from(businessConfigurationValues)
          .where(
            and(
              inArray(businessConfigurationValues.businessId, businessIds),
              eq(businessConfigurationValues.namespace, input.namespace),
              eq(businessConfigurationValues.isActive, true)
            )
          )
          .orderBy(
            businessConfigurationValues.sortOrder,
            businessConfigurationValues.displayName
          );
        const unique = new Map(rows.map(row => [row.configKey, row]));
        return [...unique.values()];
      }),

    /**
     * إضافة قيمة تشغيلية بالاسم فقط (نوع شحن / نوع دفع) من داخل نموذج الأوردر — للنشاط الجديد
     * الذي لا يملك قيمًا بعد. المفتاح الثابت يُولَّد على السيرفر؛ نفس الاسم (بعد التشذيب) لا
     * يتكرر بل يُعاد الصف القائم (ويُعاد تفعيله لو كان موقوفًا). ضمن نطاق الجلسة فقط.
     */
    configurationQuickAdd: permissionProcedure("settings.manage")
      .input(
        z.object({
          businessId: z.number(),
          namespace: z.enum(["shipping_type", "payment_type"]),
          displayName: z.string().trim().min(1).max(160),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(ctx, input.businessId);
        const actor = await requireActor(ctx);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
        const displayName = input.displayName.replace(/\s+/g, " ").trim();
        const rows = await db
          .select()
          .from(businessConfigurationValues)
          .where(and(eq(businessConfigurationValues.businessId, businessId), eq(businessConfigurationValues.namespace, input.namespace)));
        const existing = rows.find(r => r.displayName.replace(/\s+/g, " ").trim().toLowerCase() === displayName.toLowerCase());
        if (existing) {
          if (!existing.isActive)
            await db.update(businessConfigurationValues).set({ isActive: true, updatedBy: actor.id }).where(eq(businessConfigurationValues.id, existing.id));
          return { ...existing, isActive: true, created: false };
        }
        const configKey = makeSlug(displayName, input.namespace, 100);
        const [ins] = await db.insert(businessConfigurationValues).values({
          businessId, namespace: input.namespace, configKey, displayName,
          valueJson: null, sortOrder: rows.length, isActive: true, createdBy: actor.id, updatedBy: actor.id,
        });
        const [row] = await db.select().from(businessConfigurationValues).where(eq(businessConfigurationValues.id, Number((ins as any).insertId)));
        return { ...row, created: true };
      }),

    configurationSave: permissionProcedure("settings.manage")
      .input(
        z.object({
          businessId: z.number(),
          namespace: z.string().min(1).max(80),
          configKey: z.string().min(1).max(100),
          displayName: z.string().min(1).max(160),
          value: z.unknown().optional(),
          sortOrder: z.number().int().default(0),
          isActive: z.boolean().default(true),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const actor = await requireActor(ctx);
        const db = await getDb();
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "قاعدة البيانات غير متاحة",
          });
        await db
          .insert(businessConfigurationValues)
          .values({
            businessId,
            namespace: input.namespace,
            configKey: input.configKey,
            displayName: input.displayName,
            valueJson:
              input.value === undefined ? null : JSON.stringify(input.value),
            sortOrder: input.sortOrder,
            isActive: input.isActive,
            createdBy: actor.id,
            updatedBy: actor.id,
          })
          .onDuplicateKeyUpdate({
            set: {
              displayName: input.displayName,
              valueJson:
                input.value === undefined ? null : JSON.stringify(input.value),
              sortOrder: input.sortOrder,
              isActive: input.isActive,
              updatedBy: actor.id,
            },
          });
        return { success: true };
      }),

    costCenters: permissionProcedure("accounting.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const db = await getDb();
        if (!db) return [];
        return db
          .select()
          .from(costCenters)
          .where(eq(costCenters.businessId, businessId))
          .orderBy(costCenters.name);
      }),

    costCenterSave: permissionProcedure("accounting.manage")
      .input(
        z.object({
          businessId: z.number(),
          code: z.string().min(1).max(50),
          name: z.string().min(1).max(100),
          isActive: z.boolean().default(true),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const db = await getDb();
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "قاعدة البيانات غير متاحة",
          });
        await db
          .insert(costCenters)
          .values({ ...input, businessId })
          .onDuplicateKeyUpdate({
            set: { name: input.name, isActive: input.isActive },
          });
        return { success: true };
      }),

    rolePermissionSave: ownerProcedure
      .input(
        z.object({
          role: z.enum(EMPLOYEE_ROLE_VALUES),
          permission: z.enum(ALL_PERMISSIONS),
          isAllowed: z.boolean(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // الصلاحيات المقفولة للمالك (اطلاع المالك على المحادثات الخاصة) لا تُمنح لأي دور آخر.
        if (isLockedOwnerPermission(input.permission) && !isOwnerRole(input.role))
          throw new TRPCError({ code: "FORBIDDEN", message: "هذه الصلاحية للمالك فقط ولا يمكن منحها لأي دور آخر" });
        // فتح الشهر والتفعيل للمالك الحقيقي فقط، وعكس الحركات للمالك ومدير الحسابات فقط — لا منح لغيرهم (السحب مسموح).
        if (input.isAllowed && (LEDGER_OWNER_ONLY_PERMISSIONS as readonly string[]).includes(input.permission) && !isOwnerRole(input.role))
          throw new TRPCError({ code: "FORBIDDEN", message: "فتح الشهر والتفعيل للمالك فقط ولا يُمنحان لأي دور آخر" });
        if (input.isAllowed && isRoleRestrictedDenied(input.role, input.permission))
          throw new TRPCError({ code: "FORBIDDEN", message: "عكس الحركات للمالك ومدير الحسابات فقط ولا يُمنح لهذا الدور" });
        const actor = await requireActor(ctx);
        const db = await getDb();
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "قاعدة البيانات غير متاحة",
          });
        await db
          .insert(tenantRolePermissions)
          .values({
            tenantId: ctx.tenantId,
            role: input.role,
            permission: input.permission,
            isAllowed: input.isAllowed,
            updatedBy: actor.id,
          })
          .onDuplicateKeyUpdate({
            set: { isAllowed: input.isAllowed, updatedBy: actor.id },
          });
        return { success: true };
      }),

    permissionConfiguration: ownerProcedure.query(async ({ ctx }) => {
      const db = await getDb();
      const overrides = db
        ? await db
            .select()
            .from(tenantRolePermissions)
            .where(eq(tenantRolePermissions.tenantId, ctx.tenantId))
        : [];
      return {
        roles: EMPLOYEE_ROLE_VALUES.map(role => ({
          role,
          defaultPermissions: [...permissionsForRole(role)],
        })),
        permissions: [...ALL_PERMISSIONS],
        overrides,
      };
    }),

    financialAccounts: permissionProcedure("financial_accounts.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) =>
        getFinancialAccounts(
          await requireScopedBusinessId(ctx, input.businessId)
        )
      ),

    financialAccountCreate: permissionProcedure("financial_accounts.manage")
      .input(
        z.object({
          businessId: z.number(),
          code: z.string().min(1).max(50),
          name: z.string().min(1).max(120),
          accountType: z.string().min(1).max(50),
          currencyCode: z.string().length(3),
          isCashEquivalent: z.boolean().default(true),
          allowNegativeBalance: z.boolean().default(false),
          openingBalance: moneyString.default("0"),
          openingBalanceAt: z.date().optional(),
          openingEvidenceUrl: z.string().url().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        if (
          toMinorUnits(input.openingBalance) !== 0n &&
          !input.openingEvidenceUrl
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "دليل الرصيد الافتتاحي مطلوب",
          });
        }
        if (toMinorUnits(input.openingBalance) !== 0n && ctx.employee) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "اعتماد الرصيد الافتتاحي متاح للمالك فقط",
          });
        }
        return createFinancialAccount({
          ...input,
          businessId,
          currencyCode: input.currencyCode.toUpperCase(),
        });
      }),

    financialTransactionPost: permissionProcedure("financial_accounts.manage")
      .input(
        z.object({
          businessId: z.number(),
          transactionType: z.string().min(1).max(60),
          sourceAccountId: z.number().optional(),
          targetAccountId: z.number().optional(),
          amount: positiveMoneyString,
          currencyCode: z.string().length(3),
          description: z.string().min(1),
          externalCounterparty: z.string().max(160).optional(),
          occurredAt: z.date(),
          evidenceUrl: z.string().url(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const actor = await requireActor(ctx);
        return postFinancialTransaction({
          ...input,
          businessId,
          currencyCode: input.currencyCode.toUpperCase(),
          actor,
        });
      }),

    orderPaymentConfirm: permissionProcedure("financial_accounts.manage")
      .input(
        z.object({
          businessId: z.number(),
          orderId: z.number(),
          targetAccountId: z.number(),
          amount: positiveMoneyString,
          paymentReference: z.string().min(1).max(160),
          confirmedAt: z.date(),
          evidenceUrl: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) =>
        confirmOrderPayment({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    orderPaymentRefund: permissionProcedure("financial_accounts.manage")
      .input(
        z.object({
          businessId: z.number(),
          orderId: z.number(),
          sourceAccountId: z.number(),
          amount: positiveMoneyString,
          refundReference: z.string().min(1).max(160),
          refundedAt: z.date(),
          reason: z.string().min(5),
          evidenceUrl: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) =>
        refundOrderPayment({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    expenseSubmit: permissionProcedure("accounting.manage")
      .input(z.object({ businessId: z.number(), expenseId: z.number() }))
      .mutation(async ({ ctx, input }) =>
        submitExpense({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    expenseApprove: permissionProcedure("closing.approve")
      .input(z.object({ businessId: z.number(), expenseId: z.number() }))
      .mutation(async ({ ctx, input }) =>
        approveExpense({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          // الحاجز يفضل قايم لكل الموظفين. المالك هو الطرفين أصلاً.
          allowSelfApproval: isOwnerRole(ctx.employee?.role),
          actor: await requireActor(ctx),
        })
      ),

    expensePay: permissionProcedure("financial_accounts.manage")
      .input(
        z.object({
          businessId: z.number(),
          expenseId: z.number(),
          // اختياري: التاجر اللي عنده خزنة واحدة مابيختارش منها. الخدمة بتحلّها
          // لـ«الخزنة الرئيسية» وبتعملها لو لسه مش موجودة.
          sourceAccountId: z.number().optional(),
          amount: positiveMoneyString,
          paidAt: z.date(),
          // الدليل بقى اختياري — التاجر بيسجّل الدفع مباشرة من غير رابط فاتورة.
          evidenceUrl: z.string().url().optional(),
          /** معرّف الضغطة (uuid من العميل) — إعادة الإرسال بنفسه لا تدفع مرتين. */
          operationId: z.string().trim().min(8).max(100).optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        withIdempotencyGuard(async () =>
          payExpense({
            ...input,
            businessId: await requireScopedBusinessId(
              ctx,
              input.businessId
            ),
            actor: await requireActor(ctx),
          })
        )
      ),

    adSpendCreate: permissionProcedure("ad_spend.manage")
      .input(
        z.object({
          businessId: z.number(),
          categoryId: z.number().optional(),
          costCenterId: z.number().optional(),
          amount: positiveMoneyString,
          currencyCode: z.string().length(3).optional(),
          description: z.string().min(1),
          serviceFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          serviceTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          reference: z.string().max(100).optional(),
          evidenceUrl: z.string().max(500).optional(),
          platformId: z.string().min(1),
          platformName: z.string().min(1),
          accountId: z.string().min(1),
          accountName: z.string().min(1),
          campaignId: z.string().min(1),
          campaignName: z.string().min(1),
          adSetId: z.string().optional(),
          adId: z.string().optional(),
          manualMetrics: z.record(z.string(), z.number()).optional(),
          // المرفق اختياري — createAdSpendDraft بيعمل مسودة، والمسودة مابتحركش فلوس
          overrideReason: z.string().optional(),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        createAdSpendDraft({
          ...input,
          currencyCode: input.currencyCode?.toUpperCase(),
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    /** تعديل صرف إعلان لسه مسودة — التاجر بيغلط في رقم ويعرف بعد ساعة. */
    adSpendDelete: permissionProcedure("ad_spend.manage")
      .input(z.object({ businessId: z.number(), adSpendId: z.number() }))
      .mutation(async ({ ctx, input }) =>
        deleteAdSpendDraft({
          adSpendId: input.adSpendId,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    adSpendUpdate: permissionProcedure("ad_spend.manage")
      .input(
        z.object({
          businessId: z.number(),
          adSpendId: z.number(),
          amount: positiveMoneyString.optional(),
          campaignName: z.string().min(1).max(160).optional(),
          platformName: z.string().min(1).max(120).optional(),
          manualMetrics: z.record(z.string(), z.number()).optional(),
          notes: z.string().max(1000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        updateAdSpendDraft({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),


    inventoryReserve: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          orderId: z.number(),
          warehouseId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        reserveOrderInventory({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    inventoryControlData: permissionProcedure("inventory_costing.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) =>
        getInventoryControlData(
          await requireScopedBusinessId(ctx, input.businessId)
        )
      ),

    inventoryDispatch: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          orderId: z.number(),
          occurredAt: z.date(),
          ownerNegativeOverrideReason: z.string().min(5).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        if (input.ownerNegativeOverrideReason && ctx.employee)
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "تجاوز المخزون السالب متاح للمالك فقط",
          });
        return dispatchOrderInventory({
          ...input,
          businessId,
          actor: await requireActor(ctx),
        });
      }),

    openingInTransitRecord: permissionProcedure("inventory_costing.approve")
      .input(
        z.object({
          businessId: z.number(),
          orderId: z.number(),
          businessShippingProviderId: z.number(),
          externalShipmentId: z.string().optional(),
          trackingNumber: z.string().optional(),
          currentStatus: z.string().min(1),
          dispatchedAt: z.date(),
          items: z
            .array(
              z.object({
                orderItemId: z.number(),
                quantity: z.number().int().positive(),
                unitCostSnapshot: moneyString,
              })
            )
            .min(1),
        })
      )
      .mutation(async ({ ctx, input }) =>
        recordOpeningInTransit({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    purchaseReceiptApprove: permissionProcedure("inventory_costing.approve")
      .input(
        z.object({
          businessId: z.number(),
          receiptId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        approvePurchaseReceipt({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
          // المالك بس. الموظف اللي سجّل الإذن لسه مايقدرش يعتمده — شوف الشرح على
          // approvePurchaseReceipt.
          allowSelfApproval: isOwnerRole(ctx.employee?.role),
        })
      ),

    // تحويل مخزون بين مخزنين — مسار الورشة. صلاحية manage مش approve: ده نقل عهدة
    // داخلي مابيغيّرش إجمالي المخزون ولا قيمته، مش قرار مالي.
    stockTransfer: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          fromWarehouseId: z.number(),
          toWarehouseId: z.number(),
          reference: z.string().min(1).max(100),
          reason: z.string().min(1).max(500),
          occurredAt: z.date(),
          // بيتحط على تحويل الرجوع عشان يقفل دفعة المرتجع اللي راحت الورشة
          linkedReference: z.string().max(100).optional(),
          // للعلم بس — مابيعملش مصروف ولا بيلمس خزنة
          repairCostPerPiece: moneyString.optional(),
          lines: z
            .array(
              z.object({
                productId: z.number(),
                variantId: z.number().nullish(),
                quantity: z.number().int().positive(),
              })
            )
            .min(1),
        })
      )
      .mutation(async ({ ctx, input }) =>
        transferStock({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    /** دفعات المرتجع للورشة وحالتها — مشتقّة من التحويلات، مفيش جدول حالة. */
    workshopReturns: permissionProcedure("inventory_costing.view")
      .input(
        z.object({
          businessId: z.number(),
          workshopWarehouseId: z.number(),
          limit: z.number().min(1).max(500).optional(),
        })
      )
      .query(async ({ ctx, input }) =>
        listWorkshopReturns({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    // ── مرتجعات الورشة: المخازن تلقائيًا، رقم الإذن تلقائيًا، شاشة واحدة ──
    workshopSetup: permissionProcedure("inventory_costing.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) =>
        getWorkshopSetup(
          await requireScopedBusinessId(ctx, input.businessId)
        )
      ),

    workshopSetWarehouse: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          warehouseId: z.number().optional(),
          newWarehouseName: z.string().min(1).max(100).optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        setWorkshopWarehouse({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    workshopBatches: permissionProcedure("inventory_costing.view")
      .input(
        z.object({
          businessId: z.number(),
          limit: z.number().min(1).max(500).optional(),
        })
      )
      .query(async ({ ctx, input }) =>
        listWorkshopBatches({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    workshopSend: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          reason: z.string().min(1).max(500),
          occurredAt: z.date(),
          repairCostPerPiece: moneyString.optional(),
          lines: z
            .array(
              z.object({
                productId: z.number(),
                variantId: z.number().nullish(),
                quantity: z.number().int().positive(),
              })
            )
            .min(1),
          /** منع تكرار الإرسال (0052) — نفس عقد addOrder: اختياري للعملاء القدامى (بدونه غير محمي). */
          operationId: z.string().regex(OPERATION_ID_RE).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { operationId, ...requestPayload } = input;
        const businessId = await requireScopedBusinessId(ctx, input.businessId);
        const actor = await requireActor(ctx);
        const acting = await resolveActingEmployeeIdAndName(ctx);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const [biz] = await db.select({ tenantId: businessesTable.tenantId }).from(businessesTable).where(eq(businessesTable.id, businessId)).limit(1);
        return runIdempotent({
          db,
          scope: operationId && biz?.tenantId != null ? { tenantId: biz.tenantId, businessId, operation: "workshop.send", operationId } : null,
          payload: { ...requestPayload, businessId },
          actor: acting.id != null ? { type: "employee", id: acting.id } : { type: "user", id: actor.id },
          // الإعادة بنطاق النشاط: حدث التحويل لازم يكون لسه في نفس النشاط
          replay: async row => {
            const [ev] = await db.select({ id: businessEvents.id }).from(businessEvents)
              .where(and(eq(businessEvents.id, row.resultId), eq(businessEvents.businessId, businessId))).limit(1);
            if (!ev) throw new TRPCError({ code: "CONFLICT", message: `هذه العملية نُفّذت سابقًا (${row.resultReference}) ولم يعد إذنها موجودًا` });
            return { eventId: row.resultId, duplicate: false, reference: row.resultReference };
          },
          execute: record => sendToWorkshop({ ...requestPayload, businessId, actor, record: record ?? undefined }),
        });
      }),

    workshopReceive: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          sendReference: z.string().min(1).max(100),
          reason: z.string().max(500).optional().default(""),
          occurredAt: z.date(),
          repairCostPerPiece: moneyString.optional(),
          lines: z
            .array(
              z.object({
                productId: z.number(),
                variantId: z.number().nullish(),
                quantity: z.number().int().positive(),
              })
            )
            .min(1),
        })
      )
      .mutation(async ({ ctx, input }) =>
        receiveFromWorkshop({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    purchaseReceiptVoid: permissionProcedure("inventory_costing.approve")
      .input(
        z.object({
          businessId: z.number(),
          receiptId: z.number(),
          reason: z.string().min(1).max(500),
        })
      )
      .mutation(async ({ ctx, input }) =>
        voidPurchaseReceipt({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    purchaseReceiptCreate: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          warehouseId: z.number(),
          receiptType: z.string().min(1).max(50),
          supplierName: z.string().min(1).max(160),
          reference: z.string().max(100).optional(),
          receiptDate: z.date(),
          // اختياري على المسودة — الحاجز اتنقل لـapprovePurchaseReceipt، لأن المسودة
          // مابتحركش مخزون ولا فلوس.
          evidenceUrl: z.string().max(500).optional(),
          reason: z.string().optional(),
          items: z
            .array(
              z.object({
                productId: z.number(),
                variantId: z.number().optional(),
                quantity: z.number().int().positive(),
                unitCost: moneyString,
              })
            )
            .min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const hasZeroCost = input.items.some(
          item => toMinorUnits(item.unitCost) === 0n
        );
        if (hasZeroCost && (ctx.employee || !input.reason?.trim())) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message:
              "إضافة مخزون بتكلفة صفر استثناء للمالك ويتطلب سببًا موثقًا",
          });
        }
        return createPurchaseReceiptDraft({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        });
      }),

    purchaseReceiptSubmit: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          receiptId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        submitPurchaseReceipt({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    /**
     * تعديل مسودة استلام — للمسودة فقط، على inventory_costing.manage (المحاسب معاه).
     * الخدمة بترفض أي حالة غير draft، ومابتحركش مخزون ولا بتعتمد. مش inventory_costing.approve.
     */
    purchaseReceiptDraftUpdate: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          receiptId: z.number(),
          warehouseId: z.number().optional(),
          supplierName: z.string().min(1).max(160).optional(),
          reference: z.string().max(100).optional(),
          receiptDate: z.date().optional(),
          reason: z.string().optional(),
          items: z
            .array(
              z.object({
                productId: z.number(),
                variantId: z.number().optional(),
                quantity: z.number().int().positive(),
                unitCost: moneyString,
              })
            )
            .min(1),
        })
      )
      .mutation(async ({ ctx, input }) =>
        updatePurchaseReceiptDraft({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    /**
     * حذف مسودة استلام — hard delete للمسودة فقط، على inventory_costing.manage.
     * الخدمة بترفض أي حالة غير draft (اللي حرّك مخزون مايتحذفش). مش inventory_costing.approve.
     */
    purchaseReceiptDraftDelete: permissionProcedure("inventory_costing.manage")
      .input(z.object({ businessId: z.number(), receiptId: z.number() }))
      .mutation(async ({ ctx, input }) =>
        deletePurchaseReceiptDraft({
          receiptId: input.receiptId,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    // ---------- الجرد (P2-C.1: جلسة/عد/إرسال فقط — مفيش اعتماد ولا حركة مخزون) ----------
    /** إنشاء جلسة جرد لمخزن + لقطة كل الأصناف. tenant-scoped. */
    stocktakeCreate: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          warehouseId: z.number(),
          reference: z.string().max(100).optional(),
          notes: z.string().max(1000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        createStocktake({
          ...input,
          businessId: await requireScopedBusinessId(ctx, input.businessId),
          actor: await requireActor(ctx),
        })
      ),

    stocktakeList: permissionProcedure("inventory_costing.view")
      .input(z.object({ businessId: z.number(), limit: z.number().max(200).optional() }))
      .query(async ({ ctx, input }) =>
        listStocktakes({
          ...input,
          businessId: await requireScopedBusinessId(ctx, input.businessId),
        })
      ),

    stocktakeGet: permissionProcedure("inventory_costing.view")
      .input(z.object({ businessId: z.number(), stocktakeId: z.number() }))
      .query(async ({ ctx, input }) =>
        getStocktake({
          stocktakeId: input.stocktakeId,
          businessId: await requireScopedBusinessId(ctx, input.businessId),
        })
      ),

    /** إدخال العدد الفعلي لبند — للمسودة فقط (الخدمة بترفض أي حالة تانية). */
    stocktakeLineUpdate: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          stocktakeId: z.number(),
          lineId: z.number(),
          countedQuantity: z.number().int().min(0),
        })
      )
      .mutation(async ({ ctx, input }) =>
        updateStocktakeLine({
          ...input,
          businessId: await requireScopedBusinessId(ctx, input.businessId),
          actor: await requireActor(ctx),
        })
      ),

    /** إرسال الجرد للاعتماد (draft → pending_approval). */
    stocktakeSubmit: permissionProcedure("inventory_costing.manage")
      .input(z.object({ businessId: z.number(), stocktakeId: z.number() }))
      .mutation(async ({ ctx, input }) =>
        submitStocktake({
          stocktakeId: input.stocktakeId,
          businessId: await requireScopedBusinessId(ctx, input.businessId),
        })
      ),

    /**
     * اعتماد الجرد (pending_approval → approved) — بيحرّك المخزون ويسجّل الخسارة/الربح.
     * على `inventory_costing.approve` بس (المحاسب مالوش الصلاحية دي — فاصل maker-checker).
     * P0 محفوظ عبر requireScopedBusinessId(ctx). allowSelfApproval للمالك فقط.
     */
    stocktakeApprove: permissionProcedure("inventory_costing.approve")
      .input(z.object({ businessId: z.number(), stocktakeId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(ctx, input.businessId);
        await stocktakeMovementGuard(businessId, input.stocktakeId); // V3: حركة أثناء العدّ = رفض
        const result = await approveStocktake({
          stocktakeId: input.stocktakeId,
          businessId,
          actor: await requireActor(ctx),
          // نفس منطق approvePurchaseReceipt: المالك بس يقدر يعتمد جرد عمله بنفسه.
          allowSelfApproval: isOwnerRole(ctx.employee?.role),
        });
        // Ledger V3 (المرحلة 4): فروق الجرد بعد الاعتماد — فقط لشركة دفترها مفعّل؛ الفشل يُعاد للواجهة ولا يُسقط الاعتماد.
        const ledger = await ledgerHookSafely(() => postStocktakeVariance({ businessId, stocktakeId: input.stocktakeId, actor: ledgerActorOf(ctx) }));
        return { ...(result as object), ledger };
      }),

    returnInspectionSubmit: permissionProcedure("inventory_costing.manage")
      .input(
        z.object({
          businessId: z.number(),
          inspectionId: z.number(),
          receivedAt: z.date(),
          notes: z.string().optional(),
          items: z
            .array(
              z.object({
                orderItemId: z.number(),
                quantity: z.number().int().positive(),
                disposition: z.enum(["restock", "scrap", "missing"]),
                reason: z.string().optional(),
              })
            )
            .min(1),
        })
      )
      .mutation(async ({ ctx, input }) =>
        submitReturnInspection({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    returnInspectionApprove: permissionProcedure("inventory_costing.approve")
      .input(
        z.object({
          businessId: z.number(),
          inspectionId: z.number(),
          warehouseId: z.number(),
          occurredAt: z.date(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(ctx, input.businessId);
        const result = await approveReturnInspection({ ...input, businessId, actor: await requireActor(ctx) });
        // Ledger V3 (المرحلة 4): المرتجع المفحوص (إرجاع للمخزون/إعدام) — بلا تكلفة مكررة؛ الفشل يُعاد للواجهة.
        const ledger = await ledgerHookSafely(() => postReturnInspection({ businessId, inspectionId: input.inspectionId, actor: ledgerActorOf(ctx) }));
        return { ...(result as object), ledger };
      }),

    shipmentCreate: permissionProcedure("shipping_finance.manage")
      .input(
        z.object({
          businessId: z.number(),
          orderId: z.number(),
          businessShippingProviderId: z.number(),
          governorate: z.string().min(1),
          shippingType: z.string().min(1),
          paymentType: z.string().min(1),
          externalShipmentId: z.string().optional(),
          trackingNumber: z.string().optional(),
          occurredAt: z.date(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        createConfiguredShipment({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    shippingConfiguration: permissionProcedure("shipping_finance.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) =>
        listShippingConfiguration(
          await requireScopedBusinessId(ctx, input.businessId)
        )
      ),

    shippingProviderSave: permissionProcedure("shipping_finance.manage")
      .input(
        z.object({
          businessId: z.number(),
          providerCode: z.string().min(1).max(50),
          providerName: z.string().min(1).max(120),
          displayName: z.string().min(1).max(120),
          codSettlementAccountId: z.number().optional(),
          statusMapping: z.record(z.string(), z.string()),
        })
      )
      .mutation(async ({ ctx, input }) =>
        configureBusinessShippingProvider({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    shippingProviderDeactivate: permissionProcedure("shipping_finance.manage")
      .input(
        z.object({
          businessId: z.number(),
          businessShippingProviderId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        deactivateBusinessShippingProvider({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    shippingRateVersionCreate: permissionProcedure("shipping_finance.manage")
      .input(
        z.object({
          businessId: z.number(),
          businessShippingProviderId: z.number(),
          governorate: z.string().min(1),
          shippingType: z.string().min(1),
          paymentType: z.string().min(1),
          priority: z.number().int().default(0),
          effectiveFrom: z.date(),
          charges: z
            .array(
              z.object({
                chargeType: z.string().min(1),
                calculationType: z.enum(["fixed", "percentage"]),
                value: moneyString,
                percentageBase: z
                  .enum(["collected_amount", "custom_fixed_base"])
                  .optional(),
                customFixedBase: moneyString.optional(),
                billingEvent: z.string().min(1),
                tolerance: moneyString.optional(),
              })
            )
            .min(1),
        })
      )
      .mutation(async ({ ctx, input }) =>
        createShippingRateVersion({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    shipmentManualEvent: permissionProcedure("shipping_finance.manage").use(frozenWhileAccountingDisabled)
      .input(
        z.object({
          businessId: z.number(),
          shipmentId: z.number(),
          providerStatusCode: z.string().min(1),
          normalizedEvent: z.string().min(1).max(60),
          occurredAt: z.date(),
          evidenceUrl: z.string().url(),
          collectedAmount: moneyString.optional(),
          returnedItems: z
            .array(
              z.object({
                orderItemId: z.number(),
                quantity: z.number().int().positive(),
              })
            )
            .optional(),
          reason: z.string().min(5),
        })
      )
      .mutation(async ({ ctx, input }) =>
        withIdempotencyGuard(async () =>
          recordShipmentEvent({
            ...input,
            businessId: await requireScopedBusinessId(
              ctx,
              input.businessId
            ),
            payload: {
              manual: true,
              reason: input.reason,
              occurredAt: input.occurredAt.toISOString(),
              providerStatusCode: input.providerStatusCode,
              normalizedEvent: input.normalizedEvent,
              returnedItems: input.returnedItems,
            },
            isManual: true,
            actor: await requireActor(ctx),
          })
        )
      ),

    carrierSettlementImport: permissionProcedure("shipping_finance.manage")
      .input(
        z.object({
          businessId: z.number(),
          businessShippingProviderId: z.number(),
          reference: z.string().min(1).max(120),
          statementDate: z.date(),
          evidenceUrl: z.string().min(1),
          lines: z
            .array(
              z.object({
                externalReference: z.string().min(1).max(160),
                grossCollected: moneyString,
                actualCharges: moneyString,
                netAmount: moneyString,
                notes: z.string().optional(),
              })
            )
            .min(1),
        })
      )
      .mutation(async ({ ctx, input }) =>
        importCarrierSettlement({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    shippingFinanceData: permissionProcedure("shipping_finance.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) =>
        getShippingFinanceData(
          await requireScopedBusinessId(ctx, input.businessId)
        )
      ),

    carrierSettlementApprove: permissionProcedure("shipping_finance.approve").use(frozenWhileAccountingDisabled)
      .input(
        z.object({
          businessId: z.number(),
          settlementId: z.number(),
          targetAccountId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        approveCarrierSettlement({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    // تحصيل اليوم — الإدخال اليدوي البسيط. `carrierSettlementImport` فوق لسه موجود
    // لمن عنده ملف تسويات؛ ده للتاجر اللي عنده رسالة من شركة الشحن وبس.
    dailySettlementList: permissionProcedure("shipping_finance.view")
      .input(z.object({ businessId: z.number(), limit: z.number().max(200).optional() }))
      .query(async ({ ctx, input }) =>
        listDailySettlements({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    dailySettlementRecord: permissionProcedure("shipping_finance.manage").use(frozenWhileAccountingDisabled)
      .input(
        z.object({
          businessId: z.number(),
          businessShippingProviderId: z.number(),
          statementDate: z.date(),
          reference: z.string().max(120).optional(),
          ordersCount: z.number().int().min(1),
          grossCollected: positiveMoneyString,
          totalCharges: moneyString.default("0"),
          notes: z.string().max(500).optional(),
          evidenceUrl: z.string().max(500).optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        recordDailySettlement({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    /**
     * إلغاء تحصيل يومي — آمن بحركة عكسية (مش حذف)، بيتطلب سبب. الأصل بيفضل voided.
     * التعديل من الواجهة = إلغاء آمن + تسجيل جديد (بيحافظ على الأثر).
     */
    dailySettlementVoid: permissionProcedure("shipping_finance.manage").use(frozenWhileAccountingDisabled)
      .input(z.object({ businessId: z.number(), settlementId: z.number(), reason: z.string().min(1).max(500) }))
      .mutation(async ({ ctx, input }) =>
        voidDailySettlement({
          settlementId: input.settlementId,
          reason: input.reason,
          businessId: await requireScopedBusinessId(ctx, input.businessId),
          actor: await requireActor(ctx),
        })
      ),

    // مصروف بخطوة واحدة: تاريخ ومبلغ وتصنيف ووصف. المسار الكامل (فترة خدمة، مركز
    // تكلفة، اعتماد منفصل) لسه موجود لمن يحتاجه.
    expenseRecordSimple: permissionProcedure("accounting.manage")
      .input(
        z.object({
          businessId: z.number(),
          categoryId: z.number().optional(),
          amount: positiveMoneyString,
          expenseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          description: z.string().min(1).max(500),
          attachmentUrl: z.string().max(500).optional(),
          payNow: z.boolean(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        recordSimpleExpense({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    closingList: permissionProcedure("closing.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) => {
        const rows = await listClosings(await requireScopedBusinessId(ctx, input.businessId));
        // الربح لمن يملك reports.view_profit فقط — الحجب من السيرفر
        return (await canViewProfit(ctx)) ? rows : rows.map(redactClosingRow);
      }),

    closingDetail: permissionProcedure("closing.view")
      .input(z.object({ businessId: z.number(), closingId: z.number() }))
      .query(async ({ ctx, input }) => {
        const detail = await getClosingDetail(await requireScopedBusinessId(ctx, input.businessId), input.closingId);
        if (!detail || (await canViewProfit(ctx))) return detail;
        return { ...redactClosingRow(detail), totals: withoutProfitKeys(detail.totals), profitHidden: true as const };
      }),

    closingCreate: permissionProcedure("closing.create")
      .input(
        z.object({
          businessId: z.number(),
          periodType: z.enum(["daily", "weekly", "monthly", "custom"]),
          periodTo: z.date(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        createClosingDraft({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    closingSubmit: permissionProcedure("closing.submit")
      .input(z.object({ businessId: z.number(), closingId: z.number() }))
      .mutation(async ({ ctx, input }) =>
        submitClosing({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    closingApprove: permissionProcedure("closing.approve")
      .input(z.object({ businessId: z.number(), closingId: z.number() }))
      .mutation(async ({ ctx, input }) =>
        approveClosing({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    closingAdjust: permissionProcedure("closing.adjust")
      .input(
        z.object({
          businessId: z.number(),
          closingId: z.number(),
          adjustmentType: z.string().min(1).max(60),
          amount: moneyString,
          reason: z.string().min(5),
          evidenceUrl: z.string().url(),
          originalOccurredAt: z.date().optional(),
          originalClosingId: z.number().optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        addClosingAdjustment({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    closingLock: ownerProcedure.use(frozenWhileAccountingDisabled)
      .input(z.object({ businessId: z.number(), closingId: z.number() }))
      .mutation(async ({ ctx, input }) =>
        lockClosing({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),
  }),
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),

    /**
     * صلاحيات الجلسة الحالية — نفس المصدر اللي السيرفر بيحكم بيه.
     *
     * الواجهة لازم تقرا من هنا مش تعيد استنتاج الأدوار بنفسها: لو الشاشة بتحسب
     * «ده مدير يعني يقدر» والسيرفر بيحسب حاجة تانية، الاتنين بيفرقوا في يوم من الأيام
     * والمستخدم بيشوف زرار بيرجّع «غير مصرح».
     *
     * `publicProcedure` عشان الجلسة الغريبة تاخد قايمة فاضية بدل ما الشاشة تكسر —
     * والقايمة الفاضية معناها «مايقدرش يعمل حاجة»، وده الافتراض الصح.
     */
    myPermissions: publicProcedure.query(async ({ ctx }) => {
      const role = ctx.employee?.role;
      const ownerOnlyLedger = (p: string) => (LEDGER_OWNER_ONLY_PERMISSIONS as readonly string[]).includes(p);
      if (ctx.user?.role === "admin") {
        // جلسة مالك بلا صف موظف → كل شيء. مع صف موظف (super_admin/admin/manager): الصلاحيات
        // الفعلية للدور + تجاوزات الشركة — فالأدمن لا يرى reopen/activate (للمالك وحده)، والمدير
        // (غير مالي) يرى ما يُمنح له من دفتر V3 فقط دون باقي المالي.
        if (!role || ctx.tenantId == null) return ALL_PERMISSIONS.filter(p => !isLockedOwnerPermission(p));
        const effective = await Promise.all(ALL_PERMISSIONS.map(async p => (await hasTenantPermission(ctx.tenantId!, role, p)) ? p : null));
        return effective.filter((p): p is (typeof ALL_PERMISSIONS)[number] => p !== null)
          .filter(p => !ownerOnlyLedger(p) || isOwnerRole(role))
          .filter(p => role !== "manager" || !isFinancialPermission(p) || p.startsWith("ledger."));
      }
      if (!role || ctx.tenantId == null) return [];
      const granted = await Promise.all(
        ALL_PERMISSIONS.map(async permission =>
          (await hasTenantPermission(ctx.tenantId!, role, permission))
            ? permission
            : null
        )
      );
      return granted.filter((p): p is (typeof ALL_PERMISSIONS)[number] => p !== null).filter(p => !ownerOnlyLedger(p) || isOwnerRole(role));
    }),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      // Also clear employee token if present (for manager employees using admin dashboard)
      ctx.res.clearCookie("employee_token", { path: "/", maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ==================== SEED ====================
  seed: router({
    init: protectedProcedure.mutation(async () => {
      await seedInitialData();
      return { success: true };
    }),
  }),

  // ==================== EMPLOYEES ====================
  employees: router({
    // قراءة مقصورة على النطاق (ctx.tenantId) — متاحة لأي جلسة مصرّح لها عشان المحاسب
    // (موظف، user=null) يقرا الموظفين في تابات المرتبات من غير UNAUTHORIZED. الكتابة تفضل admin.
    list: authenticatedProcedure
      .input(
        z
          .object({
            businessId: z.number().optional(),
            search: z.string().optional(),
            role: z.enum(EMPLOYEE_ROLE_VALUES).optional(),
            isActive: z.boolean().optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        // عزل fail-closed: أنشطة التينانت من الـsession (undefined/آخر = أنشطة المستخدم فقط).
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        return searchEmployees({ ...(input ?? {}), businessId: undefined, businessIds });
      }),
    // هل يمكن تعيين «مدير الحسابات» الآن؟ للمالك فقط، وبشرط 0045 في القاعدة — الواجهة تخفي الخيار غير ذلك.
    roleSupport: adminProcedure.query(async ({ ctx }) => ({
      accountsManager: isOwnerRole(ctx.employee?.role) && (await isAccountsManagerRoleSupported()),
    })),
    activeList: protectedProcedure
      .input(
        z
          .object({
            businessId: z.number().optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        return getActiveEmployees(undefined, businessIds);
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        // كان بيرجّع أي موظف في النظام بالـid — بيانات موظف شركة تانية بالاسم والتليفون.
        return assertEmployeeInScope(
          ctx,
          await getEmployeeById(input.id)
        );
      }),
    create: adminProcedure
      .input(
        z.object({
          name: z.string().min(2),
          phone: z.string().optional(),
          email: z.string().email().optional(),
          role: z.enum(EMPLOYEE_ROLE_VALUES).default("agent"),
          businessId: z.number().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await assertMayAssignOwnerRole(ctx, input.role, null);
        await assertMayManageAccountsManager(ctx, input.role, null);
        // النشاط لازم يتحدّد — مايرجعش null (منع تكرار businessId=NULL).
        const businessId = await resolveEmployeeBusinessId(
          ctx,
          input.businessId
        );
        await createEmployee({ ...input, businessId, tenantId: ctx.tenantId });
        return { success: true };
      }),
    update: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().min(2).optional(),
          phone: z.string().optional(),
          email: z.string().email().optional(),
          role: z.enum(EMPLOYEE_ROLE_VALUES).optional(),
          isActive: z.boolean().optional(),
          businessId: z.number().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { id, ...data } = input;
        // الحارس الأول قبل أي حاجة: الموظف ده أصلاً بتاعي؟
        //
        // من غيره، أدمن شركة أ كان يقدر يعطّل موظفين شركة ب، أو يغيّر أدوارهم، أو
        // **ينقلهم لشركته** — الـ`businessId` جاي من العميل.
        const target = await assertEmployeeInScope(
          ctx,
          await getEmployeeById(id)
        );

        // والنشاط الجديد كمان لازم يكون في نطاقي — النقل بيمشي في الاتجاهين.
        if (data.businessId !== undefined) {
          data.businessId = await scopeBusinessId(ctx, data.businessId);
        }

        await assertMayAssignOwnerRole(ctx, data.role, target.role);
        await assertMayManageAccountsManager(ctx, data.role, target.role);

        const revokesAdminAccess =
          data.isActive === false ||
          (data.role !== undefined && !isAdminTierRole(data.role));

        if (
          revokesAdminAccess &&
          isAdminTierRole(target.role) &&
          target.isActive
        ) {
          const actingEmployeeId = await resolveActingEmployeeId(ctx);
          if (actingEmployeeId === id) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "لا يمكنك إلغاء صلاحيتك الإدارية عن حسابك الخاص",
            });
          }
          const remaining = await countActiveAdminTierEmployees(id);
          if (remaining === 0) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message:
                "لا يمكن ذلك — يجب أن يبقى مسؤول إداري واحد نشط على الأقل",
            });
          }
        }

        await updateEmployee(id, data);
        return { success: true };
      }),
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "employee", input.id);
        const target = await getEmployeeById(input.id);
        if (!target)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "الموظف غير موجود",
          });
        await assertMayManageAccountsManager(ctx, undefined, target.role);

        if (isAdminTierRole(target.role) && target.isActive) {
          const actingEmployeeId = await resolveActingEmployeeId(ctx);
          if (actingEmployeeId === input.id) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "لا يمكنك حذف حسابك الخاص",
            });
          }
          const remaining = await countActiveAdminTierEmployees(input.id);
          if (remaining === 0) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "لا يمكن حذف آخر مسؤول إداري نشط",
            });
          }
        }

        await deleteEmployee(input.id);
        return { success: true };
      }),
    setCredentials: adminProcedure
      .input(
        z.object({
          id: z.number(),
          username: z.string().min(3).max(50),
          password: z.string().min(6),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "employee", input.id);
        await assertMayManageAccountsManager(ctx, undefined, (await getEmployeeById(input.id))?.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        // Check username uniqueness
        const existing = await db
          .select()
          .from(employees)
          .where(eq(employees.username, input.username))
          .limit(1);
        if (existing.length > 0 && existing[0].id !== input.id) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "اسم المستخدم مستخدم بالفعل",
          });
        }
        const passwordHash = await bcrypt.hash(input.password, 10);
        await db
          .update(employees)
          .set({ username: input.username, passwordHash })
          .where(eq(employees.id, input.id));
        return { success: true };
      }),
    changePassword: adminProcedure
      .input(
        z.object({
          id: z.number(),
          newPassword: z.string().min(6),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // كتابة `passwordHash` على موظف شركة تانية = دخول بهويته. الحارس هنا أهم
        // حارس في الملف كله.
        await requireOwned(ctx, "employee", input.id);
        await assertMayManageAccountsManager(ctx, undefined, (await getEmployeeById(input.id))?.role);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const passwordHash = await bcrypt.hash(input.newPassword, 10);
        await db
          .update(employees)
          .set({ passwordHash })
          .where(eq(employees.id, input.id));
        return { success: true };
      }),

    // جرد الموظف: عدد الأوردرات الموزعة عليه حسب الحالة
    inventory: adminProcedure
      .input(
        z.object({
          employeeId: z.number(),
        })
      )
      .query(async ({ ctx, input }) => {
        await requireOwned(ctx, "employee", input.employeeId);
        return getEmployeeInventory(input.employeeId);
      }),

    // جرد كل الموظفين دفعة واحدة
    allInventory: adminProcedure.query(async ({ ctx }) => {
      // fail-closed: نطاق الجلسة فقط. غياب النطاق/بلا membership → [-1] → صفر موظفين،
      // مش موظفي كل التينانتات (الاستدعاء العاري بلا نطاق كان بيسرّب أسماء تينانتات أخرى).
      const businessIds = await scopeBusinessIds(ctx, {});
      const emps = await getActiveEmployees(undefined, businessIds);
      const results = await Promise.all(
        emps
          .filter(e => e.role === "agent")
          .map(async emp => {
            const inv = await getEmployeeInventory(emp.id);
            return {
              employeeId: emp.id,
              employeeName: emp.name,
              ...inv,
            };
          })
      );
      return results;
    }),

    // استرداد أوردرات موظف (إرجاعها بدون توزيع)
    reclaimOrders: adminProcedure
      .input(
        z.object({
          employeeId: z.number(),
          statuses: z.array(z.string()).optional(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "employee", input.employeeId);
        const result = await reclaimEmployeeOrders(
          input.employeeId,
          input.statuses,
          await webEventCtx(ctx, "bulk", input.operationId)
        );
        return result;
      }),
  }),

  // ==================== PRODUCTS ====================
  products: router({
    // قراءة مقصورة على النطاق — متاحة للمحاسب (dropdown الأصناف في استلام البضاعة).
    list: authenticatedProcedure
      .input(
        z
          .object({
            businessId: z.number().optional(),
            businessIds: z.array(z.number()).optional(),
            includeInactive: z.boolean().optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getAllProducts(undefined, businessIds, {
          includeInactive: input?.includeInactive,
        });
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireOwned(ctx, "product", input.id);
        return getProductById(input.id);
      }),
    create: adminProcedure
      .input(
        z.object({
          name: z.string().min(2),
          description: z.string().optional(),
          // sku/price are optional: a parent product with variants (e.g. "أسورة نحاس") carries
          // neither — those live on its variants. Standalone products without variants still set both.
          sku: z.string().min(2).optional(),
          price: z.string().optional(),
          currentStock: z.number().default(0),
          minStockLevel: z.number().default(15),
          businessId: z.number().optional(),
          categoryId: z.number().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const scopedBusinessIds = await scopeBusinessIds(ctx, {
          businessId: input.businessId,
        });
        if (scopedBusinessIds?.length !== 1)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "اختار Business واحد عند إنشاء المنتج",
          });
        const businessId = scopedBusinessIds[0];
        if (input.currentStock !== 0)
          await assertLegacyInventoryMutationAllowed(businessId);
        if (input.sku && (await isSkuTaken(input.sku))) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `رمز المنتج (SKU) "${input.sku}" مستخدم بالفعل`,
          });
        }
        const id = await createProduct({ ...input, businessId });
        return { success: true, id };
      }),
    // إنشاء منتج متعدد الخيارات: الأب + كل تركيبات Color×Size في transaction واحدة.
    // الكل-أو-لا-شيء؛ العزل بـbusinessId؛ منع تكرار اللون×المقاس؛ SKU فريد داخل النشاط.
    createWithVariants: adminProcedure
      .input(
        z.object({
          name: z.string().min(2),
          description: z.string().optional(),
          businessId: z.number().optional(),
          categoryId: z.number().optional(),
          minStockLevel: z.number().min(0).default(15),
          variants: z
            .array(
              z.object({
                color: z.string().optional(),
                size: z.string().optional(),
                name: z.string().optional(),
                // الرمز اختياري: لو اتساب فاضي السيرفر بيولّد رمزًا داخليًا فريدًا (AUTO-…).
                sku: z.string().optional(),
                price: z.number().min(0).optional(),
                costPrice: z.number().min(0).optional(),
                currentStock: z.number().min(0).default(0),
                minStockLevel: z.number().min(0).default(5),
              })
            )
            .min(1, "لازم تركيبة واحدة على الأقل"),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // 1) العزل: نشاط واحد محدّد تابع للجلسة (نفس حارس products.create).
        const scopedBusinessIds = await scopeBusinessIds(ctx, {
          businessId: input.businessId,
        });
        if (scopedBusinessIds?.length !== 1)
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "اختار Business واحد عند إنشاء المنتج",
          });
        const businessId = scopedBusinessIds[0];

        // 2) كل تركيبة لازم يكون ليها بُعد واحد على الأقل (لون أو مقاس أو اسم).
        for (const v of input.variants) {
          if (!v.color?.trim() && !v.size?.trim() && !v.name?.trim())
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "كل تركيبة لازم يكون ليها لون أو مقاس على الأقل",
            });
        }

        // 3) منع تكرار نفس التركيبة داخل المنتج (قبل أي كتابة). الهوية = النوع+اللون+المقاس،
        // عشان منتج تركيباته بالنوع فقط (نوع الحفر) مايتحسبش كله تركيبة واحدة مكررة.
        const comboSeen = new Set<string>();
        for (const v of input.variants) {
          const key = variantIdentityKey(v);
          if (comboSeen.has(key))
            throw new TRPCError({
              code: "CONFLICT",
              message: `تركيبة مكررة: ${variantIdentityLabel(v)}`,
            });
          comboSeen.add(key);
        }

        // 4) تفرّد الـSKU: داخل الدفعة، وداخل النشاط (منتجات + تركيبات النشاط).
        // الرمز اللي التاجر كتبه بيتفحص كامل؛ اللي ساب مكانه فاضي بيتولّد له رمز
        // داخلي فريد تحت (AUTO-…) بدل ما إنشاء المنتج كله يتوقف.
        const typed = input.variants
          .map(v => v.sku?.trim())
          .filter((s): s is string => !!s);
        const skuSeen = new Set<string>();
        for (const s of typed) {
          const k = s.toLowerCase();
          if (skuSeen.has(k))
            throw new TRPCError({
              code: "CONFLICT",
              message: `رمز المنتج (SKU) "${s}" مكرر داخل التركيبات`,
            });
          skuSeen.add(k);
        }
        const takenInBusiness = await findTakenSkusInBusiness(businessId, typed);
        for (const s of typed) {
          if (takenInBusiness.has(s.toLowerCase()))
            throw new TRPCError({
              code: "CONFLICT",
              message: `رمز المنتج (SKU) "${s}" مستخدم بالفعل في هذا النشاط`,
            });
        }
        // الفاضي بياخد رمزًا مولَّدًا ومتحقَّق من تفرّده في القاعدة.
        const autoCreate = await generateVariantSkus(
          businessId,
          input.variants.filter(v => !v.sku?.trim()).length,
          skuSeen
        );
        let autoIdxCreate = 0;
        const withSkus = input.variants.map(v => ({
          ...v,
          sku: v.sku?.trim() || autoCreate[autoIdxCreate++],
        }));

        // 5) مخزون افتتاحي: مسموح فقط قبل Go-Live المحاسبي (نفس حارس products.create).
        if (input.variants.some(v => v.currentStock !== 0))
          await assertLegacyInventoryMutationAllowed(businessId);

        // 6) إنشاء الأب + كل التركيبات في transaction واحدة (الكل-أو-لا-شيء).
        const result = await createProductWithVariants(
          businessId,
          {
            name: input.name,
            description: input.description,
            categoryId: input.categoryId,
            minStockLevel: input.minStockLevel,
          },
          withSkus.map(v => ({
            color: v.color,
            size: v.size,
            name: v.name,
            sku: v.sku,
            price: v.price !== undefined ? String(v.price) : undefined,
            costPrice:
              v.costPrice !== undefined ? String(v.costPrice) : undefined,
            currentStock: v.currentStock,
            minStockLevel: v.minStockLevel,
          }))
        );
        return { success: true, ...result };
      }),
    update: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          description: z.string().optional(),
          sku: z.string().min(2).optional(),
          price: z.string().optional(),
          currentStock: z.number().optional(),
          minStockLevel: z.number().optional(),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { id, ...data } = input;
        const product = await getProductById(id);
        if (!product)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "المنتج غير موجود",
          });
        await requireScopedBusinessId(ctx, product.businessId);
        // منتج متعدد الخيارات: المخزون بيعيش على التركيبات، مش على الأب. منع تعديل مخزون
        // الأب مباشرة (كان بيفسد التاريخ لو حوّلناه لبسيط). الكمية تتعدّل من حركة الـvariant.
        if (data.currentStock !== undefined) {
          const variants = await getVariantsByProduct(id, {
            includeInactive: true,
          });
          if (variants.length > 0)
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "المنتج له تركيبات (ألوان/مقاسات) — عدّل المخزون من التركيبة نفسها، مش من المنتج الأب",
            });
          await assertLegacyInventoryMutationAllowed(product.businessId);
        }
        if (
          data.sku &&
          (await isSkuTaken(data.sku, { excludeProductId: id }))
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `رمز المنتج (SKU) "${data.sku}" مستخدم بالفعل`,
          });
        }
        await updateProduct(id, data);
        return { success: true };
      }),
    lowStock: protectedProcedure
      .input(
        z
          .object({
            businessId: z.number().optional(),
            businessIds: z.array(z.number()).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getLowStockProducts(undefined, businessIds);
      }),
    addMovement: adminProcedure
      .input(
        z.object({
          productId: z.number(),
          type: z.enum(["in", "out"]),
          quantity: z.number().min(1),
          reason: z.string().optional(),
          notes: z.string().optional(),
          orderId: z.number().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const product = await getProductById(input.productId);
        if (!product)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "المنتج غير موجود",
          });
        await requireScopedBusinessId(ctx, product.businessId);
        await assertLegacyInventoryMutationAllowed(product.businessId);
        const actingEmpId = await resolveActingEmployeeId(ctx);
        await addInventoryMovement({
          ...input,
          businessId: product.businessId,
          performedBy: actingEmpId,
        });
        return { success: true };
      }),
    movements: protectedProcedure
      .input(
        z.object({
          productId: z.number().optional(),
          variantId: z.number().optional(),
          limit: z.number().default(50),
          businessId: z.number().optional(),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getInventoryMovements(
          input.productId,
          input.limit,
          undefined,
          businessIds,
          input.variantId
        );
      }),
  }),

  // ==================== ORDERS ====================
  orders: router({
    list: protectedProcedure
      .input(
        z.object({
          status: z.string().optional(),
          statuses: z.array(z.string()).optional(), // فلتر بحالات متعددة
          source: z.string().optional(),
          governorate: z.string().optional(),
          governorates: z.array(z.string()).optional(),
          assignedEmployeeId: z.number().optional(),
          unassignedOnly: z.boolean().optional(),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          printedDateFrom: z.date().optional(),
          printedDateTo: z.date().optional(),
          adName: z.string().optional(),
          search: z.string().optional(),
          page: z.number().default(1),
          limit: z.number().default(50),
          businessId: z.number().optional(),
          businessIds: z.array(z.number()).optional(),
          websiteId: z.number().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        // Agents can only see their own orders
        if (ctx.user.role !== "admin") {
          const emps = await getAllEmployees();
          const emp = emps.find(e => e.userId === ctx.user.id);
          if (emp) {
            return getOrders({
              ...input,
              businessId: undefined,
              businessIds,
              assignedEmployeeId: emp.id,
            });
          }
        }
        return getOrders({ ...input, businessId: undefined, businessIds });
      }),

    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        const order = await getOrderById(input.id);
        if (!order) return order;
        await requireScopedBusinessId(ctx, order.businessId);
        const items = await getOrderItems(input.id);
        // الشاشة لازم تعرف إن اللي بتوريه اتغيّر بعد ما بوسطة أخدت نسختها — من غير
        // كده الأوردر بيبان مظبوط جوّه، وبوسطة عندها حاجة تانية، ومحدش يعرف.
        const contentChangedAfterShipment =
          await orderContentChangedAfterShipmentCreation(input.id);
        return { ...order, items, contentChangedAfterShipment };
      }),

    /** Header stat cards on the Orders page — same business-group scope as `orders.list`. */
    statusCounts: protectedProcedure
      .input(
        z.object({
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getOrderStatusCounts(businessIds);
      }),

    /** Orders that ever touched Bosta (shipment created, or send attempt failed), grouped
     *  by shipping-pipeline stage. Uses only existing bosta* columns — no schema change. */
    bostaOrders: protectedProcedure
      .input(
        z.object({
          category: z
            .enum([
              "sent_today",
              "awaiting_update",
              "in_transit",
              "delivered",
              "returned",
              "send_failed",
            ])
            .optional(),
          governorate: z.string().optional(),
          search: z.string().optional(),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          websiteId: z.number().optional(),
          page: z.number().default(1),
          limit: z.number().default(50),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getBostaOrders({ ...input, businessIds });
      }),

    bostaOrdersSummary: protectedProcedure
      .input(
        z
          .object({
            businessIds: z.array(z.number()).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getBostaOrdersSummary(businessIds);
      }),

    // جلب أسماء البيدج المميزة (لفلتر البيدج)
    distinctAdNames: protectedProcedure.query(async () => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db
        .selectDistinct({ adName: ordersTable.adName })
        .from(ordersTable)
        .where(
          and(
            sql`${ordersTable.adName} IS NOT NULL`,
            sql`${ordersTable.adName} != ''`
          )
        );
      return rows.map(r => r.adName).filter(Boolean) as string[];
    }),

    getByIds: protectedProcedure
      .input(
        z.object({
          ids: z.array(z.number()),
        })
      )
      .query(async ({ ctx, input }) => {
        // سياسة القراءة بالمعرّفات: نرجّع المملوك بس (زي فلاتر businessIds التانية) —
        // مش نرفض الطلب كله. كده مفيش تسريب حتى عن **وجود** معرّف تابع لشركة تانية.
        const allowed = await sessionBusinessIds(ctx);
        const rows = await getOrdersByIds(input.ids);
        if (allowed == null) return rows;
        const allowedSet = new Set(allowed);
        return rows.filter((o: any) => allowedSet.has(o.businessId));
      }),

    create: protectedProcedure
      .input(
        z.object({
          customerName: z.string().min(2),
          customerPhone: z.string().min(10),
          customerAddress: z.string().min(5),
          governorate: z.string().min(2),
          productId: z.number(),
          productName: z.string(),
          variantId: z.number().optional(),
          quantity: z.number().min(1).default(1),
          totalAmount: z.string(),
          source: z.string().min(1),
          notes: z.string().optional(),
          businessId: z.number(),
          // Optional here on purpose. createOrderInTransaction is the one place that knows
          // whether a business is past its accounting Go-Live, and it already refuses the
          // order — by name — when these are missing and required. Requiring them at the
          // edge too meant a business that has not configured a shipping company yet could
          // not record an order at all, which is not a rule anyone asked for.
          projectedShippingProviderId: z.number().optional(),
          projectedShippingType: z.string().min(1).optional(),
          projectedPaymentType: z.string().min(1).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const actingEmpId = await resolveActingEmployeeId(ctx);
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        // رقم الأوردر «MAX+1» غير ذرّي: إنشاءان متزامنان قد يحصلان على نفس الرقم فيرفض القيد
        // الفريد أحدهما. بدل إظهار خطأ خام للمستخدم نعيد التوليد والمحاولة مرات محدودة.
        let orderNumber = "";
        let orderId: number | undefined;
        for (let attempt = 1; ; attempt++) {
          orderNumber = await generateOrderNumber();
          try {
            orderId = await createOrderWithItems(
              {
                ...input,
                businessId,
                orderNumber,
                lastUpdatedBy: actingEmpId,
              },
              [
                {
                  productId: input.productId,
                  productName: input.productName,
                  variantId: input.variantId,
                  quantity: input.quantity,
                  unitPrice: Number(input.totalAmount) / input.quantity,
                },
              ]
            );
            break;
          } catch (err) {
            if (!isOrderNumberCollision(err) || attempt >= 3) throw err;
            await new Promise(r => setTimeout(r, 10 * attempt + Math.random() * 20));
          }
        }
        if (!orderId)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "تعذر إنشاء الأوردر",
          });
        return { success: true, orderNumber };
      }),

    update: protectedProcedure
      .input(
        z.object({
          id: z.number(),
          customerName: z.string().optional(),
          customerPhone: z.string().optional(),
          customerAddress: z.string().optional(),
          governorate: z.string().optional(),
          notes: z.string().optional(),
          status: z
            .enum([
              "new",
              "confirmed",
              "postponed",
              "cancelled",
              "preparing",
              "shipped",
              "delivered",
              "no_answer",
            ])
            .optional(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { id, operationId, ...data } = input;
        await requireOwned(ctx, "order", id);
        const actingEmpId = await resolveActingEmployeeId(ctx);
        // «مؤكد» و«تم التسليم» لشحنة بوسطة مرفوضان هنا بالسياسة (حارس updateOrder).
        const eventCtx = data.status ? await webEventCtx(ctx, "admin_ui", operationId) : undefined;
        await withStatusGuard(() => updateOrder(id, { ...data, lastUpdatedBy: actingEmpId }, eventCtx));
        return { success: true };
      }),

    assign: adminProcedure
      .input(
        z.object({
          orderId: z.number(),
          employeeId: z.number(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        const actingEmpId = await resolveActingEmployeeId(ctx);
        await assignOrderToEmployee(
          input.orderId,
          input.employeeId,
          actingEmpId ?? 0,
          await webEventCtx(ctx, "admin_ui", input.operationId)
        );
        return { success: true };
      }),

    bulkAssign: adminProcedure
      .input(
        z.object({
          orderIds: z.array(z.number()),
          employeeId: z.number(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        // كل أوردر في القايمة، مش أول واحد بس.
        await requireAllOwned(ctx, "order", input.orderIds);
        await requireOwned(ctx, "employee", input.employeeId);
        const actingEmpId = await resolveActingEmployeeId(ctx);
        await bulkAssignOrders(
          input.orderIds,
          input.employeeId,
          actingEmpId ?? 0,
          await webEventCtx(ctx, "bulk", input.operationId)
        );
        await addActivityLog({
          action: "assign_orders",
          entityType: "order",
          description: `توزيع ${input.orderIds.length} أوردر على موظف #${input.employeeId}`,
          metadata: { orderIds: input.orderIds, employeeId: input.employeeId },
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? "مدير",
          performedByRole: ctx.user.role ?? "admin",
        });
        return { success: true };
      }),

    confirm: protectedProcedure
      .input(
        z.object({
          orderId: z.number(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        const { id: actingEmpId, name: actingEmpName } =
          await resolveActingEmployeeIdAndName(ctx);
        await confirmOrderOrReject(input.orderId, actingEmpId ?? 0, actingEmpName, await webEventCtx(ctx, "admin_ui", input.operationId));
        await addActivityLog({
          action: "confirm_order",
          entityType: "order",
          entityId: input.orderId,
          description: `تأكيد أوردر #${input.orderId}`,
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? "مدير",
          performedByRole: ctx.user.role ?? "admin",
        });
        // ❌ الإرسال التلقائي لـ Bosta معطل - الإرسال يدوي فقط من صفحة الأوردرات
        return { success: true };
      }),

    /** Orders whose external items could not be matched to a product/variant. */
    needingReview: adminProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(500).default(100),
          })
          .optional()
      )
      .query(async ({ input }) => {
        return getOrdersNeedingReview(input?.limit ?? 100);
      }),
    /** Resolves a review-flagged order by assigning the correct product/variant. */
    resolveReview: adminProcedure
      .input(
        z.object({
          orderId: z.number(),
          productId: z.number(),
          variantId: z.number().nullable().optional(),
          productName: z.string().min(1).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        const order = await getOrderById(input.orderId);
        if (!order)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "الأوردر غير موجود",
          });
        // بيكتب الهيدر والبنود مع بعض في transaction واحدة — البنود هي المصدر اللي
        // بوسطة بتقرا منه، فتعيين المنتج في الهيدر لوحده كان بيسيبها على الاسم الخام.
        await resolveOrderReviewProduct(input.orderId, {
          productId: input.productId,
          variantId: input.variantId ?? null,
          productName: input.productName,
        });
        await addActivityLog({
          action: "resolve_order_review",
          entityType: "order",
          entityId: input.orderId,
          description: `تعيين منتج يدويًا لأوردر #${order.orderNumber}`,
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? "مدير",
          performedByRole: ctx.user.role ?? "admin",
        });
        return { success: true };
      }),

    // إرسال يدوي / إعادة محاولة إرسال لـ Bosta
    /** معاينة صور الشحنة التي ستُرسل لبوسطة (المصدر: product / brand_default) أو سبب المنع — قبل الإرسال. */
    bostaShipmentPreview: adminProcedure
      .input(z.object({ orderId: z.number(), allowToOpenPackage: z.boolean().optional() }))
      .query(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        const [order] = await getOrdersByIds([input.orderId]);
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "الأوردر غير موجود" });
        const status = await getCarrierAccountStatus(order.businessId);
        const allowToOpenPackage = input.allowToOpenPackage ?? status.allowOpenPackageDefault ?? true;
        return resolveShipmentImagesForOrder(order, allowToOpenPackage);
      }),

    sendToBosta: adminProcedure
      .input(
        z.object({
          orderId: z.number(),
          /** غير مُمرَّر = إعداد حساب الشحن (allowOpenPackageDefault) — نفس ما تعرضه المعاينة. */
          allowToOpenPackage: z.boolean().optional(),
          /** ديبوزيت مطلوب من العميل (escrowInfo) — اختياري، ≤ تحصيل الأوردر. */
          depositAmount: z.number().min(0).max(30000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        // اتصال نشاط **الأوردر نفسه** — مش مربوط → رسالة واضحة، بلا أي fallback.
        // (أوردر غير موجود بيتعامل معاه createBostaShipment برسالته — البوابة للموجود بس.)
        const [gateOrder] = await getOrdersByIds([input.orderId]);
        if (gateOrder && !(await isBostaEnabledForBusiness(gateOrder.businessId)))
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: NOT_CONNECTED_MESSAGE });
        const result = await createBostaShipment(input.orderId, { allowToOpenPackage: input.allowToOpenPackage, depositAmount: input.depositAmount });
        return result;
      }),

    bulkSendToBosta: adminProcedure
      .input(
        z.object({
          orderIds: z.array(z.number()),
          /** غير مُمرَّر = إعداد حساب الشحن (allowOpenPackageDefault). */
          allowToOpenPackage: z.boolean().optional(),
          /** ديبوزيت مطلوب من العميل (escrowInfo) — اختياري، ≤ تحصيل الأوردر. */
          depositAmount: z.number().min(0).max(30000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // كل أوردر في القايمة لازم يكون في النطاق — الرفض قبل أي شحنة تتعمل.
        await requireAllOwned(ctx, "order", input.orderIds);
        // بعد النطاق: كل أوردر بيتفحص اتصال نشاطه هو جوه createBostaShipment؛ هنا نرفض
        // بدري لو ولا نشاط من الأنشطة المختارة مربوط.
        const gateRows = await getOrdersByIds(input.orderIds);
        const gateBiz = Array.from(new Set(gateRows.map(r => r.businessId)));
        const gateOk = (await Promise.all(gateBiz.map(b => isBostaEnabledForBusiness(b)))).some(Boolean);
        if (gateBiz.length > 0 && !gateOk)
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: NOT_CONNECTED_MESSAGE });
        const results = await Promise.allSettled(
          input.orderIds.map(id =>
            createBostaShipment(id, { allowToOpenPackage: input.allowToOpenPackage, depositAmount: input.depositAmount })
          )
        );
        let success = 0,
          failed = 0;
        const errors: { orderId: number; error: string }[] = [];
        results.forEach((r, i) => {
          if (r.status === "fulfilled" && r.value.success) {
            success++;
          } else {
            failed++;
            const err =
              r.status === "fulfilled"
                ? r.value.error
                : String((r as PromiseRejectedResult).reason);
            errors.push({
              orderId: input.orderIds[i],
              error: err ?? "خطأ غير معروف",
            });
          }
        });
        return { success, failed, errors };
      }),

    postpone: protectedProcedure
      .input(
        z.object({
          orderId: z.number(),
          postponedTo: z.date(),
          notes: z.string().optional(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        const actingEmpId = await resolveActingEmployeeId(ctx);
        await postponeOrder(
          input.orderId,
          input.postponedTo,
          input.notes,
          actingEmpId ?? 0,
          await webEventCtx(ctx, "admin_ui", input.operationId)
        );
        return { success: true };
      }),

    cancel: protectedProcedure
      .input(
        z.object({
          orderId: z.number(),
          cancelReason: z.string().min(1).max(80),
          notes: z.string().optional(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        const actingEmpId = await resolveActingEmployeeId(ctx);
        await cancelOrder(
          input.orderId,
          input.cancelReason,
          input.notes,
          actingEmpId ?? 0,
          await webEventCtx(ctx, "admin_ui", input.operationId)
        );
        await addActivityLog({
          action: "cancel_order",
          entityType: "order",
          entityId: input.orderId,
          description: `إلغاء أوردر #${input.orderId} - السبب: ${input.cancelReason}`,
          metadata: { cancelReason: input.cancelReason, notes: input.notes },
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? "مدير",
          performedByRole: ctx.user.role ?? "admin",
        });
        return { success: true };
      }),

    markNoAnswer: protectedProcedure
      .input(
        z.object({
          orderId: z.number(),
          // كام مرة اتصل موظف التأكيد بالعميل قبل ما يعلّم الأوردر "لم يرد" — استبيان مصغّر بيتسجل
          // وقت كل مرة الحالة دي بتتحدد، مش عدّاد تراكمي.
          callAttempts: z.number().int().min(1).max(20).optional(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        const actingEmpId = await resolveActingEmployeeId(ctx);
        await updateOrder(input.orderId, {
          status: "no_answer",
          lastUpdatedBy: actingEmpId,
          noAnswerCallAttempts: input.callAttempts,
        }, await webEventCtx(ctx, "admin_ui", input.operationId));
        return { success: true };
      }),

    // تعديل بيانات الأوردر بالكامل مع سجل التعديلات (للمدير)
    editOrder: protectedProcedure
      .input(
        z.object({
          orderId: z.number(),
          customerName: z.string().optional(),
          customerPhone: z.string().optional(),
          customerPhone2: z.string().optional(),
          customerAddress: z.string().optional(),
          governorate: z.string().optional(),
          city: z.string().optional(),
          productId: z.number().optional(),
          productName: z.string().optional(),
          quantity: z.number().min(1).optional(),
          totalAmount: z.number().optional(),
          shippingFees: z.number().optional(),
          paymentMethod: z.string().optional(),
          notes: z.string().optional(),
          employeeNotes: z.string().optional(),
          variantId: z.number().nullable().optional(),
          color: z.string().nullable().optional(),
          size: z.string().nullable().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        const actingEmpId = await resolveActingEmployeeId(ctx);
        const { orderId, ...updates } = input;
        const result = await editOrderFull(orderId, updates, {
          id: actingEmpId ?? 0,
          name: ctx.user.name || "Admin",
          role: "admin",
        });
        return { success: true, order: result };
      }),

    // ==================== ORDER ITEMS (owner / admin side) ====================
    // The employee portal has had orderItems/editOrderItems since the confirmation screen
    // was rebuilt; the admin side had no way to read or write order_items at all, which is
    // why the owner's edit dialog still described a whole basket as one text field.
    //
    // Same db functions as the employee path, deliberately: one place decides how a line is
    // priced, how the header is re-rolled and how stock is reconciled. What differs is the
    // gate — admin session and tenant scope here, employee cookie plus per-order ownership
    // there — so sharing the UI does not share the authorization.
    orderItems: adminProcedure
      .input(z.object({ orderId: z.number() }))
      .query(async ({ ctx, input }) => {
        const order = await getOrderById(input.orderId);
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "الأوردر غير موجود" });
        await requireScopedBusinessId(ctx, order.businessId);
        const items = await getOrderItems(input.orderId);
        // An order created before order_items was populated has none. Rather than showing
        // an empty basket — which the user would "fix" by adding lines, silently doubling
        // the order — synthesise one line from the header and mark it so the UI can say so.
        if (items.length === 0) {
          return {
            items: [
              {
                id: null,
                productId: order.productId,
                productName: order.productName,
                variantId: order.variantId ?? null,
                variantName: null,
                quantity: order.quantity,
                unitPrice: null,
                discount: "0",
                size: order.size ?? null,
                color: order.color ?? null,
              },
            ],
            derivedFromHeader: true,
            shippingFees: order.shippingFees ?? "0",
            totalAmount: order.totalAmount,
          };
        }
        return {
          items: items.map(i => ({
            id: i.id,
            productId: i.productId,
            productName: i.productName,
            variantId: i.variantId,
            variantName: i.variantName,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            discount: i.discountAmountSnapshot,
            size: i.size,
            color: i.color,
          })),
          derivedFromHeader: false,
          shippingFees: order.shippingFees ?? "0",
          totalAmount: order.totalAmount,
        };
      }),

    /*
      محتوى الأوردر ورا صلاحية واحدة: `orders.edit_items`.

      `permissionProcedure` هو الحارس الموجود أصلاً في المشروع، وبيعمل تلات حاجات في
      مكان واحد — بيقبل الجلستين (حساب المالك وكوكي الموظف)، بيسمح للمالك/الأدمن
      تلقائيًا، وبيقرا override الـtenant من `tenant_role_permissions` فالمالك يقدر
      يمنح أو يمنع من غير Deploy. فمفيش نظام صلاحيات موازي هنا.

      الحارس ده على السيرفر مش في الواجهة: نداء مباشر للـendpoint من غير الصلاحية
      بيترفض بنفس الشكل.
    */
    editOrderItems: permissionProcedure("orders.edit_items")
      .input(
        z.object({
          orderId: z.number(),
          items: z
            .array(
              z.object({
                productId: z.number().nullable(),
                productName: z.string().min(1).max(200),
                variantId: z.number().nullable(),
                quantity: z.number().int().min(1).max(999),
                unitPrice: z.number().min(0).max(1_000_000),
                discount: z.number().min(0).max(1_000_000),
                size: z.string().max(100).nullable().optional(),
                color: z.string().max(100).nullable().optional(),
              })
            )
            .min(1, "الأوردر لازم يكون فيه بند واحد على الأقل")
            .max(20, "أقصى عدد بنود ٢٠"),
          shippingFees: z.number().min(0).max(100_000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const order = await getOrderById(input.orderId);
        if (!order) throw new TRPCError({ code: "NOT_FOUND", message: "الأوردر غير موجود" });
        await requireScopedBusinessId(ctx, order.businessId);
        const editor = resolveOrderEditor(ctx);
        const result = await replaceOrderItemsFromEditor(
          input.orderId,
          input.items.map(i => ({
            productId: i.productId,
            productName: i.productName,
            variantId: i.variantId,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            discount: i.discount,
            size: i.size ?? null,
            color: i.color ?? null,
          })),
          input.shippingFees,
          editor
        );
        await addActivityLog({
          action: "edit_order_items",
          entityType: "order",
          entityId: input.orderId,
          description: `تعديل بنود أوردر #${input.orderId} — ${result.itemCount} بند، إجمالي ${result.totalAmount}`,
          metadata: {
            orderId: input.orderId,
            itemCount: result.itemCount,
            totalAmount: result.totalAmount,
          },
          performedBy: editor.id,
          performedByName: editor.name,
          performedByRole: editor.role,
        });
        return { success: true, ...result };
      }),

    // جلب سجل تعديلات أوردر
    getEditHistory: protectedProcedure
      .input(
        z.object({
          orderId: z.number(),
        })
      )
      .query(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        return getOrderEditLogs(input.orderId);
      }),

    delete: ownerProcedure
      .input(
        z.object({
          orderId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        await withStatusGuard(() => deleteOrder(input.orderId));
        await addActivityLog({
          action: "delete_order",
          entityType: "order",
          entityId: input.orderId,
          description: `حذف أوردر #${input.orderId}`,
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? "مدير",
          performedByRole: ctx.user.role ?? "admin",
        });
        return { success: true };
      }),

    bulkDelete: ownerProcedure
      .input(
        z.object({
          orderIds: z.array(z.number()),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // حذف جماعي — الرفض قبل أي مسح لو أي أوردر برّه النطاق.
        await requireAllOwned(ctx, "order", input.orderIds);
        await withStatusGuard(() => deleteOrders(input.orderIds));
        await addActivityLog({
          action: "bulk_delete_orders",
          entityType: "order",
          description: `حذف ${input.orderIds.length} أوردر`,
          metadata: { orderIds: input.orderIds },
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? "مدير",
          performedByRole: ctx.user.role ?? "admin",
        });
        return { success: true };
      }),

    // تكرار أوردر: نسخ بيانات أوردر موجود وإنشاء أوردر جديد بنفس البيانات
    duplicate: adminProcedure
      .input(
        z.object({
          orderId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        const originalOrder = await getOrderById(input.orderId);
        if (!originalOrder)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "الأوردر غير موجود",
          });
        const newOrderNumber = await generateOrderNumber();
        const actingEmpId = await resolveActingEmployeeId(ctx);
        // البنود بتتنسخ مع الأوردر. من غير كده الأوردر المكرّر كان بيطلع بهيدر بس،
        // فأوردر فيه تلات نقوش مختلفة بيتكرّر من غير أي نقش — وبوسطة بتستلم سطر
        // مجمّع مكان القطع.
        const originalItems = await getOrderItems(input.orderId);
        await createOrderWithItems(
          {
          orderNumber: newOrderNumber,
          businessId: originalOrder.businessId,
          customerName: originalOrder.customerName,
          customerPhone: originalOrder.customerPhone,
          customerAddress: originalOrder.customerAddress,
          governorate: originalOrder.governorate,
          productId: originalOrder.productId,
          productName: originalOrder.productName,
          quantity: originalOrder.quantity ?? 1,
          totalAmount: originalOrder.totalAmount,
          projectedShippingProviderId:
            originalOrder.projectedShippingProviderId,
          projectedShippingType: originalOrder.projectedShippingType,
          projectedPaymentType: originalOrder.projectedPaymentType,
          source: originalOrder.source,
          notes: originalOrder.notes
            ? `تكرار من أوردر #${originalOrder.orderNumber} — ${originalOrder.notes}`
            : `تكرار من أوردر #${originalOrder.orderNumber}`,
          pageName: originalOrder.pageName,
          adName: originalOrder.adName,
          lastUpdatedBy: actingEmpId,
          } as any,
          originalItems.length > 0
            ? originalItems.map(item => ({
                productId: item.productId ?? undefined,
                productName: item.productName,
                variantId: item.variantId ?? undefined,
                quantity: item.quantity,
                unitPrice: item.unitPrice != null ? Number(item.unitPrice) : undefined,
                size: item.size ?? undefined,
                color: item.color ?? undefined,
              }))
            : [
                // أوردر قديم مالوش بنود — الهيدر بيتحوّل لبند واحد، فالنسخة الجديدة
                // تبدأ بمصدر حقيقة واحد بدل ما تورّث الفراغ.
                {
                  productId: originalOrder.productId ?? undefined,
                  productName: originalOrder.productName,
                  variantId: originalOrder.variantId ?? undefined,
                  quantity: originalOrder.quantity ?? 1,
                  size: originalOrder.size ?? undefined,
                  color: originalOrder.color ?? undefined,
                },
              ]
        );
        await addActivityLog({
          action: "duplicate_order",
          entityType: "order",
          entityId: input.orderId,
          description: `تكرار أوردر #${originalOrder.orderNumber} → أوردر جديد #${newOrderNumber}`,
          metadata: {
            originalOrderId: input.orderId,
            originalOrderNumber: originalOrder.orderNumber,
            newOrderNumber,
          },
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? "مدير",
          performedByRole: ctx.user.role ?? "admin",
        });
        return { success: true, newOrderNumber };
      }),

    convertNoAnswerToNew: adminProcedure.mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB error",
        });
      // العزل: التحويل بالجملة لازم يتقيّد بأنشطة الـtenant بتاعه. من غير الفلتر ده كان
      // أدمن شركة بيقلب حالة أوردرات كل الشركات. `scopeBusinessIds` بترجع أنشطة الـtenant
      // (أو [-1] لو فاضي = يمنع الكل)، و`undefined` للمالك على مستوى المنصة (مفيش فلتر).
      const scoped = await scopeBusinessIds(ctx);
      const conds = [eq(ordersTable.status, "no_answer" as any)];
      if (scoped) conds.push(inArray(ordersTable.businessId, scoped));
      const result: any = await db
        .update(ordersTable)
        .set({ status: "new" as any })
        .where(and(...conds));
      const count =
        Number(result?.[0]?.affectedRows ?? result?.affectedRows ?? 0) || 0;
      if (count > 0) {
        await addActivityLog({
          action: "convert_no_answer",
          entityType: "order",
          entityId: 0,
          description: `تحويل ${count} أوردر من "لم يرد" إلى "جديد"`,
          metadata: { count },
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? "مدير",
          performedByRole: ctx.user.role ?? "admin",
        });
      }
      return { success: true, count };
    }),

    convertPostponedToNew: adminProcedure.mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "DB error",
        });
      // نفس العزل زي convertNoAnswerToNew — التحويل بالجملة على أنشطة الـtenant بس.
      const scoped = await scopeBusinessIds(ctx);
      const conds = [eq(ordersTable.status, "postponed" as any)];
      if (scoped) conds.push(inArray(ordersTable.businessId, scoped));
      const result: any = await db
        .update(ordersTable)
        .set({ status: "new" as any, postponedTo: null })
        .where(and(...conds));
      const count =
        Number(result?.[0]?.affectedRows ?? result?.affectedRows ?? 0) || 0;
      if (count > 0) {
        await addActivityLog({
          action: "convert_postponed",
          entityType: "order",
          entityId: 0,
          description: `تحويل ${count} أوردر من "مؤجل" إلى "جديد"`,
          metadata: { count },
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? "مدير",
          performedByRole: ctx.user.role ?? "admin",
        });
      }
      return { success: true, count };
    }),

    unassignEmployeeOrders: adminProcedure
      .input(
        z.object({
          employeeId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "employee", input.employeeId);
        const db = await getDb();
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "DB error",
          });
        const [result] = await db.execute(
          sql`UPDATE orders SET assignedEmployeeId = NULL, assignedAt = NULL WHERE assignedEmployeeId = ${input.employeeId}`
        );
        const count = (result as any).affectedRows || 0;
        if (count > 0) {
          const emps = await getAllEmployees();
          const emp = emps.find(e => e.id === input.employeeId);
          await addActivityLog({
            action: "unassign_employee_orders",
            entityType: "order",
            entityId: input.employeeId,
            description: `سحب ${count} أوردر من الموظف ${emp?.name || input.employeeId}`,
            metadata: { employeeId: input.employeeId, count },
            performedBy: ctx.user.id,
            performedByName: ctx.user.name ?? "مدير",
            performedByRole: ctx.user.role ?? "admin",
          });
        }
        return { success: true, count };
      }),

    myOrders: protectedProcedure
      .input(
        z.object({
          status: z.string().optional(),
          page: z.number().default(1),
          limit: z.number().default(200),
          // تاريخ التوزيع - افتراضياً اليوم بتوقيت القاهرة
          assignedDate: z.string().optional(), // YYYY-MM-DD, defaults to today Cairo time
        })
      )
      .query(async ({ ctx, input }) => {
        const emps = await getAllEmployees();
        const emp = emps.find(e => e.userId === ctx.user.id);
        if (!emp) return { orders: [], total: 0 };

        // حساب بداية ونهاية يوم التوزيع بتوقيت القاهرة (UTC+2)
        const { from: assignedDateFrom, to: assignedDateTo } =
          input.assignedDate
            ? cairoParseDateRange(input.assignedDate)
            : cairoTodayRange();

        return getOrders({
          ...input,
          assignedEmployeeId: emp.id,
          assignedDateFrom,
          assignedDateTo,
        });
      }),

    // ==================== QR SCAN PROCEDURES ====================
    scan: protectedProcedure
      .input(
        z.object({
          serialNumber: z.string(),
          deviceInfo: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emps = await getAllEmployees();
        const emp = emps.find((e: any) => e.userId === ctx.user.id);
        const scannedBy = emp?.id ?? ctx.user!.id;
        const scannedByName = emp?.name ?? ctx.user.name ?? "موظف";
        const result = await scanOrderBySerial(
          input.serialNumber,
          scannedBy,
          scannedByName,
          input.deviceInfo
        );
        return result;
      }),

    scanLogs: adminProcedure
      .input(
        z.object({
          orderId: z.number().optional(),
          scannedBy: z.number().optional(),
          limit: z.number().default(100),
        })
      )
      .query(async ({ ctx, input }) => {
        // الفلتر اختياري — بيتفحص لما يتبعت بس. من غيره القايمة مقصوصة أصلاً تحت.
        if (input.orderId != null)
          await requireOwned(ctx, "order", input.orderId);
        return getScanLogs(input);
      }),

    todayConfirmed: protectedProcedure
      .input(
        z.object({
          confirmedByEmployeeId: z.number().optional(), // فلتر بالموظف
          date: z.string().optional(), // YYYY-MM-DD, defaults to today Cairo time
          businessId: z.number().optional(),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) return { orders: [], total: 0 };
        const { from, to } = input.date
          ? cairoParseDateRange(input.date)
          : cairoTodayRange();
        const conditions = [
          eq(ordersTable.status, "confirmed"),
          gte(ordersTable.confirmedAt, from),
          lte(ordersTable.confirmedAt, to),
        ] as any[];
        if (input.confirmedByEmployeeId) {
          conditions.push(
            eq(ordersTable.assignedEmployeeId, input.confirmedByEmployeeId)
          );
        }
        const businessIds = await scopeBusinessIds(ctx, input);
        if (businessIds)
          conditions.push(inArray(ordersTable.businessId, businessIds));
        const rows = await db
          .select()
          .from(ordersTable)
          .where(and(...conditions))
          .orderBy(desc(ordersTable.confirmedAt));
        return { orders: rows, total: rows.length };
      }),
  }),

  // ==================== OPERATIONS WORKSPACE (Matjarak V2) ====================
  // شحنات اليوم + جدول الشحن داخل Operations workspace لجلسة الداشبورد (المالك/المدير).
  // `employeePortal.*` بتقرا كوكي employee_token بس، فالمالك اللي داخل من /login كان
  // بيترفض ويتحوّل لـ/employee-login. قراءة بس (read-only)، ونفس صلاحية شاشات الشحن.
  // النطاق من scopeBusinessIds (مبدّل الأنشطة، متقيّد بأنشطة الجلسة)؛ ولو النطاق مش
  // متحدد لأي سبب بنقفل على NO_BUSINESS — مصفوفة فاضية معناها «من غير فلتر» في getOrders.
  operations: router({
    todayShipments: permissionProcedure("shipping_ops.view")
      .input(
        z.object({
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(), // YYYY-MM-DD
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = (await scopeBusinessIds(ctx, input)) ?? [
          NO_BUSINESS,
        ];
        return buildTodayShipments(businessIds, input.date);
      }),

    shippingRoutes: permissionProcedure("shipping_ops.view")
      .input(
        z
          .object({
            businessIds: z.array(z.number()).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = (await scopeBusinessIds(ctx, input)) ?? [
          NO_BUSINESS,
        ];
        return loadShippingRouteRows(businessIds);
      }),
  }),

  // ==================== EMPLOYEE PORTAL ====================
  employeePortal: router({
    me: employeePortalProcedure.query(async ({ ctx }) => {
      const emp = (ctx as any).employee;
      return {
        id: emp.id,
        name: emp.name,
        role: emp.role,
        username: emp.username,
        businessId: emp.businessId ?? null,
      };
    }),

    // صلاحيات **هوية البوابة** (كوكي الموظف) بتجاوزات الشركة — نفس مصدر حارس requireEmployeeTenantPermission.
    // auth.myPermissions مش مناسبة هنا: لو جلسة مالك على الويب في نفس المتصفح، createContext بيقدّم
    // كوكي المالك، فالواجهة كانت هتعرض روابط السيرفر هيرفضها لهوية الموظف. قراءة بس، tenant من صف الموظف.
    myPermissions: employeePortalProcedure.query(async ({ ctx }) => {
      const emp = (ctx as any).employee;
      return tenantPermissionsForRole(requireTenantId(emp), emp.role);
    }),

    // ==================== الرسائل (0043) — هوية كوكي البوابة فقط ====================
    messages: buildMessagingRouter(employeePortalProcedure as unknown as typeof authenticatedProcedure, portalMessagingIdentity),

    // ==================== حضوري (0042) — هوية البوابة فقط ====================
    attendanceMine: requireEmployeeTenantPermission("attendance.view_self")
      .input(attendanceRange.strict())
      .query(async ({ ctx, input }) => {
        if (!attendanceSvc.attendanceEnabled()) return { enabled: false as const };
        return { enabled: true as const, ...(await attendanceSvc.myDays(portalAttendanceActor(ctx), input.dateFrom, input.dateTo)) };
      }),
    attendanceClock: requireEmployeeTenantPermission("attendance.clock_self")
      .input(z.object({ action: z.enum(["clock_in", "break_start", "break_end", "clock_out"]), operationId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/), source: z.enum(["web", "mobile_web"]).optional() }).strict())
      .mutation(async ({ ctx, input }) => attendanceSvc.clock(portalAttendanceActor(ctx), input.action, input.operationId, input.source ?? "web")),
    // أحداث يومي القابلة لتصحيح الوقت — لاختيار targetEventId صراحةً في «وقت مسجّل خطأ» (لا تخمين). هوية البوابة فقط.
    attendanceMyDayEvents: requireEmployeeTenantPermission("attendance.request_correction")
      .input(z.object({ workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict())
      .query(async ({ ctx, input }) => {
        if (!attendanceSvc.attendanceEnabled()) return { enabled: false as const };
        return { enabled: true as const, ...(await attendanceSvc.myCorrectableEvents(portalAttendanceActor(ctx), input.workDate)) };
      }),
    attendanceRequestCorrection: requireEmployeeTenantPermission("attendance.request_correction")
      .input(attendanceSvc.correctionRequestInput)
      .mutation(async ({ ctx, input }) => attendanceSvc.requestCorrection(portalAttendanceActor(ctx), input)),
    attendanceCancelRequest: requireEmployeeTenantPermission("attendance.request_correction")
      .input(z.object({ requestId: z.number().int().positive() }).strict())
      .mutation(async ({ ctx, input }) => attendanceSvc.cancelCorrection(portalAttendanceActor(ctx), input.requestId)),

    // ==================== مهامي — هوية البوابة فقط ====================
    // مهامه هو + المهام العامة (بلا مستلم) لنشاطه، داخل نطاقه (tenant + نشاطه، fail-closed). قراءة وتحديث حالة
    // فقط — لا إنشاء ولا حذف ولا employeeId من العميل. الملكية في نفس شرط الـUPDATE؛ 0 صفوف = NOT_FOUND
    // (لا نكشف وجود مهمة زميل أو شركة أخرى).
    tasks: router({
      listMine: requireEmployeeTenantPermission("tasks.view_own")
        .input(z.object({ status: z.enum(["all", "new", "in_progress", "done"]).optional() }).strict().optional())
        .query(async ({ ctx, input }) => {
          const emp = (ctx as any).employee;
          const scope = await portalTeamScope(ctx);
          const db = await getDb();
          if (!db) return [];
          const { tasks } = await import("../drizzle/schema");
          const conditions: any[] = [taskScopeCondition(scope), or(eq(tasks.assignedTo, emp.id), isNull(tasks.assignedTo))];
          if (input?.status && input.status !== "all") conditions.push(eq(tasks.status, input.status));
          return db.select().from(tasks).where(and(...conditions)).orderBy(desc(tasks.createdAt)).limit(100);
        }),
      updateMyStatus: requireEmployeeTenantPermission("tasks.view_own")
        .input(z.object({ taskId: z.number().int().positive(), status: z.enum(["new", "in_progress", "done"]) }).strict())
        .mutation(async ({ ctx, input }) => {
          const emp = (ctx as any).employee;
          const scope = await portalTeamScope(ctx);
          const db = await getDb();
          if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
          const { tasks } = await import("../drizzle/schema");
          const mine = and(eq(tasks.id, input.taskId), taskScopeCondition(scope), or(eq(tasks.assignedTo, emp.id), isNull(tasks.assignedTo)));
          const [row] = await db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(mine).limit(1);
          if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "المهمة غير موجودة أو ليست لك" });
          if (row.status !== input.status) await db.update(tasks).set({ status: input.status }).where(mine);
          return { success: true };
        }),
    }),

    // ==================== فريقي (0044) — هوية البوابة فقط، قيادة فعّالة إلزامية ====================
    // الصلاحية وحدها لا تكفي: myTeams لغير القائد = [] (صفر بيانات)، وmembers لفريق لا يقوده = FORBIDDEN.
    // بلا teamId/tenantId/employeeId من العميل إلا teamId لاختيار فريق من فرقه هو (يُتحقق منه على السيرفر).
    team: router({
      myTeams: requireEmployeeTenantPermission("teams.view_own").query(async ({ ctx }) => {
        if (!teamsSvc.teamsEnabled()) return { enabled: false as const, teams: [] as teamsSvc.LeaderTeam[] };
        return { enabled: true as const, teams: await teamsSvc.leaderTeams(portalTeamsActor(ctx)) };
      }),
      members: requireEmployeeTenantPermission("teams.view_own")
        .input(z.object({ teamId: z.number().int().positive() }).strict())
        .query(async ({ ctx, input }) => {
          if (!teamsSvc.teamsEnabled()) return { enabled: false as const, members: [] as any[] };
          await requireTeamLeader(ctx, input.teamId);
          return { enabled: true as const, members: await teamsSvc.teamMembersAt(requireTenantId((ctx as any).employee), input.teamId) };
        }),

      // ── الحضور: team_attendance.view + قيادة فعّالة. الاعتماد يضيف approve_corrections (وmanage_leaves للإجازة/المأمورية).
      attendance: requireEmployeeTenantPermission("team_attendance.view")
        .input(z.object({ teamId: z.number().int().positive(), dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict())
        .query(async ({ ctx, input }) => {
          if (!teamsSvc.teamsEnabled() || !attendanceSvc.attendanceEnabled()) return { enabled: false as const };
          return { enabled: true as const, ...(await teamLeaderSvc.teamAttendance(portalTeamsActor(ctx), input.teamId, input.dateFrom, input.dateTo)) };
        }),
      reviewCorrection: requireEmployeeTenantPermission("team_attendance.view")
        .input(teamLeaderSvc.teamReviewInput)
        .mutation(async ({ ctx, input }) => {
          const emp = (ctx as any).employee;
          const tenantId = requireTenantId(emp);
          // الاعتماد ليس افتراضيًا للقائد: approve_corrections إلزامية دائمًا، وmanage_leaves للإجازة/المأمورية (في الخدمة).
          const perms = { approveCorrections: await hasTenantPermission(tenantId, emp.role, "attendance.approve_corrections"), manageLeaves: await hasTenantPermission(tenantId, emp.role, "attendance.manage_leaves") };
          if (!perms.approveCorrections) throw new TRPCError({ code: "FORBIDDEN", message: "ليس لديك صلاحية اعتماد طلبات التصحيح" });
          return teamLeaderSvc.reviewTeamCorrection(portalTeamsActor(ctx), input, perms);
        }),

      // ── الأداء: team_performance.view + قيادة فعّالة؛ order_activity_events فقط بعضوية لحظة الحدث.
      performance: requireEmployeeTenantPermission("team_performance.view")
        .input(z.object({ teamId: z.number().int().positive(), dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict())
        .query(async ({ ctx, input }) => {
          if (!teamsSvc.teamsEnabled()) return { enabled: false as const };
          const r = await teamLeaderSvc.teamPerformance(portalTeamsActor(ctx), input.teamId, input.dateFrom, input.dateTo);
          if (!r.report.enabled) return { enabled: false as const };
          const { enabled: _on, ...report } = r.report;
          return { enabled: true as const, team: r.team, ...report };
        }),

      // ── ورديات أعضاء الفريق اليوم: team_attendance.view + قيادة فعّالة (بلا أي بيانات مالية).
      memberShifts: requireEmployeeTenantPermission("team_attendance.view")
        .input(z.object({ teamId: z.number().int().positive() }).strict())
        .query(async ({ ctx, input }) => {
          if (!teamsSvc.teamsEnabled() || !attendanceSvc.attendanceEnabled()) return { enabled: false as const };
          return { enabled: true as const, ...(await teamLeaderSvc.leaderTeamMemberShifts(portalTeamsActor(ctx), input.teamId)) };
        }),
      // ── سجل عضويات الفريق للقراءة: teams.view_own + قيادة فعّالة؛ أسماء فقط بلا معرّفات خام.
      history: requireEmployeeTenantPermission("teams.view_own")
        .input(z.object({ teamId: z.number().int().positive() }).strict())
        .query(async ({ ctx, input }) => {
          if (!teamsSvc.teamsEnabled()) return { enabled: false as const };
          return { enabled: true as const, ...(await teamLeaderSvc.leaderTeamHistory(portalTeamsActor(ctx), input.teamId)) };
        }),
      // ── تصدير أداء الفريق CSV: team_performance.view **و** employee_performance.export + قيادة فعّالة.
      performanceCsv: requireEmployeeTenantPermission("team_performance.view")
        .input(z.object({ teamId: z.number().int().positive(), dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict())
        .query(async ({ ctx, input }) => {
          const emp = (ctx as any).employee;
          if (!(await hasTenantPermission(requireTenantId(emp), emp.role, "employee_performance.export")))
            throw new TRPCError({ code: "FORBIDDEN", message: "ليس لديك صلاحية تصدير الأداء" });
          if (!teamsSvc.teamsEnabled()) return { enabled: false as const };
          return teamLeaderSvc.leaderTeamPerformanceCsv(portalTeamsActor(ctx), input.teamId, input.dateFrom, input.dateTo);
        }),

      // ── المهام: team_tasks.manage + قيادة فعّالة؛ أعضاء فعّالون أو مهمة عامة لنشاط الفريق، بلا حذف.
      tasks: router({
        list: requireEmployeeTenantPermission("team_tasks.manage")
          .input(z.object({ teamId: z.number().int().positive(), status: z.enum(["new", "in_progress", "done"]).optional() }).strict())
          .query(async ({ ctx, input }) => {
            if (!teamsSvc.teamsEnabled()) return { enabled: false as const, rows: [] as any[] };
            return { enabled: true as const, rows: await teamLeaderSvc.listTeamTasks(portalTeamsActor(ctx), input.teamId, input.status) };
          }),
        create: requireEmployeeTenantPermission("team_tasks.manage").input(teamLeaderSvc.teamTaskInput)
          .mutation(async ({ ctx, input }) => teamLeaderSvc.createTeamTask(portalTeamsActor(ctx), input)),
        updateStatus: requireEmployeeTenantPermission("team_tasks.manage").input(teamLeaderSvc.teamTaskStatusInput)
          .mutation(async ({ ctx, input }) => teamLeaderSvc.updateTeamTaskStatus(portalTeamsActor(ctx), input)),
      }),

      // ── الأوردرات: view = كل أوردرات نشاط الفريق (ومنها غير المسندة)؛ assign = لعضو فعّال عبر المسار القائم.
      orders: router({
        list: requireEmployeeTenantPermission("team_orders.view").input(teamLeaderSvc.teamOrdersInput)
          .query(async ({ ctx, input }) => {
            if (!teamsSvc.teamsEnabled()) return { enabled: false as const };
            return { enabled: true as const, ...(await teamLeaderSvc.listTeamOrders(portalTeamsActor(ctx), input)) };
          }),
        assign: requireEmployeeTenantPermission("team_orders.assign").input(teamLeaderSvc.teamAssignInput)
          .mutation(async ({ ctx, input }) => {
            if (!teamsSvc.teamsEnabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "نظام الفرق غير مفعّل" });
            const r = await teamLeaderSvc.assignTeamOrder(portalTeamsActor(ctx), input, portalEventCtx(ctx, "employee_portal", input.operationId));
            return { success: true as const, teamId: r.team.teamId };
          }),
      }),
    }),

    // «أدائي» من سجل الأحداث — هوية البوابة فقط، نشاط الموظف فقط، بلا ترتيب.
    myPerformance: requireEmployeeTenantPermission("employee_performance.view_self")
      .input(z.object({ dateFrom: z.string(), dateTo: z.string() }).strict())
      .query(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const businessIds = (await scopeBusinessIds(empScope(ctx), {})) ?? [NO_BUSINESS];
        return loadPerformance({ tenantId: requireTenantId(emp), businessIds, fromDate: input.dateFrom, toDate: input.dateTo, onlyEmployeeId: emp.id });
      }),

    myOrders: requireEmployeeTenantPermission("orders.view")
      .input(
        z.object({
          status: z.string().optional(),
          page: z.number().default(1),
          limit: z.number().default(200),
          assignedDate: z.string().optional(), // YYYY-MM-DD, defaults to today Cairo time
          dateFrom: z.date().optional(), // فلتر تاريخ مخصص - بداية
          dateTo: z.date().optional(), // فلتر تاريخ مخصص - نهاية
          websiteId: z.number().optional(),
          businessIds: z.array(z.number()).optional(), // فلتر حسب المجموعة (نحاس / مفروشات)
        })
      )
      .query(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        // الموظف يشوف كل الأوردرات الموزعة عليه بغض النظر عن الـ business
        // لكن لو اختار مجموعة معينة نفلتر بيها (بعد التأكد إنها تبع نفس الـ tenant)
        const tenantId = requireTenantId(emp);
        const filterBusinessIds = await scopeBusinessIds(empScope(ctx), input);
        // إذا كان فيه فلتر تاريخ مخصص، نستخدمه مباشرة
        if (input.dateFrom || input.dateTo) {
          return getOrders({
            ...input,
            assignedEmployeeId: emp.id,
            assignedDateFrom: input.dateFrom,
            assignedDateTo: input.dateTo,
            businessIds: filterBusinessIds,
          });
        }
        // وإلا نفلتر بتاريخ التوزيع اليوم بتوقيت القاهرة
        const { from: assignedDateFrom, to: assignedDateTo } =
          input.assignedDate
            ? cairoParseDateRange(input.assignedDate)
            : cairoTodayRange();
        return getOrders({
          ...input,
          assignedEmployeeId: emp.id,
          assignedDateFrom,
          assignedDateTo,
          businessIds: filterBusinessIds,
        });
      }),

    confirm: requireEmployeeTenantPermission("orders.confirm")
      .input(
        z.object({
          orderId: z.number(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        // Ownership check: agents can only confirm their own assigned orders
        await assertEmployeeOwnsOrder(emp, input.orderId, "هذا الأوردر غير مخصص لك");
        const res = await confirmOrderOrReject(input.orderId, emp.id, emp.name, portalEventCtx(ctx, "employee_portal", input.operationId));
        await addActivityLog({
          action: "confirm_order",
          entityType: "order",
          entityId: input.orderId,
          description: `تأكيد أوردر #${input.orderId} بواسطة موظف`,
          performedBy: emp.id,
          performedByName: emp.name,
          performedByRole: "employee",
        });
        // التأكيد نجح دائمًا؛ لو فيه عجز مخزون نبلّغ الموظف برسالة نجاح توضّح الحاجة للمراجعة.
        return {
          success: true,
          needsReview: res?.needsReview ?? false,
          message: res?.stockShortfall
            ? "تم تأكيد الأوردر، ويوجد عجز مخزون يحتاج مراجعة."
            : "تم تأكيد الأوردر.",
        };
      }),

    postpone: requireEmployeeTenantPermission("orders.update")
      .input(
        z.object({
          orderId: z.number(),
          postponedTo: z.date(),
          notes: z.string().optional(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        // Ownership check: agents can only postpone their own assigned orders
        await assertEmployeeOwnsOrder(emp, input.orderId, "هذا الأوردر غير مخصص لك");
        await postponeOrder(
          input.orderId,
          input.postponedTo,
          input.notes,
          emp.id,
          portalEventCtx(ctx, "employee_portal", input.operationId)
        );
        await addActivityLog({
          action: "postpone_order",
          entityType: "order",
          entityId: input.orderId,
          description: `تأجيل أوردر #${input.orderId}`,
          metadata: { notes: input.notes },
          performedBy: emp.id,
          performedByName: emp.name,
          performedByRole: "employee",
        });
        return { success: true };
      }),

    cancel: requireEmployeeTenantPermission("orders.cancel")
      .input(
        z.object({
          orderId: z.number(),
          cancelReason: z.string().min(1).max(80),
          notes: z.string().optional(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        // Ownership check: agents can only cancel their own assigned orders
        await assertEmployeeOwnsOrder(emp, input.orderId, "هذا الأوردر غير مخصص لك");
        await cancelOrder(
          input.orderId,
          input.cancelReason,
          input.notes,
          emp.id,
          portalEventCtx(ctx, "employee_portal", input.operationId)
        );
        await addActivityLog({
          action: "cancel_order",
          entityType: "order",
          entityId: input.orderId,
          description: `إلغاء أوردر #${input.orderId} - السبب: ${input.cancelReason}`,
          metadata: { cancelReason: input.cancelReason, notes: input.notes },
          performedBy: emp.id,
          performedByName: emp.name,
          performedByRole: "employee",
        });
        return { success: true };
      }),

    markNoAnswer: requireEmployeeTenantPermission("orders.update")
      .input(
        z.object({
          orderId: z.number(),
          callAttempts: z.number().int().min(1).max(20).optional(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        await assertEmployeeOwnsOrder(emp, input.orderId, "هذا الأوردر غير مخصص لك");
        await updateOrder(input.orderId, {
          status: "no_answer",
          lastUpdatedBy: emp.id,
          noAnswerCallAttempts: input.callAttempts,
        }, portalEventCtx(ctx, "employee_portal", input.operationId));
        return { success: true };
      }),

    /**
     * تغيير حالة الأوردر من شاشة التأكيدات — أربع حالات فقط.
     *
     * الـenum هنا هو الحد الأمني نفسه، مش مجرد تلميح للواجهة: zod بيرفض أي قيمة تانية
     * على السيرفر قبل ما توصل لأي كود، فحتى طلب متعمّد بـ"shipped" أو "delivered"
     * بيترفض. الموظف مش بيعدي أي حقل تاني — مفيش في الـinput أصلاً سعر ولا منتج ولا
     * بيانات عميل، فمفيش سطح للتعديل غير الحالة.
     *
     * التنفيذ بيمرّ على نفس دوال confirmOrder/cancelOrder/postponeOrder الموجودة، عشان
     * منطق التأكيد (تحديث المخزون، confirmedByEmployeeId، الطوابع الزمنية) يفضل واحد
     * ومايتفرّعش نسخة تانية منه هنا.
     */
    updateStatus: requireEmployeeTenantPermission("orders.update")
      .input(
        z.object({
          orderId: z.number(),
          status: z.enum(EMPLOYEE_SETTABLE_ORDER_STATUSES),
          cancelReason: z.string().min(1).max(80).optional(),
          postponedTo: z.date().optional(),
          notes: z.string().optional(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        await requireOwned(empScope(ctx), "order", input.orderId);
        const order = await getOrderById(input.orderId);
        if (!order)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "الأوردر غير موجود",
          });
        // نفس شرط الملكية الموجود في confirm/cancel/postpone
        if (!isAdminTierRole(emp.role) && order.assignedEmployeeId !== emp.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "هذا الأوردر غير مخصص لك",
          });
        }

        const previousStatus = order.status;
        if (previousStatus === input.status)
          return { success: true, unchanged: true };

        const statusEventCtx = portalEventCtx(ctx, "employee_portal", input.operationId);
        switch (input.status) {
          case "confirmed":
            await confirmOrderOrReject(input.orderId, emp.id, emp.name, statusEventCtx);
            break;
          case "cancelled":
            if (!input.cancelReason) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "سبب الإلغاء مطلوب",
              });
            }
            await cancelOrder(
              input.orderId,
              input.cancelReason,
              input.notes,
              emp.id,
              statusEventCtx
            );
            break;
          case "postponed":
            if (!input.postponedTo) {
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "تاريخ التأجيل مطلوب",
              });
            }
            await postponeOrder(
              input.orderId,
              input.postponedTo,
              input.notes,
              emp.id,
              statusEventCtx
            );
            break;
          case "new":
            // الرجوع لـ"جديد" بيمسح طابع الإلغاء وسببه، وإلا الأوردر يفضل شكله جديد
            // وسجلّه بيقول إنه ملغي — والـtimeline في صفحة الأوردرات بيقرا الطوابع دي.
            await updateOrder(input.orderId, {
              status: "new",
              lastUpdatedBy: emp.id,
              cancelledAt: null,
              cancelReason: null,
              postponedTo: null,
            }, statusEventCtx);
            break;
        }

        // سجل الحالات: مين غيّر، من إيه لإيه، وامتى. جدول order_edit_logs موجود بالحقول
        // دي بالظبط، فمفيش داعي لجدول تاريخ حالات منفصل.
        await logOrderEdit({
          orderId: input.orderId,
          field: "status",
          oldValue: previousStatus,
          newValue: input.status,
          editedBy: emp.id,
          editedByName: emp.name,
          editedByRole: emp.role ?? "employee",
        });

        return { success: true };
      }),

    // إضافة/تعديل ملاحظات الموظف على الأوردر
    updateNotes: requireEmployeeTenantPermission("orders.update")
      .input(
        z.object({
          orderId: z.number(),
          notes: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        // Ownership check: agents can only update notes on their own assigned orders
        await assertEmployeeOwnsOrder(emp, input.orderId, "هذا الأوردر غير مخصص لك");
        await updateOrder(input.orderId, {
          notes: input.notes,
          lastUpdatedBy: emp.id,
        });
        return { success: true };
      }),

    // تعديل بيانات العميل (المحافظة والعنوان) — للموظف على أوردراته فقط
    updateCustomerInfo: requireEmployeeTenantPermission("orders.update")
      .input(
        z.object({
          orderId: z.number(),
          governorate: z.string().optional(),
          customerAddress: z.string().optional(),
          customerName: z.string().optional(),
          customerPhone: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        // Ownership check
        await assertEmployeeOwnsOrder(emp, input.orderId, "هذا الأوردر غير مخصص لك");
        const updates: any = { lastUpdatedBy: emp.id };
        if (input.governorate) updates.governorate = input.governorate;
        if (input.customerAddress)
          updates.customerAddress = input.customerAddress;
        if (input.customerName) updates.customerName = input.customerName;
        if (input.customerPhone) updates.customerPhone = input.customerPhone;
        await updateOrder(input.orderId, updates);
        return { success: true };
      }),

    // عرض المخزون المتبقي للموظفين (قراءة فقط)
    stockLevels: requireEmployeeTenantPermission("orders.view")
      .input(
        z
          .object({
            businessIds: z.array(z.number()).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const tenantId = requireTenantId(emp);
        const businessIds = await scopeBusinessIds(empScope(ctx), input);
        return stripCostUnlessAllowed(ctx, await getAllProducts(undefined, businessIds));
      }),

    // عرض variants المنتجات للموظف (مع الأسعار والمخزون)
    stockVariants: requireEmployeeTenantPermission("orders.view")
      .input(
        z
          .object({
            businessIds: z.array(z.number()).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const tenantId = requireTenantId(emp);
        const businessIds = await scopeBusinessIds(empScope(ctx), input);
        // التكلفة لا تظهر للموظف إلا بصلاحية التكلفة (كانت costPrice بترجع لأي موظف).
        return stripCostUnlessAllowed(ctx, await getAllVariantsWithProduct(undefined, businessIds));
      }),

    stats: requireEmployeeTenantPermission("dashboard.view")
      .input(
        z
          .object({
            businessIds: z.array(z.number()).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const tenantId = requireTenantId(emp);
        const filterBusinessIds = await scopeBusinessIds(empScope(ctx), input);
        // تفلتر بتاريخ التوزيع اليوم بتوقيت القاهرة
        const cairoOffset = 2 * 60 * 60 * 1000;
        const cairoNow = new Date(Date.now() + cairoOffset);
        const assignedDateFrom = new Date(
          Date.UTC(
            cairoNow.getUTCFullYear(),
            cairoNow.getUTCMonth(),
            cairoNow.getUTCDate(),
            0,
            0,
            0,
            0
          ) - cairoOffset
        );
        const assignedDateTo = new Date(
          assignedDateFrom.getTime() + 24 * 60 * 60 * 1000 - 1
        );
        const result = await getOrders({
          assignedEmployeeId: emp.id,
          assignedDateFrom,
          assignedDateTo,
          limit: 1000,
          businessIds: filterBusinessIds,
        });
        const all = result.orders;
        return {
          total: all.length,
          new: all.filter(o => o.status === "new").length,
          confirmed: all.filter(o => o.status === "confirmed").length,
          postponed: all.filter(o => o.status === "postponed").length,
          cancelled: all.filter(o => o.status === "cancelled").length,
          delivered: all.filter(o => o.status === "delivered").length,
          no_answer: all.filter(o => o.status === "no_answer").length,
        };
      }),

    // تعديل بيانات الأوردر بالكامل (للموظف العادي - بدون OAuth)
    editOrder: requireEmployeeTenantPermission("orders.update")
      .input(
        z.object({
          orderId: z.number(),
          customerName: z.string().optional(),
          customerPhone: z.string().optional(),
          customerPhone2: z.string().optional(),
          customerAddress: z.string().optional(),
          governorate: z.string().optional(),
          city: z.string().optional(),
          productId: z.number().optional(),
          productName: z.string().optional(),
          quantity: z.number().min(1).optional(),
          totalAmount: z.number().optional(),
          shippingFees: z.number().optional(),
          paymentMethod: z.string().optional(),
          notes: z.string().optional(),
          employeeNotes: z.string().optional(),
          variantId: z.number().nullable().optional(),
          color: z.string().nullable().optional(),
          size: z.string().nullable().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const { orderId, ...updates } = input;
        // الموظف يعدل أوردراته فقط (إلا لو مدير)
        await assertEmployeeOwnsOrder(
          emp,
          orderId,
          "لا يمكنك تعديل أوردر غير مسند إليك"
        );
        const result = await editOrderFull(orderId, updates, {
          id: emp.id,
          name: emp.name,
          role: emp.role,
        });
        return { success: true, order: result };
      }),

    // جلب سجل تعديلات أوردر
    getOrderEditHistory: requireEmployeeTenantPermission("orders.view")
      .input(
        z.object({
          orderId: z.number(),
        })
      )
      .query(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        await assertEmployeeOwnsOrder(
          emp,
          input.orderId,
          "لا يمكنك عرض سجل أوردر غير مسند إليك"
        );
        return getOrderEditLogs(input.orderId);
      }),

    // ==================== ORDER ITEMS ====================
    // The real lines, from `order_items`. The order header carries only one product, so an
    // order of "two of these plus one of those" reads as a single row there — this is the
    // only place the employee sees what the customer actually ordered.
    orderItems: requireEmployeeTenantPermission("orders.view")
      .input(z.object({ orderId: z.number() }))
      .query(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const order = await assertEmployeeOwnsOrder(
          emp,
          input.orderId,
          "لا يمكنك عرض بنود أوردر غير مسند إليك"
        );
        const items = await getOrderItems(input.orderId);
        // An order created before order_items was populated has none. Rather than showing an
        // empty basket — which the employee would "fix" by adding lines, silently doubling
        // the order — synthesise one line from the header and mark it so the UI can say so.
        if (items.length === 0) {
          return {
            items: [
              {
                id: null,
                productId: order.productId,
                productName: order.productName,
                variantId: order.variantId ?? null,
                variantName: null,
                quantity: order.quantity,
                unitPrice: null,
                discount: "0",
                size: order.size ?? null,
                color: order.color ?? null,
              },
            ],
            derivedFromHeader: true,
            shippingFees: order.shippingFees ?? "0",
            totalAmount: order.totalAmount,
          };
        }
        return {
          items: items.map(i => ({
            id: i.id,
            productId: i.productId,
            productName: i.productName,
            variantId: i.variantId,
            variantName: i.variantName,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            discount: i.discountAmountSnapshot,
            size: i.size,
            color: i.color,
          })),
          derivedFromHeader: false,
          shippingFees: order.shippingFees ?? "0",
          totalAmount: order.totalAmount,
        };
      }),

    /* نفس الصلاحية بالظبط اللي على مسار المالك — لكن بهوية البوابة (كانت permissionProcedure = جلسة المالك). */
    editOrderItems: requireEmployeeTenantPermission("orders.edit_items")
      .input(
        z.object({
          orderId: z.number(),
          items: z
            .array(
              z.object({
                productId: z.number().nullable(),
                productName: z.string().min(1).max(200),
                variantId: z.number().nullable(),
                quantity: z.number().int().min(1).max(999),
                unitPrice: z.number().min(0).max(1_000_000),
                discount: z.number().min(0).max(1_000_000),
                size: z.string().max(100).nullable().optional(),
                color: z.string().max(100).nullable().optional(),
              })
            )
            .min(1, "الأوردر لازم يكون فيه بند واحد على الأقل")
            .max(20, "أقصى عدد بنود ٢٠"),
          shippingFees: z.number().min(0).max(100_000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        await assertEmployeeOwnsOrder(
          emp,
          input.orderId,
          "لا يمكنك تعديل بنود أوردر غير مسند إليك"
        );
        const result = await replaceOrderItemsFromEditor(
          input.orderId,
          input.items.map(i => ({
            productId: i.productId,
            productName: i.productName,
            variantId: i.variantId,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            discount: i.discount,
            size: i.size ?? null,
            color: i.color ?? null,
          })),
          input.shippingFees,
          { id: emp.id, name: emp.name, role: emp.role }
        );
        await addActivityLog({
          action: "edit_order_items",
          entityType: "order",
          entityId: input.orderId,
          description: `تعديل بنود أوردر #${input.orderId} — ${result.itemCount} بند، إجمالي ${result.totalAmount}`,
          metadata: {
            orderId: input.orderId,
            itemCount: result.itemCount,
            totalAmount: result.totalAmount,
          },
          performedBy: emp.id,
          performedByName: emp.name,
          performedByRole: emp.role,
        });
        return { success: true, ...result };
      }),

    // ==================== SHIPMENTS TODAY ====================
    // Shipping operations, not order confirmation. Was employeePortalProcedure, which
    // only asks "is this an active employee" — so an order_confirmation agent could pull
    // the whole day's shipment manifest across every business in the tenant.
    // The shipping-schedule page read these through accountingV2.configurationListForBusinesses,
    // which is authenticatedProcedure — any employee at all. Same data, behind the same
    // permission the rest of the shipping screens use.
    // المنطق نفسه في shippingOperations.service.ts — مشترك مع `operations.*` (Operations
    // workspace بتاع المالك). البوابة هنا بتحسب النطاق زي ما كانت بالظبط.
    shippingRoutes: requireEmployeeTenantPermission("shipping_ops.view").query(
      async ({ ctx }) => {
        const emp = (ctx as any).employee;
        requireTenantId(emp);
        // fail-closed: نطاق فاضي/غير محدد → [NO_BUSINESS] (صفر) مش الكل — متّسق مع todayShipments.
        const businessIds = (await scopeBusinessIds(empScope(ctx), {})) ?? [NO_BUSINESS];
        return loadShippingRouteRows(businessIds);
      }
    ),

    todayShipments: requireEmployeeTenantPermission("shipping_ops.view")
      .input(
        z.object({
          date: z.string().optional(), // YYYY-MM-DD format, defaults to today
        })
      )
      .query(async ({ ctx, input }) => {
        // fail-closed: scopeBusinessIds بيطبّق denyWhenEmpty فموظف بلا نشاط (أو نطاق فاضي)
        // بيرجّع [NO_BUSINESS] = صفر أوردرات — **مايتحوّلش أبدًا لكل الأوردرات**. الـ`?? [NO_BUSINESS]`
        // بيغطّي حالة مالك المنصة (allowed=null) برضه بأمان.
        const businessIds =
          (await scopeBusinessIds(empScope(ctx), {})) ?? [NO_BUSINESS];
        return buildTodayShipments(businessIds, input.date);
      }),

    // مسح QR للموظف - تجهيز الأوردر
    scan: requireEmployeeTenantPermission("orders.view")
      .input(
        z.object({
          serialNumber: z.string(),
          deviceInfo: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const scannedBy = emp?.id ?? 0;
        const scannedByName = emp?.name ?? "موظف";
        const result = await scanOrderBySerial(
          input.serialNumber,
          scannedBy,
          scannedByName,
          input.deviceInfo
        );
        return result;
      }),

    // ==================== MANAGER PORTAL APIs ====================
    // Dashboard stats for manager
    dashboardStats: requireManagerPortalPermission("dashboard.view")
      .input(
        z.object({
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const tenantId = requireTenantId(emp);
        const businessIds = await scopeBusinessIds(empScope(ctx), input);
        return getDashboardStats(
          input.dateFrom,
          input.dateTo,
          undefined,
          businessIds
        );
      }),

    // All orders for manager (not just assigned)
    allOrders: requireManagerPortalPermission("orders.view")
      .input(
        z.object({
          status: z.string().optional(),
          source: z.string().optional(),
          governorate: z.string().optional(),
          assignedEmployeeId: z.number().optional(),
          websiteId: z.number().optional(),
          businessId: z.number().optional(),
          businessIds: z.array(z.number()).optional(),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          search: z.string().optional(),
          page: z.number().default(1),
          limit: z.number().default(50),
        })
      )
      .query(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const tenantId = requireTenantId(emp);
        const effectiveBusinessIds = await scopeBusinessIds(empScope(ctx), input);
        return getOrders({
          ...input,
          businessId: undefined,
          businessIds: effectiveBusinessIds,
        });
      }),

    // Assign order to employee
    assignOrder: requireManagerPortalPermission("orders.update")
      .input(
        z.object({
          orderId: z.number(),
          employeeId: z.number(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        await requireOwned(empScope(ctx), "order", input.orderId);
        // P0: المستلم لازم يكون في نطاق الجلسة — كان أي employeeId من أي tenant مقبول.
        await requireOwned(empScope(ctx), "employee", input.employeeId);
        await assignOrderToEmployee(input.orderId, input.employeeId, emp.id, portalEventCtx(ctx, "employee_portal", input.operationId));
        return { success: true };
      }),

    // Bulk assign orders
    bulkAssignOrders: requireManagerPortalPermission("orders.update")
      .input(
        z.object({
          orderIds: z.array(z.number()),
          employeeId: z.number(),
          operationId: operationIdInput,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const tenantId = requireTenantId(emp);
        await requireAllOwned(empScope(ctx), "order", input.orderIds);
        await requireOwned(empScope(ctx), "employee", input.employeeId);
        await bulkAssignOrders(input.orderIds, input.employeeId, emp.id, portalEventCtx(ctx, "bulk", input.operationId));
        return { success: true };
      }),

    // Create order
    createOrder: requireManagerPortalPermission("orders.create")
      .input(
        z.object({
          customerName: z.string().min(2),
          customerPhone: z.string().min(10),
          customerAddress: z.string().min(5),
          governorate: z.string().min(2),
          productId: z.number(),
          productName: z.string(),
          quantity: z.number().min(1).default(1),
          totalAmount: z.string(),
          source: z.string().min(1).max(60),
          notes: z.string().optional(),
          websiteId: z.number().optional(),
          businessId: z.number().optional(),
          variantId: z.number().optional(),
          // بنود متعددة (أنواع حفر مختلفة) — اختياري، لو موجود يتجاوز productId/quantity المفرد
          selectedProducts: z
            .array(
              z.object({
                productId: z.number().int().min(1),
                productName: z.string().min(1),
                quantity: z.number().int().min(1).optional(),
              })
            )
            .optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const orderNumber = await generateOrderNumber();
        const tenantId = requireTenantId(emp);
        const effectiveBusinessId =
          input.businessId != null
            ? await scopeBusinessId(empScope(ctx), input.businessId)
            : (emp.businessId ?? undefined);
        // تجهيز البنود؛ لو مفيش selectedProducts نستخدم المنتج المفرد
        const items =
          input.selectedProducts && input.selectedProducts.length > 0
            ? input.selectedProducts.map(p => ({
                ...p,
                quantity: p.quantity ?? 1,
              }))
            : [
                {
                  productId: input.productId,
                  productName: input.productName,
                  quantity: input.quantity,
                },
              ];
        const totalQty =
          items.reduce((sum, p) => sum + p.quantity, 0) || input.quantity || 1;
        const productNames = items
          .map(p =>
            p.quantity > 1 ? `${p.productName} ×${p.quantity}` : p.productName
          )
          .join(" + ");
        const firstProductId = items[0].productId;
        if (effectiveBusinessId == null)
          throw new TRPCError({ code: "BAD_REQUEST", message: "النشاط مطلوب" });
        // P0: المنتجات والـvariant لازم يكونوا في نطاق الجلسة قبل أي كتابة — كان أي productId مقبول.
        await requireAllOwned(empScope(ctx), "product", items.map(p => p.productId));
        if (input.variantId != null)
          await requireOwned(empScope(ctx), "variant", input.variantId);
        const newOrderId = await createOrderWithItems(
          {
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            customerAddress: input.customerAddress,
            governorate: input.governorate,
            productId: firstProductId,
            productName: productNames,
            quantity: totalQty,
            totalAmount: input.totalAmount,
            source: input.source,
            notes: input.notes,
            orderNumber,
            lastUpdatedBy: emp.id,
            businessId: effectiveBusinessId,
            websiteId: input.websiteId ?? null,
            variantId: input.variantId ?? null,
          },
          items.map(p => ({
            productId: p.productId,
            productName: p.productName,
            quantity: p.quantity,
            variantId:
              p.productId === firstProductId
                ? (input.variantId ?? undefined)
                : undefined,
          }))
        );
        return { success: true, orderNumber };
      }),

    // Products list
    // المخزون بصلاحية inventory.view (الافتراضي: المالك/الأدمن/المدير/المخزن) بدل فحص الدور الحرفي.
    productsList: requireEmployeeTenantPermission("inventory.view").query(async ({ ctx }) => {
      // P0: نطاق الجلسة (tenant + نشاط الموظف) — كان `emp.businessId ?? undefined` = كل الـtenants لو null.
      return stripCostUnlessAllowed(ctx, await getAllProducts(undefined, await scopeBusinessIds(empScope(ctx), {})));
    }),
    // Low stock products
    lowStockProducts: requireEmployeeTenantPermission("inventory.view").query(async ({ ctx }) => {
      return stripCostUnlessAllowed(ctx, await getLowStockProducts(undefined, await scopeBusinessIds(empScope(ctx), {})));
    }),
    // Add inventory movement
    addInventoryMovement: requireEmployeeTenantPermission("inventory.adjust")
      .input(
        z.object({
          productId: z.number(),
          type: z.enum(["in", "out"]),
          quantity: z.number().min(1),
          reason: z.string().optional(),
          orderId: z.number().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        // المنتج لازم يكون داخل نطاق الموظف (tenant + نشاطه) — كان بيقبل أي productId.
        await requireOwned(empScope(ctx), "product", input.productId);
        const product = await getProductById(input.productId);
        if (!product) throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });
        // الربط بأوردر اختياري — بيتفحص لما يتبعت بس.
        if (input.orderId != null)
          await requireOwned(empScope(ctx), "order", input.orderId);
        await addInventoryMovement({
          ...input,
          businessId: product.businessId,
          performedBy: emp.id,
        });
        return { success: true };
      }),
    // Inventory movements
    inventoryMovements: requireEmployeeTenantPermission("inventory.view")
      .input(
        z.object({
          productId: z.number().optional(),
          limit: z.number().default(50),
        })
      )
      .query(async ({ ctx, input }) => {
        if (input.productId != null)
          await requireOwned(empScope(ctx), "product", input.productId);
        return getInventoryMovements(
          input.productId,
          input.limit,
          undefined,
          await scopeBusinessIds(empScope(ctx), {})
        );
      }),

    // Employee performance report
    employeePerformance: requireManagerPortalPermission("dashboard.view")
      .input(
        z.object({
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        // fail-closed: نطاق أنشطة الجلسة (متقيّد بالـtenant)؛ null/بلا نشاط → [-1] → صفر،
        // مش `emp.businessId ?? undefined` اللي بيرجّع كل التينانتات لو النشاط null.
        const businessIds = await scopeBusinessIds(empScope(ctx), {});
        const [perf, emps] = await Promise.all([
          getEmployeePerformance(input.dateFrom, input.dateTo, undefined, businessIds),
          getAllEmployees(undefined, businessIds),
        ]);
        return perf.map(p => {
          const emp = emps.find(e => e.id === p.employeeId);
          return {
            ...p,
            employeeName: emp?.name ?? "غير معروف",
            total: Number(p.total),
            confirmed: Number(p.confirmed),
            cancelled: Number(p.cancelled),
            postponed: Number(p.postponed),
            delivered: Number(p.delivered),
            confirmRate:
              p.total > 0
                ? Math.round((Number(p.confirmed) / Number(p.total)) * 100)
                : 0,
            cancelRate:
              p.total > 0
                ? Math.round((Number(p.cancelled) / Number(p.total)) * 100)
                : 0,
          };
        });
      }),

    // Cancellation reasons
    cancellationReasons: requireManagerPortalPermission("dashboard.view")
      .input(
        z.object({
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        // P0: نطاق الجلسة fail-closed (بلا نشاط → صفر)، مش `emp.businessId ?? undefined`.
        return getCancellationReasons(
          input.dateFrom,
          input.dateTo,
          undefined,
          await scopeBusinessIds(empScope(ctx), {})
        );
      }),

    // Daily chart
    dailyChart: requireManagerPortalPermission("dashboard.view")
      .input(
        z.object({
          days: z.number().int().min(1).max(366).default(30),
        })
      )
      .query(async ({ ctx, input }) => {
        // P0: الاستعلام نفسه مالوش شرط tenant — النطاق هو الحارس الوحيد. كان `emp.businessId ?? undefined`
        // فمدير بلا نشاط بيشوف أعداد أوردرات **كل الـtenants**.
        return getDailyOrdersChart(input.days, undefined, await scopeBusinessIds(empScope(ctx), {}));
      }),

    // Employees list
    employeesList: requireManagerPortalPermission("employees.view").query(async ({ ctx }) => {
      // fail-closed: نطاق الجلسة، مش `emp.businessId ?? undefined` (null → الكل).
      const businessIds = await scopeBusinessIds(empScope(ctx), {});
      return getAllEmployees(undefined, businessIds);
    }),

    // Active employees list
    activeEmployeesList: requireManagerPortalPermission("employees.view").query(async ({ ctx }) => {
      const businessIds = await scopeBusinessIds(empScope(ctx), {});
      return getActiveEmployees(undefined, businessIds);
    }),

    // Create employee
    createEmployee: requireManagerPortalPermission("employees.manage")
      .input(
        z.object({
          name: z.string().min(2),
          phone: z.string().optional(),
          email: z.string().email().optional(),
          role: z
            .enum([
              "agent",
              "warehouse",
              "manager",
              "facebook_entry",
              "scanner",
            ])
            .default("agent"),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const tenantId = requireTenantId(emp);
        // نفس الحارس — لو نشاط المدير نفسه فاضي (legacy)، بيتحلّ لنشاط التينانت مش null.
        const businessId = await resolveEmployeeBusinessId(
          empScope(ctx),
          emp.businessId ?? undefined
        );
        await createEmployee({
          ...input,
          businessId,
          tenantId,
        });
        return { success: true };
      }),

    // Update employee
    updateEmployee: requireManagerPortalPermission("employees.manage")
      .input(
        z.object({
          id: z.number(),
          name: z.string().min(2).optional(),
          phone: z.string().optional(),
          email: z.string().email().optional(),
          role: z
            .enum([
              "agent",
              "warehouse",
              "manager",
              "facebook_entry",
              "scanner",
            ])
            .optional(),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(empScope(ctx), "employee", input.id);
        const { id, ...data } = input;
        await updateEmployee(id, data);
        return { success: true };
      }),

    // Delete employee
    deleteEmployee: requireManagerPortalPermission("employees.manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireOwned(empScope(ctx), "employee", input.id);
        await deleteEmployee(input.id);
        return { success: true };
      }),

    // Set employee credentials
    setEmployeeCredentials: requireManagerPortalPermission("employees.manage")
      .input(
        z.object({
          id: z.number(),
          username: z.string().min(3).max(50),
          password: z.string().min(6),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(empScope(ctx), "employee", input.id);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const existing = await db
          .select()
          .from(employees)
          .where(eq(employees.username, input.username))
          .limit(1);
        if (existing.length > 0 && existing[0].id !== input.id) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "اسم المستخدم مستخدم بالفعل",
          });
        }
        const passwordHash = await bcrypt.hash(input.password, 10);
        await db
          .update(employees)
          .set({ username: input.username, passwordHash })
          .where(eq(employees.id, input.id));
        return { success: true };
      }),

    // Change employee password
    changeEmployeePassword: requireManagerPortalPermission("employees.manage")
      .input(
        z.object({
          id: z.number(),
          newPassword: z.string().min(6),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(empScope(ctx), "employee", input.id);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const passwordHash = await bcrypt.hash(input.newPassword, 10);
        await db
          .update(employees)
          .set({ passwordHash })
          .where(eq(employees.id, input.id));
        return { success: true };
      }),

    // ==================== BROADCAST MESSAGES ====================
    // إرسال رسالة لجميع الموظفين (من لوحة المدير - employee session)
    // P0 عزل: الرسالة بتتكتب بنشاط المدير، والإلغاء والقراءة على نطاق الجلسة بس — كان الإرسال
    // بيعطّل رسائل **كل** الشركات، والقراءة بترجّع آخر رسالة في النظام كله.
    sendBroadcast: requireManagerPortalPermission("employees.manage")
      .input(
        z
          .object({
            message: z.string().min(1).max(500),
          })
          .strict()
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const scope = await portalTeamScope(ctx);
        return sendScopedBroadcast(scope, input.message, emp.id, emp.name);
      }),

    // حذف الرسالة النشطة (من لوحة المدير - employee session) — نطاق الجلسة بس
    clearBroadcast: requireManagerPortalPermission("employees.manage").mutation(async ({ ctx }) => {
      const scope = await portalTeamScope(ctx);
      return clearScopedBroadcast(scope);
    }),

    // جلب الرسالة النشطة (للموظفين - employee session) — من نشاط الموظف بس
    activeBroadcast: employeePortalProcedure.query(async ({ ctx }) => {
      const scope = await portalTeamScope(ctx);
      return getScopedActiveBroadcast(scope);
    }),

    // ==================== الأوردرات المكررة ====================
    // تعليم أوردر كمكرر (من الموظف)
    markDuplicate: requireEmployeeTenantPermission("orders.update")
      .input(
        z.object({
          orderId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        await requireOwned(empScope(ctx), "order", input.orderId);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orders } = await import("../drizzle/schema");
        await db
          .update(orders)
          .set({
            isDuplicate: true,
            duplicateMarkedAt: new Date(),
            duplicateMarkedBy: emp.id,
          })
          .where(eq(orders.id, input.orderId));
        return { success: true };
      }),

    // إلغاء تعليم التكرار (من الموظف)
    unmarkDuplicate: requireEmployeeTenantPermission("orders.update")
      .input(
        z.object({
          orderId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(
          empScope(ctx),
          "order",
          input.orderId
        );
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orders } = await import("../drizzle/schema");
        await db
          .update(orders)
          .set({
            isDuplicate: false,
            duplicateMarkedAt: null,
            duplicateMarkedBy: null,
          })
          .where(eq(orders.id, input.orderId));
        return { success: true };
      }),
  }),

  // ==================== الأوردرات المكررة (لوحة المدير) ====================
  duplicates: router({
    // جلب كل الأوردرات المعلمة كمكررة
    list: adminProcedure.query(async () => {
      const db = await getDb();
      if (!db) return [];
      const { orders } = await import("../drizzle/schema");
      return db
        .select()
        .from(orders)
        .where(eq(orders.isDuplicate, true))
        .orderBy(desc(orders.duplicateMarkedAt));
    }),

    // حذف أوردر مكرر (من لوحة المدير)
    delete: ownerProcedure
      .input(
        z.object({
          orderId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        // المسار الوحيد للحذف — بيمسح الأصناف مع الأوردر (منع الـorphans).
        await withStatusGuard(() => deleteOrder(input.orderId));
        return { success: true };
      }),

    // إلغاء تعليم التكرار (إعادة للأوردرات العادية)
    restore: adminProcedure
      .input(
        z.object({
          orderId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(
          empScope(ctx),
          "order",
          input.orderId
        );
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orders } = await import("../drizzle/schema");
        await db
          .update(orders)
          .set({
            isDuplicate: false,
            duplicateMarkedAt: null,
            duplicateMarkedBy: null,
          })
          .where(eq(orders.id, input.orderId));
        return { success: true };
      }),

    // حذف جميع المكررات
    deleteAll: ownerProcedure.mutation(async () => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      const { orders } = await import("../drizzle/schema");
      // بنجيب المعرّفات الأول وبعدين نمرّها على نفس helper الحذف — عشان الأصناف تتمسح
      // مع الأوردرات (مش db.delete(orders) خام اللي كان بيسيب أصناف يتيمة).
      const dupRows = await db
        .select({ id: orders.id })
        .from(orders)
        .where(eq(orders.isDuplicate, true));
      const ids = dupRows.map(r => r.id);
      await withStatusGuard(() => deleteOrders(ids));
      return { deleted: ids.length };
    }),
  }),

  // ==================== FACEBOOK ENTRY (موظف إدخال فيسبوك) ====================
  facebookEntry: router({
    // إضافة أوردر فيسبوك يدوياً
    addOrder: requireEmployeeTenantPermission("orders.create")
      .input(
        z.object({
          customerName: z.string().min(1),
          customerPhone: z.string().min(5),
          /** رقم إضافي لو العميل كتب رقمين («رقم الفون(٢)») — منفصل عن العنوان. */
          customerPhone2: z.string().max(20).optional(),
          governorate: z.string().min(1),
          customerAddress: z.string().min(1),
          /** City / area within the governorate, when the message mentioned one. */
          city: z.string().optional(),
          selectedProducts: z
            .array(
              z.object({
                // Optional: an item the parser could not match is still recorded (with its raw
                // text) and the order is flagged for review, rather than being dropped or
                // silently attached to an arbitrary product.
                productId: z.number().int().min(1).optional(),
                productName: z.string().min(1),
                quantity: z.number().int().min(1).optional(),
                /** Engraving type / variant for this specific item. */
                variantId: z.number().int().optional(),
                unitPrice: z.number().min(0).optional(),
                /** مصدر السعر (للسجل فقط — بيتحفظ في audit مش في order_items). */
                priceSource: z.enum(PRICE_SOURCE).optional(),
              })
            )
            .min(1),
          quantity: z.number().int().min(1).optional(),
          totalAmount: z.number().min(0),
          shippingCost: z.number().min(0).optional(),
          discount: z.number().min(0).optional(),
          /** توكن التحليل الموقّع من parsePaste — إجباري مع rawText (أوردر ناتج عن لصق). */
          parseToken: z.string().max(2000).optional(),
          /** ناتج التحليل كما عرضته الواجهة (للسجل؛ التحقق بيتم بإعادة التحليل على السيرفر). */
          parseResult: parseResultV2Schema.optional(),
          adName: z.string().optional(),
          pageName: z.string().optional(),
          notes: z.string().optional(),
          /** Original pasted message, kept verbatim for audit when the parser was used. */
          rawText: z.string().optional(),
          // حقول كفر مرتبة ووتر بروف
          variantId: z.number().int().optional(),
          size: z.string().optional(),
          color: z.string().optional(),
          /**
           * منع تكرار الإنشاء (0052): معرّف ثابت للعملية من الواجهة — إعادة المحاولة بعد انقطاع الشبكة بنفس المعرّف تعيد
           * نفس الأوردر. اختياري للعملاء القدامى: بدونه الطلب غير محمي ولا يُولَّد له معرّف على السيرفر.
           */
          operationId: z.string().regex(OPERATION_ID_RE).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orders } = await import("../drizzle/schema");
        // العزل: النشاط **إجباريًا من جلسة الموظف**، مش من input العميل ولا القيمة الافتراضية
        // (businessId=1). موظف بلا نشاط صالح → fail-closed (مفيش أوردر يتكتب).
        const businessId = await resolveEmployeeBusinessId(empScope(ctx));

        // ── منع التكرار (0052): نطاق الشركة + نشاط الجلسة + نوع العملية + معرّف الواجهة، والبيانات بلا المعرّف ──
        const { operationId, ...requestPayload } = input;
        const createOrder = async (record: IdemRecord | null) => {
          // ── أوردر ناتج عن لصق: التحقق **على السيرفر** بإعادة تحليل النص نفسه ──
          //
          // الـmetadata الجاية من المتصفح مش مرجعًا: rawText + parseToken لازم ييجوا سوا،
          // التوكن موقّع (موظف + نشاط + hash النص) فمش قابل للتعديل، والنص بيتحلّل تاني
          // بنفس analyzePasteV2 على كتالوج النشاط الحالي (حتمي، بلا AI) — والقواعد تتطبّق
          // على اللي اتحلّل هنا مش على اللي العميل قاله. الأوردر اليدوي (بلا الاتنين)
          // بيفضل بقواعده الحالية.
          const pasteOrigin = input.rawText != null || input.parseToken != null || input.parseResult != null;
          let verifiedParse: Awaited<ReturnType<typeof analyzePasteV2>> | null = null;
          let canonLines: ReturnType<typeof canonicalParse>["lines"] | null = null;
          if (pasteOrigin) {
            // 1) rawText + parseToken + parseResult لازم سوا — حذف أي واحد مش «أوردر يدوي».
            if (!input.rawText || !input.parseToken || !input.parseResult)
              throw new TRPCError({ code: "BAD_REQUEST", message: "بيانات التحليل ناقصة — أعد تحليل الرسالة ثم احفظ" });
            // 2) التوقيع + الموظف + النشاط + النص + بصمة النتيجة القانونية + الصلاحية (ساعتان).
            const tok = verifyParseToken(input.parseToken, {
              employeeId: ctx.employee.id, businessId, rawText: input.rawText, fingerprint: canonicalFingerprint(input.parseResult),
            });
            if (!tok.ok) throw new TRPCError({ code: "BAD_REQUEST", message: PARSE_TOKEN_MESSAGES[tok.reason] });
            // 3) إعادة التحليل الحتمي للحقول الصريحة والحسابات (بلا أي AI هنا) — لازم تطابق
            //    الإجماليات الموقّعة، وإلا الرسالة/الكتالوج اتغيّروا ويلزم تحليل جديد.
            const catalogIds = await employeeCatalogBusinessIds(empScope(ctx));
            const catalog = catalogIds.length ? await getMatchCatalog(undefined, catalogIds) : { products: [], variants: [] };
            verifiedParse = await analyzePasteV2(input.rawText, catalog, {});
            const canon = canonicalParse(input.parseResult);
            const fresh = canonicalParse(verifiedParse);
            if (JSON.stringify(fresh.totals) !== JSON.stringify(canon.totals))
              throw new TRPCError({ code: "BAD_REQUEST", message: "أرقام الرسالة تغيّرت عن نتيجة التحليل — أعد التحليل ثم احفظ" });
            // 4) السطور النهائية **مستقلة عن اقتراح التحليل**: الموظفة تضيف/تحذف/تقسم/تدمج
            //    وتغيّر النوع. هنا بس: مفيش سطر بلا منتج. الملكية للنشاط وتبعية التركيبة لمنتجها
            //    بيتفحصوا تحت لكل سطر، والكميات/الأسعار/الإجماليات في الخطوة 5.
            const missing = finalLinesBlocker(input.selectedProducts);
            if (missing) throw new TRPCError({ code: "BAD_REQUEST", message: missing });
            canonLines = canon.lines;
            // 5) القواعد الحسابية على الإجماليات المتحقَّق منها.
            const num = (v: unknown) => (typeof v === "number" ? v : null);
            const blockers = pasteSaveBlockers(
              input.selectedProducts.map(p => ({ quantity: p.quantity ?? 1, unitPrice: p.unitPrice ?? 0, resolved: p.productId != null })),
              {
                pieces: num(fresh.totals.pieces),
                itemsTotal: num(fresh.totals.itemsTotal),
                shipping: input.shippingCost ?? num(fresh.totals.shipping) ?? 0,
                discount: input.discount ?? num(fresh.totals.discount) ?? 0,
              },
              input.totalAmount
            );
            if (blockers.length)
              throw new TRPCError({ code: "BAD_REQUEST", message: blockers.join(" · ") });
          }
          // عدد القطع لكل بند (افتراضي 1 لو غير محدد)
          // كل منتج مختار لازم يكون في نطاق الموظف — الإنشاء بيربط الأوردر بيهم.
          await requireAllOwned(
            empScope(ctx),
            "product",
            input.selectedProducts
              .map(p => p.productId)
              .filter((id): id is number => id != null)
          );
          // تحقّق **الملكية والتركيب** لكل بند — مش المخزون.
          //
          // المخزون مابيمنعش تسجيل أوردر: العميل طلب قطعتين والمتاح واحدة = أوردر حقيقي
          // لازم يتسجّل بكميته الصحيحة. سياسة `confirmOrder` المعتمدة أصلاً مابتمنعش
          // التأكيد بسبب العجز (بتعلّم needsReview بدل ما ترفض)، فمنع الإدخال كان أقسى
          // من التأكيد نفسه وكان بيخلي الموظف يزوّر الكمية عشان يعدّي.
          // اللون/المقاس لكل بند بيتاخدوا من **تركيبته هو**، مش من هيدر الأوردر.
          // كانوا بيتنسخوا من `input.color/size` للبند الأول بس، فأوردر بقطعتين
          // بتركيبتين مختلفتين كان بيسجّل البند التاني بلون ومقاس فاضيين.
          const variantById = new Map<number, { color: string | null; size: string | null }>();
          for (const p of input.selectedProducts) {
            if (p.variantId == null) continue;
            // variantId من غير productId ممنوع — مايبقاش فيه منتج نتحقّق التركيبة ضده.
            if (p.productId == null)
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "لازم تحدّد المنتج مع التركيبة",
              });
            const variant = await getVariantById(p.variantId);
            // التركيبة لازم تتبع **نفس المنتج**؛ والمنتج نفسه اتأكّد إنه تابع لنشاط الموظف
            // أعلاه (requireAllOwned) — فمستحيل تمرير تركيبة من منتج/نشاط تاني.
            if (!variant || variant.productId !== p.productId)
              throw new TRPCError({
                code: "BAD_REQUEST",
                message: "التركيبة غير صحيحة لهذا المنتج",
              });
            variantById.set(p.variantId, { color: variant.color, size: variant.size });
          }
          // **الاسم من كتالوج النشاط، مش من العميل** — وقبل أي كتابة.
          //
          // `order_items` بيتصحّح جوه replaceOrderItems بـwithCatalogProductNames، لكن مرآة
          // الهيدر كانت بتتبني من نص العميل — فعميل API قديم أو طلب مباشر يقدر يحط اسمًا
          // مركّبًا («أسورة نحاس - آية الكرسي») أو اسم منتج تاني خالص في الهيدر، وتفضل
          // المرآة مخالفة للبنود. البند اللي مالوش productId (صنف ما اتطابقش) بيحتفظ بنصّه
          // الخام عن قصد — ده اللي الموظف بيعيّنه يدويًا بعدين.
          const catalogNames = await getOwnedProductNames(
            businessId,
            input.selectedProducts
              .map(p => p.productId)
              .filter((id): id is number => id != null)
          );
          const itemsWithQty = input.selectedProducts.map(p => ({
            ...p,
            productName:
              (p.productId != null ? catalogNames.get(p.productId) : undefined) ??
              p.productName,
            quantity: p.quantity ?? 1,
          }));
          // العدد الإجمالي = مجموع كميات البنود
          const totalQty =
            itemsWithQty.reduce((sum, p) => sum + p.quantity, 0) ||
            input.quantity ||
            1;
          // مرآة الهيدر: أسماء المنتجات وأعدادها فقط (نوع الحفر في variantId لكل بند).
          const productNames = buildOrderHeaderName(itemsWithQty);

          // Any item without a resolved product means the order needs a human to finish
          // mapping it. It is still created — never dropped — but flagged, and the header
          // productId points at the first RESOLVED item (or null when none resolved) rather
          // than at an arbitrary product.
          const unresolved = itemsWithQty.filter(p => !p.productId);
          const needsReview = unresolved.length > 0;
          const firstResolved = itemsWithQty.find(p => p.productId);
          const headerProductId = firstResolved?.productId ?? null;
          const headerVariantId =
            firstResolved?.variantId ?? input.variantId ?? null;

          const normalizedCustomerPhone =
            normalizeEgyptianPhone(input.customerPhone) || input.customerPhone;
          // البنود بتتجهّز قبل أي كتابة، وبعدين الهيدر والبنود في **transaction واحدة**
          // (`insertOrderWithItems`): نجاح كامل أو rollback كامل. قبل كده كانوا في
          // transactionين، فلو البنود فشلت (deadlock بين أوردرين متزامنين مثلًا) كان بيفضل
          // أوردر يتيم بلا بنود. إعادة المحاولة عند الـdeadlock بنفس الرقم؛ وتصادم رقم الأوردر
          // (القيد الفريد orders_orderNumber_unique — عام لكل الشركات) = رقم جديد بمعاملة جديدة،
          // 3 محاولات إجمالًا (withFreshNumber). أي خطأ تاني بيطلع كما هو.
          const itemRows = itemsWithQty.map(p => ({
            productId: p.productId,
            productName: p.productName,
            quantity: p.quantity,
            unitPrice: p.unitPrice,
            // Each item carries its OWN variant now (previously only the first product could
            // have one, which made multi-engraving orders impossible to represent).
            variantId: p.variantId,
            // من التركيبة نفسها؛ ولو البند بلا تركيبة بنرجع لحقول الهيدر (منتج بسيط).
            size:
              (p.variantId != null ? variantById.get(p.variantId)?.size : null) ??
              (p.productId === headerProductId ? (input.size ?? undefined) : undefined) ??
              undefined,
            color:
              (p.variantId != null ? variantById.get(p.variantId)?.color : null) ??
              (p.productId === headerProductId ? (input.color ?? undefined) : undefined) ??
              undefined,
          }));
          const { number: orderNumber, value: newOrderId } = await withFreshNumber(numberSource.fbOrder, orderNumber => insertOrderWithItems(
            {
              orderNumber,
              businessId,
              customerName: input.customerName,
              customerPhone: normalizedCustomerPhone,
              customerPhone2: input.customerPhone2?.trim()
                ? normalizeEgyptianPhone(input.customerPhone2) || input.customerPhone2.trim()
                : null,
              governorate: input.governorate,
              customerAddress: input.customerAddress,
              city: input.city ?? null,
              productId: headerProductId,
              productName: productNames,
              quantity: totalQty,
              totalAmount: input.totalAmount.toString(),
              shippingFees:
                input.shippingCost != null
                  ? input.shippingCost.toString()
                  : undefined,
              source: "facebook",
              adName: input.adName ?? null,
              pageName: input.pageName ?? null,
              notes: input.notes ?? null,
              status: "new",
              lastUpdatedBy: ctx.employee.id,
              variantId: headerVariantId,
              size: input.size ?? null,
              color: input.color ?? null,
              needsReview,
              reviewReason: needsReview
                ? `أصناف غير مطابقة تحتاج تعيين منتج يدويًا: ${unresolved.map(u => u.productName).join(" | ")}`
                : null,
              // Verbatim pasted message for audit, when the paste parser was used.
              externalRawPayload: input.rawText ?? null,
            } as any,
            itemRows,
            // مفتاح منع التكرار داخل نفس معاملة الهيدر والبنود
            record ? (tx, id) => record(tx, { id, reference: orderNumber }) : undefined
          ), err => isUniqueKeyCollision(err, "orders_orderNumber_unique"));
          // سجل التحليل (fail-safe قبل 0038): اللي اتحقق على السيرفر + اللي اتحفظ فعلًا
          // + اللي الواجهة عرضته (لو اتبعت). مفيش أي عمود جديد في order_items.
          if (verifiedParse && input.rawText) {
            await insertOrderParseAudit({
              tenantId: ctx.employee.tenantId as number,
              businessId,
              orderId: newOrderId,
              parserVersion: verifiedParse.parserVersion,
              // مصدر التحليل من النتيجة الموقّعة (بتشمل مطابقات الـAI)؛ إعادة التحليل هنا حتمية.
              parseSource: input.parseResult?.parseSource ?? verifiedParse.parseSource,
              rawText: input.rawText,
              resultJson: JSON.stringify({
                verified: verifiedParse,
                client: input.parseResult ?? null,
                // اقتراح التحليل الأصلي محفوظ في client/verified؛ هنا السطور النهائية كما اختارتها
                // الموظفة، مع تصنيف كل سطر (مقبول/مصحَّح) وعلامة التعديل البنيوي.
                resolution: (() => {
                  const cls = classifyFinalLines(canonLines ?? [], itemsWithQty.map(p => ({ productId: p.productId ?? null, variantId: p.variantId ?? null, quantity: p.quantity })));
                  return { status: cls.structurallyEdited ? "employee_corrected" : "accepted", structurallyEdited: cls.structurallyEdited };
                })(),
                saved: (() => {
                  const cls = classifyFinalLines(canonLines ?? [], itemsWithQty.map(p => ({ productId: p.productId ?? null, variantId: p.variantId ?? null, quantity: p.quantity })));
                  return itemsWithQty.map((p, i) => ({ ...cls.lines[i], quantity: p.quantity, unitPrice: p.unitPrice ?? null, priceSource: p.priceSource ?? null }));
                })(),
                totals: { totalAmount: input.totalAmount, shipping: input.shippingCost ?? null, discount: input.discount ?? null },
              }),
            });
          }
          return { success: true as const, orderNumber, needsReview };
        };
        return runIdempotent({
          db,
          scope: operationId ? { tenantId: ctx.employee.tenantId as number, businessId, operation: "order.create", operationId } : null,
          payload: requestPayload,
          actor: { type: "employee", id: ctx.employee.id },
          // الإعادة بنطاق نشاط الجلسة: الأوردر لازم يكون لسه موجود في نفس النشاط، وإلا رفض (لا إنشاء جديد بنفس المعرّف)
          replay: async row => {
            const [o] = await db.select({ orderNumber: orders.orderNumber, needsReview: orders.needsReview }).from(orders)
              .where(and(eq(orders.id, row.resultId), eq(orders.businessId, businessId))).limit(1);
            if (!o) throw new TRPCError({ code: "CONFLICT", message: `هذه العملية نُفّذت سابقًا (${row.resultReference}) والأوردر لم يعد موجودًا — لن يُنشأ أوردر جديد بنفس المعرّف` });
            return { success: true as const, orderNumber: o.orderNumber, needsReview: Boolean(o.needsReview) };
          },
          execute: createOrder,
        });
      }),

    // جلب أوردرات الموظف الحالي (فيسبوك)
    myOrders: requireEmployeeTenantPermission("orders.view")
      .input(
        z.object({
          dateFrom: z.string().optional(),
          dateTo: z.string().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db) return [];
        const { orders } = await import("../drizzle/schema");
        const { and, gte, lte } = await import("drizzle-orm");
        // ملكية موظف الإدخال (مؤقتًا عبر lastUpdatedBy لحد ما يتطبّق Migration 0036 وينضاف
        // createdByEmployeeId الثابت). العزل الأساسي بالنشاط تحت. + عزل بالـbusinessId.
        const conditions: any[] = [
          eq(orders.source, "facebook"),
          eq(orders.lastUpdatedBy, ctx.employee.id),
        ];
        // Filter by employee's businessId
        if (ctx.employee.businessId) {
          conditions.push(eq(orders.businessId, ctx.employee.businessId));
        }
        if (input.dateFrom) {
          conditions.push(gte(orders.createdAt, new Date(input.dateFrom)));
        }
        if (input.dateTo) {
          const end = new Date(input.dateTo);
          end.setHours(23, 59, 59, 999);
          conditions.push(lte(orders.createdAt, end));
        }
        const rows = await db
          .select()
          .from(orders)
          .where(and(...conditions))
          .orderBy(desc(orders.createdAt))
          .limit(200);
        // إرفاق بنود كل أوردر
        const itemsMap = await getOrderItemsForOrders(rows.map(o => o.id));
        return rows.map(o => ({ ...o, items: itemsMap.get(o.id) ?? [] }));
      }),

    // حذف أوردر (الموظف يحذف أوردر دخله هو فقط)
    deleteOrder: requireEmployeeTenantPermission("orders.create")
      .input(
        z.object({
          orderId: z.number().int().min(1),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // العزل: الأوردر لازم يكون تابع لنشاط/tenant الموظف (requireOwned). وملكية «مين
        // دخله» مقيّدة تحت (lastUpdatedBy مؤقتًا — البديل الثابت createdByEmployeeId مرهون
        // بـMigration 0036 المقترح، مش متطبّق دلوقتي).
        await requireOwned(
          empScope(ctx),
          "order",
          input.orderId
        );
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orders } = await import("../drizzle/schema");
        // ملكية موظف الإدخال (مؤقتًا عبر lastUpdatedBy لحد تطبيق Migration 0036 — العزل الأساسي
        // بالنشاط عبر requireOwned فوق). createdByEmployeeId الثابت هيرجع بعد الـmigration.
        const [order] = await db
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.id, input.orderId),
              eq(orders.lastUpdatedBy, ctx.employee.id),
              eq(orders.source, "facebook")
            )
          )
          .limit(1);
        if (!order)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "الأوردر غير موجود أو ليس من إدخالك",
          });
        // نفس helper الحذف — بيمسح الأصناف مع الأوردر (منع الـorphans).
        await withStatusGuard(() => deleteOrder(input.orderId));
        return { success: true };
      }),

    // تعديل أوردر (الموظف يعدل أوردر دخله هو فقط)
    updateOrder: requireEmployeeTenantPermission("orders.create")
      .input(
        z.object({
          orderId: z.number().int().min(1),
          customerName: z.string().min(1),
          customerPhone: z.string().min(5),
          customerPhone2: z.string().max(20).optional(),
          governorate: z.string().min(1),
          // createOrder has always accepted a city; updateOrder never did, so a city typed
          // at creation could be read but never corrected.
          city: z.string().max(100).optional(),
          customerAddress: z.string().min(1),
          selectedProducts: z
            .array(
              z.object({
                productId: z.number().int().min(1),
                productName: z.string().min(1),
                quantity: z.number().int().min(1).optional(),
              })
            )
            .min(1),
          quantity: z.number().int().min(1).optional(),
          totalAmount: z.number().min(0),
          adName: z.string().optional(),
          pageName: z.string().optional(),
          notes: z.string().optional(),
          // حقول كفر مرتبة ووتر بروف
          variantId: z.number().int().optional(),
          size: z.string().optional(),
          color: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(
          empScope(ctx),
          "order",
          input.orderId
        );
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
        const { orders } = await import("../drizzle/schema");
        // ملكية موظف الإدخال (مؤقتًا عبر lastUpdatedBy لحد تطبيق Migration 0036 — العزل
        // الأساسي بالنشاط عبر requireOwned فوق). createdByEmployeeId الثابت هيرجع بعد الـmigration.
        const [order] = await db
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.id, input.orderId),
              eq(orders.lastUpdatedBy, ctx.employee.id),
              eq(orders.source, "facebook")
            )
          )
          .limit(1);
        if (!order)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "الأوردر غير موجود أو ليس من إدخالك",
          });
        // نفس حارس الإنشاء: كل منتج لازم يكون في نطاق الموظف، والاسم من الكتالوج مش
        // من نص العميل — المرآة والبنود يفضلوا متطابقين مهما بعت المتصل.
        await requireAllOwned(
          empScope(ctx),
          "product",
          input.selectedProducts.map(p => p.productId)
        );
        const catalogNames = await getOwnedProductNames(
          order.businessId,
          input.selectedProducts.map(p => p.productId)
        );
        const itemsWithQty = input.selectedProducts.map(p => ({
          ...p,
          productName: catalogNames.get(p.productId) ?? p.productName,
          quantity: p.quantity ?? 1,
        }));
        const totalQty =
          itemsWithQty.reduce((sum, p) => sum + p.quantity, 0) ||
          input.quantity ||
          1;
        const productNames = buildOrderHeaderName(itemsWithQty);
        const firstProductId = itemsWithQty[0].productId;
        // الهيدر والبنود في transaction واحدة، وصف الأوردر مقفول بالـPK أولًا
        // (`updateOrderWithItems`): تحديثين متزامنين بيتسلسلوا، والبنود بتطلع من تحديث
        // واحد كامل. الأرقام بتتكتب زي ما هي (مفيش تطبيع هنا من زمان).
        await updateOrderWithItems(
          input.orderId,
          {
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            customerPhone2: input.customerPhone2?.trim() || null,
            governorate: input.governorate,
            city: input.city ?? null,
            customerAddress: input.customerAddress,
            productId: firstProductId,
            productName: productNames,
            quantity: totalQty,
            totalAmount: input.totalAmount.toString(),
            adName: input.adName ?? null,
            pageName: input.pageName ?? null,
            notes: input.notes ?? null,
            variantId: input.variantId ?? null,
            size: input.size ?? null,
            color: input.color ?? null,
          },
          itemsWithQty.map(p => ({
            productId: p.productId,
            productName: p.productName,
            quantity: p.quantity,
            variantId:
              p.productId === firstProductId
                ? (input.variantId ?? undefined)
                : undefined,
            size:
              p.productId === firstProductId
                ? (input.size ?? undefined)
                : undefined,
            color:
              p.productId === firstProductId
                ? (input.color ?? undefined)
                : undefined,
          })),
          { normalizePhones: false }
        );
        return { success: true };
      }),

    // جلب قائمة المنتجات — مقصورة على نشاط الموظف (عزل).
    products: requireEmployeeTenantPermission("orders.view").query(async ({ ctx }) => {
      // نطاق نشاط الموظف الواحد — منتجاته النشطة فقط، معزولة عن أي نشاط/tenant تاني (الأسورة).
      // fail-closed: بلا نشاط → صفر (مش كل المنتجات).
      const businessIds = await employeeCatalogBusinessIds(empScope(ctx));
      if (businessIds.length === 0) return [];
      const db = await getDb();
      if (!db) return [];
      const { products } = await import("../drizzle/schema");
      return db
        .select()
        .from(products)
        .where(and(eq(products.isActive, true), inArray(products.businessId, businessIds)))
        .orderBy(products.name);
    }),

    /**
     * Active catalog (products + their variants) for the item picker — SCOPED to the
     * employee's own business (تركيبات المخزون بتاعت نشاطه بس، مش كل التينانتات).
     */
    catalog: requireEmployeeTenantPermission("orders.view").query(async ({ ctx }) => {
      // نطاق نشاط الموظف الواحد فقط — معزول عن أي نشاط تاني (الأسورة) حتى داخل نفس الـtenant.
      const businessIds = await employeeCatalogBusinessIds(empScope(ctx));
      if (businessIds.length === 0) return { products: [], variants: [] };
      return getMatchCatalog(undefined, businessIds);
    }),

    /**
     * يحلّل رسالة العميل الملصوقة ويطابق المنتج/التركيبة **داخل نشاط الموظف فقط**. read-only:
     * مابيكتبش حاجة. بيرجّع الحقول المستخرجة + التركيبة المحسومة (variantId/SKU) أو رسالة سبب
     * واضحة لو مفيش تركيبة مطابقة (الموظف بيملّي الباقي بدل اختيار تركيبة غلط).
     */
    /**
     * قالب شاشة الإدخال — من **نشاط جلسة الموظف** بس. مفيش input: العميل مالوش أي
     * طريقة يبعت بيها قالبًا أو نشاطًا. قراءة الإعداد fail-safe (الافتراضي عند أي خطأ)،
     * فالشاشة مابتقعش أبدًا بسبب إعداد عرض.
     */
    entryConfig: requireEmployeeTenantPermission("orders.view").query(async ({ ctx }) => {
      const businessIds = await employeeCatalogBusinessIds(empScope(ctx));
      const mode =
        businessIds.length === 1
          ? await getOrderEntryMode(businessIds[0])
          : DEFAULT_ORDER_ENTRY_MODE;
      return { mode };
    }),

    parsePaste: requireEmployeeTenantPermission("orders.view")
      .input(z.object({ text: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        // نطاق نشاط الموظف الواحد فقط — نفس كتالوج شاشة الإدخال، معزول عن أي نشاط تاني.
        const businessIds = await employeeCatalogBusinessIds(empScope(ctx));
        const catalog = businessIds.length
          ? await getMatchCatalog(undefined, businessIds)
          : { products: [], variants: [] };
        // التحليل والمطابقة كلهم في مسار إنتاج واحد (server/pasteLines.ts) — الراوتر
        // مسؤول عن النطاق بس. الاختبارات بتستدعي نفس الدالة، فمفيش نسخة تانية للمنطق.
        const legacy = analyzePaste(input.text, catalog);
        // ParseResultV2: الثقة لكل حقل/سطر، الأسعار بالقرش، وAI للأجزاء الغامضة فقط
        // (الافتراضي ORDER_PARSER_AI=none)، بحد استدعاء لكل (موظف + نشاط) — التجاوز =
        // نتيجة حتمية بلا نداء. الحقول الشخصية حتمية دايمًا.
        const ai = activeSegmentResolver();
        const aiKey = businessIds.length === 1 ? aiRateKey(ctx.employee.id, businessIds[0]) : null;
        const v2 = await analyzePasteV2(input.text, catalog, {
          resolver: aiKey ? rateLimitedResolver(ai.resolver, aiKey) : null,
          aiProvider: ai.provider,
        });
        // توكن موقّع بيربط الحفظ بالنص ده + الموظف + النشاط + **بصمة النتيجة القانونية**
        // (المعرّفات والكميات والأسعار والإجماليات ومطابقات الـAI المتحقَّق منها) —
        // addOrder بيتحقق منه ومابيتصلش بالـAI تاني.
        const parseToken =
          businessIds.length === 1
            ? signParseToken({ employeeId: ctx.employee.id, businessId: businessIds[0], rawHash: rawTextHashOf(input.text), fp: canonicalFingerprint(v2) })
            : null;
        return { ...legacy, v2, parseToken };
      }),

    // جلب variants منتج معين (للكفر ووتر بروف)
    productVariants: requireEmployeeTenantPermission("orders.view")
      .input(
        z.object({
          productId: z.number().int().min(1),
        })
      )
      .query(async ({ ctx, input }) => {
        await requireOwned(
          empScope(ctx),
          "product",
          input.productId
        );
        const db = await getDb();
        if (!db) return [];
        const { productVariants } = await import("../drizzle/schema");
        return db
          .select()
          .from(productVariants)
          .where(eq(productVariants.productId, input.productId))
          .orderBy(productVariants.size, productVariants.color);
      }),

    // جلب سجل المسحات للموظف الحالي
    scanLogs: requireEmployeeTenantPermission("orders.view")
      .input(
        z.object({
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          result: z
            .enum(["success", "failed", "duplicate", "cancelled"])
            .optional(),
          limit: z.number().default(500),
        })
      )
      .query(async ({ ctx, input }) => {
        const emp = (ctx as any).employee;
        const db = await getDb();
        if (!db)
          return {
            logs: [],
            stats: {
              total: 0,
              success: 0,
              failed: 0,
              duplicate: 0,
              cancelled: 0,
            },
          };

        const { scanLogs: scanLogsTable, orders } = await import(
          "../drizzle/schema"
        );

        // Build where conditions
        const conditions: any[] = [eq(scanLogsTable.scannedBy, emp.id)];

        if (input.dateFrom) {
          conditions.push(gte(scanLogsTable.createdAt, input.dateFrom));
        }
        if (input.dateTo) {
          const endOfDay = new Date(input.dateTo);
          endOfDay.setHours(23, 59, 59, 999);
          conditions.push(lte(scanLogsTable.createdAt, endOfDay));
        }
        if (input.result) {
          conditions.push(eq(scanLogsTable.result, input.result));
        }

        // Fetch logs with order details
        const logs = await db
          .select({
            id: scanLogsTable.id,
            orderId: scanLogsTable.orderId,
            serialNumber: scanLogsTable.serialNumber,
            scannedBy: scanLogsTable.scannedBy,
            scannedByName: scanLogsTable.scannedByName,
            result: scanLogsTable.result,
            deviceInfo: scanLogsTable.deviceInfo,
            createdAt: scanLogsTable.createdAt,
            orderNumber: orders.orderNumber,
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
            governorate: orders.governorate,
          })
          .from(scanLogsTable)
          .leftJoin(orders, eq(scanLogsTable.orderId, orders.id))
          .where(and(...conditions))
          .orderBy(desc(scanLogsTable.createdAt))
          .limit(input.limit);

        // Calculate stats
        const allLogs = await db
          .select({ result: scanLogsTable.result })
          .from(scanLogsTable)
          .where(and(...conditions));

        const stats = {
          total: allLogs.length,
          success: allLogs.filter((l: any) => l.result === "success").length,
          failed: allLogs.filter((l: any) => l.result === "failed").length,
          duplicate: allLogs.filter((l: any) => l.result === "duplicate")
            .length,
          cancelled: allLogs.filter((l: any) => l.result === "cancelled")
            .length,
        };

        return {
          logs: logs.map((log: any) => ({
            id: log.id,
            orderId: log.orderId,
            serialNumber: log.serialNumber,
            scannedBy: log.scannedBy,
            scannedByName: log.scannedByName,
            result: log.result,
            deviceInfo: log.deviceInfo,
            createdAt: log.createdAt,
            order: log.orderNumber
              ? {
                  orderNumber: log.orderNumber,
                  customerName: log.customerName,
                  customerPhone: log.customerPhone,
                  governorate: log.governorate,
                }
              : null,
          })),
          stats,
        };
      }),
  }),

  // ==================== WEBHOOK ====================
  webhook: router({
    log: adminProcedure.query(async ({ ctx }) => {
      // عزل التينانت: سجلات الويبهوك فيها PII (اسم/تليفون/محافظة) — نقصّها على أنشطة
      // التينانت فقط. fail-closed: نطاق فاضي → [NO_BUSINESS] = صفر صفوف.
      const businessIds = (await scopeBusinessIds(ctx, {})) ?? [NO_BUSINESS];
      const { getWebhookLog } = await import("./easyorderWebhook");
      const log = await getWebhookLog(businessIds);
      return { log };
    }),
    stats: adminProcedure.query(async ({ ctx }) => {
      const businessIds = (await scopeBusinessIds(ctx, {})) ?? [NO_BUSINESS];
      const { getWebhookLog } = await import("./easyorderWebhook");
      const log = await getWebhookLog(businessIds, 1000);
      const total = log.length;
      const success = log.filter((e: any) => e.status === "success").length;
      const duplicate = log.filter((e: any) => e.status === "duplicate").length;
      const error = log.filter((e: any) => e.status === "error").length;
      const statusUpdate = log.filter(
        (e: any) => e.status === "status_update"
      ).length;
      return { total, success, duplicate, error, statusUpdate };
    }),
  }),

  // ==================== REPORTS ====================
  reports: router({
    dashboard: permissionProcedure("accounting.view")
      .input(
        z.object({
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          businessId: z.number().optional(),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getDashboardStats(
          input.dateFrom,
          input.dateTo,
          undefined,
          businessIds
        );
      }),

    employeePerformance: adminProcedure
      .input(
        z.object({
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          businessId: z.number().optional(),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        const [perf, emps] = await Promise.all([
          getEmployeePerformance(
            input.dateFrom,
            input.dateTo,
            undefined,
            businessIds
          ),
          getAllEmployees(undefined, businessIds),
        ]);
        return perf.map(p => {
          const emp = emps.find(e => e.id === p.employeeId);
          return {
            ...p,
            employeeName: emp?.name ?? "غير معروف",
            total: Number(p.total),
            confirmed: Number(p.confirmed),
            cancelled: Number(p.cancelled),
            postponed: Number(p.postponed),
            delivered: Number(p.delivered),
            confirmRate:
              p.total > 0
                ? Math.round((Number(p.confirmed) / Number(p.total)) * 100)
                : 0,
            cancelRate:
              p.total > 0
                ? Math.round((Number(p.cancelled) / Number(p.total)) * 100)
                : 0,
          };
        });
      }),

    cancellationReasons: adminProcedure
      .input(
        z.object({
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          businessId: z.number().optional(),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getCancellationReasons(
          input.dateFrom,
          input.dateTo,
          undefined,
          businessIds
        );
      }),

    dailyChart: adminProcedure
      .input(
        z.object({
          days: z.number().default(30),
          businessId: z.number().optional(),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getDailyOrdersChart(input.days, undefined, businessIds);
      }),

    // تقرير الدمج التلقائي للأوردرات المكررة
    mergeLogs: adminProcedure
      .input(
        z.object({
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          limit: z.number().default(100),
        })
      )
      .query(async ({ input }) => {
        const mysql = await import("mysql2/promise");
        const conn = await mysql.default.createConnection(
          process.env.DATABASE_URL!
        );
        try {
          let query = "SELECT * FROM merge_logs";
          const params: any[] = [];
          const conditions: string[] = [];
          if (input.dateFrom) {
            conditions.push("createdAt >= ?");
            params.push(input.dateFrom);
          }
          if (input.dateTo) {
            conditions.push("createdAt <= ?");
            params.push(input.dateTo);
          }
          if (conditions.length) query += " WHERE " + conditions.join(" AND ");
          const safeLimit = Math.min(
            Math.max(1, Math.floor(Number(input.limit))),
            1000
          );
          query += ` ORDER BY createdAt DESC LIMIT ${safeLimit}`;
          const [rows] = await conn.execute(query, params);
          return { logs: rows as any[] };
        } finally {
          await conn.end();
        }
      }),

    // عدد الدمج في آخر 24 ساعة (للتنبيه)
    mergeAlert: adminProcedure.query(async () => {
      const mysql = await import("mysql2/promise");
      const conn = await mysql.default.createConnection(
        process.env.DATABASE_URL!
      );
      try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [rows] = (await conn.execute(
          "SELECT COUNT(*) as count, SUM(mergedQty) as totalMergedQty FROM merge_logs WHERE createdAt >= ?",
          [since]
        )) as any;
        const count = Number(rows[0].count);
        const totalMergedQty = Number(rows[0].totalMergedQty || 0);
        return { count, totalMergedQty, hasAlert: count > 0 };
      } finally {
        await conn.end();
      }
    }),
  }),

  // ==================== أداء الموظفين من سجل الأحداث (0041، خلف ORDER_EVENTS_ENABLED) ====================
  // القراءة فقط. النطاق من الجلسة (tenant + أنشطتها)، والمدخلات strict (لا tenantId من العميل).
  performance: router({
    status: authenticatedProcedure.query(() => ({ enabled: orderEventsEnabled() })),
    team: permissionProcedure("employee_performance.view_all")
      .input(z.object({ dateFrom: z.string(), dateTo: z.string(), businessIds: z.array(z.number()).optional() }).strict())
      .query(async ({ ctx, input }) => {
        const businessIds = (await scopeBusinessIds(ctx, input)) ?? [NO_BUSINESS];
        return loadPerformance({ tenantId: ctx.tenantId, businessIds, fromDate: input.dateFrom, toDate: input.dateTo });
      }),
    mine: permissionProcedure("employee_performance.view_self")
      .input(z.object({ dateFrom: z.string(), dateTo: z.string() }).strict())
      .query(async ({ ctx, input }) => {
        const self = ctx.employee?.id;
        if (!self) throw new TRPCError({ code: "FORBIDDEN", message: "تعذّر تحديد الموظف" });
        const businessIds = (await scopeBusinessIds(ctx, {})) ?? [NO_BUSINESS];
        return loadPerformance({ tenantId: ctx.tenantId, businessIds, fromDate: input.dateFrom, toDate: input.dateTo, onlyEmployeeId: self });
      }),
    exportCsv: permissionProcedure("employee_performance.export")
      .input(z.object({ dateFrom: z.string(), dateTo: z.string(), businessIds: z.array(z.number()).optional() }).strict())
      .query(async ({ ctx, input }) => {
        const businessIds = (await scopeBusinessIds(ctx, input)) ?? [NO_BUSINESS];
        const report = await loadPerformance({ tenantId: ctx.tenantId, businessIds, fromDate: input.dateFrom, toDate: input.dateTo });
        return report.enabled ? { enabled: true as const, csv: performanceCsv(report.rows) } : { enabled: false as const, csv: "" };
      }),
  }),

  // ==================== الحضور والانصراف — الإدارة (0042، خلف ATTENDANCE_ENABLED) ====================
  // الفاعل والنطاق من الجلسة؛ المدخلات strict؛ القراءة والعلم معطل = { enabled: false } بلا وصول للجداول.
  attendance: router({
    status: authenticatedProcedure.query(() => ({ enabled: attendanceSvc.attendanceEnabled() })),
    team: permissionProcedure("attendance.view_all")
      .input(attendanceRange.extend({ businessIds: z.array(z.number()).optional() }).strict())
      .query(async ({ ctx, input }) => {
        if (!attendanceSvc.attendanceEnabled()) return { enabled: false as const };
        const businessIds = (await scopeBusinessIds(ctx, input)) ?? [NO_BUSINESS];
        return { enabled: true as const, ...(await attendanceSvc.teamDays(ctx.tenantId, businessIds, input.dateFrom, input.dateTo)) };
      }),
    exportCsv: permissionProcedure("attendance.export")
      .input(attendanceRange.extend({ businessIds: z.array(z.number()).optional() }).strict())
      .query(async ({ ctx, input }) => {
        if (!attendanceSvc.attendanceEnabled()) return { enabled: false as const, csv: "" };
        const businessIds = (await scopeBusinessIds(ctx, input)) ?? [NO_BUSINESS];
        const t = await attendanceSvc.teamDays(ctx.tenantId, businessIds, input.dateFrom, input.dateTo);
        return { enabled: true as const, csv: attendanceCsv(t.days as any) };
      }),
    shifts: permissionProcedure("attendance.manage_shifts").query(async ({ ctx }) => {
      if (!attendanceSvc.attendanceEnabled()) return { enabled: false as const, rows: [] as any[] };
      return { enabled: true as const, rows: await attendanceSvc.listShifts(ctx.tenantId) };
    }),
    createShift: permissionProcedure("attendance.manage_shifts")
      .input(attendanceSvc.shiftInput)
      .mutation(async ({ ctx, input }) => attendanceSvc.createShift(webAttendanceActor(ctx), input, denyWhenEmpty((await sessionBusinessIds(ctx)) ?? []))),
    updateShift: permissionProcedure("attendance.manage_shifts")
      .input(z.object({ id: z.number().int().positive(), version: z.number().int().positive(), shift: attendanceSvc.shiftInput }).strict())
      .mutation(async ({ ctx, input }) => attendanceSvc.updateShift(webAttendanceActor(ctx), input.id, input.version, input.shift, denyWhenEmpty((await sessionBusinessIds(ctx)) ?? []))),
    setShiftActive: permissionProcedure("attendance.manage_shifts")
      .input(z.object({ id: z.number().int().positive(), isActive: z.boolean() }).strict())
      .mutation(async ({ ctx, input }) => attendanceSvc.setShiftActive(webAttendanceActor(ctx), input.id, input.isActive)),
    assignments: permissionProcedure("attendance.manage_shifts").query(async ({ ctx }) => {
      if (!attendanceSvc.attendanceEnabled()) return { enabled: false as const, rows: [] as any[] };
      return { enabled: true as const, rows: await attendanceSvc.listAssignments(ctx.tenantId) };
    }),
    assign: permissionProcedure("attendance.manage_shifts")
      .input(attendanceSvc.assignmentInput)
      .mutation(async ({ ctx, input }) => attendanceSvc.assignShift(webAttendanceActor(ctx), input, denyWhenEmpty((await sessionBusinessIds(ctx)) ?? []))),
    endAssignment: permissionProcedure("attendance.manage_shifts")
      .input(z.object({ id: z.number().int().positive() }).strict())
      .mutation(async ({ ctx, input }) => attendanceSvc.endAssignment(webAttendanceActor(ctx), input.id)),
    review: authenticatedProcedure
      .input(z.object({ requestId: z.number().int().positive(), decision: z.enum(["approve", "reject"]), reviewReason: z.string().max(500).nullable().optional() }).strict())
      .mutation(async ({ ctx, input }) => {
        const perms = { approveCorrections: await sessionHasPermission(ctx, "attendance.approve_corrections"), manageLeaves: await sessionHasPermission(ctx, "attendance.manage_leaves") };
        if (!perms.approveCorrections && !perms.manageLeaves) throw new TRPCError({ code: "FORBIDDEN", message: "ليس لديك صلاحية مراجعة الطلبات" });
        return attendanceSvc.reviewCorrection(webAttendanceActor(ctx), input, perms, denyWhenEmpty((await sessionBusinessIds(ctx)) ?? []));
      }),
    adminCorrect: permissionProcedure("attendance.correct")
      .input(z.object({
        employeeId: z.number().int().positive(), workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        punchType: z.enum(["clock_in", "break_start", "break_end", "clock_out", "day_close", "day_reopen"]),
        at: z.string().datetime({ offset: true }).nullable().optional(), correctionOfEventId: z.number().int().positive().nullable().optional(),
        voidEvent: z.boolean().optional(), reason: z.string().min(3).max(200), operationId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
      }).strict())
      .mutation(async ({ ctx, input: { punchType, ...rest } }) => attendanceSvc.adminCorrect(webAttendanceActor(ctx), { ...rest, eventType: punchType }, denyWhenEmpty((await sessionBusinessIds(ctx)) ?? []))),
  }),

  // ==================== مركز الرسائل (0043، خلف MESSAGING_ENABLED) — هوية جلسة الويب ====================
  messages: buildMessagingRouter(authenticatedProcedure, webMessagingIdentity),

  // ==================== الفرق (0044) — المالك/الإدارة، خلف TEAMS_ENABLED ====================
  // view_all/manage للمالك والأدمن افتراضيًا (المدير بالمنح فقط عبر permissionProcedure). النطاق = أنشطة الجلسة
  // (الفارغ = صفر). كل كتابة بـoperationId (Replay/CONFLICT) وهوية الفاعل من الجلسة فقط.
  teams: router({
    status: authenticatedProcedure.query(() => ({ enabled: teamsSvc.teamsEnabled() })),
    list: permissionProcedure("teams.view_all")
      .input(z.object({ includeInactive: z.boolean().optional() }).strict().optional())
      .query(async ({ ctx, input }) => {
        if (!teamsSvc.teamsEnabled()) return { enabled: false as const, rows: [] as any[] };
        return { enabled: true as const, rows: await teamsSvc.listTeams(ctx.tenantId, denyWhenEmpty((await sessionBusinessIds(ctx)) ?? []), input ?? {}) };
      }),
    get: permissionProcedure("teams.view_all")
      .input(z.object({ teamId: z.number().int().positive() }).strict())
      .query(async ({ ctx, input }) => {
        if (!teamsSvc.teamsEnabled()) return { enabled: false as const };
        return { enabled: true as const, ...(await teamsSvc.getTeam(ctx.tenantId, input.teamId, denyWhenEmpty((await sessionBusinessIds(ctx)) ?? []))) };
      }),
    history: permissionProcedure("teams.view_all")
      .input(z.object({ teamId: z.number().int().positive() }).strict())
      .query(async ({ ctx, input }) => {
        if (!teamsSvc.teamsEnabled()) return { enabled: false as const };
        return { enabled: true as const, ...(await teamsSvc.teamHistory(ctx.tenantId, input.teamId, denyWhenEmpty((await sessionBusinessIds(ctx)) ?? []))) };
      }),
    // تحذيرات ورديات الأعضاء اليوم (بلا وردية / فعالة / تعارض) — نفس منطق الحضور، قراءة فقط، يتطلب علمي الفرق والحضور.
    memberShifts: permissionProcedure("teams.view_all")
      .input(z.object({ teamId: z.number().int().positive() }).strict())
      .query(async ({ ctx, input }) => {
        if (!teamsSvc.teamsEnabled() || !attendanceSvc.attendanceEnabled()) return { enabled: false as const };
        return { enabled: true as const, ...(await teamLeaderSvc.ownerTeamMemberShifts(ctx.tenantId, input.teamId, denyWhenEmpty((await sessionBusinessIds(ctx)) ?? []))) };
      }),
    create: permissionProcedure("teams.manage").input(teamsSvc.createTeamInput)
      .mutation(async ({ ctx, input }) => teamsSvc.createTeam(webTeamsActor(ctx), input, denyWhenEmpty((await sessionBusinessIds(ctx)) ?? []))),
    rename: permissionProcedure("teams.manage").input(teamsSvc.renameTeamInput)
      .mutation(async ({ ctx, input }) => teamsSvc.renameTeam(webTeamsActor(ctx), input)),
    deactivate: permissionProcedure("teams.manage").input(teamsSvc.deactivateTeamInput)
      .mutation(async ({ ctx, input }) => teamsSvc.deactivateTeam(webTeamsActor(ctx), input)),
    addMember: permissionProcedure("teams.manage").input(teamsSvc.addMemberInput)
      .mutation(async ({ ctx, input }) => teamsSvc.addMember(webTeamsActor(ctx), input)),
    endMembership: permissionProcedure("teams.manage").input(teamsSvc.endMembershipInput)
      .mutation(async ({ ctx, input }) => teamsSvc.endMembership(webTeamsActor(ctx), input)),
    setLeader: permissionProcedure("teams.manage").input(teamsSvc.setLeaderInput)
      .mutation(async ({ ctx, input }) => teamsSvc.setLeader(webTeamsActor(ctx), input)),
    endLeadership: permissionProcedure("teams.manage").input(teamsSvc.endLeadershipInput)
      .mutation(async ({ ctx, input }) => teamsSvc.endLeadership(webTeamsActor(ctx), input)),
  }),

  // ==================== BROADCAST (Admin OAuth) ====================
  broadcast: router({
    // جلب الرسالة النشطة (للأدمن عبر Manus OAuth)
    // P0 عزل: كل الثلاثة على أنشطة tenant الجلسة بس (المالك/الأدمن = كل أنشطة شركته، مش المنصة).
    getActive: protectedProcedure.query(async ({ ctx }) => {
      const scope = await sessionTeamScope(ctx);
      return getScopedActiveBroadcast(scope);
    }),

    // إرسال رسالة (للأدمن) — صف لكل نشاط في نطاق الجلسة، فكل موظف يشوفها في نشاطه
    send: adminProcedure
      .input(
        z
          .object({
            message: z.string().min(1).max(500),
          })
          .strict()
      )
      .mutation(async ({ ctx, input }) => {
        const scope = await sessionTeamScope(ctx);
        return sendScopedBroadcast(scope, input.message, ctx.user.id, ctx.user.name ?? "مدير");
      }),

    // حذف الرسالة (للأدمن) — نطاق الجلسة بس
    clear: adminProcedure.mutation(async ({ ctx }) => {
      const scope = await sessionTeamScope(ctx);
      return clearScopedBroadcast(scope);
    }),
  }),

  // ==================== RETURNS ====================
  returns: router({
    // تسجيل مرتجع جديد
    markAsReturned: protectedProcedure
      .input(
        z.object({
          orderId: z.number(),
          returnReason: z.string().min(1).max(80),
          notes: z.string().optional(),
          // السياسة: المرتجع لا يعود للمخزون المتاح للبيع — true تُرفض برسالة واضحة.
          restoreStock: z.boolean().default(false),
        })
      )
      .mutation(async ({ input, ctx }) => {
        await requireOwned(ctx, "order", input.orderId);
        const userId = ctx.user?.id ?? 0;
        return withStatusGuard(() => markOrderAsReturned(
          input.orderId,
          input.returnReason,
          input.notes,
          userId,
          input.restoreStock
        ));
      }),

    // قائمة المرتجعات
    list: protectedProcedure
      .input(
        z.object({
          page: z.number().default(1),
          limit: z.number().default(50),
          governorate: z.string().optional(),
          returnReason: z.string().optional(),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          businessId: z.number().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getReturnsList({ ...input, businessId: undefined, businessIds });
      }),

    // إحصائيات المرتجعات
    stats: protectedProcedure
      .input(
        z.object({
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          businessId: z.number().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getReturnsStats(input.dateFrom, input.dateTo, undefined, businessIds);
      }),
  }),

  // نظام توزيع المهام
  tasks: router({
    // P0 عزل: كل عمليات المهام على نطاق جلسة البوابة (tenant الموظف + نشاطه) — المستلم والمهمة
    // والنشاط والمنشئ لازم يكونوا في نفس الـtenant. قبل كده: المستلم بلا تحقق، businessId
    // مابيتكتبش، والقائمة بلا employeeId بترجّع مهام **كل الشركات**.
    // الصلاحيات (لوحة المدير): القراءة employees.view؛ الإنشاء والحذف وتغيير الحالة (عمل على مهام الآخرين)
    // employees.manage — بتجاوزات الشركة للمدير (sessionHasPermission)، بلا توسيع للمشرف.
    // إنشاء مهمة جديدة (إدارة فقط — protectedProcedure = جلسة admin-tier)
    create: protectedProcedure
      .input(
        z
          .object({
            title: z.string().min(2),
            description: z.string().optional(),
            assignedTo: z.number().int().positive().optional(), // غياب = مهمة عامة لنشاط المدير
          })
          .strict()
      )
      .mutation(async ({ input, ctx }) => {
        await requireSessionPermission(ctx, "employees.manage");
        const scope = await portalTeamScope(ctx);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
        const { tasks } = await import("../drizzle/schema");

        let businessId: number;
        let assignedToName: string | null = null;
        if (input.assignedTo != null) {
          const [assignee] = await db
            .select()
            .from(employees)
            .where(eq(employees.id, input.assignedTo))
            .limit(1);
          if (!assignee) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
          if (!employeeInTeamScope(assignee, scope))
            throw new TRPCError({ code: "FORBIDDEN", message: "الموظف ده خارج نطاقك" });
          businessId = assignee.businessId!;
          assignedToName = assignee.name;
        } else {
          const own = realScopeIds(scope);
          if (own.length === 0)
            throw new TRPCError({ code: "FORBIDDEN", message: NO_TEAM_BUSINESS_MESSAGE });
          if (own.length > 1)
            throw new TRPCError({ code: "BAD_REQUEST", message: "حدد الموظف — نطاقك فيه أكتر من نشاط" });
          businessId = own[0];
        }

        // اسم المنشئ من صف الموظف الحقيقي للجلسة (مش من العميل)
        const creatorName = (ctx as any).employee?.name ?? ctx.user?.name ?? "المدير";

        await db.insert(tasks).values({
          businessId,
          title: input.title,
          description: input.description ?? null,
          assignedTo: input.assignedTo ?? null,
          assignedToName,
          createdBy: ctx.user?.id ?? 0,
          createdByName: creatorName,
        });
        return { success: true };
      }),

    // قائمة المهام — نطاق الجلسة دايمًا؛ employeeId (لو اتبعت) لازم يكون موظف في النطاق
    list: protectedProcedure
      .input(
        z
          .object({
            employeeId: z.number().int().positive().optional(),
            status: z.string().optional(),
          })
          .strict()
      )
      .query(async ({ input, ctx }) => {
        await requireSessionPermission(ctx, "employees.view");
        const scope = await portalTeamScope(ctx);
        const db = await getDb();
        if (!db) return [];
        const { tasks } = await import("../drizzle/schema");

        const conditions: any[] = [taskScopeCondition(scope)];
        if (input.employeeId != null) {
          const [target] = await db
            .select()
            .from(employees)
            .where(eq(employees.id, input.employeeId))
            .limit(1);
          if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "الموظف غير موجود" });
          if (!employeeInTeamScope(target, scope))
            throw new TRPCError({ code: "FORBIDDEN", message: "الموظف ده خارج نطاقك" });
          // الموظف يرى مهامه + المهام العامة (داخل النطاق)
          conditions.push(or(eq(tasks.assignedTo, input.employeeId), isNull(tasks.assignedTo)));
        }
        if (input.status && input.status !== "all") {
          conditions.push(eq(tasks.status, input.status as any));
        }

        return db
          .select()
          .from(tasks)
          .where(and(...conditions))
          .orderBy(desc(tasks.createdAt))
          .limit(100);
      }),

    // تحديث حالة المهمة — الملكية في نفس شرط الـUPDATE (لا تعديل خارج النطاق)
    updateStatus: protectedProcedure
      .input(
        z
          .object({
            taskId: z.number().int().positive(),
            status: z.enum(["new", "in_progress", "done"]),
          })
          .strict()
      )
      .mutation(async ({ ctx, input }) => {
        await requireSessionPermission(ctx, "employees.manage");
        const scope = await portalTeamScope(ctx);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
        const { tasks } = await import("../drizzle/schema");
        const owned = and(eq(tasks.id, input.taskId), taskScopeCondition(scope));
        await assertTaskInScope(db, tasks, input.taskId, owned!);
        await db.update(tasks).set({ status: input.status }).where(owned);
        return { success: true };
      }),

    // حذف مهمة (إدارة فقط) — نفس الحارس
    delete: protectedProcedure
      .input(z.object({ taskId: z.number().int().positive() }).strict())
      .mutation(async ({ ctx, input }) => {
        await requireSessionPermission(ctx, "employees.manage");
        const scope = await portalTeamScope(ctx);
        const db = await getDb();
        if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" });
        const { tasks } = await import("../drizzle/schema");
        const owned = and(eq(tasks.id, input.taskId), taskScopeCondition(scope));
        await assertTaskInScope(db, tasks, input.taskId, owned!);
        await db.delete(tasks).where(owned);
        return { success: true };
      }),
  }),

  // ==================== سجل الطباعات ====================
  printLogs: router({
    create: protectedProcedure
      .input(
        z.object({
          type: z.enum(["shipping_sheet", "labels"]),
          orderIds: z.array(z.number()).min(1),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireAllOwned(ctx, "order", input.orderIds);
        const result = await createPrintLog({
          type: input.type,
          orderIds: input.orderIds,
          printedBy: ctx.user.id,
          printedByName: ctx.user.name ?? "مدير",
          notes: input.notes,
        });
        return result;
      }),

    list: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().min(1).max(100).optional(),
            businessId: z.number().optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        const logs = await getPrintLogs(input?.limit ?? 50, undefined, businessIds);
        return logs;
      }),

    getById: protectedProcedure
      .input(
        z.object({
          id: z.number(),
        })
      )
      .query(async ({ ctx, input }) => {
        await requireOwned(ctx, "printLog", input.id);
        const log = await getPrintLogById(input.id);
        if (!log)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "السجل غير موجود",
          });
        return log;
      }),
  }),

  // ==================== سجل الأنشطة (Activity Log) ====================
  activityLog: router({
    list: adminProcedure
      .input(
        z
          .object({
            page: z.number().min(1).optional(),
            limit: z.number().min(1).max(100).optional(),
            action: z.string().optional(),
            entityType: z.string().optional(),
            entityId: z.number().optional(),
            performedBy: z.number().optional(),
            dateFrom: z.string().optional(),
            dateTo: z.string().optional(),
            businessId: z.number().optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        return getActivityLogs({
          page: input?.page ?? 1,
          limit: input?.limit ?? 50,
          action: input?.action,
          entityType: input?.entityType,
          entityId: input?.entityId,
          performedBy: input?.performedBy,
          dateFrom: input?.dateFrom ? new Date(input.dateFrom) : undefined,
          dateTo: input?.dateTo ? new Date(input.dateTo) : undefined,
          businessIds,
        });
      }),
  }),

  // ==================== الأنشطة (Businesses) ====================
  /**
   * حسابات شركات الشحن لكل نشاط (Bosta). للمالك/المدير المخوّل بس (adminProcedure) وبنطاق
   * `scopeBusinessId` — الموظف مالوش المسارات دي أصلًا، والمفتاح عمره ما يرجع للواجهة.
   */
  carrierAccounts: router({
    /** أحداث webhook شركة الشحن للنشاط (للمراجعة) — بلا الـpayload الخام. */
    webhookEvents: adminProcedure
      .input(z.object({
        businessId: z.number().int().min(1),
        statuses: z.array(z.enum(["received", "processed", "unmatched", "ignored", "failed"])).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }))
      .query(async ({ ctx, input }) => {
        const businessId = await scopeBusinessId(ctx, input.businessId);
        const rows = await listInboxEvents(businessId!, { statuses: input.statuses, limit: input.limit });
        return rows.map(r => ({
          ...r,
          stateLabel: r.stateCode != null && BOSTA_STATES[r.stateCode] ? BOSTA_STATES[r.stateCode].label : `حالة غير معروفة (${r.stateCode ?? "—"})`,
        }));
      }),
    /** إعادة معالجة حدث unmatched/failed — **للمالك فقط**، داخل نشاطه، وبلا تكرار أثر. */
    reprocessWebhookEvent: ownerProcedure
      .input(z.object({ businessId: z.number().int().min(1), eventId: z.number().int().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const businessId = await scopeBusinessId(ctx, input.businessId);
        return reprocessBostaInboxEvent(input.eventId, businessId!);
      }),
    status: adminProcedure
      .input(z.object({ businessId: z.number().int().min(1) }))
      .query(async ({ ctx, input }) => {
        const businessId = await scopeBusinessId(ctx, input.businessId);
        const status = await getCarrierAccountStatus(businessId!);
        const defaultRef = await getDefaultPackageImageUrl(businessId!);
        return {
          ...status,
          // الصورة الافتراضية لشحنات البراند: المرجع المخزَّن + الرابط العام الذي ستجلبه بوسطة.
          defaultPackageImage: defaultRef ? { ref: defaultRef, publicUrl: toPublicImageUrl(defaultRef) } : null,
        };
      }),
    /**
     * الصورة الافتراضية لشحنات البراند (بوسطة — السماح بفتح الشحنة). تُقبل: رابط https عام
     * بامتداد صورة، أو ملف مرفوع عندنا **لنفس التينانت**. null = إزالة. تؤثر على الشحنات
     * الجديدة فقط (الإرسال يقرأ الإعداد لحظة الإرسال).
     */
    setDefaultPackageImage: adminProcedure
      .input(z.object({ businessId: z.number().int().min(1), imageUrl: z.string().trim().max(500).nullable() }))
      .mutation(async ({ ctx, input }) => {
        const businessId = await scopeBusinessId(ctx, input.businessId);
        if (input.imageUrl != null) {
          // مرجع ملف مرفوع عندنا (نسبي **أو رابط كامل** بمسارنا) → لازم يكون لنفس التينانت.
          const ownedTenant = packageImageTenant(input.imageUrl);
          const isOurUpload = ownedTenant != null || input.imageUrl.startsWith(PACKAGE_IMAGE_URL_PREFIX);
          if (isOurUpload) {
            if (ownedTenant !== ctx.tenantId)
              throw new TRPCError({ code: "FORBIDDEN", message: "الصورة لا تخص هذه الشركة" });
            // المرجع يُحفظ فقط لملف موجود فعلًا في التخزين (لا مرجع لرفع فشل أو ملف ضائع).
            const filename = input.imageUrl.split("/").pop() ?? "";
            if (!(await packageImageExists(filename)))
              throw new TRPCError({ code: "BAD_REQUEST", message: "ملف الصورة غير موجود في التخزين — ارفع الصورة مجددًا" });
          } else if (!isPublicImageUrl(input.imageUrl)) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "الرابط يجب أن يكون https عامًا لصورة (png/jpg/webp) — أو ارفع الصورة من هنا" });
          }
        }
        await setDefaultPackageImageUrl(businessId!, input.imageUrl, ctx.user.id);
        return { ok: true, publicUrl: input.imageUrl ? toPublicImageUrl(input.imageUrl) : null };
      }),
    /** اختبار مفتاح قبل الحفظ — أماكن الاستلام من حساب Bosta نفسه. */
    testConnection: adminProcedure
      .input(z.object({ businessId: z.number().int().min(1), apiKey: z.string().min(8).max(500) }))
      .mutation(async ({ ctx, input }) => {
        await scopeBusinessId(ctx, input.businessId);
        const r = await probeBostaKey(input.apiKey.trim());
        if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error ?? "فشل الاختبار" });
        return { ok: true, pickupLocations: r.pickupLocations ?? [] };
      }),
    connect: adminProcedure
      .input(
        z.object({
          businessId: z.number().int().min(1),
          apiKey: z.string().min(8).max(500),
          pickupLocationId: z.string().max(100).nullable().optional(),
          pickupLocationName: z.string().max(255).nullable().optional(),
          allowOpenPackageDefault: z.boolean().optional().default(true),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await scopeBusinessId(ctx, input.businessId);
        if (ctx.tenantId == null) throw new TRPCError({ code: "FORBIDDEN", message: "جلسة بلا مؤسسة" });
        const r = await connectCarrierAccount({
          tenantId: ctx.tenantId,
          businessId: businessId!,
          apiKey: input.apiKey,
          pickupLocationId: input.pickupLocationId ?? null,
          pickupLocationName: input.pickupLocationName ?? null,
          allowOpenPackageDefault: input.allowOpenPackageDefault,
          actorId: ctx.user.id,
        });
        if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error });
        return { ok: true, apiKeyLast4: r.apiKeyLast4 };
      }),
    disconnect: adminProcedure
      .input(z.object({ businessId: z.number().int().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const businessId = await scopeBusinessId(ctx, input.businessId);
        await disconnectCarrierAccount(businessId!, ctx.user.id);
        return { ok: true };
      }),
  }),

  businesses: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const businessIds = await sessionBusinessIds(ctx);
      return withBusinessLogos(await getAllBusinesses(businessIds ? denyWhenEmpty(businessIds) : undefined));
    }),
    // قايمة الأنشطة بتتقري في كل تحميل صفحة من `BusinessContext`، ولازم تشتغل لأي جلسة
    // مصرّح لها (مالك أو موظف) — مش المالك بس. المحاسب موظف غير إداري (auth.me = null)،
    // فلو فضلت protectedProcedure، بيوصل صفحات الحسابات لكن مايلاقيش نشاط يختاره فتبان
    // فاضية. النطاق على `ctx.tenantId` (مش المستخدم)، فالعزل بين الشركات محفوظ زي ما هو —
    // ودي أسماء أنشطة بس، مفيش أي بيانات مالية.
    // بترجّع الهوية كمان (`logoUrl`) — الهيدر والمبدّل بيتبنوا منها لكل نشاط في النطاق.
    activeList: authenticatedProcedure.query(async ({ ctx }) => {
      const businessIds = await sessionBusinessIds(ctx);
      return withBusinessLogos(await getActiveBusinesses(businessIds ? denyWhenEmpty(businessIds) : undefined));
    }),
    /*
      المجموعات والأنشطة — مقصورة على نطاق الجلسة.

      الاتنين دول كانوا بيرجّعوا **كل** أنشطة النظام لأي مستخدم مسجّل، و`BusinessContext`
      بينادي `groupsWithBusinesses` في كل تحميل صفحة — فقايمة اختيار النشاط كانت ممكن
      تتملى بأنشطة شركة تانية.

      الفلترة بتمشي من **الأنشطة** مش من `business_groups.tenantId`: عمود المجموعة
      nullable ولسه بيتملى بسكربت backfill، فالفلترة عليه كانت هتخفي المجموعات القديمة
      وتفضّي القايمة على الإنتاج الحالي. النشاط هو اللي بيحدد النطاق، والمجموعة بتبان
      لو فيها نشاط مسموح.
    */
    groups: authenticatedProcedure.query(async ({ ctx }) => {
      const allowed = await sessionBusinessIds(ctx);
      const groups = await getActiveBusinessGroups();
      if (allowed == null) return groups;
      const mine = new Set(
        (await getActiveBusinesses(denyWhenEmpty(allowed)))
          .map(business => business.groupId)
          .filter((id): id is number => id != null)
      );
      return groups.filter(group => mine.has(group.id));
    }),
    groupsWithBusinesses: authenticatedProcedure.query(async ({ ctx }) => {
      const allowed = await sessionBusinessIds(ctx);
      // P0: نطاق مجهول = لا شيء (كان بيرجّع مجموعات وأنشطة كل الـtenants)، والتصفية في الاستعلام نفسه.
      if (allowed == null) return [];
      const groups = await getBusinessGroupsWithBusinesses(denyWhenEmpty(allowed));
      const allowedSet = new Set(denyWhenEmpty(allowed));
      return groups
        .map(group => ({
          ...group,
          businesses: group.businesses.filter(business =>
            allowedSet.has(business.id)
          ),
        }))
        // المجموعة اللي مالهاش أي نشاط مسموح مابتظهرش أصلاً — اسمها لوحده معلومة.
        .filter(group => group.businesses.length > 0);
    }),
    businessIdsByGroup: authenticatedProcedure
      .input(
        z.object({
          groupId: z.number(),
        })
      )
      .query(async ({ ctx, input }) => {
        const ids = await getBusinessIdsByGroupId(input.groupId);
        const allowed = await sessionBusinessIds(ctx);
        if (allowed == null) return ids;
        const allowedSet = new Set(allowed);
        return ids.filter(id => allowedSet.has(id));
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        const id = await scopeBusinessId(ctx, input.id);
        return id != null ? getBusinessById(id) : undefined;
      }),
    create: adminProcedure
      .input(
        z.object({
          name: z.string().min(2),
          slug: z.string().min(2),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await createBusiness({ ...input, tenantId: ctx.tenantId });
        return { success: true };
      }),
    update: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          slug: z.string().optional(),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { id, ...data } = input;
        // من غير السطر ده، أدمن شركة أ يقدر يبعت `isActive: false` على نشاط شركة ب
        // ويوقّفها. النشاط نفسه هو وحدة النطاق، فبيتفحص مباشرة.
        await scopeBusinessId(ctx, id);
        await updateBusiness(id, data);
        return { success: true };
      }),
    /**
     * لوجو النشاط — المالك/الأدمن بس (adminProcedure)، بعد فحص النطاق. المرجع لازم يكون
     * ملفًا مرفوعًا عبر `/api/branding/upload` بنفس التينانت — مش أي رابط.
     */
    setLogo: adminProcedure
      .input(z.object({ businessId: z.number().int().min(1), logoUrl: z.string().max(300).nullable() }))
      .mutation(async ({ ctx, input }) => {
        const businessId = await scopeBusinessId(ctx, input.businessId);
        if (input.logoUrl != null && (ctx.tenantId == null || !isOwnedLogoUrl(input.logoUrl, ctx.tenantId)))
          throw new TRPCError({ code: "BAD_REQUEST", message: "مرجع اللوجو غير صالح — ارفع الصورة من إعدادات النشاط" });
        await setBusinessLogoUrl(businessId!, input.logoUrl, ctx.user.id);
        return { ok: true };
      }),
    /** قالب شاشة الإدخال للنشاط — للمالك. النطاق بيتفحص، والموظف مالوش المسار ده. */
    orderEntryMode: adminProcedure
      .input(z.object({ businessId: z.number().int().min(1) }))
      .query(async ({ ctx, input }) => {
        const businessId = await scopeBusinessId(ctx, input.businessId);
        return { mode: await getOrderEntryMode(businessId!) };
      }),
    setOrderEntryMode: adminProcedure
      .input(
        z.object({
          businessId: z.number().int().min(1),
          mode: z.enum(ORDER_ENTRY_MODES),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // نفس حارس `update`: أدمن شركة أ مايقدرش يغيّر قالب نشاط شركة ب.
        const businessId = await scopeBusinessId(ctx, input.businessId);
        await setOrderEntryMode(businessId!, input.mode, ctx.user.id);
        return { success: true, mode: input.mode };
      }),
    // التصنيفات
    categories: protectedProcedure
      .input(
        z.object({
          businessId: z.number(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessId = await scopeBusinessId(
          ctx,
          input.businessId
        );
        return getCategoriesByBusiness(businessId!);
      }),
    createCategory: adminProcedure
      .input(
        z.object({
          businessId: z.number(),
          name: z.string().min(2),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        await createCategory({ ...input, businessId });
        return { success: true };
      }),
    updateCategory: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { id, ...data } = input;
        await assertRecordInScope(
          ctx,
          await getCategoryById(id),
          "التصنيف غير موجود"
        );
        await updateCategory(id, data);
        return { success: true };
      }),
    // المخازن
    // قراءة مقصورة على النطاق — متاحة للمحاسب (اختيار المخزن في استلام البضاعة).
    warehouses: authenticatedProcedure
      .input(
        z.object({
          businessId: z.number(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessId = await scopeBusinessId(
          ctx,
          input.businessId
        );
        return getWarehousesByBusiness(businessId!);
      }),
    createWarehouse: adminProcedure
      .input(
        z.object({
          businessId: z.number(),
          name: z.string().min(2),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        await createWarehouse({ ...input, businessId });
        return { success: true };
      }),
    updateWarehouse: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().optional(),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { id, ...data } = input;
        // تعطيل مخزن شركة تانية بيوقّف استلام البضاعة عندها.
        await assertRecordInScope(
          ctx,
          await getWarehouseById(id),
          "المخزن غير موجود"
        );
        await updateWarehouse(id, data);
        return { success: true };
      }),
  }),

  // ==================== SALES CHANNELS ====================
  // NOTE: every procedure here is adminProcedure — sales channels hold integration
  // credentials, so even read access is admin-only. The queries themselves never return
  // raw apiToken/webhookSecret (see getAllSalesChannels/getSalesChannelById in db.ts);
  // clients get hasApiToken/apiTokenLast4-style fields instead.
  salesChannels: router({
    list: adminProcedure
      .input(
        z
          .object({
            businessId: z.number().optional(),
            includeInactive: z.boolean().optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        // عزل fail-closed: أنشطة التينانت من الـsession — غياب businessId = قنوات المستخدم فقط،
        // مش كل النظام. (كان scopeBusinessId المفرد بيرجّع undefined → getAll بلا فلتر = كل القنوات.)
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        return getAllSalesChannels(undefined, {
          includeInactive: input?.includeInactive ?? true,
        }, businessIds);
      }),
    activeList: adminProcedure
      .input(
        z
          .object({
            businessId: z.number().optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        return getActiveSalesChannels(undefined, businessIds);
      }),
    get: adminProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireOwned(ctx, "salesChannel", input.id);
        return getSalesChannelById(input.id);
      }),
    create: adminProcedure
      .input(
        z.object({
          businessId: z.number(),
          name: z.string().trim().min(2, "اسم القناة مطلوب (حرفين على الأقل)"),
          domain: z
            .string()
            .trim()
            .url("صيغة الدومين غير صحيحة")
            .optional()
            .or(z.literal("")),
          platform: z
            .enum([
              "easyorder",
              "shopify",
              "woocommerce",
              "whatsapp",
              "facebook",
              "instagram",
              "manual",
              "other",
            ])
            .default("other"),
          apiToken: z.string().trim().min(1).optional(),
          webhookSecret: z
            .string()
            .trim()
            .min(8, "سر الـ webhook يجب أن يكون 8 أحرف على الأقل")
            .optional(),
          webhookUrl: z
            .string()
            .trim()
            .url("صيغة رابط الـ webhook غير صحيحة")
            .optional()
            .or(z.literal("")),
        })
      )
      .mutation(async ({ ctx, input }) => {
        input.businessId = (await scopeBusinessId(
          ctx,
          input.businessId
        ))!;
        if (await isSalesChannelNameTaken(input.businessId, input.name)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `يوجد بالفعل قناة نشطة بنفس الاسم "${input.name}" لهذا العمل`,
          });
        }
        if (
          input.webhookSecret &&
          (await isWebhookSecretTaken(input.webhookSecret))
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message:
              "سر الـ webhook مستخدم بالفعل في قناة أخرى — يجب أن يكون فريدًا لتوجيه الـ webhooks بشكل صحيح",
          });
        }
        const result = await createSalesChannel({
          ...input,
          domain: input.domain || undefined,
          webhookUrl: input.webhookUrl || undefined,
        });
        return { success: true, id: result.id };
      }),
    update: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().trim().min(2).optional(),
          domain: z
            .string()
            .trim()
            .url("صيغة الدومين غير صحيحة")
            .optional()
            .or(z.literal("")),
          platform: z
            .enum([
              "easyorder",
              "shopify",
              "woocommerce",
              "whatsapp",
              "facebook",
              "instagram",
              "manual",
              "other",
            ])
            .optional(),
          // Omit or send "" to keep the stored secret unchanged — the API never returns it,
          // so a form can't round-trip it. Use clearSecret to remove one.
          apiToken: z.string().trim().optional(),
          webhookSecret: z.string().trim().optional(),
          webhookUrl: z
            .string()
            .trim()
            .url("صيغة رابط الـ webhook غير صحيحة")
            .optional()
            .or(z.literal("")),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "salesChannel", input.id);
        const { id, ...data } = input;
        const current = await getSalesChannelById(id);
        if (!current)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "القناة غير موجودة",
          });

        if (
          data.name &&
          (await isSalesChannelNameTaken(current.businessId, data.name, id))
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `يوجد بالفعل قناة نشطة بنفس الاسم "${data.name}" لهذا العمل`,
          });
        }
        if (data.webhookSecret) {
          if (data.webhookSecret.length < 8) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "سر الـ webhook يجب أن يكون 8 أحرف على الأقل",
            });
          }
          if (await isWebhookSecretTaken(data.webhookSecret, id)) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "سر الـ webhook مستخدم بالفعل في قناة أخرى",
            });
          }
        }
        await updateSalesChannel(id, data);
        return { success: true };
      }),
    /** Removes a stored credential (update() alone can never clear one, by design). */
    clearSecret: adminProcedure
      .input(
        z.object({
          id: z.number(),
          field: z.enum(["apiToken", "webhookSecret"]),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "salesChannel", input.id);
        await clearSalesChannelSecret(input.id, input.field);
        return { success: true };
      }),
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "salesChannel", input.id);
        await deleteSalesChannel(input.id);
        return { success: true };
      }),
    reactivate: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "salesChannel", input.id);
        await reactivateSalesChannel(input.id);
        return { success: true };
      }),
    /** Verifies the channel's stored API credentials without importing anything. */
    testConnection: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "salesChannel", input.id);
        return testChannelConnection(input.id);
      }),
    /** Manual "Sync Now" — pulls orders for a date range and upserts them idempotently. */
    syncNow: adminProcedure
      .input(
        z.object({
          id: z.number(),
          from: z.date(),
          to: z.date(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        if (input.from > input.to) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "تاريخ البداية يجب أن يكون قبل تاريخ النهاية",
          });
        }
        await requireOwned(ctx, "salesChannel", input.id);
        const actingEmpId = await resolveActingEmployeeId(ctx);
        return syncOrdersByDateRange({
          channelId: input.id,
          from: input.from,
          to: input.to,
          performedBy: actingEmpId,
        });
      }),
    /** Re-runs a previous sync range; recorded with trigger = "retry". */
    retrySync: adminProcedure
      .input(
        z.object({
          id: z.number(),
          from: z.date(),
          to: z.date(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "salesChannel", input.id);
        const actingEmpId = await resolveActingEmployeeId(ctx);
        return syncOrdersByDateRange({
          channelId: input.id,
          from: input.from,
          to: input.to,
          performedBy: actingEmpId,
          trigger: "retry",
        });
      }),
    syncLogs: adminProcedure
      .input(
        z
          .object({
            channelId: z.number().optional(),
            limit: z.number().min(1).max(200).default(50),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        if (input?.channelId != null) {
          await requireOwned(ctx, "salesChannel", input.channelId);
          return getSyncLogs({ channelId: input.channelId, limit: input?.limit ?? 50 });
        }
        // fail-closed: بلا channelId، نقصّ على قنوات التينانت فقط (مش كل النظام).
        const businessIds = await scopeBusinessIds(ctx, {});
        const channels = await getAllSalesChannels(undefined, { includeInactive: true }, businessIds);
        const channelIds = channels.map(c => c.id);
        return getSyncLogs({ channelIds, limit: input?.limit ?? 50 });
      }),
  }),

  // ==================== PRODUCT VARIANTS ====================
  variants: router({
    byProduct: protectedProcedure
      .input(
        z.object({
          productId: z.number(),
          includeInactive: z.boolean().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        await requireOwned(ctx, "product", input.productId);
        return getVariantsByProduct(input.productId, {
          includeInactive: input.includeInactive,
        });
      }),
    // قراءة مقصورة على النطاق — متاحة للمحاسب (dropdown أنواع الحفر في استلام البضاعة).
    all: authenticatedProcedure
      .input(
        z
          .object({
            businessId: z.number().optional(),
            businessIds: z.array(z.number()).optional(),
            includeInactive: z.boolean().optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getAllVariantsWithProduct(undefined, businessIds, {
          includeInactive: input?.includeInactive,
        });
      }),
    get: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireOwned(ctx, "variant", input.id);
        return getVariantById(input.id);
      }),
    create: adminProcedure
      .input(
        z.object({
          productId: z.number(),
          name: z.string().min(1, "اسم النوع مطلوب"),
          color: z.string().optional(),
          size: z.string().optional(),
          // الرمز اختياري: لو اتساب فاضي السيرفر بيولّد رمزًا داخليًا فريدًا (AUTO-…).
                sku: z.string().optional(),
          price: z.number().min(0).optional(),
          costPrice: z.number().min(0).optional(),
          currentStock: z.number().min(0).default(0),
          minStockLevel: z.number().min(0).default(5),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { price, costPrice, ...rest } = input;
        const product = await getProductById(rest.productId);
        if (!product)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "المنتج غير موجود",
          });
        await requireScopedBusinessId(ctx, product.businessId);
        if (rest.currentStock !== 0)
          await assertLegacyInventoryMutationAllowed(product.businessId);
        if (await isVariantNameTaken(rest.productId, rest.name)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `يوجد بالفعل نوع بنفس الاسم "${rest.name}" لهذا المنتج`,
          });
        }
        // تفرّد الـSKU **داخل النشاط** فقط — نفس الـSKU مسموح في نشاط مختلف.
        const typedSku = rest.sku?.trim();
        if (typedSku && (await isSkuTakenInBusiness(product.businessId, typedSku))) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `رمز المنتج (SKU) "${typedSku}" مستخدم بالفعل في هذا النشاط`,
          });
        }
        // فاضي → رمز داخلي فريد (AUTO-…) بدل رفض الإضافة.
        const resolvedSku =
          typedSku || (await generateVariantSkus(product.businessId, 1))[0];
        await createVariant({
          ...rest,
          sku: resolvedSku,
          ...(price !== undefined ? { price: String(price) } : {}),
          ...(costPrice !== undefined ? { costPrice: String(costPrice) } : {}),
        });
        return { success: true };
      }),
    // إضافة تركيبات جديدة (ألوان/مقاسات) لمنتج قائم — الجديد فقط، بيتخطّى الموجود.
    addToProduct: adminProcedure
      .input(
        z.object({
          productId: z.number(),
          variants: z
            .array(
              z.object({
                color: z.string().optional(),
                size: z.string().optional(),
                name: z.string().optional(),
                // الرمز اختياري: لو اتساب فاضي السيرفر بيولّد رمزًا داخليًا فريدًا (AUTO-…).
                sku: z.string().optional(),
                price: z.number().min(0).optional(),
                costPrice: z.number().min(0).optional(),
                currentStock: z.number().min(0).default(0),
                minStockLevel: z.number().min(0).default(5),
              })
            )
            .min(1, "لازم تركيبة واحدة على الأقل"),
        })
      )
      .mutation(async ({ ctx, input }) => {
        // 1) العزل: المنتج لازم يكون تابع للجلسة.
        const product = await getProductById(input.productId);
        if (!product)
          throw new TRPCError({ code: "NOT_FOUND", message: "المنتج غير موجود" });
        await requireScopedBusinessId(ctx, product.businessId);

        // 2) كل تركيبة ليها بُعد واحد على الأقل.
        for (const v of input.variants) {
          if (!v.color?.trim() && !v.size?.trim() && !v.name?.trim())
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "كل تركيبة لازم يكون ليها لون أو مقاس على الأقل",
            });
        }

        // 3) تفرّد SKU: داخل الدفعة + داخل النشاط (منتجات + تركيبات).
        // الفاضي بيتولّد له رمز داخلي (AUTO-…) بدل ما الإضافة كلها تترفض.
        const typed = input.variants
          .map(v => v.sku?.trim())
          .filter((x): x is string => !!x);
        const skuSeen = new Set<string>();
        for (const x of typed) {
          const k = x.toLowerCase();
          if (skuSeen.has(k))
            throw new TRPCError({
              code: "CONFLICT",
              message: `رمز المنتج (SKU) "${x}" مكرر داخل الدفعة`,
            });
          skuSeen.add(k);
        }
        const takenInBusiness = await findTakenSkusInBusiness(product.businessId, typed);
        for (const x of typed) {
          if (takenInBusiness.has(x.toLowerCase()))
            throw new TRPCError({
              code: "CONFLICT",
              message: `رمز المنتج (SKU) "${x}" مستخدم بالفعل في هذا النشاط`,
            });
        }
        const autoAdd = await generateVariantSkus(
          product.businessId,
          input.variants.filter(v => !v.sku?.trim()).length,
          skuSeen
        );
        let autoIdxAdd = 0;
        const withSkus = input.variants.map(v => ({
          ...v,
          sku: v.sku?.trim() || autoAdd[autoIdxAdd++],
        }));

        // 4) مخزون افتتاحي: مسموح فقط قبل Go-Live المحاسبي.
        if (input.variants.some(v => v.currentStock !== 0))
          await assertLegacyInventoryMutationAllowed(product.businessId);

        // 5) إضافة الجديد فقط (بيتخطّى اللون×المقاس الموجود) في transaction واحدة.
        const result = await addVariantsToProduct(
          input.productId,
          withSkus.map(v => ({
            color: v.color,
            size: v.size,
            name: v.name,
            sku: v.sku,
            price: v.price !== undefined ? String(v.price) : undefined,
            costPrice:
              v.costPrice !== undefined ? String(v.costPrice) : undefined,
            currentStock: v.currentStock,
            minStockLevel: v.minStockLevel,
          }))
        );
        return { success: true, ...result };
      }),
    update: adminProcedure
      .input(
        z.object({
          id: z.number(),
          name: z.string().min(1).optional(),
          color: z.string().optional(),
          size: z.string().optional(),
          sku: z.string().min(1).optional(),
          price: z.number().min(0).optional(),
          costPrice: z.number().min(0).optional(),
          minStockLevel: z.number().min(0).optional(),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { id, price, costPrice, ...rest } = input;
        await requireOwned(ctx, "variant", id);
        if (rest.name?.trim()) {
          const current = await getVariantById(id);
          const productId = current?.productId;
          if (
            productId &&
            (await isVariantNameTaken(productId, rest.name, id))
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `يوجد بالفعل نوع بنفس الاسم "${rest.name}" لهذا المنتج`,
            });
          }
        }
        if (rest.sku) {
          // تفرّد الـSKU داخل النشاط مع استثناء الصنف نفسه؛ نفس الـSKU مسموح في نشاط مختلف.
          const current = await getVariantById(id);
          const product = current
            ? await getProductById(current.productId)
            : undefined;
          if (
            product &&
            (await isSkuTakenInBusiness(product.businessId, rest.sku, {
              excludeVariantId: id,
            }))
          ) {
            throw new TRPCError({
              code: "CONFLICT",
              message: `رمز المنتج (SKU) "${rest.sku}" مستخدم بالفعل في هذا النشاط`,
            });
          }
        }
        await updateVariant(id, {
          ...rest,
          ...(price !== undefined ? { price: String(price) } : {}),
          ...(costPrice !== undefined ? { costPrice: String(costPrice) } : {}),
        });
        return { success: true };
      }),
    updateStock: adminProcedure
      .input(
        z.object({
          variantId: z.number(),
          delta: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const variant = await getVariantById(input.variantId);
        const product = variant
          ? await getProductById(variant.productId)
          : undefined;
        if (!variant || !product)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "الصنف غير موجود",
          });
        await requireScopedBusinessId(ctx, product.businessId);
        await assertLegacyInventoryMutationAllowed(product.businessId);
        await updateVariantStock(input.variantId, input.delta);
        return { success: true };
      }),
    addMovement: adminProcedure
      .input(
        z.object({
          variantId: z.number(),
          type: z.enum(["in", "out"]),
          quantity: z.number().min(1),
          reason: z.string().optional(),
          notes: z.string().optional(),
          orderId: z.number().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const variant = await getVariantById(input.variantId);
        const product = variant
          ? await getProductById(variant.productId)
          : undefined;
        if (!variant || !product)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "الصنف غير موجود",
          });
        await requireScopedBusinessId(ctx, product.businessId);
        await assertLegacyInventoryMutationAllowed(product.businessId);
        const actingEmpId = await resolveActingEmployeeId(ctx);
        await addVariantInventoryMovement({
          ...input,
          performedBy: actingEmpId,
        });
        return { success: true };
      }),
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "variant", input.id);
        await deleteVariant(input.id);
        return { success: true };
      }),
  }),

  // ==================== ACCOUNTING ====================
  //
  // الوصول: adminProcedure. الـcontext الحالي بيبني ctx.user للأدوار الإدارية بس
  // (super_admin/admin/manager)، فمحاسب بـemployee_token مالوش ctx.user ومش هيوصل
  // للـrouter ده. صلاحيات accounting.view/manage اتضافت في permissions.ts استعدادًا
  // لبورتال المحاسب، لكن ربطها بمسار دخول منفصل مش جزء من المرحلة دي.
  accounting: router({
    /** مؤشرات لوحة الحسابات */
    // كانت adminProcedure — يعني أي حساب من طبقة الإدارة يشوف الأرباح والهوامش، حتى لو
    // المالك مش عايز كده. رؤية الربح قرار منفصل عن الإدارة، فبقت وراء صلاحيتها.
    dashboard: permissionProcedure("reports.view_profit")
      .input(
        z
          .object({
            dateFrom: z.date().optional(),
            dateTo: z.date().optional(),
            businessIds: z.array(z.number()).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        return getAccountingDashboard({
          businessIds,
          dateFrom: input?.dateFrom,
          dateTo: input?.dateTo,
        });
      }),

    // ---------- الخزنة ----------
    treasuryList: permissionProcedure("accounting.view")
      .input(
        z.object({
          type: z
            .enum([
              "collection",
              "refund",
              "expense",
              "deposit",
              "withdrawal",
              "adjustment",
            ])
            .optional(),
          direction: z.enum(["in", "out"]).optional(),
          performedBy: z.number().optional(),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          search: z.string().optional(),
          page: z.number().default(1),
          limit: z.number().default(50),
          businessIds: z.array(z.number()).optional(),
          includeOrderEvents: z.boolean().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getTreasuryTransactions({ ...input, businessIds });
      }),

    /** لوحة الخزنة — أرقام النهاردة والشهر وآخر ١٠ حركات */
    // ---------- مركز التسجيل اليومي ----------
    /**
     * أرقام يوم واحد. منفصلة عن treasurySummary لأن دي بتاخد اليوم كمُدخل — المحاسب بيسجّل
     * حركات إمبارح الصبح، فلو الأرقام دايمًا «النهاردة» كان فتح يوم قديم هيوريه أرقام
     * النهاردة تحت تاريخ إمبارح.
     */
    /**
     * كل أرقام مركز الحسابات في نداء واحد.
     *
     * نداء واحد مش عشرة: الأرقام دي بتتعرض مع بعض على شاشة واحدة، ولو كل كارت نادى
     * لوحده كانوا هيرجعوا من لحظات مختلفة والمجموع مايطلعش مظبوط.
     *
     * صلاحية reports.view_profit مش accounting.view — لأن فيه صافي ربح، وده رقم
     * الملّاك بس بيشوفوه (نفس بوابة accounting.dashboard).
     */
    controlCenter: permissionProcedure("reports.view_profit")
      .input(
        z.object({
          businessIds: z.array(z.number()).optional(),
          dateKey: z.string().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getAccountingControlCenter({ ...input, businessIds });
      }),

    /** سجل الخزنة ومعاه الرصيد قبل كل حركة — محسوب مش مخزّن. */
    treasuryHistory: permissionProcedure("accounting.view")
      .input(
        z.object({
          businessIds: z.array(z.number()).optional(),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          limit: z.number().min(1).max(500).default(100),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getTreasuryHistoryWithBalances({ ...input, businessIds });
      }),

    /** حملات الإعلانات في فترة — صفوف خام، والحساب في shared/adMetrics. */
    adCampaigns: permissionProcedure("accounting.view")
      .input(
        z.object({
          businessIds: z.array(z.number()).optional(),
          dateFrom: z.date(),
          dateTo: z.date(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return listAdCampaigns({ ...input, businessIds });
      }),

    /** «محتاج إجراء» — بنود مستنية تصرّف، مش أرقام للعلم. */
    actionItems: permissionProcedure("accounting.view")
      .input(z.object({ businessIds: z.array(z.number()).optional() }).optional())
      .query(async ({ ctx, input }) =>
        getAccountingActionItems({
          businessIds: await scopeBusinessIds(ctx, input ?? {}),
        })
      ),

    dailySummary: permissionProcedure("accounting.view")
      .input(
        z
          .object({
            businessIds: z.array(z.number()).optional(),
            /** يوم بتوقيت القاهرة، YYYY-MM-DD. الافتراضي النهاردة. */
            dateKey: z
              .string()
              .regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ لازم يكون YYYY-MM-DD")
              .optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        return getDailyLedgerSummary({ businessIds, dateKey: input?.dateKey });
      }),

    treasurySummary: permissionProcedure("accounting.view")
      .input(
        z
          .object({
            businessIds: z.array(z.number()).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        const cairoMonthStart = businessDayRange(
          `${businessDateKey(new Date(), "Africa/Cairo").slice(0, 7)}-01`,
          "Africa/Cairo"
        ).from;
        // ربح الشهر لمن يملك reports.view_profit فقط — بلا حساب أصلًا لغيره (الحجب من السيرفر)
        if (!(await canViewProfit(ctx))) {
          const summary = await getTreasurySummary(businessIds, 0);
          return { ...summary, monthProfit: null as number | null, profitHidden: true as const };
        }
        const dashboard = await getBusinessEventDashboard({
          businessIds: businessIds ?? [],
          dateFrom: cairoMonthStart,
        });
        const summary = await getTreasurySummary(businessIds, dashboard.realized.netProfit);
        return { ...summary, monthProfit: summary.monthProfit as number | null, profitHidden: false as const };
      }),

    treasuryBalance: permissionProcedure("accounting.view")
      .input(
        z
          .object({
            businessIds: z.array(z.number()).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        return { balance: await getTreasuryBalance(businessIds) };
      }),

    /**
     * إيداع/سحب يدوي.
     *
     * النوع محدود بـdeposit/withdrawal: التحصيل والمصروف والمرتجع بيتسجّلوا تلقائيًا من
     * مصادرهم، ولو اتسمح بإدخالهم يدوي هنا كان ممكن نفس المصروف يتحسب مرتين.
     */
    treasuryCreate: permissionProcedure("accounting.manage")
      .input(
        z.object({
          type: z.enum(["deposit", "withdrawal"]),
          amount: z.number().positive("المبلغ لازم يكون أكبر من صفر"),
          description: z.string().min(1, "الوصف مطلوب"),
          notes: z.string().optional(),
          transactionDate: z.date().optional(),
          businessId: z.number(),
          // معرّف العملية — العميل بيولّده لكل ضغطة مقصودة. retry بنفس المعرّف = حركة
          // واحدة؛ عملية جديدة (حتى بنفس المبلغ والوصف) = معرّف جديد = حركة جديدة.
          operationId: z.string().min(8).max(64),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const actor = await resolveActingEmployeeIdAndName(ctx);
        const result = await recordManualTreasuryEntry({
          businessId,
          type: input.type,
          amount: input.amount.toFixed(2),
          description: input.description,
          notes: input.notes,
          transactionDate: input.transactionDate ?? new Date(),
          operationId: input.operationId,
          actor: {
            id: actor.id ?? ctx.user!.id,
            name: actor.name ?? "غير معروف",
          },
        });
        return {
          success: true,
          duplicate: result.duplicate,
          transaction: result.transaction,
        };
      }),

    // ---------- تصنيفات المصروفات ----------
    expenseCategories: permissionProcedure("accounting.view")
      .input(
        z
          .object({
            includeInactive: z.boolean().optional(),
            businessIds: z.array(z.number()).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        return getExpenseCategories(
          businessIds,
          input?.includeInactive ?? false
        );
      }),

    expenseCategoryCreate: permissionProcedure("accounting.manage")
      .input(
        z.object({
          name: z.string().min(1, "اسم التصنيف مطلوب").max(100),
          description: z.string().optional(),
          businessId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        try {
          return await createExpenseCategory({ ...input, businessId });
        } catch (error: any) {
          // الفهرس الفريد (businessId, name) بيمنع تصنيفين بنفس الاسم — نحوّل خطأ
          // قاعدة البيانات لرسالة مفهومة بدل ما تظهر للمستخدم كخطأ داخلي.
          if (String(error?.message ?? "").includes("Duplicate")) {
            throw new TRPCError({
              code: "CONFLICT",
              message: "يوجد تصنيف بنفس الاسم",
            });
          }
          throw error;
        }
      }),

    expenseCategoryUpdate: permissionProcedure("accounting.manage")
      .input(
        z.object({
          id: z.number(),
          name: z.string().min(1).max(100).optional(),
          description: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "expenseCategory", input.id);
        const { id, ...rest } = input;
        await updateExpenseCategory(id, rest);
        return { success: true };
      }),

    expenseCategoryArchive: permissionProcedure("accounting.manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "expenseCategory", input.id);
        await archiveExpenseCategory(input.id);
        return { success: true };
      }),

    // ---------- المصروفات ----------
    expenseList: permissionProcedure("accounting.view")
      .input(
        z.object({
          categoryId: z.number().optional(),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          search: z.string().optional(),
          page: z.number().default(1),
          limit: z.number().default(50),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getExpenses({ ...input, businessIds });
      }),

    expenseCreate: permissionProcedure("accounting.manage")
      .input(
        z.object({
          categoryId: z.number().optional(),
          costCenterId: z.number().optional(),
          amount: z.number().positive("المبلغ لازم يكون أكبر من صفر"),
          description: z.string().min(1, "البيان مطلوب"),
          expenseDate: z.date(),
          serviceFrom: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          serviceTo: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          taxCode: z.string().max(30).optional(),
          taxAmount: z.number().min(0).optional(),
          reference: z.string().max(100).optional(),
          // Optional, matching the column, which has always been nullable. Requiring it
          // meant an accountant recording thirty small movements a day had to produce a
          // link for each one — including the 200 EGP paid to the cleaner — so the screen
          // went unused and the numbers were kept somewhere else.
          attachmentUrl: z.string().max(500).optional(),
          businessId: z.number(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const dateKey = input.expenseDate.toISOString().slice(0, 10);
        const result = await createExpenseDraft({
          businessId,
          categoryId: input.categoryId,
          costCenterId: input.costCenterId,
          amount: input.amount.toFixed(4),
          description: input.description,
          serviceFrom: input.serviceFrom ?? dateKey,
          serviceTo: input.serviceTo ?? dateKey,
          taxCode: input.taxCode,
          taxAmount: input.taxAmount?.toFixed(4),
          reference: input.reference,
          evidenceUrl: input.attachmentUrl,
          actor: await requireActor(ctx),
        });
        return { id: result.expenseId };
      }),

    expenseUpdate: permissionProcedure("accounting.manage")
      .input(
        z.object({
          id: z.number(),
          categoryId: z.number().optional(),
          amount: z.number().positive().optional(),
          description: z.string().min(1).optional(),
          expenseDate: z.date().optional(),
          reference: z.string().max(100).optional(),
          attachmentUrl: z.string().max(500).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { id, amount, ...rest } = input;
        const db = await getDb();
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "قاعدة البيانات غير متاحة",
          });
        const allowed = await scopeBusinessIds(ctx);
        const [expense] = await db
          .select({ businessId: expensesTable.businessId })
          .from(expensesTable)
          .where(
            and(
              eq(expensesTable.id, id),
              ...(allowed?.length
                ? [inArray(expensesTable.businessId, allowed)]
                : [])
            )
          )
          .limit(1);
        if (!expense)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "المصروف غير موجود",
          });
        const actor = await resolveActingEmployeeIdAndName(ctx);
        await updateExpense(
          id,
          { ...rest, ...(amount != null ? { amount: amount.toFixed(2) } : {}) },
          { id: actor.id ?? ctx.user!.id, name: actor.name ?? "غير معروف" }
        );
        return { success: true };
      }),

    expenseDelete: permissionProcedure("accounting.manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const db = await getDb();
        if (!db)
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "قاعدة البيانات غير متاحة",
          });
        const allowed = await scopeBusinessIds(ctx);
        const [expense] = await db
          .select({ businessId: expensesTable.businessId })
          .from(expensesTable)
          .where(
            and(
              eq(expensesTable.id, input.id),
              ...(allowed?.length
                ? [inArray(expensesTable.businessId, allowed)]
                : [])
            )
          )
          .limit(1);
        if (!expense)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "المصروف غير موجود",
          });
        const actor = await resolveActingEmployeeIdAndName(ctx);
        await deleteExpense(input.id, {
          id: actor.id ?? ctx.user!.id,
          name: actor.name ?? "غير معروف",
        });
        return { success: true };
      }),

    // ---------- التحصيلات ----------
    collectionList: permissionProcedure("accounting.view")
      .input(
        z.object({
          collectionStatus: z
            .enum(["pending", "collected", "partial", "failed"])
            .optional(),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          search: z.string().optional(),
          page: z.number().default(1),
          limit: z.number().default(50),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getCollections({ ...input, businessIds });
      }),

    /** سجل تحصيل أوردر واحد — كل خطوة ومين عملها */
    collectionHistory: permissionProcedure("accounting.view")
      .input(z.object({ orderId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        return getOrderCollectionHistory(input.orderId);
      }),

    collectionRecord: permissionProcedure("accounting.manage")
      .input(
        z.object({
          orderId: z.number(),
          collectedAmount: z.number().min(0, "المبلغ لا يمكن أن يكون سالبًا"),
          collectedAt: z.date().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "order", input.orderId);
        const actor = await resolveActingEmployeeIdAndName(ctx);
        return recordOrderCollection(
          input.orderId,
          input.collectedAmount,
          { id: actor.id ?? ctx.user!.id, name: actor.name ?? "غير معروف" },
          input.collectedAt
        );
      }),
  }),

  // ==================== PAYROLL ====================
  //
  // الوصول: adminProcedure زي router الحسابات — الـcontext بيبني ctx.user للأدوار
  // الإدارية بس. صلاحيات payroll.* اتعرّفت في permissions.ts استعدادًا لبورتال المحاسب،
  // والاعتماد مفصول عن الدفع عشان فصل المهام يفضل ممكن.
  // ==================== SUPPLIERS ====================
  //
  // كشف حساب المصنع **مشتق** من نفس أحداث المخزون والخزنة — مفيش جدول أرصدة. شوف
  // `server/supplierLedger.service.ts` للسبب كامل.
  suppliers: router({
    list: permissionProcedure("accounting.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) =>
        listSuppliers(await requireScopedBusinessId(ctx, input.businessId))
      ),

    summaries: permissionProcedure("accounting.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) =>
        getSupplierSummaries(
          await requireScopedBusinessId(ctx, input.businessId)
        )
      ),

    dashboardTotals: permissionProcedure("accounting.view")
      .input(z.object({ businessIds: z.array(z.number()).optional() }).optional())
      .query(async ({ ctx, input }) =>
        getSupplierDashboardTotals(
          (await scopeBusinessIds(ctx, input ?? {})) ?? null
        )
      ),

    statement: permissionProcedure("accounting.view")
      .input(
        z.object({
          businessId: z.number(),
          supplierKey: z.string().min(1),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          movementType: z
            .enum([
              "goods_received",
              "payment",
              "return_credit",
              "rework_fee",
              "opening_balance",
              "adjustment",
              "receipt_reversed",
            ])
            .optional(),
          search: z.string().optional(),
        })
      )
      .query(async ({ ctx, input }) =>
        getSupplierStatement({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    save: permissionProcedure("accounting.manage")
      .input(
        z.object({
          businessId: z.number(),
          key: z.string().optional(),
          name: z.string().min(1).max(160),
          phone: z.string().max(40).optional(),
          notes: z.string().max(1000).optional(),
          returnMode: z.enum(["credit", "rework"]).optional(),
          isActive: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        saveSupplier({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    // ── ربط الأسماء القديمة — قرار المالك، مفيش مطابقة تلقائية ──
    historicalNames: permissionProcedure("accounting.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) =>
        listHistoricalSupplierNames(
          await requireScopedBusinessId(ctx, input.businessId)
        )
      ),

    mapHistoricalName: permissionProcedure("accounting.manage")
      .input(
        z.object({
          businessId: z.number(),
          historicalName: z.string().min(1),
          supplierKey: z.string().min(1),
        })
      )
      .mutation(async ({ ctx, input }) =>
        mapHistoricalSupplierName({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    // ── الحركات ──
    payment: permissionProcedure("accounting.manage")
      .input(
        z.object({
          businessId: z.number(),
          supplierKey: z.string().min(1),
          amount: z.number().positive(),
          paidAt: z.date(),
          reference: z.string().max(120).optional(),
          notes: z.string().max(1000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        recordSupplierPayment({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    returnCredit: permissionProcedure("accounting.manage")
      .input(
        z.object({
          businessId: z.number(),
          supplierKey: z.string().min(1),
          amount: z.number().positive(),
          occurredAt: z.date(),
          reference: z.string().max(120).optional(),
          notes: z.string().max(1000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        recordSupplierReturnCredit({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    reworkFee: permissionProcedure("accounting.manage")
      .input(
        z.object({
          businessId: z.number(),
          supplierKey: z.string().min(1),
          amount: z.number().positive(),
          occurredAt: z.date(),
          reference: z.string().max(120).optional(),
          notes: z.string().max(1000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        recordReworkFee({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    // الافتتاحي والتسوية للمالك بس — الاتنين بيغيّروا الرصيد من غير حركة حقيقية ورا.
    openingBalance: ownerProcedure.use(frozenWhileAccountingDisabled)
      .input(
        z.object({
          businessId: z.number(),
          supplierKey: z.string().min(1),
          amount: z.number(),
          occurredAt: z.date(),
          notes: z.string().max(1000).optional(),
        })
      )
      .mutation(async ({ ctx, input }) =>
        recordOpeningBalance({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    adjustment: ownerProcedure.use(frozenWhileAccountingDisabled)
      .input(
        z.object({
          businessId: z.number(),
          supplierKey: z.string().min(1),
          amount: z.number(),
          occurredAt: z.date(),
          reference: z.string().max(120).optional(),
          notes: z.string().min(1).max(1000),
        })
      )
      .mutation(async ({ ctx, input }) =>
        recordSupplierAdjustment({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),

    /**
     * الشغل اللي الورشة سلمته — إذونات الاستلام وبنودها.
     *
     * قراءة فقط، من `purchase_receipts` و`purchase_receipt_items` — نفس الصفوف اللي
     * الكشف بيبني منها حركة «استلام بضاعة»، فمفيش رقم تاني ولا جدول تاني.
     */
    receipts: permissionProcedure("accounting.view")
      .input(z.object({ businessId: z.number(), supplierKey: z.string().min(1) }))
      .query(async ({ ctx, input }) =>
        listSupplierReceipts({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    /**
     * إلغاء حركة على حساب المصنع — حركة عكسية، مش حذف.
     *
     * التاريخ المالي مابيتمسحش: الأصل بيفضل والعكسية بتتسجّل جنبه ومربوطة بيه. إلغاء
     * إذن استلام معتمد مساره التاني (`inventory.purchaseReceiptVoid`) لأنه بيمس
     * المخزون كمان.
     */
    reverseMovement: permissionProcedure("accounting.manage")
      .input(
        z.object({
          businessId: z.number(),
          supplierKey: z.string().min(1),
          eventId: z.number(),
          reason: z.string().min(1).max(500),
        })
      )
      .mutation(async ({ ctx, input }) =>
        reverseSupplierMovement({
          ...input,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
          actor: await requireActor(ctx),
        })
      ),
  }),

  payroll: router({
    // قراءة المرتبات بصلاحية payroll.view المالية — المدير العام (جلسة admin صناعية) يُرفض ببوابة المالي
    // في permissionProcedure؛ المالك والمحاسب (payroll.view) يقرآن.
    summary: permissionProcedure("payroll.view")
      .input(
        z
          .object({
            businessIds: z.array(z.number()).optional(),
          })
          .optional()
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input ?? {});
        return getPayrollSummary(businessIds);
      }),

    // ---------- الإعدادات ----------
    settingsGet: permissionProcedure("payroll.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        return getPayrollSettings(businessId);
      }),

    settingsSave: adminProcedure.use(frozenWhileAccountingDisabled)
      .input(
        z.object({
          businessId: z.number(),
          workingDaysPerMonth: z.number().int().min(1).max(31).optional(),
          absenceDeductionBasis: z
            .enum(["calendar_days", "working_days"])
            .optional(),
          weekendDays: z.string().max(20).optional(),
          overtimeMode: z.enum(["manual", "hourly_multiplier"]).optional(),
          overtimeMultiplier: z.number().min(1).max(5).optional(),
          workHoursPerDay: z.number().min(1).max(24).optional(),
          currency: z.string().max(10).optional(),
          roundingMode: z
            .enum(["none", "nearest_1", "nearest_5", "nearest_10"])
            .optional(),
          defaultSalaryType: z
            .enum(["monthly", "daily", "commission", "mixed"])
            .optional(),
          defaultCommissionBasis: z
            .enum(["confirmed", "prepared", "shipped", "delivered"])
            .optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const actor = await resolveActingEmployeeIdAndName(ctx);
        const {
          businessId: _b,
          overtimeMultiplier,
          workHoursPerDay,
          ...rest
        } = input;
        await upsertPayrollSettings(
          businessId,
          {
            ...rest,
            ...(overtimeMultiplier != null
              ? { overtimeMultiplier: overtimeMultiplier.toFixed(2) }
              : {}),
            ...(workHoursPerDay != null
              ? { workHoursPerDay: workHoursPerDay.toFixed(2) }
              : {}),
          },
          { id: actor.id ?? ctx.user!.id, name: actor.name ?? "غير معروف" }
        );
        await addActivityLog({
          action: "payroll_settings_update",
          entityType: "payroll_settings",
          description: "تعديل إعدادات الرواتب",
          performedBy: actor.id ?? ctx.user!.id,
          performedByName: actor.name ?? "غير معروف",
          performedByRole: "admin",
          businessId,
        });
        return { success: true };
      }),

    // ---------- ملفات الرواتب ----------
    profileList: permissionProcedure("payroll.view")
      .input(z.object({ employeeId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireOwned(ctx, "employee", input.employeeId);
        return getSalaryProfiles(input.employeeId);
      }),

    /** الساري لكل موظف في النشاط — للشاشة اللي المالك بيدير منها المرتبات. */
    profileListByBusiness: permissionProcedure("payroll.view")
      .input(z.object({ businessId: z.number() }))
      .query(async ({ ctx, input }) =>
        listBusinessSalaryProfiles(
          await requireScopedBusinessId(ctx, input.businessId)
        )
      ),

    profileDelete: permissionProcedure("payroll.manage")
      .input(z.object({ businessId: z.number(), profileId: z.number() }))
      .mutation(async ({ ctx, input }) =>
        deleteSalaryProfile({
          profileId: input.profileId,
          businessId: await requireScopedBusinessId(
            ctx,
            input.businessId
          ),
        })
      ),

    profileCreate: permissionProcedure("payroll.manage")
      .input(
        z.object({
          businessId: z.number(),
          employeeId: z.number(),
          salaryType: z.enum(["monthly", "daily", "commission", "mixed"]),
          baseSalary: z.number().min(0).optional(),
          dailyRate: z.number().min(0).optional(),
          commissionType: z.enum(["per_order", "percentage"]).optional(),
          commissionValue: z.number().min(0).optional(),
          commissionBasis: z
            .enum(["confirmed", "prepared", "shipped", "delivered"])
            .default("delivered"),
          effectiveFrom: z.date(),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const actor = await resolveActingEmployeeIdAndName(ctx);
        const { baseSalary, dailyRate, commissionValue, ...rest } = input;
        const result = await createSalaryProfile({
          ...rest,
          businessId,
          ...(baseSalary != null ? { baseSalary: baseSalary.toFixed(2) } : {}),
          ...(dailyRate != null ? { dailyRate: dailyRate.toFixed(2) } : {}),
          ...(commissionValue != null
            ? { commissionValue: commissionValue.toFixed(2) }
            : {}),
          createdBy: actor.id ?? ctx.user!.id,
          createdByName: actor.name ?? "غير معروف",
        } as any);
        await addActivityLog({
          action: "salary_profile_create",
          entityType: "employee_salary_profile",
          entityId: result.id,
          description: `إنشاء ملف راتب للموظف #${input.employeeId}`,
          metadata: {
            salaryType: input.salaryType,
            effectiveFrom: input.effectiveFrom,
          },
          performedBy: actor.id ?? ctx.user!.id,
          performedByName: actor.name ?? "غير معروف",
          performedByRole: "admin",
          businessId,
        });
        return result;
      }),

    /**
     * إنشاء موظف رواتب من مساحة المحاسب — endpoint محدود بديل عن employees.create الإداري.
     * على payroll.manage (المحاسب معاه)، tenant-scoped، بينشئ موظف بدور غير إداري ثابت
     * (viewer) **بدون** أي username/passwordHash (لا دخول)، + ملف راتب في نفس الـtransaction.
     * مش بيمنح أي دور إداري ولا بيانات دخول — المالك يكمّلها لو حب. مفيش توسيع لـemployees.create.
     */
    payrollEmployeeCreate: permissionProcedure("payroll.manage")
      .input(
        z.object({
          businessId: z.number(),
          name: z.string().min(2).max(100),
          jobTitle: z.string().max(100).optional(),
          baseSalary: z.number().min(0),
          phone: z.string().max(20).optional(),
          startDate: z.date(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const actor = await requireActor(ctx);
        const result = await createPayrollEmployee({
          tenantId: ctx.tenantId!,
          businessId,
          name: input.name.trim(),
          phone: input.phone?.trim() || undefined,
          jobTitle: input.jobTitle,
          baseSalary: input.baseSalary.toFixed(2),
          effectiveFrom: input.startDate,
          actor,
        });
        await addActivityLog({
          action: "payroll_employee_create",
          entityType: "employee",
          entityId: result.employeeId,
          description: `إنشاء موظف رواتب: ${input.name.trim()}`,
          metadata: { baseSalary: input.baseSalary, jobTitle: input.jobTitle ?? null },
          performedBy: actor.id,
          performedByName: actor.name,
          performedByRole: "accountant",
          businessId,
        });
        return result;
      }),

    profileUpdate: permissionProcedure("payroll.manage")
      .input(
        z.object({
          id: z.number(),
          isActive: z.boolean().optional(),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "salaryProfile", input.id);
        const { id, ...rest } = input;
        const actor = await resolveActingEmployeeIdAndName(ctx);
        await updateSalaryProfile(id, rest, {
          id: actor.id ?? ctx.user!.id,
          name: actor.name ?? "غير معروف",
        });
        return { success: true };
      }),

    // ---------- السُلف ----------
    advanceList: permissionProcedure("payroll.view")
      .input(
        z.object({
          employeeId: z.number().optional(),
          status: z.enum(["pending", "settled", "cancelled"]).optional(),
          dateFrom: z.date().optional(),
          dateTo: z.date().optional(),
          page: z.number().default(1),
          limit: z.number().default(50),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getAdvances({ ...input, businessIds });
      }),

    advanceCreate: permissionProcedure("payroll.manage")
      .input(
        z.object({
          businessId: z.number(),
          employeeId: z.number(),
          amount: z.number().positive("المبلغ لازم يكون أكبر من صفر"),
          advanceDate: z.date(),
          reason: z.string().optional(),
          sourceAccountId: z.number().optional(),
          receivableAccountId: z.number().optional(),
          evidenceUrl: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const actor = await resolveActingEmployeeIdAndName(ctx);
        const employee = await getEmployeeById(input.employeeId);
        if (!employee)
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "الموظف غير موجود",
          });
        const result = await issueEmployeeAdvance({
          ...input,
          businessId,
          amount: input.amount.toFixed(4),
          actor: {
            id: actor.id ?? ctx.user!.id,
            name: actor.name ?? "غير معروف",
          },
        });
        await addActivityLog({
          action: "advance_create",
          entityType: "employee_advance",
          entityId: result.id,
          description: `صرف سُلفة ${input.amount} لـ${employee.name}`,
          performedBy: actor.id ?? ctx.user!.id,
          performedByName: actor.name ?? "غير معروف",
          performedByRole: "admin",
          businessId,
        });
        return result;
      }),

    advanceCancel: permissionProcedure("payroll.manage")
      .input(
        z.object({
          id: z.number(),
          businessId: z.number(),
          reason: z.string().min(5),
          evidenceUrl: z.string().min(1),
          occurredAt: z.date().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const actor = await requireActor(ctx);
        await cancelEmployeeAdvance({
          businessId,
          advanceId: input.id,
          reason: input.reason,
          evidenceUrl: input.evidenceUrl,
          occurredAt: input.occurredAt ?? new Date(),
          actor,
        });
        await addActivityLog({
          action: "advance_cancel",
          entityType: "employee_advance",
          entityId: input.id,
          description: `إلغاء سُلفة #${input.id}`,
          performedBy: actor.id ?? ctx.user!.id,
          performedByName: actor.name ?? "غير معروف",
          performedByRole: "admin",
        });
        return { success: true };
      }),

    // ---------- البونص ----------
    bonusList: permissionProcedure("payroll.view")
      .input(
        z.object({
          businessId: z.number(),
          employeeId: z.number().optional(),
          from: z.date().optional(),
          to: z.date().optional(),
        })
      )
      .query(async ({ ctx, input }) =>
        listEmployeeBonuses({
          ...input,
          businessId: await requireScopedBusinessId(ctx, input.businessId),
        })
      ),

    bonusCreate: permissionProcedure("payroll.manage")
      .input(
        z.object({
          businessId: z.number(),
          employeeId: z.number(),
          amount: moneyString,
          bonusDate: z.date(),
          reason: z.string().max(500).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(ctx, input.businessId);
        await requireOwned(ctx, "employee", input.employeeId);
        const actor = await requireActor(ctx);
        const result = await issueEmployeeBonus({
          businessId,
          employeeId: input.employeeId,
          amount: input.amount,
          bonusDate: input.bonusDate,
          reason: input.reason,
          actor,
        });
        await addActivityLog({
          action: "bonus_create",
          entityType: "employee_bonus",
          entityId: result.id,
          description: `تسجيل بونص للموظف #${input.employeeId}`,
          performedBy: actor.id ?? ctx.user!.id,
          performedByName: actor.name ?? "غير معروف",
          performedByRole: "admin",
          businessId,
        });
        return result;
      }),

    bonusDelete: permissionProcedure("payroll.manage")
      .input(z.object({ businessId: z.number(), bonusId: z.number() }))
      .mutation(async ({ ctx, input }) =>
        deleteEmployeeBonus({
          businessId: await requireScopedBusinessId(ctx, input.businessId),
          bonusId: input.bonusId,
        })
      ),

    /** ملخص المرتبات: الأساسي + البونص − السُلف = الصافي، لكل موظف. */
    salarySummary: permissionProcedure("payroll.view")
      .input(z.object({ businessId: z.number(), from: z.date().optional(), to: z.date().optional() }))
      .query(async ({ ctx, input }) =>
        getSalarySummaries({
          ...input,
          businessId: await requireScopedBusinessId(ctx, input.businessId),
        })
      ),

    // ---------- الدورات ----------
    periodList: permissionProcedure("payroll.view")
      .input(
        z.object({
          year: z.number().optional(),
          status: z.enum(["draft", "approved", "paid", "cancelled"]).optional(),
          page: z.number().default(1),
          limit: z.number().default(50),
          businessIds: z.array(z.number()).optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const businessIds = await scopeBusinessIds(ctx, input);
        return getPayrollPeriods({ ...input, businessIds });
      }),

    periodGet: permissionProcedure("payroll.view")
      .input(z.object({ id: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireOwned(ctx, "payrollPeriod", input.id);
        return getPayrollPeriod(input.id);
      }),

    periodCreate: permissionProcedure("payroll.manage")
      .input(
        z.object({
          businessId: z.number(),
          year: z.number().int().min(2020).max(2100),
          month: z.number().int().min(1).max(12),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const businessId = await requireScopedBusinessId(
          ctx,
          input.businessId
        );
        const actor = await resolveActingEmployeeIdAndName(ctx);
        const who = {
          id: actor.id ?? ctx.user!.id,
          name: actor.name ?? "غير معروف",
        };
        const result = await createPayrollPeriod({
          ...input,
          businessId,
          actor: who,
        });
        await addActivityLog({
          action: "payroll_period_create",
          entityType: "payroll_period",
          entityId: result.id,
          description: `إنشاء دورة رواتب ${input.month}/${input.year}`,
          performedBy: who.id,
          performedByName: who.name,
          performedByRole: "admin",
          businessId,
        });
        return result;
      }),

    periodRecalculate: permissionProcedure("payroll.manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "payrollPeriod", input.id);
        const actor = await resolveActingEmployeeIdAndName(ctx);
        return recalculatePayrollPeriod(input.id, {
          id: actor.id ?? ctx.user!.id,
          name: actor.name ?? "غير معروف",
        });
      }),

    itemUpdate: adminProcedure.use(frozenWhileAccountingDisabled)
      .input(
        z.object({
          id: z.number(),
          attendanceDays: z.number().int().min(0).max(31).optional(),
          absenceDays: z.number().int().min(0).max(31).optional(),
          overtimeHours: z.number().min(0).optional(),
          overtimeAmount: z.number().min(0).optional(),
          bonuses: z.number().min(0).optional(),
          deductions: z.number().min(0).optional(),
          commissions: z.number().min(0).optional(),
          baseSalary: z.number().min(0).optional(),
          netSalary: z.number().optional(),
          notes: z.string().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "payrollItem", input.id);
        const { id, ...rest } = input;
        const actor = await resolveActingEmployeeIdAndName(ctx);
        // decimal في drizzle نص — الأرقام بتتحول قبل الحفظ عشان الدقة تفضل ثابتة
        const DECIMALS = [
          "overtimeHours",
          "overtimeAmount",
          "bonuses",
          "deductions",
          "commissions",
          "baseSalary",
          "netSalary",
        ];
        const data: Record<string, any> = {};
        for (const [k, v] of Object.entries(rest)) {
          if (v === undefined) continue;
          data[k] =
            DECIMALS.includes(k) && typeof v === "number" ? v.toFixed(2) : v;
        }
        await updatePayrollItem(id, data, {
          id: actor.id ?? ctx.user!.id,
          name: actor.name ?? "غير معروف",
        });
        return { success: true };
      }),

    periodApprove: permissionProcedure("payroll.approve")
      .input(z.object({ id: z.number(), evidenceUrl: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "payrollPeriod", input.id);
        const actor = await resolveActingEmployeeIdAndName(ctx);
        const who = {
          id: actor.id ?? ctx.user!.id,
          name: actor.name ?? "غير معروف",
        };
        const result = await approveAndAccruePayrollPeriod({
          periodId: input.id,
          evidenceUrl: input.evidenceUrl,
          actor: who,
        });
        await addActivityLog({
          action: "payroll_period_approve",
          entityType: "payroll_period",
          entityId: input.id,
          description: `اعتماد دورة رواتب #${input.id} بصافي ${result.totalNet}`,
          metadata: { totalNet: result.totalNet },
          performedBy: who.id,
          performedByName: who.name,
          performedByRole: "admin",
        });
        return result;
      }),

    periodPay: permissionProcedure("payroll.pay")
      .input(
        z.object({
          id: z.number(),
          // زي expensePay — اختياري، وبيرجع لـ«الخزنة الرئيسية».
          sourceAccountId: z.number().optional(),
          evidenceUrl: z.string().min(1),
          paidAt: z.date().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "payrollPeriod", input.id);
        const actor = await resolveActingEmployeeIdAndName(ctx);
        const who = {
          id: actor.id ?? ctx.user!.id,
          name: actor.name ?? "غير معروف",
        };
        const result = await payPayrollPeriodV2({
          periodId: input.id,
          sourceAccountId: input.sourceAccountId,
          evidenceUrl: input.evidenceUrl,
          paidAt: input.paidAt ?? new Date(),
          actor: who,
        });
        await addActivityLog({
          action: "payroll_period_pay",
          entityType: "payroll_period",
          entityId: input.id,
          description: `دفع دورة رواتب #${input.id} بمبلغ ${result.amount}`,
          metadata: {
            transactionId: result.transactionId,
            amount: result.amount,
          },
          performedBy: who.id,
          performedByName: who.name,
          performedByRole: "admin",
        });
        return result;
      }),

    periodCancel: permissionProcedure("payroll.approve")
      .input(
        z.object({
          id: z.number(),
          reason: z.string().min(1, "سبب الإلغاء مطلوب"),
        })
      )
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "payrollPeriod", input.id);
        const actor = await resolveActingEmployeeIdAndName(ctx);
        const who = {
          id: actor.id ?? ctx.user!.id,
          name: actor.name ?? "غير معروف",
        };
        await cancelPayrollPeriod(input.id, input.reason, who);
        await addActivityLog({
          action: "payroll_period_cancel",
          entityType: "payroll_period",
          entityId: input.id,
          description: `إلغاء دورة رواتب #${input.id} — ${input.reason}`,
          performedBy: who.id,
          performedByName: who.name,
          performedByRole: "admin",
        });
        return { success: true };
      }),

    periodDelete: permissionProcedure("payroll.manage")
      .input(z.object({ id: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireOwned(ctx, "payrollPeriod", input.id);
        const actor = await resolveActingEmployeeIdAndName(ctx);
        await deletePayrollPeriod(input.id);
        await addActivityLog({
          action: "payroll_period_delete",
          entityType: "payroll_period",
          entityId: input.id,
          description: `حذف دورة رواتب مسودة #${input.id}`,
          performedBy: actor.id ?? ctx.user!.id,
          performedByName: actor.name ?? "غير معروف",
          performedByRole: "admin",
        });
        return { success: true };
      }),
  }),
  // دفتر الحسابات V3 — خلف صلاحيات ledger.* ونطاق الجلسة؛ بلا تفعيل عام (داخلي حتى شاشة المالك).
  ledger: createLedgerRouter({
    scopeBusinessId: ledgerScopeBusinessId, sessionBusinessIds: ledgerSessionBusinessIds,
    // قراءة الشركة كلها: جلسة المالك/الأدمن (ونطاقها كل الأنشطة أصلًا) ومدير الحسابات؛ المحاسب = نشاطه فقط.
    fullLedgerScope: (ctx: ScopeCtx) => ctx.user?.role === "admin" || ctx.employee?.role === ACCOUNTS_MANAGER_ROLE,
    canViewProfit: (ctx: ScopeCtx) => canViewProfit(ctx as any),
  }),
});

export type AppRouter = typeof appRouter;
