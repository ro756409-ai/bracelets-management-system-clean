import { describe, it, expect } from "vitest";
import { MESSAGE_KEY_PATTERN, keyBelongsToTenant, newVoiceKey, resolveMessagingStorage, memoryMessagingStorage } from "./messagingStorage";

describe("🗄️ تخزين ملفات الرسائل", () => {
  it("المفتاح يولّده السيرفر بلا اسم مستخدم، وبادئة الشركة إلزامية", () => {
    const k = newVoiceKey(7, ".webm", new Date(Date.UTC(2026, 9, 10)));
    expect(k).toMatch(/^msg\/7\/voice\/2026\/10\/[0-9a-f-]{36}\.webm$/);
    expect(keyBelongsToTenant(k, 7)).toBe(true);
    expect(keyBelongsToTenant(k, 8)).toBe(false);
    expect(() => newVoiceKey(0, ".webm")).toThrow();
  });

  it("Path Traversal وأي شكل غير مولَّد مرفوض للقراءة والحذف", async () => {
    for (const bad of ["msg/7/voice/../../etc/passwd", "../msg/7/voice/2026/10/x.webm", "msg/7/voice/2026/10/evil.svg", "msg/7/voice/2026/10/" + "a".repeat(36) + ".html", "/abs/path.webm", "evidence/t7-x.png"]) {
      expect(MESSAGE_KEY_PATTERN.test(bad)).toBe(false);
      expect(keyBelongsToTenant(bad, 7)).toBe(false);
    }
    const s = memoryMessagingStorage();
    await expect(s.get("msg/7/voice/../../x.webm")).rejects.toThrow();
    await expect(s.del("evidence/t7-x.png")).rejects.toThrow();
  });

  it("البيئات المنشورة بلا تخزين دائم = null (لا قرص محلي أبدًا)؛ المحلي في development/test فقط", () => {
    const none = { S3_BUCKET: "", S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "" };
    for (const DEPLOY_ENV of ["staging", "production", "preview", "unknown-env"]) expect(resolveMessagingStorage({ ...none, DEPLOY_ENV } as any)).toBeNull();
    expect(resolveMessagingStorage({ ...none, NODE_ENV: "production" } as any)).toBeNull();
    expect(resolveMessagingStorage({ ...none, DEPLOY_ENV: "development" } as any)?.kind).toBe("local");
    expect(resolveMessagingStorage({ S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", DEPLOY_ENV: "staging" } as any)?.kind).toBe("object");
  });
});
