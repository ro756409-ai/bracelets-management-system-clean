import { TEAMS_SPEC, TEAMS_TABLES } from "../shared/teamsSpec";
import type { HandMigrationDef } from "./handMigration.service";

/** تعريف 0044 لمحرّك الـMigrations اليدوية — يشترط الفهرسين المركّبين (من 0040 أو 0041). بلا FK لاحق. */
export const TEAMS_MIGRATION: HandMigrationDef = {
  id: "0044",
  title: "0044 teams",
  tables: [...TEAMS_TABLES],
  specs: TEAMS_SPEC,
  lateForeignKeys: [],
  compositeIndexes: "require_present",
};
