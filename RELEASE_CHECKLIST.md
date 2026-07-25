# Release Checklist — Matjarak RBAC + Legacy Import Release

Follow this in order on the real deployment target. Every DB-writing step has a
confirm/rollback path — do not skip the backup step. See [PROJECT_CONTEXT.md](PROJECT_CONTEXT.md)
for the "why" behind each system referenced here.

## 0. Before you start

- [ ] Confirm `DATABASE_URL` in the target environment's `.env` points at the correct
      (staging or production) database — never run this against the wrong database.
- [ ] Confirm `JWT_SECRET` is set to a real, long, random, secret value in that
      environment (not the sandbox placeholder).

## 1. Database backup

- [ ] Take a full backup before running any migration:
  ```bash
  mysqldump -h <host> -u <user> -p <database> > backup-pre-0022-$(date +%Y%m%d-%H%M).sql
  ```
- [ ] Verify the backup file is non-empty and store it somewhere outside the app server.

## 2. Apply the migrations

Migrations `drizzle/0022_giant_slapstick.sql` **and** `drizzle/0023_magenta_warbound.sql`
are already generated (offline, checked into git) — they do **not** need to be regenerated.
`drizzle-kit migrate` applies every pending migration in order in one run:

```bash
corepack pnpm exec drizzle-kit migrate
```

- [ ] Run the command above with the real `DATABASE_URL` loaded.
- [ ] Verify 0022 success: `import_batches` table exists, `employees.role` and
      `orders.source` enums include the new values, `employees.lastLoginAt` and
      `orders.importBatchId` columns exist.
  ```sql
  SHOW COLUMNS FROM employees LIKE 'lastLoginAt';
  SHOW COLUMNS FROM orders LIKE 'importBatchId';
  SHOW TABLES LIKE 'import_batches';
  ```
- [ ] Verify 0023 success: `product_variants.name` and `products.description` columns exist,
      `products.sku`/`products.price` are nullable.
  ```sql
  SHOW COLUMNS FROM product_variants LIKE 'name';
  SHOW COLUMNS FROM products LIKE 'description';
  SHOW COLUMNS FROM products LIKE 'sku';   -- Null column should say YES
  ```
- [ ] Confirm no data loss: row counts on `employees`, `orders`, `products` unchanged from
      before the migration.

**Rollback (manual — no down-migration files exist)**, only if something is wrong:
```sql
-- 0023 rollback
ALTER TABLE product_variants DROP COLUMN name;
ALTER TABLE products DROP COLUMN description;
ALTER TABLE products MODIFY COLUMN sku varchar(50) NOT NULL;     -- fails if any row has sku IS NULL
ALTER TABLE products MODIFY COLUMN price decimal(10,2) NOT NULL; -- fails if any row has price IS NULL

-- 0022 rollback
DROP TABLE import_batches;
ALTER TABLE orders DROP COLUMN importBatchId;
ALTER TABLE employees DROP COLUMN lastLoginAt;
ALTER TABLE employees MODIFY COLUMN role
  ENUM('agent','warehouse','manager','facebook_entry','scanner') NOT NULL DEFAULT 'agent';
ALTER TABLE orders MODIFY COLUMN source
  ENUM('easyorder','easyorder_ataba','easyorder_farhat','shopify','whatsapp','manual','facebook')
  NOT NULL DEFAULT 'manual';
```

## 2b. Bootstrap business/products (only if `businesses`/`products` are empty)

