# Sprint 1 Migration Review Report

> الحالة: **للمراجعة فقط**. لم يتم إنشاء SQL Migration، ولم يتم تطبيق أي تغيير على أي قاعدة بيانات.

## 1. الهدف وحدود الأمان

التغيير Additive بقدر الإمكان، ويشغّل المحاسبة الجديدة من `accountingGoLiveAt` مستقل لكل
Business. البيانات الأقدم تفضل مقروءة من المسارات القديمة، ولا يتم تصنيع Business Events
تاريخية تلقائيًا. نقطة البداية المحاسبية هي Opening Inventory وOpening In-Transit وOpening
Financial Accounts المعتمدة.

أي تنفيذ فعلي لازم يسبقه Backup قابل للاسترجاع، Preflight ناجح، نافذة صيانة، واعتماد صريح.

## 2. الجداول الحالية التي ستتغير

### `businesses`

- إضافة `baseCurrency VARCHAR(3) NOT NULL DEFAULT 'EGP'`.
- إضافة `timezone VARCHAR(64) NOT NULL DEFAULT 'Africa/Cairo'`.
- إضافة `accountingGoLiveAt TIMESTAMP NULL`.
- إضافة `defaultWarehouseId INT NULL`.
- الأثر: لا فقد بيانات. ممنوع ضبط Go-Live قبل تجهيز الافتتاحيات والتحقق من Warehouse.

### `orders`

- إضافة `projectedShippingProviderId INT NULL`.
- إضافة `projectedShippingType VARCHAR(50) NULL`.
- إضافة `projectedPaymentType VARCHAR(50) NULL`.
- إضافة `projectedShippingCostSnapshot DECIMAL(18,4) NULL`.
- إضافة `projectedShippingCapturedAt TIMESTAMP NULL`.
- تحويل `source` من ENUM إلى `VARCHAR(60) NOT NULL` لإدارته من Business Configuration.
- تحويل `cancelReason` من ENUM إلى `VARCHAR(80) NULL` لنفس السبب.
- الأثر: قيم `source` و`cancelReason` الحالية تنتقل نصيًا بدون تغيير. السجلات القديمة تظل
  snapshots الجديدة فيها `NULL` ولا تدخل Data Quality Blocker إلا بعد Go-Live.

### `order_items`

- إضافة `grossAmountSnapshot`, `discountAmountSnapshot`, `netAmountSnapshot`,
  `customerShippingSnapshot`, `taxAmountSnapshot`, `projectedUnitCostSnapshot`,
  `unitCostSnapshot` كـ`DECIMAL(18,4)` حسب nullable/default الموضح في schema.
- إضافة `taxCodeSnapshot VARCHAR(30) NULL`, و`costCapturedAt TIMESTAMP NULL`.
- إضافة `reservedQuantity`, `stockOutQuantity`, `returnedQuantity` كأعداد صحيحة بصفر افتراضي.
- الأثر: لا إعادة حساب تاريخي تلقائي. البنود قبل Go-Live تظل قابلة للقراءة، والافتتاحيات هي
  اللي تحدد التكلفة المحاسبية الموثوقة.

### `returns`

- تحويل `returnReason` من ENUM إلى `VARCHAR(80) NOT NULL` عشان أسباب المرتجع تُدار لكل
  Business من الإعدادات.
- الأثر: القيم الحالية تنتقل نصيًا بدون تغيير، بنفس خطة الأعمدة المرحلية والتحقق المستخدمة
  مع `orders.source` و`orders.cancelReason`.

### `expenses`

- توسيع `amount` من `DECIMAL(10,2)` إلى `DECIMAL(18,4)` بدون تقليل دقة.
- إضافة العملة والحالة وفترة الخدمة ومركز التكلفة والضريبة والمبلغ المعترف والمدفوع وبيانات
  الـVoid والاعتماد: `currencyCode`, `status`, `serviceFrom`, `serviceTo`, `costCenterId`,
  `taxCode`, `taxAmount`, `recognizedAmount`, `paidAmount`, `voidedAt`, `voidReason`,
  `approvedBy`, `approvedAt`.
- الأثر: المصروفات الحالية تبدأ `draft` في خطة الـbackfill الآمنة، ولا يتم اعتبارها Accrued
  تلقائيًا حتى تتم مراجعتها أو تبقى ضمن التقارير القديمة قبل Go-Live.

### `treasury_transactions`

- توسيع `amount` من `DECIMAL(10,2)` إلى `DECIMAL(18,4)`.
- الأثر: widening فقط، بدون تقريب أو تغيير قيمة.

### `employee_advances`

- إضافة `sourceAccountId`, `receivableAccountId`, `financialTransactionId`, `evidenceUrl`.
- الاحتفاظ بـ`expenseId` للسجلات القديمة فقط.
- الأثر: لا تحويل تلقائي للسلف القديمة إلى Receivable؛ تتم المطابقة في Opening Balances.

## 3. الجداول الجديدة

### Business Events وConfiguration وصلاحيات

- `business_events`
- `business_configuration_values`
- `tenant_role_permissions`
- `accounting_event_mappings`
- `cost_centers`

### Financial Accounts وPayments

- `financial_accounts`
- `financial_transactions`
- `financial_transaction_entries`

### Inventory

- `inventory_balances`
- `inventory_reservations`
- `inventory_transactions`
- `purchase_receipts`
- `purchase_receipt_items`
- `return_inspections`
- `return_inspection_items`

### Shipping وSettlements

- `shipping_providers`
- `business_shipping_providers`
- `shipping_rate_versions`
- `shipping_rate_charges`
- `shipments`
- `shipment_events`
- `raw_provider_webhooks`
- `shipment_charge_snapshots`
- `carrier_settlements`
- `carrier_settlement_lines`

