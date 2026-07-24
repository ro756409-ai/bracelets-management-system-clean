# BRAND_MIGRATION_NOTES.md

Notes from the platform rebrand to **متجرك (Matjarak)**. This documents everything that
still references the old identity and *why* it was deliberately left unchanged in this
phase — either because it's technical/DB-level (needs a migration, out of scope per this
phase's constraints) or because it's actual tenant/merchant data rather than platform
identity.

## 1. Tenant/business data — intentionally NOT renamed

These are real business records and business-domain concepts inside the multi-tenant data
model, not the platform's own identity. Renaming them would corrupt real data, not "fix"
branding:

- `drizzle` data and `server/db.ts` seed data: business "فرحات للنحاس" (business id=1),
  the "نحاس" business group, product seed data named after copper bracelets
  (`braceletProducts` in `server/db.ts`).
- `server/businessGroups.test.ts`, `server/orders.test.ts`: test fixtures referencing
  "نحاس"/copper/bracelet business and product names — these test real business-domain
  logic (business grouping, product seeding), not platform branding.
- `server/importExcel.ts`: product-name matching logic (`isGenericBracelet`, "strip
  bracelet prefix") — this is Excel-import parsing logic for a specific merchant's
  product catalog, not platform UI.
- `server/easyorderWebhook.ts`: code comment referencing "bracelet orders from flash
  box" — describes business routing logic (which store's orders go to which business),
  not platform identity.
- `client/src/pages/Orders.tsx`: `source` enum label `"ويب سايت فرحات للنحاس"` — a
  business-logic label for the `easyorder_farhat` order source, tied to actual schema
  data (`orders.source`).
- `client/src/pages/Businesses.tsx`: placeholder text `"مثال: فرحات للنحاس"` in the
  "add business" form — an example value, not platform branding.

## 2. Technical/infrastructure names — need a migration or external action, not just code

- **Working directory name on disk**: the project folder itself is still named
  `نسخة-من-نظام-إدارة-الأساور-النحاسية-الطبية (7)`. Renaming a live working directory is
  an OS-level action outside this phase's scope (UI/branding only) and risks breaking
  any external shortcuts/references you have to this path. Needs your explicit decision.
- **GitHub repository names**: `bracelets-management-system` and
  `bracelets-management-system-clean` still carry the old name. Renaming a GitHub repo
  changes its URL (GitHub does redirect the old URL, but any hardcoded links elsewhere
  would need review). Not done here — needs your decision.
- **Database name/schema**: no table, column, or database name was touched, per this
  phase's explicit constraints (`orders`, `businesses`, etc. all unchanged).
- **`.env` variable names** (`DATABASE_URL`, `JWT_SECRET`, etc.): unchanged — renaming
  env vars needs coordinated deploy-time changes, out of scope here.

## 3. Internal/historical documents — left mostly as-is (not user-facing)

`todo.md`, `ELECTRON_OFFLINE_PLAN.md`, `migration-plan.md`, `audit_notes.txt`,
`debug-notes.txt`, `shipping-schedule-notes.txt`, `shipping_schedules_notes.md` still
reference the old project name throughout their content. These are internal
planning/ops notes, not surfaces a merchant or employee ever sees, so they weren't
rewritten. `MIGRATION_README.md` and `ROADMAP.md` got their title lines updated only —
their body content (which discusses real multi-business/tenant data, e.g. "يدعم عدة
براندات: فرحات، عتبة، Nova...") was left alone since it's accurate operational
description, not outdated branding.

## 4. Residual old-brand visual accents — not swept in this phase

The old copper/gold identity used Tailwind's `amber-*` palette extensively as a generic
accent color across roughly 17 secondary pages (status badges, warning banners, buttons)
beyond the explicitly-named surfaces (login, header/sidebar, dashboard, loading screen).
This phase fixed every surface explicitly listed in the task plus every hardcoded
"identity" spot found (external logo image, `#1a1008`/`#2d1f0a`/`#b8860b` hex literals,
old brand name text) in headers/sidebars/login screens. It deliberately did **not** sweep
every remaining `amber-*` utility class across the rest of the app — many of those are
legitimate semantic "warning" colors (which now have a proper `--color-warning` token
available, close to the same hue) rather than brand accents, and a full sweep across ~17
files in a single phase was judged too high-risk for a scope defined as "identity only."
**Recommended as a separate, dedicated follow-up phase**, not bundled with this one.

## 5. New reusable pieces introduced by this phase

- `client/src/index.css` — full token system (colors, `--font-brand`, radius) now backs
  every `bg-primary`/`text-muted-foreground`/etc. utility class already used app-wide,
  so most of the app re-themed automatically without per-file edits.
- `client/src/components/BrandMark.tsx` — single reusable brand mark component,
  replacing 7 separate hardcoded `<img src="https://.../farahat-logo...">` occurrences.
- `client/public/favicon.svg` — no favicon existed before this phase.
