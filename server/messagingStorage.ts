import { randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import path from "path";
import { isLocalDeployEnv } from "./deployEnv";
import { deleteObjectAtKey, getObjectAtKey, isObjectStorageConfigured, putObjectAtKey } from "./objectStorage";

/**
 * تخزين ملفات الرسائل (الصوت). القرار:
 *   • التخزين الدائم المتوافق مع S3 (objectStorage) هو الوحيد المسموح في أي بيئة منشورة
 *     (staging/production/preview). غير مضبوط هناك = null والرفع يُرفض (503) — **لا قرص محلي أبدًا**.
 *   • القرص المحلي في development/test فقط (uploads/messages، صلاحية 0600).
 *   • المفتاح يولّده السيرفر: `msg/<tenantId>/voice/<yyyy>/<mm>/<uuid><ext>` — لا اسم من المستخدم، وكل
 *     قراءة/حذف تتحقق أن المفتاح يطابق هذا الشكل وأنه داخل بادئة شركة الصف (لا Path Traversal ولا ملف شركة أخرى).
 *   • الملفات خاصة: لا رابط عام؛ التشغيل عبر Endpoint مصرّح فقط.
 */
export type MessagingStorage = {
  kind: "object" | "local" | "test";
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** Idempotent: غير الموجود = نجاح. */
  del(key: string): Promise<void>;
};

export const MESSAGE_KEY_PATTERN = /^msg\/(\d+)\/voice\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.(webm|ogg|m4a)$/;

export function newVoiceKey(tenantId: number, ext: ".webm" | ".ogg" | ".m4a", now = new Date()): string {
  if (!Number.isInteger(tenantId) || tenantId <= 0) throw new Error("tenantId غير صالح");
  const y = now.getUTCFullYear(), m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `msg/${tenantId}/voice/${y}/${m}/${randomUUID()}${ext}`;
}

/** المفتاح بالشكل المولَّد **و** يخص هذه الشركة — شرط كل قراءة وحذف. */
export function keyBelongsToTenant(key: string, tenantId: number): boolean {
  const m = MESSAGE_KEY_PATTERN.exec(key);
  return Boolean(m) && Number(m![1]) === tenantId;
}

const localRoot = () => path.resolve(process.cwd(), "uploads", "messages");
function localPath(key: string): string {
  if (!MESSAGE_KEY_PATTERN.test(key)) throw new Error("مفتاح تخزين غير صالح");
  const root = localRoot();
  const full = path.resolve(root, key);
  if (!full.startsWith(root + path.sep)) throw new Error("مفتاح تخزين غير صالح");
  return full;
}

const objectStorage: MessagingStorage = {
  kind: "object",
  put: (key, body, type) => { assertKey(key); return putObjectAtKey(key, body, type); },
  get: key => { assertKey(key); return getObjectAtKey(key); },
  del: key => { assertKey(key); return deleteObjectAtKey(key); },
};
const localStorage: MessagingStorage = {
  kind: "local",
  async put(key, body) { const p = localPath(key); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, body, { flag: "wx", mode: 0o600 }); },
  get: key => readFile(localPath(key)).catch(() => null),
  del: key => rm(localPath(key), { force: true }),
};
function assertKey(key: string) { if (!MESSAGE_KEY_PATTERN.test(key)) throw new Error("مفتاح تخزين غير صالح"); }

let override: MessagingStorage | null = null;
/** للاختبار فقط: تخزين بديل (ذاكرة/فشل متعمَّد). */
export function __setMessagingStorageForTests(s: MessagingStorage | null) { override = s; }

/** التخزين المسموح في هذه البيئة، أو null (= الرفع/التشغيل غير متاح). */
export function resolveMessagingStorage(env: NodeJS.ProcessEnv = process.env): MessagingStorage | null {
  if (override) return override;
  if (isObjectStorageConfigured(env)) return objectStorage;
  return isLocalDeployEnv(env) ? localStorage : null;
}

/** تخزين في الذاكرة للاختبارات (مع خيار فشل متعمَّد لكل عملية). */
export function memoryMessagingStorage(fail: { put?: boolean; get?: boolean; del?: boolean } = {}) {
  const files = new Map<string, Buffer>();
  const s: MessagingStorage & { files: Map<string, Buffer>; fail: typeof fail } = {
    kind: "test", files, fail,
    async put(key, body) { assertKey(key); if (s.fail.put) throw new Error("storage down"); files.set(key, body); },
    async get(key) { assertKey(key); if (s.fail.get) throw new Error("storage down"); return files.get(key) ?? null; },
    async del(key) { assertKey(key); if (s.fail.del) throw new Error("storage down"); files.delete(key); },
  };
  return s;
}
