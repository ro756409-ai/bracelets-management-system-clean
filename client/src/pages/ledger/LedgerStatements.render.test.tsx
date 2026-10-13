// @vitest-environment jsdom
/** قائمة الدخل والأرباح (المرحلة 7): الأرقام من السيرفر كما هي؛ رفض السيرفر (بلا صلاحية الأرباح) رسالة لا أصفار؛ غير الموزّع صريح. */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const state = vi.hoisted(() => ({ stmt: null as any, error: null as any }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    ledger: {
      status: { useQuery: () => ({ data: { tablesPresent: true, enabled: true } }) },
      reports: {
        incomeStatement: { useQuery: () => ({ data: state.error ? undefined : state.stmt, isLoading: false, error: state.error }) },
        profitByBusiness: { useQuery: () => ({ data: [{ businessId: 7, name: "براند A", revenue: { total: "800.0000" }, netProfit: "460.0000" }, { businessId: null, name: "مستوى الشركة (غير موزّع)", revenue: { total: "0.0000" }, netProfit: "-50.0000" }] }) },
        profitByProduct: { useQuery: () => ({ data: { products: [{ productId: 1, name: "أسورة", quantity: 2, revenue: "700.0000", cogs: "160.0000", grossProfit: "540.0000" }], unallocated: { orders: 1, revenue: "400.0000", cogs: "80.0000" } } }) },
        orderCost: { useQuery: () => ({ data: state.error ? undefined : { count: 2, totals: { revenue: "400.0000", cost: "20.0000", expenses: "95.6000", contribution: "284.4000" },
          orders: [{ orderId: 11, orderNumber: "A-11", revenue: "200.0000", cost: "10.0000", expenses: "45.6000", contribution: "144.4000", returned: false }, { orderId: 12, orderNumber: "A-12", revenue: "200.0000", cost: "10.0000", expenses: "50.0000", contribution: "140.0000", returned: true }] } }) },
      },
    },
  },
}));
import LedgerStatements from "./LedgerStatements";

beforeEach(() => {
  state.error = null;
  state.stmt = { from: "2026-10-01", to: "2026-10-31", revenue: { total: "1250.0000", lines: [{ code: "REVENUE", name: "إيرادات المبيعات", amount: "1200.0000" }, { code: "REV_SHIPPING", name: "إيراد شحن", amount: "50.0000" }] },
    cogs: "280.0000", grossProfit: "970.0000", expenses: { total: "270.0000", lines: [{ code: "RETURN_LOSS", name: "خسائر المرتجعات", amount: "70.0000" }] }, netProfit: "700.0000" };
});
afterEach(() => cleanup());

describe("📈 قائمة الدخل والأرباح", () => {
  it("البطاقات والقائمة والنشاط (غير الموزّع سطر صريح) والمنتج (غير القابل للتوزيع ملاحظة صريحة)", () => {
    render(<LedgerStatements />);
    const cards = screen.getByTestId("statements-cards").textContent ?? "";
    for (const v of ["١٬٢٥٠", "٢٨٠", "٩٧٠", "٧٠٠"]) expect(cards).toContain(v);
    expect(screen.getByTestId("statements-expense-RETURN_LOSS").textContent).toContain("خسائر المرتجعات");
    expect(screen.getByTestId("statements-business").textContent).toContain("مستوى الشركة (غير موزّع)");
    expect(screen.getByTestId("statements-unallocated").textContent).toContain("غير موزّع على المنتجات");
    // تكلفة الأوردرات: الإجماليات كما هي، وبيان صريح أن الإعلانات لا تُوزَّع، وعلامة المرتجع
    expect(screen.getByTestId("statements-order-cost").textContent).toContain("الإعلانات والمصروفات العامة لا تُوزَّع");
    expect(screen.getByTestId("order-cost-totals").textContent).toContain("٢٨٤");
    expect(screen.getByTestId("order-cost-12").textContent).toContain("↩");
  });
  it("رفض السيرفر (بلا صلاحية الأرباح) = رسالة، لا بطاقات ولا أصفار", () => {
    state.error = { message: "التقارير المالية للأرباح لمن يملك صلاحية «عرض الأرباح» فقط" };
    render(<LedgerStatements />);
    expect(screen.getByTestId("statements-error").textContent).toContain("عرض الأرباح");
    expect(screen.queryByTestId("statements-cards")).toBeNull();
  });
});
