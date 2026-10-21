import { describe, it, expect } from "vitest";
import { z } from "zod";
import { optionalEmployeeEmail } from "./employeeInput";

/** BUG-41 — البريد الاختياري في إنشاء/تعديل الموظف. */
const schema = z.object({ email: optionalEmployeeEmail });

describe("optionalEmployeeEmail", () => {
  it("الفراغ والمسافات = بلا بريد (لا رفض)", () => {
    expect(schema.parse({ email: "" })).toEqual({ email: undefined });
    expect(schema.parse({ email: "   " })).toEqual({ email: undefined });
    expect(schema.parse({})).toEqual({ email: undefined });
  });
  it("البريد الصالح يُحفظ بعد إزالة المسافات الطرفية", () => {
    expect(schema.parse({ email: "  sara@store.example " })).toEqual({ email: "sara@store.example" });
  });
  it("البريد غير الصالح ما زال مرفوضًا", () => {
    expect(schema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });
});

describe("BUG-41 — الإجراءات الأربعة تستخدم نفس المخطط (فحص ثابت)", () => {
  it("لا يتبقى z.string().email().optional() خام في إنشاء/تعديل الموظف", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const code = readFileSync(resolve(__dirname, "routers.ts"), "utf8");
    expect(code.match(/email: optionalEmployeeEmail,/g)?.length).toBe(4);
    expect(code).not.toContain("email: z.string().email().optional()");
  });
});
