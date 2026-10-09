# حزمة قرار — تقارير أداء الموظفين + الحضور والانصراف (قبل أي Migration)

التاريخ: 2026-10-09 · الفرع المحلي `staging/bosta-package-images` · لم يُكتب أي Migration ولم يُشغَّل، ولم يُلمس Staging/Production.
كل مسار في هذا الملف موثّق بـ`ملف:سطر` كما في HEAD وقت الكتابة.

---

## 0) الخلاصة

| البند | القرار |
|---|---|
| تقارير الأداء التاريخية (C) | **البيانات الحالية لا تكفي — تحتاج Migration additive** (جدول أحداث أوردرات) + كتابة الحدث في كل مسار تغيير حالة داخل نفس الـtransaction. |
| الحضور والانصراف (D) | **لا يوجد أي جدول أو كود حضور — تحتاج Migration additive** (5 جداول). |
| الصلاحيات الجديدة | مفاتيح نصية (`tenant_role_permissions.permission` = `varchar(100)`، schema.ts:1419) → **كود فقط بلا Migration**. |
| Team Leader / view_team | **لا توجد علاقة فريق حقيقية** في الـschema (لا teamId/managerId/supervisorId) → `*.view_team` مؤجّل حتى قرار بنموذج فريق. |
| الفترة التجريبية | الحقول موجودة (`tenants.status/trialEndsAt`) لكن **لا Enforcement على السيرفر إطلاقًا** → قرار Backend مستقل (بلا Migration). |
| ثغرات عزل (P0) | الرسائل الجماعية والمهام بلا تقييد Tenant/نشاط → قرار Backend أمني (بلا Migration). |

---

## 1) نتيجة Audit أداء الموظفين (C1)

### 1.1 الهوية في السجلات الحالية غير متسقة
- جلسات المالك/الأدمن/المدير تحصل على مستخدم صناعي `id = -emp.id` (server/_core/context.ts:45). سجلات `activity_logs` من مسارات الأدمن تخزّن **رقمًا سالبًا** و`performedByRole = "admin"` ثابتًا.
- مسارات بوابة الموظف تخزّن `emp.id` موجبًا. مسارات النظام تخزّن `0`.

### 1.2 جدول الأحداث لكل مسار

| الحدث | مسار الكتابة | الجدول | الموظف المنفذ | الوقت | from/to | Tenant/Business | Idempotency | يكفي تاريخيًا؟ |
|---|---|---|---|---|---|---|---|---|
| confirm (أدمن) | routers.ts:3442 → db.ts:2487 | activity_logs + orders.confirmedByEmployeeId (مرة واحدة) | سالب في AL؛ موجب في العمود | نعم | لا | لا/لا | الأوردر idempotent، السجل يتكرر | جزئيًا (أول مؤكّد فقط) |
| cancel (أدمن) | routers.ts:3615 → db.ts:2592 | activity_logs | سالب | نعم | لا | لا/لا | لا | جزئيًا |
| postpone (أدمن) | routers.ts:3595 → db.ts:2528 | **لا شيء** (lastUpdatedBy يُستبدل) | — | — | — | — | — | **لا** |
| markNoAnswer (أدمن) | routers.ts:3645 | **لا شيء** (noAnswerCallAttempts يُستبدل) | — | — | — | — | — | **لا** |
| orders.update (preparing/shipped…) | routers.ts:3363 | **لا شيء** | — | — | — | — | — | **لا** |
| portal confirm/postpone/cancel | routers.ts:4270 / 4300 / 4331 | activity_logs | موجب | نعم | لا | لا/لا | لا | جزئيًا |
| portal markNoAnswer | routers.ts:4362 | **لا شيء** | — | — | — | — | — | **لا** |
| portal updateStatus | routers.ts:4392 | order_edit_logs (field=status) | موجب | نعم | **نعم** | لا/لا | نفس الحالة يرجع مبكرًا | جزئيًا |
| editOrder / editOrderItems | db.ts:4609 / 5469 | order_edit_logs + activity_logs | موجب | نعم | فروق حقول | AL فيه businessId فقط | لا | نعم للتعديل (بلا tenant) |
| assign / bulkAssign / unassign / reclaim | db.ts:2285 / 2302 / routers.ts:4036 / db.ts:3425 | لا شيء أو سجل بلا orderIds | — | — | المُسنَد السابق يضيع | — | — | **لا** |
| print → printed | db.ts:2251 | لا شيء | لا | printedAt | لا | — | WHERE status | لا |
| Bosta send / webhook | bosta.service.ts:509 / bostaWebhook.ts:108 | carrier_webhook_inbox | نظام | نعم | to فقط | نعم/نعم | UNIQUE | نعم للنظام (لا يُنسب لموظف) |
| Easy Orders status | easyorderWebhook.ts:98 | webhook_logs (نص حر) | 0 | نعم | نص | business | لا | لا |
| duplicates delete/restore | routers.ts:5394 / 5408 | لا شيء (حذف نهائي) | — | — | — | — | — | لا |

