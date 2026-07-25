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
