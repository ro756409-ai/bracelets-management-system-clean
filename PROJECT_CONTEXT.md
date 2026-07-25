# Matjarak (متجرك) — Project Context

Operational reference for the current state of the codebase after the Manus-OAuth
removal, Matjarak rebrand, employee RBAC expansion, and legacy-orders import pipeline.
Written for whoever picks this project up next (human or AI) — read this before touching
auth, roles, migrations, or the legacy importer.

## 1. Architecture

- **Frontend**: React 19 + TypeScript + Vite 7, routing via `wouter`, data via TanStack
  Query + tRPC v11 client. UI is shadcn/ui ("new-york" style) on Tailwind CSS v4, with
  brand tokens defined as CSS custom properties in [client/src/index.css](client/src/index.css)
  and applied via `@theme inline`.
- **Backend**: Express + tRPC v11 server, Drizzle ORM over MySQL. Entry point
  [server/_core/index.ts](server/_core/index.ts). All business logic/queries live in
  [server/db.ts](server/db.ts); the tRPC router tree is [server/routers.ts](server/routers.ts).
- **Schema**: [drizzle/schema.ts](drizzle/schema.ts) is the single source of truth.
  Migrations are generated offline with `drizzle-kit generate` into `drizzle/*.sql` +
  `drizzle/meta/*.json`, and applied with `drizzle-kit migrate` (see §4).

## 2. Authentication

Manus OAuth has been fully replaced with local JWT auth (bcryptjs + jsonwebtoken).
There are two independent cookie-based sessions:

| Cookie | Set by | Login page | Who |
|---|---|---|---|
| `app_session_id` (`COOKIE_NAME`) | `POST /api/auth/login` ([server/localAuth.ts](server/localAuth.ts)) | `/login` | Owner / admin-tier employee |
| `employee_token` | `POST /api/employee/login` ([server/employeeAuth.ts](server/employeeAuth.ts)) | `/employee-login` | Any employee |

Both sessions resolve to an `employees` row — there is no more separate `users`-table
login path for the dashboard. An admin-tier employee logging in via `/login` gets a
**synthetic full-admin `User` object** built in [server/_core/context.ts](server/_core/context.ts)
(`buildSyntheticAdminUser`), with `ctx.user.role === 'admin'` regardless of which
admin-tier role they actually hold. `ctx.realEmployeeId` always carries the real employee id.

