import { createHash } from "crypto";
import path from "path";
import type { Express, Request, Response } from "express";
import jwt from "jsonwebtoken";
import multer from "multer";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { COOKIE_NAME } from "../shared/const";
import { MESSAGING_LIMITS } from "../shared/messagingSpec";
import { AUDIO_CONTAINERS, measureAudioDurationMs, sniffAudioContainer } from "./audioProbe";
import { getEmployeeById } from "./db";
import * as svc from "./messaging.service";
import { resolveMessagingPerms } from "./messagingRouter";
import { newVoiceKey, resolveMessagingStorage } from "./messagingStorage";
import { assertTrpcTenantAccess } from "./_core/trpc";

/**
 * رفع وتشغيل الرسائل الصوتية (خلف MESSAGING_ENABLED).
 *
 *   POST /api/messages/voice?via=web|portal   multipart: file + conversationId + durationMs + operationId [+ replyToMessageId, waveform]
 *   GET  /api/messages/voice/:messageId?via=web|portal   (يدعم Range — مطلوب لتشغيل Safari/iOS)
 *
 * الحماية:
 *   • الهوية من الكوكي فقط (via=portal: كوكي البوابة وحده)، الموظف من الـDB نشطًا وبشركة؛ الصلاحيات من الـDB في
 *     كل طلب (messages.use + messages.voice للرفع). الفحص يسبق قراءة الجسم (لا تخزين مؤقت لطلب غير مصرّح).
 *   • النوع من **المحتوى** (WebM/Ogg/MP4) لا من Content-Type المتصفح؛ ويجب أن يتسق معه ومع امتداد الاسم إن وُجدا.
 *     SVG/HTML/تنفيذي/MP3 وغيرها مرفوض. الحجم ≤ 10MB (multer)، والمدة **مقاسة من الملف** ≤ 5 دقائق.
 *   • المفتاح يولّده السيرفر (لا اسم المستخدم)؛ التخزين الدائم فقط في البيئات المنشورة (غير مضبوط = 503).
 *   • الترتيب: فحص مسبق للـoperationId (Replay بلا رفع) → رفع → تسجيل الرسالة في معاملة. فشل الرفع = لا صف؛
 *     فشل التسجيل أو Replay متزامن = حذف الملف المرفوع (لا ملف يتيم).
 *   • التشغيل عبر هذا المسار المصرّح فقط (لا رابط عام): عضو أو المالك المطّلع (مسجَّل). Cache خاص بلا تخزين،
 *     nosniff، وsandbox.
 *   • الـlogs: اسم الخطأ والمرحلة فقط — بلا مفاتيح تخزين ولا روابط ولا محتوى.
 */
type Via = "web" | "portal";
const EMP_COOKIE = "employee_token";

async function resolveActor(req: Request): Promise<svc.MessagingActor | null> {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  const via: Via = req.query.via === "portal" ? "portal" : "web";
  const tokens = via === "portal" ? [req.cookies?.[EMP_COOKIE]] : [req.cookies?.[COOKIE_NAME], req.cookies?.[EMP_COOKIE]];
  for (const token of tokens) {
    if (!token) continue;
    let employeeId: number;
    try { employeeId = Number((jwt.verify(token, secret) as any)?.employeeId); } catch { continue; }
    if (!employeeId) continue;
    const emp = await getEmployeeById(employeeId);
    if (!emp || !emp.isActive || emp.tenantId == null) return null; // موظف معطّل/بلا شركة = رفض (لا رجوع لكوكي آخر)
    return { tenantId: emp.tenantId, employeeId: emp.id, role: emp.role ?? null, businessId: emp.businessId ?? null };
  }
  return null;
}

