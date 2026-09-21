import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "crypto";

/**
 * تشفير أسرار شركات الشحن — AES-256-GCM بمفتاح رئيسي من البيئة.
 *
 * المفتاح `CARRIER_SECRETS_KEY` (32 بايت base64) بيعيش في Coolify بس: مش في القاعدة ولا
 * في الريبو. غيابه = **رفض** أي حفظ أو فك — مفيش fallback لنص عادي ولا لمفتاح افتراضي.
 * كل سر ليه IV عشوائي وtag مصادقة، فتعديل أي بايت في القاعدة بيكشف نفسه عند الفك.
 */

const ENV_NAME = "CARRIER_SECRETS_KEY";

function masterKey(): Buffer {
  const raw = process.env[ENV_NAME];
  if (!raw) throw new Error(`${ENV_NAME} غير مضبوط — لا يمكن حفظ أو قراءة مفاتيح شركات الشحن`);
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new Error(`${ENV_NAME} لازم يكون 32 بايت base64 (openssl rand -base64 32)`);
  return key;
}

export function isSecretBoxConfigured(): boolean {
  try {
    masterKey();
    return true;
  } catch {
    return false;
  }
}

export interface SealedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function encryptSecret(plain: string): SealedSecret {
  const key = masterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { ciphertext: ct.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptSecret(sealed: SealedSecret): string {
  const key = masterKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

/** hash للبحث (سر الـwebhook) — مش قابل للعكس. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * سر webhook لكل نشاط — مشتق من المفتاح الرئيسي + ملح عشوائي مخزّن.
 * بيتحسب وقت الحاجة (إرسال الشحنة) بدل تخزينه مشفّرًا، وتغيير الملح = تدوير السر.
 */
export function deriveWebhookSecret(provider: string, businessId: number, salt: string): string {
  return createHmac("sha256", masterKey())
    .update(`${provider}:${businessId}:${salt}`)
    .digest("base64url");
}

export function randomSalt(): string {
  return randomBytes(24).toString("base64url");
}
