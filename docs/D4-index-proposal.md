# D4 — Query / Index Map + Migration Proposal (اقتراح فقط — مفيش تنفيذ)

**الحالة:** اقتراح للمراجعة. **ممنوع تشغيل أي migration قبل موافقة صريحة.**
**السياق:** الجداول الأساسية القديمة (orders, order_items, treasury_transactions, expenses,
products, product_variants, inventory_movements, employees, payroll_items) **مفيهاش أي index
غير الـPK**. كل استعلام مفلتر بـ`businessId`/`status`/`createdAt` = Full Table Scan + filesort.
مع الحجم المستهدف (10 شركات، 100k أوردر، 1M حدث) ده أهم capacity blocker.

الجداول الأحدث (business_events, financial_*, shipments, inventory_balances, ad_spend,
accounting_closings) **متفهرسة أصلاً** — خارج النطاق هنا.

## Index Map

| # | Table | Columns (بالترتيب) | الاستعلام المستفيد | index مشابه موجود؟ | تأثير متوقّع | خطر التطبيق | Rollback |
|---|-------|--------------------|--------------------|--------------------|--------------|-------------|----------|
| 1 | `orders` | `(businessId, status, createdAt)` | قوايم الأوردرات + الداشبورد: فلتر business+status وترتيب/مدى createdAt | لأ | عالي جدًا | بناء index على جدول كبير = قفل/وقت | `DROP INDEX` |
| 2 | `orders` | `(businessId, assignedEmployeeId)` | «طلبات موظف» + التوزيع | لأ | عالي | نفسه | `DROP INDEX` |
| 3 | `orders` | `(externalOrderId)` | dedup الاستيراد/الويبهوك | لأ | متوسط | خفيف (عمود قصير) | `DROP INDEX` |
| 4 | `orders` | `(customerPhone)` | كشف التكرار بالتليفون | لأ | متوسط | خفيف | `DROP INDEX` |
| 5 | `order_items` | `(orderId)` | JOIN في كل مكان (تفاصيل الأوردر، الفواتير، الأرباح) | لأ | عالي جدًا | متوسط | `DROP INDEX` |
| 6 | `treasury_transactions` | `(businessId, transactionDate)` | سجل الخزنة + التقارير + المصالحة | لأ | عالي | متوسط | `DROP INDEX` |
| 7 | `treasury_transactions` | `(businessId, type, direction)` | تجميعات ControlCenter (تحصيل/مصروف) | لأ | متوسط | متوسط | `DROP INDEX` |
| 8 | `expenses` | `(businessId, expenseDate)` | لوحة المصروفات + التقارير | لأ | متوسط | خفيف | `DROP INDEX` |
| 9 | `inventory_movements` | `(productId, variantId)` | حركات المخزون + المصالحة | لأ | عالي | متوسط | `DROP INDEX` |
| 10 | `products` | `(businessId)` | قوايم/مطابقة المنتجات | لأ | متوسط | خفيف | `DROP INDEX` |
| 11 | `product_variants` | `(productId)` | variant→product في كل مكان | لأ | عالي | خفيف | `DROP INDEX` |
| 12 | `employees` | `(businessId)` | قوايم الموظفين المعزولة | لأ | متوسط | خفيف | `DROP INDEX` |
| 13 | `payroll_items` | `(periodId)` | بنود دورة المرتبات + الربح | لأ | متوسط | خفيف | `DROP INDEX` |

**الأولوية:** #1, #5, #11, #6, #9 (الأعلى أثرًا) → ثم الباقي. أقل set يغطّي الأشكال الحرجة.

## SQL المقترح (للمراجعة — مش هيتشغّل)

```sql
CREATE INDEX orders_biz_status_created_idx      ON orders (businessId, status, createdAt);
CREATE INDEX orders_biz_assignee_idx            ON orders (businessId, assignedEmployeeId);
CREATE INDEX orders_external_id_idx             ON orders (externalOrderId);
CREATE INDEX orders_customer_phone_idx          ON orders (customerPhone);
CREATE INDEX order_items_order_idx              ON order_items (orderId);
CREATE INDEX treasury_biz_date_idx             ON treasury_transactions (businessId, transactionDate);
CREATE INDEX treasury_biz_type_dir_idx         ON treasury_transactions (businessId, type, direction);
CREATE INDEX expenses_biz_date_idx             ON expenses (businessId, expenseDate);
CREATE INDEX inv_moves_product_variant_idx     ON inventory_movements (productId, variantId);
CREATE INDEX products_biz_idx                  ON products (businessId);
CREATE INDEX product_variants_product_idx      ON product_variants (productId);
CREATE INDEX employees_biz_idx                 ON employees (businessId);
CREATE INDEX payroll_items_period_idx          ON payroll_items (periodId);
```

## خطر التطبيق و Rollout Plan

- **القفل/الوقت:** MySQL 8 / InnoDB بيعمل أغلب الـindexes بـ**Online DDL** (INPLACE) — القراءة والكتابة بتفضل شغّالة، بس بياخد وقت على الجداول الكبيرة. الأفضل تشغيلها **في وقت هادئ** وواحد-واحد.
- **الحجم الحالي صغير** (شركة واحدة) — التطبيق دلوقتي شبه فوري وأأمن وقت. كل ما أجّلنا كل ما بقى أبطأ.
- **مفيش تغيير schema منطقي** — indexes بس، مفيش أعمدة/جداول جديدة، فمفيش خطر على البيانات.
- **Rollback:** `DROP INDEX <name> ON <table>;` لكل واحد — فوري وآمن.
- **التطبيق المقترح:** migration drizzle واحد (`drizzle-kit generate` بعد إضافة الـindexes للـschema) ثم `drizzle-kit migrate` — **بعد موافقتك وباك أب**، ويفضّل في نافذة صيانة.

## STOP
مفيش أي migration اتعمل. محتاج موافقتك على: (أ) القايمة دي كلها ولا الأولوية بس، (ب)
توقيت التطبيق (نافذة صيانة؟)، (ج) هل نضيفها للـschema ونعمل migration رسمي ولا SQL يدوي.
