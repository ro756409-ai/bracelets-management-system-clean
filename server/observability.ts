/**
 * الحد الأدنى من المراقبة للإنتاج — عشان لو حصل باج عند شركة نعرف: مين، أنهي نشاط،
 * أنهي سجل، امتى، وإيه الخطأ — **من غير ما نسجّل أي سرّ**.
 *
 * ثلاث حاجات: (١) معرّف طلب/ربط لكل request، (٢) تسجيل أخطاء منظّم (JSON) بالمعرّفات
 * الآمنة بس، (٣) endpoint صحّة عام بيتأكد إن التطبيق حيّ والداتابيز واصلة.
 *
 * **ممنوع تسجيل:** باسورد، توكن، سرّ، أو payload المدخلات (ممكن يبقى فيه باسورد تسجيل
 * دخول). بنسجّل معرّفات آمنة بس: requestId, path, code, tenantId, userId/employeeId,
 * entity/order id لو موجود، اسم التكامل. الرسالة نص التطبيق مش بيانات المستخدم.
 */
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "crypto";

export interface RequestWithId extends Request {
  requestId?: string;
}

/** بيعلّق معرّف طلب (من الهيدر لو موجود، وإلا مولّد) ويرجّعه في الرد. */
export function requestIdMiddleware(
  req: RequestWithId,
  res: Response,
  next: NextFunction
): void {
  const incoming = req.headers["x-request-id"];
  const id =
    typeof incoming === "string" && incoming.length > 0 && incoming.length <= 100
      ? incoming
      : randomUUID();
  req.requestId = id;
  res.setHeader("x-request-id", id);
  next();
}

/** حقول تسجيل الخطأ — كلها معرّفات آمنة، مفيش أسرار ولا payload. */
export type ErrorLogFields = {
  requestId?: string;
  path?: string;
  code?: string;
  tenantId?: number | null;
  userId?: number | null;
  employeeId?: number | null;
  businessId?: number | null;
  entityType?: string;
  entityId?: number;
  integration?: string;
  message?: string;
};

/** أسماء مفاتيح ممنوع تظهر في اللوج مهما كان — حارس أخير ضد التسريب. */
const FORBIDDEN_KEYS = /pass(word)?|secret|token|authorization|cookie|apikey|api_key/i;

function redact(fields: ErrorLogFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (FORBIDDEN_KEYS.test(k)) continue; // حزام أمان — مايوصلش هنا أصلًا
    out[k] = v;
  }
  return out;
}

/** تسجيل خطأ منظّم كـJSON على stderr — سطر واحد قابل للبحث والتجميع. */
export function logError(fields: ErrorLogFields): void {
  const record = {
    level: "error",
    ts: new Date().toISOString(),
    ...redact(fields),
  };
  console.error(JSON.stringify(record));
}

/**
 * معالج صحّة عام — بيتأكد إن التطبيق حيّ والداتابيز واصلة، من غير كشف أي إعداد حسّاس.
 * 200 لو تمام، 503 لو الداتابيز مش واصلة. `getDb` بيتحقن عشان الاختبار.
 */
export function makeHealthHandler(getDb: () => Promise<any>) {
  return async (_req: Request, res: Response): Promise<void> => {
    let dbUp = false;
    try {
      const db = await getDb();
      if (db) {
        // استعلام تافه بيتأكد إن الاتصال شغّال فعلًا مش بس إن الكائن موجود.
        const { sql } = await import("drizzle-orm");
        await db.execute(sql`SELECT 1`);
        dbUp = true;
      }
    } catch {
      dbUp = false;
    }
    res.status(dbUp ? 200 : 503).json({
      status: dbUp ? "ok" : "degraded",
      db: dbUp ? "up" : "down",
      uptimeSeconds: Math.round(process.uptime()),
      ts: new Date().toISOString(),
    });
  };
}
