/**
 * بوابة المدير (/manager-dashboard) — حارس نصّي لإعادة بناء طبقة العرض: نفس الـ31 hook بالترتيب نفسه،
 * لا عناصر خام (<button>/<textarea>/<table>)، StatCard المشترك بدل المحلي، حالات Error/Offline/Empty،
 * لا أصناف Tailwind غير صالحة، no_answer معروض، وبوابة الدور تمنع رسم التبويبات لغير المدير.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const src = strip(readFileSync(path.join(root, "pages/ManagerDashboard.tsx"), "utf8"));
const hooks = (s: string) => [...s.matchAll(/trpc\.[a-zA-Z0-9.]+\.use(Query|Mutation)/g)].map(m => m[0]);

describe("ManagerDashboard — hooks before = after", () => {
  it("same 31 hooks in the same order", () => {
    expect(hooks(src)).toEqual([
      "trpc.employeePortal.me.useQuery",
      "trpc.employeePortal.activeBroadcast.useQuery",
      "trpc.employeePortal.sendBroadcast.useMutation",
      "trpc.employeePortal.clearBroadcast.useMutation",
      "trpc.employeePortal.dashboardStats.useQuery",
      "trpc.employeePortal.lowStockProducts.useQuery",
      "trpc.employeePortal.dailyChart.useQuery",
      "trpc.businesses.groupsWithBusinesses.useQuery",
      "trpc.employeePortal.allOrders.useQuery",
      "trpc.employeePortal.activeEmployeesList.useQuery",
      "trpc.employeePortal.assignOrder.useMutation",
      "trpc.employeePortal.bulkAssignOrders.useMutation",
      "trpc.employeePortal.confirm.useMutation",
      "trpc.employeePortal.postpone.useMutation",
      "trpc.employeePortal.cancel.useMutation",
      "trpc.employeePortal.productsList.useQuery",
      "trpc.employeePortal.lowStockProducts.useQuery",
      "trpc.employeePortal.inventoryMovements.useQuery",
      "trpc.employeePortal.addInventoryMovement.useMutation",
      "trpc.employeePortal.employeePerformance.useQuery",
      "trpc.employeePortal.cancellationReasons.useQuery",
      "trpc.employeePortal.dailyChart.useQuery",
      "trpc.employeePortal.employeesList.useQuery",
      "trpc.employeePortal.createEmployee.useMutation",
      "trpc.employeePortal.setEmployeeCredentials.useMutation",
      "trpc.employeePortal.updateEmployee.useMutation",
      "trpc.employeePortal.employeesList.useQuery",
      "trpc.tasks.list.useQuery",
      "trpc.tasks.create.useMutation",
      "trpc.tasks.updateStatus.useMutation",
      "trpc.tasks.delete.useMutation",
    ]);
  });
  it("payloads unchanged on the write paths", () => {
    for (const s of [
      "sendBroadcastMutation.mutate({ message: broadcastMsg.trim() });",
      "assignMutation.mutate({ orderId: order.id, employeeId: parseInt(val), operationId: operationIdFor(`assign:${order.id}:${val}`) });",
      "orderIds: selectedOrders,",
      "confirmMutation.mutate({ orderId: order.id, operationId: operationIdFor(`confirm:${order.id}`) })",
      "postponeMutation.mutate({ orderId: postponeDialog.orderId, postponedTo: new Date(postponeDate), notes: postponeNotes || undefined, operationId: operationIdFor(`postpone:${postponeDialog.orderId}`) });",
      "cancelMutation.mutate({ orderId: cancelDialog.orderId, cancelReason: cancelReason as any, notes: cancelNotes || undefined, operationId: operationIdFor(`cancel:${cancelDialog.orderId}`) });",
      "createMutation.mutate({ name: newEmp.name, phone: newEmp.phone || undefined, role: newEmp.role });",
      "setCredMutation.mutate({ id: credDialog.empId, username: credUsername.trim(), password: credPassword });",
      "updateMutation.mutate({ id: emp.id, isActive: !emp.isActive })",
      "updateStatusMutation.mutate({ taskId: task.id, status: v })",
      "deleteMutation.mutate({ taskId: task.id });",
      'const canAct = order.status === "new" || order.status === "postponed";',
    ]) expect(src, s).toContain(s);
  });
});

describe("ManagerDashboard — shared design system", () => {
  it("no raw <button>, <textarea> or <table>", () => {
    expect(src).not.toMatch(/<button\b/);
    expect(src).not.toMatch(/<textarea\b/);
    expect(src).not.toMatch(/<table\b/);
    expect(src).toContain("<Textarea");
    expect(src).toContain("<ResponsiveDataTable");
    expect(src).toContain('cardsBelow="md"');
  });
  it("shared StatCard replaces the local one; dashboard stats show loading", () => {
    expect(src).not.toMatch(/function StatCard\b/);
    expect(src).toMatch(/import \{[^}]*\bStatCard\b[^}]*\} from "@\/components\/shared";/);
    const statLines = src.split("\n").filter(l => l.includes("<StatCard "));
    expect(statLines.length).toBe(4);
    for (const l of statLines) expect(l).toContain("loading={statsLoading}");
    expect(src).toContain("isLoading: statsLoading");
  });
  it("Error / Offline / Empty / Loading states are used", () => {
    expect(src).toContain("useOnlineStatus");
    for (const c of ["<ErrorState", "<OfflineState", "<EmptyState", "<LoadingSkeleton", "<SectionCard", "<PageHeader"]) expect(src, c).toContain(c);
    expect((src.match(/<ErrorState\b/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect((src.match(/!online && <OfflineState/g) ?? []).length).toBe(6);
  });
  it("invalid Tailwind classes are gone; no black/white literals", () => {
    expect(src).not.toMatch(/\/100"/);
    expect(src).not.toMatch(/\/100['`\s]/);
    expect(src).not.toContain("/10/50");
    expect(src).not.toContain("/100/10");
    expect(src).not.toMatch(/\btext-white\b|\bbg-black\b/);
  });
  it("exactly one <main>", () => {
    expect((src.match(/<main\b/g) ?? []).length).toBe(1);
  });
});

describe("ManagerDashboard — display and safety guards", () => {
  it("STATUS_CONFIG has a display entry for no_answer", () => {
    const block = src.slice(src.indexOf("const STATUS_CONFIG"), src.indexOf("const ROLE_LABELS"));
    expect(block).toMatch(/no_answer:\s*\{\s*label:\s*"[^"]+",\s*tone:/);
  });
  it("broadcast Enter key is ignored while sending; toggle-active disabled while pending", () => {
    expect(src).toContain("if (e.key === 'Enter' && broadcastMsg.trim() && !sendBroadcastMutation.isPending)");
    expect(src).toMatch(/disabled=\{updateMutation\.isPending\}\s*onClick=\{\(\) => updateMutation\.mutate\(\{ id: emp\.id, isActive: !emp\.isActive \}\)\}/);
  });
  it("daily chart reads `total` (the field getDailyOrdersChart returns) — never NaN labels", () => {
    const start = src.indexOf('testId="manager-daily-chart"');
    expect(start).toBeGreaterThan(-1);
    const chart = src.slice(start, src.indexOf("</SectionCard>", start));
    expect(chart).toContain("Number(d.total) || 0");
    // عمود الرسم لازم ياخد ارتفاع الحاوية، وإلا ارتفاع العمود بالنسبة المئوية بيتحسب على auto ويختفي
    expect(chart).toContain('className="flex h-full flex-col items-center justify-end');
    expect(chart).not.toMatch(/\bd\.count\b|\bx\.count\b/);
    const db = readFileSync(path.resolve(root, "../../server/db.ts"), "utf8");
    const fn = db.slice(db.indexOf("export async function getDailyOrdersChart"), db.indexOf("export async function getDailyOrdersChart") + 2000);
    expect(fn).toMatch(/COUNT\(\*\) as total/);
  });
  it("icon-only buttons carry an aria-label", () => {
    for (const l of ['aria-label="فتح القائمة"', 'aria-label="إغلاق القائمة"', 'aria-label="تسجيل الخروج"', 'aria-label="حذف المهمة"']) expect(src, l).toContain(l);
  });
});

describe("ManagerDashboard — role gate (UI only)", () => {
  it("tabs are not rendered unless the session role is manager; redirects kept", () => {
    expect(src).toContain('empSession?.role === "manager"');
    const gate = src.indexOf("if (!isManagerSession)");
    const main = src.indexOf("<main");
    const firstTab = src.indexOf("<ManagerDashboardTab />");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(main);
    expect(main).toBeLessThan(firstTab);
    // the early return comes after the last root hook (rules of hooks) — me query and redirects precede it
    expect(src.indexOf("trpc.employeePortal.me.useQuery")).toBeLessThan(gate);
    expect(src.indexOf('setLocation("/employee-dashboard")')).toBeLessThan(gate);
    expect(src).toContain("if (!empSession || empSession.role !== 'manager') {");
    expect(src).toContain('setLocation("/employee-login");');
  });
});
