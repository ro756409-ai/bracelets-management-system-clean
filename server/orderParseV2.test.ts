import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import {
  analyzePasteV2, extractSegmentPrice, signParseToken, verifyParseToken,
  canonicalFingerprint, canonicalParse, compareLinesToCanonical, classifyResolution, PARSE_TOKEN_TTL_MS,
} from "./orderParse.service";
import { createSegmentResolver, parseAiOutput, sanitizeSegments, readResolverConfig, rateLimitedResolver } from "./ai/segmentResolver";
import { aiRateKey, AI_RATE_LIMIT_MAX, AI_RATE_LIMIT_WINDOW_MS, __resetAiRateLimitForTests } from "./ai/aiRateLimit";
import type { MatchCatalog } from "./productMatching";
import { AI_MAX_SEGMENT_CHARS, AI_MAX_SEGMENTS } from "../shared/orderParse";

/**
 * Hybrid Order Parser — كتالوج نشاط واحد في الذاكرة (أسماء عشوائية غير مرتبطة بنشاط حقيقي).
 * الأرقام والعقد نفس اللي الـendpoint بيرجّعه (`analyzePasteV2`).
 */
process.env.JWT_SECRET ??= "test-only-secret-change-me";

const REAL = `بيدج: عتبة التاريخ: 20/9
الاسم: محمد جمال محمد
العنوان: القليوبية طوخ مسجد الزعايرة جانب إدارة المرور
رقم الفون(1): 01095286405
رقم الفون(2): 01094366135
نوع المنتج: ٢ سادة، 1 نقش وعين حورس
عدد القطع: 4
السعر: 700 الشحن: 50 الإجمالي: 750`;

const CATALOG: MatchCatalog = {
  products: [{ id: 10, name: "أسورة نحاس", sku: "BR", price: "160", isActive: true } as any],
  variants: [
    { id: 101, productId: 10, name: "سادة", sku: "BR-S", price: "160", isActive: true },
    { id: 102, productId: 10, name: "منقوش", sku: "BR-N", price: "160", isActive: true },
    { id: 103, productId: 10, name: "عين حورس", sku: "BR-H", price: "160", isActive: true },
    { id: 104, productId: 10, name: "ذكر التحصين", sku: "BR-T", price: "160", isActive: true },
  ] as any,
};

const byName = (r: Awaited<ReturnType<typeof analyzePasteV2>>, name: string) =>
  r.lines.find(l => l.match?.variantName === name);

describe("🔑 النص الحقيقي → ParseResultV2", () => {
  it("🔑 2 سادة، 1 منقوش (alias نقش)، 1 عين حورس — كلها confident، وبلا أي سطر وهمي", async () => {
    const r = await analyzePasteV2(REAL, CATALOG);
    expect(r.parseSource).toBe("deterministic");
    expect(r.lines.map(l => [l.match?.variantName, l.quantity])).toEqual([["سادة", 2], ["منقوش", 1], ["عين حورس", 1]]);
    expect(r.lines.every(l => l.confidence === "confident")).toBe(true);
    expect(r.lines.some(l => /^[٢2]\s/.test(l.segmentText))).toBe(false); // مفيش «٢ سادة» أو «1 نقش»
    expect(r.unresolvedSegments).toEqual([]);
  });
  it("🔑 itemsTotal=700، shipping=50، finalTotal=750، pieces=4 — كلها من labels", async () => {
    const r = await analyzePasteV2(REAL, CATALOG);
    expect(r.fields.itemsTotal).toMatchObject({ value: 700, confidence: "confident" });
    expect(r.fields.shipping).toMatchObject({ value: 50, confidence: "confident" });
    expect(r.fields.finalTotal).toMatchObject({ value: 750, confidence: "confident" });
    expect(r.fields.pieces).toMatchObject({ value: 4, confidence: "confident" });
    expect(r.fields.discount).toMatchObject({ value: 0 });
  });
  it("🔑 السعر المذكور قبل «الشحن» = إجمالي الأصناف مش سعر وحدة: 175 × 4 = 700 (allocated) — مش 160 من الكتالوج", async () => {
    const r = await analyzePasteV2(REAL, CATALOG);
    expect(r.lines.map(l => l.unitPrice)).toEqual([175, 175, 175]);
    expect(r.lines.map(l => l.lineTotal)).toEqual([350, 175, 175]);
    expect(r.lines.every(l => l.priceSource === "allocated")).toBe(true);
    expect(r.lines.some(l => l.unitPrice === 160)).toBe(false);
  });
  it("🔑 الحقول الشخصية حتمية بثقة: الاسم، الهاتفان، المحافظة القليوبية، المركز طوخ، العنوان، بيدج عتبة", async () => {
    const f = (await analyzePasteV2(REAL, CATALOG)).fields;
    expect(f.customerName).toMatchObject({ value: "محمد جمال محمد", confidence: "confident" });
    expect(f.customerPhone.value).toBe("01095286405");
    expect(f.customerPhone2.value).toBe("01094366135");
    expect(f.governorate).toMatchObject({ value: "القليوبية", confidence: "confident" });
    expect(f.city.value).toBe("طوخ");
    expect(String(f.customerAddress.value)).toContain("مسجد الزعايرة");
    expect(f.adName.value).toBe("عتبة");
  });
});

