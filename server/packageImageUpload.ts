import { randomUUID } from "crypto";
import { access, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { Express, Request } from "express";
import multer from "multer";
import jwt from "jsonwebtoken";
import { getObject, isObjectStorageConfigured, objectExists, putObject } from "./objectStorage";
import { isLocalDeployEnv } from "./deployEnv";
import { resolveScope, hasValidSignature } from "./evidenceUpload";
import { getEmployeeById } from "./db";
import { isAdminTierRole } from "./permissions";
import { PACKAGE_IMAGE_FILENAME_PATTERN, PACKAGE_IMAGE_URL_PREFIX } from "../shared/packageImages";
import { COOKIE_NAME } from "../shared/const";

/**
 * الصورة الافتراضية لشحنات البراند (بوسطة — «السماح بفتح الشحنة»).
 *
 * الفرق الجوهري عن اللوجو: بوسطة تجلب الصورة من **رابط عام** بلا أي جلسة، فالعرض هنا
 * **علني** (`/api/public/package-images/<اسم>`) — الاسم غير قابل للتخمين (uuid) ويحمل رقم
 * التينانت كجزء من المسار فقط (لا بيانات أخرى). الرفع للمالك/الأدمن بس، بتوقيع محتوى سليم،
 * PNG/JPEG/WebP ≤ 2MB (قيودنا — توثيق بوسطة لا يذكر امتدادًا ولا حجمًا للرابط الخارجي).
 */
const allowedTypes = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => done(null, allowedTypes.has(file.mimetype)),
});
// القرص المحلي (development/test فقط). `PACKAGE_IMAGE_LOCAL_DIR` للاختبارات المتوازية بس.
const localRoot = () => path.resolve(process.env.PACKAGE_IMAGE_LOCAL_DIR || path.join(process.cwd(), "uploads", "package-images"));

/**
 * التخزين الدائم إلزامي خارج development/test: بوسطة تجلب الصورة لاحقًا من رابط عام، وقرص
 * الحاوية يضيع مع أي redeploy ولا يُرى من replica أخرى. فلو Object Storage غير مضبوط في
 * بيئة منشورة → 503 بلا كتابة أي ملف وبلا مرجع يُحفظ. (الحارس هنا لصور الشحن فقط.)
 */
export const STORAGE_NOT_CONFIGURED_MESSAGE = "التخزين الدائم للصور غير مُعد. راجع إعدادات Object Storage قبل رفع صورة الشحن";
type StorageMode = "object" | "local" | "unavailable";
export function packageImageStorageMode(env: NodeJS.ProcessEnv = process.env): StorageMode {
  if (isObjectStorageConfigured(env)) return "object";
  return isLocalDeployEnv(env) ? "local" : "unavailable";
}

/** هل ملف الصورة موجود فعلًا في التخزين (لمنع حفظ مرجع لملف غير موجود)؟ */
export async function packageImageExists(filename: string): Promise<boolean> {
  if (!PACKAGE_IMAGE_FILENAME_PATTERN.test(filename)) return false;
  const mode = packageImageStorageMode();
  if (mode === "object") return objectExists(filename);
  if (mode === "local") return access(path.join(localRoot(), filename)).then(() => true, () => false);
  return false;
}

async function isAdminSession(req: Request): Promise<boolean> {
  const secret = process.env.JWT_SECRET;
  const token = req.cookies?.[COOKIE_NAME] ?? req.cookies?.employee_token;
  if (!secret || !token) return false;
  try {
    const payload = jwt.verify(token, secret) as any;
    const emp = await getEmployeeById(Number(payload?.employeeId));
    return !!emp && emp.isActive && isAdminTierRole(emp.role);
  } catch {
    return false;
  }
}

export function registerPackageImageRoutes(app: Express) {
  app.post(
    "/api/carrier/package-image/upload",
    async (req, res, next) => {
      if (!(await isAdminSession(req))) return res.status(403).json({ error: "رفع صورة الشحنة للمالك أو الأدمن فقط" });
      next();
    },
    (req, res, next) => upload.single("file")(req, res, (err: unknown) => {
      // الحد 2MB من السيرفر: multer يقطع الطلب قبل أي حفظ (تخزين في الذاكرة) — رد JSON واضح بدل 500.
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "الصورة أكبر من 2MB" });
      if (err) return res.status(400).json({ error: "ملف غير صالح" });
      next();
    }),
    async (req, res) => {
      try {
        const scope = await resolveScope(req);
        if (!scope) return res.status(401).json({ error: "يجب تسجيل الدخول" });
        if (!req.file) return res.status(400).json({ error: "صورة PNG أو JPEG أو WebP مطلوبة (≤ 2MB)" });
        const extension = allowedTypes.get(req.file.mimetype);
        if (!extension || !hasValidSignature(req.file.mimetype, req.file.buffer))
          return res.status(415).json({ error: "محتوى الملف لا يطابق نوعه" });
        const mode = packageImageStorageMode();
        if (mode === "unavailable") return res.status(503).json({ error: STORAGE_NOT_CONFIGURED_MESSAGE });
        const filename = `t${scope.tenantId}-pkg-${randomUUID()}${extension}`;
        if (mode === "object") {
          await putObject(filename, req.file.buffer, req.file.mimetype);
        } else {
          const root = localRoot();
          await mkdir(root, { recursive: true });
          await writeFile(path.join(root, filename), req.file.buffer, { flag: "wx", mode: 0o600 });
        }
        // المرجع نسبي؛ الرابط العام الكامل يُبنى وقت الإرسال من أصل الموقع (publicBaseUrl).
        return res.status(201).json({ url: `${PACKAGE_IMAGE_URL_PREFIX}${filename}`, size: req.file.size, mimeType: req.file.mimetype });
      } catch (error) {
        console.error("[package image upload] فشل الرفع:", error);
        return res.status(500).json({ error: "تعذر رفع الصورة" });
      }
    }
  );

  // عرض علني بلا جلسة — بوسطة تجلب من هنا. اسم ملف غير مطابق للنمط = 404.
  app.get(`${PACKAGE_IMAGE_URL_PREFIX}:filename`, async (req, res) => {
    try {
      const filename = req.params.filename;
      if (!PACKAGE_IMAGE_FILENAME_PATTERN.test(filename)) return res.sendStatus(404);
      const mode = packageImageStorageMode();
      // بيئة منشورة بلا تخزين دائم → 503 بلا أي بحث صامت في قرص الحاوية.
      if (mode === "unavailable") return res.sendStatus(503);
      const file = mode === "object"
        ? await getObject(filename)
        : await readFile(path.join(localRoot(), filename)).catch(() => null);
      if (!file) return res.sendStatus(404);
      const extension = path.extname(filename);
      const mimeType = [...allowedTypes.entries()].find(([, ext]) => ext === extension)?.[0] ?? "application/octet-stream";
      res.type(mimeType)
        .setHeader("Cache-Control", "public, max-age=86400")
        .setHeader("X-Content-Type-Options", "nosniff")
        .send(file);
    } catch {
      res.sendStatus(404);
    }
  });
}
