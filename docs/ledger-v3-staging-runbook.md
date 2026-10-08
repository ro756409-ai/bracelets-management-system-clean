# Runbook — تشغيل Ledger V3 على Staging

هذا الدليل لبيئة **Staging فقط**. لا تُنفَّذ أي خطوة منه على Production إلا بقرار صريح مستقل.
كل الأوامر تُنسخ وتُلصق حرفيًا في **Terminal تطبيق Staging في Coolify** (داخل حاوية التطبيق، المجلد
`/app`). لا تكتب `DATABASE_URL` ولا `JWT_SECRET` في أي أمر: تُقرأ تلقائيًا من Environment Variables
الخاصة بالتطبيق. لا تنفّذ SQL يدويًا؛ كل شيء عبر السكربتات.

كل السكربتات تطبع المضيف واسم القاعدة فقط، ولا تطبع الرابط ولا كلمة السر، وتتوقف على قاعدة تبدو
إنتاجًا.

## 0) قبل البدء — اختبار توفر الأدوات داخل الحاوية

```bash
node -v && ls dist/scripts && node -e "require('mysql2/promise');require('drizzle-orm');require('jsonwebtoken');console.log('deps ok')"
```

المتوقع: إصدار node، وخمسة ملفات `*.mjs` (`activate-ledger-v3`, `disable-ledger-v3`,
`migrate-0040-ledger-v3`, `verify-ledger-v3`, `verify-ledger-v3-runtime`)، ثم `deps ok`.
نقطة توقف: أي ملف ناقص أو خطأ `Cannot find module` = الصورة لم تُبنَ من هذا الـcommit؛ أعد الـRedeploy
ولا تتابع. الأدوات تعمل بـ`node` العادي (لا تحتاج tsx ولا pnpm).

ثم تأكد من بيئة Staging:

```bash
node -e "console.log({DEPLOY_ENV: process.env.DEPLOY_ENV, hasDb: Boolean(process.env.DATABASE_URL), hasJwt: Boolean(process.env.JWT_SECRET)})"
```

المتوقع: `DEPLOY_ENV: 'staging'`, `hasDb: true`, `hasJwt: true`. غير ذلك = توقف وأصلح Environment
Variables في Coolify أولًا (سكربت الترحيلة يرفض التطبيق بدون `DEPLOY_ENV=staging`).

## 1) معرفة tenantId وemployeeId (قراءة فقط)

```bash
node -e "const m=require('mysql2/promise');(async()=>{const c=await m.createConnection(process.env.DATABASE_URL);await c.query('SET SESSION TRANSACTION READ ONLY');const [t]=await c.query('SELECT id, name, status FROM tenants ORDER BY id');console.table(t);const [b]=await c.query('SELECT id, tenantId, name, isActive FROM businesses ORDER BY tenantId, id');console.table(b);const [e]=await c.query(\"SELECT id, tenantId, name, role FROM employees WHERE isActive = 1 AND role IN ('super_admin','accountant') ORDER BY tenantId, id\");console.table(e);await c.end();})().catch(e=>{console.error(e.message);process.exit(1)})"
```

من الجداول: `<tenantId>` = عمود `id` في جدول الشركات، `<employeeId>` = `id` موظف دوره `super_admin`
في نفس الشركة (هو الفاعل والمعتمِد). لاحظ الأنشطة الفعّالة (`isActive = 1`): **كلها** تدخل خطة
التفعيل.

## 2) Backup

نسخة احتياطية كاملة لقاعدة Staging من لوحة Coolify (أو `mysqldump` من خدمة القاعدة) قبل أي DDL.
احفظ اسم النسخة ووقتها. نقطة توقف: لا تتابع بلا نسخة مؤكدة.

## 3) Preflight قبل الترحيلة (قراءة فقط)

```bash
node dist/scripts/verify-ledger-v3.mjs --preflight
```

يجب أن تكون كل الأسطر ✓. أي ✗ = توقف وراجع.

## 4) الترحيلة 0040 — check ثم apply ثم check

```bash
node scripts/migrate-0040-ledger-v3.cjs --check
```

المتوقع قبل التطبيق: `حالة 0040: غير مطبَّقة` والعبارات التسع ✗ ناقصة. (الحالة «جزئية» = توقف فورًا؛
انظر «نقاط التوقف».)

```bash
node scripts/migrate-0040-ledger-v3.cjs --apply --confirm "APPLY LEDGER V3 0040 TO <database>"
```