### 1.3 القرار
**البيانات الحالية لا تكفي.** لا سجل إطلاقًا لـ«لم يرد» ولا لتأجيل الأدمن ولا للإسناد، والسجلات الموجودة بلا tenantId، ومعظمها بلا businessId، وبلا from/to، وبلا منع تكرار، وبهوية متضاربة الإشارة.
التقرير الحالي `getEmployeePerformance` (db.ts:2755) يحسب من **الإسناد الحالي والحالة الحالية** — وهو تحديدًا ما طُلب ألا نعتمد عليه، فلا يُبنى عليه التقرير الجديد.

---

## 2) Schema المقترح — أداء الموظفين (C8)

### `order_activity_events` (اسم مقترح؛ يُعتمد بعد المراجعة)

| العمود | النوع | ملاحظة |
|---|---|---|
| id | int PK auto | |
| tenantId | int NOT NULL | من `businesses.tenantId` على السيرفر (orders بلا tenantId) |
| businessId | int NOT NULL | من الأوردر |
| orderId | int NOT NULL | بلا FK على orders (الحذف النهائي للمكررات قائم) |
| orderNumberSnapshot | varchar(20) | لعرض الحدث بعد حذف الأوردر |
| eventType | varchar(40) NOT NULL | confirm / no_answer / postpone / cancel / edit / edit_items / assign / unassign / status_change / prepare / print / ship_update / return / duplicate_mark / duplicate_unmark / restore |
| fromStatus / toStatus | varchar(30) NULL | |
| actorType | enum(employee, system, webhook) NOT NULL | |
| actorEmployeeId | int NULL | **موجب دائمًا** (`resolveActingEmployeeId`)؛ NULL للنظام/الويبهوك |
| actorRoleSnapshot / actorNameSnapshot | varchar | تغيير الاسم/الدور لا يمحو التاريخ |
| assigneeEmployeeIdAtEvent | int NULL | المُسنَد وقت الحدث |
| reason | varchar(160) NULL | سبب الإلغاء/التأجيل |
| callAttempts | smallint NULL | لـ no_answer |
| source | varchar(30) NOT NULL | admin_ui / employee_portal / bulk / webhook_bosta / webhook_easyorders / system |
| idempotencyKey | varchar(191) NOT NULL | |
| occurredAt | timestamp(3) NOT NULL | وقت السيرفر UTC |
| metadataJson | json NULL | |
| createdAt | timestamp default now | |

القيود والفهارس:
- `UNIQUE(tenantId, idempotencyKey)` — يمنع تكرار الضغط المزدوج/الإعادة.
- `UNIQUE(tenantId, id)`.
- `INDEX(tenantId, occurredAt)` · `INDEX(actorEmployeeId, occurredAt)` · `INDEX(businessId, occurredAt)` · `INDEX(orderId)`.
- FK مركّب `(tenantId, businessId) → businesses(tenantId, id)` و`(tenantId, actorEmployeeId) → employees(tenantId, id)` بنمط 0040 (drizzle/0040_ledger_v3.sql:37-41). **تنبيه اعتماد**: هذان الفهرسان المركّبان (`businesses_tenant_id`, `employees_tenant_id`) يُنشآن داخل 0040 الذي لا يُشغَّل؛ لذا الـMigration الجديدة تنشئهما بنفسها بعد preflight يتحقق من غيابهما، وإلا تتخطى الـFK المركّب وتبقى العزلة على مستوى الكود.
- لا DELETE: الأحداث للإضافة فقط؛ لا مسار حذف في الكود.

