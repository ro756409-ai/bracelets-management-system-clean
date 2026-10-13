import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { isUniqueKeyCollision } from "./uniqueNumber";

/**
 * منع تكرار عمليات الإنشاء على السيرفر (0052) — إنشاء أوردر فيسبوك وإرسال دفعة للورشة.
 *
 *  • المفتاح = (الشركة، النشاط، نوع العملية، operationId من الواجهة) بقيد فريد `oik_scope_unique`. الواجهة تثبّت operationId
 *    طوال العملية (إعادة المحاولة بعد انقطاع الشبكة = نفس المعرّف) وتغيّره عند بدء عملية جديدة.
 *  • نفس المفتاح + نفس البيانات (sha256 لصيغة قانونية) ⇒ نفس النتيجة بلا أي كتابة؛ بيانات مختلفة ⇒ CONFLICT.
 *  • صف المفتاح يُكتب **داخل معاملة العملية نفسها** (`record`) — نجاح كامل أو لا شيء. طلبان متزامنان بنفس المفتاح: الثاني
 *    ينتظر عند القيد الفريد ثم يفشل بـER_DUP_ENTRY ⇒ معاملته كلها ترجع، ويُعاد له ما حفظه الأول.
 *  • الإعادة لا تتجاوز الصلاحيات: البحث بنطاق نشاط الجلسة (لا يُرى مفتاح نشاط/شركة أخرى)، والصف لنفس الفاعل وإلا CONFLICT بلا
 *    تفاصيل، والنتيجة نفسها تُقرأ بنطاق النشاط (`replay`).
 *  • بلا operationId (عملاء قدامى) ⇒ السلوك القديم كما هو، **غير محمي** (idempotency: "none")، ولا يولّد السيرفر مفتاحًا.
 *    قبل تطبيق 0052 ⇒ "unavailable": العملية تتم بلا حماية (لا تتعطل الإدخالات) — 0052 تُطبَّق مباشرة بعد النشر.
 */
export type IdemOperation = "order.create" | "workshop.send";
export type IdemStatus = "protected" | "none" | "unavailable";
export type IdemScope = { tenantId: number; businessId: number; operation: IdemOperation; operationId: string };
export type IdemActor = { type: "employee" | "user"; id: number };
export type IdemRow = { id: number; requestHash: string; resultId: number; resultReference: string; actorType: string; actorId: number };
export type IdemRecord = (tx: any, result: { id: number; reference: string }) => Promise<void>;

export const OPERATION_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

const rowsOf = (r: any): any[] => (Array.isArray(r) ? (Array.isArray(r[0]) ? r[0] : r) : r?.rows ?? []);
const noTable = (e: unknown) => { for (let x: any = e, i = 0; x && i < 8; x = x.cause, i++) if (x.code === "ER_NO_SUCH_TABLE") return true; return false; };

/** JSON قانوني: مفاتيح مرتبة، undefined يُحذف، Date = ISO. */
export function canonicalRequest(v: unknown): string {
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalRequest).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalRequest(o[k])}`).join(",")}}`;
}
export const requestHashOf = (payload: unknown) => createHash("sha256").update(canonicalRequest(payload)).digest("hex");
export const isOperationKeyCollision = (err: unknown) => isUniqueKeyCollision(err, "oik_scope_unique");

export async function findOperation(exec: { execute: (q: any) => Promise<any> }, s: IdemScope): Promise<IdemRow | null | "unavailable"> {
  try {
    const [r] = rowsOf(await exec.execute(sql`SELECT id, requestHash, resultId, resultReference, actorType, actorId FROM operation_idempotency_keys
      WHERE tenantId = ${s.tenantId} AND businessId = ${s.businessId} AND operation = ${s.operation} AND operationId = ${s.operationId} LIMIT 1`));
    return r ? { id: Number(r.id), requestHash: String(r.requestHash), resultId: Number(r.resultId), resultReference: String(r.resultReference), actorType: String(r.actorType), actorId: Number(r.actorId) } : null;
  } catch (e) {
    if (noTable(e)) return "unavailable";
    throw e;
  }
}

function assertReplayable(row: IdemRow, hash: string, actor: IdemActor): void {
  // فاعل آخر: لا تفاصيل (لا رقم أوردر ولا إذن) — المفتاح لا يكشف عملية خارج صلاحيات المستخدم
  if (row.actorType !== actor.type || row.actorId !== actor.id)
    throw new TRPCError({ code: "CONFLICT", message: "معرّف العملية مستخدم بالفعل — ابدأ عملية جديدة" });
  if (row.requestHash !== hash)
    throw new TRPCError({ code: "CONFLICT", message: `هذه العملية حُفظت سابقًا ببيانات مختلفة (${row.resultReference}) — راجعها أولًا؛ الحفظ مرة أخرى يبدأ عملية جديدة` });
}

export async function runIdempotent<T extends object>(opts: {
  db: { execute: (q: any) => Promise<any> };
  /** null = طلب بلا operationId (غير محمي). */
  scope: IdemScope | null;
  payload: unknown;
  actor: IdemActor;
  /** نتيجة محفوظة ⇒ الرد نفسه، مقروءًا بنطاق نشاط الجلسة (يرمي إن لم تعد موجودة فيه). */
  replay: (row: IdemRow) => Promise<T>;
  /** تنفيذ العملية؛ `record` (أو null) يُستدعى داخل معاملتها بعد كتابة النتيجة. */
  execute: (record: IdemRecord | null) => Promise<T>;
}): Promise<T & { replay: boolean; idempotency: IdemStatus }> {
  const s = opts.scope;
  if (!s) return { ...(await opts.execute(null)), replay: false, idempotency: "none" };
  if (!OPERATION_ID_RE.test(s.operationId)) throw new TRPCError({ code: "BAD_REQUEST", message: "معرّف العملية غير صالح" });
  const hash = requestHashOf(opts.payload);
  const found = await findOperation(opts.db, s);
  if (found === "unavailable") {
    console.warn(`[idempotency] جدول operation_idempotency_keys غير موجود — ${s.operation} بلا حماية (طبّق 0052)`);
    return { ...(await opts.execute(null)), replay: false, idempotency: "unavailable" };
  }
  const replayOf = async (row: IdemRow) => { assertReplayable(row, hash, opts.actor); return { ...(await opts.replay(row)), replay: true, idempotency: "protected" as const }; };
  if (found) return replayOf(found);
  const record: IdemRecord = async (tx, result) => {
    await tx.execute(sql`INSERT INTO operation_idempotency_keys (tenantId, businessId, operation, operationId, requestHash, resultId, resultReference, actorType, actorId)
      VALUES (${s.tenantId}, ${s.businessId}, ${s.operation}, ${s.operationId}, ${hash}, ${result.id}, ${result.reference}, ${opts.actor.type}, ${opts.actor.id})`);
  };
  try {
    return { ...(await opts.execute(record)), replay: false, idempotency: "protected" };
  } catch (err) {
    if (!isOperationKeyCollision(err)) throw err;
    // طلب متزامن بنفس المفتاح سبقنا والتزم — معاملتنا رجعت بالكامل؛ نعيد نتيجته (بنفس فحوص الإعادة)
    const winner = await findOperation(opts.db, s);
    if (!winner || winner === "unavailable") throw err;
    return replayOf(winner);
  }
}
