// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({ user: null as any, loading: false, me: null as any, fetches: [] as string[], location: "/ledger" }));
vi.mock("@/_core/hooks/useAuth", () => ({ useAuth: () => ({ user: state.user, loading: state.loading }) }));
vi.mock("@/lib/trpc", () => ({ trpc: { employeePortal: { /* مدخل الرسائل في القشرة: العلم معطل (الافتراضي) */ messages: { status: { useQuery: () => ({ data: { enabled: false } }) }, conversations: { useQuery: () => ({ data: undefined, refetch: async () => ({}) }) } },  me: { useQuery: () => ({ data: state.me, isLoading: false }) } } } }));
vi.mock("@/components/DashboardLayout", () => ({ default: ({ children }: any) => <div data-testid="dashboard-layout">{children}</div> }));
vi.mock("wouter", () => ({
  Link: ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a>,
  useLocation: () => [state.location, (to: string) => { state.location = to; }],
}));
import LedgerLayout from "./LedgerLayout";

beforeEach(() => { state.user = null; state.loading = false; state.me = { id: 5, name: "محاسب V3", role: "accountant" }; state.fetches = []; state.location = "/ledger";
  (globalThis as any).fetch = vi.fn(async (url: string) => { state.fetches.push(url); return { ok: true } as any; }); });
afterEach(() => cleanup());

describe("🧭 LedgerLayout — المالك لوحة التحكم، المحاسب قشرة الموظف", () => {
  it("جلسة مالك (user موجود) → DashboardLayout كما هو، بلا قشرة الموظف", () => {
    state.user = { id: 1, role: "admin" };
    render(<LedgerLayout><p>المحتوى</p></LedgerLayout>);
    expect(screen.getByTestId("dashboard-layout").textContent).toContain("المحتوى");
    expect(screen.queryByTestId("ledger-employee-shell")).toBeNull();
  });
  it("جلسة موظف (user = null) → قشرة الدفتر: اسم الموظف، تبويبان، والمحتوى — لا «يرجى تسجيل الدخول»", () => {
    render(<LedgerLayout><p>المحتوى</p></LedgerLayout>);
    const shell = screen.getByTestId("ledger-employee-shell");
    expect(shell.textContent).toContain("المحتوى");
    expect(shell.textContent).not.toContain("يرجى تسجيل الدخول");
    expect(screen.getByTestId("ledger-shell-user").textContent).toBe("محاسب V3");
    expect(screen.getByTestId("ledger-tab-daily").getAttribute("href")).toBe("/ledger");
    expect(screen.getByTestId("ledger-tab-transactions").getAttribute("href")).toBe("/ledger/transactions");
    expect(screen.queryByTestId("dashboard-layout")).toBeNull();
  });
  it("خروج الموظف: يستدعي /api/employee/logout ثم يذهب لصفحة دخول الموظفين", async () => {
    render(<LedgerLayout><p>x</p></LedgerLayout>);
    fireEvent.click(screen.getByTestId("ledger-shell-logout"));
    await waitFor(() => expect(state.location).toBe("/employee-login"));
    expect(state.fetches).toEqual(["/api/employee/logout"]);
  });
  it("أثناء التحميل لا يُرندر شيء (لا وميض لقشرة خاطئة)", () => {
    state.loading = true;
    const { container } = render(<LedgerLayout><p>x</p></LedgerLayout>);
    expect(container.textContent).toBe("");
  });
});
