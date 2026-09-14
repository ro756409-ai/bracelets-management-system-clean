import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حراس إصلاح استيراد Excel (write operation = نشاط واحد صريح، مش «كل الأنشطة»).
 *
 * نصّية عن قصد (بيئة node، مفيش DOM) — زي باقي حراس الواجهة. الحارس الأمني الحقيقي على
 * السيرفر (`importExcelSecurity.test.ts`)؛ دول بيقفلوا على سلوك النافذة: Select إلزامي،
 * preselect صحيح، إرسال businessId دائمًا، ومفيش رجوع لـcurrentGroup كوجهة كتابة.
 */
const src = fs.readFileSync("client/src/components/ImportExcelDialog.tsx", "utf-8");

describe("🔑 استيراد Excel — النشاط إلزامي وصريح", () => {
  it("🔑 المصدر المعتمد (businesses/activeList) مش currentGroup كوجهة كتابة", () => {
    expect(src).toContain("const activeBusinesses = businesses");
    // مفيش استخدام لـcurrentGroup كوجهة (اتشال تمامًا).
    expect(src).not.toContain("currentGroup");
    expect(src).not.toContain('"كل الأقسام"');
  });

  it("🔑 preselect: نشاط الـswitcher الواحد، أو النشاط المتاح الوحيد، وإلا إجبار الاختيار", () => {
    expect(src).toContain("currentBusinessIds && currentBusinessIds.length === 1");
    expect(src).toContain("activeBusinesses.length === 1");
    // «كل الأنشطة» + متعدد → null (مفيش auto-select).
    expect(src).toContain("return null");
  });

  it("🔑 handleImport بيبعت businessId **دائمًا** (مش مشروط بعدد الأنشطة)", () => {
    expect(src).toContain('formData.append("businessId", String(selectedBusinessId))');
    // مش الشكل القديم المشروط.
    expect(src).not.toContain("currentBusinessIds.length === 1) {\n        formData.append");
    // حارس مزدوج: مفيش كتابة بلا نشاط.
    expect(src).toContain("if (selectedBusinessId == null)");
  });

  it("🔑 زر الاستيراد معطّل حتى يتحدد النشاط", () => {
    expect(src).toContain("selectedBusinessId == null");
    expect(src).toMatch(/disabled=\{loading \|\| !previewData\?\.length \|\| selectedBusinessId == null\}/);
  });

  it("🔑 الـSelect مالوش خيار «كل الأنشطة» (مفيش value=all)", () => {
    // خيارات الـSelect بس من activeBusinesses.map — مفيش SelectItem بقيمة all/كل.
    expect(src).toContain("activeBusinesses.map(b =>");
    expect(src).not.toMatch(/SelectItem[^>]*value="all"/);
    expect(src).not.toMatch(/SelectItem[^>]*value=""[^>]*>.*كل/);
  });

  it("🔑 تغيير الاختيار بيعلّم userPicked ويغيّر selectedBusinessId (الاسم والريكوست يتغيّروا معًا)", () => {
    expect(src).toContain("userPickedRef.current = true; setSelectedBusinessId(Number(v))");
    // الاسم الظاهر مشتق من نفس الـid (فبيتغيّر مع الاختيار).
    expect(src).toContain("activeBusinesses.find(b => b.id === selectedBusinessId)?.name");
  });

  it("🔑 تغيير الـswitcher والنافذة مفتوحة مايدوسش على اختيار المستخدم الصريح", () => {
    expect(src).toContain("if (userPickedRef.current)");
    // بس بيمسح الاختيار لو بقى غير صالح (مش ضمن المتاح).
    expect(src).toContain("activeBusinesses.some(b => b.id === prev) ? prev : null");
  });
});
