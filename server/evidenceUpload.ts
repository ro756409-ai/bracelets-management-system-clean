import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { Express, Request } from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { COOKIE_NAME } from "../shared/const";

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
        if (!req.file)
          return res.status(400).json({ error: "ملف PDF أو صورة صالح مطلوب" });
        const extension = allowedTypes.get(req.file.mimetype);
        if (!extension)
          return res.status(415).json({ error: "نوع الملف غير مسموح" });
        if (!hasValidSignature(req.file.mimetype, req.file.buffer)) {
          return res.status(415).json({ error: "محتوى الملف لا يطابق نوعه" });
        }
        await mkdir(root, { recursive: true });
        const filename = `${randomUUID()}${extension}`;
        await writeFile(path.join(root, filename), req.file.buffer, {
          flag: "wx",
          mode: 0o600,
        });
        return res
          .status(201)
          .json({
            url: `/api/evidence/files/${filename}`,
            originalName: req.file.originalname,
            size: req.file.size,
            mimeType: req.file.mimetype,
          });
      } catch (error) {
        return res
          .status(
            error instanceof Error && error.message === "UNAUTHORIZED"
              ? 401
              : 500
          )
          .json({ error: "تعذر رفع مستند الإثبات" });
      }
    }
  );

  app.get("/api/evidence/files/:filename", async (req, res) => {
    try {
      requireAuthenticated(req);
      if (!/^[a-f0-9-]+\.(pdf|jpg|png|webp)$/.test(req.params.filename))
        return res.sendStatus(404);
      const file = await readFile(path.join(root, req.params.filename));
      const extension = path.extname(req.params.filename);
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
