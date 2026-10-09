// @vitest-environment jsdom
/**
 * المرحلة 7H — قنوات البيع: حالة الاتصال نصًا (متصل/غير متصل/خطأ)، الأسرار لا تظهر أبدًا (آخر 4 أحرف
 * فقط)، التحقق قبل الإرسال، الإضافة بحارس ضغط مكرر، الأرشفة بتأكيد، والسوق يعرض «مربوط» للمنصة النشطة.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

type Q = { data?: any; isLoading?: boolean };
const st = vi.hoisted(() => ({ q: {} as Record<string, Q>, mut: {} as Record<string, ReturnType<typeof vi.fn>> }));
const { mkQuery, mkMutation } = vi.hoisted(() => ({
  mkQuery: (key: string) => () => { const q = st.q[key] ?? {}; return { data: q.data, isLoading: q.isLoading ?? false, refetch: vi.fn() }; },
  mkMutation: (key: string) => () => { st.mut[key] ??= vi.fn(); return { mutate: st.mut[key], isPending: false }; },
}));
vi.mock("@/lib/trpc", () => ({
  trpc: {
    salesChannels: { list: { useQuery: mkQuery("list") }, syncLogs: { useQuery: mkQuery("logs") }, create: { useMutation: mkMutation("create") }, update: { useMutation: mkMutation("update") }, delete: { useMutation: mkMutation("delete") }, reactivate: { useMutation: mkMutation("reactivate") }, testConnection: { useMutation: mkMutation("test") }, clearSecret: { useMutation: mkMutation("clear") } },
    businesses: { activeList: { useQuery: mkQuery("biz") } },
    useUtils: () => ({}),
  },
}));
vi.mock("@/contexts/BusinessContext", () => ({ useBusinessContext: () => ({ currentBusinessIds: [1], currentBusinessId: 1, businesses: [{ id: 1, name: "براند A" }], setCurrentBusinessId: vi.fn(), activeBusiness: { id: 1, name: "براند A" } }) }));
vi.mock("@/hooks/useOnlineStatus", () => ({ useOnlineStatus: () => true }));
vi.mock("@/components/SetupJourney", () => ({ SetupJourney: () => <nav data-testid="setup-journey" /> }));
vi.mock("@/components/BostaConnectDialog", () => ({ BostaConnectDialog: ({ open }: any) => open ? <div data-testid="bosta-dialog" /> : null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/select", () => import("@/test-utils/selectMock"));

import SalesChannels from "./SalesChannels";

const CH = [
  { id: 1, name: "إيزي أوردر", platform: "easyorder", businessId: 1, isActive: true, domain: "https://shop.example", hasApiToken: true, apiTokenLast4: "AB12", hasWebhookSecret: true, webhookSecretLast4: "9Z8Y", lastConnectionStatus: "connected", lastConnectionTestAt: "2026-10-09T10:00:00Z", externalStoreName: "متجر النور" },
  { id: 2, name: "واتساب", platform: "whatsapp", businessId: 1, isActive: true, hasApiToken: false, hasWebhookSecret: false, lastConnectionStatus: "failed", lastConnectionError: "401 Unauthorized", lastSyncStatus: "never" },
  { id: 3, name: "قديمة", platform: "other", businessId: 1, isActive: false, hasApiToken: false, hasWebhookSecret: false, lastConnectionStatus: "never" },
];
beforeEach(() => {
  st.q = { list: { data: CH }, biz: { data: [{ id: 1, name: "براند A" }] }, logs: {} }; st.mut = {};
  (window as any).matchMedia = (q: string) => ({ matches: q.includes("min-width"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  (window as any).confirm = vi.fn(() => true);
});
afterEach(() => cleanup());

describe("🔌 قنوات البيع", () => {
  it("الحالة نصًا: متصل / خطأ في الاتصال / غير متصل؛ المؤرشف مخفي افتراضيًا ويظهر بالزر", () => {
    render(<SalesChannels />);
    expect(screen.getByTestId("channel-connection-1").textContent).toContain("متصل");
    expect(screen.getByTestId("channel-connection-2").textContent).toContain("خطأ في الاتصال");
    expect(screen.getByTestId("channel-connection-2").textContent).toContain("401 Unauthorized");
    expect(screen.queryByTestId("channel-card-3")).toBeNull();
    fireEvent.click(screen.getByTestId("channel-show-archived"));
    expect(screen.getByTestId("channel-card-3").textContent).toContain("مؤرشف");
    expect(screen.getByTestId("channel-connection-3").textContent).toContain("غير متصل");
  });
  it("الأسرار لا تظهر أبدًا: آخر 4 أحرف فقط على البطاقة، وحقل التعديل فارغ من نوع password", () => {
    render(<SalesChannels />);
    const card = screen.getByTestId("channel-card-1").textContent ?? "";
    expect(card).toContain("••••AB12"); expect(card).toContain("••••9Z8Y");
    fireEvent.click(screen.getByTestId("channel-edit-1"));
    const dlg = screen.getByTestId("channel-dialog");
    const pw = dlg.querySelectorAll('input[type="password"]') as NodeListOf<HTMLInputElement>;
    expect(pw).toHaveLength(2);
    expect(pw[0].value).toBe(""); expect(pw[1].value).toBe("");
    expect(pw[0].placeholder).toContain("محفوظ");
    expect(dlg.textContent).not.toContain("AB12X"); // لا قيمة كاملة في أي مكان
  });
  it("إضافة: التحقق (الاسم/النشاط/8 أحرف) ثم ضغطتان = طلب واحد بالـpayload نفسه", () => {
    render(<SalesChannels />);
    fireEvent.click(screen.getByTestId("channel-add"));
    fireEvent.click(screen.getByTestId("channel-save"));
    expect(st.mut.create).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("channel-field-name"), { target: { value: "متجري" } });
    const dlg = screen.getByTestId("channel-dialog");
    const pw = dlg.querySelectorAll('input[type="password"]') as NodeListOf<HTMLInputElement>;
    fireEvent.change(pw[1], { target: { value: "short" } });
    fireEvent.click(screen.getByTestId("channel-save"));
    expect(st.mut.create).not.toHaveBeenCalled(); // سر أقل من 8
    fireEvent.change(pw[1], { target: { value: "longsecret1" } });
    const save = screen.getByTestId("channel-save");
    fireEvent.click(save); fireEvent.click(save);
    expect(st.mut.create).toHaveBeenCalledTimes(1);
    expect(st.mut.create.mock.calls[0][0]).toEqual({ businessId: 1, name: "متجري", domain: undefined, platform: "other", apiToken: undefined, webhookSecret: "longsecret1" });
  });
  it("الأرشفة بتأكيد (إلغاء = لا طلب)، واختبار الاتصال مرة واحدة بالمعرّف", () => {
    (window as any).confirm = vi.fn(() => false);
    render(<SalesChannels />);
    fireEvent.click(screen.getByTestId("channel-archive-1"));
    expect(st.mut.delete).not.toHaveBeenCalled();
    (window as any).confirm = vi.fn(() => true);
    fireEvent.click(screen.getByTestId("channel-archive-1"));
    expect(st.mut.delete).toHaveBeenCalledTimes(1);
    expect(st.mut.delete.mock.calls[0][0]).toEqual({ id: 1 });
    const t = screen.getByTestId("channel-test-1");
    fireEvent.click(t); fireEvent.click(t);
    expect(st.mut.test).toHaveBeenCalledTimes(1);
    expect(st.mut.test.mock.calls[0][0]).toEqual({ id: 1 });
  });
  it("السوق: EasyOrder «مربوط» لأن له قناة نشطة؛ Bosta يفتح حواره الخاص", () => {
    render(<SalesChannels />);
    expect(screen.getByTestId("integration-easyorder").getAttribute("data-status")).toBe("connected");
    expect(screen.getByTestId("integration-bosta").getAttribute("data-status")).toBe("available");
    fireEvent.click(screen.getByTestId("integration-bosta").querySelector("button")!);
    expect(screen.getByTestId("bosta-dialog")).toBeTruthy();
  });
});
