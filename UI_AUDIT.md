# Matjarak — UI/UX Audit & Redesign Plan

Audit date: 2026-07-26. Scope: every route in [client/src/App.tsx](client/src/App.tsx)
and every page in `client/src/pages/` (30 files, 18,333 lines).

Status: **audit only — nothing implemented yet.**

---

## 0. Headline numbers

| Metric | Value |
|---|---|
| Pages | 30 (18,333 lines) |
| Largest page | `Orders.tsx` — 2,364 lines, 68 `useState`, 50 `<Button>`, 9 `<Dialog>` |
| Pages with hardcoded (non-token) colours | 20 of 30 |
| Total hardcoded colour occurrences | ~800 |
| Pages with a desktop `<table>` and no mobile fallback | 16 |
| Pages relying on `overflow-x-auto` (horizontal scroll on phones) | 14 |
| Pages with **zero** responsive breakpoints | 15 |
| Composed shared components (PageHeader, StatCard, …) | **0** |
| shadcn primitives available | 53 |

The primitive layer is complete and healthy. What is missing is the **composed layer**
above it — so every page re-invents headers, filters, tables, and empty states by hand.
That is the single root cause of most inconsistency below.

---

## 1. Verified bugs found during the audit

These are defects, not taste. Each is a safe, contained fix.

| # | Bug | Evidence | Severity |
|---|---|---|---|
| B1 | Sidebar links to `/employee-qr-scanner`, which **has no route** — clicking it 404s | [DashboardLayout.tsx:48](client/src/components/DashboardLayout.tsx:48) vs App.tsx | **High** — visibly broken nav item |
| B2 | `ComponentShowcase.tsx` (1,437 lines) is never imported or routed — dead code | App.tsx has no import | Low |
| B3 | *(corrected below)* | | |
| B4 | *(corrected below — was two different bugs, split into B4/B6)* | | |
| B5 | 15 pages have no breakpoints at all, so a 360px phone gets the desktop layout | grep | **High** |
| B6 | `/scan-logs` and `/scan-orders` were routed **outside** `ProtectedLayout` in `App.tsx`, so clicking them from the sidebar unmounted the whole admin shell (sidebar disappeared) despite being genuine admin-session pages | App.tsx routing vs. every sibling route | **High** — silent navigation break |

### Correction after implementation: B3/B4 were one auth-architecture finding, not two bugs

The original audit read "three pages unreachable from the sidebar" as a simple omission and
planned to add sidebar links for `/manager-dashboard`, `/today-shipments`, `/employee-dashboard`
("Today Confirmations"), and `/facebook-entry`. Tracing the actual auth code before touching
the sidebar turned up why they were never linked:

- This admin sidebar (`DashboardLayout`) renders for a session resolved via `trpc.auth.me`,
  which reads the `app_session_id` cookie (or, for an admin-tier employee, `employee_token`
  bridged to a synthetic admin user — see `server/_core/context.ts`).
- Those four pages instead call `trpc.employeePortal.me` directly
  ([EmployeeDashboard.tsx:143](client/src/pages/EmployeeDashboard.tsx:143),
  [ManagerDashboard.tsx:74](client/src/pages/ManagerDashboard.tsx:74),
  [TodayShipments.tsx:97](client/src/pages/TodayShipments.tsx:97),
  [FacebookEntry.tsx:135](client/src/pages/FacebookEntry.tsx:135)), which requires the
  `employee_token` cookie specifically ([routers.ts:35](server/routers.ts:35)) and — on
  failure — **hard-redirects to `/employee-login`**
  ([ManagerDashboard.tsx:77](client/src/pages/ManagerDashboard.tsx:77)).
- An owner who signed in through `/login` has `app_session_id` but no `employee_token`.
  Linking these pages into this sidebar would have sent that owner to a page that
  immediately boots them to a different login screen — a regression, not a fix, and a
  direct violation of "preserve all existing functionality."

