import { CARRIER_SPEC, CARRIER_TABLES, LEGACY_ARCHIVE_SPEC, LEGACY_ARCHIVE_TABLES, PAYROLL_SPEC, PAYROLL_TABLES, SNAPSHOT_SPEC, SNAPSHOT_TABLES, SUPPLIER_SPEC, SUPPLIER_TABLES } from "../shared/ledgerPhaseTablesSpec";
import type { HandMigrationDef } from "./handMigration.service";

/** تعريفات 0047–0051 لمحرّك الـMigrations اليدوية — تشترط الفهرسين المركّبين وجداول 0040 (preflight)، بلا FK لاحق. */
const LEDGER_0040 = ["ledger_accounts", "ledger_transactions", "ledger_periods", "ledger_period_events"];

export const LEDGER_CARRIER_MIGRATION: HandMigrationDef = {
  id: "0047", title: "0047 ledger carrier", tables: [...CARRIER_TABLES], specs: CARRIER_SPEC, lateForeignKeys: [], compositeIndexes: "require_present", requiresTables: LEDGER_0040,
};
export const LEDGER_PAYROLL_MIGRATION: HandMigrationDef = {
  id: "0048", title: "0048 ledger payroll", tables: [...PAYROLL_TABLES], specs: PAYROLL_SPEC, lateForeignKeys: [], compositeIndexes: "require_present", requiresTables: LEDGER_0040,
};
export const LEDGER_SUPPLIERS_MIGRATION: HandMigrationDef = {
  id: "0049", title: "0049 ledger suppliers", tables: [...SUPPLIER_TABLES], specs: SUPPLIER_SPEC, lateForeignKeys: [], compositeIndexes: "require_present", requiresTables: LEDGER_0040,
};
export const LEDGER_SNAPSHOTS_MIGRATION: HandMigrationDef = {
  id: "0050", title: "0050 ledger period snapshots", tables: [...SNAPSHOT_TABLES], specs: SNAPSHOT_SPEC, lateForeignKeys: [], compositeIndexes: "require_present", requiresTables: LEDGER_0040,
};
export const LEDGER_LEGACY_ARCHIVE_MIGRATION: HandMigrationDef = {
  id: "0051", title: "0051 ledger legacy archive events", tables: [...LEGACY_ARCHIVE_TABLES], specs: LEGACY_ARCHIVE_SPEC, lateForeignKeys: [], compositeIndexes: "require_present", requiresTables: LEDGER_0040,
};

export const LEDGER_PHASE_MIGRATIONS = [
  { def: LEDGER_CARRIER_MIGRATION, file: "drizzle/0047_ledger_carrier.sql" },
  { def: LEDGER_PAYROLL_MIGRATION, file: "drizzle/0048_ledger_payroll.sql" },
  { def: LEDGER_SUPPLIERS_MIGRATION, file: "drizzle/0049_ledger_suppliers.sql" },
  { def: LEDGER_SNAPSHOTS_MIGRATION, file: "drizzle/0050_ledger_period_snapshots.sql" },
  { def: LEDGER_LEGACY_ARCHIVE_MIGRATION, file: "drizzle/0051_ledger_legacy_archive.sql" },
] as const;
