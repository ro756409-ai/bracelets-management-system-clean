# Accounting Archive Inventory — Matjarak (FROZEN, pre-removal map)

> الغرض: حصر **كامل** للنظام المحاسبي القديم قبل أي أرشفة/إزالة لاحقة. **لا حذف، لا DROP،
> لا migration مدمّرة.** الحسابات تظل FROZEN لحد الموافقة على Finance V2. الوثيقة دي +
> `scripts/accountingExport.ts` هما مخرجات مرحلة الأرشفة (خريطة + خطة تصدير)، من غير أي
> اتصال بـProduction.

الحصر مستخرَج بقراءة الكود (`drizzle/schema.ts`, `server/*`, `client/src/*`). التواريخ
والأرقام تخص لقطة الفرع `feat/matjarak-v2-shell`.

---

## 1) DATA INVENTORY — الجداول المحاسبية

| # | الجدول | schema.ts | الوصف | يعتمد عليه (relations رئيسية) |
|---|--------|-----------|-------|------------------------------|
| 1 | `financial_accounts` | :1412 | دليل الحسابات (خزنة/بنك/…)، `isCashEquivalent` | financialTransactionEntries |
| 2 | `financial_transactions` | :1450 | حركة مالية (رأس) | entries, closings (cashFlow) |
| 3 | `financial_transaction_entries` | :1480 | أطراف الحركة (in/out) | financial_accounts, transactions |
| 4 | `treasury_transactions` | :917 | حركات الخزنة (legacy bridge) | financial_accounts |
| 5 | `expenses` | :866 | المصروفات | expense_categories, expense_payments, accrual_schedules |
| 6 | `expense_categories` | :841 | تصنيفات المصروف | expenses |
| 7 | `expense_payments` | :2033 | مدفوعات المصروف | expenses |
| 8 | `expense_accrual_schedules` | :2012 | جداول استحقاق المصروف | expenses, business_events(expense.accrued) |
| 9 | `payroll_settings` | :981 | إعدادات المرتبات | — |
| 10 | `employee_salary_profiles` | :1067 | ملفات الرواتب | employees, payroll_items |
| 11 | `payroll_periods` | :1120 | دورات المرتبات | payroll_items |
| 12 | `payroll_items` | :1170 | بنود المرتب للموظف | payroll_periods, employees |
| 13 | `employee_advances` | :1246 | السلف | employees, business_events(employee_advance.*) |
| 14 | `employee_bonuses` | :1281 | المكافآت | employees, payroll |
| 15 | `business_events` | :1302 | **مصدر الحقيقة للأحداث المالية** (immutable, idempotent) | closings, realizedProfit, كل الـemitters |
| 16 | `carrier_settlements` | :1950 | تسويات شركات الشحن (رأس) | carrier_settlement_lines |
| 17 | `carrier_settlement_lines` | :1987 | بنود التسوية | carrier_settlements, orders |
| 18 | `ad_spend_entries` | :2043 | مصروف الإعلانات | expenses (expenseId) |
| 19 | `accounting_closings` | :2081 | الإقفالات (فترات) | lines, adjustments, actions |
| 20 | `accounting_closing_lines` | :2132 | سطور الإقفال (P&L snapshot) | closings, business_events |
| 21 | `accounting_closing_adjustments` | :2156 | تسويات الإقفال | closings |
| 22 | `accounting_closing_actions` | :2174 | سجل إجراءات الإقفال (audit) | closings |
| 23 | `inventory_transactions` | :1552 | حركات المخزون المقيّمة (COGS/loss/gain) | business_events, inventory_balances |
| 24 | `inventory_balances` | :1502 | أرصدة المخزون المقيّمة (moving avg) | inventory_transactions |
| 25 | `stocktakes` / `stocktake_lines` | :1663/:1701 | الجرد + أثره المحاسبي (loss/gain) | business_events, inventory |

**ملاحظة حدود:** `inventory_*` و`stocktakes` و`carrier_settlements` **مشتركة** بين التشغيل والمحاسبة —
الأرشفة المحاسبية بتصدّر أثرها المالي، لكن **مايصحّش حذف جداول المخزون** (تشغيل حيّ). دي أهم
dependency عند أي إزالة مستقبلية (شوف §6).

