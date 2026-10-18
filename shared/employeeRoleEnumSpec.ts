/**
 * مواصفة 0045 — إضافة الدور `accounts_manager` (مدير الحسابات) إلى `employees.role` وحده.
 *
 * مراجعة كل ما يخزّن الدور قبل الكتابة (2026-10-11):
 *   • employees.role — ENUM (القيمة الجديدة تُرفض بدون تعديل) ⇒ هو التعديل الوحيد.
 *   • tenant_role_permissions.role / memberships.role / attendance_assignments.role — varchar(50): تكفي (16 حرفًا).
 *   • activity_logs.performedByRole varchar(20) / editedByRole varchar(30) / order_activity_events.actorRoleSnapshot
 *     varchar(50): لقطات نصية تاريخية، تكفي.
 *   • لا CHECK في أي Migration يعدّد أدوار الموظفين.
 *
 * القيم القديمة وترتيبها كما هي حرفيًا، والجديدة في **آخر** القائمة فقط (لا تتغير أي قيمة مخزّنة، وتعديل تعريف بلا
 * إعادة بناء في MySQL 8). خصائص العمود الأخرى (NOT NULL، الافتراضي 'agent'، charset/collation، بلا تعليق) تبقى.
 */
export const EMPLOYEE_ROLE_ENUM_BEFORE_0045 = [
  "agent", "warehouse", "manager", "facebook_entry", "scanner",
  "super_admin", "admin", "data_entry", "order_confirmation", "shipping", "accountant", "viewer",
  "moderator",
] as const;
/**
 * الشكل الفعلي في الإنتاج (فحص نسخة مسترجعة 2026-10-18): أول 12 قيمة من القائمة أعلاه **بنفس الترتيب حرفيًا** بلا
 * `moderator` — لأن ملف drizzle/manual/accounting-reorg.sql اتطبّق جزئيًا (employee_bonuses موجود، وتعديل الـENUM لا).
 * 0045 بتقبله كحالة «قبل» معروفة وتكمّل القيم الناقصة في **الآخر** فقط (moderator ثم accounts_manager).
 */
export const EMPLOYEE_ROLE_ENUM_LEGACY_WITHOUT_MODERATOR = EMPLOYEE_ROLE_ENUM_BEFORE_0045.slice(0, 12);
export const ACCOUNTS_MANAGER_ROLE = "accounts_manager" as const;
export const EMPLOYEE_ROLE_ENUM_AFTER_0045 = [...EMPLOYEE_ROLE_ENUM_BEFORE_0045, ACCOUNTS_MANAGER_ROLE] as const;

/** نص COLUMN_TYPE كما يعيده information_schema لقائمة ENUM. */
export const enumColumnType = (values: readonly string[]) => `enum(${values.map(v => `'${v}'`).join(",")})`;

/** أين يُخزَّن الدور كنص — التراجع يُرفض لو أي منها يستخدم الدور الجديد. */
export const ROLE_REFERENCE_COLUMNS = [
  { table: "employees", column: "role" },
  { table: "tenant_role_permissions", column: "role" },
  { table: "memberships", column: "role" },
  { table: "attendance_assignments", column: "role" },
] as const;