### الكتابة
- دالة واحدة `recordOrderEvent(tx, …)` تُستدعى **داخل نفس الـtransaction** في كل مسار من جدول 1.2 (≈ 20 موضعًا). مفتاح الـidempotency = `${eventType}:${orderId}:${requestKey}` حيث requestKey من العميل للأفعال اليدوية (operationId كما في Ledger) أو من حدث الويبهوك.
- أحداث النظام/الويبهوك: `actorType = system/webhook` و`actorEmployeeId = NULL` — لا تُنسب لموظف.

---

## 3) تعريف المقاييس (C2) — مركزيًا في `shared/employeePerformance.ts`

| المقياس | التعريف |
|---|---|
| uniqueHandledOrders | `COUNT(DISTINCT orderId)` لأحداث مؤهلة للموظف: confirm, no_answer, postpone, cancel, edit, edit_items, status_change |
| confirmedOrders | `COUNT(DISTINCT orderId)` حيث eventType=confirm |
| noAnswerOrders / noAnswerAttempts | `COUNT(DISTINCT orderId)` / `COUNT(*)` لـ no_answer |
| postponedOrders / cancelledOrders / editedOrders | `COUNT(DISTINCT orderId)` للنوع |
| eligibleOrders (المقام) | الأوردرات المختلفة التي تعامل معها الموظف بقرار تأكيد (confirm/no_answer/postpone/cancel) في الفترة |
| confirmationRate | confirmedOrders ÷ eligibleOrders (≤ 100% بالتعريف لأن البسط مجموعة جزئية من المقام) |
| needsFollowUp | أوردرات eligible آخر حدث لها من الموظف no_answer/postpone ولم يتلُه confirm/cancel من أي أحد |
| firstResponseMinutes | من `assign` (أو إنشاء الأوردر إن لم يُسنَد) إلى أول حدث قرار للموظف — **يُعرض فقط للأوردرات التي لها حدث assign بعد Go-Live** |
| activeDays | الأيام المختلفة (بتوقيت Africa/Cairo) التي فيها حدث للموظف |

قواعد: كل حدث لصاحبه؛ إعادة الإسناد لا تغيّر التاريخ؛ تعطيل الموظف لا يحذف بياناته؛ حد أدنى للعينة **20 أوردرًا eligible** لترتيب النِّسَب (قابل للضبط بعد رؤية البيانات الحقيقية)؛ كل نسبة تُعرض بجانب عددها.

---

## 4) Schema المقترح — الحضور (D16 بعد المراجعة)

ملاحظة: `businesses.timezone` موجود (schema.ts:90، افتراضي Africa/Cairo) ويُعاد استخدامه؛ و`payroll_settings.weekendDays/workHoursPerDay` موجودة لكن **لا ربط بالرواتب في هذه النسخة**.

1. **`attendance_shifts`**: id, tenantId, businessId NULL, name, startTime `time`, endTime `time`, crossesMidnight bool (مشتق ويُخزَّن), workDays varchar (`"0,1,2,3,4"`), graceMinutes, allowedBreakMinutes, overtimeStartsAfterMinutes, earlyClockInLimitMinutes, effectiveFrom `date`, effectiveTo `date` NULL, isActive, createdByEmployeeId, createdAt, updatedAt. فهارس: `(tenantId, isActive)`، `UNIQUE(tenantId,id)`.
2. **`attendance_assignments`**: id, tenantId, shiftId, employeeId NULL, role NULL, businessId NULL, effectiveFrom, effectiveTo NULL, priority (1 موظف، 2 دور/نشاط، 3 افتراضي)، assignedByEmployeeId, assignedAt. CHECK: واحد على الأقل من employeeId/role/businessId أو افتراضي الشركة.
3. **`attendance_days`**: id, tenantId, employeeId, businessId NULL, workDate `date` (تاريخ بداية الوردية), timezone, shiftId NULL, shiftSnapshotJson (لقطة الوردية يومها — التعديل لاحقًا لا يعيد حساب الماضي), status, scheduledStart/End `timestamp`, actualFirstIn/LastOut NULL, workedMinutes, breakMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes, requiresReview, approvedByEmployeeId NULL, approvedAt NULL, createdAt, updatedAt. `UNIQUE(tenantId, employeeId, workDate)` — يمنع يومين مفتوحين لنفس التاريخ.
4. **`attendance_events`**: id, tenantId, attendanceDayId, employeeId, businessId NULL, eventType (clock_in / break_start / break_end / clock_out / absence / leave / mission / correction / day_close), occurredAt (وقت السيرفر), idempotencyKey, actorType (self / admin / system), actorEmployeeId, source (web / mobile / web-app / admin), correctionOfEventId NULL, reason NULL, oldValueJson / newValueJson NULL, metadataJson NULL, createdAt. `UNIQUE(tenantId, idempotencyKey)`؛ فهارس `(tenantId, employeeId, occurredAt)`؛ إضافة فقط بلا حذف.
5. **`attendance_correction_requests`**: id, tenantId, employeeId, attendanceDayId NULL, workDate, requestType, requestedTime NULL, reason NOT NULL, note NULL, status (pending/approved/rejected/canceled), reviewedByEmployeeId NULL, reviewedAt NULL, reviewReason NULL (إجباري عند الرفض — يُفرض في الكود)، createdAt, updatedAt.