### opening/historical balances
- أرصدة المخزون الافتتاحية: عبر `purchase_receipts.receiptType = "opening_inventory"` → `inventory_transactions`.
- أرصدة الموردين الافتتاحية: `business_events(supplier.opening_balance)`.
- الخزنة الافتتاحية: قيود `financial_transactions` الأولى / `treasury_transactions`.

---

## 2) CODE INVENTORY

### Services (server)
| ملف | الدور |
|-----|------|
| `accountingV2.service.ts` | القلب: business events, financial accounts/transactions, `computeRealizedProfit`, dashboard, treasury manual |
| `closingV2.service.ts` | الإقفالات (draft→submit→approve→lock)، `buildSnapshot`, eventLines→P&L |
| `expensesV2.service.ts` | المصروفات + الاستحقاق + المدفوعات |
| `payrollV2.service.ts` | المرتبات (دورات/بنود/اعتماد/دفع) |
| `advancesV2.service.ts` | السلف |
| `settlementsV2.service.ts` | تسويات الشحن |
| `shippingV2.service.ts` | تكاليف/أحداث الشحن المالية |
| `paymentsV2.service.ts` | تأكيد/استرداد المدفوعات |
| `supplierLedger.service.ts` | دفتر المورد/الورشة |
| `accountantSummary.service.ts` | ملخصات مساحة المحاسب |
| `inventoryV2.service.ts` | (مشترك) حركات المخزون المقيّمة — أثر محاسبي |
| `stocktake.service.ts` | (مشترك) اعتماد الجرد — loss/gain |

### Routers / Endpoints (`server/routers.ts`)
- `accountingV2` (:845) — ~**126 endpoint** (financial accounts, transactions, treasury, expenses, closings, payroll bridge, supplier, ad-spend, stocktake, inventory-costing…).
- `payroll` (:7580)، وأجزاء محاسبية داخل `reports` (:5673).
- بوابات الصلاحيات: `permissionProcedure`/`ownerProcedure` بالصلاحيات في §permissions.

### Pages (client) — legacy accounting UI
`Accounting.tsx` (Control Center), `Treasury.tsx`, `Expenses.tsx`, `Collections.tsx`,
`DailyCollections.tsx`, `DailyLedger.tsx`, `Payroll.tsx`, `SalaryProfiles.tsx`,
`SalaryPreparation.tsx`, `Closings.tsx`, `Advertising.tsx`, `ShippingFinance.tsx`,
`SupplierStatements.tsx`, `InventoryAccounting.tsx`, `AccountingSettings.tsx`,
+ مساحة المحاسب: `AccountantWorkspace.tsx` + `accountant/{AccExpenses,AccCollections,AccPayroll,AccGoodsReceipt,AccStocktake,AccWorkshop,ui}.tsx`
+ `pages/accounting/*` (ControlCenter…).

### Components (client)
`components/accounting/{AccountingFilters,ExpenseDrawer,PaymentSource,SupplierPaymentDrawer,Surface}.tsx`.

### Permissions (`server/permissions.ts`) — FINANCIAL_PERMISSIONS
`accounting.{view,manage,create,approve}` · `closing.{view,create,submit,approve,adjust,lock,export}` ·
`financial_accounts.{view,manage}` · `shipping_finance.{view,manage,approve}` · `ad_spend.{view,manage}` ·
`treasury.transfer` · `settlements.create` · `reports.view_profit` · `payroll.{view,manage,approve,pay}`.

### Tests (accounting-related)
`accounting.test.ts`, `accountingControlCenter.test.ts`, `accountingPermissions.test.ts`,
`accountantRedirectAccess.test.ts`, `accountantWorkspace.test.ts`, `financialAccessControl.test.ts`,
`defaultTreasuryAccount.test.ts`, `treasuryBridge.test.ts`, `payroll*.test.ts`, `salary*.test.ts`,
`supplier*.test.ts`, `canonicalProfitEngine.test.ts`, `closing*` (ضمن غيرها).

### Manual SQL
`drizzle/manual/accounting-reorg.sql`, `drizzle/manual/stocktake.sql` + migrations `drizzle/*.sql`.

