/**
 * Legacy tenant backfill — multi-tenant Migration A + Migration C.
 *
 * Creates the single pre-multi-tenant "legacy" tenant (resolved by a stable slug — NEVER
 * assumed to be id=1) if it doesn't already exist, then backfills tenantId on businesses,
 * business_groups, employees, and import_batches from real ownership relationships. Rows that
 * cannot be safely resolved are reported, never silently assigned.
 *
 * Default mode is DRY RUN — prints exactly what it would change without writing anything.
 * Pass --commit to actually write. Safe to re-run: every step only touches rows that still
 * need it (idempotent — already-backfilled rows are skipped).
 *
 * This script does NOT make any tenantId column NOT NULL and does NOT add any foreign key or
 * index — that is Migration D, and only after every query in drizzle/validation-queries.sql
 * returns zero rows against the post-backfill data.
 *
 * Usage:
 *   Dry run (safe, default, no writes):
 *     tsx scripts/backfillLegacyTenant.ts
 *
 *   Commit (writes to DB):
 *     tsx scripts/backfillLegacyTenant.ts --commit
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { getDb } from "../server/db";
import { tenants, businesses, businessGroups, employees, importBatches } from "../drizzle/schema";

const LEGACY_TENANT_SLUG = "legacy-default";
const LEGACY_TENANT_NAME = "الحساب الأصلي (قبل تعدد التجار)";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const db = await getDb();
  if (!db) {
    console.error("Database not available — aborting.");
    process.exit(1);
  }

  console.log(COMMIT ? "=== COMMIT MODE — writes will happen ===" : "=== DRY RUN — no writes will happen ===");

  // ---- Step A (Migration A): resolve or create the legacy tenant, by slug ----
  const existingTenant = await db.select().from(tenants).where(eq(tenants.slug, LEGACY_TENANT_SLUG)).limit(1);
  let legacyTenantId: number;
  if (existingTenant.length > 0) {
    legacyTenantId = existingTenant[0].id;
    console.log(`Legacy tenant already exists: id=${legacyTenantId}, slug="${LEGACY_TENANT_SLUG}"`);
  } else if (COMMIT) {
    const result = await db.insert(tenants).values({
      name: LEGACY_TENANT_NAME,
      slug: LEGACY_TENANT_SLUG,
      status: "active",
    });
    legacyTenantId = (result as any).insertId as number;
    console.log(`Created legacy tenant: id=${legacyTenantId}, slug="${LEGACY_TENANT_SLUG}"`);
  } else {
    console.log(`[DRY RUN] Would create legacy tenant with slug="${LEGACY_TENANT_SLUG}" (id not yet known)`);
    legacyTenantId = -1; // placeholder id, dry-run reporting only — never written
  }

  // ---- Step B (Migration C, part 1): backfill businesses.tenantId ----
  const allBusinesses = await db.select().from(businesses);
  const knownTenantIds = new Set((await db.select({ id: tenants.id }).from(tenants)).map(t => t.id));
  if (legacyTenantId > 0) knownTenantIds.add(legacyTenantId);
  const businessesNeedingBackfill = allBusinesses.filter(b => b.tenantId == null || !knownTenantIds.has(b.tenantId));
  console.log(`\n-- businesses needing tenantId backfill: ${businessesNeedingBackfill.length}`);
  for (const b of businessesNeedingBackfill) {
    console.log(`  business #${b.id} (${b.name}): tenantId ${b.tenantId ?? "NULL"} -> ${legacyTenantId}`);
    if (COMMIT) await db.update(businesses).set({ tenantId: legacyTenantId }).where(eq(businesses.id, b.id));
  }

  // ---- Step C (Migration C, part 2): backfill employees.tenantId ----
  const allEmployees = await db.select().from(employees);
  const businessTenantMap = new Map(allBusinesses.map(b => [b.id, b.tenantId]));
  let resolvedViaBusiness = 0, resolvedViaLegacy = 0, unresolved = 0;
  console.log(`\n-- employees needing tenantId backfill: ${allEmployees.filter(e => e.tenantId == null).length}`);
  for (const e of allEmployees) {
    if (e.tenantId != null) continue; // already backfilled — idempotent re-run
    if (e.businessId != null) {
      const bizExists = allBusinesses.some(b => b.id === e.businessId);
      if (!bizExists) {
        console.log(`  [UNRESOLVED] employee #${e.id} (${e.name}): businessId=${e.businessId} does not exist — skipped, needs manual review`);
        unresolved++;
        continue;
      }
      const inheritedTenantId = businessTenantMap.get(e.businessId) ?? legacyTenantId;
      console.log(`  employee #${e.id} (${e.name}): tenantId -> ${inheritedTenantId} (inherited from business #${e.businessId})`);
      resolvedViaBusiness++;
      if (COMMIT) await db.update(employees).set({ tenantId: inheritedTenantId }).where(eq(employees.id, e.id));
    } else {
      // No businessId at all (the normal shape for every current admin-tier employee). Before
      // this migration the whole system had exactly one tenant, so an employee with no specific
      // business assignment belongs to that one tenant — a documented, reviewed, one-time
      // historical fact from this script, never a runtime fallback in application code.
      console.log(`  employee #${e.id} (${e.name}): tenantId -> ${legacyTenantId} (no businessId — single pre-existing tenant)`);
      resolvedViaLegacy++;
      if (COMMIT) await db.update(employees).set({ tenantId: legacyTenantId }).where(eq(employees.id, e.id));
    }
  }
  console.log(`  summary: ${resolvedViaBusiness} resolved via business, ${resolvedViaLegacy} resolved via legacy tenant, ${unresolved} UNRESOLVED (needs manual review before Migration D)`);

  // ---- Step D (Migration C, part 3): backfill business_groups.tenantId ----
  const allGroups = await db.select().from(businessGroups);
  console.log(`\n-- business_groups needing tenantId backfill: ${allGroups.filter(g => g.tenantId == null).length}`);
  for (const g of allGroups) {
    if (g.tenantId != null) continue;
    const owningBusiness = allBusinesses.find(b => b.groupId === g.id);
    const resolvedTenantId = owningBusiness?.tenantId ?? legacyTenantId;
    console.log(
      `  business_group #${g.id} (${g.name}): tenantId -> ${resolvedTenantId}` +
      (owningBusiness ? ` (via business #${owningBusiness.id})` : " (no owning business — single pre-existing tenant)")
    );
    if (COMMIT) await db.update(businessGroups).set({ tenantId: resolvedTenantId }).where(eq(businessGroups.id, g.id));
  }

  // ---- Step E (Migration C, part 4 — only if import_batches.tenantId is approved/present) ----
  console.log(`\n-- import_batches tenantId backfill (skipped cleanly if the column isn't present)`);
  try {
    const allBatches = await db.select().from(importBatches);
    const employeeTenantMap = new Map(allEmployees.map(e => [e.id, e.tenantId]));
    for (const batch of allBatches) {
      if ((batch as any).tenantId != null) continue;
      const viaEmployee = employeeTenantMap.get(batch.performedBy);
      const resolvedTenantId = viaEmployee ?? legacyTenantId;
      console.log(
        `  import_batch #${batch.id} (${batch.label}): tenantId -> ${resolvedTenantId}` +
        (viaEmployee ? ` (via performedBy employee #${batch.performedBy})` : " (performedBy employee unresolved — single pre-existing tenant)")
      );
      if (COMMIT) await db.update(importBatches).set({ tenantId: resolvedTenantId } as any).where(eq(importBatches.id, batch.id));
    }
  } catch (err) {
    console.log("  skipped:", (err as Error).message);
  }

  console.log(COMMIT ? "\n=== Done (committed) ===" : "\n=== Done (dry run — nothing was written; re-run with --commit to apply) ===");
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
