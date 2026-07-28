# Multi-tenant deployment sequence

This is the required order for deploying the tenant-isolation work. **Steps 2–7 must happen
before step 8 (deploying the strict runtime tenant enforcement) — deploying the runtime code
first, against un-backfilled production data, locks out every existing employee**, because
`employees.tenantId` is NULL for every current row and the new runtime rejects any authenticated
session with no resolvable tenant (see `server/_core/context.ts`, no fallback to any default
tenant).

1. **Database backup.** Full backup of the production database before touching anything.
2. **Apply the additive/corrective tenant schema**, in order:
   `drizzle/0028_next_grandmaster.sql` (already committed — creates tenants/subscriptions/
   payment_gateway_configs, adds `businesses.tenantId` as `NOT NULL DEFAULT 1`),
   `drizzle/0029_puzzling_genesis.sql` (new tables `plan_features`/`plan_limits`, adds
   `business_groups.tenantId` / `employees.tenantId` / `import_batches.tenantId` — all nullable,
   no default), `drizzle/0030_bright_lenny_balinger.sql` (corrective — walks `businesses.tenantId`
   back to nullable with no default; 0028 is left untouched since it's unknown whether it has
   already run against a real database). No drops, no data deleted by any of the three.
3. **Create/verify the legacy tenant.** Run `tsx scripts/backfillLegacyTenant.ts` (dry run,
   default — no `--commit`) and review the report. It resolves or creates the legacy tenant by
   the stable slug `legacy-default`, never by an assumed id.
4. **Backfill businesses and employees** (and business_groups, and import_batches if approved).
   Run `tsx scripts/backfillLegacyTenant.ts --commit`. Re-run is safe/idempotent — it only
   touches rows still missing a tenantId.
5. **Run the validation queries** in `drizzle/validation-queries.sql` against the now-backfilled
   database. Every query must return zero rows. Any non-empty result is a stop condition — do
   not proceed to step 6 until it's resolved (either by re-running the backfill script or by a
   manual, reviewed decision on the specific orphaned rows).
6. **Apply NOT NULL and constraints** (Migration D — not yet written; produced after step 5 is
   clean, since drizzle-kit needs the live schema state to diff against, and adding a NOT NULL
   constraint before the data is clean would fail or corrupt intent).
7. **Smoke test authentication** against the migrated database: confirm a real admin/manager
   login still works end to end (this exercises the exact `context.ts` code path that will
   reject anyone with a NULL tenantId).
8. **Deploy the strict runtime tenant enforcement** (the current uncommitted `context.ts` /
   `trpc.ts` / `routers.ts` changes) — only now, after steps 2–7 are confirmed against the real
   production database.
9. **Run smoke tests** against the deployed application: login, view orders, view products,
   confirm an order, create an employee — confirm the created employee inherits the acting
   admin's tenantId (see `employees.create` / `employeePortal.createEmployee` in `routers.ts`).
10. **Rollback policy:** if something breaks, roll back the **application deploy only** (revert
    to the previous release). Do not delete or revert the migrated tenant/backfill data — it is
    additive and harmless to leave in place even if the application is rolled back to
    pre-multi-tenant code, since old code simply never reads the new columns.
