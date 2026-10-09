// @vitest-environment jsdom
/**
 * التقرير الحالي لأداء الموظفين تقديري (الإسناد الحالي + الحالة الحالية) لحد بناء سجل الأحداث:
 * العنوان والتنبيه لازم يظهروا في كل مكان بيعرضه، ومايترتّبش بنسبة التأكيد، والحسابات ماتتغيّرش.
 * + حارس عام: مفيش اسم استعلام/دالة ظاهر للمستخدم في hint/description/title/label.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import fs from "fs";
import path from "path";
import {
  EstimatedPerformanceNotice,
  ESTIMATED_PERFORMANCE_TITLE,
  ESTIMATED_PERFORMANCE_WARNING,
  sortByEmployeeName,
} from "./EstimatedPerformanceNotice";

afterEach(() => cleanup());
const pages = path.resolve(__dirname, "../../pages");
const read = (f: string) => fs.readFileSync(path.join(pages, f), "utf8");

describe("ملخص الأداء التقديري", () => {
  it("التنبيه يظهر بالنص المطلوب كـnote", () => {
    render(<EstimatedPerformanceNotice />);
    const note = screen.getByRole("note");
    expect(note.textContent).toContain("قد لا يعكس الموظف الذي نفّذ كل إجراء فعليًا.");
    expect(note.textContent).toContain("ولا يُستخدم لترتيب الموظفين أو مكافأتهم أو الخصم منهم");
    expect(ESTIMATED_PERFORMANCE_TITLE).toBe("ملخص تشغيلي تقديري حسب التعيين والحالة الحالية");
    expect(ESTIMATED_PERFORMANCE_WARNING).toBe("قد لا يعكس الموظف الذي نفّذ كل إجراء فعليًا.");
  });

  it("الترتيب محايد بالاسم ومابيغيّرش الأرقام ولا المصفوفة الأصلية", () => {
    const rows = [
      { employeeName: "منى", confirmRate: 90, total: 10 },
      { employeeName: "سارة", confirmRate: 10, total: 3 },
    ];
    const sorted = sortByEmployeeName(rows);
    expect(sorted.map(r => r.employeeName)).toEqual(["سارة", "منى"]);
    expect(sorted[1]).toBe(rows[0]);
    expect(rows[0].employeeName).toBe("منى");
    expect(sortByEmployeeName(undefined)).toEqual([]);
  });

  it("الأماكن الثلاثة بتعرض العنوان والتنبيه، ومفيش ترتيب بنسبة التأكيد ولا «أداء ممتاز»", () => {
    for (const f of ["Reports.tsx", "Employees.tsx", "ManagerDashboard.tsx"]) {
      const src = read(f);
      expect(src, f).toContain("<EstimatedPerformanceNotice");
      expect(src, f).toContain("ESTIMATED_PERFORMANCE_TITLE");
      expect(src, f).toContain("sortByEmployeeName(");
      expect(src, f).not.toMatch(/b\.confirmRate - a\.confirmRate/);
      expect(src, f).not.toMatch(/title="أداء الموظفين"/);
    }
    expect(read("Reports.tsx")).not.toContain("أداء ممتاز");
    expect(read("Reports.tsx")).not.toContain("يحتاج تحسين");
  });
});

describe("لا أسماء برمجية ظاهرة للمستخدم", () => {
  it("مفيش hint/description/title/label فيه اسم استعلام أو دالة (x.y أو (getX))", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".tsx") && !p.includes(".test.")) files.push(p);
      }
    };
    walk(path.resolve(__dirname, "../.."));
    const offenders: string[] = [];
    const attr = /\b(hint|description|title|label)=("([^"]*)"|\{`([^`]*)`\})/g;
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(attr)) {
        const text = (m[3] ?? m[4] ?? "").replace(/\$\{[^}]*\}/g, "");
        if (/https?:|@|example/.test(text)) continue;
        if (/\b[a-z][a-zA-Z]*\.[a-z][a-zA-Z]+\b/.test(text) || /\(get[A-Z][a-zA-Z]*\)/.test(text))
          offenders.push(`${path.relative(process.cwd(), f)}: ${m[0].slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("مفيش نص عربي ظاهر فيه اسم برمجي بين قوسين — (stocktakeList) أو (accounting.view)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".tsx") && !p.includes(".test.")) files.push(p);
      }
    };
    walk(path.resolve(__dirname, "../.."));
    const literal = /"([^"\n]*)"|`([^`]*)`|>([^<>{}\n]+)</g;
    const arabic = /[؀-ۿ]/;
    const codeInParens = /\((?:[a-z]+[A-Z][A-Za-z0-9]*|[a-z][a-zA-Z]*\.[a-z][a-zA-Z]+)\)/;
    const offenders: string[] = [];
    for (const f of files) {
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        const trimmed = line.trim();
        if (/^(\/\/|\*|\/\*|\{\/\*)/.test(trimmed)) return;
        for (const m of line.matchAll(literal)) {
          const text = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, "");
          if (arabic.test(text) && codeInParens.test(text)) offenders.push(`${path.relative(process.cwd(), f)}:${i + 1}: ${text.trim().slice(0, 80)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