const HTTP: Record<string, number> = { BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, PRECONDITION_FAILED: 412, PAYLOAD_TOO_LARGE: 413 };
function sendError(res: Response, e: unknown) {
  if (e instanceof TRPCError) return res.status(HTTP[e.code] ?? 500).json({ error: HTTP[e.code] ? e.message : "تعذّر تنفيذ الطلب" });
  if (e instanceof z.ZodError) return res.status(400).json({ error: e.issues[0]?.message ?? "مدخلات غير صالحة" });
  return res.status(500).json({ error: "تعذّر تنفيذ الطلب" });
}
const logFailure = (stage: string, e: unknown) => console.error(`[messages voice] ${stage} failed: ${(e as any)?.name ?? "Error"}`);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MESSAGING_LIMITS.attachmentMaxBytes, files: 1, fields: 8, fieldSize: 8 * 1024, parts: 10 },
});

const fieldsSchema = z.object({
  conversationId: z.coerce.number().int().positive(),
  durationMs: z.coerce.number().int().min(1).max(MESSAGING_LIMITS.voiceMaxMs, "الحد الأقصى للتسجيل 5 دقائق"),
  operationId: z.string().regex(/^[A-Za-z0-9_:-]{8,100}$/),
  replyToMessageId: z.coerce.number().int().positive().optional(),
  waveform: z.string().max(4000).optional(),
}).strict();

/** امتداد الاسم الأصلي (إن وُجد) يجب أن يكون صوتًا من نفس الحاوية — `.svg`/`.html`/`.exe`… مرفوض. */
function extensionConsistent(originalName: string | undefined, container: keyof typeof AUDIO_CONTAINERS): boolean {
  const ext = path.extname(originalName ?? "").toLowerCase();
  return !ext || AUDIO_CONTAINERS[container].extensions.includes(ext);
}
function browserMimeConsistent(mime: string | undefined, container: keyof typeof AUDIO_CONTAINERS): boolean {
  return !mime || mime === "application/octet-stream" || AUDIO_CONTAINERS[container].browserMimes.test(mime);
}

