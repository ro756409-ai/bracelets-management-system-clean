# SECURITY_NOTES.md

Generated as part of Milestone M0.1 (Git initialization). This file documents what was
excluded from version control and why. **No secret values are recorded here** — only
file paths, categories, and the reasoning.

## 1. Files/directories excluded via `.gitignore`

| Path | Reason |
|---|---|
| `.env`, `.env.*` (except `.env.example`) | Would contain real `DATABASE_URL`, `JWT_SECRET`, `BOSTA_API_KEY`, and Manus Forge credentials once created. No `.env` file exists in the project yet — this rule is preventive. |
| `.manus/db/` | Contains 151 JSON files with raw SQL statements captured during development, including **real customer PII in plaintext**: names, phone numbers, and full addresses. This directory was not previously gitignored. It must never be committed. |
| `.manus-logs/` | Runtime debug log directory (`browserConsole.log`, `networkRequests.log`, `sessionReplay.log`) created by the Manus Vite plugin during local dev sessions. Not present on disk right now, but excluded proactively since session replay logs can capture user input. |
| `client/public/__manus__/` | Manus runtime static assets (`version.json`, `debug-collector.js`). No secrets found in either file, but excluded per instruction since these are platform-runtime artifacts, not application source. **Note:** `debug-collector.js` is served as a dev-only script tag (injected only when `NODE_ENV !== "production"`, see `vite.config.ts`); excluding it from git means a fresh clone will 404 on that one dev-only script until the file is restored — this does not affect production builds or any application logic. |
| `*.dump`, `*.sql.gz`, `*.bak.sql`, `backup(s)/`, `dump(s)/`, `export(s)/`, `uploads/`, `*.zip`, `*.tar.gz` | Preventive rules — no such files exist in the repo today, but these are the shapes a DB dump, customer data export, or uploaded file archive would take if one were added later. |
| `node_modules/`, `dist/`, `build/` | Standard — already covered by the pre-existing `.gitignore`. |

## 2. Secret scan performed

Searched all tracked-candidate source files (`*.ts`, `*.tsx`, `*.js`, `*.mjs`, `*.cjs`, `*.json`,
plus root-level `.md`/`.txt` notes) for hardcoded API keys, JWT secrets, database
credentials, and Bosta/EasyOrder secrets.

**Result: no hardcoded secrets found in any file destined for the first commit.**

- All real secrets are read exclusively from `process.env.*` at runtime (`server/_core/env.ts`,
  `server/employeeAuth.ts`, `server/bosta.service.ts`, `drizzle.config.ts`) — confirmed by
  reading each of these files.
- EasyOrder webhook secrets are stored per sales channel in the database
  (`sales_channels.webhookSecret` column), not in source or env files.
- No `.env` file exists on disk to begin with.

## 3. Files reviewed and judged safe to commit as-is

- Root-level one-off scripts (`insert_orders.mjs`, `run-migration.mjs`, `check-cols.mjs`,
  `scripts/*.mjs`, `test_match.cjs`, `test_match2.cjs`, `test_import_check.cjs`): all read
  `DATABASE_URL` from `.env` via `dotenv` at runtime — no embedded credentials. A few
  reference absolute file paths from a prior development machine (e.g.
  `/home/ubuntu/upload/...xlsx`) — not a secret, but not portable either; flagged here for
  awareness, not excluded.
- `drizzle/*.sql` (22 migration files): schema-only migrations, no seed/production data.
- `audit_notes.txt`, `debug-notes.txt`, `migration-plan.md`, `todo.md`, and other root
  `.md`/`.txt` notes: scanned, no secret-like patterns found.

## 4. Known residual risk (not fixed in this milestone — informational only)

Per the prior audit, `server/easyorderWebhook.ts` currently accepts incoming webhook
requests without rejecting invalid/missing secrets. This is a code-behavior issue, not a
git-hygiene issue, and is scoped to Milestone M0.2 — **not touched in this commit.**

## 5. What still needs a human decision

- Whether any commit history / backup of this project exists elsewhere (e.g. inside Manus)
  that should be reconciled before this becomes the canonical repo.
- Where `.env` (the real one) will live for local development and how it reaches
  production — this repo will never contain it.
