import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * تعديل الأوردر كان بيفتح بهيدر فاضي (اسم/موبايل/محافظة/عنوان) رغم إن التفاصيل فيها
 * البيانات. السبب: `editingOrder` كان بيتدوّر عليه في `data.orders` (القايمة الأساسية)
 * بس، بينما الجدول ممكن يكون معروض من مصدر تاني (تاب «مؤكدات اليوم» بيقرا من
 * `todayConfirmedData`) أو الأوردر في صفحة تانية/مفلتر — فالبحث بيرجّع null والهيدر يفضل
 * فاضي، بينما البنود بتتحمّل باستعلام مستقل بالـid (وده اللي كان بيبان أحيانًا).
 *
 * الإصلاح: نخزّن الصف الكامل اللي فُتح منه التعديل ونستخدمه مباشرة. كل استعلامات صفوف
 * الأوردرات (list و todayConfirmed) بترجع أعمدة العميل والشحن كاملة، فالكائن كافي.
 */

const orders = fs.readFileSync("client/src/pages/Orders.tsx", "utf-8");
const employeeDash = fs.readFileSync("client/src/pages/EmployeeDashboard.tsx", "utf-8");
const agentWorkspace = fs.readFileSync("client/src/pages/AgentWorkspace.tsx", "utf-8");

describe("🔑 تعديل الأوردر بيتعبّى من الصف المفتوح مش من القايمة الأساسية", () => {
  it("🔑 فيه حالة بتخزّن الصف الكامل عند فتح التعديل", () => {
    expect(orders).toContain("const [editOrderData, setEditOrderData]");
  });

  it("🔑 openEditFor بيخزّن الكائن نفسه مش الـid بس", () => {
    const fn = orders.slice(orders.indexOf("const openEditFor ="));
    const body = fn.slice(0, fn.indexOf("};") + 2);
    expect(body).toContain("setEditOrderData(order)");
    expect(body).toContain("setEditOrderId(order.id)");
  });

  it("🔑 editingOrder بيفضّل الكائن المخزّن قبل ما يدوّر في data.orders", () => {
    const idx = orders.indexOf("const editingOrder =");
    const expr = orders.slice(idx, orders.indexOf(";", idx));
    // الكائن المخزّن أولاً، والبحث في القايمة fallback بس
    expect(expr).toContain("editOrderData ??");
    expect(expr.indexOf("editOrderData")).toBeLessThan(expr.indexOf("data?.orders"));
  });

  it("🔑 الكائن بيتمسح عند قفل الديالوج (ما يفضلش عالق للأوردر اللي بعده)", () => {
    const idx = orders.indexOf("onOpenChange={open => { setShowEditDialog(open)");
    const line = orders.slice(idx, orders.indexOf("\n", idx));
    expect(line).toContain("setEditOrderData(null)");
    expect(line).toContain("setEditOrderId(null)");
  });
});

describe("🔑 السبب الجذري: الجدول ممكن يكون من مصدر غير data.orders", () => {
  it("تاب «مؤكدات اليوم» بيعرض من todayConfirmedData مش data.orders", () => {
    // ده اللي كان بيخلّي البحث في data.orders يرجّع null للصف المعروض.
    expect(orders).toContain("activeTab === 'today_confirmed'");
    expect(orders).toContain("todayConfirmedData?.orders");
  });
});

describe("🔑 نفس الإصلاح متطبّق على شاشتَي التأكيدات — عشان الـbug ميرجعش في مكان تاني", () => {
  it("🔑 EmployeeDashboard بيخزّن الصف ويفضّله قبل البحث في القايمة", () => {
    // editDialog بقى بيحمل data، والفتح بيخزّن order، والهيدر بيفضّلها.
    expect(employeeDash).toContain("data: any | null");
    expect(employeeDash).toContain("orderId: order.id, data: order");
    const idx = employeeDash.indexOf("const editingOrder =");
    const expr = employeeDash.slice(idx, employeeDash.indexOf(";", idx));
    expect(expr).toContain("editDialog.data ??");
    expect(expr.indexOf("editDialog.data")).toBeLessThan(expr.indexOf("ordersData?.orders"));
    // بيتمسح عند القفل
    expect(employeeDash).toContain("setEditDialog({ open: false, orderId: null, data: null })");
  });

  it("🔑 AgentWorkspace بيخزّن الصف ويفضّله قبل البحث في القايمة", () => {
    expect(agentWorkspace).toContain("const [editOrderData, setEditOrderData]");
    const idx = agentWorkspace.indexOf("const editingOrder =");
    const expr = agentWorkspace.slice(idx, agentWorkspace.indexOf(";", idx));
    expect(expr).toContain("editOrderData ??");
    expect(expr.indexOf("editOrderData")).toBeLessThan(expr.indexOf("orders.find"));
    // الفتح بيخزّن الكائن، والقفل بيمسحه
    expect(agentWorkspace).toContain("setEditOrderData(order)");
    expect(agentWorkspace).toContain("setEditOrderData(null)");
  });
});
