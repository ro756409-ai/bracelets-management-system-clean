import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import { TRPCError } from "@trpc/server";
import { ClientSafeError, safeErrorText } from "./logSafety";
import { OrderStatusGuardError, OrderLineScopeError, StockShortfallError } from "./db";
import { InventoryScopeError } from "./inventoryV2.service";
import { OutOfScopeError } from "./tenantScope";
import { EasyOrderApiError, fetchEasyOrderById } from "./easyorder.service";
import { appRouter } from "./routers";

/**
 * رسائل الأخطاء للعميل وللّوج ولسجلات الـWebhook: بتعدّي بس لو اتصنّفت صراحةً رسالة أعمال. الاختبارات السلبية هنا
 * كلها **من غير كود ORM ومن غير «Failed query»** — رسائل حساسة عادية لازم تتحجب برضه.
 */
const PII = ["01012345678", "0101 234 5678", "٠١٠١٢٣٤٥٦٧٨", "ahmed@example.com", "أحمد محمد", "شارع النيل", "SECRET-TOKEN-1234", "customerPhone"];
const leaks = (text: string) => PII.filter(p => text.includes(p));

describe("🔒 safeErrorText — تصنيف صريح", () => {
  it("سلبي: رسائل حساسة من غير كود ORM مابتطلعش (SQL، هاتف، إيميل، رابط، stack، runtime، مكتبة، خطأ driver من غير code)", () => {
    class VendorError extends Error {}
    const sensitive: unknown[] = [
      new Error("select `customerPhone` from `orders` where `customerName` = 'أحمد محمد'"),
      new Error("insert into orders values ('01012345678', 'شارع النيل')"),
      new Error("الأوردر للعميل 01012345678 مش موجود"), // عربي بس فيه هاتف
      new Error("رقم العميل 0101 234 5678 غلط"), // هاتف بمسافات
      new Error("رقم العميل ٠١٠١٢٣٤٥٦٧٨ غلط"), // أرقام عربية-هندية
      new Error("مراسلة العميل ahmed@example.com فشلت"),
      new Error("تعذّر الاتصال https://api.example.com/orders?token=SECRET-TOKEN-1234"),
      new Error("فشل\n    at query (/app/server/db.ts:120:5)"),
      new Error("customer أحمد محمد at شارع النيل phone 01012345678"),
      new Error("Request failed: {\"name\":\"أحمد محمد\",\"address\":\"شارع النيل\"}"),
      new Error("Unknown column 'customerPhone' in 'field list'"),
      new TypeError("Cannot read properties of undefined (reading 'customerPhone') — أحمد محمد"),
      (() => { try { JSON.parse("{\"phone\":\"01012345678\", أحمد محمد"); } catch (e) { return e; } })(),
      new RangeError("قيمة أحمد محمد خارج المدى"),
      Object.assign(new Error("العميل أحمد محمد مكرر"), { sql: "insert ...", sqlMessage: "Duplicate entry 'أحمد محمد'" }),
      Object.assign(new Error("العميل أحمد محمد"), { errno: 1062 }),
      new Error("العميل أحمد محمد", { cause: new Error("db") }),
      new VendorError("بيانات العميل أحمد محمد في شارع النيل"), // نوع غير مصنّف = مش رسالة أعمال
      new EasyOrderApiError("EasyOrder API 401: {\"phone\":\"01012345678\",\"name\":\"أحمد محمد\"}", 401),
      "أحمد محمد 01012345678", { message: "أحمد محمد" }, null, undefined,
    ];
    for (const err of sensitive) {
      const text = safeErrorText(err);
      expect(text.startsWith("خطأ داخلي"), `${String((err as any)?.message ?? err)} → ${text}`).toBe(true);
      expect(leaks(text)).toEqual([]);
    }
    expect(safeErrorText(new EasyOrderApiError("EasyOrder API 401: body", 401))).toBe("خطأ داخلي (HTTP_401)");
    expect(safeErrorText(new TypeError("x"))).toBe("خطأ داخلي (TypeError)");
    expect(safeErrorText(Object.assign(new Error("Duplicate entry '01012345678'"), { code: "ER_DUP_ENTRY" }))).toBe("خطأ داخلي (ER_DUP_ENTRY)");
    expect(safeErrorText(Object.assign(new Error("x"), { code: "bad code; drop" }))).toBe("خطأ داخلي");
  });

  it("سلبي: كود التشخيص Allowlist — code/cause.code/errno/status/name بقيم حساسة مابتنعكسش؛ والأكواد المعروفة بتفضل", () => {
    const sensitiveTags: unknown[] = [
      Object.assign(new Error("x"), { code: "01012345678" }),
      Object.assign(new Error("x"), { cause: { code: "01012345678" } }),
      Object.assign(new Error("x"), { errno: 1012345678 }),
      Object.assign(new Error("x"), { cause: { errno: "01012345678" } }),
      Object.assign(new Error("x"), { code: 1012345678 }),
      Object.assign(new Error("x"), { code: "ER_01012345678" }),
      Object.assign(new Error("x"), { code: "E01012345678" }),
      Object.assign(new Error("x"), { code: "ahmed_example_com" }),
      Object.assign(new Error("x"), { code: "SECRET_TOKEN_1234" }),
      Object.assign(new Error("x"), { cause: { code: "AhmedMohamed" } }),
      Object.assign(new Error("x"), { status: 1012345678 }),
      Object.assign(new Error("x"), { status: "01012345678" }),
      Object.assign(new Error("x"), { name: "01012345678" }),
      Object.assign(new Error("x"), { name: "AhmedMohamed" }),
      Object.assign(new Error("x"), { name: "Phone01012345678Error" }),
      { code: "01012345678", errno: 1012345678, name: "01012345678" },
    ];
    for (const err of sensitiveTags) {
      const text = safeErrorText(err);
      expect(text, JSON.stringify(err)).toBe("خطأ داخلي");
      expect(text).not.toMatch(/\d{4,}|Ahmed|SECRET|example/);
    }
    // الأكواد المعروفة بتفضل (حتى مع errno رقمي جنبها — الـerrno نفسه مابيظهرش)
    expect(safeErrorText(Object.assign(new Error("Duplicate entry '01012345678'"), { code: "ER_DUP_ENTRY", errno: 1062 }))).toBe("خطأ داخلي (ER_DUP_ENTRY)");
    expect(safeErrorText(Object.assign(new Error("x"), { cause: { code: "ER_LOCK_DEADLOCK", errno: 1213 } }))).toBe("خطأ داخلي (ER_LOCK_DEADLOCK)");
    expect(safeErrorText(Object.assign(new Error("connect 10.0.0.1"), { code: "ECONNREFUSED", errno: -61 }))).toBe("خطأ داخلي (ECONNREFUSED)");
    expect(safeErrorText(Object.assign(new Error("x"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }))).toBe("خطأ داخلي (UND_ERR_CONNECT_TIMEOUT)");
    expect(safeErrorText(new EasyOrderApiError("EasyOrder API 422: {\"phone\":\"01012345678\"}", 422))).toBe("خطأ داخلي (HTTP_422)");
    // كود مش معروف بيرجع لاسم الصنف لو معروف الشكل، مش للكود نفسه
    expect(safeErrorText(Object.assign(new TypeError("x"), { code: "01012345678" }))).toBe("خطأ داخلي (TypeError)");
  });

  it("إيجابي: رسائل الأعمال المقصودة بتفضل — ClientSafeError وأخطاء الأعمال المسمّاة، ورسائل Error عربي قديمة، وTRPCError مكتوب من غير cause", () => {
    expect(safeErrorText(new OrderStatusGuardError('لا يمكن تغيير حالة الأوردر من "shipped" إلى "confirmed" مباشرة')))
      .toBe('لا يمكن تغيير حالة الأوردر من "shipped" إلى "confirmed" مباشرة');
    expect(safeErrorText(new OrderLineScopeError())).toBe("صنف في الأوردر لا يتبع نشاط هذا الأوردر — لم يُحفظ شيء");
    expect(safeErrorText(new StockShortfallError([{ label: "أسورة سادة", available: 2, needed: 3 }]))).toBe("المتاح من أسورة سادة 2 والمطلوب 3");
    expect(safeErrorText(new InventoryScopeError("الصنف خارج نطاق النشاط"))).toBe("الصنف خارج نطاق النشاط");
    expect(safeErrorText(new OutOfScopeError())).toBe("لا يمكنك الوصول لبيانات هذا الفرع/النشاط");
    expect(safeErrorText(new ClientSafeError("Order Item #12 has no revenue snapshot"))).toBe("Order Item #12 has no revenue snapshot");
    expect(safeErrorText(new Error("توجد دورة رواتب بالفعل لشهر 10/2026"))).toBe("توجد دورة رواتب بالفعل لشهر 10/2026");
    expect(safeErrorText(new Error("الأوردر #10234 مش موجود"))).toBe("الأوردر #10234 مش موجود");
    expect(safeErrorText(new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "قاعدة البيانات غير متاحة" }))).toBe("قاعدة البيانات غير متاحة");
    // حتى المصنّف صراحةً مايعدّيش لو المحتوى نفسه حساس
    expect(safeErrorText(new ClientSafeError("العميل 01012345678"))).toBe("خطأ داخلي");
  });
});

