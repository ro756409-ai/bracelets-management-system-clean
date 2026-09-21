import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { Express } from "express";
import multer from "multer";
import { getObject, isObjectStorageConfigured, putObject } from "./objectStorage";
import { resolveScope, hasValidSignature } from "./evidenceUpload";
import { getEmployeeById } from "./db";
import { isAdminTierRole } from "./permissions";
import { LOGO_FILENAME_PATTERN, LOGO_URL_PREFIX } from "../shared/branding";
import jwt from "jsonwebtoken";
import { COOKIE_NAME } from "../shared/const";

/**
 * لوجو النشاط — نفس نمط مرفقات الإثبات (`evidenceUpload.ts`): الملف في التخزين الدائم لو
 * متظبّط وإلا القرص المحلي، والمرجع المخزّن مسار مُتحقّق بيحمل رقم التينانت في اسمه.
 *
 *   • الرفع: المالك/الأدمن بس (admin-tier) — صورة PNG/JPEG/WebP ≤ 2MB بتوقيع محتوى سليم.
 *   • العرض: أي جلسة مصرّح لها **في نفس التينانت** (الموظف بيشوف لوجو نشاطه).
 *
 * الربط الفعلي بالنشاط بيحصل بعدها عبر `businesses.setLogo` (tRPC) اللي بيفحص النطاق
 * وإن المرجع يخص نفس التينانت — الرفع لوحده مابيغيّرش أي نشاط.
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
const root = path.resolve(process.cwd(), "uploads", "branding");

/** الرافع لازم يكون admin-tier في جلسته (نفس تعريف السيرفر، مش ادعاء من العميل). */
async function isAdminSession(req: Parameters<typeof resolveScope>[0]): Promise<boolean> {
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

export function registerBrandingRoutes(app: Express) {
  app.post(
    "/api/branding/upload",
    async (req, res, next) => {
      if (!(await isAdminSession(req))) return res.status(403).json({ error: "تعديل هوية النشاط للمالك أو المدير فقط" });
      next();
    },
    upload.single("file"),
    async (req, res) => {
      try {
        const scope = await resolveScope(req);
        if (!scope) return res.status(401).json({ error: "يجب تسجيل الدخول" });
        if (!req.file) return res.status(400).json({ error: "صورة PNG أو JPEG أو WebP مطلوبة (≤ 2MB)" });
        const extension = allowedTypes.get(req.file.mimetype);
        if (!extension || !hasValidSignature(req.file.mimetype, req.file.buffer))
          return res.status(415).json({ error: "محتوى الملف لا يطابق نوعه" });
        const filename = `t${scope.tenantId}-logo-${randomUUID()}${extension}`;
        if (isObjectStorageConfigured()) {
          await putObject(filename, req.file.buffer, req.file.mimetype);
        } else {
          await mkdir(root, { recursive: true });
          await writeFile(path.join(root, filename), req.file.buffer, { flag: "wx", mode: 0o600 });
        }
        return res.status(201).json({ url: `${LOGO_URL_PREFIX}${filename}`, size: req.file.size, mimeType: req.file.mimetype });
      } catch (error) {
        console.error("[branding upload] فشل الرفع:", error);
        return res.status(500).json({ error: "تعذر رفع اللوجو" });
      }
    }
  );

  app.get(`${LOGO_URL_PREFIX}:filename`, async (req, res) => {
    try {
      const scope = await resolveScope(req);
      if (!scope) return res.sendStatus(404);
      const filename = req.params.filename;
      const m = LOGO_FILENAME_PATTERN.exec(filename);
      // عزل التينانت: اسم الملف بيحمل tenant الرافع ولازم يطابق tenant الجلسة. fail-closed.
      if (!m || Number(m[1]) !== scope.tenantId) return res.sendStatus(404);
      const file = isObjectStorageConfigured()
        ? await getObject(filename)
        : await readFile(path.join(root, filename)).catch(() => null);
      if (!file) return res.sendStatus(404);
      const extension = path.extname(filename);
      const mimeType = [...allowedTypes.entries()].find(([, ext]) => ext === extension)?.[0] ?? "application/octet-stream";
      res.type(mimeType).setHeader("Cache-Control", "private, max-age=3600").send(file);
    } catch {
      res.sendStatus(404);
    }
  });
}
