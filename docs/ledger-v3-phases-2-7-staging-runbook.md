# Runbook — مراحل الدفتر 2–7 على Staging (Migrations ‏0045–0051 وخطة الرجوع)

> **غير مصرّح بتنفيذه حاليًا.** الموافقة الحالية محلية فقط: لا Push، لا Deploy، لا تطبيق Migrations ولا تفعيل
> Ledger على Staging أو Production. هذا الدليل جاهز لقرار لاحق منفصل.

نفس قواعد `docs/ledger-v3-staging-runbook.md`: الأوامر تُلصق في **Terminal حاوية تطبيق Staging** (المجلد `/app`)،
`DATABASE_URL` و`DEPLOY_ENV` من Environment Variables فقط، لا SQL يدوي، وكل سكربت يرفض الهدف الذي يبدو إنتاجًا.
`<db>` في عبارات التأكيد = اسم قاعدة Staging كما يطبعه أمر `--check` (السطر الأول: `الهدف: <host> / <db>`).

## 0) نشر الكود أولًا — السكربتات الجديدة لا توجد قبل النشر

1. Deploy لنفس الـcommit المعتمد على تطبيق Staging (الصورة تُبنى بـ`pnpm build` فتنتج `dist/scripts/*.mjs`).
   **العلم `LEDGER_V3` يبقى مطفأ**، و`ACCOUNTING_MODULE_ENABLED` كما هو. الكود الجديد بلا جداوله الجديدة يعمل بالسلوك
   القديم (كل مسار يتحقق من وجود جداوله ويعرض «غير متاح قبل 00NN»).
2. تحقق من وجود السكربتات داخل الحاوية:

```bash
ls dist/scripts | grep -E "^(migrate-004[5-9]|migrate-005[01]|check-ledger-prereqs|legacy-recovery|disable-ledger-v3)" ; ls drizzle | grep -E "^00(4[5-9]|5[01])_"
```

المتوقع: `migrate-0045-roles.mjs` … `migrate-0051-ledger-legacy-archive.mjs`، `check-ledger-prereqs.mjs`،
`legacy-recovery.mjs`، `disable-ledger-v3.mjs`؛ وملفات SQL ‏0045–0051 (السكربت يقرؤها من `drizzle/`). **نقطة توقف**: أي ملف ناقص =
الصورة ليست من هذا الـcommit.

3. `node -e "console.log({DEPLOY_ENV: process.env.DEPLOY_ENV})"` يجب أن يطبع `staging`.

## 1) Backup

نسخة كاملة لقاعدة Staging قبل أي DDL، واحفظ اسمها ووقتها. لا متابعة بلا نسخة مؤكدة.

## 2) فحص المتطلبات (قراءة فقط) — قبل أي Migration

```bash
node dist/scripts/check-ledger-prereqs.mjs
```

اقرأ المخرجات في قسمين **منفصلين**:

| القسم | الشكل | المعنى | القرار |
|---|---|---|---|
| جداول التشغيل المطلوبة (`[الطلبات]`، `[المخزون]`، `[الشحن]`، `[المرتبات]`، `[الحضور (0042)]`…) | `✗ … — الجدول غير موجود` أو `أعمدة ناقصة` | جدول **قائم** تعتمد عليه مسارات الدفتر غير موجود في القاعدة | **نقطة توقف** — رمز الخروج 1. لا تطبّق أي Migration؛ هذه جداول لا تنشئها Migrations الدفتر |
| `أرشيف V1/V2` | `غير موجود (اختياري)` | الكود يتجاهل الجدول الغائب | للعلم فقط |
| `0045` / `0046` (قيم enum) | `· … — غير مطبّقة` | متوقع قبل التطبيق | تُطبَّق في الخطوة 3 |
| `0040`، `0047`–`0051` | `absent` | **جداول جديدة متوقع غيابها** قبل تطبيق Migrations | تُطبَّق في الخطوة 3 |
| أي marker | `partial` | جزء من جداول Migration موجود | **نقطة توقف** — راجع قبل أي apply |

رمز الخروج: 0 = المتطلبات القائمة كاملة (غياب جداول 0047–0051 لا يغيّره)، 1 = جدول/عمود تشغيل مطلوب ناقص، 2 = خطأ
تشغيل، 3 = هدف يبدو إنتاجًا.

حالة 0040 على Staging مسجّلة لدي **كآخر معلوم** فقط («طُبّقت وتحققت، الدفتر معطّل» حسب المالك بتاريخ 2026-10-12) — يؤكدها
هذا الفحص (`0040 … present`) أو `node scripts/migrate-0040-ledger-v3.cjs --check` قبل الاعتماد عليها.

## 3) Migrations بالترتيب — لكل واحدة: check → apply → check → replay

الترتيب إلزامي: **0045 → 0046 → 0047 → 0048 → 0049 → 0050 → 0051** (0046–0051 تتطلب 0040، و0047–0051 تتطلب
الفهرسين المركّبين من 0040/0041 — يفحصهما preflight).

لكل `<id>` و`<script>` من الجدول:

| id | script |
|---|---|
| 0045 | `migrate-0045-roles` |
| 0046 | `migrate-0046-ledger-kinds` |
| 0047 | `migrate-0047-ledger-carrier` |
| 0048 | `migrate-0048-ledger-payroll` |
| 0049 | `migrate-0049-ledger-suppliers` |
| 0050 | `migrate-0050-ledger-snapshots` |
| 0051 | `migrate-0051-ledger-legacy-archive` |

```bash
node dist/scripts/<script>.mjs
```
المتوقع: `حالة <id>: غير مطبَّقة`، وكل أسطر preflight ✓ (لـ0047–0051). **توقف** إن كانت «جزئية» أو أي preflight ✗.

