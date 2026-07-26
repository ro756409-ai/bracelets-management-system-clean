import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAdminContext(): TrpcContext {
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
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

function createUserContext(): TrpcContext {
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
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

/**
 * The context a NON-admin-tier employee actually gets in production.
 *
 * server/_core/context.ts only ever sets ctx.user via buildSyntheticAdminUser(), and only
 * for employees passing `emp.isActive && isAdminTierRole(emp.role)`. Every other employee —
 * viewer, agent, warehouse, data_entry, order_confirmation, shipping, accountant,
 * facebook_entry, scanner — gets `user: null` and is rejected before any router runs.
 * (Those roles use the separate /employee-login portal, not this router tree.)
 */
function createNoUserContext(): TrpcContext {
  return {
    user: null,
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: { clearCookie: () => {} } as TrpcContext["res"],
  };
}

/** Skips the rest of a test gracefully in environments with no live DATABASE_URL. */
function isNoDbError(err: unknown): boolean {
  return String((err as any)?.message ?? err).includes("Database not available");
}

describe("salesChannels — access control", () => {
  it("non-admin cannot LIST channels (they hold integration credentials)", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.salesChannels.list()).rejects.toThrow();
  });

  it("non-admin cannot GET a single channel", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.salesChannels.get({ id: 1 })).rejects.toThrow();
  });

  it("non-admin cannot list ACTIVE channels", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.salesChannels.activeList()).rejects.toThrow();
  });

  it("non-admin cannot create / update / delete / reactivate / clearSecret", async () => {
    const caller = appRouter.createCaller(createUserContext());
    await expect(caller.salesChannels.create({ businessId: 1, name: "قناة اختبار" })).rejects.toThrow();
    await expect(caller.salesChannels.update({ id: 1, name: "تعديل" })).rejects.toThrow();
    await expect(caller.salesChannels.delete({ id: 1 })).rejects.toThrow();
    await expect(caller.salesChannels.reactivate({ id: 1 })).rejects.toThrow();
    await expect(caller.salesChannels.clearSecret({ id: 1, field: "apiToken" })).rejects.toThrow();
  });

  it("admin CAN list channels", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const result = await caller.salesChannels.list();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("salesChannels — production role reality (regression guard)", () => {
  // These document how auth ACTUALLY resolves in this app, so the equivalence below
  // can't silently drift. createUserContext() above (role: "user") is a synthetic shape
  // that production never produces — the real non-admin state is `user: null`.

  it("a session with no user (every non-admin-tier employee) is rejected from all procedures", async () => {
    const caller = appRouter.createCaller(createNoUserContext());
    await expect(caller.salesChannels.list()).rejects.toThrow();
    await expect(caller.salesChannels.activeList()).rejects.toThrow();
    await expect(caller.salesChannels.get({ id: 1 })).rejects.toThrow();
    await expect(caller.salesChannels.create({ businessId: 1, name: "قناة" })).rejects.toThrow();
    await expect(caller.salesChannels.update({ id: 1, name: "قناة" })).rejects.toThrow();
    await expect(caller.salesChannels.delete({ id: 1 })).rejects.toThrow();
    await expect(caller.salesChannels.reactivate({ id: 1 })).rejects.toThrow();
    await expect(caller.salesChannels.clearSecret({ id: 1, field: "apiToken" })).rejects.toThrow();
  });

  it("exactly super_admin/admin/manager are admin-tier — everyone else has no dashboard session", async () => {
    const { isAdminTierRole, EMPLOYEE_ROLE_VALUES } = await import("./permissions");
    const adminTier = EMPLOYEE_ROLE_VALUES.filter(isAdminTierRole);
    expect([...adminTier].sort()).toEqual(["admin", "manager", "super_admin"]);

    // Viewer specifically — the role called out in the access review.
    expect(isAdminTierRole("viewer")).toBe(false);
    for (const role of ["viewer", "agent", "warehouse", "data_entry", "order_confirmation", "shipping", "accountant", "facebook_entry", "scanner"]) {
      expect(isAdminTierRole(role)).toBe(false);
    }
  });

  it("moving reads from protectedProcedure to adminProcedure did not change who has access", async () => {
    // context.ts builds ctx.user ONLY via buildSyntheticAdminUser(), which hardcodes
    // role:"admin", and only for admin-tier employees. So `ctx.user != null` already
    // implies `ctx.user.role === "admin"` — protectedProcedure and adminProcedure admit
    // an identical set, and no previously-authorized user lost access.
    const adminCaller = appRouter.createCaller(createAdminContext());
    const noUserCaller = appRouter.createCaller(createNoUserContext());

    // protectedProcedure-based (unchanged by this work) and adminProcedure-based
    // (changed) behave identically for both context shapes.
    await expect(adminCaller.products.list()).resolves.toBeDefined();      // protectedProcedure
    await expect(adminCaller.salesChannels.list()).resolves.toBeDefined(); // adminProcedure (was protected)
    await expect(noUserCaller.products.list()).rejects.toThrow();
    await expect(noUserCaller.salesChannels.list()).rejects.toThrow();
  });
});

describe("salesChannels — secrets are never returned to clients", () => {
  it("list() results contain no apiToken/webhookSecret fields, only masked indicators", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const channels = await caller.salesChannels.list();
    for (const channel of channels) {
      expect(channel).not.toHaveProperty("apiToken");
      expect(channel).not.toHaveProperty("webhookSecret");
      expect(channel).toHaveProperty("hasApiToken");
      expect(channel).toHaveProperty("apiTokenLast4");
      expect(channel).toHaveProperty("hasWebhookSecret");
      expect(channel).toHaveProperty("webhookSecretLast4");
    }
  });

  it("a created channel's secret is stored but never echoed back", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const secret = "super-secret-" + Date.now();
    let created;
    try {
      created = await caller.salesChannels.create({
        businessId: 1,
        name: "قناة أسرار " + Date.now(),
        platform: "easyorder",
        apiToken: secret,
        webhookSecret: secret + "-wh",
      });
    } catch (err) {
      if (isNoDbError(err)) return;
      throw err;
    }

    const fetched = await caller.salesChannels.get({ id: created.id });
    expect(fetched).toBeDefined();
    expect(fetched).not.toHaveProperty("apiToken");
    expect(fetched).not.toHaveProperty("webhookSecret");
    expect(fetched!.hasApiToken).toBe(true);
    expect(fetched!.hasWebhookSecret).toBe(true);
    // only the last 4 characters are exposed, for identification
    expect(fetched!.apiTokenLast4).toBe(secret.slice(-4));
    expect(JSON.stringify(fetched)).not.toContain(secret);
  });
});

