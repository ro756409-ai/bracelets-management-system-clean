import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_CANCEL_REASONS, withDefaultCancelReasons } from "./useCancelReasonOptions";

/** BUG-28 — نوافذ الإلغاء لا تتعطل لما النشاط مالوش أسباب إلغاء مضبوطة. */
const src = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

describe("withDefaultCancelReasons", () => {
  it("قائمة فارغة ⇒ الأسباب الافتراضية الموجودة في الكود (نفس الثمانية بالحرف، بلا إضافة)", () => {
    expect([...DEFAULT_CANCEL_REASONS]).toEqual([
      "العميل غيّر رأيه",
      "السعر غالي",
      "طلب بالخطأ",
      "مش متاح للتوصيل في منطقته",
      "المنتج مش متوفر",
      "أوردر مكرر",
      "رقم غلط أو مش موجود",
      "العميل مش بيرد",
    ]);
    const out = withDefaultCancelReasons([]);
    expect(out).toHaveLength(8);
    expect(out[0]).toEqual({ value: "العميل غيّر رأيه", label: "العميل غيّر رأيه" });
  });
  it("أسباب النشاط المضبوطة لها الأولوية والافتراضية لا تُخلط بها", () => {
    const configured = [{ value: "price", label: "السعر" }, { value: "dup", label: "مكرر" }];
    expect(withDefaultCancelReasons(configured)).toEqual(configured);
  });
  it("صفوف تالفة (بلا قيمة أو اسم) لا تُحسب أسبابًا مضبوطة", () => {
    expect(withDefaultCancelReasons([{ value: "", label: "x" }, { value: "y", label: "" }])).toHaveLength(8);
  });
});

describe("BUG-28 — كل نوافذ الإلغاء تستخدم القائمة المضمونة (فحص ثابت)", () => {
  const dialogs = ["components/orders/OrderActionDialogs.tsx", "pages/Orders.tsx", "pages/AgentWorkspace.tsx"];
  for (const f of dialogs) {
    it(`${f}: useCancelReasonOptions بدل القائمة الخام`, () => {
      const s = src(f);
      expect(s).toContain("const cancelReasonOptions = useCancelReasonOptions().options;");
      expect(s).not.toContain('useOperationalOptions("cancellation_reason")');
    });
  }
  it("ManagerDashboard: نافذة الإلغاء مضمونة، وتبويب التقارير يبقى على القائمة الخام لتحويل الكود لاسم", () => {
    const s = src("pages/ManagerDashboard.tsx");
    expect(s.match(/useCancelReasonOptions\(\)\.options/g)?.length).toBe(1);
    expect(s.match(/useOperationalOptions\("cancellation_reason"\)\.options/g)?.length).toBe(1);
    expect(s.indexOf("useCancelReasonOptions().options")).toBeLessThan(s.indexOf("function ManagerReportsTab"));
  });
  it("EmployeeDashboard يستخدم نفس المصدر (لا نسخة ثانية من القائمة)", () => {
    const s = src("pages/EmployeeDashboard.tsx");
    expect(s).toContain("withDefaultCancelReasons(cancelReasonOptions)");
    expect(s).not.toContain("const DEFAULT_CANCEL_REASONS");
  });
  it("لا أسباب مرتجع افتراضية جديدة ولا تغيير في مصدر أسباب المرتجع", () => {
    const orders = src("pages/Orders.tsx");
    expect(orders).toContain('useOperationalOptions("return_reason")');
    expect(src("hooks/useCancelReasonOptions.ts")).not.toMatch(/return_reason|DEFAULT_RETURN/);
  });
});
