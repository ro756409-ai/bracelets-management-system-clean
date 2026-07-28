-- ============================================================================
-- Multi-tenant migration — validation queries
-- ============================================================================
-- Read-only. Nothing here writes to the database. Run each block against a
-- production READ REPLICA or a fresh backup restore first, never the live
-- primary during business hours, until you're confident in the results.
--
-- Purpose: every query below must return ZERO rows before the corresponding
-- tenantId column is allowed to become NOT NULL, and before any foreign key
-- referencing tenants(id)/businesses(id)/business_groups(id) is added. A
-- non-empty result means either the backfill script needs another pass, or
-- there's real orphaned data that needs a human decision — never silently
-- resolved by the script or by application code.
-- ============================================================================

-- 1) Employees without a matching business (dangling businessId)
SELECT e.id, e.name, e.businessId
FROM employees e
LEFT JOIN businesses b ON b.id = e.businessId
WHERE e.businessId IS NOT NULL AND b.id IS NULL;

-- 2) Employees with NULL tenantId (not yet backfilled, or unresolvable)
SELECT id, name, businessId, role, isActive
FROM employees
WHERE tenantId IS NULL;

-- 3) Employees whose tenantId disagrees with their business's tenantId
SELECT e.id, e.name, e.tenantId AS employeeTenantId, b.id AS businessId, b.tenantId AS businessTenantId
FROM employees e
JOIN businesses b ON b.id = e.businessId
WHERE e.tenantId IS NOT NULL AND e.tenantId <> b.tenantId;

-- 4) Businesses with no resolvable tenant (NULL, or pointing at a tenant row that doesn't exist)
SELECT b.id, b.name, b.tenantId
FROM businesses b
LEFT JOIN tenants t ON t.id = b.tenantId
WHERE b.tenantId IS NULL OR t.id IS NULL;

-- 5) business_groups with no resolvable tenant
SELECT bg.id, bg.name, bg.tenantId
FROM business_groups bg
LEFT JOIN tenants t ON t.id = bg.tenantId
WHERE bg.tenantId IS NULL OR t.id IS NULL;

-- 6) Businesses referencing a business_group that belongs to a DIFFERENT tenant
SELECT b.id AS businessId, b.tenantId AS businessTenantId,
       bg.id AS groupId, bg.tenantId AS groupTenantId
FROM businesses b
JOIN business_groups bg ON bg.id = b.groupId
WHERE b.groupId IS NOT NULL AND (bg.tenantId IS NULL OR bg.tenantId <> b.tenantId);

-- 7) Duplicate tenant slugs (defensive — should be impossible once the UNIQUE
--    constraint on tenants.slug is live, but check raw data before trusting that)
SELECT slug, COUNT(*) AS count
FROM tenants
GROUP BY slug
HAVING COUNT(*) > 1;

-- 8) Orphan subscriptions (tenantId or planId doesn't resolve)
SELECT s.id, s.tenantId, s.planId
FROM subscriptions s
LEFT JOIN tenants t ON t.id = s.tenantId
LEFT JOIN subscription_plans p ON p.id = s.planId
WHERE t.id IS NULL OR p.id IS NULL;

-- 9) Orphan payment_gateway_configs (tenantId doesn't resolve)
SELECT pg.id, pg.tenantId, pg.provider
FROM payment_gateway_configs pg
LEFT JOIN tenants t ON t.id = pg.tenantId
WHERE t.id IS NULL;

-- 10) Duplicate plan feature codes per plan (defensive — should be impossible
--     once plan_features_plan_id_feature_code_unique is live)
SELECT planId, featureCode, COUNT(*) AS count
FROM plan_features
GROUP BY planId, featureCode
HAVING COUNT(*) > 1;

-- 11) Duplicate plan limit codes per plan (defensive — should be impossible
--     once plan_limits_plan_id_limit_code_unique is live)
SELECT planId, limitCode, COUNT(*) AS count
FROM plan_limits
GROUP BY planId, limitCode
HAVING COUNT(*) > 1;

-- 12) import_batches with no resolvable tenant (only relevant if the
--     import_batches.tenantId column is approved and added)
SELECT ib.id, ib.label, ib.performedBy, ib.tenantId
FROM import_batches ib
LEFT JOIN tenants t ON t.id = ib.tenantId
WHERE ib.tenantId IS NULL OR t.id IS NULL;
