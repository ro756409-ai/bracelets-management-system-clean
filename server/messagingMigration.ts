import { MESSAGING_SPEC, MESSAGING_TABLES } from "../shared/messagingSpec";
import type { HandMigrationDef } from "./handMigration.service";

/** تعريف 0043 لمحرّك الـMigrations اليدوية — يشترط الفهرسين المركّبين (من 0040 أو 0041). بلا FK لاحق. */
export const MESSAGING_MIGRATION: HandMigrationDef = {
  id: "0043",
  title: "0043 messaging",
  tables: [...MESSAGING_TABLES],
  specs: MESSAGING_SPEC,
  lateForeignKeys: [],
  compositeIndexes: "require_present",
};
