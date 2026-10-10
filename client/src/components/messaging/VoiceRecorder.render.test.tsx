// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { VoiceRecorder, uploadVoice } from "./VoiceRecorder";
import { HttpError } from "./messagingApi";

/** MediaRecorder/ميكروفون مزيّفان — التسجيل والمعاينة والإرسال مرة واحدة والتنظيف الكامل وحالات الإذن. */
const env = vi.hoisted(() => ({ tracks: [] as { stop: ReturnType<typeof vi.fn> }[], created: [] as string[], revoked: [] as string[], recorders: [] as any[] }));

class FakeRecorder {
  static isTypeSupported = (t: string) => t === "audio/webm;codecs=opus";
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_s: MediaStream, o?: { mimeType?: string }) { this.mimeType = o?.mimeType ?? "audio/webm"; env.recorders.push(this); }
  start() { this.state = "recording"; }
  stop() { if (this.state === "inactive") return; this.state = "inactive"; this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)], { type: this.mimeType }) }); this.onstop?.(); }
}
const stream = () => { const t = { stop: vi.fn() }; env.tracks.push(t); return { getTracks: () => [t] } as unknown as MediaStream; };

beforeEach(() => {
  env.tracks = []; env.created = []; env.revoked = []; env.recorders = [];
  (window as any).MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: vi.fn(async () => stream()) }, configurable: true });
  URL.createObjectURL = vi.fn(() => { const u = `blob:test/${env.created.length + 1}`; env.created.push(u); return u; });
  URL.revokeObjectURL = vi.fn((u: string) => { env.revoked.push(u); });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const ui = (p: any = {}) => render(<div className="relative"><VoiceRecorder via="portal" conversationId={7} disabled={false} onSent={() => {}} {...p} /></div>);
const startRec = async () => { await act(async () => { fireEvent.click(screen.getByTestId("voice-record")); }); };

describe("🎙️ التسجيل", () => {
  it("تسجيل → إيقاف → معاينة → إرسال **مرة واحدة** رغم الضغط المزدوج، ثم تحرير الرابط والميكروفون", async () => {
    let resolve!: (r: Response) => void;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>(r => { resolve = r; }));
    const onSent = vi.fn();
    ui({ onSent });
    await startRec();
    expect(screen.getByTestId("voice-recording").textContent).toContain("/ 5:00");
    await act(async () => { fireEvent.click(screen.getByTestId("voice-stop")); });
    expect(env.tracks[0].stop).toHaveBeenCalled(); // الميكروفون مُطفأ فور الإيقاف
    expect(screen.getByTestId("voice-preview")).toBeTruthy();
    expect(env.created).toHaveLength(1);
    await act(async () => { fireEvent.click(screen.getByTestId("voice-send")); fireEvent.click(screen.getByTestId("voice-send")); });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/messages/voice?via=portal");
    const fd = init.body as FormData;
    expect([...fd.keys()].sort()).toEqual(["conversationId", "durationMs", "file", "operationId"]); // لا tenantId/employeeId
    expect((fd.get("file") as File).name).toBe("voice.webm");
    await act(async () => { resolve(new Response(JSON.stringify({ messageId: 5, replay: false }), { status: 201 })); });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(env.revoked).toEqual(env.created);
    expect(screen.queryByTestId("voice-panel")).toBeNull();
  });

  it("فشل الرفع: رسالة عربية حسب الحالة، والإعادة بنفس operationId؛ الحذف يحرّر الرابط", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 503 }));
    ui();
    await startRec();
    await act(async () => { fireEvent.click(screen.getByTestId("voice-stop")); });
    await act(async () => { fireEvent.click(screen.getByTestId("voice-send")); });
    expect(screen.getByTestId("voice-upload-error").textContent).toContain("التخزين الدائم غير مضبوط");
    fetchSpy.mockResolvedValue(new Response("{}", { status: 413 }));
    await act(async () => { fireEvent.click(screen.getByTestId("voice-send")); });
    expect(screen.getByTestId("voice-upload-error").textContent).toContain("5 دقائق");
    const ids = fetchSpy.mock.calls.map(c => ((c[1] as RequestInit).body as FormData).get("operationId"));
    expect(ids[0]).toBe(ids[1]);
    fireEvent.click(screen.getByTestId("voice-discard"));
    expect(env.revoked).toEqual(env.created);
  });

  it("إيقاف تلقائي عند 5 دقائق", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    ui();
    await startRec();
    await act(async () => { vi.advanceTimersByTime(5 * 60 * 1000 + 400); });
    expect(env.recorders[0].state).toBe("inactive");
    expect(screen.getByTestId("voice-preview").textContent).toContain("5:00");
  });

  it("مغادرة الصفحة أثناء التسجيل أو بعده: الميكروفون مطفأ والرابط محرّر", async () => {
    const a = ui();
    await startRec();
    a.unmount();
    expect(env.tracks[0].stop).toHaveBeenCalled();
    const b = ui();
    await startRec();
    await act(async () => { fireEvent.click(screen.getByTestId("voice-stop")); });
    b.unmount();
    expect(env.revoked).toEqual(env.created);
  });

  it("رفض الميكروفون، وعدم وجوده، والمتصفح غير الداعم — رسائل واضحة", async () => {
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    ui();
    await startRec();
    expect(screen.getByTestId("voice-error").textContent).toContain("رفض الوصول للميكروفون");
    cleanup();
    (navigator.mediaDevices.getUserMedia as any).mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotFoundError" }));
    ui();
    await startRec();
    expect(screen.getByTestId("voice-error").textContent).toContain("لا يوجد ميكروفون");
    cleanup();
    delete (window as any).MediaRecorder;
    ui();
    await startRec();
    expect(screen.getByTestId("voice-error").textContent).toContain("لا يدعم التسجيل");
  });

  it("إلغاء أثناء انتظار إذن الميكروفون: يعود للوضع العادي، والإذن المتأخر يُغلق الميكروفون فورًا", async () => {
    let grant!: (s: MediaStream) => void;
    (navigator.mediaDevices.getUserMedia as any).mockImplementationOnce(() => new Promise<MediaStream>(r => { grant = r; }));
    ui();
    await startRec();
    fireEvent.click(screen.getByTestId("voice-cancel-request"));
    expect(screen.queryByTestId("voice-panel")).toBeNull();
    const late = stream();
    await act(async () => { grant(late); });
    expect(env.tracks.at(-1)!.stop).toHaveBeenCalled();
    expect(env.recorders).toHaveLength(0);
  });

  it("uploadVoice: الحالة غير 2xx = HttpError (لا ثقة في المدة — السيرفر يقيسها)", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 415 }));
    await expect(uploadVoice("web", { blob: new Blob(["x"], { type: "audio/ogg" }), conversationId: 1, durationMs: 1, operationId: "op12345678" }, f as any)).rejects.toBeInstanceOf(HttpError);
    const fd = (f.mock.calls[0] as any)[1].body as FormData;
    expect((fd.get("file") as File).name).toBe("voice.ogg");
    expect((f.mock.calls[0] as any)[0]).toBe("/api/messages/voice?via=web");
  });
});
