// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * مدخل مركز الرسائل في كل بوابات الموظفين: يظهر فقط والعلم مفعّل ومع messages.use (من status بهوية **البوابة**)،
 * ويختفي فور سحب الصلاحية؛ وكل بوابة تستخدم هوية البوابة (لا جلسة مالك مفتوحة في نفس المتصفح).
 */
const st = vi.hoisted(() => ({ status: { enabled: true, permissions: { use: true, voice: true, announce: false, manageGroups: false, viewPrivate: false } } as any, unread: 2, calls: [] as string[] }));
vi.mock("@/lib/trpc", () => {
  const msgs = (via: string) => ({
    status: { useQuery: () => { st.calls.push(`${via}.status`); return { data: st.status, isLoading: false }; } },
    conversations: { useQuery: (_: any, o: any) => { if (o?.enabled) st.calls.push(`${via}.conversations`); return { data: o?.enabled ? { enabled: true, conversations: [], unreadTotal: st.unread, monitor: [], canMonitor: false } : undefined, refetch: async () => ({}) }; } },
  });
  return { trpc: { messages: msgs("web"), employeePortal: { messages: msgs("portal"), me: { useQuery: () => ({ data: { name: "كريم" } }) } } } };
});
vi.mock("wouter", () => ({ useLocation: () => ["/warehouse-dashboard", () => {}], Link: ({ children }: any) => <a>{children}</a> }));

import { EmployeeShell } from "@/components/shell/EmployeeShell";
import { EmployeeLedgerShell } from "@/pages/ledger/LedgerLayout";

const PERMS = (p: any = {}) => ({ use: true, voice: true, announce: false, manageGroups: false, viewPrivate: false, ...p });
beforeEach(() => { st.status = { enabled: true, permissions: PERMS() }; st.unread = 2; st.calls = []; });
afterEach(() => cleanup());

describe("🚪 مدخل الرسائل في القشرة المشتركة للبوابة", () => {
  for (const [name, Shell] of [["EmployeeShell", ({ children }: any) => <EmployeeShell title="حضوري">{children}</EmployeeShell>], ["قشرة المحاسب", EmployeeLedgerShell]] as const) {
    it(`${name}: يظهر بهوية البوابة مع العدد، ويختفي والعلم معطل أو بلا messages.use (الطلب التالي)`, () => {
      const v = render(<Shell><p>محتوى</p></Shell>);
      expect(screen.getByTestId("messages-entry").getAttribute("aria-label")).toBe("الرسائل — 2 غير مقروءة");
      expect(st.calls.every(c => c.startsWith("portal."))).toBe(true); // لا هوية ويب
      st.status = { enabled: true, permissions: PERMS({ use: false }) }; // سحب الصلاحية
      v.rerender(<Shell><p>محتوى</p></Shell>);
      expect(screen.queryByTestId("messages-entry")).toBeNull();
      st.status = { enabled: false, permissions: PERMS() };
      st.calls = [];
      v.rerender(<Shell><p>محتوى</p></Shell>);
      expect(screen.queryByTestId("messages-entry")).toBeNull();
      expect(st.calls.filter(c => c.endsWith("conversations"))).toEqual([]); // العلم معطل: status فقط
    });
  }
});

describe("🧭 كل بوابة موظف فيها المدخل المشترك بهوية البوابة", () => {
  const PORTALS: [string, string][] = [
    ["التأكيدات/agent/moderator/الشحن/Scanner/viewer", "client/src/pages/EmployeeDashboard.tsx"],
    ["المخزن", "client/src/pages/WarehouseDashboard.tsx"],
    ["المدير (بوابة)", "client/src/pages/ManagerDashboard.tsx"],
    ["Data Entry / Facebook Entry", "client/src/pages/FacebookEntry.tsx"],
    ["الشحن — شحنات اليوم", "client/src/pages/TodayShipments.tsx"],
    ["الشحن — جدول الشحن", "client/src/pages/ShippingSchedule.tsx"],
    ["حضوري/أدائي/الرسائل/استلام البضاعة/الجرد (EmployeeShell)", "client/src/components/shell/EmployeeShell.tsx"],
    ["المحاسب (قشرة الدفتر)", "client/src/pages/ledger/LedgerLayout.tsx"],
  ];
  for (const [who, file] of PORTALS) {
    it(`${who}: <MessagesEntryButton via="portal"> وبلا via="web"`, () => {
      const src = fs.readFileSync(file, "utf-8");
      expect(src).toMatch(/<MessagesEntryButton via="portal"/);
      expect(src).not.toMatch(/<MessagesEntryButton via="web"/);
    });
  }
  it("المدير: في الشريط الجانبي (ديسكتوب) ورأس الموبايل", () => {
    expect(fs.readFileSync("client/src/pages/ManagerDashboard.tsx", "utf-8").match(/<MessagesEntryButton via="portal"/g)).toHaveLength(2);
  });
  it("لوحة المالك/المدير (DashboardLayout) وحدها بهوية الويب", () => {
    expect(fs.readFileSync("client/src/components/DashboardLayout.tsx", "utf-8")).toMatch(/<MessagesEntryButton via="web"/);
  });
});