الإجازات/المأموريات: تُسجَّل في البداية كأحداث `leave/mission` على `attendance_days` (يوم أو مدى أيام) بموافقة — بلا نظام HR منفصل ولا خصم.

---

## 5) تدفق الأحداث والتزامن (D2/D12)

- `attendance.clock(action)` على `employeePortalProcedure`: **employeeId من الجلسة فقط**؛ tenantId من `ctx.tenantId`؛ الوقت `NOW()` من السيرفر.
- داخل transaction واحدة: احسب workDate من وردية الموظف وتوقيت النشاط ← `SELECT … FOR UPDATE` على صف `attendance_days` (أو INSERT بـ`UNIQUE` ثم إعادة قراءة) ← تحقق تسلسل الحالة (لا انصراف بلا حضور، لا استراحتين مفتوحتين…) ← INSERT الحدث بمفتاح idempotency ← حدّث مجاميع اليوم ← أعد قراءة الصف المحفوظ وأرجعه.
- الضغط المزدوج/الطلبات المتزامنة: نفس `idempotencyKey` (يولّده العميل لكل نقرة مرة واحدة) + قفل الصف = حدث واحد.
- الموظف المعطّل: `employeePortalProcedure` يرفضه أصلًا (isActive)، وتاريخه باقٍ.
- Login/Logout لا يكتبان حضورًا (localAuth.ts:64 و employeeAuth.ts:69 يكتبان lastLoginAt فقط — يبقيان كما هما).
- Offline: الواجهة لا تعرض نجاحًا إلا بعد ردّ السيرفر؛ لا localStorage كمصدر.

---

## 6) الصلاحيات (C7/D15) — كود فقط

مقترحة في `server/permissions.ts` + `shared/permissionLabels.ts`:
`employee_performance.view_self | view_all | export` · `attendance.clock_self | view_self | request_correction | view_all | manage_shifts | correct | approve_corrections | manage_leaves | export`.

الافتراضات المقترحة: super_admin الكل داخل شركته؛ admin الكل ما عدا export حسب المنح؛ manager بلا شيء من الأداء/الحضور الشامل إلا بمنح؛ accountant لا يرى بلا منح؛ كل الأدوار التشغيلية `attendance.clock_self/view_self/request_correction` و`employee_performance.view_self`.
`*.view_team` مؤجّل (لا علاقة فريق). صلاحيات Ledger منفصلة ولا تمنح أيًّا منها. السيرفر هو الحارس (`permissionProcedure`)، مع ملاحظة أن `requireEmployeePermission` الحالي يتجاهل تخصيصات الشركة (routers.ts:290) — المسارات الجديدة تستخدم `hasTenantPermission`.

---

## 7) Go-Live / Backfill / Rollback

**الأداء**
- Go-Live = تاريخ تطبيق الـMigration ونشر الكود الذي يكتب الأحداث. التقرير الرسمي يبدأ منه.
- Backfill اختياري بثلاث درجات (لا يُنفَّذ إلا بموافقة):
  - **مؤكد**: `orders.confirmedByEmployeeId + confirmedAt` (أول مؤكّد)، صفوف `activity_logs` لـ confirm/cancel/postpone (بعد عكس الإشارة السالبة وربط businessId عبر الأوردر)، `order_edit_logs` لتغييرات الحالة والتعديل.
  - **مستنتج جزئيًا**: لا يوجد مصدر يُعتد به.
  - **غير معروف**: no_answer، تأجيل الأدمن، كل الإسنادات، الطباعة — لا تُنسب لأحد.
  - يُعلَّم كل صف مُرحّل `source = backfill_<مصدر>`، ويُعرض في التقرير منفصلًا عن الرسمي.
