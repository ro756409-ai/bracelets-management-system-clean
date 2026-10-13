/**
 * متطلبات Ledger V3 من الجداول **القائمة** (لا تُنشئها Migrations الدفتر): ما تقرؤه/تكتبه مسارات الطلبات والمخزون والشحن
 * والمرتبات وفحص الإقفال. جداول V2 للمخزون والشحن بلا ملفات Migration في المستودع ⇒ وجودها على أي بيئة يُثبت بفحص قراءة فقط
 * قبل التفعيل. `required: false` = يُتجاهل إن غاب (الكود يتعامل مع غيابه) ويُعرض للعلم.
 */
export type PrereqTable = { table: string; area: string; columns: string[]; required: boolean };

export const LEDGER_PREREQ_TABLES: readonly PrereqTable[] = [
  { area: "الطلبات", table: "orders", required: true, columns: ["id", "businessId", "orderNumber", "status", "totalAmount", "shippingFees", "bostaShipmentId", "bostaTrackingNumber", "assignedEmployeeId", "confirmedAt", "preparedAt", "shippedAt", "deliveredAt", "needsReview", "reviewReason"] },
  { area: "الطلبات", table: "order_items", required: true, columns: ["id", "orderId", "productId", "productName", "quantity", "unitPrice", "unitCostSnapshot", "stockOutQuantity", "returnedQuantity"] },
  { area: "الأنشطة", table: "businesses", required: true, columns: ["id", "tenantId", "name", "timezone", "accountingGoLiveAt", "defaultWarehouseId"] },
  { area: "المخزون", table: "warehouses", required: true, columns: ["id", "businessId", "name"] },
  { area: "المخزون", table: "products", required: true, columns: ["id", "name", "businessId"] },
  { area: "المخزون", table: "inventory_balances", required: true, columns: ["id", "businessId", "warehouseId", "productId", "inventoryKey", "onHandQuantity", "reservedQuantity", "inventoryValue", "movingAverageCost", "version"] },
  { area: "المخزون", table: "inventory_transactions", required: true, columns: ["id", "businessId", "inventoryBalanceId", "sourceType", "sourceId", "createdAt"] },
  { area: "المخزون", table: "inventory_reservations", required: true, columns: ["id", "businessId", "orderId", "status"] },
  { area: "المخزون", table: "business_events", required: true, columns: ["id", "businessId", "idempotencyKey"] },
  { area: "المرتجعات", table: "return_inspections", required: true, columns: ["id", "businessId", "orderId", "status", "approvedAt", "inspectedBy"] },
  { area: "المرتجعات", table: "return_inspection_items", required: true, columns: ["id", "inspectionId", "businessId", "orderItemId", "quantity", "unitCostSnapshot", "disposition"] },
  { area: "الجرد", table: "stocktakes", required: true, columns: ["id", "businessId", "warehouseId", "status", "approvedAt", "createdAt"] },
  { area: "الجرد", table: "stocktake_lines", required: true, columns: ["id", "stocktakeId", "businessId", "warehouseId", "productId", "inventoryKey", "systemQuantity", "countedQuantity", "unitCostSnapshot"] },
  { area: "المشتريات", table: "purchase_receipts", required: true, columns: ["id", "businessId", "status", "totalAmount"] },
  { area: "الشحن", table: "carrier_webhook_inbox", required: true, columns: ["id", "tenantId", "businessId", "shipmentId", "stateCode", "eventTimestamp", "processingStatus"] },
  { area: "الموظفون", table: "employees", required: true, columns: ["id", "tenantId", "businessId", "name", "role", "isActive"] },
  { area: "الصلاحيات", table: "tenant_role_permissions", required: true, columns: ["tenantId", "role", "permission", "isAllowed"] },
  { area: "المرتبات", table: "employee_salary_profiles", required: true, columns: ["employeeId", "businessId", "salaryType", "baseSalary", "dailyRate", "commissionType", "commissionValue", "commissionBasis", "effectiveFrom", "isActive"] },
  { area: "المرتبات", table: "payroll_settings", required: true, columns: ["businessId", "workingDaysPerMonth", "workHoursPerDay", "overtimeMultiplier"] },
  { area: "الحضور (0042)", table: "attendance_days", required: true, columns: ["tenantId", "employeeId", "workDate", "status", "lateMinutes", "overtimeMinutes", "requiresReview", "approvedByEmployeeId"] },
  // أرشيف V1/V2: حاجز الكتابات القديمة وبند قائمة الفحص يتجاهلان الجدول الغائب
  { area: "أرشيف V1/V2", table: "treasury_transactions", required: false, columns: ["businessId", "createdAt"] },
  { area: "أرشيف V1/V2", table: "financial_transactions", required: false, columns: ["businessId", "createdAt"] },
  { area: "أرشيف V1/V2", table: "expenses", required: false, columns: ["businessId", "createdAt"] },
  { area: "أرشيف V1/V2", table: "employee_advances", required: false, columns: ["businessId", "createdAt"] },
] as const;

/** حالة Migrations الدفتر (للعلم — تُطبَّق بأدواتها الرسمية): جداول/قيم يكفي وجودها للدلالة. */
export const LEDGER_MIGRATION_MARKERS = [
  { id: "0040", label: "جداول Ledger V3", tables: ["ledger_accounts", "ledger_transactions", "ledger_entries", "ledger_periods", "ledger_tenant_flags"] },
  { id: "0047", label: "شركات الشحن", tables: ["ledger_shipments", "ledger_carrier_review_items", "ledger_settings"] },
  { id: "0048", label: "المرتبات والسلف", tables: ["ledger_payroll_runs", "ledger_payroll_lines", "ledger_advances", "ledger_advance_installments"] },
  { id: "0049", label: "الموردون والورشة", tables: ["ledger_suppliers", "ledger_supplier_documents", "ledger_workshop_batches", "ledger_workshop_events"] },
  { id: "0050", label: "صور الإقفال", tables: ["ledger_period_snapshots"] },
] as const;
