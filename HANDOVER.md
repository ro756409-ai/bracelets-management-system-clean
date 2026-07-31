# متجرك (Matjarak) — ملف تسليم ومراجعة فنية

> **الغرض:** مراجعة فنية مستقلة من جهة خارجية.
> **تاريخ الإصدار:** ٣١ يوليو ٢٠٢٦
> **حالة النشر:** ٥ commits محلية **غير مدفوعة** · migration 0032 و0033 **غير مُشغَّلتين على الإنتاج**

---

## ١. نظرة عامة

نظام ERP لتجار الأونلاين في مصر: إدارة أوردرات، تأكيدات هاتفية، مخزون، شحن (بوسطة)، حسابات، ورواتب.

النظام في **الإنتاج فعليًا** على `matjarak.net` بحوالي **٩٦٦ أوردر** وبيانات عملاء حقيقية.

### أصل المشروع
الكود الأصلي مُولَّد بمنصة **Manus**. الشغل الموثّق هنا هو تحويله من نموذج أولي إلى نظام SaaS متعدد التجار.

| المؤشر | القيمة |
|---|---|
| عدد الـcommits | 81 |
| صافي التغيير منذ البداية | +62,471 / −6,063 سطر · 186 ملف |
| ملفات الاختبار | 45 |
| الاختبارات | **677** (669 ناجح · 8 فاشل بيئيًا) |
| migrations | 35 ملفًا (`0000` → `0033`) |
| جداول قاعدة البيانات | 37 |
| صفحات الواجهة | 36 |
| tRPC routers | 15 |

### التقنيات
| الطبقة | التقنية |
|---|---|
| الواجهة | React 19.2 · Vite 7.1 · wouter · TanStack Query · Tailwind CSS 4.1 |
| الـAPI | tRPC 11.6 · Zod 4.1 |
| الخادم | Express 4.21 · Node |
| قاعدة البيانات | MySQL · Drizzle ORM 0.44 |
| اللغة | TypeScript 5.9 (strict) |
| الاختبارات | Vitest 2.1 |
| النشر | Coolify |
| مدير الحزم | **`corepack pnpm`** (مهم — `pnpm` المجرّد غير مستخدم) |

---

## ٢. المعمارية

### طبقات البيانات
```
tenant (تاجر)
  └── business group (اختياري)
        └── business (براند/نشاط)
              └── orders · products · employees · expenses · payroll …
```

### 🔴 عزل الـtenant — نقطة مراجعة أساسية

**جداول التشغيل لا تحمل `tenantId`.** بتحمل `businessId NOT NULL` فقط. العزل بيتم **في الكود** عبر:

```
scopeBusinessIds(ctx.tenantId, input)
  └── getBusinessIdsForTenant(tenantId)   ← server/db.ts:142
        └── SELECT id FROM businesses WHERE tenantId = ?
```

الجداول اللي بتحمل `tenantId`: `tenants`, `business_groups`, `businesses`, `subscriptions`, `payment_gateway_configs`, `employees`, `import_batches`.

**نقطة للمراجعة:** أي procedure جديد **لازم** يستدعي `scopeBusinessIds` أو `requireScopedBusinessId`. النسيان = تسريب بيانات بين التجار. مافيش حماية على مستوى قاعدة البيانات (RLS أو Foreign Keys).

**سلوك مقصود:** `getBusinessIdsForTenant` بترجّع `null` لما قاعدة البيانات مش متاحة (يعني "متعذّر التحقق") و`[]` لما التحقق تمّ ومفيش نتائج. الفرق ده مقصود — كان bug سابق بيرجّع `[]` في الحالتين وبيسبب `FORBIDDEN` كاذبة.

### المصادقة — نظام كوكيّين

| الكوكي | المسار | الأدوار |
|---|---|---|
| `app_session_id` | `/login` | المالك + الأدوار الإدارية |
| `employee_token` | `/employee-login` | كل الموظفين |

`createContext()` بيبني `ctx.user` للأدوار الإدارية فقط (`super_admin`/`admin`/`manager`). موظف عادي عنده `ctx.employee` بدون `ctx.user` — عشان كده كل الـrouters الإدارية (بما فيها الحسابات والرواتب) على `adminProcedure`.

**نقطة للمراجعة:** ده يعني إن دور `accountant` عنده صلاحيات `accounting.*` و`payroll.*` في `permissions.ts` لكن **مالوش مسار دخول** لاستخدامها. مرصود كنقص مقصود.

