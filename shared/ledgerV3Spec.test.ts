import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  LEDGER_V3_DROP_ORDER, LEDGER_V3_SPEC, LEDGER_V3_TABLES, splitMigrationStatements, verifyLedgerV3, type SchemaSnapshot,
} from "./ledgerV3Spec";

const sqlText = fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8");
const statements = splitMigrationStatements(sqlText);

/** لقطة مطابقة للمواصفة مبنية من المواصفة نفسها (ثم نكسرها عمدًا). */
function perfectSnapshot(): SchemaSnapshot {
  const s: SchemaSnapshot = { tables: new Set(LEDGER_V3_TABLES), columns: {}, uniques: {}, foreignKeys: {}, checks: { ledger_entries: new Set(["ledger_entries_amount_positive"]) } };
  for (const t of LEDGER_V3_TABLES) {
    const spec = LEDGER_V3_SPEC[t];
    s.columns[t] = spec.columns.map(c => ({ name: c.name, columnType: c.type === "enum" ? "enum('a','b')" : c.type, nullable: c.nullable }));
    s.uniques[t] = Object.fromEntries(spec.uniques.map(u => [u.name, [...u.columns]]));
    s.foreignKeys[t] = Object.fromEntries(spec.foreignKeys.map(f => [f.name, { columns: [...f.columns], refTable: f.refTable, refColumns: [...f.refColumns] }]));
  }
  return s;
}

describe("📄 drizzle/0040_ledger_v3.sql — additive، جداول جديدة فقط، ومطابق للمواصفة", () => {
  it("7 عبارات CREATE TABLE بنفس أسماء المواصفة وبترتيب يحترم المفاتيح الأجنبية", () => {
    expect(statements).toHaveLength(7);
    const created = statements.map(s => /CREATE TABLE `([a-z_0-9]+)`/i.exec(s)?.[1]);
    expect(created).toEqual([...LEDGER_V3_TABLES]);
    expect([...LEDGER_V3_DROP_ORDER].reverse()).toEqual([...LEDGER_V3_TABLES]); // الحذف = عكس الإنشاء
  });
  it("لا ALTER/DROP/UPDATE/DELETE/INSERT على أي جدول قديم — الملف لا يلمس المخطط القائم", () => {
    const code = sqlText.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    // (ON UPDATE CURRENT_TIMESTAMP تعريف عمود، لا عبارة UPDATE)
    expect(code).not.toMatch(/\bALTER TABLE\b|\bDROP TABLE\b|^\s*UPDATE\b|^\s*DELETE\b|^\s*INSERT\b|\bTRUNCATE\b/im);
    for (const t of ["treasury_transactions", "financial_accounts", "financial_transactions", "business_events", "accounting_closings"]) expect(code).not.toContain(`\`${t}\``);
  });
  it("كل عمود وفهرس فريد ومفتاح أجنبي من المواصفة مذكور في عبارة الجدول نفسها", () => {
    for (const [i, t] of LEDGER_V3_TABLES.entries()) {
      const stmt = statements[i];
      for (const c of LEDGER_V3_SPEC[t].columns) expect(stmt, `${t}.${c.name}`).toContain(`\`${c.name}\``);
      for (const u of LEDGER_V3_SPEC[t].uniques) if (u.name !== "PRIMARY") expect(stmt, u.name).toContain(`\`${u.name}\` UNIQUE(${u.columns.map(c => `\`${c}\``).join(",")})`);
      for (const f of LEDGER_V3_SPEC[t].foreignKeys)
        expect(stmt, f.name).toContain(`\`${f.name}\` FOREIGN KEY (${f.columns.map(c => `\`${c}\``).join(",")}) REFERENCES \`${f.refTable}\`(${f.refColumns.map(c => `\`${c}\``).join(",")})`);
    }
  });
  it("قرارات المراجعة مثبّتة في الملف: currentBalance، payloadHash، بلا status على الحركات، actorType بلا موظف وهمي، سجل أحداث الفترة، tenantId على الربط، currency، CHECK amount>0", () => {
    const tx = statements[4], entries = statements[5], accounts = statements[0], link = statements[1], events = statements[3];
    expect(accounts).toContain("`currentBalance` decimal(18,4) NOT NULL DEFAULT 0");
    expect(accounts).toContain("`currency` char(3) NOT NULL DEFAULT 'EGP'");
    expect(tx).toContain("`payloadHash` char(64) NOT NULL");
    expect(tx).toContain("`currency` char(3) NOT NULL DEFAULT 'EGP'");
    expect(tx).not.toMatch(/`status`/);
    expect(tx).toContain("`ledger_transactions_reversal_once_unique` UNIQUE(`reversalOfTransactionId`)");
    expect(tx).toContain("`ledger_transactions_tenant_idem_unique` UNIQUE(`tenantId`,`idempotencyKey`)");
    for (const s of [accounts, link, tx, events]) expect(s).toContain("`actorType` enum('employee','system','webhook') NOT NULL");
    for (const s of [accounts, link, tx, events]) expect(s).toContain("`actorEmployeeId` int NULL");
    expect(sqlText).not.toMatch(/`createdBy` int NOT NULL/);
    expect(link).toContain("`tenantId` int NOT NULL");
    expect(events).toContain("`action` enum('lock','reopen') NOT NULL");
    expect(events).toContain("`reason` text NOT NULL");
    expect(entries).toContain("CHECK (`amount` > 0)");
    expect(entries).toContain("`balanceAfter` decimal(18,4) NOT NULL");
  });
});

describe("🧪 verifyLedgerV3 — يكتشف الانحراف", () => {
  it("لقطة مطابقة → صفر مشاكل", () => expect(verifyLedgerV3(perfectSnapshot())).toEqual([]));
  it("جدول ناقص، عمود بنوع مختلف، فهرس فريد ناقص، FK بمرجع آخر، CHECK ناقص — كلها تُبلَّغ", () => {
    const s = perfectSnapshot();
    s.tables.delete("ledger_tenant_flags");
    s.columns.ledger_accounts.find(c => c.name === "currentBalance")!.columnType = "decimal(10,2)";
    delete s.uniques.ledger_transactions.ledger_transactions_tenant_idem_unique;
    s.foreignKeys.ledger_entries.fk_le_tenant_account.refTable = "financial_accounts";
    s.checks.ledger_entries.clear();
    const issues = verifyLedgerV3(s);
    expect(issues.map(i => i.kind).sort()).toEqual(["check", "column", "foreign_key", "table", "unique"]);
  });
});