describe("🔑 حالات إضافية", () => {
  it("🔑 «٢ سادة و١ عين حورس» بالأرقام العربية → 2 + 1", async () => {
    const r = await analyzePasteV2("نوع المنتج: ٢ سادة و١ عين حورس\nعدد القطع: ٣\nالسعر: ٦٠٠", CATALOG);
    expect(r.lines.map(l => [l.match?.variantName, l.quantity])).toEqual([["سادة", 2], ["عين حورس", 1]]);
    expect(r.lines.map(l => l.unitPrice)).toEqual([200, 200]);
  });
  it("🔑 نقش/منقوش/منقوشة → نفس التركيبة", async () => {
    for (const w of ["نقش", "منقوش", "منقوشة"]) {
      const r = await analyzePasteV2(`نوع المنتج: ${w}\nعدد القطع: 1`, CATALOG);
      expect(r.lines[0].match?.variantId).toBe(102);
    }
  });
  it("🔒 نوع غير موجود في الكتالوج → unresolved بالنص الأصلي واقتراحات، بلا تخمين", async () => {
    const r = await analyzePasteV2("نوع المنتج: ٢ سادة، 1 نجمة داوود\nعدد القطع: 3\nالسعر: 600", CATALOG);
    const u = r.lines[1];
    expect(u.match).toBeNull(); expect(u.confidence).toBe("unresolved"); expect(u.segmentText).toBe("نجمة داوود");
    expect(r.unresolvedSegments).toEqual([{ text: "نجمة داوود", quantity: 1, suggestions: expect.any(Array) }]);
  });
  it("🔑 إجمالي غير قابل للقسمة: 700 على 3 قطع [2,1] → 233.33/233.34 والمجموع 700 بالظبط", async () => {
    const r = await analyzePasteV2("نوع المنتج: ٢ سادة، 1 منقوش\nعدد القطع: 3\nالسعر: 700", CATALOG);
    expect(r.lines.map(l => l.unitPrice)).toEqual([233.33, 233.34]);
    const sum = r.lines.reduce((s, l) => s + Math.round(l.unitPrice! * 100) * l.quantity, 0);
    expect(sum).toBe(70000);
  });
  it("🔑 سعر لكل نوع في الرسالة → message، والباقي موزّع", async () => {
    expect(extractSegmentPrice("سادة 150ج")).toEqual({ text: "سادة", unitPrice: 150 });
    expect(extractSegmentPrice("منقوش بـ 200 جنيه")).toEqual({ text: "منقوش", unitPrice: 200 });
    expect(extractSegmentPrice("عين حورس")).toEqual({ text: "عين حورس", unitPrice: null });
    const r = await analyzePasteV2("نوع المنتج: ٢ سادة 150ج، 1 منقوش\nعدد القطع: 3\nالسعر: 500", CATALOG);
    expect(r.lines[0]).toMatchObject({ unitPrice: 150, priceSource: "message", quantity: 2 });
    expect(r.lines[1]).toMatchObject({ unitPrice: 200, priceSource: "allocated" });
  });
  it("🔒 بلا «السعر» ولا «الإجمالي» → أسعار null (مفيش اختراع)", async () => {
    const r = await analyzePasteV2("نوع المنتج: سادة\nعدد القطع: 1", CATALOG);
    expect(r.lines[0].unitPrice).toBeNull(); expect(r.fields.itemsTotal.confidence).toBe("unresolved");
  });
});

