// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/**
 * «وقت مسجّل خطأ» في «حضوري»: اختيار صريح لحدث من أحداث اليوم (لا تخمين ولا افتراضي) يُرسل targetEventId الحقيقي؛
 * حالات تحميل/فارغ؛ الإرسال معطّل حتى الاختيار؛ خيار الوردية الليلية باقٍ وغير محدد افتراضيًا.
 * سيناريو Staging: 2026-10-10 حضور 12:16 م وانصراف 12:19 م، والوقت الصحيح 12:30 م.
 */
const st = vi.hoisted(() => ({ events: [] as any[], loading: false, calls: [] as any[], queried: [] as any[] }));
const cairo = (hm: string) => Date.parse(`2026-10-10T${hm}:00+03:00`);
vi.mock("@/lib/trpc", () => ({
  trpc: {
    employeePortal: { /* مدخل الرسائل في القشرة: العلم معطل (الافتراضي) */ messages: { status: { useQuery: () => ({ data: { enabled: false } }) }, conversations: { useQuery: () => ({ data: undefined, refetch: async () => ({}) }) } }, 
      attendanceMine: { useQuery: () => ({ data: { enabled: true, days: [{ id: 1, workDate: "2026-10-10", timezone: "Africa/Cairo", status: "closed", firstInMs: cairo("12:16"), lastOutMs: cairo("12:19"), workedMinutes: 3 }], requests: [], open: null }, isLoading: false, isError: false }) },
      attendanceMyDayEvents: { useQuery: (input: any, opts: any) => { if (opts?.enabled) st.queried.push(input); return { data: opts?.enabled ? { enabled: true, timezone: "Africa/Cairo", events: st.events } : undefined, isLoading: !!opts?.enabled && st.loading, isError: false, refetch: vi.fn() }; } },
      attendanceClock: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      attendanceRequestCorrection: { useMutation: () => ({ mutate: (v: any) => st.calls.push(v), isPending: false }) },
      attendanceCancelRequest: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
      me: { useQuery: () => ({ data: { name: "منى" } }) },
    },
    useUtils: () => ({ employeePortal: { attendanceMine: { invalidate: vi.fn() } } }),
  },
}));
vi.mock("@/components/ui/select", () => import("@/test-utils/selectMock"));
vi.mock("wouter", () => ({ useLocation: () => ["/my-attendance", () => {}] }));
vi.mock("@/components/shared/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@shared/businessTime", async orig => ({ ...(await orig<any>()), businessDateKey: () => "2026-10-10" }));

import MyAttendance from "./MyAttendance";

const fill = () => {
  fireEvent.change(screen.getByLabelText("req-type"), { target: { value: "wrong_time" } });
  fireEvent.change(screen.getByLabelText("الوقت الصحيح"), { target: { value: "12:30" } });
  fireEvent.change(screen.getByLabelText("السبب"), { target: { value: "سجّلت الانصراف قبل موعده" } });
};
beforeEach(() => {
  st.events = [{ id: 501, eventType: "clock_in", atMs: cairo("12:16"), corrected: false }, { id: 502, eventType: "clock_out", atMs: cairo("12:19"), corrected: false }];
  st.loading = false; st.calls = []; st.queried = [];
  (window as any).matchMedia = (mq: string) => ({ matches: false, media: mq, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
});
afterEach(() => cleanup());

describe("🕒 «وقت مسجّل خطأ» — اختيار الحدث", () => {
  it("يعرض أحداث اليوم المحدد فقط بوقتها (حضور — 12:16 م، انصراف — 12:19 م) بلا اختيار افتراضي", () => {
    render(<MyAttendance />);
    fill();
    expect(st.queried.at(-1)).toEqual({ workDate: "2026-10-10" });
    expect(screen.getByTestId("req-target-501").textContent).toContain("حضور");
    expect(screen.getByTestId("req-target-501").textContent).toContain("12:16 م");
    expect(screen.getByTestId("req-target-502").textContent).toContain("انصراف");
    expect(screen.getByTestId("req-target-502").textContent).toContain("12:19 م");
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.every(r => !r.checked)).toBe(true);
    expect(screen.getByTestId("req-target-required")).toBeTruthy();
    expect((screen.getByTestId("request-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("بعد الاختيار يُرسل targetEventId الحقيقي والوقت الصحيح، والوردية الليلية غير محددة افتراضيًا", () => {
    render(<MyAttendance />);
    fill();
    const night = screen.getByRole("checkbox") as HTMLElement;
    expect(night.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getAllByRole("radio")[1]);
    const submit = screen.getByTestId("request-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(st.calls).toHaveLength(1);
    expect(st.calls[0]).toMatchObject({ workDate: "2026-10-10", requestType: "wrong_time", targetEventId: 502, requestedValue: { at: new Date(cairo("12:30")).toISOString() } });
  });

  it("تغيير اليوم أو النوع يُسقط الاختيار (لا يُرسل حدث يوم آخر)", () => {
    render(<MyAttendance />);
    fill();
    fireEvent.click(screen.getAllByRole("radio")[0]);
    fireEvent.change(screen.getByLabelText("اليوم"), { target: { value: "2026-10-09" } });
    expect((screen.getAllByRole("radio") as HTMLInputElement[]).every(r => !r.checked)).toBe(true);
    expect((screen.getByTestId("request-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("يوم بلا أحداث قابلة للتصحيح: حالة واضحة تقترح النوع المناسب، والإرسال معطّل", () => {
    st.events = [];
    render(<MyAttendance />);
    fill();
    expect(screen.getByTestId("req-target-empty").textContent).toContain("لا توجد أحداث مسجّلة قابلة للتصحيح");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect((screen.getByTestId("request-submit") as HTMLButtonElement).disabled).toBe(true);
  });

  it("أثناء التحميل: حالة تحميل واضحة", () => {
    st.loading = true;
    render(<MyAttendance />);
    fill();
    expect(screen.getByTestId("req-target-loading")).toBeTruthy();
  });

  it("الأنواع الأخرى لا تعرض اختيار الحدث ولا ترسل targetEventId", () => {
    render(<MyAttendance />);
    fireEvent.change(screen.getByLabelText("req-type"), { target: { value: "missing_clock_out" } });
    fireEvent.change(screen.getByLabelText("الوقت الصحيح"), { target: { value: "18:00" } });
    fireEvent.change(screen.getByLabelText("السبب"), { target: { value: "نسيت الانصراف" } });
    expect(screen.queryByTestId("req-target")).toBeNull();
    fireEvent.click(screen.getByTestId("request-submit"));
    expect(st.calls[0]).not.toHaveProperty("targetEventId");
  });
});
