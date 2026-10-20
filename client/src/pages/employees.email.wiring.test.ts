import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** BUG-41 — الواجهة لا ترسل email: "" (كان يرجع خطأ zod خام ويمنع الحفظ). */
describe("Employees — البريد الاختياري", () => {
  it("الحمولة ترسل البريد بعد trim أو undefined", () => {
    const s = readFileSync(resolve(__dirname, "Employees.tsx"), "utf8");
    expect(s).toContain("email: form.email.trim() || undefined");
    expect(s).not.toMatch(/email: form\.email,/);
  });
});
