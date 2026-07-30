export const COOKIE_NAME = "app_session_id";
export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = 'Please login (10001)';
export const NOT_ADMIN_ERR_MSG = 'You do not have required permission (10002)';

/**
 * الحالات اللي موظف التأكيدات مسموح له يحطها من شاشة التأكيدات.
 *
 * هنا في shared/ عشان الطرفين يقروا من نفس السطر: السيرفر بيعمل منها الـz.enum اللي
 * بيرفض أي قيمة تانية في `employeePortal.updateStatus`، والواجهة بتبني منها قائمة
 * الاختيار. لو كانت متكتوبة مرتين كان ممكن حد يزوّد حالة في الواجهة والحد الأمني
 * مايعرفش عنها حاجة.
 *
 * "لم يرد" مش منها عن قصد: ليها مسار منفصل (`markNoAnswer`) بيسجّل عدد محاولات
 * الاتصال كمان، فمش مجرد تغيير حالة.
 */
export const EMPLOYEE_SETTABLE_ORDER_STATUSES = [
  "new", "confirmed", "postponed", "cancelled",
] as const;

export type EmployeeSettableOrderStatus = (typeof EMPLOYEE_SETTABLE_ORDER_STATUSES)[number];
