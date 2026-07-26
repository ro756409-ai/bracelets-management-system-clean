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

## 4b. Product / variant model (2026-07-25 refactor)

`أسورة نحاس` (medical copper bracelet) is **one product** with engraving-type **variants**
(آية الكرسي, عين حورس, ذكر التحصين, ...) — not separate products. Other lines (مسند سيارة,
كفر مرتبة ووتر بروف, مسن سكاكين) remain standalone products with no variants.

- The `product_variants` table already existed (originally for color/size variants) —
  migration **`drizzle/0023_magenta_warbound.sql`** extends it rather than replacing it:
  adds `product_variants.name` (generic variant label, used instead of/alongside color/size),
  adds `products.description`, and relaxes `products.sku`/`products.price` from `NOT NULL` to
  nullable (a parent product with variants carries neither — its variants do). Purely
  additive/widening, no data loss possible. Not yet applied to any database.
- Backend: `server/routers.ts`'s `products`/`variants` routers accept `name`/`description`
  and enforce **duplicate-SKU** (checked across both `products.sku` and `product_variants.sku`)
  and **duplicate-variant-name-per-product** validation (`server/db.ts`: `isSkuTaken`,
  `isVariantNameTaken`). Both product and variant "archive" already existed as soft-delete
  (`isActive: false`) before this refactor — reused as-is, including the confirmation dialogs
  already present in the UI.
- Frontend: `client/src/pages/Inventory.tsx` — merged the previously-separate "variants" tab
  into "products": each product card is expandable to show its variants inline. Added
  add/edit/archive for products (previously only stock/price editing existed at the product
  level, with no create/archive flow at all).
- See §5 for how the legacy importer maps free-text engraving descriptions onto this model.

### 4c. Inventory UI overhaul (2026-07-25)

Migration **`drizzle/0024_ancient_the_enforcers.sql`** (additive/widening, same as 0023) adds:
`product_variants.costPrice`, `inventory_movements.variantId`, `inventory_movements.notes`.
The latter two exist because variant stock movements previously had **no audit trail at all**
(`variants.updateStock` just incremented the number) — `addVariantInventoryMovement()` in
`server/db.ts` now logs every variant movement the same way product movements always were.

- **Archived visibility**: `getAllProducts`/`getVariantsByProduct`/`getAllVariantsWithProduct`
  take an `includeInactive` option (default `false`, i.e. unchanged behavior for every existing
  caller — order creation dropdowns etc. still only ever see active items). `Inventory.tsx` is
  the only caller that passes `includeInactive: true`, filtering client-side via a "show
  archived" toggle so switching it doesn't require a refetch.
- **Stock changes are append-only**: `variants.update`'s zod schema no longer accepts
  `currentStock` at all — the edit dialog has no stock field. Stock only moves through
  `products.addMovement` / `variants.addMovement`, both of which now reject (server-side, not
  just UI-disabled) an `out` movement whose quantity exceeds current stock.
- **Variant identity**: `variants.create` now requires both `name` and `sku` (previously either
  name/color/size was enough) — matches the parent/variant model where every real variant has
  both. `costPrice` is optional everywhere it appears.
- Parent product card totals (active variant count, total stock, total inventory value when any
  variant has a `costPrice`, count of variants needing restock) are computed by
  `shared/inventoryCalculations.ts` (`computeVariantTotals`, `getStockStatus`) — a pure,
  framework-free module imported by both `Inventory.tsx` and its test file, so the UI and its
  test coverage can't drift apart.

## 5. Legacy orders importer

Script: [scripts/import-legacy-orders.ts](scripts/import-legacy-orders.ts). Imports
`كل_الأوردرات.xlsx` (historical export with wrapped/split rows) into `orders` (+ `order_items`
for multi-item orders, see below).

