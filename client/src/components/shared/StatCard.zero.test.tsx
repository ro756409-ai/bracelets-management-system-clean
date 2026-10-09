// @vitest-environment jsdom
/**
 * القسم A — بطاقات الإحصاء بقيمة صفر: الصفر الحقيقي يُعرض كما هو (لا يُخفى ولا يُستبدل بشرطة)، والبطاقة بلا
 * الحشو المزدوج (Card الأساسي py-6 gap-6 فوق p-4) وبنفس ارتفاع سطر القيمة للصفر وللقيمة الموجبة.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { StatCard } from "./StatCard";

afterEach(() => cleanup());

describe("📊 StatCard — القيمة صفر", () => {
  it("الصفر يُعرض كما هو، وسطر القيمة بنفس الحد الأدنى للارتفاع للصفر وللموجب", () => {
    render(<div><StatCard label="نافد" value={(0).toLocaleString("ar-EG")} /><StatCard label="المنتجات" value={(12).toLocaleString("ar-EG")} /></div>);
    const values = screen.getAllByTestId("stat-card-value");
    // الصفر يبقى «٠» نفسه + وصف مكتوب بجانبه؛ القيمة الموجبة بلا وصف
    expect(values[0].textContent).toBe("٠لا يوجد");
    expect(values[0].firstChild?.textContent).toBe("٠");
    expect(values[1].textContent).toBe("١٢");
    expect(screen.getAllByTestId("stat-card-zero-note")).toHaveLength(1);
    for (const v of values) expect(v.className).toContain("min-h-8");
    expect(values[0].className).toBe(values[1].className);
  });
  it("«٠ ج.م» و«٠%» ليست صفرًا عدديًا خامًا فلا وصف إضافي؛ الرقم 0 الحقيقي يأخذ الوصف", () => {
    render(<div><StatCard label="أ" value="٠ ج.م" /><StatCard label="ب" value="٠%" /><StatCard label="ج" value={0} /></div>);
    expect(screen.getAllByTestId("stat-card-zero-note")).toHaveLength(1);
  });
  it("بلا حشو مزدوج: Card بـ gap-0 py-0 h-full (عادية وتفاعلية)، والتلميح الطويل مقصوص لسطرين", () => {
    const { container } = render(<div><StatCard label="أ" value="٠" hint={"نص طويل جدًا ".repeat(20)} /><StatCard label="ب" value="٠" onClick={() => {}} /></div>);
    const cards = container.querySelectorAll('[data-slot="card"]');
    expect(cards).toHaveLength(2);
    for (const c of cards) { expect(c.className).toMatch(/\bgap-0\b/); expect(c.className).toMatch(/\bpy-0\b/); expect(c.className).toMatch(/\bh-full\b/); }
    expect(container.querySelector("p.line-clamp-2[title]")?.textContent).toContain("نص طويل");
  });
});
