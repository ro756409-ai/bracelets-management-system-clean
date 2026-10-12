-- 0046 — نوعا حساب جديدان في ledger_accounts.kind: payroll_payable (رواتب مستحقة) وsupplier_advance (دفعات مقدمة لموردين).
-- DELTA مكتوبة بخط اليد: تعديل عمود واحد (ENUM من 0040)، بلا جداول جديدة، بلا Backfill. القيم القديمة وترتيبها كما هي حرفيًا،
-- والجديدتان في آخر القائمة (لا تتغير أي قيمة مخزّنة). خصائص العمود تبقى: NOT NULL، بلا افتراضي، charset/collation الحالي
-- (المشغّل يقرؤه ويعيده صراحةً)، بلا تعليق. يتطلب 0040.
-- لا يُشغَّل إلا عبر scripts/migrate-0046-ledger-kinds: فحص مسبق يطابق التعريف الحالي حرفيًا (غير ذلك = partial ورفض بلا DDL)،
-- عبارة تأكيد «APPLY 0046 TO <db>»، تحقق بعد التطبيق، وفي هذه المرحلة على Docker محلي مؤقت فقط.

ALTER TABLE `ledger_accounts` MODIFY COLUMN `kind` enum('cash','bank','wallet','carrier_receivable','employee_receivable','supplier_payable','customer_advance','owner_current','revenue','expense','cogs','inventory','equity','suspense','payroll_payable','supplier_advance') NOT NULL;

-- ROLLBACK — فقط عبر scripts/migrate-0046-ledger-kinds --rollback (يُرفض لو أي حساب يستخدم أحد النوعين الجديدين):
--   ALTER TABLE `ledger_accounts` MODIFY COLUMN `kind` enum('cash','bank','wallet','carrier_receivable','employee_receivable','supplier_payable','customer_advance','owner_current','revenue','expense','cogs','inventory','equity','suspense') NOT NULL;