export function registerMessagingUploadRoutes(app: Express) {
  app.post(
    "/api/messages/voice",
    async (req, res, next) => {
      try {
        const actor = await resolveActor(req);
        if (!actor) return res.status(401).json({ error: "يجب تسجيل الدخول" });
        if (!svc.messagingEnabled()) return res.status(412).json({ error: "مركز الرسائل غير مفعّل" });
        await assertTrpcTenantAccess(actor.tenantId, "mutation", "messages.voiceUpload");
        const perms = await resolveMessagingPerms(actor.tenantId, actor.role);
        if (!perms.use || !perms.voice) return res.status(403).json({ error: "الرسائل الصوتية غير متاحة لك" });
        if (!resolveMessagingStorage()) return res.status(503).json({ error: "التخزين الدائم غير مضبوط — الرفع غير متاح" });
        (req as any).messaging = { actor, perms };
        next();
      } catch (e) { sendError(res, e); }
    },
    (req, res, next) => upload.single("file")(req, res, err => {
      if (!err) return next();
      if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "الملف أكبر من 10 ميجا" });
      return res.status(400).json({ error: "طلب رفع غير صالح" });
    }),
    async (req, res) => {
      const { actor, perms } = (req as any).messaging as { actor: svc.MessagingActor; perms: svc.MessagingPerms };
      const storage = resolveMessagingStorage()!;
      let uploadedKey: string | null = null;
      try {
        const fields = fieldsSchema.parse(req.body ?? {});
        const file = req.file;
        if (!file?.buffer?.length) return res.status(400).json({ error: "ملف الصوت مطلوب" });
        const container = sniffAudioContainer(file.buffer);
        if (!container || !extensionConsistent(file.originalname, container) || !browserMimeConsistent(file.mimetype, container))
          return res.status(415).json({ error: "الملف ليس تسجيلًا صوتيًا مدعومًا" });
        const measured = measureAudioDurationMs(file.buffer, container);
        if (measured == null) return res.status(415).json({ error: "تعذّر التحقق من مدة التسجيل" });
        if (measured > MESSAGING_LIMITS.voiceMaxMs) return res.status(413).json({ error: "الحد الأقصى للتسجيل 5 دقائق" });
        let waveform: number[] | undefined;
        if (fields.waveform) {
          try { waveform = z.array(z.number().min(0).max(1)).max(128).parse(JSON.parse(fields.waveform)); }
          catch { return res.status(400).json({ error: "بيانات الموجة غير صالحة" }); }
        }
        const meta = {
          conversationId: fields.conversationId,
          bytes: file.size,
          durationMs: Math.max(1, measured), // المدة من الملف نفسه، لا من العميل
          contentSha256: createHash("sha256").update(file.buffer).digest("hex"),
          replyToMessageId: fields.replyToMessageId,
          waveform,
          idempotencyKey: fields.operationId,
        };
        const existing = await svc.precheckVoice(actor, perms, meta);
        if (existing != null) return res.status(200).json({ messageId: existing, replay: true });

        const { mime, ext } = AUDIO_CONTAINERS[container];
        const key = newVoiceKey(actor.tenantId, ext as ".webm" | ".ogg" | ".m4a");
        try {
          await storage.put(key, file.buffer, mime);
        } catch (e) {
          logFailure("storage put", e);
          return res.status(502).json({ error: "تعذّر حفظ التسجيل — لم تُرسل الرسالة" });
        }
        uploadedKey = key;
        const r = await svc.sendVoice(actor, perms, { ...meta, storageKey: key, mime: mime as "audio/webm" | "audio/ogg" | "audio/mp4" });
        if (r.replay) { await storage.del(key).catch(e => logFailure("cleanup", e)); uploadedKey = null; }
        else uploadedKey = null; // صار مملوكًا للرسالة
        return res.status(r.replay ? 200 : 201).json(r);
      } catch (e) {
        if (uploadedKey) await storage.del(uploadedKey).catch(err => logFailure("cleanup", err));
        if (!(e instanceof TRPCError) && !(e instanceof z.ZodError)) logFailure("send", e);
        return sendError(res, e);
      }
    }
  );

  app.get("/api/messages/voice/:messageId", async (req, res) => {
    try {
      const actor = await resolveActor(req);
      if (!actor) return res.sendStatus(404);
      if (!svc.messagingEnabled()) return res.sendStatus(404);
      await assertTrpcTenantAccess(actor.tenantId, "query", "messages.voicePlay");
      const perms = await resolveMessagingPerms(actor.tenantId, actor.role);
      if (!perms.use) return res.sendStatus(403);
      const messageId = z.coerce.number().int().positive().parse(req.params.messageId);
      const storage = resolveMessagingStorage();
      if (!storage) return res.sendStatus(503);
      const a = await svc.authorizeVoicePlayback(actor, perms, messageId);
      const file = await storage.get(a.storageKey);
      if (!file) return res.sendStatus(404);
      res.setHeader("Content-Type", a.mime);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
      res.setHeader("Content-Disposition", `inline; filename="voice${AUDIO_CONTAINERS[a.mime === "audio/ogg" ? "ogg" : a.mime === "audio/mp4" ? "mp4" : "webm"].ext}"`);
      res.setHeader("Accept-Ranges", "bytes");
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
      if (range && (range[1] || range[2])) {
        const size = file.length;
        let start = range[1] ? Number(range[1]) : size - Number(range[2]);
        let end = range[1] && range[2] ? Number(range[2]) : size - 1;
        start = Math.max(0, start); end = Math.min(size - 1, end);
        if (start > end || start >= size) { res.setHeader("Content-Range", `bytes */${size}`); return res.sendStatus(416); }
        res.status(206).setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        return res.send(file.subarray(start, end + 1));
      }
      return res.status(200).send(file);
    } catch (e) {
      if (e instanceof TRPCError && (e.code === "NOT_FOUND" || e.code === "FORBIDDEN")) return res.sendStatus(e.code === "FORBIDDEN" ? 403 : 404);
      if (!(e instanceof TRPCError) && !(e instanceof z.ZodError)) logFailure("play", e);
      return res.sendStatus(e instanceof z.ZodError ? 404 : 500);
    }
  });
}