- Rollback قبل أول كتابة: DROP للجدول الجديد فقط. بعد أول أحداث فعلية: تعطيل الكتابة بعلم ميزة (feature flag) وإبقاء الجدول.

**الحضور**
- Go-Live = أول يوم عمل بعد التفعيل؛ **لا استنتاج للماضي من Login/Logout**، ولا ساعات قديمة، ولا Backfill (لا يوجد مصدر مؤكد).
- Rollback قبل الاستخدام: DROP للجداول الخمسة بالترتيب العكسي. بعد الاستخدام: إخفاء الواجهة وتعطيل `attendance.clock_self` فقط، والتاريخ يبقى.

---

## 8) مخاطر Concurrency

- ضغطتان متزامنتان على «حضور»: يحسمها `UNIQUE(tenantId, idempotencyKey)` + `SELECT … FOR UPDATE` على اليوم.
- يوم مفتوح من وردية ليلية + حضور جديد بعد منتصف الليل: workDate يُحسب من الوردية لا من تاريخ اليوم، فيُلحق باليوم المفتوح أو يُرفض حتى الإغلاق.
- تصحيح إداري أثناء تسجيل الموظف: نفس قفل الصف، والتصحيح حدث جديد لا UPDATE صامت.
- أحداث الأوردرات: الحدث داخل transaction تغيير الحالة نفسه؛ إن فشل أحدهما رجع الاثنان.

---

## 9) خطة الاختبارات (E)

**الأداء** (DB-gated على قواعد Docker مؤقتة): موظفان على نفس الأوردر؛ إعادة الإسناد لا تنقل التاريخ؛ ضغط مزدوج = حدث واحد؛ إعادة/Replay؛ حدث ويبهوك/نظام بلا موظف؛ موظف أكّد وآخر ألغى؛ no_answer ×3 = 1 أوردر و3 محاولات؛ موظف معطّل؛ تغيير الاسم؛ عزل Tenant A/B ونشاط؛ كل الفترات بتوقيت القاهرة (حدود اليوم 22:00 UTC صيفًا)؛ النِّسَب ≤ 100%؛ حد العينة؛ الصلاحيات من السيرفر؛ التصدير يحترم الفلاتر والعزل.
**الحضور**: التسلسل الكامل؛ منع التسلسل الخاطئ؛ ضغط مزدوج وتزامن (Promise.all على نفس المفتاح)؛ منع تسجيل لموظف آخر (employeeId من العميل يُتجاهل)؛ وقت السيرفر؛ العزل؛ وردية صباحية وليلية؛ السماح والتأخير؛ الخروج المبكر؛ الإضافي؛ الاستراحة الزائدة؛ عطلة/إجازة/مأمورية؛ موظف معطّل؛ Audit التصحيح؛ قبول/رفض طلب؛ يوم ناقص؛ Shift Snapshot؛ Offline؛ **صفر كتابة على payroll_* وledger_***.

---

## 10) أسماء ملفات الـMigration المقترحة (لم تُكتب)

- `drizzle/0041_order_activity_events.sql` + `drizzle/orderEvents.schema.ts` (خارج drizzle.config كما في ledgerV3) + `scripts/migrate-0041-order-events.ts` بـ`--check/--apply/--rollback` ومانع للإنتاج كما في سكربت 0040.
- `drizzle/0042_attendance.sql` + `drizzle/attendance.schema.ts` + `scripts/migrate-0042-attendance.ts`.
- لا `drizzle-kit generate/push` (اللقطات قديمة منذ 0034 — drizzle/meta/_journal.json).

---

## 11) ما يمكن تنفيذه بعد الموافقة (بالترتيب)

1. 0041 على Staging فقط بعد نسخة احتياطية، ثم الكود الذي يكتب الأحداث في المسارات العشرين، ثم صفحة التقارير (C3–C6) والتصدير.
2. 0042، ثم بوابة الحضور للموظف، ثم لوحة اليوم، ثم الورديات، ثم التصحيحات والتقارير.
3. Backfill الأداء «المؤكد» فقط إن وُوفق عليه.

---

## 12) قرارات Backend مستقلة (بلا Migration) — تحتاج موافقتك

