/**
 * المرحلة 8 — إصلاحات المراجعة النهائية (عرض فقط): شريط إجراءات الأوردر يرتكز على --bottom-nav-h لا على 3.5rem
 * (فجوة 6px عند خط 90%)؛ الحد الأدنى بالبكسل لأهداف اللمس على الهاتف يشمل min-h-12/h-12؛ لا صنف 44px بمتغيّر
 * عشوائي ([&_x]:min-h-11) يفلت من ذلك الحد؛ بوابة الموظف فيها <main> واحد وأزرار هيدر 44px معنونة.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const walk = (dir: string): string[] => readdirSync(dir).flatMap(f => { const p = path.join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe("🧪 المرحلة 8", () => {
  it("OrderActionBar: bottom-[var(--bottom-nav-h,0px)] بدل 3.5rem", () => {
    const bar = read("components/orders/OrderActionBar.tsx");
    expect(bar).toContain("fixed inset-x-0 bottom-[var(--bottom-nav-h,0px)] z-30");
    expect(bar).not.toContain("3.5rem");
  });
  it("حد البكسل على الهاتف يشمل min-h-11/h-11/w-11/min-w-11/min-h-12/h-12", () => {
    const css = read("index.css");
    const start = css.indexOf("@media (max-width: 767px) {\n  /* ارتفاع القائمة السفلية");
    const block = css.slice(start, css.indexOf("\n}\n", start) + 3);
    for (const s of [".min-h-11 { min-height: max(2.75rem, 44px); }", ".h-11 { height: max(2.75rem, 44px); }", ".min-w-11 { min-width: max(2.75rem, 44px); }", ".min-h-12 { min-height: max(3rem, 48px); }", ".h-12 { height: max(3rem, 48px); }"]) expect(block, s).toContain(s);
  });
  it("لا [&_x]:min-h-11 في الواجهة — المتغيّرات العشوائية تستخدم min-h-[max(2.75rem,44px)]", () => {
    const offenders = walk(root).filter(f => f.endsWith(".tsx") && !f.includes(".test.")).filter(f => /(?<!md:)\[&[^ "`]*\]:min-h-11\b/.test(readFileSync(f, "utf8")));
    expect(offenders.map(f => path.relative(root, f))).toEqual([]);
  });
  it("EmployeeDashboard: <main> واحد، وأزرار الهيدر 44px على الهاتف ومعنونة", () => {
    const s = read("pages/EmployeeDashboard.tsx");
    expect((s.match(/<main\b/g) ?? []).length).toBe(1);
    const header = s.slice(s.indexOf("<header"), s.indexOf("</header>"));
    // أزرار الرأس انتقلت للمكوّن المشترك PortalHeaderActions (صف واحد على الهاتف + «المزيد»)
    expect(header).toContain("<PortalHeaderActions");
    expect(header.match(/label: "[^"]+"/g)?.length ?? 0).toBeGreaterThanOrEqual(9);
    const c = read("components/shell/PortalHeaderActions.tsx");
    expect(c).toMatch(/const BTN = "[^"]*\bmin-h-11\b[^"]*min-w-11/);
    const buttons = c.match(/<button\b(?:=>|[^>])*>/gs) ?? [];
    expect(buttons.length).toBe(3); // الفعل، «المزيد»، الخروج
    for (const b of buttons) { expect(b).toMatch(/className=\{cn\(BTN/); expect(b).toMatch(/aria-label=/); }
    expect(c).toMatch(/DropdownMenuItem[^>]*min-h-11/);
  });
  it("زر الدخول في DashboardLayout 44px", () => {
    expect(read("components/DashboardLayout.tsx")).toContain('className="min-h-11 w-full"');
  });
});
