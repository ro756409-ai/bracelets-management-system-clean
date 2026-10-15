import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * Matjarak 2.0 — المرحلة 1B-2: الشعار المؤقت وشاشات الدخول الأربع بألوان البراند الثابتة، بينما رؤوس الموبايل
 * التشغيلية تبقى بلون مساحة العمل (قرار المالك). مصدريًا — والقيم مثبتة في brandV2.test.
 */
const SRC = path.resolve(__dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(SRC, f), "utf-8");
const AUTH = ["pages/Login.tsx", "pages/EmployeeLogin.tsx", "pages/Register.tsx", "pages/platform/PlatformAdminLogin.tsx"];

describe("🏛️ المرحلة 1B-2 — أسطح البراند الثابتة", () => {
  it("شاشات الدخول الأربع: الخلفية من --brand-surface/--brand-surface-strong ولا تقرأ لون مساحة العمل (--primary)", () => {
    for (const f of AUTH) {
      const bg = read(f).match(/background:\s*"(linear-gradient\([^"]*\))"/)?.[1] ?? "";
      expect(bg, f).toMatch(/var\(--brand-surface(-strong)?\)/);
      expect(bg, f).not.toMatch(/var\(--primary/);
    }
  });

  it("دائرة الشعار المؤقت: تدرّج البراند الثابت (from-brand-mark to-brand-mark-strong)، لا primary؛ والشكل نفسه لم يتغير", () => {
    const mark = read("components/BrandMark.tsx");
    // النسخة العادية (الافتراضية) — والـclass المُنتَج حرفيًا مثبت في BrandMark.test
    expect(mark).toContain("bg-gradient-to-br ${inverse ? ");
    expect(mark).toContain(': "from-brand-mark to-brand-mark-strong"}');
    expect(mark).not.toMatch(/from-primary|to-primary/);
    expect(mark).toContain('d="M6 17 L6 7 L12 13 L18 7 L18 17"');
    const css = read("index.css");
    expect(css).toContain("--color-brand-mark: var(--brand-mark);");
    expect(css).toContain("--color-brand-mark-strong: var(--brand-mark-strong);");
  });

  it("رؤوس الموبايل التشغيلية (المدير/الموظف/المخزن) تبقى بلون مساحة العمل --primary — لا ألوان البراند", () => {
    for (const f of ["pages/ManagerDashboard.tsx", "pages/EmployeeDashboard.tsx", "pages/WarehouseDashboard.tsx"]) {
      const src = read(f);
      expect(src, f).toMatch(/linear-gradient\(135deg, var\(--primary-dark\) 0%, var\(--primary\) 100%\)/);
      expect(src, f).not.toMatch(/--brand-surface/);
    }
  });
});

describe("✨ المرحلة 1B-4 — الشعار المعكوس لهيدر المخزن وحدّ بطاقات الدخول", () => {
  const usages = () => {
    const out: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(path.join(SRC, d), { withFileTypes: true })) {
      const rel = path.join(d, e.name);
      if (e.isDirectory()) walk(rel); else if (/\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name)) for (const m of read(rel).matchAll(/<BrandMark\b[^>]*>/g)) out.push(`${rel} ${m[0]}`);
    } };
    walk("."); return out;
  };

  it("النسخة المعكوسة في هيدر المخزن فقط — كل أماكن BrandMark الأخرى على النسخة العادية", () => {
    const all = usages();
    expect(all.length).toBeGreaterThan(1);
    expect(all.filter(u => u.includes('variant="inverse"')).map(u => u.split(" ")[0])).toEqual(["pages/WarehouseDashboard.tsx"]);
  });

  it("المعكوس: نفس الشكل الهندسي حرفيًا، وألوانه من --brand-mark-inverse* فقط", () => {
    const mark = read("components/BrandMark.tsx");
    expect(mark).toContain("from-brand-mark-inverse to-brand-mark-inverse-strong");
    expect(mark).toContain('var(--brand-mark-inverse-foreground)');
    expect(mark).toContain('var(--brand-mark-inverse-node)');
    expect(mark.match(/<path\b/g)?.length).toBe(1);
    expect(mark.match(/<circle\b/g)?.length).toBe(1);
    const css = read("index.css");
    expect(css).toContain("--color-brand-mark-inverse: var(--brand-mark-inverse);");
    expect(css).toContain("--color-brand-mark-inverse-strong: var(--brand-mark-inverse-strong);");
  });

  it("بطاقات الدخول الأربع: حدّ من --auth-card-border عبر outline داخلي (لا يغيّر المقاس)، والخلفية والظل كما هما", () => {
    for (const f of AUTH) {
      const src = read(f);
      expect(src, f).toMatch(/shadow-\[var\(--shadow-card\)\]( backdrop-blur)? outline outline-\[var\(--auth-card-border\)\] -outline-offset-1/);
      expect(src.match(/--auth-card-border/g)?.length, f).toBe(1);
    }
  });
});
