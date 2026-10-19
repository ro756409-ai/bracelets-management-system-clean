import { sql } from "drizzle-orm";
import {
  BILLING_CURRENCY, computeBillingStatus, newPeriodFor, planAmountMinor, planByCode,
  type BillingPeriod, type BillingStatus, type SubscriptionPlanCode,
} from "@shared/billing";
import { getDb } from "./db";
import { ClientSafeError } from "./logSafety";
import { isUniqueKeyCollision } from "./uniqueNumber";

/**
 * اشتراك متجرك (0055) — المصدر الوحيد لكتابة المدفوعات والفترات. الحالة نفسها مشتقة (shared/billing) من الفترات غير الملغاة.
 *
 *  • خلف `SUBSCRIPTION_BILLING_ENABLED` (معطل افتراضيًا): معطل ⇒ لا قراءة ولا كتابة لجداول 0055 من أي مسار تلقائي، والتسجيل
 *    الجديد بسلوكه القديم. يتفعّل فقط بعد تطبيق 0055 والتحقق منها (موافقة منفصلة لكل بيئة).
 *  • الشركات الحالية **مش** بتدخل النموذج تلقائيًا — التسجيل صريح (`enrollTenant`) من أدمن المنصة أو عند قبول تسجيل جديد.
 *  • كل كتابة لشركة تحت قفل صف حسابها (`SELECT … FOR UPDATE`) ⇒ تفعيلان متزامنان مايحسبوش نفس البداية.
 *  • لا تكرار: مفتاح idempotency فريد لكل دفع، (provider, providerRef) فريد ⇒ نفس مرجع المزوّد/التحويل مايفعّلش مرتين، وفترة
 *    واحدة بالظبط لكل دفع ناجح (paymentId فريد).
 *  • المبلغ يتحدد على السيرفر من الخطة (planAmountMinor) — أي مبلغ من مزوّد لازم يطابقه بالظبط وإلا الدفع مايتفعّلش.
 *  • الاسترداد = voidedAt على الفترة + status=refunded (لا حذف). مسموح بس لآخر فترة سارية (مايعملش فجوة وسط السلسلة).
 *  • لا بيانات بطاقات أبدًا — بس مرجع المزوّد ومرجع التحويل والدليل.
 */
export const subscriptionBillingEnabled = () => process.env.SUBSCRIPTION_BILLING_ENABLED === "true";

export class BillingError extends ClientSafeError {
  constructor(message: string, readonly code: "not_found" | "conflict" | "invalid" | "unavailable" = "invalid") { super(message); this.name = "BillingError"; }
}

export type PaymentProvider = "manual" | "paymob" | "fawry" | "mock";
export type PaymentStatus = "pending" | "succeeded" | "failed" | "refunded";
export type PaymentRow = {
  id: number; tenantId: number; planCode: SubscriptionPlanCode; months: number; amountMinor: number; currency: string;
  provider: PaymentProvider; status: PaymentStatus; idempotencyKey: string; providerRef: string | null;
  paymentReference: string | null; createdAt: Date; succeededAt: Date | null; failedAt: Date | null; refundedAt: Date | null;
};
export type PeriodRow = { id: number; paymentId: number; startsAt: Date; endsAt: Date; voidedAt: Date | null };

export const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9:_-]{8,80}$/;
const rowsOf = (r: any): any[] => (Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : r?.rows ?? []);
const noTable = (e: unknown) => { for (let x: any = e, i = 0; x && i < 8; x = x.cause, i++) if (x.code === "ER_NO_SUCH_TABLE") return true; return false; };
const d = (v: any): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));
type Exec = { execute: (q: any) => Promise<any> };

