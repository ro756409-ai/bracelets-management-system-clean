# حزمة قرار — تقارير أداء الموظفين + الحضور والانصراف + قرارات Backend (قبل أي Migration)

التاريخ: 2026-10-09 · الفرع المحلي `staging/bosta-package-images`.
**لم يُكتب أي ملف SQL ولم يُشغَّل أي Migration، ولا `drizzle-kit push/generate` (ولا حتى على قواعد الاختبار في هذه المرحلة)، ولم يُلمس Staging/Production.**
كل DDL هنا **مقترح نصي** للمراجعة. كل مسار موثّق بـ`ملف:سطر` وقت الكتابة.

---

## 0) الخلاصة

| البند | الحالة |
|---|---|
| P0 الرسائل الجماعية والمهام | **أُصلح** (commit `9b0d672`) — بلا Schema. |
| P0 استعلامات لوحة المدير وأفعال الأوردر | **أُصلح** (commit `30515c4`) — بلا Schema. |
| روابط الشحن في لوحة الموظف | **أُصلح** (commits `03b9e12` + `7f1ad56`) — Query قراءة صغيرة بلا Migration. |
| التقرير الحالي «أداء الموظفين» | **وُسم «ملخص تشغيلي تقديري»** بلا تغيير حسابات (commit `11ba3e7`). |
| تقارير الأداء التاريخية (C) | **تحتاج Migration 0041** — جدول أحداث (Event Ledger). موافقة مبدئية فقط. |
| الحضور والانصراف (D) | **تحتاج Migration 0042** — 5 جداول. موافقة مبدئية فقط. |
| صلاحيات C/D الجديدة | مفاتيح نصية (`tenant_role_permissions.permission` varchar(100)) → كود فقط، **لم تُنفّذ**. |
| الفترة التجريبية | لا Enforcement إطلاقًا — تصميم كامل هنا (§9)، **لا تنفيذ قبل قرارك**. |
| أدوار `/manager-dashboard` | جدول قرار (§10) — لا توسيع للسيرفر قبل قرارك. |

---

## 1) P0 — خريطة الثغرات قبل/بعد (منفّذة ومختبرة)

| # | المسار | قبل | بعد | اختبار |
|---|---|---|---|---|
| 1 | `employeePortal.sendBroadcast` / `broadcast.send` | `UPDATE broadcast_messages SET isActive=0` على **كل** الشركات؛ الصف بلا businessId | إلغاء داخل نطاق الجلسة فقط + صف لكل نشاط في النطاق، في transaction واحدة | teamScope.security: «إرسال B مايعطّلش رسالة A» |
| 2 | `clearBroadcast` / `broadcast.clear` | يعطّل رسائل كل الشركات | نطاق الجلسة؛ نطاق فاضي = FORBIDDEN | «clear من B مايلمسش A» |
| 3 | `activeBroadcast` / `broadcast.getActive` | آخر رسالة نشطة **في المنصة كلها** | آخر رسالة داخل أنشطة الجلسة؛ القديمة (بلا businessId) لشركتها فقط بإثبات المرسل (المعرّف + الاسم) | «Super admin يشوف شركته بس» + «الصفوف القديمة» |
| 4 | `tasks.create` | المستلم من أي tenant، بلا businessId | المستلم لازم في نفس الـtenant والنشاط؛ businessId يُكتب؛ مدخلات strict | «A مايقدرش ينشئ مهمة لموظف B ولا لنشاط تاني» |
| 5 | `tasks.list` | بلا employeeId = مهام **كل الشركات** | نطاق الجلسة دائمًا؛ employeeId خارج النطاق = FORBIDDEN | «القائمة معزولة» + «مدير بلا نشاط = صفر» |
| 6 | `tasks.updateStatus/delete` | `requireOwned` يرفض كل الصفوف (businessId NULL دائمًا) | شرط الملكية داخل WHERE نفسه؛ NOT_FOUND/FORBIDDEN | «A مايعدّلش ولا يحذفش مهمة B» |
| 7 | `employeePortal.dailyChart` | `getDailyOrdersChart(emp.businessId ?? undefined)` — الاستعلام بلا شرط tenant ⇒ مدير بلا نشاط يرى **كل الـtenants** | `scopeBusinessIds(empScope(ctx), {})`؛ القائمة الفاضية = `[-1]` | managerPortalScope: «A1=3، B=4، نفس التاريخ» |
| 8 | `productsList/lowStockProducts/inventoryMovements/cancellationReasons` | نفس النمط fail-open | نطاق الجلسة | «المنتجات والمخزون والحركات معزولة» |
| 9 | `assertEmployeeOwnsOrder` (confirm/cancel/postpone/markNoAnswer/notes/edit…) | المدير/الأدمن **معفى من كل فحص** ⇒ يأكّد/يلغي أوردر tenant آخر بمعرّفه | فحص نطاق الأوردر لكل الأدوار قبل استثناء الإسناد | «المدير والمالك مايقدروش يأكّدوا/يلغوا/يأجّلوا أوردر B» |
| 10 | `employeePortal.assignOrder` | أي employeeId من أي tenant | المستلم في النطاق | «مايقدرش يسند لموظف B» |
| 11 | `employeePortal.createOrder` | أي productId | المنتجات والـvariant في النطاق قبل أي كتابة | «منتج من B يُرفض بلا أوردر» |
| 12 | `businesses.groupsWithBusinesses` | نطاق مجهول ⇒ كل المجموعات؛ التصفية بعد الجلب | نطاق مجهول ⇒ `[]`؛ التصفية في SQL | «المالك: أنشطة شركته فقط» |
| 13 | `getDashboardStats/getLowStockProducts/getInventoryMovements/getDailyOrdersChart` | `[]` = بلا فلتر | `[]` = `[-1]` (دفاع إضافي) | ثابت + DB |
| 14 | روابط الشحن (`/employee-dashboard`) | تظهر لكل موظف | تظهر فقط بـ`shipping_ops.view` من **هوية البوابة** (`employeePortal.myPermissions`)؛ حارس السيرفر صار يحترم تخصيص الشركة | shippingPortalPermission: منح/سحب فوري + جلسة مالك في نفس المتصفح |