1. **P0 أمني — الرسائل الجماعية**: `sendBroadcast/clearBroadcast/activeBroadcast` (routers.ts:5282-5326) تعمل على **كل** الصفوف بلا تقييد؛ مدير شركة يعطّل رسالة شركة أخرى، وموظفو شركة يرون رسالة شركة أخرى. الإصلاح: كتابة `businessId` من جلسة المدير والتصفية بنطاق الجلسة؛ الصفوف القديمة بلا businessId تختفي (fail-closed).
2. **P0 أمني — المهام**: `tasks.create` لا يتحقق من أن `assignedTo` من نفس الشركة ولا يحفظ `businessId`؛ `tasks.list` بلا `employeeId` يُرجع مهام **كل الشركات** والمهام العامة لأي شركة (routers.ts:6440-6515). الإصلاح: `requireOwned` على assignedTo، حفظ businessId، والتصفية بنطاق الجلسة.
3. **Fail-open**: `productsList/lowStockProducts/inventoryMovements/cancellationReasons/dailyChart` تمرّر `emp.businessId ?? undefined` (موظف بلا نشاط = بلا فلتر).
   أشدّها `dailyChart`: استعلام `getDailyOrdersChart` (db.ts:2819) لا يحتوي أي شرط `tenantId`، فمدير بلا `businessId` يرى
   أعداد أوردرات **كل الـTenants**. الإصلاح: `scopeBusinessIds(empScope(ctx), {})` مثل `employeesList`.
4. **الفترة التجريبية**: لا أي Enforcement (`trialEndsAt` يُكتب عند الموافقة ولا يُقرأ). المكان الطبيعي `createContext` + `employeePortalProcedure` + `requireAdminOrManager` + مسارا الدخول، مع شاشة واضحة بعد التطبيق. لا تُبنى الشاشة قبل التطبيق على السيرفر.
   **تصميم الشاشة المقترح (لا يُبنى قبل التطبيق على السيرفر):** صفحة مستقلة بـ`<main>` واحد على هوية Copper: أيقونة
   ساعة، عنوان «انتهت الفترة التجريبية»، تاريخ الانتهاء الفعلي من `trialEndsAt` بتوقيت القاهرة (أو «غير متاح»)، فقرة
   «بياناتك محفوظة ولم تُحذف»، زر «تواصل مع إدارة المنصة» (رابط تواصل يُحدَّد بقرار)، وزر «تسجيل الخروج». حالات منفصلة
   لـ suspended («الحساب موقوف») وcanceled. الموظف (غير المالك) يرى نفس الرسالة بلا تفاصيل اشتراك. لا عدّاد أيام
   قبل الانتهاء إلا بقرار. يتطلب: كود للحارس المركزي + رسالة خطأ موحّدة (`TENANT_TRIAL_EXPIRED`) تلتقطها الواجهة.
   **حقائق الـAudit:** `tenants.status` = trialing/active/past_due/canceled/suspended/expired (schema.ts:27-36)؛
   `approveSignupRequest` يضبط trialing + 14 يومًا (db.ts:492-540)؛ لا قراءة لـ`trialEndsAt` في أي مكان؛ لا انتقال
   تلقائي إلى expired؛ لا مسار تعليق في لوحة المنصة؛ جدول `subscriptions` غير مقروء؛ القراءة الوحيدة لـstatus في
   ledgerV3Activation.service.ts:80-83.
5. **/manager-dashboard**: `managerPortalProcedure` يقبل super_admin/admin لكن `productsList/lowStockProducts/addInventoryMovement/inventoryMovements` تشترط حرفيًا manager/warehouse (routers.ts:5017-5067). القرار: توحيدها على مستوى الإدارة أو إبقاؤها للمدير فقط.
6. **روابط شاشة الموظف لمسارات قد ترفضه**: زرّا «شحنات اليوم» و«جدول توزيع المحافظات» في `/employee-dashboard` يظهران لكل
   موظف، بينما المساران يشترطان `shipping_ops.view` (routers.ts:4793-4803)؛ موظف التأكيد بلا الصلاحية يصل لصفحة «مش من
   مهامك» (مع زر رجوع). إخفاء الزرين يحتاج أن تُرجع `employeePortal.me` صلاحيات الجلسة — تغيير Backend لم يُنفّذ.
7. **التقرير الحالي `reports.employeePerformance`** يُنسب بالإسناد الحالي والحالة الحالية (db.ts:2755) — يبقى كما هو إلى أن يحل محله تقرير الأحداث، مع وسم «تقديري» في الواجهة إن وافقت.
