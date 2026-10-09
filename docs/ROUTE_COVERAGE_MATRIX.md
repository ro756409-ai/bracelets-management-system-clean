# مصفوفة تغطية المسارات — ثيم Copper Signature × Clean Spatial (المرحلة 7I)

المصدر: `client/src/App.tsx` (كل `<Route>`), محدَّثة في 2026-10-09. الحارس الآلي: `client/src/pages/routes.phase7i.wiring.test.ts`
(كل صفحة مسارية: بلا ألوان خام/hex/إيموجي/هوية بنفسجية قديمة، كل Button بهدف لمس 44px على الهاتف، `<main>` واحد في الصفحات المستقلة).

الرموز: ✔ تم التحقق في المتصفح (360/1280، Light/Dark، 125%) · ○ مغطّى بالحارس النصّي + اختبارات render فقط · — غير منطبق.
"الدور المسموح" = الحارس الفعلي على المسار في App.tsx؛ الحكم النهائي على السيرفر لكل إجراء (`*Procedure`).

| المسار | الدور/الحارس | الصفحة | المرحلة | Light/Dark | Mobile/Desktop | Loading | Empty | Error | Permission | Offline |
|---|---|---|---|---|---|---|---|---|---|---|
| `/` | عام (المسجَّل → /dashboard) | Home | 7H | ✔ | ✔ | — | — | — | — | — |
| `/login` | عام | Login | 7H | ✔ | ✔ | زر | — | role=alert | — | — |
| `/signup` | عام (طلب pending للموافقة) | Register | 7H | ✔ | ✔ | زر | حالة «قيد المراجعة» | role=alert | — | — |
| `/platform-admin/login` | عام (جلسة platform_admin) | PlatformAdminLogin | 7H | ✔ | ✔ | زر | — | role=alert | — | — |
| `/platform-admin` | جلسة platform_admin (وإلا → login) | PlatformAdmin | 7H | ○ | ○ | ✔ | ✔ | رسالة | توجيه للدخول | — |
| `/dashboard` | ProtectedLayout (مستخدم مسجَّل) | Dashboard | 7A | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `/orders` | ProtectedLayout | Orders | 3/4 + 7I | ✔ | ✔ | ✔ | ✔ | ✔ | — | — |
| `/workspace` | ProtectedLayout (موظف تأكيد بجلسة لوحة) | AgentWorkspace | 7I | ✔ | ✔ | ✔ | ✔ | — | — | ✔ |
| `/employees` | ProtectedLayout + `isAdmin` داخل الصفحة | Employees | 7F | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `/inventory` | ProtectedLayout | Inventory | 7C | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| `/reports` | ProtectedLayout + `isAdmin` (queries disabled) | Reports | 7G | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `/employee-login` | عام | EmployeeLogin | 7I | ✔ | ✔ | زر | — | role=alert | — | — |
| `/accountant` | أي دور → AccountingDisabled | AccountingDisabled | 7E | ✔ | ✔ | — | — | — | — | — |
| `/employee-dashboard` | BlockFinancialUser + EmployeeDashboardGuard | EmployeeDashboard | 7F (لمسات) | ○ | ○ | موجود | موجود | — | توجيه | — |
| `/warehouse-dashboard` | جلسة موظف (employee_session) | WarehouseDashboard | 7I | ✔ | ✔ | ✔ | ✔ | توجيه للدخول | — | — |
| `/manager-dashboard` | BlockFinancialUser | ManagerDashboard | 7F/7I (لمسات) | ○ | ○ | موجود | موجود | — | — | — |
| `/today-shipments` | OperationsRoute (لوحة → Workspace، موظف → بوابة) | TodayShipmentsWorkspace / TodayShipments | 7D | ✔ | ✔ | ✔ | ✔ | ✔ | — | — |
| `/shipping-schedule` | OperationsRoute | ShippingScheduleWorkspace / ShippingSchedule | 7D | ✔ | ✔ | ✔ | ✔ | ✔ | — | — |
| `/webhook-settings` | ProtectedLayout | WebhookSettings | 7H | ✔ | ✔ | ✔ | ✔ | — | — | ✔ |
| `/merge-logs` | ProtectedLayout | MergeLogs | 7I | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| `/returns` | ProtectedLayout | Returns | 7D | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| `/duplicates` | ProtectedLayout | Duplicates | 7I | ✔ | ✔ | ✔ | ✔ | — | — | — |
| `/preparation` | ProtectedLayout | Preparation | 7D | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| `/print-logs` | ProtectedLayout | PrintLogs | 7D | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| `/activity-log` | ProtectedLayout | ActivityLog | 7I | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| `/order/:id` | ProtectedLayout | OrderDetails | 7B | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| `/sales-channels` | ProtectedLayout | SalesChannels | 7H | ✔ | ✔ | ✔ | ✔ | — | — | ✔ |
| `/businesses` | ProtectedLayout | Businesses | 7H | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| `/printed-orders` | ProtectedLayout | PrintedOrders | 7D | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| `/scan-logs` | ProtectedLayout | ScanLogs | 7D | ✔ | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| `/bosta-orders` | ProtectedLayout | BostaOrders | 7D | ✔ | ✔ | ✔ | ✔ | ✔ | — | — |
| `/ledger/transactions` | FinancialRoute `ledger.view` (bare) + LedgerLayout | LedgerTransactions | 7E | ✔ | ✔ | ✔ | ✔ | ✔ | حارس المسار | ✔ |
| `/ledger` | FinancialRoute `ledger.view` (bare) + LedgerLayout | LedgerDaily | 7E | ✔ | ✔ | ✔ | غير مهيأ/غير مفعّل | ✔ | حارس المسار | ✔ |
| `/permissions` | ProtectedLayout (المالك؛ FORBIDDEN → Denied) | PermissionsPage | 7F | ✔ | ✔ | ✔ | — | ✔ | ✔ | — |
| `/accounting` `/treasury` `/expenses` `/collections` `/supplier-statements` `/salary-profiles` `/salary-preparation` `/payroll` `/closings` `/daily-ledger` `/daily-collections` `/advertising` `/accounting-settings` `/shipping-finance` `/accounting-disabled` | أي دور (مجمّد) | AccountingDisabled | 7E | ✔ | ✔ | — | — | — | — | — |
| `/goods-receipt` | FinancialRoute `inventory_costing.view` (+EmployeeShell) | GoodsReceipt | 7C | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `/stocktake` | FinancialRoute `inventory_costing.view` (+EmployeeShell) | Stocktake | 7C | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| `/stock-transfer` | FinancialRoute `inventory_costing.view` | StockTransfer | 7I | ✔ | ✔ | — | — | role=alert | حارس المسار | ✔ |
| `/workshop-returns` | FinancialRoute `inventory_costing.view` | WorkshopReturns | 7D | ✔ | ✔ | ✔ | ✔ | ✔ | حارس المسار | ✔ |
| `/facebook-entry` | BlockFinancialUser + OrderCreateGuard | FacebookEntry | 7B | ✔ | ✔ | ✔ | ✔ | ✔ | توجيه | ✔ |
| `/scan-orders` | ProtectedLayout | ScanOrders | 7D | ✔ | ✔ | — | — | ✔ | — | — |
| `/404` + catch-all | عام | NotFound | 7H | ✔ | ✔ | — | — | — | — | — |

## صفحات مستوردة في App.tsx لكنها غير مسارية
`DailyLedger`, `AccountantWorkspace` (استيرادان بلا Route — موروث؛ لم يُحذفا في هذه المرحلة حتى لا يتغيّر App.tsx المثبَّت بالاختبارات).

## ما تبقّى خارج النطاق (يُسجَّل لا يُنفَّذ)
- انتهاء الفترة التجريبية: لا توجد شاشة/حالة في الواجهة الحالية ولا حقل في الـschema — غير متاح.
- `EmployeeDashboard` و`ManagerDashboard` (2093/1406 سطرًا): أخذا لمسات الأساسيات فقط (44px، إزالة الإيموجي، tokens)؛ إعادة بنائهما بالمكوّنات المشتركة مؤجّلة.