### الصلاحيات — `server/permissions.ts` (90 سطرًا)

جدول ثابت: **19 صلاحية** × **12 دور**.

```
dashboard.view · orders.{view,create,update,confirm,cancel,export,import}
employees.{view,manage} · settings.{view,manage} · audit.view
accounting.{view,manage} · payroll.{view,manage,approve,pay}
```

**نقطة للمراجعة — قيد معروف:** الصلاحيات الدقيقة مربوطة بـ**15 موضعًا** فقط (`requireEmployeePermission`)، مقابل **97 `adminProcedure`**. يعني معظم النظام محميّ بـ«إداري / غير إداري» لا بالصلاحية الدقيقة. موثّق في تعليق أعلى `permissions.ts` كقيد مقصود لهذه المرحلة.

---

## ٣. الوحدات

### ٣.١ الأوردرات (`client/src/pages/Orders.tsx` — 2,442 سطرًا)
- 10 أعمدة · 8 فلاتر · pagination 25/50/100
- Drawer فيه: العميل · الشحن · المنتجات · الموظف · **سجل الحالات** · الملاحظات
- سجل الحالات مبنيّ من 10 أعمدة طوابع زمنية على `orders` + `order_edit_logs` — **بدون جدول تاريخ حالات منفصل**
- عمليات جماعية · تصدير Excel · طباعة AWB

### ٣.٢ بورتال الموظف (`EmployeeDashboard.tsx` — 2,176 سطرًا)
- Mobile-first · 7 بطاقات إحصائية · أزرار إجراءات **ثابتة ظاهرة** (مش داخل الطي)
- موظف التأكيدات يقدر يغيّر الحالة لأربع حالات فقط، والحد الأمني `z.enum` مبنيّ من `shared/const.ts`
- كل تغيير حالة بيتسجّل في `order_edit_logs`

### ٣.٣ التكاملات
| التكامل | الحالة |
|---|---|
| **بوسطة** | Webhook بسر ثابت + مقارنة آمنة · إنشاء شحنة · AWB رسمي · خريطة حالات |
| **EasyOrder** | Webhook فقط (مفيش list endpoint في الـAPI بتاعهم) · مطابقة منتجات SKU-first |
| **فيسبوك** | لصق نص عربي حر → parser → نموذج مراجعة |

### ٣.٤ الحسابات (`Accounting.tsx` + 4 أقسام)

صفحة واحدة بخمسة تابات: **نظرة عامة · الخزنة · المصروفات · التحصيلات · المرتبات**.

**القرار المعماري المركزي:** `treasury_transactions` هو الـ**ledger الوحيد**. كل حركة مالية بتنزل فيه صفًا واحدًا.

```
balanceAfter محسوب وقت الكتابة داخل db.transaction() — مش SUM عند القراءة
```

**السبب:** الجمع عند القراءة معناه إن إدخال حركة بتاريخ قديم يعيد كتابة كل الأرصدة بعدها، والتاجر مايقدرش يطابق كشفًا قديمًا. والـtransaction لأن قراءة-ثم-كتابة عمليتان: بدونها حركتان متزامنتان تقرآن نفس الرصيد وتكتبان نفس `balanceAfter`.

**الـledger append-only:** التعديل والحذف بينزّلوا **قيد تسوية** مش بيمسّوا الصف الأصلي.

### ٣.٥ الرواتب (أحدث وحدة — commit `13876fb`)

5 جداول · **صفر `ALTER`** على أي جدول قائم.

```
employee_salary_profiles  ← مُصدَّر بالإصدارات (effectiveFrom)
payroll_settings          ← قواعد المحرّك لكل نشاط
payroll_periods           ← رأس الدورة + expenseId
payroll_items             ← سطر لكل موظف + profileSnapshot + manualFields
employee_advances         ← السُلف
```

**محرّك الحساب** في `shared/payrollCalc.ts` (269 سطرًا) — **دوال نقية بلا قاعدة بيانات**، مغطّاة بـ**43 اختبارًا**.

**ثلاثة حواجز ضد الدفع المزدوج:**
1. `UNIQUE(businessId, year, month)` — على مستوى قاعدة البيانات
2. `status !== 'approved'` → رفض
3. `expenseId != null` → رفض

**المسار المحاسبي:** الرواتب والسُلف بتدخل عبر `expenses` مش الخزنة مباشرة، لأن لوحة الحسابات بتقرا التكاليف من `expenses` — والنزول على الخزنة وحدها كان هيخلي صافي الربح يتجاهل المرتبات.

