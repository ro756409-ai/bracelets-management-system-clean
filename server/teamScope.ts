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
 * **الصفوف القديمة (`businessId IS NULL`)** تفضل مرئية لشركتها وبس، بإثبات قاطع مش بتخمين:
 *   • مهمة مسندة لموظف → الموظف ده (`assignedTo` = employees.id دايمًا) لازم يكون في نفس
 *     الـtenant وفي نشاط من نطاق الجلسة.
 *   • رسالة جماعية أو مهمة عامة → المُرسِل/المنشئ بعقد الفاعل (sentBy / createdBy) — بلا ABS وبلا اسم:
 *       < 0  ⇒ employees.id = -القيمة **فقط** (جلسة admin الصناعية `-emp.id` — كل جلسات الويب الحالية).
 *       > 0  ⇒ users.id **فقط** — لا يُفسَّر employees.id أبدًا. الشركة تُثبت بالربط الموثوق employees.userId
 *              وحده، وبشرط ألا يرتبط نفس المستخدم بموظف في أي شركة أخرى (أو بلا شركة) — وإلا مخفي.
 *       0 / NULL ⇒ فاعل غير معروف/نظام — لا يُنسب لأحد ⇒ مخفي.
 *     الاسم المحفوظ (sentByName / createdByName) للعرض فقط وليس دليل ملكية ولا يعبر به أي Tenant.
 *   أي صف مايتثبتش قطعيًا → مخفي عن كل الشركات (fail-closed).
 * الصفوف بـbusinessId: النشاط هو مصدر النطاق الأساسي — بلا تغيير.
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

/**
 * فاعل صف قديم (sentBy / createdBy) مثبت قطعيًا في نطاق الجلسة — بعقد الإشارة وحده (انظر أعلى الملف):
 * السالب موظف بمعرّفه، والموجب مستخدم يُربط بموظف واحد الشركة عبر employees.userId، والصفر/NULL لا أحد.
 * NULL يجعل المقارنتين UNKNOWN ⇒ لا تطابق. لا اسم ولا ABS.
 */
export function legacyActorInScope(idColumn: SQL | unknown, scope: TeamScope): SQL {
  const ids = inList(scopeIds(scope));
  return sql`((${idColumn} < 0 AND EXISTS (SELECT 1 FROM employees e WHERE e.id = -(${idColumn}) AND e.tenantId = ${scope.tenantId} AND e.businessId IN (${ids})))
    OR (${idColumn} > 0
      AND EXISTS (SELECT 1 FROM employees e WHERE e.userId = ${idColumn} AND e.tenantId = ${scope.tenantId} AND e.businessId IN (${ids}))
      AND NOT EXISTS (SELECT 1 FROM employees x WHERE x.userId = ${idColumn} AND (x.tenantId IS NULL OR x.tenantId <> ${scope.tenantId}))))`;
}

/** شرط WHERE لكل قراءة/إلغاء تفعيل على الرسائل الجماعية. */
export function broadcastScopeCondition(scope: TeamScope): SQL {
  return or(
    inArray(broadcastMessages.businessId, scopeIds(scope)),
    and(
      isNull(broadcastMessages.businessId),
      legacyActorInScope(broadcastMessages.sentBy, scope)
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
      legacyActorInScope(tasks.createdBy, scope)
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
