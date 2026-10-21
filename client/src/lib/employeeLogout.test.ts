import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { employeeLogout, EMPLOYEE_SESSION_KEY } from "./employeeScope";

/**
 * BUG-19 — الخروج من بوابات المخزن وإدخال فيسبوك وشحنات اليوم لازم يمر على السيرفر.
 * (الكوكي httpOnly؛ مسح localStorage أو document.cookie من الواجهة لا يُنهي الجلسة.)
 */
function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    get length() { return m.size; },
  };
}

beforeEach(() => {
  (globalThis as any).localStorage = memoryStorage();
});

describe("employeeLogout", () => {
  it("يستدعي POST /api/employee/logout مع الكوكي ثم يمسح الجلسة المحلية", async () => {
    localStorage.setItem(EMPLOYEE_SESSION_KEY, JSON.stringify({ id: 7 }));
    localStorage.setItem("employee_token", "legacy");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await employeeLogout(fetchImpl as any);
    expect(fetchImpl).toHaveBeenCalledWith("/api/employee/logout", { method: "POST", credentials: "include" });
    expect(localStorage.getItem(EMPLOYEE_SESSION_KEY)).toBeNull();
    expect(localStorage.getItem("employee_token")).toBeNull();
  });

  it("فشل الشبكة لا يمنع الخروج من الشاشة ولا يرمي خطأ", async () => {
    localStorage.setItem(EMPLOYEE_SESSION_KEY, JSON.stringify({ id: 7 }));
    const fetchImpl = vi.fn(async () => { throw new TypeError("offline"); });
    await expect(employeeLogout(fetchImpl as any)).resolves.toBeUndefined();
    expect(localStorage.getItem(EMPLOYEE_SESSION_KEY)).toBeNull();
  });
});

describe("BUG-19 — البوابات الثلاث تستخدم الخروج الحقيقي", () => {
  const root = resolve(__dirname, "../pages");
  for (const file of ["WarehouseDashboard.tsx", "FacebookEntry.tsx", "TodayShipments.tsx"]) {
    it(`${file}: handleLogout يمر على employeeLogout`, () => {
      const s = readFileSync(resolve(root, file), "utf8");
      const i = s.search(/(const handleLogout = async \(\) => \{|async function handleLogout\(\) \{)/);
      expect(i).toBeGreaterThan(-1);
      const body = s.slice(i, i + 300);
      expect(body).toContain("await employeeLogout()");
      expect(s).not.toMatch(/document\.cookie\s*=\s*["'`]employee_token=/);
      expect(s).not.toMatch(/localStorage\.removeItem\(["']employee_token["']\)/);
    });
  }
});