const toPayment = (r: any): PaymentRow => ({
  id: Number(r.id), tenantId: Number(r.tenantId), planCode: r.planCode, months: Number(r.months), amountMinor: Number(r.amountMinor),
  currency: String(r.currency), provider: r.provider, status: r.status, idempotencyKey: String(r.idempotencyKey),
  providerRef: r.providerRef ?? null, paymentReference: r.paymentReference ?? null, createdAt: d(r.createdAt)!,
  succeededAt: d(r.succeededAt), failedAt: d(r.failedAt), refundedAt: d(r.refundedAt),
});
const toPeriod = (r: any): PeriodRow => ({ id: Number(r.id), paymentId: Number(r.paymentId), startsAt: d(r.startsAt)!, endsAt: d(r.endsAt)!, voidedAt: d(r.voidedAt) });
const PAYMENT_COLS = sql.raw("id, tenantId, planCode, months, amountMinor, currency, provider, status, idempotencyKey, providerRef, paymentReference, createdAt, succeededAt, failedAt, refundedAt");

async function requireDb() {
  const db = await getDb();
  if (!db) throw new BillingError("قاعدة البيانات غير متاحة", "unavailable");
  return db;
}
function wrapNoTable(e: unknown): never {
  if (noTable(e)) throw new BillingError("نظام الاشتراك غير جاهز على الخادم بعد (تحديث قاعدة البيانات 0055) — لم يُحفظ شيء", "unavailable");
  throw e;
}

async function loadPeriods(exec: Exec, tenantId: number): Promise<PeriodRow[]> {
  return rowsOf(await exec.execute(sql`SELECT id, paymentId, startsAt, endsAt, voidedAt FROM subscription_periods WHERE tenantId = ${tenantId} ORDER BY endsAt, id`)).map(toPeriod);
}

/** حالة الاشتراك لشركة: null = الشركة مش على نموذج الاشتراك (السلوك القديم). قراءة فقط. */
export async function loadBillingStatus(tenantId: number, now = new Date(), exec?: Exec): Promise<BillingStatus | null> {
  const db = exec ?? (await requireDb());
  const [acc] = rowsOf(await db.execute(sql`SELECT tenantId FROM tenant_billing_accounts WHERE tenantId = ${tenantId} LIMIT 1`));
  if (!acc) return null;
  return computeBillingStatus(await loadPeriods(db, tenantId), now);
}

export type BillingOverview = {
  enrolled: boolean; status: BillingStatus | null;
  periods: PeriodRow[];
  payments: Array<Pick<PaymentRow, "id" | "planCode" | "months" | "amountMinor" | "currency" | "provider" | "status" | "paymentReference" | "createdAt" | "succeededAt" | "refundedAt">>;
};
export async function getBillingOverview(tenantId: number, now = new Date()): Promise<BillingOverview> {
  const db = await requireDb();
  try {
    const status = await loadBillingStatus(tenantId, now, db);
    if (!status) return { enrolled: false, status: null, periods: [], payments: [] };
    const payments = rowsOf(await db.execute(sql`SELECT ${PAYMENT_COLS} FROM subscription_payments WHERE tenantId = ${tenantId} ORDER BY id DESC LIMIT 50`)).map(toPayment)
      .map(({ id, planCode, months, amountMinor, currency, provider, status, paymentReference, createdAt, succeededAt, refundedAt }) =>
        ({ id, planCode, months, amountMinor, currency, provider, status, paymentReference, createdAt, succeededAt, refundedAt }));
    return { enrolled: true, status, periods: await loadPeriods(db, tenantId), payments };
  } catch (e) { wrapNoTable(e); }
}

/** تسجيل شركة في نموذج الاشتراك — idempotent (التسجيل المكرر لا يغيّر شيئًا). لا يفعّل أي فترة. */
export async function enrollTenant(exec: Exec, input: { tenantId: number; by: "signup" | "platform_admin"; platformAdminId?: number | null }): Promise<{ created: boolean }> {
  if (input.by === "platform_admin" && !(Number(input.platformAdminId) >= 1)) throw new BillingError("أدمن المنصة مطلوب للتسجيل اليدوي");
  const [t] = rowsOf(await exec.execute(sql`SELECT id FROM tenants WHERE id = ${input.tenantId} LIMIT 1`));
  if (!t) throw new BillingError("الشركة غير موجودة", "not_found");
  const r = await exec.execute(sql`INSERT IGNORE INTO tenant_billing_accounts (tenantId, model, enrolledBy, enrolledByPlatformAdminId)
    VALUES (${input.tenantId}, 'subscription_v1', ${input.by}, ${input.by === "platform_admin" ? input.platformAdminId! : null})`);
  const affected = Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
  return { created: affected === 1 };
}

