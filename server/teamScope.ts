import { and, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { broadcastMessages, tasks } from "../drizzle/schema";

/**
 * نطاق الرسائل الجماعية والمهام — P0 عزل الـTenant.
 *
 * الجدولان (`broadcast_messages` و`tasks`) مالهمش `tenantId`، وعمود `businessId` فيهم nullable
 * ومكانش بيتكتب أصلًا قبل الإصلاح ده. فالعزل بيتم عن طريق **النشاط**: النشاط تابع لـtenant واحد
 * (`businesses.tenantId`)، والجلسة بتاخد قايمة أنشطتها المسموحة من `scopeBusinessIds` (من
 * الجلسة بس، مش من العميل) — والقايمة الفاضية بتوصل هنا `[-1]` فمابتطابقش ولا صف.
 *
 * **الصفوف القديمة (`businessId IS NULL`)** تفضل مرئية لشركتها وبس، بإثبات مش بتخمين:
 *   • مهمة مسندة لموظف → الموظف ده (`assignedTo` = employees.id دايمًا) لازم يكون في نفس
 *     الـtenant وفي نشاط من نطاق الجلسة.
 *   • رسالة جماعية أو مهمة عامة → المُرسِل/المنشئ: `ABS(sentBy|createdBy)` = employees.id
 *     **و** الاسم المحفوظ = اسم الموظف (الـid السالب = جلسة admin صناعية `-emp.id`؛ الموجب قديم
 *     وممكن يكون users.id — مطابقة الاسم كمان بتقفل الاحتمال ده). أي صف مايتثبتش → مخفي.
 * لا Schema ولا Backfill هنا — الصفوف القديمة ماتتعدّلش.
 */
export type TeamScope = {
  /** tenant الجلسة — من صف الموظف نفسه (`requireTenantId`)، مش من العميل. */
  tenantId: number;
  /** أنشطة الجلسة المسموحة؛ الفاضي بيتعامل كـ`[-1]` (صفر صفوف). */
  businessIds: number[];
};

const NO_BUSINESS = -1;

export function scopeIds(scope: TeamScope): number[] {
  return scope.businessIds.length > 0 ? scope.businessIds : [NO_BUSINESS];
}

/** الأنشطة الحقيقية في النطاق (من غير المعرّف المستحيل). */
export function realScopeIds(scope: TeamScope): number[] {
  return scope.businessIds.filter(id => id > 0);
}

function inList(ids: number[]): SQL {
  return sql.join(ids.map(id => sql`${id}`), sql`, `);
}

/** موظف (بالمعرّف + الاسم المحفوظ) تابع لنفس الـtenant ولنشاط في النطاق. */
function legacyActorInScope(idColumn: SQL | unknown, nameColumn: unknown, scope: TeamScope): SQL {
  return sql`EXISTS (SELECT 1 FROM employees e WHERE e.id = ABS(${idColumn}) AND e.name = ${nameColumn} AND e.tenantId = ${scope.tenantId} AND e.businessId IN (${inList(scopeIds(scope))}))`;
}

/** شرط WHERE لكل قراءة/إلغاء تفعيل على الرسائل الجماعية. */
export function broadcastScopeCondition(scope: TeamScope): SQL {
  return or(
    inArray(broadcastMessages.businessId, scopeIds(scope)),
    and(
      isNull(broadcastMessages.businessId),
      legacyActorInScope(broadcastMessages.sentBy, broadcastMessages.sentByName, scope)
    )
  )!;
}

/** شرط WHERE لكل قراءة/تعديل/حذف على المهام. */
export function taskScopeCondition(scope: TeamScope): SQL {
  const ids = inList(scopeIds(scope));
  return or(
    inArray(tasks.businessId, scopeIds(scope)),
    and(
      isNull(tasks.businessId),
      isNotNull(tasks.assignedTo),
      sql`EXISTS (SELECT 1 FROM employees e WHERE e.id = ${tasks.assignedTo} AND e.tenantId = ${scope.tenantId} AND e.businessId IN (${ids}))`
    ),
    and(
      isNull(tasks.businessId),
      isNull(tasks.assignedTo),
      legacyActorInScope(tasks.createdBy, tasks.createdByName, scope)
    )
  )!;
}

/** الموظف المستهدف (مستلم مهمة/فلتر) لازم يكون في نفس الـtenant وفي نشاط من النطاق. */
export function employeeInTeamScope(
  target: { tenantId: number | null; businessId: number | null } | null | undefined,
  scope: TeamScope
): boolean {
  if (!target) return false;
  if (target.tenantId !== scope.tenantId) return false;
  if (target.businessId == null) return false;
  return realScopeIds(scope).includes(target.businessId);
}
