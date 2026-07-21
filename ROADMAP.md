# ROADMAP.md

**Project:** Bracelets Management System (bracelets_management_system)
**Status:** Planning only — no code has been changed to produce this document.
**Owner going forward:** Claude Code, acting as lead architect / senior engineer.
**Prior platform:** Manus (WebDev template). Manus will be phased out per Milestone Group 4.

This document is the single source of truth for how this project evolves from here.
It is derived from a full read-only audit of the codebase (structure, routers, db layer,
frontend pages, auth, integrations, security posture — see prior audit report in
conversation history for full detail).

---

## 0. Ground rules (non-negotiable, apply to every milestone)

1. **Explain before implementing.** Each milestone gets a short plan message before any file is touched, even after this roadmap is approved.
2. **Git commit before every major change.** One logical change = one commit, on a dedicated branch where risk is Medium or higher. No `--no-verify`, no force-push, no amending shared history.
3. **Never modify production data without explicit confirmation.** Schema migrations, data backfills, and destructive scripts always stop and ask first, and always assume a DB backup exists and is verified before running.
4. **No mixing of concerns in one change.** A refactor commit does not carry a behavior change. A migration does not carry a new feature. A new feature does not carry a refactor. (This mirrors the phased-migration principle from the original audit.)
5. **Contract stability.** tRPC procedure paths (`orders.confirm`, `employeePortal.scan`, etc.) do not change during refactors unless a milestone explicitly says otherwise and calls it out as a breaking change requiring frontend + backend to land together.
6. **Every milestone is independently revertible.** If a milestone can't be scoped small enough to revert cleanly, it gets split further before work starts.

---

## 1. How to read the estimates

| Field | Scale | Meaning |
|---|---|---|
| **Complexity** | S / M / L / XL | S = single file, mechanical. M = a few files, some judgment calls. L = a module, cross-file coordination. XL = spans backend+frontend or is a new domain, needs its own sub-plan. |
| **Risk** | Low / Med / High / Critical | Low = isolated, trivially revertible. Med = touches shared code paths. High = touches money, auth, or data integrity. Critical = wrong execution can cause data loss, security exposure, or production outage. |
| **Time** | engineer-days | Rough effort with AI-assisted implementation + human review gates. Not calendar time — calendar time depends on your review bandwidth. |
| **Depends on** | Milestone IDs | Must be complete (and approved) before this one starts. |

---

## 2. Open decisions needed (block specific milestones below — not blocking approval of this roadmap)

These aren't blockers to starting Phase 0, but each one blocks the milestone it's tagged against. I'll raise each one explicitly, with options and a recommendation, when we reach it — not now.

| # | Decision | Blocks | Why it matters |
|---|---|---|---|
| D1 | Replace Manus OAuth with what? (self-hosted email+password, Google/other OAuth, or keep Manus OAuth for admin only and drop it later) | M4.2 | This is the highest-risk milestone in the whole roadmap — it's the admin login path. |
| D2 | Keep or drop the Manus AI features (`AIChatBox`, `ManusDialog`, `llm.ts`, `imageGeneration.ts`, `voiceTranscription.ts`)? They appear present but I haven't confirmed they're wired into any live user flow. | M4.5 | If unused, this is a deletion, not a replacement — much cheaper. |
| D3 | Accounting module scope: simple revenue/expense ledger tied to orders, or full double-entry bookkeeping with chart of accounts? | M5.1 | Changes schema design and implementation size by an order of magnitude. |
| D4 | Payroll jurisdiction/compliance requirements (Egyptian labor law, social insurance deductions, tax brackets) — do you have specs, or should this start as a configurable-rules engine? | M5.4 | Payroll correctness has legal/financial consequences; needs real requirements, not assumptions. |
| D5 | Treasury scope: single cash account, or multi-account (cash + multiple bank accounts) with reconciliation against Bosta COD remittances? | M5.6 | Bosta already handles COD collection — treasury design should account for that money flow, not duplicate it. |
| D6 | Inventory data currently has two parallel read paths (`products.*` router used by `Inventory.tsx`, and `employeePortal.*` used by `WarehouseDashboard.tsx`/`ManagerDashboard.tsx` for the same underlying data). Consolidate into one, or keep both intentionally? | M2.5 | Touches an existing API contract both dashboards depend on. |