async function lockAccount(tx: Exec, tenantId: number): Promise<void> {
  const [acc] = rowsOf(await tx.execute(sql`SELECT tenantId FROM tenant_billing_accounts WHERE tenantId = ${tenantId} FOR UPDATE`));
  if (!acc) throw new BillingError("الشركة غير مسجّلة في نظام الاشتراك — سجّلها أولًا", "not_found");
}

/** تفعيل دفع pending تحت قفل الحساب (الـcaller ماسك القفل). نفس الدفع ناجح بالفعل ⇒ نفس فترته بلا كتابة. */
async function activateLocked(tx: Exec, payment: PaymentRow, now: Date): Promise<PeriodRow> {
  if (payment.status === "succeeded") {
    const [p] = rowsOf(await tx.execute(sql`SELECT id, paymentId, startsAt, endsAt, voidedAt FROM subscription_periods WHERE paymentId = ${payment.id}`)).map(toPeriod);
    if (p) return p;
  }
  if (payment.status !== "pending") throw new BillingError(`الدفع في حالة ${payment.status} — مينفعش يتفعّل`, "conflict");
  if (payment.amountMinor !== planAmountMinor(payment.planCode) || payment.currency !== BILLING_CURRENCY)
    throw new BillingError("مبلغ الدفع لا يطابق سعر الخطة — لم يُفعَّل", "conflict");
  const periods: BillingPeriod[] = await loadPeriods(tx, payment.tenantId);
  const { startsAt, endsAt } = newPeriodFor(periods, payment.planCode, now);
  const r = await tx.execute(sql`UPDATE subscription_payments SET status = 'succeeded', succeededAt = ${now} WHERE id = ${payment.id} AND status = 'pending'`);
  if (Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0) !== 1) throw new BillingError("حالة الدفع اتغيّرت — راجعه تاني", "conflict");
  const ins = await tx.execute(sql`INSERT INTO subscription_periods (tenantId, paymentId, startsAt, endsAt) VALUES (${payment.tenantId}, ${payment.id}, ${startsAt}, ${endsAt})`);
  const id = Number((Array.isArray(ins) ? ins[0] : ins)?.insertId);
  return { id, paymentId: payment.id, startsAt, endsAt, voidedAt: null };
}

async function paymentByKey(exec: Exec, key: string): Promise<PaymentRow | null> {
  const [r] = rowsOf(await exec.execute(sql`SELECT ${PAYMENT_COLS} FROM subscription_payments WHERE idempotencyKey = ${key} LIMIT 1`));
  return r ? toPayment(r) : null;
}
const normalizeReference = (ref: string) => ref.trim().replace(/\s+/g, " ");

/**
 * دفع يدوي (تحويل/إنستاباي/كاش) يسجّله أدمن منصة **مخوَّل**، بمرجع دفع إلزامي ودليل (رابط أو وصف). يتفعّل فورًا.
 * نفس مفتاح الـidempotency ⇒ نفس النتيجة (إعادة آمنة) أو CONFLICT لو البيانات مختلفة. نفس مرجع التحويل لدفع يدوي تاني ⇒ مرفوض.
 */
