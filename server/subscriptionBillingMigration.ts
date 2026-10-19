import { SUBSCRIPTION_BILLING_SPEC, SUBSCRIPTION_BILLING_TABLES } from "../shared/subscriptionBillingSpec";
import type { HandMigrationDef } from "./handMigration.service";

/** 0055 لمحرّك الـMigrations اليدوية — 3 جداول جديدة بس (بلا تعديل أي جدول قائم)، بلا FK لاحق. */
export const SUBSCRIPTION_BILLING_MIGRATION: HandMigrationDef = {
  id: "0055", title: "0055 subscription billing", tables: [...SUBSCRIPTION_BILLING_TABLES], specs: SUBSCRIPTION_BILLING_SPEC,
  lateForeignKeys: [], compositeIndexes: "require_present",
};
export const SUBSCRIPTION_BILLING_FILE = "drizzle/0055_subscription_billing.sql";
