# حزمة قرار — تقارير أداء الموظفين + الحضور والانصراف + قرارات Backend

**الحالة: معتمدة معماريًا (2026-10-09) مع التصحيحات الإلزامية أدناه.** التنفيذ خلف Feature Flags معطلة، والـMigrations على Docker محلي مؤقت فقط.

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

## 4) 0041 — DDL النهائي المعتمد (بعد التصحيحات الإلزامية)

الملف: `drizzle/0041_order_activity_events.sql` (تم التحقق من أنه يُنشأ بلا خطأ على MySQL 8.4 Docker محلي مؤقت).

```sql
-- 0041 — Order activity events (Event Ledger لأداء الموظفين). DELTA مكتوبة بخط اليد، ADDITIVE بحت:
--   • فهرسان فريدان مركّبان على جدولين قديمين (businesses/employees) — **فقط إذا لم يكونا موجودين**
--     (سكربت scripts/migrate-0041-order-events يقرر: كلاهما غائب → يُنشآن؛ كلاهما موجود بنفس الأعمدة
--     والترتيب → skip/replay؛ واحد فقط أو تعريف مختلف → partial ورفض بلا أي DDL).
--   • جدول جديد واحد order_activity_events. لا تعديل لأي عمود أو صف قائم. غير مضاف إلى drizzle journal.
--
-- عزل الـtenant بالـFK المركّب: النشاط (tenantId,businessId) وكل موظف (منفّذ/منسوب/مُسنَد) (tenantId,employeeId).
-- orderId **بلا FK** عمدًا (حذف المكررات النهائي قائم) — الخدمة تقفل الأوردر FOR UPDATE وتستخرج businessId منه
--   وtenantId من النشاط، ولا تقبلهما من العميل، وتحفظ orderNumberSnapshot ليبقى الحدث مقروءًا بعد الحذف.
-- eventType/source = VARCHAR بقائمة مسموحة مركزية في الخدمة (shared/orderEventsSpec.ts) — لا قيمة حرة من العميل.
-- actorEmployeeId = من نفّذ؛ attributedEmployeeId = من يُحتسب الحدث في أدائه (التقارير تعتمده).
-- الأحداث للإضافة فقط: لا UPDATE ولا DELETE في أي مسار كود. الوقت timestamp(3) (UTC داخليًا).
-- CHECK: كل تعبير مكتوب بحيث لا ينتج UNKNOWN (MySQL يمرّر UNKNOWN) — شروط IS [NOT] NULL صريحة و<=>.
-- يتطلب MySQL ≥ 8.0.16 لفرض CHECK (يفحصه الـpreflight).
-- لا يُشغَّل إلا عبر السكربت، وفي هذه المرحلة على قواعد Docker محلية مؤقتة فقط.

ALTER TABLE `businesses` ADD UNIQUE INDEX `businesses_tenant_id` (`tenantId`,`id`);
--> statement-breakpoint
ALTER TABLE `employees` ADD UNIQUE INDEX `employees_tenant_id` (`tenantId`,`id`);
--> statement-breakpoint
CREATE TABLE `order_activity_events` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NOT NULL,
	`orderId` int NOT NULL,
	`orderNumberSnapshot` varchar(100) NOT NULL,
	`eventType` varchar(50) NOT NULL,
	`fromStatus` varchar(30) NULL,
	`toStatus` varchar(30) NULL,
	`actorType` enum('employee','system','webhook','backfill') NOT NULL,
	`actorEmployeeId` int NULL,
	`attributedEmployeeId` int NULL,
	`actorRoleSnapshot` varchar(50) NULL,
	`actorNameSnapshot` varchar(100) NULL,
	`assigneeEmployeeIdAtEvent` int NULL,
	`previousAssigneeEmployeeId` int NULL,
	`reason` varchar(160) NULL,
	`callAttempt` smallint unsigned NULL,
	`source` varchar(30) NOT NULL,
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
	INDEX `oae_tenant_attributed_occurred` (`tenantId`,`attributedEmployeeId`,`occurredAt`),
	INDEX `oae_tenant_actor_occurred` (`tenantId`,`actorEmployeeId`,`occurredAt`),
	INDEX `oae_tenant_assignee_occurred` (`tenantId`,`assigneeEmployeeIdAtEvent`,`occurredAt`),
	INDEX `oae_tenant_business_occurred` (`tenantId`,`businessId`,`occurredAt`),
	INDEX `oae_tenant_type_occurred` (`tenantId`,`eventType`,`occurredAt`),
	INDEX `oae_order_occurred` (`orderId`,`occurredAt`),
	CONSTRAINT `fk_oae_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_oae_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_oae_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_oae_tenant_attributed` FOREIGN KEY (`tenantId`,`attributedEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_oae_tenant_assignee` FOREIGN KEY (`tenantId`,`assigneeEmployeeIdAtEvent`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_oae_tenant_prev_assignee` FOREIGN KEY (`tenantId`,`previousAssigneeEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_oae_actor` CHECK (
		(`actorType` = 'employee' AND `actorEmployeeId` IS NOT NULL AND `attributedEmployeeId` IS NOT NULL AND `attributedEmployeeId` = `actorEmployeeId`)
		OR (`actorType` IN ('system','webhook') AND `actorEmployeeId` IS NULL)
		OR (`actorType` = 'backfill' AND `actorEmployeeId` IS NULL)),
	CONSTRAINT `chk_oae_backfill` CHECK (
		((`actorType` = 'backfill') = (`source` = 'backfill'))
		AND ((`source` = 'backfill') = (`backfillConfidence` IS NOT NULL))),
	CONSTRAINT `chk_oae_call` CHECK (`callAttempt` IS NULL OR `eventType` = 'no_answer'),
	CONSTRAINT `chk_oae_event_type` CHECK (`eventType` REGEXP '^[a-z][a-z_]{1,49}$'),
	CONSTRAINT `chk_oae_source` CHECK (`source` REGEXP '^[a-z][a-z_]{1,29}$'),
	CONSTRAINT `chk_oae_hash` CHECK (`payloadHash` REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ROLLBACK قبل أي استخدام — فقط عبر: scripts/migrate-0041-order-events --rollback (يتحقق أن الجدول فارغ):
--   DROP TABLE `order_activity_events`;
--   الفهرسان المركّبان **لا يُحذفان** إذا كانت أي جداول أخرى تعتمد عليهما (FK إليهما من ledger_* أو attendance_*)
--   أو إذا لم يكن 0041 منشئهما (كانا موجودين قبله) — السكربت يقرر من information_schema ويُبقيهما عند الشك.
```

### التصحيحات المطبّقة على 0041
| # | التصحيح | التطبيق |
|---|---|---|
| 1 | فصل المنفّذ عن المنسوب إليه الأداء | `attributedEmployeeId` + FK مركّب؛ `chk_oae_actor`: employee ⇒ actor = attributed؛ system/webhook ⇒ actor NULL (attributed فقط بدليل)؛ backfill ⇒ actor NULL. التقارير تعتمد `attributedEmployeeId`. |
| 2 | eventType مفتوح للتوسع | `varchar(50)` + `chk_oae_event_type` (صيغة فقط) + Allowlist مركزية في `shared/orderEventsSpec.ts` (refund/complaint/reassign/delivery_attempt/collection_update محجوزة)؛ لا قيمة من العميل. `source` بنفس النمط. |
| 3 | orderNumberSnapshot | `varchar(100)` ≥ `orders.orderNumber` (varchar(20) حاليًا) ويغطي أرقام Easy Orders واليدوي؛ اختبار بأطول رقم مسموح. |
| 4 | Idempotency في الواجهة | `operationId` يُنشأ مرة لكل عملية (فتح الحوار/بدء دورة الإرسال) ويثبت في Retry وDouble-click؛ الزر معطل أثناء isPending؛ السيرفر: قفل الأوردر ثم `UPDATE … WHERE status = expectedFrom`؛ affectedRows=0 ⇒ قراءة الحالة وتحديد Replay/Conflict؛ لا حدث بلا تغيير ولا تغيير بلا حدث والعلم مفعّل. |
| 5 | eligibleOrders | «نسبة التأكيد من القرارات المسجلة» = أوردرات أكّدها الموظف ÷ أوردرات سجّل عليها confirm/no_answer/postpone/cancel؛ حجم العمل والإسنادات مقاييس منفصلة. |
| 6 | Backfill | confirmed فقط من `confirmedByEmployeeId+confirmedAt` و`order_edit_logs` المؤكدة؛ partial خارج الترتيب الافتراضي؛ unknown بلا حدث؛ لا تنفيذ — سكربت Preview قراءة فقط لاحقًا. |
| 7 | orderId بلا FK | معتمد؛ الخدمة تقفل الأوردر FOR UPDATE وتستخرج businessId/tenantId وتحفظ الرقم؛ اختبار قراءة الحدث بعد حذف أوردر مكرر. |
| 8 | الفهرسان المركّبان | السكربت يميّز: كلاهما غائب ⇒ يُنشآن؛ كلاهما موجود بنفس الأعمدة والترتيب ⇒ skip؛ واحد فقط/تعريف مختلف ⇒ partial ورفض. سكربت 0040 يُحدَّث ليقبل وجودهما الصحيح ويتخطى عبارتيهما فقط (بلا تطبيق 0040). Rollback 0041 لا يحذفهما إن اعتمدت عليهما جداول أخرى أو لم يكن 0041 منشئهما. |

### الخدمة والمسارات (0041)
- العلم: `ORDER_EVENTS_ENABLED` (افتراضيًا معطل). معطل ⇒ **لا أي وصول للجدول** والسلوك الحالي حرفيًا. مفعّل والجدول غائب ⇒ `PRECONDITION_FAILED` بلا سقوط صامت.
- المسارات المربوطة: الإدارة (confirm/postpone/cancel/markNoAnswer/assign/bulkAssign/تغيير الحالة) والبوابة (confirm/postpone/cancel/markNoAnswer/updateStatus/assignOrder/bulkAssignOrders) + ويبهوك Easy Orders (تأكيد) وBosta (تحديث الشحن) كسطر Audit فقط (actorType=webhook، attributed=NULL، مفتاح من معرّف حدث المزود ⇒ Retry لا يكرر).
- Rollback: قبل أي حدث `--rollback` (جدول فارغ)؛ بعد وجود أحداث: إطفاء العلم فقط.

---

## 5) 0042 — DDL النهائي المعتمد (بعد التصحيحات الإلزامية)

الملف: `drizzle/0042_attendance.sql` (تم التحقق من أنه يُنشأ بلا خطأ على MySQL 8.4 Docker محلي مؤقت).

```sql
-- 0042 — الحضور والانصراف. DELTA مكتوبة بخط اليد، ADDITIVE بحت: 5 جداول جديدة + FK لاحق واحد (كسر الدورة).
-- يعتمد على الفهرسين المركّبين businesses_tenant_id/employees_tenant_id (ينشئهما 0040 أو 0041) — الـpreflight يرفض بدونهما.
-- لا ربط بالرواتب ولا Ledger. لا GPS ولا بيانات حيوية. لا حذف في أي مسار كود. غير مضاف إلى drizzle journal.
--
-- عزل الموظف داخل الـtenant بالـFK الثلاثي: الحدث وطلب التصحيح لا يُربطان بيوم/طلب/حدث موظف آخر:
--   (tenantId, employeeId, attendanceDayId)     → attendance_days(tenantId, employeeId, id)
--   (tenantId, employeeId, correctionRequestId) → attendance_correction_requests(tenantId, employeeId, id)
--   (tenantId, employeeId, correctionOfEventId) → attendance_events(tenantId, employeeId, id)
--   (tenantId, employeeId, targetEventId)       → attendance_events(tenantId, employeeId, id)  ← ALTER بعد إنشاء الجدولين
-- الوقت: كل الطوابع timestamp(3) (UTC داخليًا)؛ الخدمة تكتب/تقرأ بالـepoch وتضبط time_zone='+00:00' لكل معاملة؛
--   workDate = تاريخ بداية الوردية بتوقيت الوردية (IANA، افتراضيًا Africa/Cairo) يُحسب على السيرفر.
-- workDaysMask (ثابت في shared/attendanceSpec.ts): bit0=السبت، bit1=الأحد، bit2=الاثنين، bit3=الثلاثاء،
--   bit4=الأربعاء، bit5=الخميس، bit6=الجمعة — بلا Default: العميل يرسل الأيام صراحةً ويوم واحد على الأقل.
-- CHECK: كل تعبير بلا UNKNOWN (شروط IS [NOT] NULL صريحة). يتطلب MySQL ≥ 8.0.16.
-- لا يُشغَّل إلا عبر scripts/migrate-0042-attendance، وفي هذه المرحلة على قواعد Docker محلية مؤقتة فقط.

CREATE TABLE `attendance_shifts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`businessId` int NULL,
	`name` varchar(80) NOT NULL,
	`startTime` time NOT NULL,
	`endTime` time NOT NULL,
	`crossesMidnight` tinyint(1) NOT NULL,
	`workDaysMask` tinyint unsigned NOT NULL,
	`graceMinutes` smallint unsigned NOT NULL,
	`allowedBreakMinutes` smallint unsigned NOT NULL,
	`overtimeStartsAfterMinutes` smallint unsigned NOT NULL,
	`earlyClockInLimitMinutes` smallint unsigned NOT NULL,
	`earlyLeaveToleranceMinutes` smallint unsigned NOT NULL DEFAULT 0,
	`timezone` varchar(64) NOT NULL,
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
	CONSTRAINT `chk_ash_times` CHECK (`endTime` <> `startTime` AND `crossesMidnight` = (`endTime` < `startTime`)),
	CONSTRAINT `chk_ash_days` CHECK (`workDaysMask` BETWEEN 1 AND 127),
	CONSTRAINT `chk_ash_limits` CHECK (`graceMinutes` <= 240 AND `allowedBreakMinutes` <= 480 AND `earlyClockInLimitMinutes` <= 480 AND `overtimeStartsAfterMinutes` <= 720 AND `earlyLeaveToleranceMinutes` <= 240),
	CONSTRAINT `chk_ash_range` CHECK (`effectiveTo` IS NULL OR `effectiveTo` >= `effectiveFrom`),
	CONSTRAINT `chk_ash_name` CHECK (CHAR_LENGTH(TRIM(`name`)) >= 1)
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
	INDEX `aas_tenant_target_from` (`tenantId`,`targetType`,`role`,`businessId`,`effectiveFrom`),
	CONSTRAINT `fk_aas_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_aas_tenant_shift` FOREIGN KEY (`tenantId`,`shiftId`) REFERENCES `attendance_shifts`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_assigner` FOREIGN KEY (`tenantId`,`assignedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_aas_tenant_ender` FOREIGN KEY (`tenantId`,`endedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_aas_target` CHECK (
		(`targetType` = 'employee' AND `employeeId` IS NOT NULL AND `role` IS NULL AND `businessId` IS NULL)
		OR (`targetType` = 'role' AND `employeeId` IS NULL AND `role` IS NOT NULL)
		OR (`targetType` = 'business' AND `employeeId` IS NULL AND `role` IS NULL AND `businessId` IS NOT NULL)
		OR (`targetType` = 'tenant_default' AND `employeeId` IS NULL AND `role` IS NULL AND `businessId` IS NULL)),
	CONSTRAINT `chk_aas_range` CHECK (`effectiveTo` IS NULL OR `effectiveTo` >= `effectiveFrom`),
	CONSTRAINT `chk_aas_end` CHECK ((`endedAt` IS NULL AND `endedByEmployeeId` IS NULL) OR (`endedAt` IS NOT NULL AND `endedByEmployeeId` IS NOT NULL))
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
	CONSTRAINT `ad_tenant_employee_id_unique` UNIQUE(`tenantId`,`employeeId`,`id`),
	INDEX `ad_tenant_date_status` (`tenantId`,`workDate`,`status`),
	INDEX `ad_tenant_business_date` (`tenantId`,`businessId`,`workDate`),
	CONSTRAINT `fk_ad_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_ad_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_ad_tenant_business` FOREIGN KEY (`tenantId`,`businessId`) REFERENCES `businesses`(`tenantId`,`id`),
	CONSTRAINT `fk_ad_tenant_shift` FOREIGN KEY (`tenantId`,`shiftId`) REFERENCES `attendance_shifts`(`tenantId`,`id`),
	CONSTRAINT `fk_ad_tenant_approver` FOREIGN KEY (`tenantId`,`approvedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_ad_times` CHECK (`lastOutAt` IS NULL OR `firstInAt` IS NULL OR `lastOutAt` >= `firstInAt`),
	CONSTRAINT `chk_ad_break` CHECK ((`status` = 'on_break' AND `openBreakStartedAt` IS NOT NULL) OR (`status` <> 'on_break' AND `openBreakStartedAt` IS NULL)),
	CONSTRAINT `chk_ad_approval` CHECK ((`approvedAt` IS NULL AND `approvedByEmployeeId` IS NULL) OR (`approvedAt` IS NOT NULL AND `approvedByEmployeeId` IS NOT NULL)),
	CONSTRAINT `chk_ad_snapshot` CHECK (`shiftId` IS NULL OR `shiftSnapshotJson` IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
CREATE TABLE `attendance_correction_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenantId` int NOT NULL,
	`employeeId` int NOT NULL,
	`attendanceDayId` int NULL,
	`workDate` date NOT NULL,
	`requestType` enum('missing_clock_in','missing_clock_out','wrong_time','break_fix','absence_to_leave','absence_to_mission','early_leave_reason','other') NOT NULL,
	`targetEventId` bigint NULL,
	`requestedAt` timestamp(3) NULL,
	`requestedValueJson` json NULL,
	`reason` varchar(500) NOT NULL,
	`note` varchar(500) NULL,
	`status` enum('pending','approved','rejected','canceled') NOT NULL DEFAULT 'pending',
	`reviewedByEmployeeId` int NULL,
	`reviewedAt` timestamp(3) NULL,
	`reviewReason` varchar(500) NULL,
	`idempotencyKey` varchar(191) NOT NULL,
	`payloadHash` char(64) NOT NULL,
	`version` int unsigned NOT NULL DEFAULT 1,
	`createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `attendance_correction_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `acr_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`),
	CONSTRAINT `acr_tenant_id_unique` UNIQUE(`tenantId`,`id`),
	CONSTRAINT `acr_tenant_employee_id_unique` UNIQUE(`tenantId`,`employeeId`,`id`),
	INDEX `acr_tenant_status_created` (`tenantId`,`status`,`createdAt`),
	INDEX `acr_tenant_employee_date` (`tenantId`,`employeeId`,`workDate`),
	CONSTRAINT `fk_acr_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_acr_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_acr_tenant_employee_day` FOREIGN KEY (`tenantId`,`employeeId`,`attendanceDayId`) REFERENCES `attendance_days`(`tenantId`,`employeeId`,`id`),
	CONSTRAINT `fk_acr_tenant_reviewer` FOREIGN KEY (`tenantId`,`reviewedByEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `chk_acr_reason` CHECK (CHAR_LENGTH(TRIM(`reason`)) >= 3),
	CONSTRAINT `chk_acr_review` CHECK (
		(`status` IN ('pending','canceled') AND `reviewedByEmployeeId` IS NULL AND `reviewedAt` IS NULL)
		OR (`status` IN ('approved','rejected') AND `reviewedByEmployeeId` IS NOT NULL AND `reviewedAt` IS NOT NULL)),
	CONSTRAINT `chk_acr_reject` CHECK (`status` <> 'rejected' OR CHAR_LENGTH(TRIM(COALESCE(`reviewReason`, ''))) >= 3),
	CONSTRAINT `chk_acr_no_self` CHECK (`reviewedByEmployeeId` IS NULL OR `reviewedByEmployeeId` <> `employeeId`),
	CONSTRAINT `chk_acr_hash` CHECK (`payloadHash` REGEXP '^[0-9a-f]{64}$')
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
	CONSTRAINT `ae_tenant_employee_id_unique` UNIQUE(`tenantId`,`employeeId`,`id`),
	INDEX `ae_tenant_employee_occurred` (`tenantId`,`employeeId`,`occurredAt`),
	INDEX `ae_day_occurred` (`attendanceDayId`,`occurredAt`),
	CONSTRAINT `fk_ae_tenant` FOREIGN KEY (`tenantId`) REFERENCES `tenants`(`id`),
	CONSTRAINT `fk_ae_tenant_employee` FOREIGN KEY (`tenantId`,`employeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_ae_tenant_employee_day` FOREIGN KEY (`tenantId`,`employeeId`,`attendanceDayId`) REFERENCES `attendance_days`(`tenantId`,`employeeId`,`id`),
	CONSTRAINT `fk_ae_tenant_actor` FOREIGN KEY (`tenantId`,`actorEmployeeId`) REFERENCES `employees`(`tenantId`,`id`),
	CONSTRAINT `fk_ae_tenant_employee_correction_of` FOREIGN KEY (`tenantId`,`employeeId`,`correctionOfEventId`) REFERENCES `attendance_events`(`tenantId`,`employeeId`,`id`),
	CONSTRAINT `fk_ae_tenant_employee_request` FOREIGN KEY (`tenantId`,`employeeId`,`correctionRequestId`) REFERENCES `attendance_correction_requests`(`tenantId`,`employeeId`,`id`),
	CONSTRAINT `chk_ae_actor` CHECK (
		(`actorType` = 'self' AND `actorEmployeeId` IS NOT NULL AND `actorEmployeeId` = `employeeId`)
		OR (`actorType` = 'admin' AND `actorEmployeeId` IS NOT NULL AND CHAR_LENGTH(TRIM(COALESCE(`reason`, ''))) >= 3)
		OR (`actorType` = 'system' AND `actorEmployeeId` IS NULL)),
	CONSTRAINT `chk_ae_correction` CHECK (`eventType` <> 'correction' OR `correctionOfEventId` IS NOT NULL OR `correctionRequestId` IS NOT NULL),
	CONSTRAINT `chk_ae_hash` CHECK (`payloadHash` REGEXP '^[0-9a-f]{64}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
--> statement-breakpoint
ALTER TABLE `attendance_correction_requests` ADD CONSTRAINT `fk_acr_tenant_employee_target_event` FOREIGN KEY (`tenantId`,`employeeId`,`targetEventId`) REFERENCES `attendance_events`(`tenantId`,`employeeId`,`id`);

-- ROLLBACK قبل أي استخدام — فقط عبر: scripts/migrate-0042-attendance --rollback (يتحقق أن الجداول الخمسة فارغة):
--   ALTER TABLE `attendance_correction_requests` DROP FOREIGN KEY `fk_acr_tenant_employee_target_event`;
--   DROP TABLE `attendance_events`; DROP TABLE `attendance_correction_requests`;
--   DROP TABLE `attendance_days`; DROP TABLE `attendance_assignments`; DROP TABLE `attendance_shifts`;
```

### التصحيحات المطبّقة على 0042
| # | التصحيح | التطبيق |
|---|---|---|
| 1 | الحدث لا يُربط بيوم موظف آخر | `ad_tenant_employee_id_unique(tenantId,employeeId,id)` + FK ثلاثي من events وrequests. |
| 2 | الحدث لا يُربط بطلب موظف آخر | `acr_tenant_employee_id_unique` + FK ثلاثي من events. |
| 3 | CHECK الفاعل بلا UNKNOWN | `chk_ae_actor` تعبير واحد صريح (self/admin/system) — اختبار DB لكل تركيبة خاطئة. |
| 4 | طلبات التصحيح | `targetEventId bigint` + `requestedValueJson json` (Zod صارم حسب requestType)؛ الدورة events↔requests مكسورة بإنشاء الجدولين ثم `ALTER … ADD CONSTRAINT fk_acr_tenant_employee_target_event`. |
| 5 | مراجعة الطلب | `chk_acr_review` (pending/canceled ⇒ الاثنان NULL؛ approved/rejected ⇒ الاثنان NOT NULL) + `chk_acr_reject` + `chk_acr_no_self`. |
| 6 | الوردية | `chk_ash_times`: startTime ≠ endTime، وcrossesMidnight = (endTime < startTime). |
| 7 | workDaysMask | Mapping ثابت (bit0=السبت … bit6=الجمعة) في الكود وتعليق الـDDL؛ **بلا Default**؛ يوم واحد على الأقل. |
| 8 | دور داخل نشاط | `targetType='role'` يقبل businessId NULL أو قيمة. الأولوية: موظف ← دور+نشاط ← نشاط ← دور على الشركة ← افتراضي الشركة (مكتوبة ومختبرة). |
| 9 | منع التداخل | خدمة داخل Transaction تقفل صف الـtenant FOR UPDATE، تبحث عن تقاطع لنفس الهدف، ترفض برسالة واضحة، وإنهاء القديم + الجديد في نفس المعاملة؛ اختبار طلبين متزامنين. |
| 10 | الوقت | حسابات IANA على السيرفر (`Intl`، Africa/Cairo)، تخزين UTC، `SET time_zone='+00:00'` لكل معاملة حضور، قراءة/كتابة الطوابع بالـepoch؛ اختبارات منتصف الليل/الشهر/الوردية الليلية/التوقيت الصيفي. |
| 11 | المجاميع المخزنة | Projection من الأحداث: دالة إعادة حساب نقية + `reconcileAttendance` قراءة فقط + اختبار عبث بـworkedMinutes؛ التحديث داخل نفس المعاملة تحت FOR UPDATE. |
| 12 | Idempotency | operationId ثابت للعملية؛ نفس المفتاح+hash ⇒ Replay؛ hash مختلف ⇒ Conflict؛ طلبان متزامنان ⇒ حدث واحد. |

العلم: `ATTENDANCE_ENABLED` (افتراضيًا معطل): معطل ⇒ لا وصول للجداول ولا ظهور للواجهة؛ مفعّل والجداول غائبة ⇒ `PRECONDITION_FAILED`.

---

## 6) الصلاحيات المعتمدة (كود فقط — بلا Migration)

**المكان:** `server/permissions.ts` (`ALL_PERMISSIONS` + `ROLE_PERMISSIONS`) و`shared/permissionLabels.ts`. الحارس: `permissionProcedure` (ويب) و`requireEmployeeTenantPermission` (كل البوابة بعد التوحيد).

| الصلاحية | super_admin | admin | manager | warehouse | agent / order_confirmation / moderator / shipping / scanner / data_entry / facebook_entry | accountant | viewer |
|---|---|---|---|---|---|---|---|
| employee_performance.view_self | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| employee_performance.view_all | ✓ | ✓ | منح | — | — | — | — |
| employee_performance.export | ✓ | ✓ | منح | — | — | — | — |
| attendance.clock_self / view_self / request_correction | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| attendance.view_all | ✓ | ✓ | منح | — | — | منح | — |
| attendance.manage_shifts / correct / approve_corrections / manage_leaves | ✓ | ✓ | منح | — | — | — | — |
| attendance.export | ✓ | ✓ | منح | — | — | منح | — |
| inventory.view / inventory.adjust (جديدتان) | ✓ | ✓ | ✓ | ✓ | — | — | — |

`*.view_team` مؤجّل (لا نموذج فريق). `inventory.adjust` لا تعني رؤية التكلفة (`inventory_costing.*` منفصلة). «منح» = غير مفعّلة افتراضيًا. لا Leaderboard عام.

---

## 7) المقاييس المعتمدة

| المقياس | التعريف |
|---|---|
| decisionEligibleOrders | `COUNT(DISTINCT orderId)` لأحداث المنسوب إليه من confirm/no_answer/postpone/cancel في الفترة |
| confirmedOrders | `COUNT(DISTINCT orderId)` لأحداث confirm المنسوبة إليه |
| «نسبة التأكيد من القرارات المسجلة» | confirmedOrders ÷ decisionEligibleOrders (≤ 100%) |
| noAnswerOrders / noAnswerAttempts | `COUNT(DISTINCT orderId)` / `COUNT(*)` لـno_answer |
| workload (حجم العمل) | أوردرات مختلفة له أي حدث منسوب (منفصل عن النسبة) |
| assignedOrders (الإسنادات) | أوردرات مختلفة أُسندت إليه (assign/reassign، `assigneeEmployeeIdAtEvent`) — منفصل |
| الترتيب | فقط لمن decisionEligibleOrders ≥ 20؛ الأقل تظهر أرقامهم ونسبتهم بلا ترتيب |
| الأيام | بتوقيت Africa/Cairo |

---

## 8) قرارات المالك المعتمدة

1. حد عينة الترتيب: 20 أوردرًا مؤهلًا؛ الأقل يظهرون بلا ترتيب.
2. eligibleOrders: confirm/no_answer/postpone/cancel؛ الاسم «نسبة التأكيد من القرارات المسجلة».
3. المقارنة: super_admin، admin، ومن يُمنح `employee_performance.view_all`؛ الموظف يرى نفسه فقط؛ لا Leaderboard عام.
4. الورديات: لا ورديات افتراضية ولا Seed؛ المالك ينشئها من الواجهة (يُدعم مثال 11:00–18:00 بلا أن يكون افتراضيًا).
5. سماح التأخير: 10 دقائق كاقتراح أولي في نموذج الإنشاء، قابل للتغيير لكل وردية.
6. الاستراحة: 60 دقيقة كاقتراح أولي؛ الزيادة تُسجَّل ولا تُخصم.
7. الخروج المبكر: دقائق + سبب + مراجعة؛ لا خصم.
8. الإضافي: بعد 30 دقيقة كاقتراح؛ يحتاج اعتمادًا؛ لا ربط بالراتب.
9. الإجازة/المأمورية: طلب واعتماد فقط؛ لا رصيد ولا خصم.
10. انتهاء التجربة: trialing قبل النهاية Full؛ بعدها Read-only؛ active Full؛ past_due سماح 7 أيام ثم Read-only؛ expired Read-only؛ suspended وcanceled Blocked. Read-only: دخول، قراءة، تصدير، إعدادات الاشتراك، خروج؛ كل كتابة تشغيلية ممنوعة؛ الويبهوك تُستقبل وتُحفظ في الـInbox بلا معالجة، وتُعالج مرة واحدة بعد إعادة التفعيل.

---

## 9) Tenant Access Enforcement (خلف `TENANT_ACCESS_ENFORCEMENT_ENABLED=false`)

- `resolveTenantAccess(tenantId, now)` نقطة واحدة ← `full | read_only | blocked` + السبب.
- مُطبَّق في: middleware موحّد لكل إجراءات tRPC المصادَق عليها (ويب وبوابة، query/mutation)، مسارات Express (import/upload ⇒ كتابة؛ export/awb ⇒ قراءة)، المجدول الخلفي، ومعالجة الويبهوك (استقبال وحفظ دون معالجة).
- Platform Admin مستثنى (مصادقة منفصلة). العلم معطل = السلوك الحالي حرفيًا. لا تغيير status لأي Tenant.
- شاشة «انتهت الفترة التجريبية» تُعرض فقط عند رمز `TENANT_READ_ONLY`/`TENANT_BLOCKED` من الحارس.

---

## 10) Manager Dashboard — المعتمد

- الدخول للمسار يبقى super_admin/admin/manager (لا moderator).
- كل تبويب وإجراء يحتاج صلاحيته: الأوردرات `orders.view/update/confirm/cancel`؛ الموظفون `employees.view/manage`؛ المهام `employees.view` (قراءة) و`employees.manage` (إنشاء/حذف/إسناد الآخرين)؛ المخزون `inventory.view/adjust`.
- warehouse يستخدم Warehouse Dashboard (يحتفظ بالمخزون عبر `inventory.*`).

## 11) Backend معتمد

1. `employeePortal.tasks.listMine` / `employeePortal.tasks.updateMyStatus`: مهامه + المهام العامة لنشاطه؛ لا إنشاء ولا حذف؛ fail-closed.
2. كل إجراءات البوابة على `requireEmployeeTenantPermission` (منح/سحب فوري، عزل A/B، لا صلاحيات جلسة المالك).
3. أحداث الويبهوك في 0041 خلف العلم (Audit فقط، بلا منطق Bosta/Easy Orders ولا كتابة مالية).

---

## 12) ترتيب التنفيذ وقيود التشغيل

Commits مستقلة: (1) هذه الحزمة؛ (2) ملفات 0041 + السكربتات؛ (3) خدمة Event Ledger وربط المسارات؛ (4) تقرير الأداء؛ (5) ملفات 0042 + السكربتات؛ (6) خدمات الحضور؛ (7) Routers والصلاحيات؛ (8) الواجهات؛ (9) مهام الموظف وتوحيد البوابة؛ (10) صلاحيات لوحة المدير؛ (11) Tenant Access خلف العلم؛ (12) مراجعة واختبارات.
مسموح: تشغيل 0041/0042 على Docker محلي مؤقت فقط. ممنوع: Push، Deploy، Staging، Production، تشغيل 0040، Backfill حقيقي، تفعيل أي علم، تغيير Tenant Status، كتابة Ledger V3 أو Payroll، drizzle-kit push/generate.