---

## 3. Milestone summary table

| ID | Milestone | Phase | Complexity | Risk | Time (days) | Depends on |
|---|---|---|---|---|---|---|
| M0.1 | Initialize Git repo + baseline commit | 0 Foundation | S | Low | 0.5 | — |
| M0.2 | Fix EasyOrder webhook secret validation | 0 Foundation | S | Low | 0.5 | M0.1 |
| M0.3 | Exclude PII (`.manus/db/`) + add `.env.example` | 0 Foundation | S | Low | 0.5 | M0.1 |
| M0.4 | Establish test baseline (run + document current suite) | 0 Foundation | S | Low | 0.5 | M0.1 |
| M0.5 | DB backup checklist (coordination, not execution) | 0 Foundation | S | Low | 0.25 | — |
| M1.1 | `server/modules/` scaffold + conventions | 1 Backend Arch | S | Low | 0.5 | M0.4 |
| M1.2 | Extract businesses/categories/warehouses module | 1 Backend Arch | M | Low | 1 | M1.1 |
| M1.3 | Extract logs module (print/activity/scan/order-edit) | 1 Backend Arch | M | Low | 1 | M1.1 |
| M1.4 | Extract employees module | 1 Backend Arch | M | Med | 1.5 | M1.1 |
| M1.5 | Extract products/inventory module | 1 Backend Arch | M | Med | 1.5 | M1.1 |
| M1.6 | Extract sales channels + variants module | 1 Backend Arch | M | Low | 1 | M1.1 |
| M1.7 | Extract returns module | 1 Backend Arch | S | Low | 0.5 | M1.1 |
| M1.8 | Extract tasks + broadcast module | 1 Backend Arch | S | Low | 0.5 | M1.1 |
| M1.9 | Extract orders module (core) | 1 Backend Arch | L | High | 3 | M1.2–M1.8 |
| M1.10 | Split `employeePortal` → employee-portal + manager-portal | 1 Backend Arch | L | High | 2.5 | M1.9 |
| M1.11 | Reduce `routers.ts` to composition root only | 1 Backend Arch | S | Med | 0.5 | M1.10 |
| M2.1 | `client/src/features/` scaffold + query-hook conventions | 2 Frontend Arch | S | Low | 0.5 | M1.11 |
| M2.2 | Refactor `ManagerDashboard.tsx` into feature tabs | 2 Frontend Arch | M | Low | 1.5 | M2.1 |
| M2.3 | Refactor `EmployeeDashboard.tsx` into feature modules | 2 Frontend Arch | L | Med | 2.5 | M2.1 |
| M2.4 | Refactor `Orders.tsx` into feature modules | 2 Frontend Arch | XL | High | 4 | M2.1, M1.9 |
| M2.5 | Consolidate duplicated inventory data paths (needs D6) | 2 Frontend Arch | M | Med | 1.5 | M2.2, M2.3 |
| M3.1 | Unify phone normalization + Arabic digit handling | 3 Core Hardening | S | Low | 1 | M1.9 |
| M3.2 | Formalize permission layer (document + consolidate) | 3 Core Hardening | M | Med | 1.5 | M1.10 |
| M3.3 | Session policy hardening (JWT lifetime, revoke, rotation) | 3 Core Hardening | M | High | 1.5 | M1.10 |
| M3.4 | Standardize webhook auth (apply Bosta's pattern everywhere) | 3 Core Hardening | S | Med | 1 | M0.2 |
| M4.1 | Design doc: auth replacement strategy (needs D1) | 4 Manus Removal | M | — (design only) | 1 | M3.3 |
| M4.2 | Replace Manus OAuth with chosen auth | 4 Manus Removal | XL | Critical | 5 | M4.1 |
| M4.3 | Replace Manus Forge storage with S3 | 4 Manus Removal | M | Med | 1.5 | M0.4 |
| M4.4 | Remove `vite-plugin-manus-runtime` + `__manus__` routes | 4 Manus Removal | S | Low | 0.5 | M4.2 |
| M4.5 | Remove/replace Manus AI components (needs D2) | 4 Manus Removal | M | Low | 1–3 | M4.2 |
| M4.6 | Final purge: env vars, package.json, docs | 4 Manus Removal | S | Low | 0.5 | M4.2–M4.5 |
| M5.1 | Accounting: requirements + schema design (needs D3) | 5 Financial Modules | M | — (design only) | 1.5 | M1.9 |
| M5.2 | Accounting: chart of accounts + ledger core | 5 Financial Modules | L | High | 4 | M5.1 |
| M5.3 | Accounting: integrate with Orders (revenue/COGS) | 5 Financial Modules | L | High | 3 | M5.2 |
| M5.4 | Payroll: requirements + schema design (needs D4) | 5 Financial Modules | M | — (design only) | 1.5 | M1.4 |
| M5.5 | Payroll: implementation (salary, deductions, payslips) | 5 Financial Modules | L | High | 4 | M5.4 |
| M5.6 | Treasury: requirements + schema design (needs D5) | 5 Financial Modules | M | — (design only) | 1 | M5.2 |
| M5.7 | Treasury: implementation | 5 Financial Modules | L | High | 3.5 | M5.6 |
| M6.1 | Reports improvements | 6 Feature Improvements | M | Low | 2 | M1.9 |
| M6.2 | Inventory improvements | 6 Feature Improvements | M | Med | 2 | M2.5 |
| M6.3 | Duplicate detection improvements | 6 Feature Improvements | M | Med | 2 | M3.1 |
| M6.4 | EasyOrder integration improvements | 6 Feature Improvements | M | Med | 2 | M3.4 |
| M6.5 | Bosta integration improvements | 6 Feature Improvements | M | Med | 2 | M3.4 |
| M6.6 | Employee management improvements | 6 Feature Improvements | M | Med | 1.5 | M1.4 |
| M6.7 | Permissions improvements (granular matrix) | 6 Feature Improvements | L | High | 3 | M3.2 |
| M6.8 | Printing improvements | 6 Feature Improvements | M | Low | 1.5 | M1.3 |
| M7.1 | Database indexing & query audit | 7 Scalability | M | Med | 1.5 | M1.9 |
| M7.2 | Pagination audit (remove unbounded queries) | 7 Scalability | S | Med | 1 | M1.9 |
| M7.3 | Caching strategy for dashboard/report aggregates | 7 Scalability | M | Med | 2 | M6.1 |
| M7.4 | Load/perf testing baseline | 7 Scalability | M | Low | 1.5 | M7.1–M7.3 |

**Total estimated effort: ~78–80 engineer-days** across all phases. This is a multi-month program, not a sprint — the summary table exists so we can re-sequence or drop milestones deliberately, not so we commit to all of it up front.

---

## 4. Phase detail

### Phase 0 — Foundation & Safety (do first, cheap, no ambiguity)
Goal: make the project safe to iterate on before touching any structure.
- **M0.1** — `git init`, baseline `.gitignore` review, first commit capturing current state as-is.
- **M0.2** — Fix `server/easyorderWebhook.ts`: currently accepts all incoming webhooks regardless of secret validity (confirmed in audit, code comment says so explicitly). This is the single highest-impact, lowest-effort fix available. Affected: `server/easyorderWebhook.ts`, `server/easyorderWebhook.test.ts`.
- **M0.3** — Add `.manus/db/` to `.gitignore` (contains real customer PII in plaintext), create `.env.example` documenting all 13 env vars found in the audit. Affected: `.gitignore`, `.env.example` (new).
- **M0.4** — Run `pnpm test` and `pnpm check`, record baseline pass/fail state in this repo so every later milestone can be judged against a known-good starting point.
- **M0.5** — Confirm with you that a current production DB backup exists and is restorable, before Phase 1 touches anything that reads/writes `orders` or `employees`. I will not assume this — I will ask.

### Phase 1 — Backend Architecture Refactor
Goal: turn `server/db.ts` (1554 lines, ~100 functions, 14 domains) and `server/routers.ts` (2321 lines, 18 sub-routers) into `server/modules/<domain>/{router,repository}.ts`, with `routers.ts` becoming a pure composition root. Order goes from least-coupled domains to the most-coupled (`orders`, `employeePortal`) last, so early milestones de-risk the pattern before we apply it to the hard parts.
Affected root paths: `server/db.ts`, `server/routers.ts`, new `server/modules/*`.
Every extraction milestone: same tRPC procedure names preserved, existing `*.test.ts` files re-pointed at new module paths and re-run green before merge.

### Phase 2 — Frontend Architecture Refactor
Goal: turn `Orders.tsx` (2364 lines, one ~1940-line component), `EmployeeDashboard.tsx` (1840 lines, one ~1630-line component), and `ManagerDashboard.tsx` (1416 lines, already split into tab functions) into `client/src/features/<domain>/`.
Order: `ManagerDashboard` first (lowest risk — internal boundaries already exist), then `EmployeeDashboard`, then `Orders.tsx` last (highest risk — heaviest shared state, 68 `useState` calls, no existing frontend test coverage so every milestone here leans on manual regression checklists we write before starting).
No frontend test suite exists today — Phase 2 milestones will each include a written manual test checklist (feature-by-feature) run before and after, since that's the only verification available until we decide whether to invest in frontend tests.

### Phase 3 — Shared Core Hardening
Goal: fix the cross-cutting issues the audit found — duplicated/inconsistent phone normalization, an implicit 5-tier permission system that's never been written down in one place, a 1-year admin session lifetime with no revocation path, and inconsistent webhook auth (Bosta validates, EasyOrder currently doesn't until M0.2 lands).

