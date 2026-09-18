/**
 * Public tenant signup (Phase 3.3) — `POST /api/signup`. عام بلا مصادقة.
 *
 * بيعمل بس: إدراج **طلب pending** في signup_requests. **مفيش** إنشاء tenant/business/employee
 * هنا (ده وقت موافقة Platform Admin — P3.4)، ومفيش أي businessId/tenantId من العميل.
 *
 * أمان: كلمة السر تُخزَّن hashed فورًا (bcrypt)؛ email/phone/username مطبّعين قبل الفحص؛ منع
 * enumeration (رد عام موحّد سواء البريد/اليوزر مأخوذ أو لأ)؛ rate-limit per IP؛ application/json فقط.
 */
import { Router, type Express, type Request } from "express";
import bcrypt from "bcryptjs";
import { createSignupRequest } from "./db";

const OWNER_MIN = 2, OWNER_MAX = 150;
const BIZ_MIN = 2, BIZ_MAX = 150;
const PHONE_MIN = 6, PHONE_MAX = 30;
const EMAIL_MAX = 320;
const USERNAME_MIN = 3, USERNAME_MAX = 50;
const PASSWORD_MIN_BYTES = 12, PASSWORD_MAX_BYTES = 72;

// rate-limit مستقل per-IP (in-memory، نسخة واحدة؛ per-process). 10 طلبات / ساعة.
const WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const MAX_ENTRIES = 10_000;
const attempts = new Map<string, { count: number; resetAt: number }>();
let sweepTimer: ReturnType<typeof setInterval> | undefined;
function ensureSweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, r] of attempts) if (now > r.resetAt) attempts.delete(k);
  }, WINDOW_MS);
  sweepTimer.unref?.();
}
function ipKey(req: Request): string {
  return `signup::${req.socket?.remoteAddress ?? "unknown"}`;
}
function isLimited(key: string, now = Date.now()): boolean {
  const r = attempts.get(key);
  if (!r) return false;
  if (now > r.resetAt) { attempts.delete(key); return false; }
  return r.count >= MAX_ATTEMPTS;
}
function record(key: string, now = Date.now()): void {
  const r = attempts.get(key);
  if (r && now <= r.resetAt) { r.count += 1; return; }
  if (!attempts.has(key) && attempts.size >= MAX_ENTRIES) {
    let evicted = false;
    for (const [k, rec] of attempts) { if (now > rec.resetAt) { attempts.delete(k); evicted = true; break; } }
    if (!evicted) { const oldest = attempts.keys().next().value; if (oldest !== undefined) attempts.delete(oldest); }
  }
  attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  ensureSweep();
}
export function _clearSignupLimiter(key?: string) { key ? attempts.delete(key) : attempts.clear(); }

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type SignupInput = {
  ownerName: string; businessName: string; phone: string;
  email: string; username: string; password: string;
};
export function parseSignup(body: any):
  | { ok: true; value: SignupInput }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "بيانات غير صالحة" };
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  const ownerName = s(body.ownerName)?.trim() ?? "";
  const businessName = s(body.businessName)?.trim() ?? "";
  const phone = s(body.phone)?.trim() ?? "";
  const emailRaw = s(body.email);
  const usernameRaw = s(body.username);
  const password = s(body.password);
  if (password == null || emailRaw == null || usernameRaw == null)
    return { ok: false, error: "بيانات غير صالحة" };
  const email = emailRaw.trim().toLowerCase();
  const username = usernameRaw.trim().toLowerCase();

  if (ownerName.length < OWNER_MIN || ownerName.length > OWNER_MAX) return { ok: false, error: "اسم صاحب النشاط غير صالح" };
  if (businessName.length < BIZ_MIN || businessName.length > BIZ_MAX) return { ok: false, error: "اسم النشاط غير صالح" };
  if (phone.length < PHONE_MIN || phone.length > PHONE_MAX) return { ok: false, error: "رقم الهاتف غير صالح" };
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return { ok: false, error: "البريد الإلكتروني غير صالح" };
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) return { ok: false, error: "اسم المستخدم غير صالح" };
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes < PASSWORD_MIN_BYTES || bytes > PASSWORD_MAX_BYTES) return { ok: false, error: "كلمة المرور يجب أن تكون بين 12 و72 بايت" };

  return { ok: true, value: { ownerName, businessName, phone, email, username, password } };
}

// رد عام موحّد — نفس الرسالة سواء اتسجّل طلب جديد أو البريد/اليوزر مأخوذ (منع enumeration).
const RECEIVED = { success: true as const, message: "تم استلام طلبك، سيتم مراجعته وتفعيله من الإدارة قريبًا." };

export function registerSignupRoutes(app: Express) {
  const router = Router();

  router.post("/", async (req, res) => {
    if (!req.is("application/json")) return res.status(415).json({ success: false, error: "نوع المحتوى غير مدعوم" });
    const key = ipKey(req);
    if (isLimited(key)) return res.status(429).json({ success: false, error: "محاولات كثيرة، حاول لاحقًا" });
    record(key);

    const parsed = parseSignup(req.body);
    if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.error });
    const v = parsed.value;

    // نحفظ الطلب **دايمًا** للمدخلات الصحيحة، ونرجّع النجاح **فقط بعد insert حقيقي**. مفيش
    // تخطّي صامت: الفحص القديم ضد employees/الطلبات كان بيرجّع نجاحًا وهميًا لو البريد/اليوزر
    // مطابق لموظف legacy (السبب الجذري لفقد الطلبات على Production DB=default). التفرّد يُفرض
    // server-side وقت القبول. الرد عام موحّد فمايكشفش وجود أي حساب (لا enumeration).
    try {
      const passwordHash = await bcrypt.hash(v.password, 12);
      const id = await createSignupRequest({
        ownerName: v.ownerName, businessName: v.businessName, phone: v.phone,
        email: v.email, username: v.username, passwordHash,
      });
      if (!id || Number.isNaN(id)) {
        // insert ما رجّعش id صالح — نعتبره فشلًا (مانعرضش نجاحًا وهميًا).
        console.error("[signup] insert returned no id");
        return res.status(500).json({ success: false, error: "تعذّر إنشاء الطلب، حاول لاحقًا" });
      }
      // logging آمن: id فقط — بلا password/بريد/أي secret.
      console.log(`[signup] pending request created id=${id}`);
      return res.json(RECEIVED);
    } catch (err) {
      console.error("[signup] failed to persist request:", (err as Error).message);
      return res.status(500).json({ success: false, error: "تعذّر إنشاء الطلب، حاول لاحقًا" });
    }
  });

  app.use("/api/signup", router);
}
