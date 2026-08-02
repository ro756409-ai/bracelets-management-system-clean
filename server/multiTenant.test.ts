import { describe, it, expect } from "vitest";
import fs from "fs";

// Most tenant-isolation behavior is already covered end-to-end in authContext.test.ts (rejection
// of an unresolved tenantId, no fallback to a default/first/hardcoded tenant) and
// security.test.ts (the requireEmployeePermission / scopeBusinessId sweep). This file covers the
// remaining checks that need either the generated migration SQL or the router/db source itself,
// following the same source-verification pattern already used in security.test.ts for things
// that would otherwise require a live database connection this sandbox doesn't have.

describe("Multi-tenant: no fallback anywhere in the auth-critical path", () => {
  it("context.ts never falls back to a hardcoded/default tenantId", async () => {
    const content = fs.readFileSync("server/_core/context.ts", "utf-8");
    expect(content).not.toMatch(/tenantId:\s*1\b/);
    expect(content).not.toContain("tenantId ?? 1");
    expect(content).toContain("rejectUnresolvedTenant");
  });

  it("routers.ts's tenant helpers never default a resolved tenantId to 1", async () => {
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    expect(content).not.toContain("tenantId ?? 1");
    expect(content).not.toContain("getTenantIdForBusiness"); // removed — replaced by requireTenantId reading emp.tenantId directly
    expect(content).toContain(
      "function requireTenantId(emp: { tenantId: number | null }): number {"
    );
  });

  it("db.ts's tenant helpers return null/undefined instead of asserting a default tenant when unresolved", async () => {
    const content = fs.readFileSync("server/db.ts", "utf-8");
    expect(content).not.toContain("return 1;"); // the old getTenantIdForBusiness fallback pattern
    expect(content).toMatch(
      /export async function getBusinessIdsForTenant\(\s*tenantId: number\s*\): Promise<number\[\] \| null>/
    );
  });
});

describe("Multi-tenant: employee creation inherits the creator's tenant", () => {
  it("employees.create (admin) stamps the acting admin's ctx.tenantId onto the new employee", async () => {
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const match =
      /create:\s*adminProcedure\s*\.input\(\s*z\.object\(\{\s*name:\s*z\.string\(\)\.min\(2\)/m.exec(
        content
      );
    const idx = match?.index ?? -1;
    expect(idx).toBeGreaterThan(-1);
    const section = content.substring(idx, idx + 1200);
    expect(section).toContain("tenantId: ctx.tenantId");
  });

  it("employeePortal.createEmployee (manager) stamps the manager's own resolved tenantId onto the new employee", async () => {
    const content = fs.readFileSync("server/routers.ts", "utf-8");
    const idx = content.indexOf("createEmployee: managerPortalProcedure");
    expect(idx).toBeGreaterThan(-1);
    const section = content.substring(idx, idx + 1200);
    expect(section).toContain("requireTenantId(emp)");
    expect(section).toContain("tenantId");
  });
});

describe("Multi-tenant: business_groups cross-tenant protection", () => {
  it("createBusiness/updateBusiness reject a groupId belonging to a different tenant", async () => {
    const content = fs.readFileSync("server/db.ts", "utf-8");
    expect(content).toContain("Business group belongs to a different tenant");
    // Both mutation entry points must run the check, not just one.
    const createIdx = content.indexOf("export async function createBusiness");
    const updateIdx = content.indexOf("export async function updateBusiness");
    expect(createIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(content.substring(createIdx, createIdx + 400)).toContain(
      "getBusinessGroupTenantId"
    );
    expect(content.substring(updateIdx, updateIdx + 600)).toContain(
      "getBusinessGroupTenantId"
    );
  });
});

describe("Multi-tenant: no database-level default tenant fallback on nullable columns", () => {
  it("business_groups.tenantId / employees.tenantId / import_batches.tenantId have no DEFAULT in the generated migration", async () => {
    const migration = fs.readFileSync(
      "drizzle/0029_puzzling_genesis.sql",
      "utf-8"
    );
    expect(migration).toContain(
      "ALTER TABLE `business_groups` ADD `tenantId` int;"
    );
    expect(migration).toContain("ALTER TABLE `employees` ADD `tenantId` int;");
    expect(migration).toContain(
      "ALTER TABLE `import_batches` ADD `tenantId` int;"
    );
    // None of these three ALTER statements may carry a DEFAULT or NOT NULL — unlike
    // businesses.tenantId (migration 0028), which is a known, separately-tracked issue.
    expect(migration).not.toMatch(/ADD `tenantId` int DEFAULT/);
  });

  it("plan_features / plan_limits have real composite UNIQUE constraints in the generated migration", async () => {
    const migration = fs.readFileSync(
      "drizzle/0029_puzzling_genesis.sql",
      "utf-8"
    );
    expect(migration).toContain(
      "CONSTRAINT `plan_features_plan_id_feature_code_unique` UNIQUE(`planId`,`featureCode`)"
    );
    expect(migration).toContain(
      "CONSTRAINT `plan_limits_plan_id_limit_code_unique` UNIQUE(`planId`,`limitCode`)"
    );
  });

  it("schema.ts defines plan_features/plan_limits uniqueness via uniqueIndex, not a no-op object literal", async () => {
    const content = fs.readFileSync("drizzle/schema.ts", "utf-8");
    expect(content).toMatch(
      /uniqueIndex\(\s*"plan_features_plan_id_feature_code_unique"\s*\)\.on\(table\.planId, table\.featureCode\)/
    );
    expect(content).toMatch(
      /uniqueIndex\(\s*"plan_limits_plan_id_limit_code_unique"\s*\)\.on\(\s*table\.planId,\s*table\.limitCode\s*\)/
    );
  });
});