### Phase 4 — Manus Dependency Replacement
Goal: remove every Manus-specific dependency, in order of blast radius (storage first — contained and low-risk since `@aws-sdk/client-s3` is already a project dependency; auth last — highest risk, gets its own design doc milestone first).
This phase does **not** start until Phase 1–3 are done. Rationale: replacing auth on top of a still-monolithic `routers.ts`/`context.ts` means every touchpoint is harder to find and verify; doing it after modularization means auth's blast radius is contained to `server/modules/auth/` and a handful of call sites.

### Phase 5 — New Financial Modules (Accounting, Payroll, Treasury)
Goal: three new business domains, greenfield. Each gets a **design milestone first** (schema + requirements, produces a doc, not code) before any implementation milestone — these are the three biggest sources of ambiguity in the whole roadmap (see D3, D4, D5) and the ones most likely to need real-world compliance input from you, not assumptions from me.
Sequenced after Phase 1 so they're built directly into the new modular structure rather than bolted onto the old monolith.

### Phase 6 — Feature Improvements on Existing Modules
Goal: the remaining items from your list (Reports, Inventory, Duplicate detection, EasyOrder, Bosta, Employee management, Permissions, Printing) — these are incremental improvements to modules that already work, sequenced after the module each depends on has been extracted (Phase 1) and hardened (Phase 3), so improvements land in the new structure, not the old one.

### Phase 7 — Scalability
Goal: database indexing, removing unbounded queries (audit already found one: `importExcel.ts` duplicate-check loads up to 100,000 orders into memory on every import), caching for dashboard aggregates, and a load-test baseline. Sequenced last deliberately — scalability work is most valuable once the final module boundaries and query patterns are settled, otherwise we'd be optimizing code we're about to move.

---

## 5. What this roadmap deliberately does not include

- No UI redesign or rebranding — out of scope unless you ask separately.
- No decision made on your behalf for D1–D6 — those get raised as explicit choices when we reach them.
- No code changes yet. Nothing in Phase 0 has been executed — this file is the plan for Phase 0, not evidence it happened.

---

## 6. Status

**Awaiting your approval.** I will not start Milestone M0.1 or any other milestone until you confirm — either the whole roadmap, or a specific starting point (e.g., "start with M0.1–M0.4 only" or "re-order Phase 5 earlier"). If you want any phase reordered, split further, or dropped, tell me and I'll revise this file before we start.
