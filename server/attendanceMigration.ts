import { ATTENDANCE_SPEC, ATTENDANCE_TABLES } from "../shared/attendanceSpec";
import type { HandMigrationDef } from "./handMigration.service";

/** تعريف 0042 لمحرّك الـMigrations اليدوية — يشترط الفهرسين المركّبين (من 0040 أو 0041). */
export const ATTENDANCE_MIGRATION: HandMigrationDef = {
  id: "0042",
  title: "0042 attendance",
  tables: [...ATTENDANCE_TABLES],
  specs: ATTENDANCE_SPEC,
  lateForeignKeys: [{ table: "attendance_correction_requests", name: "fk_acr_tenant_employee_target_event" }],
  compositeIndexes: "require_present",
};