These four pages are a **separate portal** reached through `/employee-login`'s own
role-based redirect (manager → `/dashboard`, `facebook_entry` → `/facebook-entry`,
`warehouse` → `/warehouse-dashboard`, everyone else → `/employee-dashboard`), not an
oversight in this sidebar. **Not implemented, and correctly so** — this needed the brief's
"if you find an architectural problem, propose, don't auto-implement" clause. If unifying
the two portals under one navigation is wanted, it is a follow-up decision for the user, not
a UI-phase change.

What **was** a genuine, safe bug — found while tracing the same code — was B6 above:
`/scan-logs` and `/scan-orders` are `ProtectedLayout` pages exactly like every other sidebar
item (same `app_session_id` session, same `trpc.orders.scan` / admin-tier data), but were
routed as bare top-level routes in `App.tsx`, missing the `<ProtectedLayout>` wrapper every
sibling route has. That is a mechanical omission, not a design choice, and fixing it does not
touch auth, permissions, or any business rule — so it was fixed in Phase A alongside B1.

B1 and B6 are both now fixed. B3/B4 stand corrected: intentional, not a bug — the sidebar
change accounts for it by deliberately not linking those four routes.

---

## 2. Per-page audit

Priority: **P1** = daily operational use, **P2** = frequent, **P3** = occasional/admin.

| Page | Lines | Current issues | Proposed improvement | Pri |
|---|---|---|---|---|
| `Orders.tsx` | 2364 | 50 equal-weight buttons in one toolbar; 68 useState; 9 dialogs inline; table truncates; no mobile cards; no column control; no filter chips; no bulk actions | Full restructure: header stats → grouped toolbar (1 primary + overflow menu) → FilterBar with chips → ResponsiveDataTable → row Drawer. Mobile → MobileOrderCard | P1 |
| `EmployeeDashboard.tsx` (Today Confirmations) | 1863 | Single scrolling column; 167 hardcoded colours; no queue/detail split; no keyboard flow; no next/prev; no validation before confirm | Rebuild as 3-pane workflow: queue / detail / sticky actions. Mobile → card + sticky footer | P1 |
| `Inventory.tsx` | 1699 | Table cramped; costPrice column always rendered; mobile squeeze | Summary cards, expandable variant tables, mobile cards, permission-gated cost | P1 |
| `FacebookEntry.tsx` | 1499 | Already improved; still needs section cards + sticky footer + wider fields | Section cards (النص الأصلي / العميل / المنتجات / الأسعار / المراجعة) + StickyActionBar | P1 |
| `ManagerDashboard.tsx` | 1413 | 154 hardcoded colours; wide table; no responsive | Tokens + StatCard grid + ResponsiveDataTable | P2 |
| `Employees.tsx` | 904 | 84 hardcoded colours; `overflow-x-auto`; no breakpoints | Tokens + table system + mobile cards | P2 |
| `SalesChannels.tsx` | 705 | Mostly modernised already | Align to new PageHeader/SectionCard | P3 |
| `Dashboard.tsx` | 629 | 55 hardcoded colours; stat cards ad-hoc | StatCard + tokens | P2 |
| `AgentWorkspace.tsx` | 533 | 33 hardcoded colours | Tokens + layout | P3 |
| `TodayShipments.tsx` | 446 | table + overflow-x, no breakpoints | Table system | P2 |
| `Preparation.tsx` | 437 | table, no breakpoints | Table system + mobile cards | P2 |
| `OrderDetails.tsx` | 434 | 34 hardcoded colours | Tokens + SectionCard | P2 |
| `ScanOrders.tsx` | 361 | 40 hardcoded colours, no breakpoints | Tokens; camera UI needs large touch targets | P2 |
| `WebhookSettings.tsx` | 359 | overflow-x | Tokens + table system | P3 |
| `ScanLogs.tsx` | 351 | 51 hardcoded colours | Tokens + table system | P3 |
| `WarehouseDashboard.tsx` | 348 | no breakpoints | Responsive pass | P2 |
| `PrintedOrders.tsx` | 324 | 35 colours, overflow-x, no breakpoints | Table system | P2 |
| `Reports.tsx` | 304 | overflow-x | Table system + chart tokens | P2 |
| `Businesses.tsx` | 246 | table, no breakpoints | Table system | P3 |
| `Returns.tsx` | 229 | 20 colours, overflow-x | Table system | P2 |
| `ShippingSchedule.tsx` | 223 | 24 colours, overflow-x, no breakpoints | Table system | P2 |
| `MergeLogs.tsx` | 219 | table, overflow-x | Table system | P3 |
| `Duplicates.tsx` | 202 | no breakpoints | Responsive pass | P2 |
| `EmployeeLogin.tsx` / `Login.tsx` | 181 / 145 | no breakpoints | Responsive pass | P3 |
| `PrintLogs.tsx` | 179 | no breakpoints | Table system | P3 |
| `ActivityLog.tsx` | 178 | table, overflow-x, no breakpoints | Table system | P3 |
| `Home.tsx` / `NotFound.tsx` | 69 / 52 | minor | Polish | P3 |