export async function recordManualPayment(input: {
  tenantId: number; planCode: string; idempotencyKey: string; paymentReference: string;
  evidenceUrl?: string | null; note?: string | null; platformAdminId: number; now?: Date;
}): Promise<{ payment: PaymentRow; period: PeriodRow; replay: boolean }> {
  const plan = planByCode(input.planCode);
  if (!plan) throw new BillingError("خطة غير معروفة");
  if (!IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) throw new BillingError("مفتاح العملية غير صالح");
  const reference = normalizeReference(input.paymentReference ?? "");
  if (reference.length < 3 || reference.length > 120) throw new BillingError("مرجع الدفع مطلوب (3–120 حرف)");
  const evidenceUrl = input.evidenceUrl?.trim() || null;
  if (evidenceUrl && !/^https:\/\/\S{3,490}$/.test(evidenceUrl)) throw new BillingError("رابط الدليل لازم يكون https");
  const note = input.note?.trim() || null;
  if (!evidenceUrl && (note?.length ?? 0) < 10) throw new BillingError("الدليل مطلوب: رابط https أو وصف 10 حروف على الأقل");
  if (!(input.platformAdminId >= 1)) throw new BillingError("أدمن المنصة مطلوب");
  const now = input.now ?? new Date();
  const db = await requireDb();
  const replayOf = async (p: PaymentRow) => {
    if (p.tenantId !== input.tenantId || p.planCode !== plan.code || p.provider !== "manual" || p.paymentReference !== reference)
      throw new BillingError("مفتاح العملية مستخدم لدفع مختلف", "conflict");
    const [period] = (await loadPeriods(db, p.tenantId)).filter(x => x.paymentId === p.id);
    if (!period) throw new BillingError("الدفع مسجّل بدون فترة — راجع الحالة", "conflict");
    return { payment: p, period, replay: true };
  };
  try {
    const existing = await paymentByKey(db, input.idempotencyKey);
    if (existing) return await replayOf(existing);
    return await db.transaction(async tx => {
      await lockAccount(tx, input.tenantId);
      const ins = await tx.execute(sql`INSERT INTO subscription_payments
        (tenantId, planCode, months, amountMinor, currency, provider, status, idempotencyKey, providerRef, paymentReference, evidenceUrl, note, recordedByPlatformAdminId)
        VALUES (${input.tenantId}, ${plan.code}, ${plan.months}, ${planAmountMinor(plan.code)}, ${BILLING_CURRENCY}, 'manual', 'pending',
                ${input.idempotencyKey}, ${reference.toLowerCase()}, ${reference}, ${evidenceUrl}, ${note}, ${input.platformAdminId})`);
      const id = Number((Array.isArray(ins) ? ins[0] : ins)?.insertId);
      const [row] = rowsOf(await tx.execute(sql`SELECT ${PAYMENT_COLS} FROM subscription_payments WHERE id = ${id}`)).map(toPayment);
      const period = await activateLocked(tx, row, now);
      return { payment: { ...row, status: "succeeded" as const, succeededAt: now }, period, replay: false };
    });
  } catch (e) {
    if (isUniqueKeyCollision(e, "sp_idempotency_unique")) {
      const winner = await paymentByKey(db, input.idempotencyKey);
      if (winner) return replayOf(winner);
    }
    if (isUniqueKeyCollision(e, "sp_provider_ref_unique")) throw new BillingError("مرجع الدفع ده مسجّل قبل كده لدفع تاني — مينفعش يفعّل مرتين", "conflict");
    if (e instanceof BillingError) throw e;
    wrapNoTable(e);
  }
}

/** إنشاء دفع pending لمزوّد أونلاين (Checkout) — المبلغ من الخطة على السيرفر. نفس المفتاح ⇒ نفس الدفع. */
export async function createPendingPayment(input: { tenantId: number; planCode: string; provider: Exclude<PaymentProvider, "manual">; idempotencyKey: string }): Promise<{ payment: PaymentRow; replay: boolean }> {
  const plan = planByCode(input.planCode);
  if (!plan) throw new BillingError("خطة غير معروفة");
  if (!IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)) throw new BillingError("مفتاح العملية غير صالح");
  const db = await requireDb();
  const replayOf = (p: PaymentRow) => {
    if (p.tenantId !== input.tenantId || p.planCode !== plan.code || p.provider !== input.provider) throw new BillingError("مفتاح العملية مستخدم لدفع مختلف", "conflict");
    return { payment: p, replay: true };
  };
  try {
    const existing = await paymentByKey(db, input.idempotencyKey);
    if (existing) return replayOf(existing);
    return await db.transaction(async tx => {
      await lockAccount(tx, input.tenantId);
      const ins = await tx.execute(sql`INSERT INTO subscription_payments (tenantId, planCode, months, amountMinor, currency, provider, status, idempotencyKey)
        VALUES (${input.tenantId}, ${plan.code}, ${plan.months}, ${planAmountMinor(plan.code)}, ${BILLING_CURRENCY}, ${input.provider}, 'pending', ${input.idempotencyKey})`);
      const id = Number((Array.isArray(ins) ? ins[0] : ins)?.insertId);
      const [row] = rowsOf(await tx.execute(sql`SELECT ${PAYMENT_COLS} FROM subscription_payments WHERE id = ${id}`)).map(toPayment);
      return { payment: row, replay: false };
    });
  } catch (e) {
    if (isUniqueKeyCollision(e, "sp_idempotency_unique")) { const w = await paymentByKey(db, input.idempotencyKey); if (w) return replayOf(w); }
    if (e instanceof BillingError) throw e;
    wrapNoTable(e);
  }
}

