import { TRPCError } from "@trpc/server";

/**
 * أرقام يولّدها السيرفر بصيغة `<بادئة>-<Date.now()>-<3 أرقام عشوائية>` (طولها 20 حرفًا بالضبط لـFB — حد العمود):
 * طلبان في نفس المللي ثانية بنفس الرقم العشوائي = تصادم على القيد الفريد. الإصلاح يحافظ على الصيغة والطول ويعيد التوليد:
 *   • عند **تصادم القيد الفريد الخاص بالرقم فقط** (`isCollision`)؛ أي خطأ آخر يخرج كما هو من أول محاولة.
 *   • كل محاولة = `run(n)` كاملة بمعاملة جديدة (المحاولة السابقة رجعت rollback بالكامل) — لا بنود ولا حركات مكررة.
 *   • 3 محاولات إجمالًا؛ بعدها CONFLICT صريح بلا أي بيانات جزئية، والخطأ الأصلي في cause.
 * منع تكرار **نفس الطلب** (إعادة الإرسال) مسألة مستقلة عن توليد الرقم — لا تُحل هنا.
 */
export const MAX_NUMBER_ATTEMPTS = 3;

const rand3 = () => Math.floor(Math.random() * 1000).toString().padStart(3, "0");
/** مصدر الأرقام — كائن (لا دوال مصدّرة منفصلة) حتى تستطيع الاختبارات فرض تصادم عمدًا. */
export const numberSource = {
  fbOrder: () => `FB-${Date.now()}-${rand3()}`,
  workshopReference: () => `WS-${Date.now()}-${rand3()}`,
};

/** الرقم المولّد مستخدم بالفعل (اكتُشف بقراءة داخل المعاملة قبل أي كتابة نهائية) — يُرمى لإلغاء المعاملة وإعادة التوليد. */
export class NumberTakenError extends Error {
  constructor(readonly number: string) { super(`الرقم ${number} مستخدم بالفعل`); this.name = "NumberTakenError"; }
}

export class UniqueNumberExhaustedError extends TRPCError {
  constructor(readonly attempts: number, readonly lastNumber: string, cause: unknown) {
    super({ code: "CONFLICT", message: `تعذّر توليد رقم فريد بعد ${attempts} محاولات — لم يُحفظ شيء، أعد المحاولة`, cause: cause instanceof Error ? cause : undefined });
    this.name = "UniqueNumberExhaustedError";
  }
}

/** ER_DUP_ENTRY (1062) على قيد فريد بعينه — في أي مستوى من سلسلة cause (Drizzle/tRPC تغلّف الخطأ الأصلي). */
export function isUniqueKeyCollision(err: unknown, keyName: string): boolean {
  for (let e: any = err, depth = 0; e && depth < 8; e = e.cause, depth++) {
    if ((e.code === "ER_DUP_ENTRY" || e.errno === 1062) && String(e.sqlMessage ?? e.message ?? "").includes(keyName)) return true;
  }
  return false;
}

export async function withFreshNumber<T>(
  next: () => string,
  run: (number: string) => Promise<T>,
  isCollision: (err: unknown) => boolean,
): Promise<{ number: string; value: T; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    const number = next();
    try {
      return { number, value: await run(number), attempts: attempt };
    } catch (err) {
      if (!isCollision(err)) throw err;
      if (attempt >= MAX_NUMBER_ATTEMPTS) throw new UniqueNumberExhaustedError(attempt, number, err);
    }
  }
}