استبدل `<database>` باسم القاعدة كما يطبعه سطر `الهدف:` في أمر `--check` (مثل `matjarak_staging`).
السكربت ينفّذ العبارات التسع بالترتيب داخليًا ويتحقق بعد كل واحدة، ويرفض التطبيق إن لم يكن
`DEPLOY_ENV=staging` أو بدا الهدف إنتاجًا أو لم يدل اسم القاعدة على Staging (يحوي `staging` أو
`stage` أو `test`). المتوقع في النهاية: `✓ 0040 مطبَّقة · ✓ مطابق بالكامل لمواصفة ledgerV3Spec`.
إعادة التشغيل بعد النجاح تطبع `replay آمن بلا أي تغيير`.

```bash
node scripts/migrate-0040-ledger-v3.cjs --check
```

المتوقع: `حالة 0040: مطبَّقة`، العبارات التسع ✓، و«مطابق بالكامل». لا تتابع بغير ذلك.

## 5) dry-run التفعيل (قراءة فقط — الوضع الافتراضي)

بلا ملف أرصدة (تفعيل صفري — كل الأرصدة الافتتاحية صفر):

```bash
node dist/scripts/activate-ledger-v3.mjs --tenant <tenantId> --go-live <YYYY-MM-DD> --actor <employeeId>
```

أو بملف أرصدة افتتاحية: انسخ `docs/ledger-v3-opening.example.json` إلى `/app/opening.json` وعدّله
(المبالغ نصوص عشرية مثل `"1000.50"`؛ احذف `businessIds` لتُدرج كل الأنشطة الفعّالة تلقائيًا)، ثم:

```bash
node dist/scripts/activate-ledger-v3.mjs --tenant <tenantId> --opening-file opening.json --actor <employeeId>
```

## 6) مراجعة التقرير

التقرير يعرض: الشركة، الأنشطة، حالة 0040، العلم، مطابقة V2 لكل نشاط، الحسابات التسعة، الأرصدة
الافتتاحية المقترحة (من الملف أو صفر — لا تخمين ولا نسخ من V2)، القيد الافتتاحي، الاعتماد، جدول
تغطية الأنشطة، والموانع. **لا تتابع إلا بسطر «✓ جاهز للتفعيل — كل الأنشطة الفعّالة مغطّاة ولا موانع».**