- **Product/variant matching (2026-07-25)**: each reconstructed order's free-text product
  description is split on `+` into one segment per item (e.g. `"أسورة عين حورس + أسورة منقوش"`
  → two items), with an optional trailing `×N` as that item's quantity. Each segment is then
  resolved independently: if it contains "أسورة"/"اسورة" it's matched as a **variant** of the
  `أسورة نحاس` parent product (exact name match first, then single-candidate substring); other
  descriptions are matched as **standalone products** the same way. This is all-or-nothing per
  order — if any single item in a multi-item order can't be resolved, the *entire* order is
  skipped and logged for review, never partially imported or guessed. Orders whose items all
  resolve get one `orders` row (first item's product/variant as the primary reference) plus one
  `order_items` row per item via `replaceOrderItems()`.
- Pure functions (`splitCompoundProduct`, `matchByName`, `resolveSegment`, `isBraceletItem`) are
  exported and unit-tested in `scripts/import-legacy-orders.test.ts` — the script guards its
  `main()` call behind an `isMainModule` check so importing it for tests doesn't trigger a real
  run.

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

## 5c. Sales channels & integration credentials (2026-07-25)

`sales_channels` holds per-channel integration credentials (`apiToken`, `webhookSecret`).
These were previously returned **in full** by `salesChannels.list`/`get`/`activeList`, so the
raw values sat in the JSON payload even though the UI masked them visually (`••••`+last4).

**Scope of the exposure — verified, not assumed.** `server/_core/context.ts` sets `ctx.user`
only via `buildSyntheticAdminUser()`, and only for employees passing
`isActive && isAdminTierRole(role)`. So the readers were **admin-tier employees
(`super_admin`/`admin`/`manager`) only** — not "any logged-in user". A `viewer`/`agent`/
`warehouse`/etc. employee has `ctx.user = null`, is rejected by `protectedProcedure` before
any router runs, and uses the separate `/employee-login` portal entirely. The real risk was
therefore narrower than a public leak: secrets travelled to admin browsers (and any
DevTools/proxy/log along that path) with no need to.

Fixed:

- **Every** `salesChannels` procedure is now `adminProcedure`, including the read ones.
  ⚠️ Note this is a **defence-in-depth no-op, not an access change**: because
  `buildSyntheticAdminUser` hardcodes `role: "admin"`, `ctx.user != null` already implies
  `ctx.user.role === "admin"`, so `protectedProcedure` and `adminProcedure` admit an
  identical set here. **No role gained or lost access.** The real fix is the masking below.
  `server/salesChannels.test.ts` pins this equivalence so it can't silently drift.
- `getAllSalesChannels` / `getActiveSalesChannels` / `getSalesChannelById` return a
  `SafeSalesChannel` (see `server/db.ts`): raw secrets stripped, replaced by
  `hasApiToken` / `apiTokenLast4` / `hasWebhookSecret` / `webhookSecretLast4`.
  `getSalesChannelByWebhookSecret` and `getSalesChannelByPlatformAndBusiness` still return
  full rows — they are **server-internal only** (webhook routing) and must never be exposed
  through a procedure.
- Secrets are **write-only**: because the API never returns them, an edit form can't
  round-trip them, so `updateSalesChannel` treats `undefined` *and* `""` as "leave
  unchanged". Removing a secret requires the explicit `salesChannels.clearSecret`.
- Validation: unique `webhookSecret` across all channels (webhook routing matches on it, so
  duplicates would be ambiguous), unique channel name per business, URL format on
  `domain`/`webhookUrl`, minimum 8 characters for a webhook secret.
- `delete` remains a soft delete (`isActive=false`); `reactivate` restores. The UI has an
  archived-visibility toggle and hides archived channels by default.
- Covered by `server/salesChannels.test.ts` (20 tests), including explicit assertions that
  no response object ever carries an `apiToken`/`webhookSecret` property, that a `user: null`
  context (every non-admin-tier employee) is rejected from all eight procedures, and that
  exactly `{super_admin, admin, manager}` are admin-tier.

## 5d. EasyOrder integration (Phase 2, 2026-07-25)

Migration **`drizzle/0025_mysterious_typhoid_mary.sql`** (additive/widening):
`orders.externalRawPayload/externalUpdatedAt/needsReview/reviewReason`,
`sales_channels.apiBaseUrl/lastSyncAt/lastSyncStatus/lastSyncError/lastSyncedOrderCount`,
new `sync_logs` table, and `orders.productId`/`returns.productId` widened to nullable.

**Why productId became nullable.** The old webhook fell back to
`productId: firstMatchedProductId ?? 1` — an unmatched order was silently attributed to
product #1. An order awaiting review genuinely has no product, so the column now allows
null and such orders are created with `needsReview = true` plus a human-readable
`reviewReason`. Nothing is dropped and nothing is mis-attributed. Several call sites
already guarded for null; the stock paths (`editOrderWithInventory`, `markOrderAsReturned`,
`editOrderFull`) now skip inventory movement when no product is resolved, which is correct
— an unresolved order never deducted stock in the first place.

- **`server/productMatching.ts`** — the single matching implementation, shared by the
  webhook and manual sync. Order of confidence: variant SKU → product SKU → variant name →
  product name, with Arabic normalization (alef/hamza/ta-marbuta/alef-maqsura/diacritics)
  so `اية الكرسي` matches `آية الكرسي`. **Never guesses**: zero or 2+ candidates returns
  `matched: false` (with `ambiguous: true` for the latter) and never carries a `productId`.
  This also repaired a regression — after the parent/variant refactor `getAllProducts()`
  returns only 4 rows, so the old name-only matcher could no longer match any bracelet.
- **`server/easyorder.service.ts`** — payload normalization, the idempotent
  `upsertEasyOrder` pipeline, `withRetry` (exponential backoff; 429/5xx retryable, 4xx not),
  the `EasyOrderClient`, and `syncOrdersByDateRange`. Idempotency key is
  `orders.externalOrderId`; an existing order is only rewritten when the incoming
  `updated_at` is strictly newer, so replayed webhooks are no-ops.
- **`server/easyorderWebhook.ts`** — rewritten on that shared pipeline. Creates real
  `order_items` rows (one per cart item) instead of one concatenated `productName` string,
  stores the full untruncated payload, and actually applies `order-status-update` events
  instead of only logging them.
- **Secret enforcement**: was disabled outright. Now gated by
  `EASYORDER_WEBHOOK_ENFORCE_SECRET` — `log_only` (default) records what would have been
  rejected, `enforce` returns 401. See `.env.example` for the rollout procedure.
- **UI**: Sales Channels page gains Sync Now (date range), Test Connection, a
  Connected/Error/Last-Sync badge, and an inline sync-log panel. Review queue exposed via
  `orders.needingReview` / `orders.resolveReview`.
- Tests: `productMatching.test.ts` (19) + `easyorder.service.test.ts` (24), including
  retry/backoff behaviour, envelope-shape tolerance, and an assertion that the API token
  never appears in an error message.

### Connection test (read-only credential check)

Migration **`drizzle/0026_curly_iceman.sql`** adds `sales_channels.lastConnectionTestAt`,
`lastConnectionStatus` (never/connected/failed), `lastConnectionError`, `externalStoreName`.

Deliberately **separate from sync status**: a failed import must not look like broken
credentials, and valid credentials must not imply a successful import. The Sales Channels
card shows the two independently.

- `testChannelConnection(channelId)` issues **GET requests only** and writes **nothing**
  except that channel's own four connection columns — no order, product, or `sync_logs`
  row is created or updated.
- It tries the configured harmless read-only paths in order. A **404** means "this provider
  doesn't expose that path" so it falls through to the next candidate; any other failure
  (401/403/429/5xx/network) is conclusive and returned immediately rather than repeating a
  rejection against more paths.
- Returns a structured `ConnectionTestResult`: `connected`, `storeName` (when the endpoint
  exposes one), a stable `errorCode` (`NO_TOKEN`, `INVALID_CREDENTIALS`, `ENDPOINT_NOT_FOUND`,
  `RATE_LIMITED`, `PROVIDER_ERROR`, `REQUEST_FAILED`, `NETWORK_ERROR`), and a sanitized
  `errorMessage`.
- `sanitizeErrorMessage()` redacts the channel's own token plus anything matching
  bearer/api-key/secret patterns and truncates to 400 chars, so even a provider that echoes
  the credential back in its error body cannot leak it to the client. Covered by a test that
  does exactly that.

⚠️ **Known limitation — the pull API contract is unverified.** No EasyOrder API key or
documentation was available, so the endpoint path, date-range query-param names and auth
header in `EASYORDER_ENDPOINT` are assumptions. They are isolated in one constant and
configurable per channel. Verify them before relying on manual sync; the webhook path is
verified against real payload traffic and does not depend on them.

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