**السُلفة تُسجَّل مصروفًا وقت صرفها** (الكاش خرج ساعتها)، والدفع بالصافي. التسجيل مرتين كان هيضاعف التكلفة.

---

## ٤. سجل الـcommits الكامل (81)

<details>
<summary>اضغط للعرض</summary>

```
13876fb 2026-07-31 feat(payroll): salary profiles, monthly runs, advances, payslips
6035823 2026-07-30 feat(treasury): dashboard + totals that mean what they say
bd31e77 2026-07-30 feat(accounting): one page, four tabs, profit view
47a7361 2026-07-30 feat(accounting): treasury as single ledger + expenses + collections
0fe828c 2026-07-30 feat(confirmations): agent sets status, four only
5e62d54 2026-07-29 fix(sidebar): drop group header naming its only child
d99fadf 2026-07-29 feat(employee-dashboard): operations screen
62cfb6a 2026-07-29 feat(orders): employee filter, shipping card, status timeline
1f2b7bf 2026-07-29 design(v2): bulk-delete red from --destructive
942d2a3 2026-07-29 design(v2): mobile stat strip + type scale
bd9c347 2026-07-29 design(v2): port approved Orders redesign
ec4e099 2026-07-28 design(v2): floating surfaces, toasts, ⌘K palette
8ab3225 2026-07-28 design(v2): design language foundation from brand book
f35965c 2026-07-28 design(v2): order drawer as queue workspace
55e5a37 2026-07-28 design(v2): motion scale + table primitive
ae5eb91 2026-07-28 design(v2): V2 tokens + Orders stat cards
2af90f8 2026-07-28 fix(bosta): stop double-charging shipping in COD
04af8d5 2026-07-28 polish(orders): merge tab rows, compact chips
84bb311 2026-07-28 feat(orders): full order page + stages timeline
2f07df5 2026-07-28 feat(orders): status-tabs strip + no-answer survey
032cd70 2026-07-28 fix(orders): defaultHidden flag never applied
5337232 2026-07-28 feat(orders): per-item engraving, widened transitions
2c2acea 2026-07-28 redesign(orders): modern ERP layout — UI only
bc7fc40 2026-07-28 fix(migration): backfillLegacyTenant crash on fresh tenant
3377011 2026-07-28 tests: cover tenant isolation
9d676b6 2026-07-28 auth: enforce tenant context without fallback
3cc2921 2026-07-28 migration: prepare safe tenant backfill
b8d9774 2026-07-28 schema: tenant ownership + plan entitlements
f59d57c 2026-07-27 feat(multi-tenant): tenants/subscriptions/gateway schema
5510a7b 2026-07-27 fix(permissions): enforce role checks on employeePortal
aed7cbf 2026-07-27 chore: remove dead Manus AI leftover code
3255499 2026-07-27 feat(orders): status transition validation + confirming employee
32b37bf 2026-07-27 fix(auth): requireAdminOrManager rejects admin employee-token
75836c5 2026-07-27 polish(orders): filter-bar, action icons, page-size picker
9bc786b 2026-07-27 feat(bosta): dedicated Bosta orders view
d0ceb2c 2026-07-27 feat(orders): quick actions in drawer
36d6be5 2026-07-27 feat(orders): redesign actions column
58871b1 2026-07-27 feat(bosta): harden webhook auth, status map, AWB printing
f0e4263 2026-07-27 fix(orders): clamp long text for consistent row height
067fe1c 2026-07-27 fix(sidebar): prevent group/label overlap
9fb97a8 2026-07-27 fix(sidebar): dock sidebar right for RTL
0f38181 2026-07-27 Revert "polish(ui): premium ERP pass"
0e16954 2026-07-26 polish(ui): premium ERP pass
a2d9584 2026-07-26 feat(ui): Phase D — brand tokens all remaining pages
be6165e 2026-07-26 feat(ui): Phase C part 2 — Employees + Inventory
8a0f7e4 2026-07-26 feat(ui): Phase C part 1 — tokens + PageHeader 6 pages
f7953b3 2026-07-26 feat(ui): Phase B — Facebook Entry draft + clear
93e3cbe 2026-07-26 feat(ui): Phase B — Today Confirmations safety
acc1304 2026-07-26 feat(ui): Phase B — Orders full redesign
70fa624 2026-07-26 feat(ui): Phase A part 2 — sidebar regroup + 2 nav bugs
1fb8f50 2026-07-26 feat(ui): Phase A part 1 — tokens + shared component library
e840630 2026-07-26 docs: UI/UX audit and phased redesign plan
5408d38 2026-07-26 fix(inventory): stop flagging parent products out of stock
2589a65 2026-07-26 refactor(ui): drop Sync Now — no list endpoint exists
ded6ce0 2026-07-26 feat(easyorder): webhook-only capture + API recovery
b059815 2026-07-26 fix(easyorder): point Test Connection at documented endpoint
2862a8a 2026-07-26 feat(ui): surface needsReview on confirmation screen
82c6b23 2026-07-26 refactor(ui): Facebook entry on brand system
95d9973 2026-07-26 feat: Facebook order paste parser
dcef40c 2026-07-26 feat: legacy importer on shared matcher
090851b 2026-07-26 feat: read-only connection test for EasyOrder
156ee49 2026-07-25 feat: EasyOrder integration — pipeline, sync, review queue
b0b9635 2026-07-25 test: pin sales channel role access
52809cc 2026-07-25 fix: stop exposing sales channel tokens and secrets
e9b26f2 2026-07-25 feat: inventory UI overhaul
74012c3 2026-07-25 feat: migration for bootstrapped flat bracelet products
3c9d943 2026-07-25 feat: parent product / variant model
3158e26 2026-07-25 feat: one-time production bootstrap script
58c18aa 2026-07-25 fix: never report import as completed without verified count
ae1b1dc 2026-07-25 fix: recognize ORD-YYYY-NNNNNN and FB-NNNN numbers
03072f5 2026-07-25 feat: explicit sheet selection in XLSX importer
cddc10a 2026-07-25 feat: structured orders CSV importer
69db460 2026-07-25 docs: release and deployment instructions
697fc85 2026-07-25 feat: safe legacy orders import pipeline
f69d040 2026-07-25 feat: employee roles and permissions
f4c6f99 2026-07-25 feat: apply Matjarak brand foundation
93effa1 2026-07-24 feat: replace Manus OAuth with local authentication
e5ab177 2026-07-24 feat: rebrand application to Matjarak
616df5f 2026-07-24 feat: centralize phone normalization + duplicate detection
a4191fd 2026-07-21 chore: gitignore Claude Code local settings
a9943e3 2026-07-21 chore: initialize Git repository
```
</details>