```bash
node dist/scripts/<script>.mjs --apply --confirm "APPLY <id> TO <db>"
```
المتوقع: رمز الخروج 0 وسطر نجاح ✓ (لـ0047–0051: كل عبارة `✓ … نُفِّذ وتحقّق` ثم `✓ <id> مطبَّقة ومطابقة للمواصفة بالكامل`).

التحقق بعد التطبيق (قراءة فقط):
```bash
node dist/scripts/<script>.mjs
```
المتوقع: `حالة <id>: مطبَّقة` بلا أي سطر فرق (✗).

إعادة التطبيق (replay — يجب ألا يغيّر شيئًا):
```bash
node dist/scripts/<script>.mjs --apply --confirm "APPLY <id> TO <db>"
```
المتوقع: `↻ مطبَّقة مسبقًا — replay بلا أي تغيير`، رمز الخروج 0.

**نقاط توقف**: رمز خروج 3 (رفض: بيئة/عبارة/partial/preflight) أو 1 (فشل عبارة) — لا تنتقل للتالية. فشل عبارة يترك
`partial` ظاهرًا (DDL في MySQL غير معاملاتي)؛ لا إكمال يدوي — ارجع للنسخة أو rollback الموثّق.

بعد 0051:
```bash
node dist/scripts/check-ledger-prereqs.mjs
```
المتوقع: المتطلبات كاملة، `0045`/`0046` ✓، وكل markers `0040`،`0047`–`0051` = `present`.

### التراجع (rollback) — قبل وجود بيانات فقط
`--rollback --confirm "ROLLBACK <id> TO <db>"` بترتيب عكسي (0051 أولًا). يُرفض تلقائيًا (`not_empty` /
`kind_in_use` / دور مستخدم) متى وُجدت بيانات — **0051 يُرفض مع أي حدث** في سجل الأرشيف. بعد وجود بيانات: إطفاء العلم فقط.

## 4) تجربة الأدوار (معلّقة حتى تنفيذها)

دخول فعلي بحساب **المحاسب** و**مدير الحسابات** على Staging بعد 0045 والتحقق من الصفحات المسموحة/الممنوعة. لم تُنفَّذ بعد.

## 5) خطة الرجوع «توقف ومطابقة» (بعد 0051 — طريقة واحدة: إدخال أرصدة التوقف)

لا إعادة حركات V3 في V1/V2؛ تُدخل أرصدة لحظة التوقف **كفروق فوق أرصدة V1/V2 القائمة** (لا تضاعف، لا حذف تاريخ).

1. إطفاء V3 (لا يرفع حظر الكتابات القديمة):
   `node dist/scripts/disable-ledger-v3.mjs --tenant <t> --actor <ownerId> --reason "<سبب>" --apply --confirm "DISABLE LEDGER V3 TENANT <t>"`
2. إيقاف الشركة من لوحة المنصة (`tenants.status = suspended`)، و`TENANT_ACCESS_ENFORCEMENT_ENABLED=true` في بيئة التطبيق
   (السكربت يرفض بدونهما).
3. صورة التوقف — dry-run ثم apply:
   ```bash
   node dist/scripts/legacy-recovery.mjs snapshot --tenant <t> --actor <ownerId> --reason "<سبب>"
   node dist/scripts/legacy-recovery.mjs snapshot --tenant <t> --actor <ownerId> --reason "<سبب>" --apply --confirm "SNAPSHOT LEGACY TENANT <t> ON <db>"
   ```
   يطبع رصيد كل حساب V3 والبصمة ورقم الصورة.
4. ملف الخطة `plan.json` (يُعدّ ويُراجع مع المالك):
   ```json
   { "snapshotEventId": 0, "figuresHash": "<64 hex>",
     "cash": [{ "code": "OFFICE_CASH", "target": { "kind": "v1_treasury", "businessId": 0 } },
              { "code": "BANK_MAIN", "target": { "kind": "v2_account", "accountId": 0 } }],
     "acknowledgedNonCash": ["<كل حساب غير نقدي برصيد غير صفري>"],
     "zeroTargets": [{ "kind": "v2_account", "accountId": 0 }] }
   ```
   كل حساب نقدي/بنكي/محفظة برصيد ← هدف واحد؛ كل حساب آخر برصيد يُذكر في `acknowledgedNonCash` (يُتابَع خارج V1/V2)؛
   كل خزنة/حساب قديم نقدي برصيد خارج الخريطة يُذكر في `zeroTargets`. الهدف لا يتكرر؛ خزنة V1 بمنزلتين فقط.
5. الاستعادة — dry-run (يطبع قبل/بعد/الفرق لكل هدف) ثم apply:
   ```bash
   node dist/scripts/legacy-recovery.mjs recover --tenant <t> --actor <ownerId> --reason "<سبب>" --plan plan.json
   node dist/scripts/legacy-recovery.mjs recover --tenant <t> --actor <ownerId> --reason "<سبب>" --plan plan.json --apply --confirm "RECOVER LEGACY TENANT <t> ON <db>"
   ```
   transaction واحدة: الرفع + الفروق + إعادة القراءة والمطابقة + حدث الاستعادة. أي اختلاف ⇒ إلغاء كامل (الحظر قائم، الشركة متوقفة).
   تكرار الأمر = replay بلا كتابة.
6. بعد النجاح فقط: مدير المنصة يرفع الإيقاف. إعادة تفعيل V3 لاحقًا تعيد الحظر تلقائيًا داخل معاملة التفعيل.

## ما لا يفعله هذا الدليل
لا تفعيل Ledger، لا Production، لا إجراء «احتفاظ بمستحق العميل» (معطّل)، لا SQL يدوي.
