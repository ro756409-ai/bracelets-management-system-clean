-- 0045 — دور «مدير الحسابات» accounts_manager. DELTA مكتوبة بخط اليد: تعديل عمود واحد، بلا جداول جديدة، بلا Backfill.
-- employees.role عمود ENUM في القاعدة؛ القيمة الجديدة تُضاف في **آخر** القائمة — القيم الثلاث عشرة القديمة وترتيبها
-- كما هي حرفيًا، فلا تتغير أي قيمة مخزّنة (MySQL 8: تعديل تعريف بلا إعادة بناء الجدول).
-- خصائص العمود تبقى: NOT NULL، DEFAULT 'agent'، charset/collation الحالي للعمود (المشغّل يقرؤه ويعيده صراحةً)، بلا تعليق.
-- باقي أعمدة الدور (tenant_role_permissions/memberships/attendance_assignments.role ولقطات السجلات) نصية وتكفي — لا تتغير.
-- لا يُشغَّل إلا عبر scripts/migrate-0045-roles: فحص مسبق يطابق التعريف الحالي **حرفيًا** (غير ذلك = partial ورفض
-- بلا أي DDL)، عبارة تأكيد «APPLY 0045 TO <db>»، تحقق بعد التطبيق، وفي هذه المرحلة على Docker محلي مؤقت فقط.

ALTER TABLE `employees` MODIFY COLUMN `role` enum('agent','warehouse','manager','facebook_entry','scanner','super_admin','admin','data_entry','order_confirmation','shipping','accountant','viewer','moderator','accounts_manager') NOT NULL DEFAULT 'agent';

-- ROLLBACK — فقط عبر: scripts/migrate-0045-roles --rollback (يُرفض لو أي موظف/صلاحية/عضوية/تعيين وردية يستخدم الدور):
--   ALTER TABLE `employees` MODIFY COLUMN `role` enum('agent','warehouse','manager','facebook_entry','scanner','super_admin','admin','data_entry','order_confirmation','shipping','accountant','viewer','moderator') NOT NULL DEFAULT 'agent';