---

## ٥. الأخطاء المُصلَحة (لمراجعة الجودة)

| Commit | الخطأ | الأثر |
|---|---|---|
| `2af90f8` | **بوسطة تحصّل الشحن مرتين** — `totalAmount + shippingFees` و`totalAmount` أصلاً شامل الشحن | 🔴 كل أوردر EasyOrder/فيسبوك كان بيتحصّل زيادة بقيمة الشحن |
| `52809cc` | تسريب `apiToken` و`webhookSecret` لقنوات البيع للعميل | 🔴 أمني |
| `32b37bf` | `requireAdminOrManager` بيرفض `admin`/`super_admin` بكوكي الموظف | 🔴 قفل صلاحيات |
| `5510a7b` | `employeePortalProcedure` بلا أي فحص دور | 🔴 أمني |
| `9d676b6` | fallback صامت لـ`tenantId = 1` | 🔴 تسريب بين التجار |
| `bc7fc40` | `backfillLegacyTenant` بينهار على tenant جديد (`insertId` غير موثوق) | 🟡 migration |
| `58c18aa` | الاستيراد بيقول "تم" بدون تحقق من عدد الصفوف | 🟡 بيانات |
| `9fb97a8` | السايدبار على اليسار في RTL ⇒ تداخل مع المحتوى | 🟡 واجهة |
| `032cd70` | `defaultHidden` مش بيتطبّق على الحالة الابتدائية | 🟢 واجهة |
| `5408d38` | المنتج الأب بيتعلّم "نفد المخزون" رغم توفر الـvariants | 🟢 مخزون |
| `0f38181` | **Revert** لـ`0e16954` — تراجع مقصود عن تغيير واجهة | — |

---

## ٦. 🔴 المشاكل المفتوحة — الأهم للمراجعة

### ٦.١ خصم المخزون يتجاهل الـvariants وبنود الأوردر — **خلل قائم في الإنتاج**

`confirmOrder` ([server/db.ts:1007](server/db.ts)) بيخصم من `orders.productId × orders.quantity` فقط. فحص الدالة: **صفر إشارة لـ`orders.variantId` أو `order_items`**.