If this is a fresh environment with employees already seeded but no business/product catalog
yet, run [scripts/bootstrap-production.ts](scripts/bootstrap-production.ts) — it refuses to
run at all if `businesses`, `products`, or `product_variants` already have any row:
```bash
corepack pnpm exec tsx scripts/bootstrap-production.ts --owner-employee-id=<id>
# review the dry-run output, then:
corepack pnpm exec tsx scripts/bootstrap-production.ts --owner-employee-id=<id> --confirm
```
Creates one business, links the given employee to it, creates the `أسورة نحاس` parent product
with 9 engraving-type variants, and 3 standalone products (مسند سيارة, كفر مرتبة ووتر بروف,
مسن سكاكين). See PROJECT_CONTEXT.md §4b for the full product model.
(The enum-narrowing statements will fail if any row already uses a new role/source value —
that's the safety check confirming nothing depends on the new schema yet.)

## 3. Deploy the application

- [ ] `corepack pnpm install` (if dependencies changed)
- [ ] `corepack pnpm build`
- [ ] `corepack pnpm start` (or however the target platform runs `dist/index.js` —
      process manager / container restart)
- [ ] Confirm the server boots without the `[FATAL] JWT_SECRET ...` error and without
      DB-connection errors in its logs.

## 4. Bootstrap / verify the first admin account

Only needed once per environment, and only if no admin-tier employee exists yet:
```bash
INITIAL_ADMIN_USERNAME=owner \
INITIAL_ADMIN_PASSWORD=<strong-password> \
INITIAL_ADMIN_EMAIL=owner@example.com \
corepack pnpm seed:admin
```
- [ ] Confirm output is either "Admin account created: owner" or the
      "already exists — skipping" no-op message (safe to re-run).
- [ ] Log in at `/login` with those credentials and confirm the dashboard loads.

## 5. Post-deployment verification (manual, against the real environment)

- [ ] Admin login at `/login` succeeds and shows the dashboard.
- [ ] Employee login at `/employee-login` succeeds for a non-admin employee.
- [ ] Invalid login (wrong password) shows the Arabic error, does not leak whether the
      username exists.
- [ ] A deactivated employee cannot log in (403 with the "disabled" message).
- [ ] Create a new employee from `/employees` with each of the 12 roles available in the
      role dropdown; confirm it appears in the list with the right role badge.
- [ ] Set/reset credentials for an employee via the key icon; confirm the generated
      password actually logs the employee in.
- [ ] Try to deactivate/delete the **last** active admin-tier employee — confirm it is
      blocked with the "يجب أن يبقى مسؤول إداري واحد نشط" error.
- [ ] Try to deactivate/demote/delete **your own** logged-in account — confirm it is
      blocked with the self-lockout error, even when other admins exist.
- [ ] Search/filter the employee list by name, role, and active status — confirm results
      match.
- [ ] Confirm no `passwordHash` field appears anywhere in the Network tab responses for
      `employees.list` / `employees.get` / `employees.activeList`.
- [ ] Orders page loads and existing order workflows (create/confirm/cancel/assign) are
      unaffected.
- [ ] Sidebar renders correctly on desktop and on mobile width (~375px).
- [ ] `/inventory` shows the "أسورة نحاس" product card expandable to its 9 variants, and the
      3 standalone products with no expand toggle.
- [ ] Add a product, edit its name/description, archive it (confirm dialog appears), then
      re-activate it — all via the "الأصناف" tab.
- [ ] Add a variant under an existing product, try adding a duplicate variant name — confirm
      it's rejected with a clear error.
- [ ] Try creating a product or variant with an SKU already in use — confirm it's rejected.

## 6. Legacy orders import (only when ready to bring in historical data)

Always dry-run first, on every environment, even if you dry-ran before — the DB-duplicate
check depends on what's already in that specific database:
```bash
corepack pnpm exec tsx scripts/import-legacy-orders.ts \
  --file "/path/to/كل_الأوردرات.xlsx"
```
- [ ] Review the console report and the two generated CSVs (all-orders, issues) in the
      report directory it prints.
- [ ] Confirm the "duplicate against live DB" count matches expectations (0 on a fresh
      environment).

Only after reviewing the dry-run output, run the real import:
```bash
corepack pnpm exec tsx scripts/import-legacy-orders.ts \
  --file "/path/to/كل_الأوردرات.xlsx" \
  --commit --business-id=1 --performed-by=<your-employee-id>
```
- [ ] Note the printed batch id (`#<batchId>`).
- [ ] Confirm `importedCount` in the final summary matches the dry-run's "صالحة تمامًا"
      count minus any unmatched-product skips reported in the commit-errors CSV.
- [ ] Spot-check a handful of imported orders in the UI against the original Excel file
      (customer name, phone, address, product, total, status).

**Rollback a bad import batch** (preview first, then confirm):
```bash
corepack pnpm exec tsx scripts/import-legacy-orders.ts \
  --rollback <batchId> --performed-by=<your-employee-id>
# review the preview output, then:
corepack pnpm exec tsx scripts/import-legacy-orders.ts \
  --rollback <batchId> --performed-by=<your-employee-id> --confirm
```
- [ ] Confirm the affected orders are gone and the batch status is `rolled_back`.

## 7. Sign-off

- [ ] All boxes above checked on the real target environment (not just this sandbox).
- [ ] `PROJECT_CONTEXT.md` known-limitations section reviewed and accepted.
- [ ] Decide whether to push/merge — this sandbox intentionally stopped short of
      `git push` / deploy; that step is a manual decision by the project owner.