---

## 3. Proposed design system

Tokens already exist in [client/src/index.css](client/src/index.css) and are good — brand
purple `#5B3DF5`, navy `#1E293B`, semantic success/warning/error, radius scale, three
shadow levels. **No token rewrite is needed.** The gap is adoption: ~800 hardcoded colours
bypass them.

Additions proposed (CSS variables only, no breaking change):

- `--color-info` (currently missing; `--chart-2` blue `#3B82F6` is the natural value)
- Spacing scale aliases for consistent card padding / section gaps
- Table row height tokens for the two densities (`comfortable` 56px, `compact` 40px)
- Arabic typography: line-height `1.75` for body, `1.4` for headings, and
  `font-variant-numeric: tabular-nums` on numeric cells so totals align in RTL

## 4. Proposed shared components (`client/src/components/shared/`)

| Component | Replaces (approx.) |
|---|---|
| `PageHeader` | 30 hand-rolled page titles |
| `SectionCard` | ad-hoc Card+CardHeader repetition |
| `StatCard` | 6 different stat-card styles |
| `FilterBar` + `SearchInput` + `DateRangeFilter` + `MultiSelect` | per-page filter rows |
| `StatusBadge` | STATUS_CONFIG duplicated in ≥4 pages |
| `EmptyState` / `ErrorState` / `LoadingSkeleton` | inconsistent blank screens |
| `ConfirmDialog` | destructive actions with no confirm |
| `ResponsiveDataTable` | 16 raw tables |
| `MobileOrderCard` | nothing (missing entirely) |
| `FormSection` / `StickyActionBar` / `Pagination` / `Drawer` | scattered |

`Toast` and `Tooltip` already exist (sonner + shadcn) — they will be wrapped for
consistent Arabic defaults rather than replaced.

## 5. Proposed sidebar grouping

All existing routes and permission gates preserved; only grouping and presentation change.

**As implemented** (revised from the original proposal after the B3/B4 correction above —
`مؤكدات اليوم`, `لوحة المدير`, `إدخال فيسبوك`, and `شحنات اليوم`/`جدول الشحن` are
intentionally not here; see the correction note):

```
الرئيسية      لوحة التحكم · مساحة العمل
الطلبات       الأوردرات · المرتجعات · المكررات
التشغيل       التجهيز والطباعة · المطبوعات · سجل الطباعات
              مسح QR الأوردرات · سجل المسحات · سجل الأنشطة
المخزون       المخزون
الموظفون      الموظفين
التقارير      التقارير · تقرير الدمج
التكاملات     قنوات البيع · ربط Easy Order
الإعدادات     إدارة الأنشطة
```

- Fixes B1 (drop the dead `/employee-qr-scanner` link) and B6 (`/scan-logs`/`/scan-orders`
  now render inside `ProtectedLayout` like every other item, so the sidebar no longer
  disappears when they are opened).
