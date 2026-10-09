import { ORDER_EVENTS_SPEC, ORDER_EVENTS_TABLE } from "../shared/orderEventsSpec";
import type { HandMigrationDef } from "./handMigration.service";

/** تعريف 0041 لمحرّك الـMigrations اليدوية (يُنشئ الفهرسين المركّبين إن كانا غائبين). */
export const ORDER_EVENTS_MIGRATION: HandMigrationDef = {
  id: "0041",
  title: "0041 order_activity_events",
  tables: [ORDER_EVENTS_TABLE],
  specs: { [ORDER_EVENTS_TABLE]: ORDER_EVENTS_SPEC },
  lateForeignKeys: [],
  compositeIndexes: "create_if_absent",
};
