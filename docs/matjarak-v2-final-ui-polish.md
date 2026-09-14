# Matjarak V2 — Final UI Polish (backlog)

> مرحلة مراجعة بصرية نهائية بعد اكتمال الـworkspaces. **عرض بس** — لا API ولا صلاحيات ولا
> نطاق أنشطة. كل بند هنا اتسجّل أثناء مرحلة سابقة واتأجّل عمدًا عشان مايتخلطش مع شغلها.

## المبدأ الحاكم
تصميم **Classic / Smart / Calm / Professional** موحّد على مستوى النظام كله: نفس الـtokens
(ألوان/مسافات/radius)، نفس تسلسل الأزرار (Primary واحد)، نفس الحالات (loading/empty/error)،
ومفيش ألوان Tailwind خام (`blue-700`, `amber-50`, `stone-800`…) جوه الصفحات.

## Inventory (Stage C) — مطلوب من صاحب المشروع
- [ ] تقليل المساحات البيضاء (المسافات بين الرأس/الإحصائيات/الفلاتر/الكروت).
- [ ] تقليل حجم KPI cards (صف الإحصائيات الأربعة — أيقونة + رقم `text-2xl` + `p-4`).
- [ ] إزالة أي تكرار في navigation/tabs — شوف «تبويبات مكرّرة» تحت.
- [ ] تحسين visual hierarchy لبطاقات المنتجات والإجراءات (إجراء أساسي واضح، الباقي هادي).
- [ ] مراجعة الأزرار الداخلية (الأصناف/الحركات/التكلفة) جنب تبويبات الـworkspace — مستويين
      تنقّل فوق بعض.

## تبويبات مكرّرة (اتكشفت في Stage D) — Orders + Inventory
`DashboardLayout` بيعرض `<WorkspaceTabs tabs={workspaceTabs} />` لكل وجهة (Sprint 1)، و
`Orders.tsx` (Stage B) و`Inventory.tsx` (Stage C) بيعرضوا `<WorkspaceTabs>` تاني جوه الصفحة —
فالتبويبات بتظهر مرتين.
- **الإصلاح المقترح:** الشل هو المصدر الوحيد — شيل `<WorkspaceTabs>` + `ordersTabs`/`inventoryTabs`
  من الصفحتين، وحدّث حراس Stage B/C (`Inventory.wiring.test.ts` بيقفل على السطر ده حاليًا).
- Stage D (Operations) اتبنى على القاعدة دي من الأول (حارس في `Operations.wiring.test.ts`).

## Operations (Stage D)
- [ ] `ShipmentsManifest` و`ShippingRoutesBoard`: اتنقلوا من صفحات البوابة كما هم — ألوان خام
      (تدرّجات blue/emerald/amber لكل شركة شحن، `stone-*`، `border-emerald-500`). تتحوّل لـtokens
      (مع الحفاظ على تمييز لون لكل شركة).
- [ ] شريط الإجراءات العائم في التجهيز (`bg-foreground` ثابت) → نمط موحّد لشريط التحديد الجماعي
      (نفس Orders).
- [ ] جدول التجهيز → `ResponsiveDataTable` (كروت على الموبايل) بدل `<table>` يدوي.
- [ ] صفحات البوابة (TodayShipments/ShippingSchedule) لسه بكروم مختلف (`slate-950` header) —
      توحيد مع باقي بوابة الموظفين.
