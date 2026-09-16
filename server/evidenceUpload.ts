import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { Express, Request } from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { COOKIE_NAME } from "../shared/const";
import {
  getObject,
  isObjectStorageConfigured,
  putObject,
} from "./objectStorage";
import {
  getEmployeeById,
  getBusinessIdsForTenant,
  findEvidenceOwnerBusinessIds,
} from "./db";
import { isAdminTierRole } from "./permissions";

const allowedTypes = new Map([
  ["application/pdf", ".pdf"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
]);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => done(null, allowedTypes.has(file.mimetype)),
});
const root = path.resolve(process.cwd(), "uploads", "evidence");

function requireAuthenticated(req: Request) {
  const secret = process.env.JWT_SECRET;
  const token = req.cookies?.[COOKIE_NAME] ?? req.cookies?.employee_token;
  if (!secret || !token) throw new Error("UNAUTHORIZED");
  jwt.verify(token, secret);
}

/**
 * نطاق المستخدم من الجلسة server-side — tenantId والأنشطة المسموحة. **fail-closed**: أي فشل
 * (بلا توكن/غير صالح، موظف موقوف، بلا tenant، DB مش متاحة) → null والمتصل يرفض.
 * أدمن/مدير → كل أنشطة التينانت؛ موظف عادي → نشاطه فقط لو تابع للتينانت.
 */
async function resolveScope(
  req: Request
): Promise<{ tenantId: number; allowed: number[] } | null> {
  const secret = process.env.JWT_SECRET;
  const token = req.cookies?.[COOKIE_NAME] ?? req.cookies?.employee_token;
  if (!secret || !token) return null;
  let payload: any;
  try {
    payload = jwt.verify(token, secret);
  } catch {
    return null;
  }
  const employeeId = Number(payload?.employeeId);
  if (!employeeId) return null;
  const emp = await getEmployeeById(employeeId);
  if (!emp || !emp.isActive || emp.tenantId == null) return null;
  const all = await getBusinessIdsForTenant(emp.tenantId);
  if (all == null) return null; // DB مش متاحة → fail-closed
  const allowed = isAdminTierRole(emp.role)
    ? all
    : emp.businessId != null && all.includes(emp.businessId)
      ? [emp.businessId]
      : [];
  return { tenantId: emp.tenantId, allowed };
}

function hasValidSignature(mimeType: string, buffer: Buffer): boolean {
  if (mimeType === "application/pdf")
    return buffer.subarray(0, 5).toString("ascii") === "%PDF-";
  if (mimeType === "image/jpeg")
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/png")
    return buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") {
    return (
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  return false;
}

export function registerEvidenceUploadRoutes(app: Express) {
  app.post(
    "/api/evidence/upload",
    (req, res, next) => {
      try {
        requireAuthenticated(req);
        next();
      } catch {
        res.status(401).json({ error: "يجب تسجيل الدخول قبل رفع المستند" });
      }
    },
    upload.single("file"),
    async (req, res) => {
      try {
        // العزل: نحدّد tenant المستخدم ونضمّنه في اسم الملف عشان التنزيل يتحقق منه فورًا
        // (حتى قبل ربط الملف بأي سجل). fail-closed: بلا نطاق → رفض.
        const scope = await resolveScope(req);
        if (!scope)
          return res.status(401).json({ error: "يجب تسجيل الدخول قبل رفع المستند" });
        if (!req.file)
          return res.status(400).json({ error: "ملف PDF أو صورة صالح مطلوب" });
        const extension = allowedTypes.get(req.file.mimetype);
        if (!extension)
          return res.status(415).json({ error: "نوع الملف غير مسموح" });
        if (!hasValidSignature(req.file.mimetype, req.file.buffer)) {
          return res.status(415).json({ error: "محتوى الملف لا يطابق نوعه" });
        }
        const filename = `t${scope.tenantId}-${randomUUID()}${extension}`;
        // تخزين دائم لو متظبّط (S3/R2/MinIO)، وإلا قرص محلي (تطوير بس). المرجع اللي
        // بيتخزّن هو نفسه في الحالتين — مسار مُتحقّق، مش رابط bucket عام.
        if (isObjectStorageConfigured()) {
          await putObject(filename, req.file.buffer, req.file.mimetype);
        } else {
          await mkdir(root, { recursive: true });
          await writeFile(path.join(root, filename), req.file.buffer, {
            flag: "wx",
            mode: 0o600,
          });
        }
        return res
          .status(201)
          .json({
            url: `/api/evidence/files/${filename}`,
            originalName: req.file.originalname,
            size: req.file.size,
            mimeType: req.file.mimetype,
          });
      } catch (error) {
        const unauthorized =
          error instanceof Error && error.message === "UNAUTHORIZED";
        // نسجّل السبب الحقيقي في اللوج (مش للواجهة) عشان أي فشل تخزين يبقى قابل للتشخيص.
        if (!unauthorized)
          console.error("[evidence upload] فشل الرفع:", error);
        return res
          .status(unauthorized ? 401 : 500)
          .json({ error: "تعذر رفع مستند الإثبات" });
      }
    }
  );

  app.get("/api/evidence/files/:filename", async (req, res) => {
    try {
      const scope = await resolveScope(req);
      if (!scope) return res.sendStatus(404);
      const filename = req.params.filename;
      // اسم صالح: بادئة tenant اختيارية (t<رقم>-) + UUID + امتداد مسموح.
      if (!/^(t\d+-)?[a-f0-9-]+\.(pdf|jpg|png|webp)$/.test(filename))
        return res.sendStatus(404);
      // عزل التينانت:
      //   • ملف جديد باسم يحمل الـtenant → لازم يطابق tenant المستخدم.
      //   • ملف قديم بلا بادئة → reverse-lookup: لازم يكون مملوكًا لأحد أنشطة المستخدم.
      // fail-closed: أي عدم تطابق / مالك غير معروف → 404.
      const prefixMatch = /^t(\d+)-/.exec(filename);
      if (prefixMatch) {
        if (Number(prefixMatch[1]) !== scope.tenantId) return res.sendStatus(404);
      } else {
        const owners = await findEvidenceOwnerBusinessIds(filename);
        if (!owners.some(b => scope.allowed.includes(b))) return res.sendStatus(404);
      }
      // من التخزين الدائم لو متظبّط، وإلا القرص المحلي. null = ملف مش موجود → 404.
      const file = isObjectStorageConfigured()
        ? await getObject(filename)
        : await readFile(path.join(root, filename));
      if (!file) return res.sendStatus(404);
      const extension = path.extname(filename);
      const mimeType =
        [...allowedTypes.entries()].find(([, ext]) => ext === extension)?.[0] ??
        "application/octet-stream";
      res
        .type(mimeType)
        .setHeader("Cache-Control", "private, max-age=300")
        .send(file);
    } catch {
      res.sendStatus(404);
    }
  });
}