/** ربط مرجع جلسة المزوّد بدفع pending (مرة واحدة) — الأحداث اللاحقة لازم تطابقه. */
export async function attachProviderRef(paymentId: number, providerRef: string): Promise<void> {
  const db = await requireDb();
  try {
    await db.execute(sql`UPDATE subscription_payments SET providerRef = ${providerRef.slice(0, 120)} WHERE id = ${paymentId} AND status = 'pending' AND providerRef IS NULL`);
  } catch (e) {
    if (isUniqueKeyCollision(e, "sp_provider_ref_unique")) throw new BillingError("مرجع المزوّد مستخدم لدفع تاني", "conflict");
    wrapNoTable(e);
  }
}

/** حدث مزوّد **مُتحقَّق التوقيع مسبقًا** (طبقة المزوّد) — نتيجة دفع لـpaymentId بعينه. idempotent بالكامل. */
export type VerifiedProviderEvent = {
  provider: Exclude<PaymentProvider, "manual">; paymentId: number; providerRef: string;
  outcome: "succeeded" | "failed" | "refunded"; amountMinor: number; currency: string; reason?: string | null;
};

export async function applyProviderEvent(ev: VerifiedProviderEvent, now = new Date()): Promise<{ status: PaymentStatus; changed: boolean }> {
  const ref = (ev.providerRef ?? "").trim();
  if (!ref || ref.length > 120) throw new BillingError("مرجع المزوّد غير صالح");
  const db = await requireDb();
  try {
    return await db.transaction(async tx => {
      const [raw] = rowsOf(await tx.execute(sql`SELECT ${PAYMENT_COLS} FROM subscription_payments WHERE id = ${ev.paymentId} LIMIT 1`));
      if (!raw) throw new BillingError("الدفع غير موجود", "not_found");
      const p0 = toPayment(raw);
      if (p0.provider !== ev.provider) throw new BillingError("المزوّد لا يطابق الدفع", "conflict");
      await lockAccount(tx, p0.tenantId);
      const [locked] = rowsOf(await tx.execute(sql`SELECT ${PAYMENT_COLS} FROM subscription_payments WHERE id = ${ev.paymentId} FOR UPDATE`)).map(toPayment);
      if (locked.providerRef && locked.providerRef !== ref) throw new BillingError("مرجع المزوّد لا يطابق الدفع المسجّل", "conflict");
      // المبلغ والعملة من المزوّد لازم يطابقوا اللي حدده السيرفر — أي اختلاف = لا تفعيل.
      if (ev.amountMinor !== locked.amountMinor || ev.currency !== locked.currency) throw new BillingError("المبلغ/العملة من المزوّد لا تطابق الدفع", "conflict");
      if (ev.outcome === "succeeded") {
        if (locked.status === "succeeded" || locked.status === "refunded") return { status: locked.status, changed: false };
        if (locked.status === "failed") throw new BillingError("دفع فاشل وصله نجاح لاحق — مراجعة يدوية مطلوبة", "conflict");
        if (!locked.providerRef) await tx.execute(sql`UPDATE subscription_payments SET providerRef = ${ref} WHERE id = ${locked.id}`);
        await activateLocked(tx, { ...locked, providerRef: ref }, now);
        return { status: "succeeded" as const, changed: true };
      }
      if (ev.outcome === "failed") {
        if (locked.status !== "pending") return { status: locked.status, changed: false };
        await tx.execute(sql`UPDATE subscription_payments SET status = 'failed', failedAt = ${now}, providerRef = ${ref}, failureReason = ${(ev.reason ?? "").slice(0, 300) || null} WHERE id = ${locked.id} AND status = 'pending'`);
        return { status: "failed" as const, changed: true };
      }
      if (locked.status === "refunded") return { status: "refunded" as const, changed: false };
      if (locked.status !== "succeeded") throw new BillingError("استرداد لدفع غير ناجح — مراجعة يدوية مطلوبة", "conflict");
      await refundLocked(tx, locked, `استرداد من المزوّد ${ev.provider}${ev.reason ? `: ${ev.reason}` : ""}`.slice(0, 300), now, { requireLatest: false });
      return { status: "refunded" as const, changed: true };
    });
  } catch (e) {
    if (isUniqueKeyCollision(e, "sp_provider_ref_unique")) throw new BillingError("مرجع المزوّد مستخدم لدفع تاني", "conflict");
    if (e instanceof BillingError) throw e;
    wrapNoTable(e);
  }
}