describe("🔒 errorFormatter / onError / سجلات الـWebhook", () => {
  const format = (error: TRPCError, data: Record<string, unknown> = {}) =>
    (appRouter as any)._def._config.errorFormatter({ shape: { message: error.message, code: -32603, data: { code: error.code, ...data } }, error, type: "mutation", path: "x", input: undefined, ctx: undefined });

  it("الخطأ غير المتوقع (من غير كود ORM) بيوصل للعميل «خطأ داخلي» — لا رسالة ولا stack ولا بيانات؛ ورسالة الأعمال بتفضل", () => {
    for (const cause of [new Error("customer أحمد محمد phone 01012345678"), new TypeError("Cannot read 'customerPhone' of undefined"), new Error("select * from orders")]) {
      const out = format(new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: cause.message, cause }), { stack: cause.stack });
      expect(out.message.startsWith("خطأ داخلي")).toBe(true);
      expect(out.data.stack).toBeUndefined();
      expect(leaks(JSON.stringify(out))).toEqual([]);
      expect(JSON.stringify(out)).not.toContain("select");
    }
    const business = new Error("الدورة غير موجودة");
    expect(format(new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: business.message, cause: business })).message).toBe("الدورة غير موجودة");
    expect(format(new TRPCError({ code: "BAD_REQUEST", message: "رسالة واضحة" }), { stack: "s" })).toMatchObject({ message: "رسالة واضحة", data: { stack: "s" } });
  });

  it("onError (stderr) ومسار handover وسجلات Easy Order بتستخدم النص الآمن", () => {
    expect(fs.readFileSync("server/_core/index.ts", "utf-8")).toContain("message: safeErrorText(error.cause ?? error)");
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    expect(routers).not.toContain("message: (e as Error).message");
    expect(fs.readFileSync("server/easyorder.service.ts", "utf-8")).toContain("return { order: null, error: safeErrorText(err) };");
  });

  it("سجل الـWebhook: فشل جلب أوردر Easy Order مابيكتبش جسم رد الـAPI (بيانات العميل) — كود الحالة بس", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 422, json: async () => ({}), text: async () => JSON.stringify({ full_name: "أحمد محمد", phone: "01012345678", address: "شارع النيل" }) }));
    const r = await fetchEasyOrderById("eo-1", { apiToken: "SECRET-TOKEN-1234", fetchImpl: fetchImpl as any });
    expect(r.order).toBeNull();
    expect(r.error).toBe("خطأ داخلي (HTTP_422)");
    expect(leaks(String(r.error))).toEqual([]);
  });
});