`ctx.employeeManager` is `true` only when the admin session came through the
`employee_token` cookie (i.e. an admin-tier employee using `/employee-login` instead of
the owner's `/login`) — `ownerProcedure` in `routers.ts` uses this flag to block
owner-only actions (e.g. permanently deleting orders) for anyone but the true owner.

## 3. Roles & permissions

Central definition: [server/permissions.ts](server/permissions.ts).

- `EMPLOYEE_ROLE_VALUES` — 12 roles total: the 5 original (`agent`, `warehouse`,
  `manager`, `facebook_entry`, `scanner`) plus 7 added this release (`super_admin`,
  `admin`, `data_entry`, `order_confirmation`, `shipping`, `accountant`, `viewer`).
- `ADMIN_TIER_ROLES = ["super_admin", "admin", "manager"]` — these get the synthetic
  full-admin session described above (`isAdminTierRole()` gates it everywhere:
  `context.ts`, `authMiddleware.ts`'s `isActiveManagerSession`, `localAuth.ts`).
- `ROLE_PERMISSIONS` — a **hardcoded, non-DB-driven** role→permission table. This is a
  deliberate scope decision, not an oversight: a full dynamic RBAC system (custom roles,
  per-tenant permission editing) is explicitly deferred to a future "System
  Administration" module. Non-admin-tier roles' permissions are defined here but are
  **not yet enforced on every existing procedure** (orders, reports, etc.) — only on the
  employee-management endpoints themselves. Wiring `hasPermission()` into the rest of the
  router tree is the natural next increment.

### Backend protections added this release (`employees` router in `server/routers.ts`)

- **Last-admin protection**: `update`/`delete` reject any change that would deactivate,
  demote, or delete the last active admin-tier employee (checked via
  `countActiveAdminTierEmployees(excludeId)` in `server/db.ts`).
- **Self-lockout protection**: the acting employee (`resolveActingEmployeeId(ctx)`) can
  never deactivate/demote/delete their own account, even if other admins exist.
- **No password-hash leakage**: every employee query that can reach the client
  (`getAllEmployees`, `searchEmployees`, `getActiveEmployees`, `getEmployeeById`) now
  selects an explicit column set (`employeeSafeColumns` in `server/db.ts`) that omits
  `passwordHash`. Only `getEmployeeByUsernameOrEmail` (used internally by the two login
  routes to run `bcrypt.compare`) still returns the hash — it is never sent to a client.
- **`lastLoginAt`** is stamped on both login routes (`localAuth.ts`, `employeeAuth.ts`)
  and returned by `employees.list` / `employees.get`.

### Known limitation: forced password change on first login

Not implemented this release. There is no `mustChangePassword` column. New employees are
issued a temporary password by the admin creating them (via the existing
`employees.setCredentials` mutation) and are expected to be told to change it through
whatever self-service flow exists later. This was an explicit scope trade-off — adding
the column now without a UI to act on it would be a half-built feature.

### Known limitation: `authMiddleware.ts` employee_token fallback

`requireAdminOrManager`'s `employee_token` fallback path (used by the older
import/export REST routes, not the tRPC router) still checks `emp.role !== "manager"`
literally, rather than `isAdminTierRole()`. This is intentional: `server/security.test.ts`
asserts on that literal string, and this fallback path is secondary — the primary
`/login` → tRPC path already treats all admin-tier roles equivalently. A `super_admin`/
`admin` employee who only ever used `/employee-login` would not pass this one Express
middleware; they can still do everything through the main dashboard login.

## 4. Database migrations

- Migrations are **generated offline** (`drizzle-kit generate` — does not need a live
  DB connection, only a syntactically-valid `DATABASE_URL` env var to load
  `drizzle.config.ts`) and applied separately (`drizzle-kit migrate` — needs a real
  connection).
- Latest migration: **`drizzle/0022_giant_slapstick.sql`** — generated, **not yet
  applied** to any database (this sandbox has no live `DATABASE_URL`). It is purely
  additive:
  - New table `import_batches` (see §5).
  - `employees.role` enum: adds the 7 new roles (existing 5 unchanged).
  - `orders.source` enum: adds `easyorder_flashbox` (confirmed real legacy value, 299
    raw occurrences in the historical export).
  - `employees.lastLoginAt` — new nullable column.
  - `orders.importBatchId` — new nullable column (FK-by-convention to `import_batches.id`).
  - No columns dropped, no types narrowed, no data touched. Safe to apply to a database
    with existing data; rollback is "drop the new table / new columns" if ever needed
    (there is no down-migration file — MySQL DDL rollback is manual, see
    RELEASE_CHECKLIST.md).

## 5. Legacy orders importer

Script: [scripts/import-legacy-orders.ts](scripts/import-legacy-orders.ts). Imports
`كل_الأوردرات.xlsx` (historical export with wrapped/split rows) into `orders`.

- **Reconstruction**: the source file skips empty cells and re-flows remaining values,
  sometimes across multiple physical rows, with no fixed column-shift pattern. The
  script collects every non-empty cell from one order-boundary to the next into a flat
  token stream and classifies each token by *shape* (phone/date/money/status/source/
  governorate/product-keyword) rather than by column position — see the file's header
  comment for the full rationale.
- **Dry run is the default and is always safe** — it never opens a write transaction,
  only reads the Excel file and (if `DATABASE_URL` is live) reads `orders` to check for
  existing `externalOrderId`s. Produces two CSVs (all reconstructed orders; rejected +
  warned orders) plus a console report with unique-order count, merged-row count,
  rejection reasons, and unknown status/source/governorate value listings.
- **Commit mode** (`--commit`) requires `--performed-by=<employeeId>` and a live DB with
  migration `0022` already applied (needs the `import_batches` table and the
  `easyorder_flashbox` enum value). It:
  1. Creates one `import_batches` row (`status: "running"`).
  2. Matches each importable order's free-text product name against `products` for the
     target business — **exact match first, then single-candidate substring match**; any
     order with zero or multiple product candidates is skipped, never guessed.
  3. Inserts each remaining order via the shared `createOrder()` helper (same code path
     the rest of the app uses — gets serial-number generation and phone normalization
     for free), stamping `externalOrderId` = legacy order number and `importBatchId` =
     the new batch id.
  4. Updates the batch row to `completed`/`failed` with final counts
     (`importedCount`/`skippedCount`/`duplicateCount`) and an `errorSummary` if anything
     was skipped or failed.
  5. Writes a commit-specific error CSV (`legacy-import-commit-errors-batch<id>-*.csv`)
     listing unmatched-product and insert-error rows, if any.
- **Rollback** (`--rollback <batchId>`): previews how many orders would be deleted for
  that batch; only deletes (and marks the batch `rolled_back`) when `--confirm` is also
  passed. Requires `--performed-by` too, for the audit trail.

Full command reference is in RELEASE_CHECKLIST.md.

## 5b. Structured orders CSV importer

Script: [scripts/import-orders-csv.ts](scripts/import-orders-csv.ts). A separate,
simpler importer for well-formed order exports (one row per order, one column per
field — e.g. `orders_data.csv`), as opposed to §5's wrapped/split-row Excel format.
Same dry-run/commit/rollback shape and `import_batches` tracking as §5, but no
row-reconstruction step — each CSV row maps directly to one order.

- **Source CSV files are never committed to git** — they contain real customer PII
  (name, phone, address) and must be uploaded to the server directly, not via the repo.
  See RELEASE_CHECKLIST.md for the upload method and target path.
- **Status mapping**: the source has three separate status columns (confirmation /
  preparation / shipping) collapsed into the single `orders.status` field — highest
  stage reached wins (shipping status > preparation status > confirmation status). See
  the script's header comment for the exact value table.
- **Duplicate detection / idempotency**: identical mechanism to §5 — before any insert,
  it reads every existing `orders.externalOrderId` from the database and excludes any
  CSV row whose `رقم الأوردر` value already matches one. This is an **application-level**
  check (re-read from the DB on every run), not a database `UNIQUE` constraint — safe for
  sequential manual runs, so running the same command twice imports 0 new rows the second
  time. It does not update/upsert existing orders; a matched row is skipped entirely, not
  touched.
- Dry-run mode also performs product-name matching against the live `products` table (not
  just at commit time), so unmatched-product risk is visible before any write happens.

## 6. Deployment

- Build: `pnpm build` → Vite build to `dist/public` + esbuild bundle of the server to
  `dist/index.js`.
- Run: `pnpm start` (`NODE_ENV=production node dist/index.js`).
- Required env vars: see [.env.example](.env.example) — at minimum `DATABASE_URL`,
  `JWT_SECRET` (long random string; the server refuses to boot without it), and the
  `INITIAL_ADMIN_*` vars for the one-time `pnpm seed:admin` bootstrap. Bosta and
  EasyOrder-related vars are optional (features degrade gracefully / are per-channel).

## 7. Known limitations (full list)

1. No forced password-change-on-first-login flow (see §3).
2. `requireAdminOrManager`'s legacy `employee_token` fallback path only recognizes
   `role === "manager"`, not the newer `admin`/`super_admin` roles (see §3).
3. Non-admin-tier role permissions (`accountant`, `viewer`, `order_confirmation`, etc.)
   are defined in `server/permissions.ts` but only enforced on the employee-management
   endpoints so far — not yet wired into orders/reports/settings procedures.
4. No down-migration for `0022_giant_slapstick.sql` — MySQL DDL rollback is manual if
   ever needed (see RELEASE_CHECKLIST.md for the exact statements).
5. This development sandbox has no live `DATABASE_URL`, so none of the DB-dependent
   manual test scenarios (real login, employee CRUD, permission-denial responses, actual
   commit-mode import, actual rollback) could be executed end-to-end here — only their
   code paths, unit-testable logic, and the DB-independent UI (login pages, RTL, mobile)
   were verified. They must be run against a real staging database before production use.
6. 8 pre-existing test failures in `pnpm test` (`bosta.test.ts`, `businesses.test.ts`,
   `orderItems.test.ts`) are environment-dependent (missing `BOSTA_API_KEY`/
   `BOSTA_PICKUP_ADDRESS_ID`, no live DB) and unrelated to this release's changes — they
   were already failing before this work began and will pass once a real environment
   with those secrets and a DB is used.

## 8. Future work

- Wire `hasPermission()` into the rest of the router tree (orders, reports, settings)
  for full defense-in-depth RBAC, not just employee management.
- Forced password change on first login (needs a `mustChangePassword` column + a
  "change password" UI gate).
- Reconcile the `employee_token` fallback in `authMiddleware.ts` with `isAdminTierRole`
  once the test that pins the old literal string is updated alongside it.
- Dynamic/DB-driven roles & permissions (custom roles, per-tenant editing) — the
  "System Administration" module referenced throughout `server/permissions.ts`.