**النتيجة الحالية على الإنتاج:**
- مخزون الـ`product_variants` **مابيتحركش أبدًا** عند البيع — أرقامه مجمّدة من آخر تعديل يدوي
- أوردر متعدد البنود بيخصم مرة واحدة من المنتج الأب

**لم يُصلَح** لأن الإصلاح بيغيّر أرقام مخزون قائمة ومحتاج قرار المالك + فحص جاف.

### ٦.٢ `products.costPrice` غير موجود ⇒ صافي الربح مبالغ فيه

`getAccountingDashboard` بيحسب تكلفة المنتجات من `product_variants.costPrice` **فقط**. منتج بلا variants تكلفته صفر ⇒ **صافي الربح المعروض أعلى من الحقيقي**.

موثّق بتعليق صريح في الكود عند موضع الحساب.

### ٦.٣ الـ8 اختبارات الفاشلة — بيئية

```
server/bosta.test.ts        5 فاشل  ← BOSTA_API_KEY غير موجود
server/orderItems.test.ts   2 فاشل  ← DATABASE_URL غير موجود
server/businesses.test.ts   1 فاشل  ← DATABASE_URL غير موجود
```

**مُثبَت أنها سابقة لشغلنا:** تشغيل الاختبارات على شجرة نظيفة (`git stash`) بيدّي نفس `8 failed | 669 passed` بالحرف.

### ٦.٤ migrations غير مُشغَّلة

| Migration | المحتوى | الحالة |
|---|---|---|
| `0032_cultured_radioactive_man.sql` | 3 جداول حسابات + 3 أعمدة على `orders` | ❌ **لم تُشغَّل** |
| `0033_funny_korg.sql` | 5 جداول رواتب | ❌ **لم تُشغَّل** |

> ⚠️ **حادثة إنتاج وقعت بسبب هذا:** المالك نشر الكود قبل تشغيل 0032. الكود طلب أعمدة غير موجودة (`orders.collectedAmount`) ⇒ **كل استعلامات الأوردرات فشلت** (18 دالة بتعمل `select()` كامل على `orders`) بينما ظلّت الإحصائيات تعمل (مشروع صريح). البيانات لم تُمس.
>
> **القاعدة:** أي commit يضيف ملفًا في `drizzle/*.sql` ⇒ **migration أولًا، ثم deploy**.

### ٦.٥ دَين تقني مقاس

| البند | العدد |
|---|---|
| صفحات لا تستخدم مكتبة التصميم المشتركة | **23 من 36** |
| جداول مكتوبة يدويًا بدل `ResponsiveDataTable` | **13** |
| ألوان Tailwind خام خارج التوكنز | **226** (أعلاها `TodayShipments.tsx` بـ54) |
| نص عربي مضمّن في الواجهة | **~1,535 سلسلة** — صفر بنية i18n |
| كلاسات اتجاه فيزيائية (`ml-*`, `right-*`) | **~130** — هتنكسر في LTR |

### ٦.٦ قيود أخرى موثّقة
- **رفع الملفات** غير متاح — مفيش خدمة تخزين. `attachmentUrl` بيقبل رابطًا فقط (varchar 500)
- **`payment_gateway_configs.credentials`** عمود `text` غير مشفّر — **محظور استخدامه** لأي بيانات حقيقية قبل تنفيذ تشفير على مستوى التطبيق (موثّق بتحذير في الـschema)
- **`warehouses`** جدول موجود و`warehouseId` على الحركات — **مهجور تمامًا، صفر استخدام**
- **لا يوجد عمود شركة شحن** — العمود في صفحة التحصيلات مشتق من حقول بوسطة
- **لا توجد Foreign Keys** في الـschema إطلاقًا — العلاقات مفروضة في الكود فقط

---

## ٧. منهجية العمل (لتقييم الالتزام)

### قواعد التزمنا بها
| القاعدة | الحالة |
|---|---|
| لا push ولا deploy بدون إذن صريح | ✅ ملتزم — 5 commits محلية حاليًا |
| لا migration على الإنتاج بدون موافقة | ✅ ملتزم |
| لا تعديل بيانات إنتاج | ✅ ملتزم |
| `pnpm check` + `build` + `test` قبل كل commit | ✅ ملتزم |
| الشرح بالعربية · الكود بالإنجليزية | ✅ |
| ملفات حسّاسة خارج Git | ✅ `.env` · `.manus/db/` (بيانات عملاء) |

### التحقق البصري
البيئة **مافيهاش قاعدة بيانات** (لا MySQL ولا Docker)، فالصفحات مش بتفتح عادةً.

