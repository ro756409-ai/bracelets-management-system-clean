# D6 — Foreign Keys Rollout Plan (خطة فقط — مشروطة بنتيجة D5)

**الحالة:** خطة للمراجعة. **ممنوع إنشاء أي FK قبل تشغيل D5 على البيانات الفعلية والموافقة.**
**المبدأ:** مفيش FK قبل ما نتأكد إن العلاقة **نظيفة (صفر ORPHAN/WRONG_PARENT)**. لو فيه
حتى صف يتيم واحد، MySQL هيرفض إنشاء الـFK — فالتنظيف بيسبق، وهو خطة منفصلة معتمدة.

**الخلفية:** الـschema كله (69 جدول) **مفيهوش أي Foreign Key** — مفيش سلامة مرجعية على
مستوى الداتابيز. الهدف نضيفها **تدريجيًا** على العلاقات النظيفة الأول، مش دفعة واحدة.

## الخطوة الإلزامية أولًا
```
corepack pnpm tsx scripts/auditIntegrity.ts
```
يطلّع ORPHAN/WRONG_PARENT لكل علاقة. **الأرقام دي هي اللي بتقرّر أنهي FK ينفع دلوقتي.**

## Rollout مقترح (بالترتيب — الأنظف والأعلى قيمة الأول)

| مرحلة | FK (child.col → parent) | onDelete | onUpdate | شرط الإنشاء | خطر |
|-------|--------------------------|----------|----------|-------------|-----|
| 1 | `product_variants.productId → products.id` | `CASCADE` | `CASCADE` | ORPHAN=0 من D5 | منخفض (علاقة أساسية نظيفة غالبًا) |
| 2 | `order_items.orderId → orders.id` | `CASCADE` | `CASCADE` | ORPHAN=0 | منخفض/متوسط (جدول كبير) |
| 3 | `payroll_items.periodId → payroll_periods.id` | `CASCADE` | `CASCADE` | ORPHAN=0 | منخفض |
| 4 | `order_items.productId → products.id` | `SET NULL` | `CASCADE` | ORPHAN=0 (المرجع اختياري) | متوسط |
| 5 | `order_items.variantId → product_variants.id` | `SET NULL` | `CASCADE` | ORPHAN=0 | متوسط |
| 6 | `inventory_movements.productId → products.id` | `RESTRICT` | `CASCADE` | ORPHAN=0 | متوسط (ledger — مانمسحش) |
| 7 | `payroll_items.employeeId → employees.id` | `RESTRICT` | `CASCADE` | ORPHAN=0 + businessId متسق | متوسط |

**اختيار onDelete:** `CASCADE` للعلاقات الملكية الصريحة (نوع بلا منتجه مالوش معنى)؛
`SET NULL` للمراجع الاختيارية؛ `RESTRICT` للـledgers (حركة مخزون/مرتب مايتمسحش لمجرد
مسح الأب). كلها `onUpdate CASCADE` عشان تغيير id (نادر) مايكسرش.

## القواعد
- **علاقة واحدة كل مرة** — أضِف FK، اتأكد، بعدين اللي بعده. مش دفعة.
- **لو ORPHAN > 0** لأي علاقة → توقف، اعرض خطة تنظيف منفصلة (تصنيف الصفوف اليتيمة
  SAFE/AMBIGUOUS)، خُد موافقة + باك أب، نظّف، بعدين أنشئ الـFK.
- **WRONG_PARENT** (businessId متعارض) → مايتحلّش بـFK؛ ده بيتحل في تنظيف البيانات
  (نفس منطق الـtenant backfill).
- **الـFK مش بديل عن العزل** — عزل الـtenant وشروط الأعمال بيفضلوا في الكود؛ الـFK
  بيحمي السلامة المرجعية بس.

## Rollback
كل FK: `ALTER TABLE <child> DROP FOREIGN KEY <name>;` — فوري وآمن.

## STOP
محتاج: (أ) تشغيل D5 وإرسالي الأرقام، (ب) قرارك على الترتيب وقيم onDelete، (ج) موافقة
على إن الإنشاء migration منفصل بعد الباك أب. مفيش أي FK هيتعمل قبل كده.
