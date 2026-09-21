import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "crypto";
import {
  encryptSecret,
  decryptSecret,
  hashSecret,
  deriveWebhookSecret,
  randomSalt,
  isSecretBoxConfigured,
} from "./secretBox";

const KEY = randomBytes(32).toString("base64");
let saved: string | undefined;
beforeEach(() => { saved = process.env.CARRIER_SECRETS_KEY; process.env.CARRIER_SECRETS_KEY = KEY; });
afterEach(() => { if (saved == null) delete process.env.CARRIER_SECRETS_KEY; else process.env.CARRIER_SECRETS_KEY = saved; });

describe("🔒 secretBox — AES-256-GCM", () => {
  it("🔑 تشفير/فك يرجّع الأصل، والنص المشفّر مش الأصل", () => {
    const sealed = encryptSecret("bosta-api-key-XYZ123");
    expect(sealed.ciphertext).not.toContain("XYZ123");
    expect(decryptSecret(sealed)).toBe("bosta-api-key-XYZ123");
  });
  it("🔒 IV مختلف لكل تشفير (نفس النص → نص مشفّر مختلف)", () => {
    expect(encryptSecret("same").ciphertext).not.toBe(encryptSecret("same").ciphertext);
  });
  it("🔒 تعديل بايت في القاعدة بيكشف نفسه (auth tag)", () => {
    const s = encryptSecret("secret");
    const buf = Buffer.from(s.ciphertext, "base64"); buf[0] ^= 1;
    expect(() => decryptSecret({ ...s, ciphertext: buf.toString("base64") })).toThrow();
  });
  it("🔒 بلا CARRIER_SECRETS_KEY → رفض، مفيش fallback", () => {
    delete process.env.CARRIER_SECRETS_KEY;
    expect(isSecretBoxConfigured()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/CARRIER_SECRETS_KEY/);
  });
  it("🔒 مفتاح بطول غلط → رفض", () => {
    process.env.CARRIER_SECRETS_KEY = Buffer.from("short").toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32/);
  });
  it("🔑 سر الـwebhook: نفس النشاط ونفس الملح = نفس السر؛ ملح جديد = سر جديد؛ نشاط تاني = سر تاني", () => {
    const salt = randomSalt();
    expect(deriveWebhookSecret("bosta", 7, salt)).toBe(deriveWebhookSecret("bosta", 7, salt));
    expect(deriveWebhookSecret("bosta", 7, salt)).not.toBe(deriveWebhookSecret("bosta", 7, randomSalt()));
    expect(deriveWebhookSecret("bosta", 7, salt)).not.toBe(deriveWebhookSecret("bosta", 8, salt));
    expect(hashSecret("a")).not.toBe(hashSecret("b"));
  });
});