### Event emitters (business_events) — 23 نوع
`expense.accrued|paid` · `payment.confirmed|refunded` · `payroll.paid` ·
`employee_advance.issued|cancelled` · `supplier.opening_balance|payment|adjustment|return_credit|rework_fee` ·
`shipping.charge_recognized|cost_adjustment|settlement_approved|settlement_voided|shipment_created` ·
`inventory.stock_out|stock_transfer|return_inspected|purchase_reversed|opening_in_transit|stocktake_approved`.
> **Consumers:** `closingV2.buildSnapshot` + `computeRealizedProfit` (كلاهما replay). أي إزالة
> لجدول business_events تكسر الإقفال والأرباح — أعلى dependency حرج.

### Integrations المعتمدة على الحسابات
- **الشحن (Bosta/settlements):** `shipping_finance` + carrier_settlements → business_events.
- **الإعلانات:** `ad_spend_entries.expenseId` → تُفرز في computeRealizedProfit.
- **EasyOrder/الأوردرات:** delivered/returned → revenue/COGS events (تشغيل يغذّي المحاسبة).

---

## 3) EXCEL EXPORT PLAN (تشغيلي — بدون لمس Production)

**الأداة:** `scripts/accountingExport.ts` (SELECT-only، sheet لكل جدول، ملف `.xlsx` واحد).

**التشغيل الآمن (المالك ينفّذه بنفسه على نسخة):**
1. خُد **نسخة/سناب‑شوت** من قاعدة الإنتاج (dump ثم restore على DB منفصلة). **مانتصلش بالإنتاج مباشرة.**
2. `export DATABASE_URL="mysql://user:pass@COPY_HOST:3306/matjarak_copy"`
3. `export ACCOUNTING_EXPORT_CONFIRM=1` (حاجز أمان — السكربت بيرفض بدونه).
4. `corepack pnpm tsx scripts/accountingExport.ts`
5. الناتج: `accounting-export-<timestamp>.xlsx` (sheet لكل جدول من §1) + sheet `_manifest` (أسماء/أعداد الصفوف).

**التغطية:** كل جداول §1 (financial accounts/transactions/entries, treasury, expenses+categories+payments+accruals, payroll+profiles+advances+bonuses, business_events, carrier settlements+lines, ad_spend, closings+lines+adjustments+actions, inventory_transactions+balances, stocktakes+lines). الأرصدة الافتتاحية بتظهر ضمن جداولها المصدر.

**قيود:** التصدير الفعلي بيحتاج بيانات (DB). في البيئة دي مفيش بيانات إنتاج — فالمُخرَج هنا = **السكربت + الخطة فقط**، جاهزين للتشغيل على نسخة وقت ما تقرّر.

---

## 4) DEPENDENCY MAP (قبل أي إزالة مستقبلية)
```
business_events ──► closingV2.buildSnapshot ──► accounting_closing_lines
       ▲         └► computeRealizedProfit ──► reports/dashboard (reports.view_profit)
       │
  emitters: expenses / payroll / advances / supplier / shipping / payments /
            inventory / stocktake   (10 services)
inventory_transactions ◄── (مشترك: تشغيل + محاسبة)
carrier_settlements    ◄── (مشترك: شحن + محاسبة)
```

## 5) CLASSIFICATION (accounting)
كل الحسابات = **FROZEN / KEEP-ACCESSIBLE** حاليًا. في V2 shell: رابط واحد هادي (`/accounting`) في «المزيد» بصلاحية `accounting.view` — كل الشاشات والـroutes شغّالة، خارج محور تنقّل المالك. **لا REMOVE قبل Finance V2.**

## 6) مخاطر الإزالة المستقبلية (للتوثيق فقط — مش دلوقتي)
1. **business_events غير قابل للحذف** طالما الإقفال/الأرباح شغّالين — أي Finance V2 لازم يهاجر أو يجسر عليه.
2. **inventory_* و carrier_settlements مشتركة** — إزالة «المحاسبة» مايصحّش يلمسها (تشغيل حيّ).
3. **الأرباح (computeRealizedProfit) تقرأ payroll/ad_spend/events** — إزالة أي مصدر بيغيّر الأرقام التاريخية.
4. **10 خدمات بتصدر أحداث** — إيقاف الإصدار لازم يسبق أي أرشفة نهائية.
5. **مساحة المحاسب** (`/accountant`) مسار حيّ لدور accountant — إخفاؤها بيقطع وصوله.

**الخلاصة:** الخريطة جاهزة. الأرشفة الفعلية (تصدير + قطع dependencies + إزالة) = مرحلة مستقلة
بموافقتك على Finance V2. **مفيش حذف/DROP/DELETE اتعمل.**
