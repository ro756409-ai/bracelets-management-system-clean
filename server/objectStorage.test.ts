import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  readObjectStorageConfig,
  isObjectStorageConfigured,
  evidenceObjectKey,
} from "./objectStorage";

/**
 * إعداد التخزين الدائم — نقي وقابل للاختبار من غير شبكة.
 * الرفع/التنزيل الفعلي على S3 محتاج credentials حقيقية (تحقّق يدوي بعد ضبط البيئة).
 */
describe("readObjectStorageConfig", () => {
  it("null لو الأساسيات ناقصة → المنادي بيرجع للقرص المحلي", () => {
    expect(readObjectStorageConfig({})).toBeNull();
    expect(
      readObjectStorageConfig({ S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k" } as any)
    ).toBeNull(); // بلا secret
    expect(isObjectStorageConfigured({} as any)).toBe(false);
  });

  it("بيقرا الإعداد الكامل مع الافتراضات الآمنة", () => {
    const cfg = readObjectStorageConfig({
      S3_BUCKET: "matjarak",
      S3_ACCESS_KEY_ID: "AK",
      S3_SECRET_ACCESS_KEY: "SK",
    } as any);
    expect(cfg).toEqual({
      bucket: "matjarak",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      endpoint: undefined,
      region: "us-east-1",
      forcePathStyle: true, // الافتراضي الآمن للأنظمة المتوافقة
    });
  });

  it("بيحترم endpoint/region/forcePathStyle المخصّصين (R2/MinIO/Spaces)", () => {
    const cfg = readObjectStorageConfig({
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "AK",
      S3_SECRET_ACCESS_KEY: "SK",
      S3_ENDPOINT: "https://x.r2.cloudflarestorage.com",
      S3_REGION: "auto",
      S3_FORCE_PATH_STYLE: "false",
    } as any);
    expect(cfg?.endpoint).toBe("https://x.r2.cloudflarestorage.com");
    expect(cfg?.region).toBe("auto");
    expect(cfg?.forcePathStyle).toBe(false);
  });

  it("مفتاح الكائن تحت بادئة evidence", () => {
    expect(evidenceObjectKey("abc.pdf")).toBe("evidence/abc.pdf");
  });
});

describe("🔑 evidenceUpload بيستخدم التخزين الدائم لو متظبّط", () => {
  const src = fs.readFileSync("server/evidenceUpload.ts", "utf-8");
  it("الرفع: putObject لما متظبّط، وقرص محلي fallback بس", () => {
    expect(src).toContain("isObjectStorageConfigured()");
    expect(src).toContain("putObject(");
  });
  it("التنزيل: getObject لما متظبّط", () => {
    expect(src).toContain("getObject(");
  });
  it("🔑 مفيش credential بيتبعت للواجهة — المرجع مسار مُتحقّق مش رابط bucket", () => {
    expect(src).toContain("/api/evidence/files/");
    expect(src).not.toMatch(/S3_SECRET|secretAccessKey/);
  });
});