async function refundLocked(tx: Exec, payment: PaymentRow, reason: string, now: Date, opts: { requireLatest: boolean }): Promise<PeriodRow> {
  const periods = await loadPeriods(tx, payment.tenantId);
  const period = periods.find(p => p.paymentId === payment.id);
  if (!period) throw new BillingError("الدفع بدون فترة", "conflict");
  const active = periods.filter(p => !p.voidedAt);
  // استرداد فترة وسط السلسلة يعمل فجوة والفترات اللاحقة متحسبة عليها — يدويًا: استرد الأحدث الأول.
  if (opts.requireLatest && active.length && active[active.length - 1].id !== period.id)
    throw new BillingError("الاسترداد اليدوي مسموح لآخر فترة بس — استرد الفترات الأحدث الأول", "conflict");
  const r = await tx.execute(sql`UPDATE subscription_payments SET status = 'refunded', refundedAt = ${now}, refundReason = ${reason} WHERE id = ${payment.id} AND status = 'succeeded'`);
  if (Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0) !== 1) throw new BillingError("حالة الدفع اتغيّرت — راجعه تاني", "conflict");
  await tx.execute(sql`UPDATE subscription_periods SET voidedAt = ${now}, voidReason = ${reason} WHERE id = ${period.id} AND voidedAt IS NULL`);
  return { ...period, voidedAt: now };
}

/** استرداد يدوي من أدمن منصة مخوَّل (بسبب إلزامي). */
export async function refundPayment(input: { paymentId: number; reason: string; now?: Date }): Promise<{ payment: PaymentRow; period: PeriodRow }> {
  const reason = (input.reason ?? "").trim();
  if (reason.length < 5) throw new BillingError("سبب الاسترداد مطلوب (5 حروف على الأقل)");
  const now = input.now ?? new Date();
  const db = await requireDb();
  try {
    return await db.transaction(async tx => {
      const [raw] = rowsOf(await tx.execute(sql`SELECT tenantId FROM subscription_payments WHERE id = ${input.paymentId}`));
      if (!raw) throw new BillingError("الدفع غير موجود", "not_found");
      await lockAccount(tx, Number(raw.tenantId));
      const [p] = rowsOf(await tx.execute(sql`SELECT ${PAYMENT_COLS} FROM subscription_payments WHERE id = ${input.paymentId} FOR UPDATE`)).map(toPayment);
      if (p.status !== "succeeded") throw new BillingError("الاسترداد متاح لدفع ناجح بس", "conflict");
      const period = await refundLocked(tx, p, reason.slice(0, 300), now, { requireLatest: true });
      return { payment: { ...p, status: "refunded" as const, refundedAt: now }, period };
    });
  } catch (e) {
    if (e instanceof BillingError) throw e;
    wrapNoTable(e);
  }
}

/** أدمن منصة مخوَّل للفوترة (منفصل عن صلاحية قبول التسجيلات): قائمة صريحة بالمعرّفات، فارغة ⇒ لا أحد (fail-closed). */
export function isBillingPlatformAdmin(adminId: number): boolean {
  const ids = (process.env.PLATFORM_BILLING_ADMIN_IDS ?? "").split(",").map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  return ids.includes(adminId);
}