describe("salesChannels — validation", () => {
  it("rejects a name shorter than 2 characters", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    await expect(
      caller.salesChannels.create({ businessId: 1, name: "ق" })
    ).rejects.toThrow();
  });

  it("rejects a malformed domain / webhookUrl", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    await expect(
      caller.salesChannels.create({ businessId: 1, name: "قناة دومين", domain: "not-a-url" })
    ).rejects.toThrow();
    await expect(
      caller.salesChannels.create({ businessId: 1, name: "قناة ويبهوك", webhookUrl: "also-not-a-url" })
    ).rejects.toThrow();
  });

  it("rejects a webhook secret shorter than 8 characters", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    await expect(
      caller.salesChannels.create({ businessId: 1, name: "قناة سر قصير", webhookSecret: "short" })
    ).rejects.toThrow();
  });

  it("rejects a duplicate webhook secret (webhooks must route unambiguously)", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const sharedSecret = "duplicate-secret-" + Date.now();
    try {
      await caller.salesChannels.create({
        businessId: 1, name: "قناة أولى " + Date.now(), webhookSecret: sharedSecret,
      });
    } catch (err) {
      if (isNoDbError(err)) return;
      throw err;
    }
    await expect(
      caller.salesChannels.create({
        businessId: 1, name: "قناة ثانية " + Date.now(), webhookSecret: sharedSecret,
      })
    ).rejects.toThrow();
  });

  it("rejects a duplicate channel name within the same business", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const name = "قناة مكررة " + Date.now();
    try {
      await caller.salesChannels.create({ businessId: 1, name });
    } catch (err) {
      if (isNoDbError(err)) return;
      throw err;
    }
    await expect(
      caller.salesChannels.create({ businessId: 1, name })
    ).rejects.toThrow();
  });
});

describe("salesChannels — secret lifecycle", () => {
  it("an update with a blank secret keeps the stored one (forms can't round-trip secrets)", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const token = "keepme-token-" + Date.now();
    let created;
    try {
      created = await caller.salesChannels.create({
        businessId: 1, name: "قناة إبقاء " + Date.now(), apiToken: token,
      });
    } catch (err) {
      if (isNoDbError(err)) return;
      throw err;
    }

    // Update only the name; secrets omitted entirely.
    await caller.salesChannels.update({ id: created.id, name: "قناة إبقاء معدّلة " + Date.now() });
    const afterOmitted = await caller.salesChannels.get({ id: created.id });
    expect(afterOmitted!.hasApiToken).toBe(true);
    expect(afterOmitted!.apiTokenLast4).toBe(token.slice(-4));

    // Update sending an empty string — must also be treated as "unchanged", not "clear".
    await caller.salesChannels.update({ id: created.id, apiToken: "" });
    const afterEmpty = await caller.salesChannels.get({ id: created.id });
    expect(afterEmpty!.hasApiToken).toBe(true);
    expect(afterEmpty!.apiTokenLast4).toBe(token.slice(-4));
  });

  it("a non-empty secret on update replaces the stored one", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    let created;
    try {
      created = await caller.salesChannels.create({
        businessId: 1, name: "قناة استبدال " + Date.now(), apiToken: "original-token-0000",
      });
    } catch (err) {
      if (isNoDbError(err)) return;
      throw err;
    }
    await caller.salesChannels.update({ id: created.id, apiToken: "replacement-token-9999" });
    const after = await caller.salesChannels.get({ id: created.id });
    expect(after!.apiTokenLast4).toBe("9999");
  });

  it("clearSecret removes a stored credential", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    let created;
    try {
      created = await caller.salesChannels.create({
        businessId: 1, name: "قناة مسح " + Date.now(), apiToken: "to-be-cleared-1234",
      });
    } catch (err) {
      if (isNoDbError(err)) return;
      throw err;
    }
    expect((await caller.salesChannels.get({ id: created.id }))!.hasApiToken).toBe(true);

    await caller.salesChannels.clearSecret({ id: created.id, field: "apiToken" });
    const after = await caller.salesChannels.get({ id: created.id });
    expect(after!.hasApiToken).toBe(false);
    expect(after!.apiTokenLast4).toBeNull();
  });
});

