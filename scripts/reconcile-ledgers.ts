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

/**
 * Runs one section and keeps going if it throws.
 *
 * Every fix to this script costs a redeploy on the user's side, so a single bad query must
 * not take the other five sections down with it. A failed section is reported in place and
 * recorded in the JSON, and the run continues.
 */
const failures: { section: string; error: string }[] = [];
async function section<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e: any) {
    const msg = String(e?.message ?? e).split("\n")[0];
    failures.push({ section: name, error: msg });
    if (!asJson) console.log(`\n  ⚠ القسم ده فشل ومكملين: ${msg}\n`);
    return null;
  }
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


  let treasuryDrift = 0;
  let acctDrift = 0;
  let dupCount = 0;
  let orphanCount = 0;
  let ttNoBrandCount = 0;
  let ftNoBrandCount = 0;

  // ── 1. What exists at all ────────────────────────────────────────────────
  heading("١ · حجم كل دفتر");
  await section("حجم كل دفتر", async () => {
    const [tt] = await q(`SELECT COUNT(*) rowCount, MIN(transactionDate) firstAt, MAX(transactionDate) lastAt,
        COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) totalIn,
        COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) totalOut
      FROM treasury_transactions`);
    const [ft] = await q(`SELECT COUNT(*) rowCount, MIN(occurredAt) firstAt, MAX(occurredAt) lastAt,
        COALESCE(SUM(amount),0) totalAmount
      FROM financial_transactions WHERE status <> 'reversed'`);

    line("صفوف الخزنة (treasury_transactions)", String(tt.rowCount));
    line("  داخل", money(tt.totalIn));
    line("  خارج", money(tt.totalOut));
    line("  الصافي", money(Number(tt.totalIn) - Number(tt.totalOut)));
    line("  من", String(tt.firstAt ?? "—"));
    line("  إلى", String(tt.lastAt ?? "—"));
    line("صفوف الحسابات المالية (financial_transactions)", String(ft.rowCount));
    line("  إجمالي المبالغ", money(ft.totalAmount));
    line("  من", String(ft.firstAt ?? "—"));
    line("  إلى", String(ft.lastAt ?? "—"));
    out.volume = { treasury: tt, financial: ft };
  });

  // ── 2. Does each ledger agree with itself? ───────────────────────────────
  heading("٢ · هل كل دفتر متطابق مع نفسه؟");

  await section("رصيد الخزنة", async () => {
    // treasury_transactions stores a running balanceAfter per row. If the arithmetic ever
    // drifted (concurrent writes, a manual edit), the last row's balanceAfter will not
    // equal the sum of the signed amounts.
    // `stored` is a reserved word in MySQL 8.0 (GENERATED ALWAYS AS ... STORED) and cannot
    // be a bare column alias — every alias in this file is a compound identifier for that
    // reason.
    const drift = await q(`SELECT t.businessId,
        COALESCE(SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END),0) computedBalance,
        (SELECT balanceAfter FROM treasury_transactions x
          WHERE x.businessId = t.businessId ORDER BY x.id DESC LIMIT 1) storedBalance
      FROM treasury_transactions t GROUP BY t.businessId ORDER BY t.businessId`);

    if (drift.length === 0) line("مفيش حركات خزنة", "—");
    for (const r of drift) {
      const diff = Number(r.computedBalance) - Number(r.storedBalance ?? 0);
      if (Math.abs(diff) > 0.005) treasuryDrift++;
      line(
        `نشاط ${r.businessId}: محسوب ${money(r.computedBalance)} / مخزّن ${money(r.storedBalance)}`,
        Math.abs(diff) > 0.005 ? `فرق ${money(diff)}` : "مطابق"
      );
    }
    out.treasuryDrift = drift;
  });

  await section("أرصدة الحسابات المالية", async () => {
    // financial_accounts.currentBalance is a stored aggregate. Recompute it from the
    // transactions that reference the account on either side.
    const accts = await q(`SELECT a.id, a.businessId, a.code, a.name, a.accountType,
        a.openingBalance, a.currentBalance,
        COALESCE((SELECT SUM(amount) FROM financial_transactions f
           WHERE f.targetAccountId = a.id AND f.status <> 'reversed'),0) inflow,
        COALESCE((SELECT SUM(amount) FROM financial_transactions f
           WHERE f.sourceAccountId = a.id AND f.status <> 'reversed'),0) outflow
      FROM financial_accounts a ORDER BY a.businessId, a.code`);

    if (accts.length === 0) line("مفيش حسابات مالية متعرّفة", "—");
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
  });

  // ── 3. The dangerous overlap ─────────────────────────────────────────────
  heading("٣ · هل نفس الحدث اتسجّل في الدفترين؟");

  await section("الأوردرات المزدوجة", async () => {
    // An order collection can be recorded in treasury_transactions (recordOrderCollection)
    // AND as an order_payment in financial_transactions (confirmOrderPayment, which emits a
    // `payment.confirmed` business event). Copying the treasury rows across without
    // checking would double-count every order in this list.
    // Identifying columns only — order id, order number, amounts, dates, source table. No
    // customer name, phone or address is selected anywhere in this script.
    const dupOrders = await q(`SELECT t.referenceId orderId, o.orderNumber,
        'treasury_transactions' treasuryTable, t.id treasuryRowId,
        t.amount treasuryAmount, t.transactionDate treasuryDate,
        'financial_transactions' financialTable, f.id financialRowId,
        f.amount financialAmount, f.occurredAt financialDate
      FROM treasury_transactions t
      JOIN orders o ON o.id = t.referenceId
      JOIN business_events be ON be.sourceType = 'order'
        AND be.sourceReference = CAST(t.referenceId AS CHAR)
        AND be.eventType = 'payment.confirmed'
        AND be.status = 'active'
      JOIN financial_transactions f ON f.businessEventId = be.id AND f.status <> 'reversed'
      WHERE t.referenceType = 'order' AND t.type = 'collection'
      ORDER BY t.referenceId
      LIMIT 500`);

    dupCount = dupOrders.length;
    line("أوردرات متسجّلة في الدفترين", String(dupCount) + (dupCount >= 500 ? "+" : ""));
    if (dupCount > 0 && !asJson) {
      console.log("\n  ⚠ الأوردرات دي هتتحسب مرتين لو نسخنا من غير استثناء:");
      for (const d of dupOrders.slice(0, 15)) {
        console.log(
          `     أوردر ${d.orderNumber} (#${d.orderId})  خزنة ${money(d.treasuryAmount)}  ·  مالي ${money(d.financialAmount)}`
        );
      }
      if (dupCount > 15) console.log(`     ... و${dupCount - 15} غيرهم (كلهم في مخرجات --json)`);
    }
    out.duplicateOrderCollections = dupOrders;
  });

  await section("مصروفات بلا حركة", async () => {
    // Expenses are created in the `expenses` table by V1 and paid through V2. An expense
    // marked paid with no payment row means money left with no ledger entry behind it.
    // description is truncated: business text, not customer data, but no reason to print
    // more of it than identifies the row.
    const orphanExpenses = await q(`SELECT e.id, e.businessId, e.amount, e.paidAmount, e.status,
        LEFT(e.description, 40) descriptionShort
      FROM expenses e
      LEFT JOIN expense_payments p ON p.expenseId = e.id
      WHERE e.status IN ('paid','partially_paid') AND p.id IS NULL
      LIMIT 100`);
    orphanCount = orphanExpenses.length;
    line("مصروفات مدفوعة بلا حركة مالية", String(orphanCount));
    out.orphanExpenses = orphanExpenses;
  });

  // ── 4. Brand attribution ─────────────────────────────────────────────────
  heading("٤ · هل كل حركة ليها براند؟");

  await section("البراند على الحركات", async () => {
    const [ttNoBrand] = await q(`SELECT COUNT(*) rowCount FROM treasury_transactions WHERE businessId IS NULL`);
    const [ftNoBrand] = await q(`SELECT COUNT(*) rowCount FROM financial_transactions WHERE businessId IS NULL`);
    ttNoBrandCount = Number(ttNoBrand.rowCount);
    ftNoBrandCount = Number(ftNoBrand.rowCount);
    line("حركات خزنة بلا براند", String(ttNoBrandCount));
    line("حركات مالية بلا براند", String(ftNoBrandCount));

    const perBrand = await q(`SELECT b.id, b.name,
        (SELECT COUNT(*) FROM treasury_transactions t WHERE t.businessId = b.id) treasuryRows,
        (SELECT COUNT(*) FROM financial_transactions f WHERE f.businessId = b.id) financialRows,
        (SELECT COUNT(*) FROM financial_accounts a WHERE a.businessId = b.id) accountCount
      FROM businesses b ORDER BY b.id`);
    if (!asJson) {
      console.log("");
      for (const b of perBrand) {
        console.log(`  [${b.id}] ${b.name}: خزنة ${b.treasuryRows} · مالي ${b.financialRows} · حسابات ${b.accountCount}`);
      }
    }
    out.perBrand = perBrand;
  });

  // ── 5. Shared-account feasibility ────────────────────────────────────────
  heading("٥ · الحسابات المشتركة");

  await section("الحسابات حسب النوع", async () => {
    // The requirement is one physical cash box and one bank shared by three brands. The
    // schema puts businessId on financial_accounts, so today each brand owns its own. This
    // counts how many separate accounts would have to be merged into one.
    const byType = await q(`SELECT accountType, COUNT(*) accountCount,
        COUNT(DISTINCT businessId) brandCount, SUM(currentBalance) totalBalance
      FROM financial_accounts GROUP BY accountType ORDER BY accountType`);
    if (byType.length === 0) line("مفيش حسابات مالية متعرّفة", "—");
    for (const t of byType) {
      line(`${t.accountType}: ${t.accountCount} حساب عبر ${t.brandCount} براند`, money(t.totalBalance));
    }
    out.accountsByType = byType;
  });

  // ── 6. Verdict ───────────────────────────────────────────────────────────
  heading("٦ · الخلاصة");

  const blockers: string[] = [];
  if (treasuryDrift > 0) blockers.push(`${treasuryDrift} نشاط رصيد خزنته مش مطابق لمجموع حركاته`);
  if (acctDrift > 0) blockers.push(`${acctDrift} حساب مالي رصيده مش مطابق لمجموع حركاته`);
  if (dupCount > 0) blockers.push(`${dupCount} أوردر متسجّل في الدفترين — لازم يتستثنى من النقل`);
  if (orphanCount > 0) blockers.push(`${orphanCount} مصروف مدفوع بلا حركة مالية`);
  if (ttNoBrandCount > 0) blockers.push(`${ttNoBrandCount} حركة خزنة بلا براند`);
  if (ftNoBrandCount > 0) blockers.push(`${ftNoBrandCount} حركة مالية بلا براند`);

  out.blockers = blockers;
  out.failedSections = failures;

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    if (failures.length > 0) {
      console.log("\n  ⚠ أقسام فشلت ولازم تتصلّح قبل ما التقرير يبقى كامل:\n");
      for (const f of failures) console.log(`     • ${f.section}: ${f.error}`);
      console.log("");
    }
    if (blockers.length === 0 && failures.length === 0) {
      console.log("\n  ✅ الدفترين متسقين داخليًا ومفيش تداخل. النقل ممكن يتخطط عليه.\n");
    } else if (blockers.length > 0) {
      console.log("\n  ⛔ لازم تتحل الأول:\n");
      for (const b of blockers) console.log(`     • ${b}`);
      console.log("");
    }
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
