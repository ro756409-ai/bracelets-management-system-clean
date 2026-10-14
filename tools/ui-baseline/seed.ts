// Matjarak 2.0 — المرحلة 0: بيانات تجريبية للّقطات المرجعية على قاعدة Docker محلية مؤقتة فقط (mj-ui-baseline:3324).
// لا Staging ولا Production ولا بوسطة: أرقام وهمية، والدفتر يُبنى عبر الخدمات الحقيقية (بلا إدخال مباشر في القيود)،
// وأوردرات بحالات متنوعة (جديد/مؤكد/مؤجل/لم يرد/تجهيز/مشحون/ملغي/ناقص البيانات) لشاشات الطلبات — إدخال مباشر بلا أي إرسال.
import fs from "fs";
import bcrypt from "bcryptjs";
import mysql from "mysql2/promise";
const REPO = process.cwd();
const imp = (p: string) => import(`${REPO}/${p}`);

async function main() {
  const url = process.env.DATABASE_URL as string;
  if (!/^mysql:\/\/root:root@127\.0\.0\.1:3324\/matjarak_ui_baseline$/.test(url)) throw new Error("refusing: not the throwaway local UI-baseline DB");
  const name = new URL(url).pathname.slice(1);
  const { splitMigrationStatements } = await imp("shared/ledgerV3Spec.ts");
  const { runHandMigration, confirmPhrase } = await imp("server/handMigration.service.ts");
  const { runRoleEnumMigration } = await imp("server/roleEnumMigration.service.ts");
  const { runLedgerKindsMigration } = await imp("server/ledgerKindsMigration.service.ts");
  const { LEDGER_PHASE_MIGRATIONS } = await imp("server/ledgerPhaseMigrations.ts");
  const { ATTENDANCE_MIGRATION } = await imp("server/attendanceMigration.ts");
  const { ORDER_EVENTS_MIGRATION } = await imp("server/orderEventsMigration.ts");
  const c = await mysql.createConnection(url);
  const q = async (s: string, p: unknown[] = []) => ((await c.query(s, p)) as any)[0];
  const env = (id: string) => ({ deployEnv: "test", confirm: confirmPhrase(id, "apply", name) });
  for (const [def, file, id] of [[ORDER_EVENTS_MIGRATION, "drizzle/0041_order_activity_events.sql", "0041"], [ATTENDANCE_MIGRATION, "drizzle/0042_attendance.sql", "0042"]] as const) {
    const r = await runHandMigration(def, { databaseUrl: url, mode: "apply", sqlText: fs.readFileSync(`${REPO}/${file}`, "utf-8"), ...env(id) });
    if (!r.ok) throw new Error(`${id}: ${JSON.stringify(r)}`);
  }
  for (const stmt of splitMigrationStatements(fs.readFileSync(`${REPO}/drizzle/0040_ledger_v3.sql`, "utf-8"))) {
    try { await c.query(stmt); } catch (e: any) { if (e?.code !== "ER_DUP_KEYNAME") throw e; }
  }
  if (!(await runRoleEnumMigration({ databaseUrl: url, mode: "apply", ...env("0045") })).ok) throw new Error("0045");
  if (!(await runLedgerKindsMigration({ databaseUrl: url, mode: "apply", ...env("0046") })).ok) throw new Error("0046");
  for (const m of LEDGER_PHASE_MIGRATIONS) {
    const r = await runHandMigration(m.def, { databaseUrl: url, mode: "apply", sqlText: fs.readFileSync(`${REPO}/${m.file}`, "utf-8"), ...env(m.def.id) });
    if (!r.ok) throw new Error(`${m.def.id}: ${JSON.stringify(r)}`);
  }

  // شركة تجريبية بنشاطين
  const hash = await bcrypt.hash(process.env.OWNER_TEST_PASSWORD as string, 10);
  const tenantId = Number((await q("INSERT INTO tenants (name, slug, status) VALUES ('شركة الأساور التجريبية', 'demo-ui-baseline', 'active')")).insertId);
  const biz = async (n: string, slug: string) => Number((await q("INSERT INTO businesses (tenantId, name, slug, baseCurrency, timezone, accountingGoLiveAt) VALUES (?, ?, ?, 'EGP', 'Africa/Cairo', ?)", [tenantId, n, slug, new Date("2026-08-31T21:00:00Z")])).insertId);
  const b1 = await biz("نحاس طبي", "nahas-ui"), b2 = await biz("أساور فضة", "silver-ui");
  const emp = async (n: string, role: string, username: string, businessId = b1) => Number((await q("INSERT INTO employees (name, role, isActive, tenantId, businessId, username, passwordHash) VALUES (?, ?, 1, ?, ?, ?, ?)", [n, role, tenantId, businessId, username, hash])).insertId);
  const owner = await emp("المالك أحمد", "super_admin", "owner27");
  const am = await emp("مدير الحسابات كريم", "accounts_manager", "am27");
  const am2 = await emp("مديرة الحسابات منى", "accounts_manager", "am27b");
  await emp("محاسب براند نحاس", "accountant", "acc27u");
  await emp("إدخال بيانات — فيسبوك", "data_entry", "de27u"); // شاشة إدخال فيسبوك بجلسة بوابة الموظف (اللقطات المرجعية)
  const w1 = await emp("سارة — تجهيز", "agent", "w1u27"), w2 = await emp("مينا — مبيعات", "agent", "w2u27");
  const wh = Number((await q("INSERT INTO warehouses (businessId, name) VALUES (?, 'المكتب')", [b1])).insertId);
  await q("UPDATE businesses SET defaultWarehouseId = ? WHERE id = ?", [wh, b1]);
  const A = (id: number) => ({ type: "employee", employeeId: id });

  const v3 = await imp("server/ledgerV3.service.ts");
  await v3.activateLedgerV3({ tenantId, goLiveDate: "2026-09-01", currency: "EGP", actor: A(owner),
    reconciliation: { reportGeneratedAt: "2026-08-31T20:00:00Z", approvedByEmployeeId: owner, approvedAt: "2026-08-31T21:00:00Z" },
    openingBalances: { OFFICE_CASH: "20000", BANK_MAIN: "50000" }, businessIds: [b1, b2],
    safeGrants: { OFFICE_CASH: [b1, b2], BANK_MAIN: [b1, b2], COD_BOSTA: [b1, b2] } });
  await (await imp("server/ledgerDaily.service.ts")).ensureDailyAccounts({ tenantId, businessIds: [b1, b2], actor: A(owner) });
  const pay = await imp("server/ledgerPayroll.service.ts");
  const sup = await imp("server/ledgerSuppliers.service.ts");
  const ops = await imp("server/ledgerCarrierOps.service.ts");
  await pay.ensurePayrollAccounts({ tenantId, actor: A(owner) });
  await sup.ensureSupplierAccounts({ tenantId, actor: A(owner) });
  const acc: Record<string, number> = Object.fromEntries((await q("SELECT id, code FROM ledger_accounts WHERE tenantId = ?", [tenantId])).map((r: any) => [r.code, r.id]));
  let n = 0;
  const post = (kind: string, debit: string, credit: string, amount: string, date: string, description: string, businessId = b1) => v3.postLedgerTransaction({
    tenantId, sourceBusinessId: businessId, kind, idempotencyKey: `seed27-${++n}-xxxx`, effectiveDate: date, currency: "EGP", actor: A(owner), description, sourceType: null, sourceReference: null,
    entries: [{ accountId: acc[debit], side: "debit", amount, businessId }, { accountId: acc[credit], side: "credit", amount, businessId }] });
  await post("inventory_purchase", "INV_GOODS", "BANK_MAIN", "6000", "2026-09-02", "بضاعة جاهزة — شراء نقدي");
  await post("inventory_purchase", "INV_PACKAGING", "OFFICE_CASH", "400", "2026-09-02", "علب وأكياس تغليف");
  await post("expense", "EXP_ADS", "BANK_MAIN", "1800", "2026-09-03", "إعلانات فيسبوك سبتمبر");
  await post("expense", "EXP_RENT", "OFFICE_CASH", "2500", "2026-09-05", "إيجار سبتمبر");
  await post("expense", "EXP_INTERNET", "OFFICE_CASH", "350", "2026-09-06", "إنترنت");

  // إعدادات مُدخلة
  for (const [key, scope, value] of [["carrier.bosta.payout_weekdays", 0, (1 << 1) | (1 << 3)], ["carrier.bosta.fee_per_shipment", 0, "40"], ["carrier.bosta.vat_percent", 0, "14"], ["carrier.bosta.return_fee", 0, "30"], ["packaging.cost_per_order", b1, "3.5"], ["payroll.late_grace_minutes", b1, 60]] as const)
    await ops.setLedgerSetting({ tenantId, key, scopeBusinessId: scope, value, actor: A(am) });

  // أوردرات مسلَّمة (تسليم من بوسطة) + كشف تسوية + تحويل
  const orders = await imp("server/ledgerOrders.service.ts");
  const carrier = await imp("server/ledgerCarrier.service.ts");
  const mkOrder = async (no: string, ship: string, total: string, fees: string, cost: string, emp: number, at: string) => {
    const id = Number((await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productName, totalAmount, shippingFees, status, source, bostaShipmentId, assignedEmployeeId, deliveredAt)
      VALUES (?, ?, 'عميل تجريبي', '01000000000', 'عنوان', 'القاهرة', 'أسورة نحاس', ?, ?, 'delivered', 'manual', ?, ?, ?)`, [b1, no, total, fees, ship, emp, new Date(at)])).insertId);
    await q("INSERT INTO order_items (orderId, productName, quantity, unitCostSnapshot, stockOutQuantity) VALUES (?, 'أسورة نحاس', 1, ?, 1)", [id, cost]);
    await orders.postOrderDelivered({ businessId: b1, orderId: id, cod: Number(total), occurredAt: new Date(at), actor: { type: "webhook" } });
    return id;
  };
  await mkOrder("NH-1001", "BST-9001", "750", "50", "180", w2, "2026-09-08T12:00:00Z");
  await mkOrder("NH-1002", "BST-9002", "520", "40", "140", w2, "2026-09-09T12:00:00Z");
  const ret = await mkOrder("NH-1003", "BST-9003", "600", "50", "150", w2, "2026-09-10T12:00:00Z");
  await mkOrder("NH-1004", "BST-9004", "450", "40", "110", w1, "2026-09-11T12:00:00Z");
  const lines = [["BST-9001", "750", "45.60", "704.40"], ["BST-9002", "520", "50", "470"], ["BST-9003", "600", "45.60", "554.40"], ["BST-9004", "450", "45.60", "404.40"], ["BST-7777", "300", "45.60", "254.40"]];
  await carrier.settleCarrierStatement({ tenantId, statementRef: "BOSTA-2026-09-14", statementDate: "2026-09-14", actor: A(am),
    lines: lines.map(([shipment, cod, fees, net], i) => ({ row: i + 2, shipment, cod, fees, net })) });
  await carrier.recordCarrierPayout({ tenantId, statementRef: "BOSTA-2026-09-14", receivedOn: "2026-09-16", amount: "2133.2000", accountCode: "BANK_MAIN", actor: A(am) });
  // مرتجع بعد التحصيل ⇒ التزام رد للعميل
  await q("UPDATE orders SET status = 'returned' WHERE id = ?", [ret]);
  await orders.postOrderReturned({ businessId: b1, orderId: ret, occurredAt: new Date("2026-09-18T12:00:00Z"), actor: { type: "webhook" } });

  // المرتبات والسلف
  await q("INSERT INTO payroll_settings (businessId, workingDaysPerMonth, workHoursPerDay, overtimeMultiplier) VALUES (?, 26, '8.00', '1.50')", [b1]);
  for (const [e, type, base, ct, cv] of [[w1, "monthly", "6000", null, null], [w2, "mixed", "4000", "per_order", "25"]] as const)
    await q(`INSERT INTO employee_salary_profiles (businessId, employeeId, salaryType, baseSalary, commissionType, commissionValue, commissionBasis, effectiveFrom, isActive, createdBy, createdByName)
      VALUES (?, ?, ?, ?, ?, ?, 'delivered', ?, 1, ?, 'المالك')`, [b1, e, type, base, ct, cv, new Date("2026-08-01T00:00:00Z"), owner]);
  await q(`INSERT INTO attendance_days (tenantId, employeeId, workDate, timezone, status, workedMinutes, breakMinutes, excessBreakMinutes, lateMinutes, earlyLeaveMinutes, overtimeMinutes, requiresReview, approvedByEmployeeId, approvedAt, version)
    VALUES (?, ?, '2026-09-15', 'Africa/Cairo', 'absent', 0, 0, 0, 0, 0, 0, 0, NULL, NULL, 1), (?, ?, '2026-09-16', 'Africa/Cairo', 'closed', 540, 0, 0, 0, 0, 120, 0, ?, NOW(3), 1)`, [tenantId, w1, tenantId, w1, am]);
  await pay.issueAdvance({ tenantId, employeeId: w1, principal: "1500", issuedOn: "2026-09-04", installmentsCount: 3, firstDueMonth: "2026-09", fromAccountCode: "OFFICE_CASH", operationId: "seed27-adv-0001", actor: A(am) });
  const run = await pay.createPayrollRun({ tenantId, period: "2026-09", operationId: "seed27-run-0001", actor: A(am) });
  await pay.setPayrollAdjustments({ tenantId, runId: run.runId, employeeId: w2, bonuses: [{ label: "حافز تارجت سبتمبر", amount: "300" }], deductions: [] });
  await pay.approvePayrollRun({ tenantId, runId: run.runId, actor: A(am2), isOwner: false });
  await pay.payPayrollRun({ tenantId, runId: run.runId, paidOn: "2026-09-30", fromAccountCode: "BANK_MAIN", actor: A(am) });

  // الموردون والورشة
  const s1 = (await sup.createSupplier({ tenantId, code: "CU-01", name: "مورد النحاس المصري", phone: "0222222222", isWorkshop: false, actor: A(am) })).supplierId;
  const ws = (await sup.createSupplier({ tenantId, code: "WS-01", name: "ورشة الأسطى حسن", isWorkshop: true, actor: A(am) })).supplierId;
  await sup.postSupplierDocument({ tenantId, supplierId: s1, docType: "invoice", docNo: "INV-551", docDate: "2026-09-03", dueDate: "2026-09-20", amount: "8000", businessId: b1, itemAccountCode: "INV_RAW", actor: A(am) });
  await sup.postSupplierDocument({ tenantId, supplierId: s1, docType: "payment", docNo: "PAY-12", docDate: "2026-09-10", amount: "5000", cashAccountCode: "BANK_MAIN", actor: A(am) });
  await sup.postSupplierDocument({ tenantId, supplierId: s1, docType: "advance", docNo: "ADV-3", docDate: "2026-09-12", amount: "1000", cashAccountCode: "OFFICE_CASH", actor: A(am) });
  const batch = (await sup.createWorkshopBatch({ tenantId, supplierId: ws, businessId: b1, reference: "WS-B-0901", pieceWage: "12", actor: A(am) })).batchId;
  await sup.recordWorkshopEvent({ tenantId, batchId: batch, eventType: "send", quantity: 50, value: "2500", date: "2026-09-05", operationId: "seed27-ws-0001", actor: A(am) });
  await sup.recordWorkshopEvent({ tenantId, batchId: batch, eventType: "receive", quantity: 30, date: "2026-09-20", operationId: "seed27-ws-0002", actor: A(am) });
  await sup.recordWorkshopEvent({ tenantId, batchId: batch, eventType: "shortage", quantity: 2, chargeTo: "workshop", date: "2026-09-21", operationId: "seed27-ws-0003", actor: A(am) });

  // إقفال سبتمبر بصورة ثابتة (يتطلب قائمة فحص كاملة — مراجعة السطر الغامض أولًا)
  for (const r of await q("SELECT id FROM ledger_carrier_review_items WHERE tenantId = ? AND status = 'open'", [tenantId]))
    await ops.resolveCarrierReview({ tenantId, id: r.id, status: "dismissed", note: "شحنة ليست لنا — أُبلغت بوسطة", actor: A(am) });
  const close = await imp("server/ledgerClose.service.ts");
  const closed = await close.closeLedgerPeriod({ tenantId, period: "2026-09", reason: "راجعت سبتمبر وطابقت البنك والخزنة", actor: A(am) });
  // أكتوبر: مصروف + مسودة مرتب + سطر كشف للمراجعة (تظهر في الطابور)
  await post("expense", "EXP_MOBILE", "OFFICE_CASH", "220", "2026-10-02", "باقات موبايل");
  await pay.createPayrollRun({ tenantId, period: "2026-10", operationId: "seed27-run-0002", actor: A(am) });
  await carrier.settleCarrierStatement({ tenantId, statementRef: "BOSTA-2026-10-05", statementDate: "2026-10-05", actor: A(am), lines: [{ row: 2, shipment: "BST-8888", cod: "200", fees: "40", net: "160" }] });
  // ── شاشات الطلبات والمخزون: منتجات بتركيبات + أوردرات بحالات متنوعة (بيانات عرض فقط، بلا شحن) ──
  const { createProductWithVariants } = await imp("server/db.ts");
  const p1 = await createProductWithVariants(b1, { name: "أسورة نحاس طبي" }, [
    { name: "سادة", sku: "UI-NH-1", currentStock: 42, price: "250" }, { name: "محفورة بالاسم", sku: "UI-NH-2", currentStock: 7, price: "320" }, { name: "مطلية", sku: "UI-NH-3", currentStock: 0, price: "290" }]);
  const p2 = await createProductWithVariants(b1, { name: "خاتم نحاس" }, [{ name: "مقاس 18", sku: "UI-RG-18", currentStock: 15, price: "150" }]);
  const statuses = ["new", "new", "new", "confirmed", "confirmed", "postponed", "no_answer", "preparing", "printed", "shipped", "cancelled", "new"] as const;
  const names = ["منى عبد الله", "أحمد سامي", "سارة محمود", "كريم حسن", "نورا علي", "محمد إبراهيم", "هدى مصطفى", "يوسف خالد", "ريم طارق", "عمر فؤاد", "ليلى حسين", "طارق نبيل"];
  const govs = ["القاهرة", "الجيزة", "الإسكندرية", "الدقهلية", "الشرقية", "أسيوط", "القاهرة", "الجيزة", "المنوفية", "القليوبية", "سوهاج", "غير محدد"];
  for (let i = 0; i < statuses.length; i++) {
    const incomplete = i === 2 || i === 11; // عنوان قصير/محافظة غير محددة ⇒ «محتاج استكمال بيانات»
    const variant = i % 3 === 2 ? p1.variantIds[1] : p1.variantIds[0];
    const id = Number((await q(`INSERT INTO orders (businessId, orderNumber, customerName, customerPhone, customerAddress, governorate, productId, variantId, productName, quantity, totalAmount, shippingFees, status, source, assignedEmployeeId, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'أسورة نحاس طبي', ?, ?, '50', ?, ?, ?, ?)`, [b1, `UI-${2001 + i}`, names[i], `010${String(10000000 + i * 7919).slice(0, 8)}`,
      incomplete ? "شارع 5" : `شارع ${10 + i} متفرع من شارع النصر — عمارة ${i + 2}`, govs[i], p1.productId, variant, 1 + (i % 2), String(300 + i * 35), statuses[i],
      ["facebook", "easyorder", "manual", "whatsapp"][i % 4], statuses[i] === "new" ? null : i % 2 ? w2 : w1, // «جديد» غير موزّع (فلتر الصفحة الافتراضي)
      new Date(Date.UTC(2026, 9, 14, 8 + i))])).insertId);
    await q("INSERT INTO order_items (orderId, productId, variantId, productName, quantity, unitPrice) VALUES (?, ?, ?, 'أسورة نحاس طبي', ?, ?)", [id, p1.productId, variant, 1 + (i % 2), String(250 + i * 10)]);
  }
  void p2;
  console.log(JSON.stringify({ tenantId, b1, b2, owner, am, am2, snapshot: closed.snapshot }));
  await c.end();
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
