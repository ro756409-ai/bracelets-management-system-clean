/**
 * Ledger reconciliation — READ ONLY.
 *
 * The system keeps money in two places that never talk to each other:
 *
 *   treasury_transactions   manual deposits/withdrawals + order collections
 *   financial_transactions  expense payments, payroll, advances, carrier settlements,
 *                           order payments, refunds, shipping charges
 *
 * Before anything is copied from one into the other, we need to know exactly what is in
 * each, whether the same real-world event was recorded in both, and whether either
 * ledger's stored balance still agrees with the sum of its own rows.
 *
 * This script answers those questions and writes NOTHING. It issues SELECT statements
 * only — no INSERT, UPDATE, DELETE, ALTER or DDL of any kind. It is safe to run against
 * production, and running it twice changes nothing.
 *
 *   corepack pnpm tsx scripts/reconcile-ledgers.ts
 *   corepack pnpm tsx scripts/reconcile-ledgers.ts --json > reconcile.json
 */

import "dotenv/config";
import mysql from "mysql2/promise";

const asJson = process.argv.includes("--json");
const out: Record<string, unknown> = {};

function money(v: unknown): string {
  const n = Number(v ?? 0);
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function heading(title: string) {
  if (asJson) return;
  console.log("\n" + "═".repeat(72));
  console.log("  " + title);
  console.log("═".repeat(72));
}

function line(label: string, value: string) {
  if (asJson) return;
  console.log(`  ${label.padEnd(46, ".")} ${value.padStart(20)}`);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Run this inside the app container.");
    process.exit(1);
  }

  const db = await mysql.createConnection(url);

  // Two independent guards, because "I checked the file" is not a safety property.
  //
  // 1. The server refuses writes. START TRANSACTION READ ONLY makes MySQL itself reject
  //    any INSERT/UPDATE/DELETE/DDL for the life of this connection — a bug in this file
  //    cannot write, and neither can anything it calls. The session is rolled back at the
  //    end, which is a no-op on a read-only transaction but keeps the intent explicit.
  // 2. The client refuses non-SELECT. Belt to the server's braces.
  await db.query("START TRANSACTION READ ONLY");

  const q = async <T = any>(sql: string, args: any[] = []): Promise<T[]> => {
    if (!/^\s*select/i.test(sql)) throw new Error("Refusing to run a non-SELECT statement");
    const [rows] = await db.execute(sql, args);
    return rows as T[];
  };

  // ── 1. What exists at all ────────────────────────────────────────────────
  heading("١ · حجم كل دفتر");

  const [tt] = await q(`SELECT COUNT(*) c, MIN(transactionDate) f, MAX(transactionDate) t,
      COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) tin,
      COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) tout
    FROM treasury_transactions`);
  const [ft] = await q(`SELECT COUNT(*) c, MIN(occurredAt) f, MAX(occurredAt) t,
      COALESCE(SUM(amount),0) total
    FROM financial_transactions WHERE status <> 'reversed'`);

  line("صفوف الخزنة (treasury_transactions)", String(tt.c));
  line("  داخل", money(tt.tin));
  line("  خارج", money(tt.tout));
  line("  الصافي", money(Number(tt.tin) - Number(tt.tout)));
  line("  من", String(tt.f ?? "—"));
  line("  إلى", String(tt.t ?? "—"));
  line("صفوف الحسابات المالية (financial_transactions)", String(ft.c));
  line("  إجمالي المبالغ", money(ft.total));
  line("  من", String(ft.f ?? "—"));
  line("  إلى", String(ft.t ?? "—"));
  out.volume = { treasury: tt, financial: ft };

  // ── 2. Does each ledger agree with itself? ───────────────────────────────
  heading("٢ · هل كل دفتر متطابق مع نفسه؟");

  // treasury_transactions stores a running balanceAfter per row. If the arithmetic ever
  // drifted (concurrent writes, a manual edit), the last row's balanceAfter will not equal
  // the sum of the signed amounts.
  const drift = await q(`SELECT t.businessId,
      COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END),0) computed,
      (SELECT balanceAfter FROM treasury_transactions x
        WHERE x.businessId = t.businessId ORDER BY x.id DESC LIMIT 1) stored
    FROM treasury_transactions t GROUP BY t.businessId ORDER BY t.businessId`);

  let treasuryDrift = 0;
  for (const r of drift) {
    const diff = Number(r.computed) - Number(r.stored ?? 0);
    if (Math.abs(diff) > 0.005) treasuryDrift++;
    line(
      `نشاط ${r.businessId}: محسوب ${money(r.computed)} / مخزّن ${money(r.stored)}`,
      Math.abs(diff) > 0.005 ? `فرق ${money(diff)}` : "مطابق"
    );
  }
  out.treasuryDrift = drift;

  // financial_accounts.currentBalance is a stored aggregate. Recompute it from the
  // transactions that reference the account on either side.
  const accts = await q(`SELECT a.id, a.businessId, a.code, a.name, a.accountType,
      a.openingBalance, a.currentBalance,
      COALESCE((SELECT SUM(amount) FROM financial_transactions f
         WHERE f.targetAccountId = a.id AND f.status <> 'reversed'),0) inflow,
      COALESCE((SELECT SUM(amount) FROM financial_transactions f
         WHERE f.sourceAccountId = a.id AND f.status <> 'reversed'),0) outflow
    FROM financial_accounts a ORDER BY a.businessId, a.code`);

  let acctDrift = 0;
  for (const a of accts) {
    const computed = Number(a.openingBalance) + Number(a.inflow) - Number(a.outflow);
    const diff = computed - Number(a.currentBalance);
    if (Math.abs(diff) > 0.005) acctDrift++;
    line(
      `[${a.businessId}] ${a.code} ${a.name}`,
      Math.abs(diff) > 0.005 ? `فرق ${money(diff)}` : money(a.currentBalance)
    );
  }
  out.accounts = accts;

  // ── 3. The dangerous overlap ─────────────────────────────────────────────
  heading("٣ · هل نفس الحدث اتسجّل في الدفترين؟");

  // An order collection can be recorded in treasury_transactions (recordOrderCollection)
  // AND as an order_payment in financial_transactions (confirmOrderPayment). Copying the
  // treasury rows across without checking would double-count every order in this list.
  // Identifying columns only — order id, order number, amounts, dates, source table.
  // No customer name, phone, address or any other personal field is selected anywhere in
  // this script, so nothing personal can reach the console or the JSON file.
  const dupOrders = await q(`SELECT t.referenceId orderId, o.orderNumber,
      'treasury_transactions' treasuryTable, t.id treasuryRowId,
      t.amount treasuryAmount, t.transactionDate treasuryDate,
      'financial_transactions' financialTable, f.id financialRowId,
      f.amount financialAmount, f.occurredAt financialDate
    FROM treasury_transactions t
    JOIN orders o ON o.id = t.referenceId
    JOIN business_events be ON be.sourceType = 'order'
      AND be.sourceReference = CAST(t.referenceId AS CHAR)
      AND be.eventType IN ('order.payment_confirmed','order.paid')
    JOIN financial_transactions f ON f.businessEventId = be.id AND f.status <> 'reversed'
    WHERE t.referenceType = 'order' AND t.type = 'collection'
    ORDER BY t.referenceId
    LIMIT 500`);

  line("أوردرات متسجّلة في الدفترين", String(dupOrders.length) + (dupOrders.length >= 500 ? "+" : ""));
  if (dupOrders.length > 0 && !asJson) {
    console.log("\n  ⚠ الأوردرات دي هتتحسب مرتين لو نسخنا من غير استثناء:");
    for (const d of dupOrders.slice(0, 15)) {
      console.log(
        `     أوردر ${d.orderNumber} (#${d.orderId})  خزنة ${money(d.treasuryAmount)}  ·  مالي ${money(d.financialAmount)}`
      );
    }
    if (dupOrders.length > 15) console.log(`     ... و${dupOrders.length - 15} غيرهم (كلهم في مخرجات --json)`);
  }
  out.duplicateOrderCollections = dupOrders;

  // Expenses are created in the `expenses` table by V1 and paid through V2. An expense
  // that is marked paid but has no payment row means the money left without a ledger entry.
  // description is truncated: it is business text, not customer data, but there is no
  // reason to print more of it than is needed to recognise which expense this is.
  const orphanExpenses = await q(`SELECT e.id, e.businessId, e.amount, e.paidAmount, e.status,
      LEFT(e.description, 40) descriptionShort
    FROM expenses e
    LEFT JOIN expense_payments p ON p.expenseId = e.id
    WHERE e.status IN ('paid','partially_paid') AND p.id IS NULL
    LIMIT 100`);
  line("مصروفات مدفوعة بلا حركة مالية", String(orphanExpenses.length));
  out.orphanExpenses = orphanExpenses;

  // ── 4. Brand attribution ─────────────────────────────────────────────────
  heading("٤ · هل كل حركة ليها براند؟");

  const [ttNoBrand] = await q(`SELECT COUNT(*) c FROM treasury_transactions WHERE businessId IS NULL`);
  const [ftNoBrand] = await q(`SELECT COUNT(*) c FROM financial_transactions WHERE businessId IS NULL`);
  line("حركات خزنة بلا براند", String(ttNoBrand.c));
  line("حركات مالية بلا براند", String(ftNoBrand.c));

  const perBrand = await q(`SELECT b.id, b.name,
      (SELECT COUNT(*) FROM treasury_transactions t WHERE t.businessId = b.id) treasuryRows,
      (SELECT COUNT(*) FROM financial_transactions f WHERE f.businessId = b.id) financialRows,
      (SELECT COUNT(*) FROM financial_accounts a WHERE a.businessId = b.id) accounts
    FROM businesses b ORDER BY b.id`);
  if (!asJson) {
    console.log("");
    for (const b of perBrand) {
      console.log(`  [${b.id}] ${b.name}: خزنة ${b.treasuryRows} · مالي ${b.financialRows} · حسابات ${b.accounts}`);
    }
  }
  out.perBrand = perBrand;

  // ── 5. Shared-account feasibility ────────────────────────────────────────
  heading("٥ · الحسابات المشتركة");

  // The requirement is one physical cash box and one bank shared by three brands. The
  // schema puts businessId on financial_accounts, so today each brand owns its own. This
  // counts how many separate accounts would have to be merged into one.
  const byType = await q(`SELECT accountType, COUNT(*) c, COUNT(DISTINCT businessId) brands,
      SUM(currentBalance) total
    FROM financial_accounts GROUP BY accountType ORDER BY accountType`);
  for (const t of byType) {
    line(`${t.accountType}: ${t.c} حساب عبر ${t.brands} براند`, money(t.total));
  }
  out.accountsByType = byType;

  // ── 6. Verdict ───────────────────────────────────────────────────────────
  heading("٦ · الخلاصة");

  const blockers: string[] = [];
  if (treasuryDrift > 0) blockers.push(`${treasuryDrift} نشاط رصيد خزنته مش مطابق لمجموع حركاته`);
  if (acctDrift > 0) blockers.push(`${acctDrift} حساب مالي رصيده مش مطابق لمجموع حركاته`);
  if (dupOrders.length > 0) blockers.push(`${dupOrders.length} أوردر متسجّل في الدفترين — لازم يتستثنى من النقل`);
  if (orphanExpenses.length > 0) blockers.push(`${orphanExpenses.length} مصروف مدفوع بلا حركة مالية`);
  if (Number(ttNoBrand.c) > 0) blockers.push(`${ttNoBrand.c} حركة خزنة بلا براند`);
  if (Number(ftNoBrand.c) > 0) blockers.push(`${ftNoBrand.c} حركة مالية بلا براند`);

  if (asJson) {
    out.blockers = blockers;
    console.log(JSON.stringify(out, null, 2));
  } else if (blockers.length === 0) {
    console.log("\n  ✅ الدفترين متسقين داخليًا ومفيش تداخل. النقل ممكن يتخطط عليه.\n");
  } else {
    console.log("\n  ⛔ لازم تتحل الأول:\n");
    for (const b of blockers) console.log(`     • ${b}`);
    console.log("");
  }

  await db.query("ROLLBACK");
  await db.end();
}

main().catch(e => {
  // A driver-level failure can carry the host, port and user from the connection string.
  // Print the message with anything URL-shaped stripped, so a paste of this output into a
  // chat or a ticket can never carry the database credentials with it.
  const safe = String(e?.message ?? e)
    .replace(/\b[a-z]+:\/\/[^\s]*/gi, "[connection-string-redacted]")
    .replace(/(password|pwd|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  console.error("فشل:", safe);
  process.exit(1);
});