الحل المستخدم: **اعتراض طبقة tRPC ببيانات وهمية** فتُرندَر الصفحات **الحقيقية** — لا نسخ معاينة. الـharness **يُحذف قبل كل commit** ومُتحقَّق من غيابه.

القياسات محسوبة برمجيًا لا بالنظر: التمرير الأفقي بمحاولة تمرير فعلية (`scrollLeft = ±9999`)، لا بقراءة CSS.

### ⚠️ ما لم يُتحقَّق منه
- **Layout Shift (CLS)** — لم يُقَس
- **الـmutations ضد قاعدة بيانات حقيقية** — الحسابات والرواتب لم تُشغَّل على DB فعلي
- **`balanceAfter` تحت تزامن حقيقي** — منطق الـtransaction مكتوب لكن غير مُختبَر تحت حمل

---

## ٨. نقاط أقترح تركيز المراجعة عليها

1. **`scopeBusinessIds` في كل procedure جديد** — أي نسيان = تسريب بين التجار، ومافيش شبكة أمان على مستوى قاعدة البيانات
2. **`addTreasuryTransaction`** ([db.ts](server/db.ts)) — صحة حساب `balanceAfter` تحت التزامن
3. **`payPayrollPeriod`** — كفاية الحواجز الثلاثة ضد الدفع المزدوج
4. **`confirmOrder`** — الخلل في ٦.١، وأثر إصلاحه على البيانات القائمة
5. **`shared/payrollCalc.ts`** — صحة الصيغ محاسبيًا وقانونيًا (قانون العمل المصري)
6. **معالجة `decimal`** — Drizzle بيرجّعه **نصًا**؛ راجع أي حساب بيتعامل معه كرقم
7. **غياب Foreign Keys** — هل مقبول أم مخاطرة سلامة بيانات
8. **`employees` كجدول مصادقة** — `tenantId` فيه `nullable-no-default` عن قصد

---

## ٩. تشغيل المشروع محليًا

```bash
corepack pnpm install
cp .env.example .env          # يحتاج DATABASE_URL و JWT_SECRET
corepack pnpm drizzle-kit migrate
corepack pnpm dev             # http://localhost:3000
```

```bash
corepack pnpm check           # tsc --noEmit
corepack pnpm build
corepack pnpm test
```

> **لا تشغّل `drizzle-kit migrate` على الإنتاج بدون إذن المالك.**
> `drizzle-kit generate` آمن محليًا (بيقارن الـschema فقط) — بيحتاج `DATABASE_URL` كمتغيّر شكلي.

---

## ١٠. خريطة الملفات

```
server/
  db.ts              3,790 سطرًا   ← كل الوصول لقاعدة البيانات (كبير — مرشّح للتقسيم)
  routers.ts         3,366 سطرًا   ← كل الـtRPC (كبير — مرشّح للتقسيم)
  permissions.ts        90 سطرًا   ← جدول الأدوار/الصلاحيات
  bosta.service.ts · easyorder.service.ts · productMatching.ts
  _core/context.ts               ← بناء الـcontext والـtenant

shared/                          ← كود مشترك بين الطرفين
  payrollCalc.ts       269 سطرًا  ← محرّك الرواتب (نقي، 43 اختبارًا)
  facebookOrderParser.ts · phone.ts · const.ts

drizzle/
  schema.ts            998 سطرًا  ← 37 جدولًا
  00xx_*.sql            35 ملفًا

client/src/
  pages/                36 صفحة
  components/shared/               ← مكتبة التصميم (19 مكوّنًا)
  lib/                             ← money · printExpenses · printPayslip · whatsapp
```

---

## ١١. خلاصة الحالة

| البند | الحالة |
|---|---|
| commits محلية غير مدفوعة | **5** (`0fe828c` · `47a7361` · `bd31e77` · `6035823` · `13876fb`) |
| migrations غير مُشغَّلة | **2** (0032 · 0033) |
| الإنتاج | يعمل على آخر كود مدفوع (قبل الحسابات والرواتب) |
| `check` / `build` | ✅ نظيفان |
| `test` | 669 ✅ / 8 ❌ (بيئية موروثة) |

**الخطوة التالية المطلوبة قبل أي نشر:**
```
١. تشغيل migration 0032 ثم 0033 على الإنتاج
٢. دفع الـ5 commits
٣. نشر
```

---

*هذا الملف مُولَّد من المستودع الفعلي — كل رقم فيه مقيس لا مُقدَّر.*