**ملاحظات صادقة:**
- لا يوجد نموذج «منح نشاط لموظف» (جدول `memberships` يربط موظفًا بـtenant فقط). لذلك مدير البوابة نطاقه نشاطه، والمدير بلا نشاط = **Fail-closed**. «مدير مع نشاطين» متاح فقط بجلسة إدارة الشركة (owner/admin) = كل أنشطة شركته — مُختبر.
- Platform Admin كيان منفصل تمامًا (كوكي `platform_admin_session` على `/api/platform` فقط)؛ `createContext` لا يقرؤه، فلا يصل لأي Endpoint تشغيلي.
- لوحة مهام الموظف (`EmployeeDashboard` → `tasks.list`) ترجع UNAUTHORIZED لموظفي البوابة غير الإداريين منذ قبل هذا العمل (`tasks.*` على `protectedProcedure`). لم يُغيَّر العقد؛ القرار في §11.

---

## 2) Audit أداء الموظفين (C1) — ملخص

الهوية في السجلات الحالية متضاربة: جلسات الإدارة تكتب `-emp.id` (server/_core/context.ts:45)، البوابة تكتب `emp.id`، النظام `0`.
مسارات بلا أي سجل: `markNoAnswer` (إدارة وبوابة)، تأجيل الإدارة، كل الإسنادات (assign/bulk/unassign/reclaim)، الطباعة، حذف/استرجاع المكررات.
السجلات الموجودة (`activity_logs`, `order_edit_logs`) بلا tenantId، ومعظمها بلا businessId وبلا from/to وبلا منع تكرار.
`getEmployeePerformance` (server/db.ts:2755) يحسب من **الإسناد الحالي والحالة الحالية** ⇒ ليس تاريخيًا. **القرار: البيانات الحالية لا تكفي.**

---

## 3) التحقق من أسماء الملفات (مُثبت)

- `drizzle/meta/_journal.json`: **35 entry** من `0000_sparkling_deadpool` إلى `0034_supplier_ledger` فقط.
- ملفات خارج الـjournal عمدًا (مكتوبة يدويًا): `0035_phase3_multitenant_signup` … `0040_ledger_v3` (+ `drizzle/ledgerV3.schema.ts` خارج drizzle.config).
- **`0041` و`0042` غير مستخدمين**: لا ملف في `drizzle/` ولا `drizzle/manual/` ولا `scripts/`، ولا أي إشارة في الكود، ولا في تاريخ Git لكل الفروع (313 commit).
- الترقيم المقترح: `drizzle/0041_order_activity_events.sql` و`drizzle/0042_attendance.sql` + `drizzle/orderEvents.schema.ts` و`drizzle/attendance.schema.ts` (خارج drizzle.config) + `scripts/migrate-0041-order-events.ts` و`scripts/migrate-0042-attendance.ts` بأوضاع `--preflight/--apply/--verify/--rollback` ومانع إنتاج كسكربت 0040.
- تجهيز Schema الاختبارات في هذه المرحلة: **لم يُشغَّل drizzle-kit**. القواعد المؤقتة تُبنى من dump مخطط فقط (80 جدولًا، مطابق لـ`schema.ts`)، ثم يُتحقق منها بأداتي المشروع للقراءة فقط `scripts/verify-schema-drift.ts` (لا اختلاف) و`scripts/test-db-preflight.ts`.

### الحقائق التي بُني عليها الـDDL
- كل الجداول: `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`.
- المفاتيح: `int` (`tenants.id`, `businesses.id`, `employees.id`, `orders.id`).
- `businesses.tenantId` و`employees.tenantId` **nullable**؛ `orders` **بلا tenantId** (`businessId int NOT NULL DEFAULT 1`).
- `orders.status` = enum('new','confirmed','postponed','cancelled','preparing','shipped','delivered','no_answer','returned','printed').
- الفهرسان المركّبان `businesses_tenant_id(tenantId,id)` و`employees_tenant_id(tenantId,id)` **يُنشآن داخل 0040 فقط**، و0040 لم يُشغَّل في أي بيئة ⇒ قرار تقني (§8-أ).
- CHECK constraints تُفرض في MySQL ≥ 8.0.16 فقط ⇒ الـpreflight يتحقق من `VERSION()`؛ وإن كان أقدم تُنقل القيود للخدمة باختبارات.

---

## 4) أ) `0041_order_activity_events.sql` — DDL مقترح كامل