### Expenses وAds وClosing

- `expense_accrual_schedules`
- `expense_payments`
- `ad_spend_entries`
- `accounting_closings`
- `accounting_closing_lines`
- `accounting_closing_adjustments`
- `accounting_closing_actions`

## 4. ترتيب Migration المقترح

1. إنشاء الجداول الجديدة التي لا تعتمد على بيانات backfill.
2. إضافة الأعمدة الجديدة nullable وتوسيع أعمدة DECIMAL.
3. نسخ قيم `orders.source` و`orders.cancelReason` إلى أعمدة VARCHAR مرحلية، والتحقق من
   التطابق row-for-row، ثم swap آمن للأسماء. لا يتم حذف enum القديم قبل التحقق.
4. إضافة `orderId` في `shipment_charge_snapshots` كـnullable أولًا لو الجدول موجود من محاولة
   سابقة، ثم backfill من `shipments.orderId`، والتحقق أن المتبقي صفر، وبعدها فقط جعله NOT NULL.
5. إنشاء الـindexes والـunique indexes على دفعات مع مراقبة lock time وحجم الجداول.
6. إدخال Business Configuration الأولية من القيم التشغيلية الحالية بعد مراجعة كل Business؛
   لا توجد قائمة محافظات أو شركات أو رسوم تُزرع من الكود.
7. تجهيز Opening Accounts وOpening Inventory وOpening In-Transit يدويًا مع Evidence وMaker/Checker.
8. ضبط `accountingGoLiveAt` آخر خطوة لكل Business بعد نجاح reconciliation.

## 5. Preflight إلزامي

- التحقق من إصدار MySQL، timezone tables، charset/collation، والمساحة الحرة.
- حصر عدد وحجم كل جدول متأثر، وأطول زمن lock متوقع.
- التأكد من عدم وجود `businessId` يتيم أو Business بدون `tenantId` معتمد.
- التأكد من Business Base Currency وTimezone وDefault Warehouse.
- فحص القيم الحالية وطولها قبل تحويل `source` و`cancelReason` إلى VARCHAR.
- فحص overflow قبل توسيع DECIMAL، ثم checksum للقيم قبل/بعد.
- التأكد من عدم تكرار المفاتيح التي ستصبح unique، خصوصًا idempotency وrate versions والحسابات.
- reconciliation للكميات: legacy stock مقابل Opening Inventory، والشحنات المفتوحة مقابل
  Opening In-Transit.
- reconciliation مالي: أرصدة الخزن/البنوك/COD مقابل Opening Financial Accounts.
- تشغيل التطبيق على نسخة Restore منعزلة، ثم `type-check`, build, unit, integration, Browser E2E.

## 6. Backup

- Full consistent logical backup مع routines/triggers/events، ويفضل physical snapshot كطبقة ثانية.
- حفظ schema-only dump مستقل ونتائج Preflight وrow counts وchecksums.
- اختبار Restore فعلي إلى قاعدة جديدة قبل نافذة التنفيذ؛ وجود ملف backup بدون Restore test غير كافٍ.
- إيقاف الكتابة أو وضع النظام Read-only أثناء الخطوات التي تعمل swap للأعمدة أو Go-Live.

## 7. التحقق بعد التنفيذ

- مقارنة row counts وchecksums للأعمدة المتحولة.
- التأكد أن كل Order بعد Go-Live له Items وExpected Shipping Snapshot عند انطباق Rate.
- التأكد أن مجموع Inventory Value يطابق Opening + Stock In - Stock Out + Returns inspected.
- التأكد أن مجموع Financial Account entries يطابق current balances.
- تجربة Delivered/Returned/Partial Return/Inspection/Settlement/Expense/Payroll/Closing كاملة.
- منع Go-Live تلقائيًا لو أي Data Quality Blocker قائم.

## 8. Rollback

- قبل Go-Live: إرجاع نسخة التطبيق القديمة، وحذف الجداول/الأعمدة الإضافية فقط بعد أخذ dump لها.
- أثناء تحويل enums: الرجوع للأعمدة القديمة المحفوظة؛ ممنوع downgrade لو ظهرت قيمة Configuration
  لا يدعمها الـenum القديم قبل تحويلها/مراجعتها.
- بعد بدء الكتابة في V2 وقبل Lock: وقف الكتابة، تصدير Business Events الجديدة، Restore للنسخة
  السابقة، ثم reconciliation يدوي للأحداث التي حدثت بعد الـbackup.
- بعد أي Closing Locked: لا يوجد rollback محاسبي صامت. يتم Restore كامل لنقطة متسقة أو Forward
  Fix/Post-Closing Adjustment بعد اعتماد الإدارة.

## 9. المخاطر المعروفة

- إنشاء indexes على جداول كبيرة قد يسبب locks؛ يلزم Online DDL حيث يدعمه إصدار MySQL.
- عدم تجهيز Opening In-Transit يكرر أو يُسقط COGS عند وصول أحداث شحنات قديمة.
- تعيين Go-Live مبكرًا يمنع عمليات legacy قبل اكتمال Configuration.
- البيانات التاريخية غير الموثوقة لن تُعاد كتابتها؛ المقارنة بين Legacy وV2 قبل Go-Live فقط.
- File uploads الحالية تخزن محليًا بصلاحيات مقيدة؛ بيئة multi-instance تحتاج Object Storage قبل Deploy.

## 10. قرار التنفيذ

لا يتم توليد أو تطبيق Migration قبل: اعتماد هذا التقرير، أخذ Backup واختبار Restore، تحديد نافذة
الصيانة، وتقديم موافقة صريحة منفصلة.
