// @vitest-environment jsdom
/**
 * المرحلة 7F — صلاحيات الأدوار: الصلاحيات من السيرفر (الافتراضي + التخصيصات)، ما هو للمالك فقط مقفول
 * لغير super_admin، الحفظ بنفس الـpayload مع invalidate فوري لـauth.myPermissions، وحالة FORBIDDEN واضحة.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const st = vi.hoisted(() => ({ data: null as any, error: null as any, saves: [] as any[], invalidated: [] as string[] }));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ accountingV2: { permissionConfiguration: { invalidate: async () => { st.invalidated.push("config"); } } }, auth: { myPermissions: { invalidate: async () => { st.invalidated.push("myPermissions"); } } } }),
    accountingV2: {
      permissionConfiguration: { useQuery: () => ({ data: st.data, error: st.error, isLoading: false, refetch: vi.fn() }) },
      rolePermissionSave: { useMutation: (opts: any) => ({ mutate: async (input: any) => { st.saves.push(input); await opts.onSuccess?.(); }, isPending: false }) },
    },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
import { PermissionSettings } from "./PermissionSettings";

const CONFIG = {
  permissions: ["ledger.view", "ledger.post", "ledger.period.reopen", "ledger.activate", "orders.view"],
  roles: [
    { role: "accountant", defaultPermissions: ["ledger.view"] },
    { role: "super_admin", defaultPermissions: ["ledger.view", "ledger.post", "ledger.period.reopen", "ledger.activate", "orders.view"] },
  ],
  overrides: [{ role: "accountant", permission: "ledger.post", isAllowed: true }, { role: "accountant", permission: "ledger.period.reopen", isAllowed: true }],
};
beforeEach(() => { st.data = CONFIG; st.error = null; st.saves = []; st.invalidated = []; });
afterEach(() => cleanup());

const switchIn = (perm: string) => screen.getByTestId(`perm-${perm}`).querySelector('[role="switch"]') as HTMLButtonElement;

describe("🔐 صلاحيات الأدوار", () => {
  it("المحاسب: الافتراضي + التخصيص مفعّلان؛ reopen/activate مقفولان حتى مع override", () => {
    render(<PermissionSettings />);
    expect(switchIn("ledger.view").getAttribute("aria-checked")).toBe("true");
    expect(switchIn("ledger.post").getAttribute("aria-checked")).toBe("true");
    expect(switchIn("orders.view").getAttribute("aria-checked")).toBe("false");
    expect(switchIn("ledger.period.reopen").disabled).toBe(true);
    expect(switchIn("ledger.period.reopen").getAttribute("aria-checked")).toBe("false");
    expect(switchIn("ledger.activate").disabled).toBe(true);
  });
  it("المالك (super_admin): لا قفل، وكل الصلاحيات مفعّلة", () => {
    render(<PermissionSettings />);
    fireEvent.change(screen.getByTestId("perm-role"), { target: { value: "super_admin" } });
    expect(switchIn("ledger.period.reopen").disabled).toBe(false);
    expect(switchIn("ledger.period.reopen").getAttribute("aria-checked")).toBe("true");
  });
  it("التبديل يحفظ {role, permission, isAllowed} ثم يُبطل config و myPermissions فورًا", async () => {
    render(<PermissionSettings />);
    fireEvent.click(switchIn("orders.view"));
    await waitFor(() => expect(st.saves).toHaveLength(1));
    expect(st.saves[0]).toEqual({ role: "accountant", permission: "orders.view", isAllowed: true });
    await waitFor(() => expect(st.invalidated).toEqual(["config", "myPermissions"]));
  });
  it("FORBIDDEN → حالة رفض واضحة بلا مفاتيح", () => {
    st.data = undefined; st.error = { data: { code: "FORBIDDEN" }, message: "x" };
    render(<PermissionSettings />);
    expect(screen.getByText("لا تملك صلاحية الوصول")).toBeTruthy();
    expect(screen.queryByTestId("perm-role")).toBeNull();
  });
});