describe("salesChannels — connection test", () => {
  it("is admin-only", async () => {
    const userCaller = appRouter.createCaller(createUserContext());
    const noUserCaller = appRouter.createCaller(createNoUserContext());
    await expect(userCaller.salesChannels.testConnection({ id: 1 })).rejects.toThrow();
    await expect(noUserCaller.salesChannels.testConnection({ id: 1 })).rejects.toThrow();
  });

  it("reports NO_TOKEN (rather than throwing) for a channel with no credentials", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    let created;
    try {
      created = await caller.salesChannels.create({
        businessId: 1,
        name: "قناة بلا توكن " + Date.now(),
        platform: "easyorder",
      });
    } catch (err) {
      if (isNoDbError(err)) return;
      throw err;
    }

    const result = await caller.salesChannels.testConnection({ id: created.id });
    expect(result.connected).toBe(false);
    expect(result.errorCode).toBe("NO_TOKEN");

    // The failed test must be recorded on the channel...
    const after = await caller.salesChannels.get({ id: created.id });
    expect(after!.lastConnectionStatus).toBe("failed");
    expect(after!.lastConnectionTestAt).toBeTruthy();
  });

  it("never returns raw credentials in the result", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    const secret = "connection-test-secret-" + Date.now();
    let created;
    try {
      created = await caller.salesChannels.create({
        businessId: 1,
        name: "قناة اختبار اتصال " + Date.now(),
        platform: "easyorder",
        apiToken: secret,
      });
    } catch (err) {
      if (isNoDbError(err)) return;
      throw err;
    }

    // Will fail to reach the (nonexistent) provider, which is fine — we only assert
    // that nothing sensitive comes back regardless of outcome.
    const result = await caller.salesChannels.testConnection({ id: created.id });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).not.toHaveProperty("apiToken");
  });

  it("does not create any order while testing a connection", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    let created;
    try {
      created = await caller.salesChannels.create({
        businessId: 1,
        name: "قناة بدون استيراد " + Date.now(),
        platform: "easyorder",
        apiToken: "some-token-value",
      });
    } catch (err) {
      if (isNoDbError(err)) return;
      throw err;
    }

    const before = (await caller.orders.list({ limit: 1 })).total;
    await caller.salesChannels.testConnection({ id: created.id });
    const after = (await caller.orders.list({ limit: 1 })).total;
    expect(after).toBe(before);
  });
});

describe("salesChannels — archive / reactivate", () => {
  it("delete() soft-deletes (isActive=false) without removing the row, and reactivate() restores it", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    let created;
    try {
      created = await caller.salesChannels.create({
        businessId: 1, name: "قناة أرشفة " + Date.now(),
      });
    } catch (err) {
      if (isNoDbError(err)) return;
      throw err;
    }

    await caller.salesChannels.delete({ id: created.id });
    const archived = await caller.salesChannels.get({ id: created.id });
    expect(archived).toBeDefined(); // row still exists
    expect(archived!.isActive).toBe(false);

    // archived channels are excluded from activeList
    const active = await caller.salesChannels.activeList();
    expect(active.find((c) => c.id === created.id)).toBeUndefined();

    await caller.salesChannels.reactivate({ id: created.id });
    const restored = await caller.salesChannels.get({ id: created.id });
    expect(restored!.isActive).toBe(true);
  });

  it("list({ includeInactive: false }) hides archived channels", async () => {
    const caller = appRouter.createCaller(createAdminContext());
    let created;
    try {
      created = await caller.salesChannels.create({
        businessId: 1, name: "قناة إخفاء " + Date.now(),
      });
    } catch (err) {
      if (isNoDbError(err)) return;
      throw err;
    }
    await caller.salesChannels.delete({ id: created.id });

    const withArchived = await caller.salesChannels.list({ includeInactive: true });
    const withoutArchived = await caller.salesChannels.list({ includeInactive: false });
    expect(withArchived.find((c) => c.id === created.id)).toBeDefined();
    expect(withoutArchived.find((c) => c.id === created.id)).toBeUndefined();
  });
});
