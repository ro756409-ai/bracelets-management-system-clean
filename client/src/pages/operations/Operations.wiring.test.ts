import { describe, it, expect } from "vitest";
import fs from "fs";
import { PRIMARY_DESTINATIONS, visibleChildren, activeDestinationKey } from "@/config/navigation";

/**
 * حراس Stage D — Operations Workspace. نصّية (بيئة node، مفيش DOM) زي Stage B/C، + فحص
 * سلوكي للتنقّل. بتقفل على: toolkit المرحلة A، العدّادات من السيرفر، مفيش تبويبات مكرّرة
 * جوه الصفحات، جلسة الداشبورد بتفتح التبويبات جوه الشل، والبوابة محفوظة.
 */
const read = (p: string) => fs.readFileSync(p, "utf-8");
const prep = read("client/src/pages/Preparation.tsx");
const todayWs = read("client/src/pages/operations/TodayShipmentsWorkspace.tsx");
const scheduleWs = read("client/src/pages/operations/ShippingScheduleWorkspace.tsx");
const todayPortal = read("client/src/pages/TodayShipments.tsx");
const schedulePortal = read("client/src/pages/ShippingSchedule.tsx");
const app = read("client/src/App.tsx");

describe("🔑 التجهيز — Workspace من toolkit المرحلة A", () => {
  it("🔑 WorkspaceShell + StatusFilterChips + DataToolbar (مفيش رأس/فلاتر يدوية)", () => {
    expect(prep).toContain('from "@/components/workspace"');
    expect(prep).toContain("<WorkspaceShell");
    expect(prep).toContain("<StatusFilterChips");
    expect(prep).toContain("<DataToolbar");
    expect(prep).toContain("onReset={resetFilters}");
    expect(prep).not.toContain("<h1");
    // Select الحالة القديم اتشال — الحالة مصدرها الشرائح بس.
    expect(prep).not.toContain('<SelectItem value="confirmed">مؤكد فقط</SelectItem>');
  });

  it("🔑 عدّادات الحالة من orders.statusCounts (مش من صفحة الـ50)", () => {
    expect(prep).toContain("trpc.orders.statusCounts.useQuery");
    expect(prep).toContain("statusCounts?.byStatus?.confirmed");
    expect(prep).not.toContain('const confirmedCount = orders.filter');
    // الطباعة بتحوّل مؤكد → مطبوع، فالعدّادات بتتحدّث معاها.
    expect(prep).toContain("utils.orders.statusCounts.invalidate()");
  });

  it("🔑 الوظائف محفوظة: تحديد/طباعة/شيت الشحن + سجل الطباعة + التحقق", () => {
    for (const s of [
      "/api/export/print-labels?", "/api/export/shipping?",
      'savePrintLogMutation.mutate({ type: "labels"', 'savePrintLogMutation.mutate({ type: "shipping_sheet"',
      "selectAllConfirmed", "toggleSelectAll", "incompleteOrders", "refetchInterval: 30000",
    ]) {
      expect(prep, s).toContain(s);
    }
  });
});

describe("🔑 مفيش تبويبات مكرّرة — الشل هو المصدر الوحيد", () => {
  it("🔑 صفحات التشغيل مابتعرضش WorkspaceTabs (DashboardLayout بيعرضها)", () => {
    for (const [name, src] of [["Preparation", prep], ["TodayShipmentsWorkspace", todayWs], ["ShippingScheduleWorkspace", scheduleWs]] as const) {
      expect(src, name).not.toContain("<WorkspaceTabs");
      expect(src, name).not.toContain("tabs={");
    }
    expect(read("client/src/components/DashboardLayout.tsx")).toContain("<WorkspaceTabs tabs={workspaceTabs} />");
  });
});

describe("🔑 شحنات اليوم / جدول الشحن — جلسة الداشبورد جوه الشل", () => {
  it("🔑 نفس الـroute: user → DashboardLayout + workspace، غير كده → صفحة البوابة", () => {
    const fn = app.slice(app.indexOf("function OperationsRoute"), app.indexOf("function Router"));
    expect(fn).toContain("if (user) return <DashboardLayout>{workspace}</DashboardLayout>;");
    expect(fn).toContain("return <>{portal}</>;");
    expect(app).toContain("<OperationsRoute workspace={<TodayShipmentsWorkspace />} portal={<TodayShipments />} />");
    expect(app).toContain("<OperationsRoute workspace={<ShippingScheduleWorkspace />} portal={<ShippingSchedule />} />");
  });

  it("🔑 الـworkspace بيقرا من operations.* بنطاق مبدّل الأنشطة", () => {
    expect(todayWs).toContain("trpc.operations.todayShipments.useQuery");
    expect(scheduleWs).toContain("trpc.operations.shippingRoutes.useQuery");
    for (const src of [todayWs, scheduleWs]) {
      expect(src).toContain("businessIds: currentBusinessIds");
      expect(src).not.toContain("employeePortal");
      expect(src).not.toContain("currentGroup");
      expect(src).not.toContain("employee_session");
      expect(src).toContain("<WorkspaceShell");
      expect(src).toContain("PermissionDeniedState");
    }
  });

  it("🔑 عرض وفلترة مشتركين بين البوابة والـworkspace (مفيش نسختين)", () => {
    expect(todayPortal).toContain("<ShipmentsManifest");
    expect(todayWs).toContain("<ShipmentsManifest");
    expect(todayPortal).toContain("filterShipmentAgents(");
    expect(todayWs).toContain("filterShipmentAgents(");
    expect(schedulePortal).toContain("<ShippingRoutesBoard");
    expect(scheduleWs).toContain("<ShippingRoutesBoard");
    expect(todayPortal).not.toContain("const AGENT_COLORS");
    expect(schedulePortal).not.toContain("const dayNames");
  });

  it("🔑 البوابة محفوظة: جلسة الموظف + رسالة المنع + endpoints البوابة", () => {
    expect(todayPortal).toContain("trpc.employeePortal.todayShipments.useQuery");
    expect(todayPortal).toContain('setLocation("/employee-login")');
    expect(todayPortal).toContain("شحنات اليوم مش من مهامك");
    expect(schedulePortal).toContain("trpc.employeePortal.shippingRoutes.useQuery");
    expect(schedulePortal).toContain("جدول الشحن مش من مهامك");
  });
});

describe("🔑 التنقّل — بوابة الصلاحية = بوابة السيرفر", () => {
  const ops = PRIMARY_DESTINATIONS.find(d => d.key === "operations")!;

  it("🔑 شحنات اليوم/جدول الشحن خلف shipping_ops.view", () => {
    for (const path of ["/today-shipments", "/shipping-schedule"]) {
      expect(ops.children!.find(c => c.path === path)!.permission, path).toBe("shipping_ops.view");
    }
  });

  it("🔑 المالك/المدير (myPermissions فيها shipping_ops.view) يشوفوا التبويبات التلاتة", () => {
    const paths = visibleChildren(ops, true, ["shipping_ops.view"]).map(c => c.path);
    expect(paths).toEqual(["/preparation", "/today-shipments", "/shipping-schedule"]);
  });

  it("من غير الصلاحية: التجهيز بس (مفيش تبويب يطرد صاحبه)", () => {
    expect(visibleChildren(ops, true, []).map(c => c.path)).toEqual(["/preparation"]);
  });

  it("المسارات بتحلّ لوجهة التشغيل (active state + تبويبات الشل)", () => {
    for (const path of ["/preparation", "/today-shipments", "/shipping-schedule"]) {
      expect(activeDestinationKey(path), path).toBe("operations");
    }
  });
});
