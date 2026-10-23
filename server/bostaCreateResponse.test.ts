import { describe, it, expect } from "vitest";
import fs from "fs";
import { extractCreatedDelivery, describeResponseShape } from "./bosta.service";

/**
 * رد إنشاء شحنة بوسطة (P0 — الأوردر 14371): v2 بيرجّع الشحنة جوه `data`، وv0 في أعلى الرد.
 * المثال الأول هو مثال التوثيق الرسمي حرفيًا (docs.bosta.co/api/api.yaml — POST /deliveries?apiVersion=1).
 */
const V2_DOC_EXAMPLE = {
  success: true,
  message: "Done successfully.",
  data: {
    _id: "Lx9vyKBqAeiIcERQKfn6I",
    trackingNumber: "5108002",
    state: { _id: "6dow5iWGHejX8IA5vMMUb" },
    message: "Delivery created successfully!",
  },
};

describe("📦 extractCreatedDelivery — رقم الشحنة من رد الإنشاء", () => {
  it("✅ v2 (مثال التوثيق): الرقم ورقم التتبع من data", () => {
    expect(extractCreatedDelivery(V2_DOC_EXAMPLE)).toEqual({ shipmentId: "Lx9vyKBqAeiIcERQKfn6I", trackingNumber: "5108002", shape: "v2_data" });
  });

  it("✅ v0 المسطّح (تاريخ r1) لسه شغال", () => {
    expect(extractCreatedDelivery({ _id: "AbC-123_x", trackingNumber: "5165840774" })).toEqual({ shipmentId: "AbC-123_x", trackingNumber: "5165840774", shape: "v0_flat" });
  });

  it("✅ رقم التتبع رقمي (number) بيتحفظ نص — ومن غيره الرقم كفاية", () => {
    expect(extractCreatedDelivery({ success: true, data: { _id: "Lx9vyKBq", trackingNumber: 5165840774 } })?.trackingNumber).toBe("5165840774");
    expect(extractCreatedDelivery({ success: true, data: { _id: "Lx9vyKBq" } })).toEqual({ shipmentId: "Lx9vyKBq", trackingNumber: undefined, shape: "v2_data" });
  });

  it("🟡 201 بلا رقم في أي شكل → null (يفضل «غير مؤكد»، مش فشل)", () => {
    expect(extractCreatedDelivery({ success: true, message: "Done", data: {} })).toBeNull();
    expect(extractCreatedDelivery({ success: true, message: "Done" })).toBeNull();
    expect(extractCreatedDelivery({ success: true, data: { trackingNumber: "5165840774" } })).toBeNull();
    expect(extractCreatedDelivery({})).toBeNull();
  });

  it("🟡 success:false حتى مع رقم → null", () => {
    expect(extractCreatedDelivery({ success: false, message: "x", data: { _id: "Lx9vyKBq" } })).toBeNull();
    expect(extractCreatedDelivery({ success: false, _id: "Lx9vyKBq" })).toBeNull();
  });

  it("🟡 رقمين مختلفين في المكانين → null (مانختارش على الأعمى)", () => {
    expect(extractCreatedDelivery({ _id: "Top12345", data: { _id: "Data1234" } })).toBeNull();
    expect(extractCreatedDelivery({ _id: "Same1234", data: { _id: "Same1234" } })?.shape).toBe("v2_data");
  });

  it("🟡 رقم بصيغة غريبة/فاضي/طويل/كائن → null", () => {
    for (const bad of ["", "   ", "abc", "has space", "x".repeat(101), "<script>", { $oid: "Lx9vyKBq" }, true, null, Number.NaN])
      expect(extractCreatedDelivery({ success: true, data: { _id: bad } })).toBeNull();
  });

  it("🟡 رد مش كائن (null/مصفوفة/نص/رقم) → null من غير رمي", () => {
    for (const body of [null, undefined, [], [{ _id: "Lx9vyKBq" }], "Lx9vyKBq", 42, { data: [{ _id: "Lx9vyKBq" }] }])
      expect(extractCreatedDelivery(body)).toBeNull();
  });

  it("رقم تتبع بصيغة غريبة بيتشال بس — الشحنة نفسها بتتسجّل", () => {
    expect(extractCreatedDelivery({ success: true, data: { _id: "Lx9vyKBq", trackingNumber: "51 65" } })).toEqual({ shipmentId: "Lx9vyKBq", trackingNumber: undefined, shape: "v2_data" });
  });
});

describe("🔒 describeResponseShape — أسماء الحقول بس للّوج", () => {
  it("مابيطلّعش أي قيمة (اسم/هاتف/عنوان المستلم)", () => {
    const out = describeResponseShape({ success: true, message: "ok", data: { receiver: { phone: "01012345678", firstName: "أحمد" }, dropOffAddress: { firstLine: "شارع 9" } } });
    expect(out).toBe("top=[success,message,data] data=[+2]");
    expect(out).not.toMatch(/0101|أحمد|شارع|receiver|dropOffAddress/);
  });
  it("حتى اسم webhookCustomHeaders (السر) مايظهرش — بيتعد بس", () => {
    const out = describeResponseShape({ success: true, data: { _id: "x", webhookCustomHeaders: { "x-bosta-secret": "S3cr3t" }, webhookUrl: "https://a" } });
    expect(out).toBe("top=[success,data] data=[_id,+2]");
    expect(out).not.toMatch(/webhook|S3cr3t/);
  });
  it("أشكال غير كائن", () => {
    expect(describeResponseShape(null)).toBe("top=[null]");
    expect(describeResponseShape([1])).toBe("top=[[array]]");
    expect(describeResponseShape({ data: null })).toBe("top=[data] data=[null]");
  });
});

describe("🔑 مسار الإنشاء نفسه بيستخدم الدالة — ومفيش حالات بوسطة جديدة", () => {
  const svc = fs.readFileSync("server/bosta.service.ts", "utf-8");
  const code = svc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
  const sendFn = code.slice(code.indexOf("const response = await fetchImpl(`${conn.baseUrl}/deliveries`"), code.indexOf("export function clampDeposit"));

  it("النجاح (sent) بس لما extractCreatedDelivery يرجّع رقم — مفيش قراءة لـresponseBody._id مباشرة", () => {
    expect(sendFn).toContain("extractCreatedDelivery(parsedBody)");
    expect(sendFn).toContain("if (response.ok && !created)");
    expect(sendFn).toContain("if (response.ok && created)");
    expect(sendFn).not.toContain("responseBody._id");
  });

  it("نسخة الرجوع r1 بتقفل الإرسال لـcreating/uncertain/reset_requested بس — الإصلاح مابيضيفش أي قيمة bostaStatus جديدة", () => {
    const values = new Set([...code.matchAll(/bostaStatus:\s*("([a-z_]+)"|([A-Z_]+))/g)].map(m => m[2] ?? m[3]));
    expect([...values].sort()).toEqual(["BOSTA_CREATING", "BOSTA_UNCERTAIN", "failed", "sent"].sort());
  });
});
