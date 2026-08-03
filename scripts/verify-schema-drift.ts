/**
 * Schema drift verification — READ ONLY.
 *
 * Drizzle's migration history knows about 37 tables. `drizzle/schema.ts` declares 69. The
 * other 32 — every accounting table among them — were created outside the migration system,
 * so `drizzle-kit generate` diffs against a snapshot that predates them and emits CREATE
 * TABLE for tables that already exist. Running that against production fails on the first
 * statement.
 *
 * Repairing that means telling Drizzle "this state is already true". Before we can honestly
 * say so, we have to check it: does production actually match what schema.ts declares, table
 * by table and column by column?
 *
 * This script answers that and writes NOTHING. It reads `information_schema` and compares it
 * against the Drizzle table definitions themselves — not a hand-copied list, so it cannot
 * drift from the code it is checking. Two guards: MySQL refuses writes for the life of the
 * connection, and the query helper rejects any statement that is not a SELECT.
 *
 *   corepack pnpm tsx scripts/verify-schema-drift.ts
 *   corepack pnpm tsx scripts/verify-schema-drift.ts --json > drift.json
 *   corepack pnpm tsx scripts/verify-schema-drift.ts --table financial_accounts
 */

import "dotenv/config";
import mysql from "mysql2/promise";
import { getTableConfig } from "drizzle-orm/mysql-core";
import * as schema from "../drizzle/schema";

const asJson = process.argv.includes("--json");
const onlyTableArg = process.argv.indexOf("--table");
const onlyTable = onlyTableArg > -1 ? process.argv[onlyTableArg + 1] : null;

type ColumnExpectation = { name: string; notNull: boolean; sqlType: string };
type TableExpectation = { table: string; columns: ColumnExpectation[] };

/** Every table Drizzle declares, read from the definitions rather than a copied list. */
function expectedTables(): TableExpectation[] {
  const out: TableExpectation[] = [];
  for (const value of Object.values(schema)) {
    let config;
    try {
      config = getTableConfig(value as any);
    } catch {
      continue; // not a table (a type, an enum, a helper)
    }
    out.push({
      table: config.name,
      columns: config.columns.map(c => ({
        name: c.name,
        notNull: c.notNull,
        sqlType: c.getSQLType().toLowerCase(),
      })),
    });
  }
  return out.sort((a, b) => a.table.localeCompare(b.table));
}