**التفعيل على مستوى الشركة كلها (Tenant-wide):** العلم في `ledger_tenant_flags` يفعّل الدفتر للشركة
بأكملها، ولا يوجد علم لكل نشاط. لذلك تشمل خطة التفعيل **كل نشاط فعّال**، وبما أن خزن الشركة مشتركة
بين البراندات يربط التفعيل كل نشاط فعّال **بالحسابات الأساسية التسعة كلها** (خزنة المكتب، البنك،
مستحقات بوسطة، فودافون كاش، إنستا باي، إيرادات المبيعات، مصروفات عامة، الرصيد الافتتاحي، حساب
معلّق) — القائمة المشتركة نفسها التي يستخدمها التفعيل والـruntime verify. لو استبعد الملف نشاطًا
فعّالًا يُرفض التفعيل: «لا يمكن تفعيل دفتر الشركة: النشاط [الاسم (#ID)] غير موجود في خطة التفعيل».
المستبعد الوحيد المسموح هو النشاط غير النشط («مستبعد — غير نشط»). نشاط فعّال يُضاف بعد إعداد الملف
وقبل التطبيق يُكتشف تحت القفل ويُرفض بلا كتابة.

- فروق في مطابقة V2 توقف التفعيل حتى تُراجع، ثم تُقرّ صراحةً في الملف
  (`reconciliation.acknowledgedDifferences: true`) مع بيانات الاعتماد.
- `--actor` و`approvedByEmployeeId` يجب أن يكونا مالكًا (`super_admin`) فعّالًا في الشركة نفسها؛ لا يغني
  عن ذلك أي منح في `tenant_role_permissions`.

## 7) التفعيل الفعلي (--apply بعبارة التأكيد)

العبارة تُطبع في نهاية التقرير وتتضمن معرّف الشركة وتاريخ Go-Live حرفيًا:

```bash
node dist/scripts/activate-ledger-v3.mjs --tenant <tenantId> --opening-file opening.json --actor <employeeId> --apply --confirm "ACTIVATE LEDGER V3 TENANT <tenantId> GO-LIVE <YYYY-MM-DD>"
```

(بلا ملف: استبدل `--opening-file opening.json` بـ`--go-live <YYYY-MM-DD>`.) يُنشئ في **معاملة واحدة**:
الحسابات التسعة، الربط، القيد الافتتاحي الواحد المتوازن (أو لا شيء عند الصفر)، ثم العلم. المتوقع:
`✓ تم التفعيل (معاملة واحدة)` و`صفوف V2 قبل/بعد: بلا تغيير ✓`. إعادة التشغيل بنفس التاريخ = `replay` آمن.

## 8) Smoke test بعد التفعيل (قراءة فقط)

```bash
node dist/scripts/verify-ledger-v3-runtime.mjs --tenant <tenantId>
```

كل الفحوص الثمانية يجب أن تكون ✓ وينتهي بـ`✓ الدفتر سليم تشغيليًا`: العلم، الحسابات التسعة مرة
واحدة، كل نشاط فعّال مربوط بالتسعة ولا ربط لشركة أخرى، `openingTransactionId` (أو NULL عند الصفر)،
مطابقة V3 صفر فروق، لا كتابة في V2 في نافذة التفعيل، واستجابة routers القراءة للمالك والمحاسب حسب
المنح (وإعادة فتح الشهر مرفوضة للمحاسب دائمًا).

## 9) اختبار الواجهة

بحساب المالك على Staging من «الحسابات» (`/ledger`):

1. **تسجيل إيراد** 10 ج.م إلى «خزنة المكتب» (نوع: إيرادات المبيعات) — الرصيد يرتفع 10 فورًا.
2. **تسجيل مصروف** 5 ج.م من «خزنة المكتب» (تصنيف: مصروفات عامة) — الرصيد ينخفض 5.
3. **تحويل** 2 ج.م من «خزنة المكتب» إلى «فودافون كاش» — خزنة −2، فودافون +2.
4. من «سجل الحركات»: **عكس المصروف** بسبب واضح — الرصيد يعود +5، الأصل «معكوسة بـ #…» والعكس
   «يعكس #…»، ولا زر عكس على أيٍّ منهما بعدها.

اضغط «حفظ» مرتين سريعًا: حركة واحدة فقط. بحساب المحاسب (الممنوح `ledger.view` و`ledger.post` فقط):
يرى الأرصدة ويسجّل ولا يرى زر العكس. ثم أعد الخطوة 8.

## 10) Rollback قبل وجود أي حركة فعلية

إذا لم تُسجَّل أي حركة بعد التفعيل (سجل الحركات يحوي القيد الافتتاحي فقط أو لا شيء): استعادة النسخة
الاحتياطية من الخطوة 2 كاملةً (تعيد القاعدة لما قبل 0040)، **أو** إبقاء 0040 وتعطيل العلم فقط (الخطوة
11) لإعادة المحاولة لاحقًا. لا تُحذف الجداول يدويًا بينما يعمل التطبيق على نفس القاعدة.

## 11) بعد وجود حركات فعلية: تعطيل العلم فقط

لا حذف جداول ولا صفوف. dry-run أولًا (لا تغيير):

```bash
node scripts/disable-ledger-v3.cjs --tenant <tenantId> --actor <employeeId> --reason "<السبب>"
```

ثم التعطيل الفعلي بعبارة التأكيد:

```bash
node scripts/disable-ledger-v3.cjs --tenant <tenantId> --actor <employeeId> --reason "<السبب>" --apply --confirm "DISABLE LEDGER V3 TENANT <tenantId>"
```

يعطّل العلم فقط عبر `disableLedgerV3` ويسجّل الفاعل والسبب والتوقيت؛ يرفض غير المالك وأي شركة أخرى؛
معطّل مسبقًا = `replay` بلا تغيير. القراءة تبقى، والحركات محفوظة (الدفتر غير قابل للتعديل: التصحيح
بعكس الحركة فقط).

## نقاط التوقف

- أي ✗ في preflight أو `--check` أو runtime verify.
- `حالة 0040: ⚠️ جزئية` في `--check`: السكربت لا يكمل تلقائيًا ويعرض العبارات المنفَّذة والناقصة.
  القرار: استعادة النسخة الاحتياطية (الأنظف) أو مراجعة الناقص مع المسؤول التقني — لا إعادة تشغيل عمياء.
- `✗ مرفوض قبل أي DDL` من سكربت الترحيلة: راجع `DEPLOY_ENV` واسم القاعدة وعبارة التأكيد.
- أي مانع في dry-run، أو غياب سطر «جاهز للتفعيل».
- `صفوف V2 قبل/بعد` غير «بلا تغيير».
- تحذير «يبدو إنتاجًا» من أي سكربت: توقف وتأكد من البيئة.
- ظهور «يرجى تسجيل الدخول» للمحاسب على `/ledger`، أو غياب وجهة «الحسابات» للمالك: راجع نشر الواجهة.

## ما لا يفعله هذا الـRunbook

- لا يُنفَّذ على Production. لا Push ولا Deploy منه. لا `drizzle-kit push`/`generate` أبدًا على Staging
  بعد 0040 (مخطط drizzle-kit لا يعرف جداول `ledger_*`).
- لا يربط Bosta أو EasyOrder أو المصروفات أو الرواتب بالدفتر الجديد — مراحل لاحقة بقرار مستقل.
- لا يفك تجميد شاشات الحسابات القديمة.
