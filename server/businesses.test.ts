import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { createCoreTestFixture, type CoreTestFixture } from "./testFixtures";
import { getDb } from "./db";
import { businesses } from "../drizzle/schema";
import { like } from "drizzle-orm";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAdminContext(tenantId: number): TrpcContext {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "admin-user",
    email: "admin@example.com",
    name: "Admin User",
    loginMethod: "manus",
    role: "admin",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    tenantId,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

function createUserContext(tenantId: number): TrpcContext {
  const user: AuthenticatedUser = {
    id: 2,
    openId: "regular-user",
    email: "user@example.com",
    name: "Regular User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return {
    user,
    tenantId,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))(
  "businesses router",
  () => {
    let fixture: CoreTestFixture;
    const createdSlugPrefix = `test-biz-${Date.now()}`;
    beforeAll(async () => {
      fixture = await createCoreTestFixture("businesses");
    });
    afterAll(async () => {
      const db = await getDb();
      if (db)
        await db
          .delete(businesses)
          .where(like(businesses.slug, `${createdSlugPrefix}%`));
      await fixture?.cleanup();
    });

    it("activeList returns an array", async () => {
      const ctx = createAdminContext(fixture.tenantId);
      const caller = appRouter.createCaller(ctx);
      const result = await caller.businesses.activeList();
      expect(Array.isArray(result)).toBe(true);
    });

    it("list returns businesses for admin", async () => {
      const ctx = createAdminContext(fixture.tenantId);
      const caller = appRouter.createCaller(ctx);
      const result = await caller.businesses.list();
      expect(Array.isArray(result)).toBe(true);
    });

    it("create adds a new business (admin only)", async () => {
      const ctx = createAdminContext(fixture.tenantId);
      const caller = appRouter.createCaller(ctx);
      const result = await caller.businesses.create({
        name: "Test Business",
        slug: `${createdSlugPrefix}-${Math.random().toString(36).slice(2, 7)}`,
      });
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    it("non-admin can still call activeList (public procedure)", async () => {
      const ctx = createUserContext(fixture.tenantId);
      const caller = appRouter.createCaller(ctx);
      const result = await caller.businesses.activeList();
      expect(Array.isArray(result)).toBe(true);
    });
  }
);