describe("🔒 AI fallback — للأجزاء الغامضة فقط، والسيرفر هو اللي بيطابق", () => {
  const TEXT = `الاسم: سرّي جدًا\nرقم الفون(1): 01000000000\nالعنوان: القاهرة شارع سري 5\nنوع المنتج: ٢ سادة، 1 عين حرس\nعدد القطع: 3\nالسعر: 600`;
  it("🔑 AI يقترح نصًا موجودًا في الكتالوج → السطر يتحل ambiguous + aiAssisted، parseSource=mixed، والحقول الشخصية ماوصلتش للـAI", async () => {
    const seen: any[] = [];
    const resolver = vi.fn(async (segments: string[], terms: string[]) => {
      seen.push({ segments, terms });
      return [{ segmentText: "عين حرس", intendedText: "عين حورس", quantity: null, unitPrice: null, confidence: 0.8 }];
    });
    const r = await analyzePasteV2(TEXT, CATALOG, { resolver, aiProvider: "mock" });
    expect(seen).toEqual([{ segments: ["عين حرس"], terms: expect.arrayContaining(["سادة", "عين حورس"]) }]);
    const payload = JSON.stringify(seen);
    for (const pii of ["سرّي", "01000000000", "شارع سري", "القاهرة"]) expect(payload).not.toContain(pii);
    expect(r.parseSource).toBe("mixed"); expect(r.aiProvider).toBe("mock");
    expect(r.lines[1]).toMatchObject({ match: { variantId: 103 }, confidence: "ambiguous", aiAssisted: true });
    expect(r.lines.map(l => l.unitPrice)).toEqual([200, 200]);
  });
  it("🔒 AI يرجع variant/نصًا مزيفًا (مش في الكتالوج) → مرفوض، السطر يفضل unresolved، ولا معرّف من الـAI يُستخدم", async () => {
    const resolver = vi.fn(async () => [
      { segmentText: "عين حرس", intendedText: "تركيبة لا وجود لها", quantity: 1, unitPrice: 999, confidence: 0.99 },
    ]);
    const r = await analyzePasteV2(TEXT, CATALOG, { resolver });
    expect(r.lines[1].match).toBeNull(); expect(r.lines[1].confidence).toBe("unresolved");
    expect(r.lines[1].unitPrice).toBe(200); // مش 999 — سعر الـAI مايتاخدش لسطر مش محلول
    expect(r.parseSource).toBe("deterministic");
    // مخرج فيه variantId → الـschema ترفضه أصلًا قبل ما يوصل هنا
    expect(parseAiOutput('[{"segmentText":"عين حرس","intendedText":"عين حورس","quantity":1,"unitPrice":null,"confidence":0.9,"variantId":103}]')).toBeNull();
  });
  it("🔒 AI مايتنادش لما كل السطور محلولة", async () => {
    const resolver = vi.fn(async () => []);
    await analyzePasteV2(REAL, CATALOG, { resolver });
    expect(resolver).not.toHaveBeenCalled();
  });
  it("🔒 تعطل/timeout الـAI → النتيجة الحتمية كاملة والصفحة ماتقفش", async () => {
    const boom = vi.fn(async () => { throw new Error("timeout"); });
    const r = await analyzePasteV2(TEXT, CATALOG, { resolver: boom });
    expect(r.parseSource).toBe("deterministic");
    expect(r.lines.map(l => [l.match?.variantName ?? null, l.quantity])).toEqual([["سادة", 2], [null, 1]]);
    expect(r.fields.itemsTotal.value).toBe(600);
  });
  it("🔒 الافتراضي ORDER_PARSER_AI=none → مفيش resolver؛ الحدود مفروضة على المدخل", () => {
    expect(readResolverConfig({} as any).provider).toBe("none");
    expect(readResolverConfig({ ORDER_PARSER_AI: "anthropic" } as any).provider).toBe("none"); // بلا مفتاح
    expect(createSegmentResolver(readResolverConfig({} as any))).toBeNull();
    const long = "x".repeat(500);
    const s = sanitizeSegments(Array.from({ length: 30 }, () => long));
    expect(s.length).toBe(AI_MAX_SEGMENTS); expect(s[0].length).toBe(AI_MAX_SEGMENT_CHARS);
  });
  it("🔑 مزوّد anthropic بـfetch مزيّف: retry واحد بعد فشل، والمخرج يتحقق بالـschema", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      if (calls === 1) return new Response("oops", { status: 500 });
      return new Response(JSON.stringify({ content: [{ type: "text", text: '[{"segmentText":"عين حرس","intendedText":"عين حورس","quantity":null,"unitPrice":null,"confidence":0.7}]' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const resolver = createSegmentResolver({ provider: "anthropic", apiKey: "k", model: "m", fetchImpl })!;
    const out = await resolver(["عين حرس"], ["عين حورس"]);
    expect(calls).toBe(2);
    expect(out).toEqual([{ segmentText: "عين حرس", intendedText: "عين حورس", quantity: null, unitPrice: null, confidence: 0.7 }]);
    const body = JSON.parse((fetchImpl as any).mock.calls[0][1].body);
    expect(JSON.stringify(body)).not.toContain("01000000000");
  });
});

describe("🔒 parse token — موقّع ببصمة النتيجة القانونية وصلاحية ساعتين", () => {
  const rawText = REAL;
  const rawHash = require("crypto").createHash("sha256").update(rawText).digest("hex");
  it("🔑 يتحقق لنفس الموظف/النشاط/النص/البصمة، ويرفض أي تغيير بسبب واضح", async () => {
    const v2 = await analyzePasteV2(rawText, CATALOG);
    const fp = canonicalFingerprint(v2);
    const tok = signParseToken({ employeeId: 7, businessId: 3, rawHash, fp });
    expect(verifyParseToken(tok, { employeeId: 7, businessId: 3, rawText, fingerprint: fp }).ok).toBe(true);
    expect(verifyParseToken(tok, { employeeId: 8, businessId: 3, rawText, fingerprint: fp })).toMatchObject({ ok: false, reason: "identity" });
    expect(verifyParseToken(tok, { employeeId: 7, businessId: 4, rawText, fingerprint: fp })).toMatchObject({ ok: false, reason: "identity" });
    expect(verifyParseToken(tok, { employeeId: 7, businessId: 3, rawText: rawText + " ", fingerprint: fp })).toMatchObject({ ok: false, reason: "text" });
    expect(verifyParseToken(tok.slice(0, -2) + "zz", { employeeId: 7, businessId: 3, rawText, fingerprint: fp })).toMatchObject({ ok: false, reason: "signature" });
    // تعديل معرّف في النتيجة (المتصفح) → بصمة مختلفة → مرفوض
    const tampered = structuredClone(v2); tampered.lines[0].match!.variantId = 104;
    expect(verifyParseToken(tok, { employeeId: 7, businessId: 3, rawText, fingerprint: canonicalFingerprint(tampered) })).toMatchObject({ ok: false, reason: "result" });
    // تعديل سعر/كمية في النتيجة الموقّعة برضه بيغيّر البصمة
    const t2 = structuredClone(v2); t2.lines[0].unitPrice = 1;
    expect(canonicalFingerprint(t2)).not.toBe(fp);
    const t3 = structuredClone(v2); t3.lines[1].quantity = 5;
    expect(canonicalFingerprint(t3)).not.toBe(fp);
  });
  it("🔒 الصلاحية ساعتان بالميلي ثانية: قبلها صالح، بعدها منتهي (fake timers)", () => {
    expect(PARSE_TOKEN_TTL_MS).toBe(2 * 60 * 60 * 1000);
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-09-22T10:00:00Z").getTime();
      vi.setSystemTime(t0);
      const tok = signParseToken({ employeeId: 7, businessId: 3, rawHash, fp: "x" });
      vi.setSystemTime(t0 + PARSE_TOKEN_TTL_MS - 1);
      expect(verifyParseToken(tok, { employeeId: 7, businessId: 3, rawText }).ok).toBe(true);
      vi.setSystemTime(t0 + PARSE_TOKEN_TTL_MS + 1);
      expect(verifyParseToken(tok, { employeeId: 7, businessId: 3, rawText })).toMatchObject({ ok: false, reason: "expired" });
    } finally { vi.useRealTimers(); }
  });
  it("🔒 السر إلزامي من البيئة — بلا fallback", () => {
    const saved = process.env.JWT_SECRET; delete process.env.JWT_SECRET;
    try { expect(() => signParseToken({ employeeId: 1, businessId: 1, rawHash: "h", fp: "f" })).toThrow(/JWT_SECRET/); }
    finally { process.env.JWT_SECRET = saved; }
    const src = fs.readFileSync("server/orderParse.service.ts", "utf8");
    expect(src).not.toMatch(/JWT_SECRET\s*(\?\?|\|\|)\s*["']/);
  });
  it("🔑 الموظف هو المراجع النهائي: تغيير النوع (حتمي أو AI) مسموح بنيويًا، والبصمة لا تتأثر بقراره؛ الرفض للعدد/غير المحلول فقط", async () => {
    const v2 = await analyzePasteV2("نوع المنتج: ٢ سادة، 1 نجمة داوود\nعدد القطع: 3\nالسعر: 600", CATALOG);
    const canon = canonicalParse(v2);
    expect(JSON.stringify(canon)).not.toContain("locked");
    const fp = canonicalFingerprint(v2);
    // قبول الاقتراح أو تصحيحه لنوع تاني مملوك — الاتنين بيعدّوا المقارنة البنيوية
    expect(compareLinesToCanonical([{ productId: 10, variantId: 101 }, { productId: 10, variantId: 104 }], canon.lines)).toBeNull();
    expect(compareLinesToCanonical([{ productId: 10, variantId: 102 }, { productId: 10, variantId: 104 }], canon.lines)).toBeNull();
    expect(canonicalFingerprint(v2)).toBe(fp); // القرار النهائي مش جزء من النتيجة الموقّعة
    expect(compareLinesToCanonical([{ productId: 10, variantId: 101 }, { productId: undefined }], canon.lines)).toContain("اختر نوع النقش للسطر رقم 2");
    expect(compareLinesToCanonical([{ productId: 10, variantId: 101 }], canon.lines)).toContain("عدد السطور");
    // تصنيف القرار للسجل
    expect(classifyResolution({ productId: 10, variantId: 103, aiAssisted: true }, { productId: 10, variantId: 103 })).toBe("ai_accepted");
    expect(classifyResolution({ productId: 10, variantId: 103, aiAssisted: true }, { productId: 10, variantId: 104 })).toBe("employee_corrected");
    expect(classifyResolution({ productId: 10, variantId: 101, aiAssisted: false }, { productId: 10, variantId: 101 })).toBe("deterministic_accepted");
    expect(classifyResolution({ productId: 10, variantId: 101, aiAssisted: false }, { productId: 10, variantId: 102 })).toBe("employee_corrected");
    expect(classifyResolution({ productId: null, variantId: null, aiAssisted: false }, { productId: 10, variantId: 104 })).toBe("employee_selected");
  });
});

describe("🔒 حد استدعاء الـAI لكل (موظف + نشاط)", () => {
  it("🔒 بعد 20 محاولة في 10 دقائق مفيش request جديد للمزوّد، والنتيجة حتمية؛ النافذة بتتجدد", async () => {
    __resetAiRateLimitForTests();
    vi.useFakeTimers();
    try {
      const t0 = new Date("2026-09-22T12:00:00Z").getTime();
      vi.setSystemTime(t0);
      const provider = vi.fn(async (segments: string[]) => segments.map(s => ({ segmentText: s, intendedText: "عين حورس", quantity: null, unitPrice: null, confidence: 0.8 })));
      const limited = rateLimitedResolver(provider, aiRateKey(7, 3))!;
      const TEXT = "نوع المنتج: ٢ سادة، 1 عين حرس\nعدد القطع: 3\nالسعر: 600";
      for (let i = 0; i < AI_RATE_LIMIT_MAX; i++) expect((await analyzePasteV2(TEXT, CATALOG, { resolver: limited })).parseSource).toBe("mixed");
      expect(provider).toHaveBeenCalledTimes(AI_RATE_LIMIT_MAX);
      const over = await analyzePasteV2(TEXT, CATALOG, { resolver: limited });
      expect(provider).toHaveBeenCalledTimes(AI_RATE_LIMIT_MAX); // مفيش نداء جديد
      expect(over.parseSource).toBe("deterministic"); expect(over.lines[1].confidence).toBe("unresolved");
      // موظف/نشاط تاني مفتاح مستقل
      const other = rateLimitedResolver(provider, aiRateKey(8, 3))!;
      await analyzePasteV2(TEXT, CATALOG, { resolver: other });
      expect(provider).toHaveBeenCalledTimes(AI_RATE_LIMIT_MAX + 1);
      // بعد انقضاء النافذة يرجع مسموح
      vi.setSystemTime(t0 + AI_RATE_LIMIT_WINDOW_MS + 1);
      await analyzePasteV2(TEXT, CATALOG, { resolver: limited });
      expect(provider).toHaveBeenCalledTimes(AI_RATE_LIMIT_MAX + 2);
      // التحليل الحتمي (كل السطور محلولة) مابيعدّش ولا بينادي
      const before = provider.mock.calls.length;
      await analyzePasteV2(REAL, CATALOG, { resolver: limited });
      expect(provider.mock.calls.length).toBe(before);
    } finally { vi.useRealTimers(); __resetAiRateLimitForTests(); }
  });
});

describe("🔒 حراس المصدر", () => {
  it("🔒 addOrder: أوردر اللصق بيتحقق بإعادة التحليل على السيرفر (مش metadata العميل)، وrawText+parseToken لازم سوا", () => {
    const routers = fs.readFileSync("server/routers.ts", "utf8");
    const i = routers.indexOf("const pasteOrigin = input.rawText != null || input.parseToken != null");
    expect(i).toBeGreaterThan(0);
    const block = routers.slice(i, i + 2500);
    expect(block).toContain("fingerprint: canonicalFingerprint(input.parseResult)");
    expect(block).toContain("analyzePasteV2(input.rawText, catalog, {})"); // حتمي — بلا resolver
    expect(block).toContain("compareLinesToCanonical(input.selectedProducts, canon.lines)");
    expect(block).toContain("pasteSaveBlockers(");
    expect(block).toContain("employeeCatalogBusinessIds(empScope(ctx))");
    // مفيش أي اتصال بالـAI وقت الحفظ
    const addOrderBlock = routers.slice(routers.indexOf("addOrder: requireEmployeePermission"), routers.indexOf("myOrders: requireEmployeePermission"));
    expect(addOrderBlock).not.toMatch(/activeSegmentResolver|rateLimitedResolver|createSegmentResolver|resolver:/);
  });
  it("🔒 order_items بلا أعمدة جديدة، وسجل التحليل fail-safe", () => {
    const schema = fs.readFileSync("drizzle/schema.ts", "utf8");
    const items = schema.slice(schema.indexOf('export const orderItems = mysqlTable("order_items"'), schema.indexOf("});", schema.indexOf('export const orderItems = mysqlTable("order_items"')));
    expect(items).not.toMatch(/priceSource|confidence|parseSource/);
    const sql = fs.readFileSync("drizzle/0038_order_parse_audits.sql", "utf8").split("\n").filter(l => !l.trim().startsWith("--")).join("\n");
    expect(sql).not.toMatch(/ALTER TABLE|FOREIGN KEY|order_items/);
    const db = fs.readFileSync("server/db.ts", "utf8");
    const fn = db.slice(db.indexOf("export async function insertOrderParseAudit"), db.indexOf("export async function insertOrderParseAudit") + 1200);
    expect(fn).toContain("isMissingTableErr(err)");
    expect(fn).toContain("return false");
  });
  it("🔒 parsePaste مابيقراش جدول audit (مفيش استعلام عليه في المسارات العادية)", () => {
    const routers = fs.readFileSync("server/routers.ts", "utf8");
    expect(routers.match(/orderParseAudits/g) ?? []).toEqual([]);
    expect(routers.match(/insertOrderParseAudit\(/g)?.length).toBe(1);
  });
});
