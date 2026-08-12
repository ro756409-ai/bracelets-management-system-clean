/**
 * تخزين كائنات دائم متوافق مع S3 (S3 / R2 / MinIO / DigitalOcean Spaces).
 *
 * المرفقات كانت بتتكتب على قرص الـcontainer وبتضيع مع أي redeploy. الوحدة دي بتديها
 * تخزين دائم بره الـcontainer. **مدفوعة بالبيئة بالكامل** — لو المتغيرات مش مظبوطة،
 * `isObjectStorageConfigured()` بترجّع false والمنادي بيرجع للقرص المحلي (للتطوير بس).
 *
 * مافيش أي credential بيتخزّن في قاعدة البيانات أو بيتبعت للواجهة — القيم من env بس،
 * والتنزيل بيعدّي من مسار مُتحقّق (`/api/evidence/files/:name`) مش برابط عام من الـbucket،
 * فالـauth بيفضل قايم والـbucket مايتكشفش.
 *
 * المتغيرات:
 *   S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY   (مطلوبة للتفعيل)
 *   S3_ENDPOINT       (لـR2/MinIO/Spaces؛ فاضي = AWS S3 الرسمي)
 *   S3_REGION         (افتراضي us-east-1؛ R2 بتقبل auto)
 *   S3_FORCE_PATH_STYLE ("true"/"false"، افتراضي true — أأمن مع MinIO/الأنظمة المتوافقة)
 */
import type {
  GetObjectCommandOutput,
  S3Client as S3ClientType,
} from "@aws-sdk/client-s3";

export type ObjectStorageConfig = {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  region: string;
  forcePathStyle: boolean;
};

/** بتقرا الإعداد من البيئة، أو null لو الأساسيات ناقصة. نقية وقابلة للاختبار. */
export function readObjectStorageConfig(
  env: NodeJS.ProcessEnv = process.env
): ObjectStorageConfig | null {
  const bucket = env.S3_BUCKET?.trim();
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  return {
    bucket,
    accessKeyId,
    secretAccessKey,
    endpoint: env.S3_ENDPOINT?.trim() || undefined,
    region: env.S3_REGION?.trim() || "us-east-1",
    // الافتراضي path-style — بيشتغل مع MinIO/الأنظمة المتوافقة من غير DNS للـbucket.
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? "true").toLowerCase() !== "false",
  };
}

export function isObjectStorageConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return readObjectStorageConfig(env) !== null;
}

/** مفتاح الكائن جوه الـbucket — كل المرفقات تحت بادئة واحدة. */
export function evidenceObjectKey(filename: string): string {
  return `evidence/${filename}`;
}

// عميل واحد كسول — بيتبني مرة أول استخدام فعلي بس.
let cachedClient: S3ClientType | null = null;
let cachedConfigJson = "";

async function getClient(config: ObjectStorageConfig): Promise<S3ClientType> {
  const key = JSON.stringify(config);
  if (cachedClient && cachedConfigJson === key) return cachedClient;
  const { S3Client } = await import("@aws-sdk/client-s3");
  cachedClient = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // نسخ aws-sdk الحديثة (3.729+) بتضيف checksum تلقائي (CRC32) بيرفضه R2/MinIO/Spaces،
    // فالرفع بيفشل على أي تخزين متوافق مع S3 غير AWS نفسه. بنطلبه "عند اللزوم" بس —
    // AWS بيفضل شغّال، وR2 وأخواته بيرفعوا عادي.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  cachedConfigJson = key;
  return cachedClient;
}

/** يرفع كائن. بيرمي لو فشل — المنادي بيتعامل مع الفشل (مايكتبش مرجع لملف مش موجود). */
export async function putObject(
  filename: string,
  body: Buffer,
  contentType: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = readObjectStorageConfig(env);
  if (!config) throw new Error("Object storage is not configured");
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await getClient(config);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: evidenceObjectKey(filename),
      Body: body,
      ContentType: contentType,
    })
  );
}

/** ينزّل كائن كـBuffer، أو null لو مش موجود. */
export async function getObject(
  filename: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Buffer | null> {
  const config = readObjectStorageConfig(env);
  if (!config) throw new Error("Object storage is not configured");
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = await getClient(config);
  try {
    const out: GetObjectCommandOutput = await client.send(
      new GetObjectCommand({
        Bucket: config.bucket,
        Key: evidenceObjectKey(filename),
      })
    );
    if (!out.Body) return null;
    const bytes = await out.Body.transformToByteArray();
    return Buffer.from(bytes);
  } catch (error: any) {
    if (
      error?.name === "NoSuchKey" ||
      error?.$metadata?.httpStatusCode === 404
    ) {
      return null;
    }
    throw error;
  }
}

/** للاختبار — بيصفّر العميل المخبّأ. */
export function __resetObjectStorageClientForTests(): void {
  cachedClient = null;
  cachedConfigJson = "";
}