```sql
-- 0041 — Order activity events (Event Ledger). ADDITIVE فقط: جدول جديد واحد (+ الفهرسان المركّبان حسب §8-أ).
-- لا تعديل لأي عمود أو صف قائم. غير مضاف للـjournal. التشغيل يدوي بعد backup وبعد Staging فقط.

-- (الخيار المُوصى به §8-أ: فقط إذا لم يكن 0040 مطبّقًا — الـpreflight يقرر ويرفض لو أحدهما موجود جزئيًا)
ALTER TABLE `businesses` ADD UNIQUE INDEX `businesses_tenant_id` (`tenantId`,`id`);
--> statement-breakpoint
ALTER TABLE `employees` ADD UNIQUE INDEX `employees_tenant_id` (`tenantId`,`id`);
--> statement-breakpoint
CREATE TABLE `order_activity_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NOT NULL,
	`orderId` int NOT NULL,
	`orderNumberSnapshot` varchar(20) NOT NULL,
	`eventType` enum('confirm','no_answer','postpone','cancel','edit','edit_items','assign','unassign','status_change','print','ship_update','return','duplicate_mark','duplicate_restore') NOT NULL,
	`fromStatus` enum('new','confirmed','postponed','cancelled','preparing','shipped','delivered','no_answer','returned','printed') NULL,
	`toStatus` enum('new','confirmed','postponed','cancelled','preparing','shipped','delivered','no_answer','returned','printed') NULL,
	`actorType` enum('employee','system','webhook','backfill') NOT NULL,
	`actorEmployeeId` int NULL,
	`actorRoleSnapshot` varchar(50) NULL,
	`actorNameSnapshot` varchar(100) NULL,
	`assigneeEmployeeIdAtEvent` int NULL,
	`previousAssigneeEmployeeId` int NULL,
	`reason` varchar(160) NULL,
	`callAttempt` smallint unsigned NULL,
	`source` enum('admin_ui','employee_portal','bulk','webhook_bosta','webhook_easyorders','system','backfill') NOT NULL,
	`backfillConfidence` enum('confirmed','partial') NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`payloadHash` char(64) NOT NULL,
	`occurredAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`metadataJson` json NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_activity_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `oae_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	CONSTRAINT `oae_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	INDEX `oae_tenant_occurred` (`tenantId`,`occurredAt`),
	INDEX `oae_tenant_actor_occurred` (`tenantId`,`actorEmployeeId`,`occurredAt`),
	INDEX `oae_tenant_business_occurred` (`tenantId`,`businessId`,`occurredAt`),
	INDEX `oae_tenant_type_occurred` (`tenantId`,`eventType`,`occurredAt`),
	INDEX `oae_order_occurred` (`orderId`,`occurredAt`),
	CONSTRAINT `fk_oae_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_oae_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_oae_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_oae_tenant_assignee` FOREIGN KEY (`tenantId`,`assigneeEmployeeIdAtEvent`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_oae_tenant_prev_assignee` FOREIGN KEY (`tenantId`,`previousAssigneeEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_oae_actor` CHECK ((`actorType` = 'employee' AND `actorEmployeeId` IS NOT NULL) OR (`actorType` <> 'employee' AND `actorEmployeeId` IS NULL)),
	CONSTRAINT `chk_oae_backfill` CHECK ((`actorType` = 'backfill') = (`source` = 'backfill') AND ((`source` = 'backfill') = (`backfillConfidence` IS NOT NULL))),
	CONSTRAINT `chk_oae_call` CHECK (`callAttempt` IS NULL OR `eventType` = 'no_answer')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ROLLBACK قبل أي استخدام (معلّق — يُشغّل فقط عبر السكربت --rollback بعد التحقق أن الجدول فارغ):
-- DROP TABLE `order_activity_events`;
-- (والفهرسان يُحذفان فقط إذا أنشأهما 0041 ولم يُطبَّق 0040 بعدها:)
-- ALTER TABLE `employees` DROP INDEX `employees_tenant_id`;
-- ALTER TABLE `businesses` DROP INDEX `businesses_tenant_id`;
```

### السياسات
- **orderId بلا FK على `orders`** عن قصد: حذف المكررات اليوم حذف نهائي (routers.ts duplicates.delete)؛ FK بـRESTRICT كان سيكسر هذه الميزة. السلامة تُفرض في الخدمة: `recordOrderEvent` يقرأ الأوردر `FOR UPDATE` داخل نفس الـtransaction ويأخذ `businessId` منه (لا من العميل)، ويأخذ `tenantId` من `businesses.tenantId`؛ و`orderNumberSnapshot` يحفظ التاريخ بعد الحذف.
- **actorType / actorEmployeeId**: `employee` ⇒ معرّف موجب حقيقي (`resolveActingEmployeeId`، لا `-emp.id`)؛ `system/webhook/backfill` ⇒ NULL — لا تُنسب لأحد (CHECK).
- **Event types**: كما في الـenum؛ `status_change` للانتقالات غير المغطاة بنوع خاص (preparing/shipped/delivered من الإدارة).
- **payloadHash** = SHA-256 لتمثيل قانوني (canonical JSON مرتب المفاتيح) للحمولة: نفس المفتاح + نفس الـhash ⇒ إعادة (لا شيء جديد، يرجع الحدث الموجود)؛ نفس المفتاح + hash مختلف ⇒ `CONFLICT` (منع إعادة استخدام المفتاح لفعل مختلف).
- **غير قابلة للتعديل**: لا UPDATE ولا DELETE في أي مسار كود (اختبار ثابت يمنع `update(orderActivityEvents)`/`delete(orderActivityEvents)`). اختياري بقرار: Triggers `BEFORE UPDATE/DELETE … SIGNAL` — تحتاج صلاحية `TRIGGER` و`log_bin_trust_function_creators` على MySQL المُدار، لذلك غير مُوصى بها افتراضيًا. التصحيح = حدث جديد.
- **الوقت**: `timestamp(3)` (UTC داخليًا، ملّي ثانية للترتيب)؛ العرض والتجميع اليومي بـ`Africa/Cairo` في طبقة الخدمة. (`timestamp` محدود بـ2038 — نفس قيد كل جداول المشروع الحالية.)

### الأثر على مسارات الكتابة الحالية
- نقطة كتابة **واحدة** داخل دوال db (لا في الراوترات) لتجنّب Dual Events: `confirmOrder`, `postponeOrder`, `cancelOrder`, `markNoAnswer*`, `updateOrder(status)`, `assignOrderToEmployee`, `bulkAssignOrders`, `unassign/reclaim`, `markPrinted`, `editOrder`, `replaceOrderItems/editOrderItems`, `duplicates.mark/restore`, `bostaWebhook` (ship_update)، `easyorderWebhook` (status). ≈ 20 موضعًا.
- المسارات غير المعاملية حاليًا (مثل `postponeOrder`) تُلف في transaction: UPDATE الأوردر بشرط `WHERE id=? AND status=?from` ⇒ الحدث يُكتب فقط إذا `affectedRows = 1`. فشل أحدهما ⇒ يرجع الاثنان.
- **Double-click**: الواجهة تولّد `operationId` (UUID) مرة واحدة لكل نقرة فعلية وتُعيد إرساله عند إعادة المحاولة ⇒ `idempotencyKey = ${eventType}:${orderId}:${operationId}`؛ الويبهوك: `${provider}:${externalEventId}`؛ الدُفعات: `${operationId}:${orderId}`.
- لا تغيير في Bosta/Easy Orders/الرواتب/Ledger سوى سطر تسجيل الحدث في الويبهوك (يحتاج موافقتك ضمن §11 لأن القاعدة «لا ربط Bosta/Easy Orders»؛ البديل: أحداث الويبهوك تُسجَّل لاحقًا).

### Backfill (لا يُنفَّذ إلا بموافقة، بعد Go-Live، وفي جدول منفصل منطقيًا بـ`source='backfill'`)
| الدرجة | المصدر | ما يُرحَّل |
|---|---|---|
| confirmed | `orders.confirmedByEmployeeId + confirmedAt` | حدث confirm واحد (أول مؤكّد فقط) |
| confirmed | `order_edit_logs` (field=status، موظف موجب) | status_change بقيم from/to |
| partial | `activity_logs` confirm/cancel/postpone (الإشارة السالبة تُعكس، business عبر الأوردر) | يُعلَّم `partial` ويُعرض منفصلًا |
| unknown | no_answer، تأجيل الإدارة، الإسنادات، الطباعة | **لا شيء** — لا تخمين |

### Go-Live
1. نسخة احتياطية → preflight (قراءة فقط: الإصدار، غياب الجدول، حالة الفهرسين، لا `tenantId NULL` في businesses/employees، `foreign_key_checks=1`).
2. تطبيق 0041 على Staging → `--verify` → نشر الكود الذي يكتب الأحداث خلف علم `ORDER_EVENTS_WRITE` (افتراضيًا off) → تفعيل → مراقبة أسبوع → Production بنفس الترتيب.
3. التقرير الرسمي الجديد يبدأ من تاريخ التفعيل؛ ما قبله يُعرض «غير متاح» أو Backfill موسوم.

### Rollback
- **قبل أي حدث**: `--rollback` يتحقق أن الجدول فارغ ثم `DROP TABLE` (+ الفهرسين إن كان 0041 منشئهما ولم يُطبَّق 0040).
- **بعد وجود أحداث**: لا DROP. إطفاء `ORDER_EVENTS_WRITE` فقط؛ الجدول يبقى للقراءة. أي حذف يتطلب تصديرًا كاملًا وقرارًا مكتوبًا.

---

## 5) ب) `0042_attendance.sql` — DDL مقترح كامل

```sql
-- 0042 — الحضور والانصراف. ADDITIVE فقط: 5 جداول جديدة. يعتمد على الفهرسين المركّبين (0040 أو 0041).
-- لا ربط بالرواتب ولا Ledger. لا GPS ولا بيانات حيوية. لا حذف.

CREATE TABLE `attendance_shifts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NULL,
	`name` varchar(80) NOT NULL,
	`startTime` time NOT NULL,
	`endTime` time NOT NULL,
	`crossesMidnight` tinyint(1) NOT NULL,
	`workDaysMask` tinyint unsigned NOT NULL DEFAULT 31,
	`graceMinutes` smallint unsigned NOT NULL DEFAULT 0,
	`allowedBreakMinutes` smallint unsigned NOT NULL DEFAULT 0,
	`overtimeStartsAfterMinutes` smallint unsigned NOT NULL DEFAULT 0,
	`earlyClockInLimitMinutes` smallint unsigned NOT NULL DEFAULT 60,
	`earlyLeaveToleranceMinutes` smallint unsigned NOT NULL DEFAULT 0,
	`timezone` varchar(64) NOT NULL DEFAULT 'Africa/Cairo',
	`effectiveFrom` date NOT NULL,
	`effectiveTo` date NULL,
	`isActive` tinyint(1) NOT NULL DEFAULT 1,
	`version` int unsigned NOT NULL DEFAULT 1,
	`createdByEmployeeId` int NOT NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_shifts_id` PRIMARY KEY(`id`),
	CONSTRAINT `ash_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	INDEX `ash_tenant_active_from` (`tenantId`,`isActive`,`effectiveFrom`),
	CONSTRAINT `fk_ash_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_ash_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_ash_tenant_creator` FOREIGN KEY (`tenantId`,`createdByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_ash_midnight` CHECK (`crossesMidnight` = (`endTime` <= `startTime`)),
	CONSTRAINT `chk_ash_days` CHECK (`workDaysMask` BETWEEN 1 AND 127),
	CONSTRAINT `chk_ash_limits` CHECK (`graceMinutes` <= 240 AND `allowedBreakMinutes` <= 480 AND `earlyClockInLimitMinutes` <= 480 AND `overtimeStartsAfterMinutes` <= 720 AND `earlyLeaveToleranceMinutes` <= 240),
	CONSTRAINT `chk_ash_range` CHECK (`effectiveTo` IS NULL OR `effectiveTo` >= `effectiveFrom`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `attendance_assignments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`shiftId` int NOT NULL,
	`targetType` enum('employee','role','business','tenant_default') NOT NULL,
	`employeeId` int NULL,
	`role` varchar(50) NULL,
	`businessId` int NULL,
	`effectiveFrom` date NOT NULL,
	`effectiveTo` date NULL,
	`assignedByEmployeeId` int NOT NULL,
	`assignedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`endedByEmployeeId` int NULL,
	`endedAt` timestamp(3) NULL,
	CONSTRAINT `attendance_assignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `aas_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	INDEX `aas_tenant_employee_from` (`tenantId`,`employeeId`,`effectiveFrom`),
	INDEX `aas_tenant_target_from` (`tenantId`,`targetType`,`effectiveFrom`),
	CONSTRAINT `fk_aas_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_aas_tenant_shift` FOREIGN KEY (`tenantId`,`shiftId`) REFERENCES `attendance_shifts`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_assigner` FOREIGN KEY (`tenantId`,`assignedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_ender` FOREIGN KEY (`tenantId`,`endedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_aas_target` CHECK (
		(`targetType` = 'employee' AND `employeeId` IS NOT NULL AND `role` IS NULL AND `businessId` IS NULL) OR
		(`targetType` = 'role' AND `employeeId` IS NULL AND `role` IS NOT NULL) OR
		(`targetType` = 'business' AND `employeeId` IS NULL AND `role` IS NULL AND `businessId` IS NOT NULL) OR
		(`targetType` = 'tenant_default' AND `employeeId` IS NULL AND `role` IS NULL AND `businessId` IS NULL)),
	CONSTRAINT `chk_aas_range` CHECK (`effectiveTo` IS NULL OR `effectiveTo` >= `effectiveFrom`),
	CONSTRAINT `chk_aas_end` CHECK ((`endedAt` IS NULL) = (`endedByEmployeeId` IS NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `attendance_days` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`employeeId` int NOT NULL,
	`businessId` int NULL,
	`workDate` date NOT NULL,
	`timezone` varchar(64) NOT NULL,
	`shiftId` int NULL,
	`shiftSnapshotJson` json NULL,
	`scheduledStartAt` timestamp(3) NULL,
	`scheduledEndAt` timestamp(3) NULL,
	`status` enum('open','on_break','closed','absent','leave','mission','holiday','day_off','incomplete') NOT NULL DEFAULT 'open',
	`firstInAt` timestamp(3) NULL,
	`lastOutAt` timestamp(3) NULL,
	`openBreakStartedAt` timestamp(3) NULL,
	`workedMinutes` int unsigned NOT NULL DEFAULT 0,
	`breakMinutes` int unsigned NOT NULL DEFAULT 0,
	`excessBreakMinutes` int unsigned NOT NULL DEFAULT 0,
	`lateMinutes` int unsigned NOT NULL DEFAULT 0,
	`earlyLeaveMinutes` int unsigned NOT NULL DEFAULT 0,
	`overtimeMinutes` int unsigned NOT NULL DEFAULT 0,
	`requiresReview` tinyint(1) NOT NULL DEFAULT 0,
	`reviewReason` varchar(160) NULL,
	`approvedByEmployeeId` int NULL,
	`approvedAt` timestamp(3) NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_days_id` PRIMARY KEY(`id`),
	CONSTRAINT `ad_tenant_employee_date_unique` UNIQUE(`tenantId`,`employeeId`,`workDate`),
	CONSTRAINT `ad_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	INDEX `ad_tenant_date_status` (`tenantId`,`workDate`,`status`),
	INDEX `ad_tenant_business_date` (`tenantId`,`businessId`,`workDate`),
	CONSTRAINT `fk_ad_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_ad_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_ad_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_ad_tenant_shift` FOREIGN KEY (`tenantId`,`shiftId`) REFERENCES `attendance_shifts`(`tenantId`,`id`),
	CONSTRAINT `fk_ad_tenant_approver` FOREIGN KEY (`tenantId`,`approvedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_ad_times` CHECK (`lastOutAt` IS NULL OR `firstInAt` IS NULL OR `lastOutAt` >= `firstInAt`),
	CONSTRAINT `chk_ad_break` CHECK ((`status` = 'on_break') = (`openBreakStartedAt` IS NOT NULL)),
	CONSTRAINT `chk_ad_approval` CHECK ((`approvedAt` IS NULL) = (`approvedByEmployeeId` IS NULL)),
	CONSTRAINT `chk_ad_snapshot` CHECK (`shiftId` IS NULL OR `shiftSnapshotJson` IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `attendance_correction_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`employeeId` int NOT NULL,
	`attendanceDayId` int NULL,
	`workDate` date NOT NULL,
	`requestType` enum('missing_clock_in','missing_clock_out','wrong_time','break_fix','absence_to_leave','absence_to_mission','other') NOT NULL,
	`requestedAt` timestamp(3) NULL,
	`reason` varchar(500) NOT NULL,
	`note` varchar(500) NULL,
	`status` enum('pending','approved','rejected','canceled') NOT NULL DEFAULT 'pending',
	`reviewedByEmployeeId` int NULL,
	`reviewedAt` timestamp(3) NULL,
	`reviewReason` varchar(500) NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_correction_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `acr_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	CONSTRAINT `acr_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	INDEX `acr_tenant_status_created` (`tenantId`,`status`,`createdAt`),
	INDEX `acr_tenant_employee_date` (`tenantId`,`employeeId`,`workDate`),
	CONSTRAINT `fk_acr_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_acr_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_acr_tenant_day` FOREIGN KEY (`tenantId`,`attendanceDayId`) REFERENCES `attendance_days`(`tenantId`,`id`),
	CONSTRAINT `fk_acr_tenant_reviewer` FOREIGN KEY (`tenantId`,`reviewedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_acr_reason` CHECK (CHAR_LENGTH(TRIM(`reason`)) >= 3),
	CONSTRAINT `chk_acr_reject` CHECK (`status` <> 'rejected' OR CHAR_LENGTH(TRIM(COALESCE(`reviewReason`, ''))) >= 3),
	CONSTRAINT `chk_acr_review` CHECK ((`status` IN ('pending','canceled')) = (`reviewedByEmployeeId` IS NULL)),
	CONSTRAINT `chk_acr_no_self` CHECK (`reviewedByEmployeeId` IS NULL OR `reviewedByEmployeeId` <> `employeeId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `attendance_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`attendanceDayId` int NOT NULL,
	`employeeId` int NOT NULL,
	`eventType` enum('clock_in','break_start','break_end','clock_out','absence','leave','mission','correction','day_close','day_reopen') NOT NULL,
	`occurredAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`effectiveAt` timestamp(3) NULL,
	`actorType` enum('self','admin','system') NOT NULL,
	`actorEmployeeId` int NULL,
	`source` enum('web','mobile_web','admin','system') NOT NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`payloadHash` char(64) NOT NULL,
	`correctionOfEventId` bigint NULL,
	`correctionRequestId` int NULL,
	`reason` varchar(200) NULL,
	`oldValueJson` json NULL,
	`newValueJson` json NULL,
	`clientInfoJson` json NULL,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_events_id` PRIMARY KEY(`id`),
	CONSTRAINT `ae_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	CONSTRAINT `ae_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	INDEX `ae_tenant_employee_occurred` (`tenantId`,`employeeId`,`occurredAt`),
	INDEX `ae_day_occurred` (`attendanceDayId`,`occurredAt`),
	CONSTRAINT `fk_ae_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_ae_tenant_day` FOREIGN KEY (`tenantId`,`attendanceDayId`) REFERENCES `attendance_days`(`tenantId`,`id`),
	CONSTRAINT `fk_ae_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_ae_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_ae_tenant_correction_of` FOREIGN KEY (`tenantId`,`correctionOfEventId`) REFERENCES `attendance_events`(`tenantId`,`id`),
	CONSTRAINT `fk_ae_tenant_request` FOREIGN KEY (`tenantId`,`correctionRequestId`) REFERENCES `attendance_correction_requests`(`tenantId`,`id`),
	CONSTRAINT `chk_ae_self` CHECK (`actorType` <> 'self' OR `actorEmployeeId` = `employeeId`),
	CONSTRAINT `chk_ae_admin` CHECK (`actorType` <> 'admin' OR (`actorEmployeeId` IS NOT NULL AND CHAR_LENGTH(TRIM(COALESCE(`reason`, ''))) >= 3)),
	CONSTRAINT `chk_ae_system` CHECK (`actorType` <> 'system' OR `actorEmployeeId` IS NULL),
	CONSTRAINT `chk_ae_correction` CHECK (`eventType` <> 'correction' OR `correctionOfEventId` IS NOT NULL OR `correctionRequestId` IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ROLLBACK قبل أي استخدام (معلّق — عبر السكربت بعد التحقق أن الجداول فارغة)، بالترتيب العكسي:
-- DROP TABLE `attendance_events`; DROP TABLE `attendance_correction_requests`;
-- DROP TABLE `attendance_days`; DROP TABLE `attendance_assignments`; DROP TABLE `attendance_shifts`;
```

### سياسات الحضور
- **الهوية**: `employeeId` و`tenantId` من الجلسة فقط (`employeePortalProcedure` + `requireTenantId`)؛ أي employeeId يرسله العميل يُرفض (مدخلات strict). الوقت من السيرفر (`occurredAt`) لا من الجهاز.
- **سياسة الوقت**: كل الطوابع `timestamp(3)` (UTC داخليًا). `workDate` = تاريخ **بداية الوردية** بتوقيت الوردية/النشاط (`Africa/Cairo` افتراضيًا) يُحسب على السيرفر بقاعدة بيانات المناطق الزمنية (تراعي التوقيت الصيفي المصري).
- **الوردية الليلية**: `crossesMidnight=1` ⇒ الانصراف بعد منتصف الليل يُلحق بيوم `workDate` السابق المفتوح؛ حضور جديد قبل إغلاق يوم مفتوح يُرفض أو يحتاج «إغلاق اليوم».
- **Snapshot الوردية**: `shiftSnapshotJson` يُكتب عند فتح اليوم (الأوقات، السماح، الاستراحة، الإضافي، المنطقة). تعديل الوردية لاحقًا لا يعيد حساب الماضي (CHECK يمنع يومًا بوردية بلا لقطة).
- **Idempotency**: الواجهة تولّد مفتاحًا لكل نقرة؛ نفس المفتاح + نفس الـhash = نفس النتيجة؛ hash مختلف = CONFLICT.
- **Concurrency**: داخل transaction واحدة: قفل صف الموظف (`SELECT … FROM employees WHERE id=? FOR UPDATE`) ثم إنشاء/قراءة يوم العمل (`UNIQUE(tenantId,employeeId,workDate)` يمنع يومين) و`FOR UPDATE` عليه، تحقق التسلسل (لا انصراف بلا حضور، لا استراحتين مفتوحتين — CHECK `chk_ad_break`)، إدراج الحدث، إعادة حساب المجاميع من الأحداث، `version = version + 1`. تعديلات المدير على الورديات والطلبات بقفل تفاؤلي `WHERE version = ?`.
- **Audit والتصحيح**: لا UPDATE صامت لوقت حضور؛ التصحيح حدث `correction` بقيم قبل/بعد وسبب (CHECK للمدير)، والمراجع لا يعتمد طلبه بنفسه (CHECK `chk_acr_no_self`)، والرفض يتطلب سببًا.
- **عدم الحذف**: لا DELETE في أي مسار؛ الموظف المعطّل يبقى تاريخه (`employeePortalProcedure` يرفض دخوله أصلًا).
- **Go-Live**: أول يوم عمل بعد التفعيل. **لا Backfill** — لا مصدر مؤكد (Login/Logout لا يعني حضورًا).
- **Rollback**: قبل الاستخدام DROP بالترتيب العكسي بعد التحقق من الفراغ؛ بعده إخفاء الواجهة وسحب `attendance.clock_self` فقط، والتاريخ يبقى.

---

## 6) ج) الصلاحيات المقترحة (لم تُنفّذ)

**مكان الإضافة:** `server/permissions.ts` (`ALL_PERMISSIONS` + `ROLE_PERMISSIONS` الافتراضية) و`shared/permissionLabels.ts` (التسميات العربية). بلا Migration (`tenant_role_permissions.permission` varchar(100)). الحارس: `permissionProcedure` للويب و`requireEmployeeTenantPermission` للبوابة (كلاهما يحترم تخصيص الشركة).

| الصلاحية | super_admin | admin | manager | moderator | order_confirmation / agent | warehouse / shipping / scanner / data_entry / facebook_entry | accountant | viewer |
|---|---|---|---|---|---|---|---|---|
| employee_performance.view_self | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| employee_performance.view_team | مؤجّل (لا نموذج فريق) | | | | | | | |
| employee_performance.view_all | ✓ | ✓ | منح | — | — | — | — | — |
| employee_performance.export | ✓ | منح | — | — | — | — | — | — |
| attendance.clock_self | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| attendance.view_self | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| attendance.request_correction | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| attendance.view_team | مؤجّل | | | | | | | |
| attendance.view_all | ✓ | ✓ | ✓ | — | — | — | منح | — |
| attendance.manage_shifts | ✓ | ✓ | منح | — | — | — | — | — |
| attendance.correct | ✓ | ✓ | منح | — | — | — | — | — |
| attendance.approve_corrections | ✓ | ✓ | منح | — | — | — | — | — |
| attendance.manage_leaves | ✓ | ✓ | منح | — | — | — | — | — |
| attendance.export | ✓ | منح | — | — | — | — | منح | — |

«منح» = غير مفعّلة افتراضيًا وتُمنح من شاشة الصلاحيات لكل شركة. المدير لا يأخذ أي صلاحية مالية (قاعدة `permissionProcedure` الحالية)؛ هذه الصلاحيات ليست مالية.

**اختبارات المصفوفة (مخططة):** لكل دور × صلاحية: الافتراضي، المنح، السحب، عزل الشركة (منح في A لا يؤثر على B)، المالك وحده يرى `export` إن لم يُمنح، الواجهة تُخفي من نفس المصدر، والسيرفر يرفض عند السحب في الطلب التالي (نفس نمط shippingPortalPermission.security.test.ts).

---

## 7) تعريف المقاييس (C2)

| المقياس | التعريف |
|---|---|
| uniqueHandledOrders | `COUNT(DISTINCT orderId)` لأحداث الموظف من: confirm, no_answer, postpone, cancel, edit, edit_items, status_change |
| confirmedOrders | `COUNT(DISTINCT orderId)` حيث eventType = confirm |
| noAnswerOrders / noAnswerAttempts | `COUNT(DISTINCT orderId)` / `COUNT(*)` لـ no_answer |
| eligibleOrders (المقام) | يُحدد بقرارك (§12-2) |
| confirmationRate | confirmedOrders ÷ eligibleOrders (≤ 100% لأن البسط جزء من المقام) |
| needsFollowUp | أوردرات آخر حدث للموظف فيها no_answer/postpone بلا confirm/cancel لاحق من أي أحد |
| firstResponseMinutes | من `assign` إلى أول حدث قرار للموظف — للأوردرات المُسندة بعد Go-Live فقط |
| activeDays | أيام مختلفة (بتوقيت القاهرة) فيها حدث للموظف |

كل حدث لصاحبه؛ إعادة الإسناد لا تنقل التاريخ؛ كل نسبة تُعرض بجانب عددها؛ لا ترتيب تحت حد العينة.

---

## 8) قرارات تقنية تحتاج اعتمادك مع الـDDL

أ) **الفهرسان المركّبان** (`businesses_tenant_id`, `employees_tenant_id`) — مطلوبان لكل FK مركّب، ويُنشئهما 0040 غير المطبّق:
   1. **(مُوصى به)** 0041 يُنشئهما إن لم يكونا موجودين (preflight يقرر)، ويُعدَّل preflight الخاص بـ0040 لاحقًا ليقبل وجودهما ويتخطى عبارتيه — تعديل كود سكربت لا يغيّر 0040 نفسه.
   2. تطبيق 0040 أولًا (جداوله تبقى فارغة وV3 غير مفعّل) — يتعارض مع قاعدة «لا تشغيل 0040».
   3. FK بسيط بلا tenant + تحقق بالخدمة — أضعف، غير مُوصى به.
ب) **orderId بلا FK** على orders (للحفاظ على حذف المكررات) — مُوصى به.
ج) **Triggers لمنع UPDATE/DELETE** على جداول الأحداث — غير مُوصى بها افتراضيًا (صلاحيات MySQL المُدار)؛ المنع بالكود والاختبارات.
د) **إصدار MySQL في Production ≥ 8.0.16** لتفعيل CHECK — يُتحقق في preflight؛ وإلا تُنقل القيود للخدمة.

---

## 9) الفترة التجريبية — تصميم كامل (لا تنفيذ قبل قرارك)

**الحقائق:** `tenants.status` = trialing/active/past_due/canceled/suspended/expired؛ `approveSignupRequest` يضبط trialing + 14 يومًا؛ **لا قراءة لـ`trialEndsAt` في أي مكان**؛ لا انتقال تلقائي إلى expired؛ جدول `subscriptions` غير مقروء.

**نقطة Enforcement مركزية:** دالة واحدة `resolveTenantAccess(tenantId, now)` → `full | read_only | blocked` بكاش قصير (60 ثانية) ومفعّلة في:
1. `createContext` (server/_core/context.ts) — يُرفق `ctx.tenantAccess` لكل جلسة ويب/بوابة.
2. middleware موحّد على `protectedProcedure` و`authenticatedProcedure` و`permissionProcedure` و`employeePortalProcedure` و`managerPortalProcedure`: أي **mutation** مع `read_only` ⇒ `FORBIDDEN` برمز `TENANT_TRIAL_EXPIRED`؛ `blocked` ⇒ كل شيء عدا الخروج والاشتراك.
3. مسارات Express خارج tRPC (تتجاوز الـmiddleware حاليًا): `/api/import/{preview,execute}`, `/api/import/whatsapp/*`, `/api/branding/upload`, `/api/carrier/package-image/upload`, `/api/evidence/upload` ⇒ كتابة = تُمنع؛ `/api/export/*` و`/api/orders/*/bosta-awb` ⇒ قراءة = مسموحة في `read_only`.
4. Webhooks: `/api/webhooks/bosta` و`/api/webhooks/easyorder` تُستقبل وتُخزَّن في صناديقها الحالية **بلا معالجة** لشركة غير `full` (لا فقد بيانات) — قرار §12-10.
5. المجدول الخلفي (Maintenance/Bosta sync) يتخطى الشركات غير `full`.
6. مسارا الدخول (`/api/auth/login`, `/api/employee/login`) يسمحان بالدخول ويُرجعان حالة الوصول للواجهة.

| الحالة | الوصول المقترح |
|---|---|
| trialing قبل `trialEndsAt` | full |
| trialing بعد `trialEndsAt` | read_only + شاشة «انتهت الفترة التجريبية» |
| active | full |
| past_due | full لمدة سماح (اقتراح 7 أيام) ثم read_only — قرار |
| canceled | blocked (دخول + تصدير + اشتراك فقط) |
| suspended | blocked |
| expired | read_only |

**ما يبقى متاحًا بعد الانتهاء (read_only):** تسجيل الدخول؛ قراءة البيانات؛ التصدير؛ إعدادات الاشتراك؛ تسجيل الخروج. **Platform Admin مستثنى تمامًا** (مصادقة منفصلة لا تمر بأي من هذا).
**الشاشة** (لا تُبنى قبل الحارس): صفحة بـ`<main>` واحد: «انتهت الفترة التجريبية»، تاريخ الانتهاء بتوقيت القاهرة، «بياناتك محفوظة ولم تُحذف»، «تواصل مع إدارة المنصة»، «تسجيل الخروج»؛ suspended/canceled برسائل مستقلة؛ الموظف غير المالك يرى رسالة بلا تفاصيل اشتراك.
**الاختبارات:** كل حالة × كل نوع إجراء (query/mutation/Express/webhook/بوابة/مجدول)، والحد بالضبط عند `trialEndsAt`، وPlatform Admin غير متأثر، وعزل الشركات.

---

## 10) توحيد صلاحيات `/manager-dashboard` — جدول قرار (لا تنفيذ)

الوضع: `managerPortalProcedure` يقبل super_admin/admin/manager (فحص دور)، بينما `productsList/lowStockProducts/inventoryMovements/addInventoryMovement` تشترط حرفيًا manager/warehouse. الواجهة تعرض التبويبات لدور manager فقط (لا تبويب يرفضه السيرفر).

| التبويب | البيانات | الصلاحية الأنسب الموجودة | من يملكها افتراضيًا | يلزم جديد؟ |
|---|---|---|---|---|
| لوحة التحكم | عدادات الأوردرات، الرسم اليومي | `dashboard.view` | super_admin, admin, manager, moderator, agent, order_confirmation, warehouse, accountant, viewer | لا — لكنها واسعة؛ مُوصى: `orders.view` + نطاق |
| لوحة التحكم | الرسالة الجماعية (إرسال/إلغاء) | `employees.manage` | super_admin, admin, manager | لا |
| الأوردرات | القائمة | `orders.view` | الكل تقريبًا | لا |
| الأوردرات | إسناد/إسناد جماعي | `orders.update` | super_admin, admin, manager, moderator, agent, order_confirmation | لا — لكن الإسناد للآخرين أقوى من التعديل ⇒ مُوصى `employees.manage` |
| الأوردرات | تأكيد/إلغاء/تأجيل | `orders.confirm` / `orders.cancel` / `orders.update` | كما في الخريطة | لا |
| المخزون | المنتجات، المنخفض، الحركات، إضافة حركة | **لا يوجد** (`inventory_costing.*` للتكلفة) | — | **نعم**: `inventory.view` و`inventory.adjust` (افتراضيًا: super_admin, admin, manager, warehouse) |
| التقارير | الملخص التقديري، أسباب الإلغاء | `orders.view` (الإلغاءات) + `employee_performance.view_all` (C) | — | نعم ضمن C |
| الموظفين | قائمة / إنشاء / تعديل / بيانات دخول | `employees.view` / `employees.manage` | view: +moderator؛ manage: super_admin, admin, manager | لا |
| توزيع المهام | قائمة / إنشاء / حالة / حذف | `employees.view` / `employees.manage` | كما سبق | لا |

**التوصية:** تحويل الفحص من «الدور» إلى الصلاحيات الموجودة أعلاه (tenant-aware) لكل Endpoint، مع إبقاء النطاق كما هو. الأثر: admin/super_admin يحتفظان بكل شيء؛ manager كما هو؛ **moderator سيكتسب** الأوردرات والموظفين (عرض) في البوابة — توسيع يحتاج موافقتك أو منعًا صريحًا له؛ warehouse لا يرى إلا المخزون (بعد `inventory.*`). الواجهة تعرض كل تبويب حسب نفس المصدر (`employeePortal.myPermissions`) والسيرفر يبقى الحارس، وحالات FORBIDDEN تعرض رسالة السيرفر.

---

## 11) قرارات Backend متبقية (بلا Migration) — تحتاج موافقتك

1. **مهام الموظف في البوابة**: `tasks.*` على `protectedProcedure` ⇒ لوحة مهام الموظف غير الإداري ترجع UNAUTHORIZED منذ قبل هذا العمل. الاقتراح: `tasks.listMine/updateMyStatus` على البوابة بنطاق الموظف (مهامه + العامة لنشاطه).
2. **بوابة الموظف وتخصيص الشركة**: `requireEmployeePermission` (routers.ts) يقرأ الخريطة الافتراضية فقط ويتجاهل `tenant_role_permissions` (ما عدا شاشتي الشحن بعد هذا العمل). الاقتراح: توحيد كل البوابة على `requireEmployeeTenantPermission` — يغيّر السلوك حيث توجد تخصيصات.
3. **تسجيل أحداث الويبهوك في 0041** (Bosta / Easy Orders): سطر تسجيل فقط بلا تغيير منطقهما — يحتاج إذنًا لأن القاعدة تمنع ربطهما بالميزات الجديدة.
4. **Backfill الأداء «المؤكد» فقط** بعد Go-Live.

---

## 12) قرارات تحتاج إجابة المالك (10)

1. **حد عينة ترتيب نسبة التأكيد** — اقتراح: 20 أوردرًا eligible في الفترة؛ تحته تُعرض النسبة بلا ترتيب.
2. **تعريف eligible orders** — اقتراح: الأوردرات المختلفة التي اتخذ فيها الموظف قرار تأكيد (confirm / no_answer / postpone / cancel) في الفترة، مع استبعاد المكررات المحذوفة والأوردرات المُلغاة من النظام/الويبهوك.
3. **من يرى مقارنة الموظفين** — اقتراح: المالك والأدمن ومن يُمنح `employee_performance.view_all`؛ الموظف يرى نفسه فقط؛ لا لوحة ترتيب عامة.
4. **مواعيد الورديات الفعلية** — لكل نشاط: البداية/النهاية وأيام العمل والوردية الليلية إن وُجدت.
5. **سماح التأخير** — اقتراح: 10 دقائق.
6. **مدة الاستراحة** — اقتراح: 60 دقيقة إجمالًا، والزيادة تُسجَّل «استراحة زائدة» بلا خصم.
7. **سياسة الخروج المبكر** — اقتراح: تُسجَّل الدقائق ويُطلب سبب، ومراجعة المدير، بلا خصم.
8. **سياسة الإضافي** — اقتراح: يُحتسب بعد 30 دقيقة من نهاية الوردية، ويحتاج اعتمادًا، بلا ربط بالرواتب.
9. **الإجازات** — اقتراح: إجازة/مأمورية بطلب واعتماد (`attendance.manage_leaves`)، بلا رصيد إجازات في هذه النسخة.
10. **وضع الشركة بعد انتهاء التجربة** — اقتراح: قراءة + تصدير + إعدادات الاشتراك، منع كل الكتابات التشغيلية، والويبهوك تُخزَّن بلا معالجة؛ past_due: سماح 7 أيام.

**لم يُكتب 0041 ولا 0042 ولا أي Migration صلاحيات ولا أي Backfill.** التنفيذ يبدأ فقط بعد اعتمادك لهذه الحزمة.
