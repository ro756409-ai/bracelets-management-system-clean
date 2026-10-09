import type { ReadOnlyExecutor } from "./balanceReconciliation.service";

/**
 * معاينة Backfill لسجل أحداث الأوردرات — **قراءة فقط** (منفّذ READ ONLY يرفض غير SELECT). لا يكتب حدثًا واحدًا.
 * الدرجات المعتمدة:
 *   • confirmed: `orders.confirmedByEmployeeId + confirmedAt` (أول مؤكّد، موظف من نفس الشركة)، و`order_edit_logs`
 *     لتغيير الحالة بموظف موجب من نفس الشركة.
 *   • partial: `activity_logs` (confirm/cancel/postpone) — هوية متضاربة الإشارة؛ لا يدخل الترتيب الافتراضي.
 *   • unknown: لم يرد، تأجيل الإدارة، الإسنادات، الطباعة — **لا حدث** أبدًا.
 * الأعداد لكل شركة على حدة (عبر businesses.tenantId)؛ لا يُطبع أي اتصال.
 */
export type BackfillPreview = {
  tenantId: number;
  confirmed: { confirmFromOrders: number; statusFromEditLogs: number };
  partial: { activityLogs: number };
  unknown: { noAnswerOrders: number; postponedOrders: number; assignedOrders: number; printedOrders: number };
};

export async function previewOrderEventsBackfill(exec: ReadOnlyExecutor, tenantId: number): Promise<BackfillPreview> {
  const n = async (q: string, p: unknown[]) => Number((await exec.query<{ n: number }>(q, p))[0]?.n ?? 0);
  const inTenant = "JOIN businesses b ON b.id = o.businessId AND b.tenantId = ?";
  return {
    tenantId,
    confirmed: {
      confirmFromOrders: await n(
        `SELECT COUNT(*) n FROM orders o ${inTenant} JOIN employees e ON e.id = o.confirmedByEmployeeId AND e.tenantId = b.tenantId
         WHERE o.confirmedByEmployeeId IS NOT NULL AND o.confirmedAt IS NOT NULL`, [tenantId]),
      statusFromEditLogs: await n(
        `SELECT COUNT(*) n FROM order_edit_logs l JOIN orders o ON o.id = l.orderId ${inTenant} JOIN employees e ON e.id = l.editedBy AND e.tenantId = b.tenantId
         WHERE l.field = 'status' AND l.editedBy > 0`, [tenantId]),
    },
    partial: {
      activityLogs: await n(
        `SELECT COUNT(*) n FROM activity_logs a JOIN orders o ON o.id = a.entityId ${inTenant}
         WHERE a.entityType = 'order' AND a.action IN ('confirm_order','cancel_order','postpone_order')`, [tenantId]),
    },
    unknown: {
      noAnswerOrders: await n(`SELECT COUNT(*) n FROM orders o ${inTenant} WHERE o.status = 'no_answer'`, [tenantId]),
      postponedOrders: await n(`SELECT COUNT(*) n FROM orders o ${inTenant} WHERE o.status = 'postponed'`, [tenantId]),
      assignedOrders: await n(`SELECT COUNT(*) n FROM orders o ${inTenant} WHERE o.assignedEmployeeId IS NOT NULL`, [tenantId]),
      printedOrders: await n(`SELECT COUNT(*) n FROM orders o ${inTenant} WHERE o.printedAt IS NOT NULL`, [tenantId]),
    },
  };
}