function heading(title: string) {
  if (asJson) return;
  console.log("\n" + "═".repeat(74));
  console.log("  " + title);
  console.log("═".repeat(74));
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set. Run this inside the app container.");
    process.exit(1);
  }

  const db = await mysql.createConnection(url);
  await db.query("START TRANSACTION READ ONLY");
  const q = async <T = any>(sql: string, args: any[] = []): Promise<T[]> => {
    if (!/^\s*select/i.test(sql)) throw new Error("Refusing to run a non-SELECT statement");
    const [rows] = await db.execute(sql, args);
    return rows as T[];
  };

  const [{ db: dbName }] = await q<{ db: string }>("SELECT DATABASE() AS db");

  const liveTables = new Set(
    (
      await q<{ TABLE_NAME: string }>(
        "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
        [dbName]
      )
    ).map(r => r.TABLE_NAME)
  );

  const liveColumns = await q<{
    TABLE_NAME: string; COLUMN_NAME: string; IS_NULLABLE: string; COLUMN_TYPE: string;
  }>(
    `SELECT TABLE_NAME, COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`,
    [dbName]
  );

  const byTable = new Map<string, Map<string, { nullable: boolean; type: string }>>();
  for (const c of liveColumns) {
    const t = byTable.get(c.TABLE_NAME) ?? new Map();
    t.set(c.COLUMN_NAME, {
      nullable: c.IS_NULLABLE === "YES",
      type: c.COLUMN_TYPE.toLowerCase(),
    });
    byTable.set(c.TABLE_NAME, t);
  }

  let expected = expectedTables();
  if (onlyTable) expected = expected.filter(t => t.table === onlyTable);

  const missingTables: string[] = [];
  const missingColumns: { table: string; column: string; sqlType: string; notNull: boolean }[] = [];
  const nullabilityDiffs: { table: string; column: string; code: string; live: string }[] = [];
  const extraColumns: { table: string; column: string }[] = [];
  const okTables: string[] = [];

  for (const t of expected) {
    if (!liveTables.has(t.table)) {
      missingTables.push(t.table);
      continue;
    }
    const live = byTable.get(t.table) ?? new Map();
    let clean = true;

    for (const col of t.columns) {
      const found = live.get(col.name);
      if (!found) {
        // The dangerous class: Drizzle expands db.select() to an explicit column list, so a
        // column the code knows and the database lacks fails every query on that table.
        missingColumns.push({
          table: t.table, column: col.name, sqlType: col.sqlType, notNull: col.notNull,
        });
        clean = false;
        continue;
      }
      if (found.nullable === col.notNull) {
        nullabilityDiffs.push({
          table: t.table,
          column: col.name,
          code: col.notNull ? "NOT NULL" : "NULL",
          live: found.nullable ? "NULL" : "NOT NULL",
        });
        clean = false;
      }
    }

    const declared = new Set(t.columns.map(c => c.name));
    for (const name of live.keys()) {
      // Harmless: the database has something the code ignores. Reported, not a blocker.
      if (!declared.has(name)) extraColumns.push({ table: t.table, column: name });
    }

    if (clean) okTables.push(t.table);
  }

  // ── Report ────────────────────────────────────────────────────────────────
  heading("١ · الجداول");
  if (!asJson) {
    console.log(`  قاعدة البيانات                 ${dbName}`);
    console.log(`  جداول معرّفة في الكود           ${expected.length}`);
    console.log(`  موجودة في الإنتاج ومطابقة      ${okTables.length}`);
    console.log(`  ناقصة من الإنتاج               ${missingTables.length}`);
  }
  if (missingTables.length && !asJson) {
    console.log("\n  ⛔ الجداول دي الكود بيتوقعها ومش موجودة:");
    for (const t of missingTables) console.log(`     • ${t}`);
  }

  heading("٢ · الأعمدة الناقصة — أخطر نوع");
  if (!asJson) {
    if (missingColumns.length === 0) {
      console.log("  ✅ مفيش. كل عمود الكود بيعرفه موجود في قاعدة البيانات.");
    } else {
      console.log("  ⛔ الأعمدة دي بتخلّي كل استعلام على جدولها يفشل:\n");
      for (const c of missingColumns) {
        console.log(`     • ${c.table}.${c.column}  (${c.sqlType}${c.notNull ? ", NOT NULL" : ""})`);
      }
    }
  }

  heading("٣ · اختلافات NULL / NOT NULL");
  if (!asJson) {
    if (nullabilityDiffs.length === 0) {
      console.log("  ✅ مفيش اختلاف.");
    } else {
      for (const d of nullabilityDiffs) {
        console.log(`     • ${d.table}.${d.column}  الكود: ${d.code}  |  الإنتاج: ${d.live}`);
      }
    }
  }

  heading("٤ · أعمدة في الإنتاج والكود مش عارفها");
  if (!asJson) {
    if (extraColumns.length === 0) console.log("  ✅ مفيش.");
    else {
      console.log("  (مش خطر — الكود بيتجاهلها)\n");
      for (const c of extraColumns.slice(0, 40)) console.log(`     • ${c.table}.${c.column}`);
      if (extraColumns.length > 40) console.log(`     ... و${extraColumns.length - 40} غيرهم`);
    }
  }

  // financial_accounts is the table the shared-accounts change touches, so print its live
  // shape in full — the migration will be written against exactly this.
  if (!onlyTable || onlyTable === "financial_accounts") {
    heading("٥ · financial_accounts — الشكل الفعلي في الإنتاج");
    const live = byTable.get("financial_accounts");
    if (!live) {
      if (!asJson) console.log("  ⛔ الجدول نفسه مش موجود.");
    } else if (!asJson) {
      for (const [name, meta] of live) {
        console.log(`     ${name.padEnd(24)} ${meta.type.padEnd(18)} ${meta.nullable ? "NULL" : "NOT NULL"}`);
      }
    }
  }

  heading("٦ · الخلاصة");
  const safeForBaseline = missingTables.length === 0 && missingColumns.length === 0;
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          database: dbName,
          expectedTableCount: expected.length,
          okTables,
          missingTables,
          missingColumns,
          nullabilityDiffs,
          extraColumns,
          financialAccounts: Object.fromEntries(byTable.get("financial_accounts") ?? []),
          safeForBaseline,
        },
        null,
        2
      )
    );
  } else if (safeForBaseline) {
    console.log("\n  ✅ الإنتاج مطابق للكود في كل الجداول والأعمدة.");
    console.log("     الـbaseline بيبقى تسجيل حالة متحققة فعلًا، مش افتراض.\n");
    if (nullabilityDiffs.length > 0) {
      console.log("     ⚠ فيه اختلافات NULL/NOT NULL فوق — مش بتكسر الاستعلامات،");
      console.log("       لكن لازم تتراجع قبل ما نعتمد الـbaseline.\n");
    }
  } else {
    console.log("\n  ⛔ الإنتاج مش مطابق للكود. الـbaseline مينفعش دلوقتي.");
    console.log("     أي جدول أو عمود ناقص فوق لازم نفهمه الأول.\n");
  }

  await db.query("ROLLBACK");
  await db.end();
}

main().catch(e => {
  const safe = String(e?.message ?? e)
    .replace(/\b[a-z]+:\/\/[^\s]*/gi, "[connection-string-redacted]")
    .replace(/(password|pwd|token|secret)\s*[:=]\s*\S+/gi, "$1=[redacted]");
  console.error("فشل:", safe);
  process.exit(1);
});
