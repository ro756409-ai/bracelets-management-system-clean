import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  LEDGER_V3_DROP_ORDER, LEDGER_V3_OLD_TABLE_INDEXES, LEDGER_V3_SPEC, LEDGER_V3_TABLES, applicationState,
  splitMigrationStatements, verifyLedgerV3, type SchemaSnapshot,
} from "./ledgerV3Spec";

const sqlText = fs.readFileSync("drizzle/0040_ledger_v3.sql", "utf-8");
const statements = splitMigrationStatements(sqlText);
const alterStatements = statements.slice(0, 2);
const createStatements = statements.slice(2);

/** لقطة مطابقة للمواصفة مبنية من المواصفة نفسها (ثم نكسرها عمدًا). */
function perfectSnapshot(): SchemaSnapshot {
  const s: SchemaSnapshot = { tables: new Set(LEDGER_V3_TABLES), columns: {}, uniques: {}, foreignKeys: {}, checks: { ledger_entries: new Set(["ledger_entries_amount_positive"]) } };
  for (const t of LEDGER_V3_TABLES) {
    const spec = LEDGER_V3_SPEC[t];
    s.columns[t] = spec.columns.map(c => ({ name: c.name, columnType: c.type === "enum" ? "enum('a','b')" : c.type, nullable: c.nullable }));
    s.uniques[t] = Object.fromEntries(spec.uniques.map(u => [u.name, [...u.columns]]));
    s.foreignKeys[t] = Object.fromEntries(spec.foreignKeys.map(f => [f.name, { columns: [...f.columns], refTable: f.refTable, refColumns: [...f.refColumns] }]));
  }
  for (const oi of LEDGER_V3_OLD_TABLE_INDEXES) (s.uniques[oi.table] ??= {})[oi.name] = [...oi.columns];
  return s;
}

describe("📄 drizzle/0040_ledger_v3.sql — additive: فهرسان مركّبان على القديم + 7 جداول جديدة، مطابق للمواصفة", () => {
  it("9 عبارات: ALTER (فهرس فريد مركّب) على businesses ثم employees، ثم 7 CREATE TABLE بترتيب المفاتيح الأجنبية", () => {
    expect(statements).toHaveLength(9);
    expect(alterStatements[0]).toBe("ALTER TABLE `businesses` ADD UNIQUE INDEX `businesses_tenant_id` (`tenantId`,`id`);");
    expect(alterStatements[1]).toBe("ALTER TABLE `employees` ADD UNIQUE INDEX `employees_tenant_id` (`tenantId`,`id`);");
    const created = createStatements.map(s => /CREATE TABLE `([a-z_0-9]+)`/i.exec(s)?.[1]);
    expect(created).toEqual([...LEDGER_V3_TABLES]);
    expect([...LEDGER_V3_DROP_ORDER].reverse()).toEqual([...LEDGER_V3_TABLES]);
  });
  it("لا يمس الجداول القديمة إلا بإضافة الفهرسين: لا تعديل أعمدة ولا DROP/UPDATE/DELETE/INSERT", () => {
    const code = sqlText.split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    const alters = code.match(/^\s*ALTER TABLE[^\n]*/gim) ?? [];
    expect(alters).toHaveLength(2);
    for (const a of alters) expect(a).toMatch(/ADD UNIQUE INDEX `(businesses|employees)_tenant_id` \(`tenantId`,`id`\);$/);
    expect(code).not.toMatch(/\bDROP\b|^\s*UPDATE\b|^\s*DELETE\b|^\s*INSERT\b|\bTRUNCATE\b|\bMODIFY\b|\bCHANGE\b|\bADD COLUMN\b/im);
    for (const t of ["treasury_transactions", "financial_accounts", "financial_transactions", "business_events", "accounting_closings"]) expect(code).not.toContain(`\`${t}\``);
  });
  it("كل عمود وفهرس فريد ومفتاح أجنبي من المواصفة مذكور في عبارة الجدول نفسها — وكل علاقة نشاط/موظف مركّبة بالـtenant", () => {
    for (const [i, t] of LEDGER_V3_TABLES.entries()) {
      const stmt = createStatements[i];
      for (const c of LEDGER_V3_SPEC[t].columns) expect(stmt, `${t}.${c.name}`).toContain(`\`${c.name}\``);
      for (const u of LEDGER_V3_SPEC[t].uniques) if (u.name !== "PRIMARY") expect(stmt, u.name).toContain(`\`${u.name}\` UNIQUE(${u.columns.map(c => `\`${c}\``).join(",")})`);
      for (const f of LEDGER_V3_SPEC[t].foreignKeys)
        expect(stmt, f.name).toContain(`\`${f.name}\` FOREIGN KEY (${f.columns.map(c => `\`${c}\``).join(",")}) REFERENCES \`${f.refTable}\`(${f.refColumns.map(c => `\`${c}\``).join(",")})`);
      // لا FK بسيط إلى businesses(id) أو employees(id) — كلها مركّبة
      expect(stmt).not.toMatch(/REFERENCES `(businesses|employees)`\(`id`\)/);
      for (const f of LEDGER_V3_SPEC[t].foreignKeys.filter(f => f.refTable === "businesses" || f.refTable === "employees"))
        expect(f.columns[0] + "|" + f.refColumns.join(",")).toBe("tenantId|tenantId,id");
    }
  });
  it("قرارات المراجعة مثبّتة: currentBalance، payloadHash، بلا status، actorType/actorEmployeeId NULL، سجل أحداث الفترة بسبب، tenantId على الربط، currency، CHECK amount>0", () => {
    const [accounts, link, , events, tx, entries] = createStatements;
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

describe("🧪 verifyLedgerV3 / applicationState — يكتشف الانحراف والتطبيق الجزئي", () => {
  it("لقطة مطابقة → صفر مشاكل وحالة applied", () => {
    expect(verifyLedgerV3(perfectSnapshot())).toEqual([]);
    expect(applicationState(perfectSnapshot())).toBe("applied");
  });
  it("جدول ناقص، عمود بنوع مختلف، فهرس فريد ناقص، FK بمرجع آخر، فهرس قديم ناقص، CHECK ناقص — كلها تُبلَّغ", () => {
    const s = perfectSnapshot();
    s.tables.delete("ledger_tenant_flags");
    s.columns.ledger_accounts.find(c => c.name === "currentBalance")!.columnType = "decimal(10,2)";
    delete s.uniques.ledger_transactions.ledger_transactions_tenant_idem_unique;
    s.foreignKeys.ledger_entries.fk_le_tenant_business.refColumns = ["id"];
    delete s.uniques.employees.employees_tenant_id;
    s.checks.ledger_entries.clear();
    const issues = verifyLedgerV3(s);
    expect(issues.map(i => i.kind).sort()).toEqual(["check", "column", "foreign_key", "old_index", "table", "unique"]);
    expect(applicationState(s)).toBe("partial");
  });
  it("لا شيء مطبَّق → not_applied", () => {
    expect(applicationState({ tables: new Set(), columns: {}, uniques: {}, foreignKeys: {}, checks: {} })).toBe("not_applied");
  });
});
