-- Migration: إعادة ترقيم الأوردرات + إضافة حالة no_answer
-- 1. تعديل عمود orderNumber ليكون varchar(20) (كان varchar(20) بالفعل)
-- 2. إعادة ترقيم الأوردرات الموجودة بالترتيب الزمني من 1
-- 3. إضافة حالة no_answer للـ status enum

-- Step 1: إضافة عمود مؤقت للترقيم
ALTER TABLE orders ADD COLUMN seq_num INT;

-- Step 2: تعيين الأرقام المتسلسلة بالترتيب الزمني (id ASC كـ tiebreaker)
SET @row_num = 0;
UPDATE orders o
JOIN (
  SELECT id, (@row_num := @row_num + 1) AS rn
  FROM orders
  ORDER BY createdAt ASC, id ASC
) ranked ON o.id = ranked.id
SET o.seq_num = ranked.rn;

-- Step 3: إزالة الـ UNIQUE constraint من orderNumber مؤقتاً
ALTER TABLE orders DROP INDEX orderNumber;

-- Step 4: تحديث orderNumber بالأرقام المتسلسلة
UPDATE orders SET orderNumber = CAST(seq_num AS CHAR);

-- Step 5: إعادة إضافة الـ UNIQUE constraint
ALTER TABLE orders ADD UNIQUE INDEX orderNumber (orderNumber);

-- Step 6: حذف العمود المؤقت
ALTER TABLE orders DROP COLUMN seq_num;

-- Step 7: إضافة حالة no_answer للـ status enum
ALTER TABLE orders MODIFY COLUMN status ENUM('new','confirmed','postponed','cancelled','preparing','shipped','delivered','no_answer') NOT NULL DEFAULT 'new';