- Admin-only group membership stays exactly as `adminMenuItems` defined it — a `MenuItem`
  now carries `adminOnly?: boolean` instead of living in a second array, but the same
  `isAdmin` boolean gates the same set of items.
- **No الحسابات entry** — the module does not exist, so per the brief it is left out entirely.
- Each group carries a small header icon (`Home`, `ShoppingCart`, `PackageCheck`, `Boxes`,
  `UserCog`, `LineChart`, `Plug`, `Settings`) for the "icon alignment"/"section labels"
  requirement; `SidebarGroupLabel` already fades out under icon-only collapse via the
  existing primitive, so collapsed mode needed no new code.

## 6. Orders page structure

```
PageHeader        title · description · [إضافة أوردر] primary · [⋯] overflow menu
StatCard row      الكل · اليوم · مؤكد اليوم · معلّق · يحتاج مراجعة · ملغي
FilterBar         search · status · source · channel · governorate · product
                  employee · date range · batch · needsReview · duplicate
                  → active chips + reset + count badge
Toolbar           column visibility · density · bulk actions (when rows selected)
ResponsiveDataTable  sticky header · sortable · selectable · sticky actions column
                  → desktop: table   → mobile: MobileOrderCard list
Drawer            full order detail (customer, items, variants, history, warnings)
```

Overflow menu holds: import WhatsApp, Easy Orders import, export confirmed, shipping
sheet, print export, postponed, no-answer.

## 7. Today Confirmations structure

```
Desktop (≥1024px)          Mobile (<1024px)
┌────────┬────────────┐    ┌──────────────┐
│ queue  │ detail     │    │ order card   │
│ list   │ panel      │    │ (expandable) │
│        ├────────────┤    ├──────────────┤
│        │ actions    │    │ sticky action│
└────────┴────────────┘    └──────────────┘
```

- Header: employee, date, queue count, confirmed/postponed/no-answer/cancelled/remaining.
- Actions colour-coded: تأكيد success · مؤجل warning · لم يرد neutral · ملغي danger.
- Destructive actions confirm first; validation blocks تأكيد when required data is missing.
- Keyboard: C/N/P/X/E, suppressed while focus is in an input.
- Next/previous navigation between queued orders.

## 8. Mobile behaviour

| Breakpoint | Behaviour |
|---|---|
| 360–389px | single column; tables → cards; filters → drawer; sticky bottom actions |
| 390–767px | same, slightly wider gutters |
| 768–1023px | 2-column forms; tables still cards for wide datasets |
| 1024–1365px | sidebar collapsible; tables appear; 2-col forms |
| ≥1366px | full layout; 2–3 col forms; drawer for details |

Hard rule: **no horizontal page scroll at any width.** Wide content scrolls inside its own
container only.

---

## 9. Phasing

| Phase | Content | Risk |
|---|---|---|
| A | tokens, shared components, layout, sidebar (+ fix B1/B3) | Low — additive |
| B | Orders, Today Confirmations, Facebook Entry | **High** — busiest pages |
| C | Inventory, Reports, Employees, Returns, Duplicates, Preparation, QR pages | Medium |
| D | Sales Channels, Easy Orders, activity logs, settings, remainder | Low |

Each phase gets its own local commit. No push, no deploy, no migration.

## 10. Migration assessment

**No schema change is required for any of this.** Every item above is presentation-layer.
The only backend touch anticipated is permission-gating the inventory `costPrice` column
if it is not already gated — and that is a read-filter, not a schema change.

## 11. Known risks

1. `Orders.tsx` has 68 `useState` and 9 inline dialogs; restructuring it is the highest-risk
   single change in the project. It must be done incrementally with the page kept working.
2. There is no live database in the dev sandbox, so none of this can be verified against
   real data locally — only type-check, build, unit tests, and the browser preview against
   whatever the dev server can render without a DB.
3. Existing tests cover business logic, not UI. New UI tests will target pure logic
   (filter reducers, validation, permission visibility) rather than pixel output.
