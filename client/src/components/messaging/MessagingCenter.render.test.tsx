// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act, waitFor } from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";

/**
 * واجهة مركز الرسائل بـtRPC مزيّف: العلم، الصلاحيات لكل زر، جلسة المالك/الموظف/المدير/بلا صلاحية، وضع الاطلاع،
 * الإعلانات، القراءة فقط للشركة، الضغط المزدوج، الأخطاء العربية مع بقاء النص، النص العادي (لا HTML)، المحذوفة،
 * التحميل الأقدم، عدم إعادة تنزيل الصوت، وأهداف اللمس.
 */
type Perms = { use: boolean; voice: boolean; announce: boolean; manageGroups: boolean; viewPrivate: boolean };
const st = vi.hoisted(() => ({
  status: { enabled: true, permissions: { use: true, voice: false, announce: false, manageGroups: false, viewPrivate: false } as any },
  conversations: { enabled: true, conversations: [] as any[], unreadTotal: 0, monitor: [] as any[], canMonitor: false } as any,
  read: {} as Record<number, any>,
  readCalls: [] as any[],
  calls: { status: 0, conversations: 0 } as Record<string, number>,
  muts: {} as Record<string, any[]>,
  pending: {} as Record<string, boolean>,
  fail: {} as Record<string, unknown>,
  hold: {} as Record<string, boolean>,
  tenant: { readOnly: false, blocked: false },
  nav: [] as string[],
}));

function mk(name: string) {
  return {
    useMutation: () => ({
      isPending: st.pending[name] ?? false,
      isError: false,
      error: null,
      reset() {},
      mutate: (v: any, o?: any) => { (st.muts[name] ??= []).push(v); if (st.hold[name]) return; if (st.fail[name]) o?.onError?.(st.fail[name]); else { o?.onSuccess?.(name === "startDirect" || name === "createGroup" ? { conversationId: 99, replay: false } : { ok: true }); } o?.onSettled?.(); },
      mutateAsync: async (v: any) => { (st.muts[name] ??= []).push(v); if (st.fail[name]) throw st.fail[name]; return { messageId: 1000, replay: false }; },
    }),
  };
}
const q = (data: any, extra: any = {}) => ({ data, isLoading: false, error: null, refetch: vi.fn(async () => ({ data })), ...extra });
const api = vi.hoisted(() => ({} as any));
const utilsApi = vi.hoisted(() => ({} as any));

vi.mock("@/lib/trpc", () => {
  Object.assign(api, {
    status: { useQuery: () => { st.calls.status++; return q(st.status); } },
    conversations: { useQuery: (_i: any, o: any) => { if (o?.enabled === false) return q(undefined); st.calls.conversations++; return q(st.conversations); } },
    directory: { useQuery: () => q([{ id: 2, name: "منى", role: "agent", businessId: 1 }]) },
    history: { useQuery: () => q([]) },
    announcementReads: { useQuery: () => q({ acked: [], pending: [] }) },
    ...Object.fromEntries(["bootstrap", "send", "edit", "remove", "react", "ack", "markRead", "startDirect", "createGroup"].map(n => [n, mk(n)])),
  });
  Object.assign(utilsApi, {
    read: { fetch: async (input: any) => { st.readCalls.push(input); const r = st.read[input.conversationId]; if (!r) throw Object.assign(new TRPCClientError("x"), { data: { code: "NOT_FOUND" } }); return typeof r === "function" ? r(input) : r; } },
    history: { invalidate: () => {} },
  });
  return { trpc: { messages: api, employeePortal: { messages: api }, useUtils: () => ({ messages: utilsApi, employeePortal: { messages: utilsApi } }) } };
});
vi.mock("@/contexts/TenantAccessContext", () => ({ useTenantAccess: () => ({ enforced: st.tenant.readOnly || st.tenant.blocked, level: st.tenant.readOnly ? "read_only" : "full", reason: null, message: null, until: null, readOnly: st.tenant.readOnly, blocked: st.tenant.blocked }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/x", (to: string) => st.nav.push(to)], useRoute: () => [false, null] }));

import { MessagingCenter, CONVERSATION_LIST_POLL_MS } from "./MessagingCenter";
import { OPEN_CONVERSATION_POLL_MS } from "./useConversationThread";
import { MessagesEntryButton } from "./MessagesEntryButton";
import { messagingVoiceHooks } from "./voiceHooks";
import { audioController } from "./audioController";

const PERMS = (p: Partial<Perms> = {}): Perms => ({ use: true, voice: false, announce: false, manageGroups: false, viewPrivate: false, ...p });
const conv = (id: number, kind: string, p: any = {}) => ({ id, kind, businessId: null, title: null, peerEmployeeId: null, lastMessageId: null, lastMessageAt: null, unread: 0, last: null, ...p });
const msg = (id: number, p: any = {}) => ({ id, senderEmployeeId: 2, senderName: "منى", kind: "text", mine: false, title: null, body: `نص ${id}`, replyToMessageId: null, orderId: null, isPinned: false, editedAt: null, deletedAt: null, createdAt: Date.UTC(2026, 9, 10, 10, id % 60), attachments: [], reactions: [], listens: { count: 0, mine: false }, acks: { count: 0, mine: false }, ...p });
const page = (kind: string, messages: any[], p: any = {}) => ({ conversation: { id: 5, kind, title: kind === "group" ? "التغليف" : null, businessId: null }, readOnly: false, privacyNotice: null, messages, hasMore: false, lastReadMessageId: 0, ...p });
const center = (p: any = {}) => render(<MessagingCenter via="portal" conversationId={null} onOpen={id => st.nav.push(String(id))} desktopHeight="600px" {...p} />);
const trpcErr = (code: string, message = "x") => Object.assign(new TRPCClientError(message), { data: { code } });

beforeEach(() => {
  st.status = { enabled: true, permissions: PERMS() };
  st.conversations = { enabled: true, conversations: [conv(1, "announcement"), conv(2, "team", { unread: 3 }), conv(3, "group", { title: "التغليف" }), conv(5, "direct", { title: "منى" })], unreadTotal: 3, monitor: [], canMonitor: false };
  st.read = {}; st.readCalls = []; st.calls = { status: 0, conversations: 0 }; st.muts = {}; st.pending = {}; st.fail = {}; st.hold = {}; st.tenant = { readOnly: false, blocked: false }; st.nav = [];
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});
afterEach(() => { cleanup(); audioController.__reset(); vi.restoreAllMocks(); });

describe("🚦 العلم والصلاحية", () => {
  it("معدلات التحديث: المحادثة المفتوحة 4 ثوانٍ، والقائمة/زر الدخول 20 ثانية", () => {
    expect(OPEN_CONVERSATION_POLL_MS).toBe(4_000);
    expect(CONVERSATION_LIST_POLL_MS).toBe(20_000);
  });
  it("العلم معطّل: «غير متاح» بلا أي طلب غير status، وزر الدخول لا يُرسم", () => {
    st.status = { enabled: false, permissions: PERMS() };
    center();
    expect(screen.getByTestId("messaging-unavailable").textContent).toContain("غير متاح");
    expect(st.calls.conversations).toBe(0);
    expect(st.muts.bootstrap).toBeUndefined();
    cleanup();
    render(<MessagesEntryButton via="web" />);
    expect(screen.queryByTestId("messages-entry")).toBeNull();
    expect(st.calls.conversations).toBe(0);
  });
  it("بلا messages.use: رفض واضح بلا قائمة ولا زر دخول", () => {
    st.status = { enabled: true, permissions: PERMS({ use: false }) };
    center();
    expect(screen.getByText(/ليست لديك صلاحية استخدام الرسائل/)).toBeTruthy();
    expect(st.calls.conversations).toBe(0);
    cleanup();
    render(<MessagesEntryButton via="portal" />);
    expect(screen.queryByTestId("messages-entry")).toBeNull();
  });
  it("زر الدخول: عدد غير المقروء", () => {
    render(<MessagesEntryButton via="web" />);
    expect(screen.getByTestId("messages-unread").textContent).toBe("3");
    expect(screen.getByTestId("messages-entry").getAttribute("aria-label")).toContain("3 غير مقروءة");
  });
});

describe("📋 القائمة والأزرار حسب الصلاحية", () => {
  it("موظف عادي: القنوات/المجموعات/الخاص، «محادثة جديدة» بلا «مجموعة جديدة»، وbootstrap مرة واحدة", () => {
    center();
    expect(screen.getByText("القنوات")).toBeTruthy(); expect(screen.getByText("المجموعات")).toBeTruthy(); expect(screen.getByText("الخاص")).toBeTruthy();
    expect(screen.getByTestId("new-direct")).toBeTruthy();
    expect(screen.queryByTestId("new-group")).toBeNull();
    expect(screen.getByTestId("unread-2").textContent).toBe("3");
    expect(st.muts.bootstrap).toHaveLength(1);
  });
  it("مدير (manage_groups): «مجموعة جديدة» ظاهرة", () => {
    st.status = { enabled: true, permissions: PERMS({ manageGroups: true, announce: true }) };
    center();
    expect(screen.getByTestId("new-group")).toBeTruthy();
  });
  it("مالك بمنح الاطلاع: قسم «اطلاع المالك — قراءة فقط ومسجَّل»", () => {
    st.status = { enabled: true, permissions: PERMS({ viewPrivate: true }) };
    st.conversations = { ...st.conversations, monitor: [{ id: 40, kind: "direct", title: null, participants: ["أحمد", "منى"], lastMessageAt: null }], canMonitor: true };
    center();
    expect(screen.getByTestId("monitor-section").textContent).toContain("قراءة فقط");
    fireEvent.click(screen.getByTestId("monitor-40"));
    expect(st.nav).toContain("40");
  });
  it("وضع القراءة فقط للشركة: لا bootstrap وأزرار الإنشاء معطّلة", () => {
    st.tenant = { readOnly: true, blocked: false };
    center();
    expect(st.muts.bootstrap).toBeUndefined();
    expect((screen.getByTestId("new-direct") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("💬 المحادثة", () => {
  it("نص عادي فقط (لا HTML)، والمحذوفة بلا محتوى، وفاصل «رسائل جديدة»", async () => {
    st.read[5] = page("direct", [msg(10, { mine: true, senderEmployeeId: 1 }), msg(11, { body: '<img src=x onerror="alert(1)">' }), msg(12, { deletedAt: 1, body: null })], { lastReadMessageId: 10, privacyNotice: "سياسة الرسائل: …" });
    center({ conversationId: 5 });
    await screen.findByTestId("message-11");
    expect(screen.getByTestId("message-11").textContent).toContain('<img src=x onerror="alert(1)">');
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByTestId("deleted-12").textContent).toBe("تم حذف هذه الرسالة");
    expect(screen.getByTestId("unread-divider")).toBeTruthy();
    expect(screen.getByTestId("privacy-notice").textContent).toContain("سياسة الرسائل");
  });

  it("Enter يرسل وShift+Enter لا؛ الضغط المزدوج يرسل مرة؛ المدخلات بلا tenantId/employeeId", async () => {
    st.read[5] = page("team", [msg(10)]);
    center({ conversationId: 5 });
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "سطر" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(st.muts.send).toBeUndefined();
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); fireEvent.click(screen.getByTestId("composer-send")); });
    expect(st.muts.send).toHaveLength(1);
    const sent = st.muts.send[0];
    expect(sent).toMatchObject({ conversationId: 5, body: "سطر" });
    expect(Object.keys(sent).sort()).toEqual(["body", "conversationId", "idempotencyKey"]);
    expect(sent.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });

  it("فشل الإرسال: رسالة عربية، يبقى النص، وإعادة الإرسال بنفس المعرّف؛ تغيير النص = معرّف جديد", async () => {
    st.read[5] = page("team", [msg(10)]);
    st.fail.send = trpcErr("CONFLICT");
    center({ conversationId: 5 });
    const input = await screen.findByTestId("composer-input");
    fireEvent.change(input, { target: { value: "مهم" } });
    await act(async () => { fireEvent.click(screen.getByTestId("composer-send")); });
    expect(screen.getByTestId("composer-error").textContent).toContain("أُرسلت من قبل");
    expect((input as HTMLTextAreaElement).value).toBe("مهم");
    await act(async () => { fireEvent.click(screen.getByTestId("composer-retry")); });
    expect(st.muts.send[1].idempotencyKey).toBe(st.muts.send[0].idempotencyKey);
    fireEvent.change(input, { target: { value: "مهم جدًا" } });
    await act(async () => { fireEvent.click(screen.getByTestId("composer-send")); });
    expect(st.muts.send[2].idempotencyKey).not.toBe(st.muts.send[0].idempotencyKey);
    for (const [code, text] of [["FORBIDDEN", "صلاحية"], ["NOT_FOUND", "غير موجودة"], ["UNAUTHORIZED", "انتهت الجلسة"]] as const) {
      st.fail.send = trpcErr(code);
      await act(async () => { fireEvent.click(screen.getByTestId("composer-send")); });
      expect(screen.getByTestId("composer-error").textContent).toContain(text);
    }
  });

  it("أثناء الإرسال: الأزرار والكتابة معطّلة", async () => {
    st.read[5] = page("team", [msg(10)]);
    st.pending.send = true;
    center({ conversationId: 5 });
    expect(((await screen.findByTestId("composer-input")) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByTestId("composer-send") as HTMLButtonElement).disabled).toBe(true);
  });

  it("وضع اطلاع المالك: قراءة فقط بوضوح — لا كتابة ولا قائمة تفاعل ولا علامة قراءة", async () => {
    st.status = { enabled: true, permissions: PERMS({ viewPrivate: true }) };
    st.read[5] = page("direct", [msg(10), msg(11, { editedAt: 5 })], { readOnly: true, privacyNotice: "سياسة الرسائل" });
    center({ conversationId: 5 });
    await screen.findByTestId("message-10");
    expect(screen.getByTestId("readonly-badge").textContent).toContain("قراءة فقط");
    expect(screen.getByTestId("composer-disabled").textContent).toContain("وضع الاطلاع");
    expect(screen.queryByTestId("composer")).toBeNull();
    expect(screen.queryByTestId("menu-10")).toBeNull(); // لا رد/تفاعل/تعديل/حذف
    expect(screen.getByTestId("menu-11")).toBeTruthy(); // السجل فقط
    expect(screen.getByTestId("privacy-notice").textContent).toContain("هذا الاطلاع مسجَّل");
    expect(st.muts.markRead).toBeUndefined();
  });

  it("الإعلانات: بلا announce = قراءة فقط و«اطّلعت»؛ مع announce = عنوان + إحصائية", async () => {
    st.read[5] = page("announcement", [msg(10, { kind: "announcement", title: "اجتماع", isPinned: true })]);
    center({ conversationId: 5 });
    expect((await screen.findByTestId("composer-disabled")).textContent).toContain("الإعلانات للقراءة");
    expect(screen.queryByTestId("reads-10")).toBeNull();
    fireEvent.click(screen.getByTestId("ack-10"));
    expect(st.muts.ack).toEqual([{ messageId: 10 }]);
    cleanup();
    st.status = { enabled: true, permissions: PERMS({ announce: true }) };
    center({ conversationId: 5 });
    expect(await screen.findByTestId("composer-title")).toBeTruthy();
    expect(screen.getByTestId("reads-10")).toBeTruthy();
  });

  it("القراءة فقط للشركة: لا كتابة", async () => {
    st.tenant = { readOnly: true, blocked: false };
    st.read[5] = page("team", [msg(10)]);
    center({ conversationId: 5 });
    expect((await screen.findByTestId("composer-disabled")).textContent).toContain("القراءة فقط");
  });

  it("الرسائل الأقدم: beforeId من أقدم رسالة، والجديدة أثناء التحميل لا تضيع", async () => {
    st.read[5] = (input: any) => input.beforeId ? page("team", [msg(1), msg(2)], { hasMore: false }) : page("team", [msg(10), msg(11)], { hasMore: true });
    center({ conversationId: 5 });
    fireEvent.click(await screen.findByTestId("load-older"));
    await screen.findByTestId("message-1");
    expect(st.readCalls.at(-1)).toEqual({ conversationId: 5, beforeId: 10 });
    expect(["message-1", "message-2", "message-10", "message-11"].every(id => screen.queryByTestId(id))).toBe(true);
  });

  it("الصوت: لا تنزيل مع إعادة الرسم أو التحديث — المصدر يُضبط عند التشغيل فقط ومرة لكل رسالة", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
    const voice = msg(20, { kind: "voice", body: null, attachments: [{ kind: "voice", mime: "audio/webm", bytes: 9000, width: null, height: null, durationMs: 12_000, waveform: [0.2, 0.9], purged: false }] });
    st.read[5] = page("direct", [voice]);
    const v = center({ conversationId: 5, voice: messagingVoiceHooks });
    await screen.findByTestId("voice-20");
    v.rerender(<MessagingCenter via="portal" conversationId={5} onOpen={() => {}} desktopHeight="600px" voice={messagingVoiceHooks} />);
    expect(audioController.__srcSets()).toBe(0);
    expect(document.querySelectorAll("audio").length).toBe(0); // لا عنصر audio داخل الفقاعات
    fireEvent.click(screen.getByTestId("voice-play-20"));
    fireEvent.click(screen.getByTestId("voice-play-20"));
    fireEvent.click(screen.getByTestId("voice-play-20"));
    expect(audioController.__srcSets()).toBe(1);
    expect(play).toHaveBeenCalled();
    cleanup(); // مغادرة المحادثة توقف الصوت
    expect(audioController.getState().currentId).toBeNull();
  });

  it("الصوت المنتهي (6 أشهر) واضح، وزر التسجيل فقط مع messages.voice", async () => {
    st.read[5] = page("direct", [msg(20, { kind: "voice", body: null, attachments: [{ kind: "voice", mime: "audio/webm", bytes: 1, width: null, height: null, durationMs: 1000, waveform: null, purged: true }] })]);
    center({ conversationId: 5, voice: messagingVoiceHooks });
    expect((await screen.findByTestId("voice-expired-20")).textContent).toContain("6 أشهر");
    expect(screen.queryByTestId("voice-record")).toBeNull();
    cleanup();
    st.status = { enabled: true, permissions: PERMS({ voice: true }) };
    center({ conversationId: 5, voice: messagingVoiceHooks });
    expect(await screen.findByTestId("voice-record")).toBeTruthy();
  });

  it("الضغط المزدوج: إنشاء المجموعة طلب واحد بـoperationId، والتفاعل لا يُلغى بنقرتين", async () => {
    st.status = { enabled: true, permissions: PERMS({ manageGroups: true }) };
    st.hold = { createGroup: true, react: true };
    st.read[5] = page("team", [msg(10, { reactions: [{ reaction: "like", count: 2, mine: false }] })]);
    center({ conversationId: 5 });
    fireEvent.click(await screen.findByTestId("new-group"));
    fireEvent.change(await screen.findByTestId("group-title"), { target: { value: "التغليف" } });
    fireEvent.click(screen.getByTestId("directory-2"));
    fireEvent.click(screen.getByTestId("create-group")); fireEvent.click(screen.getByTestId("create-group"));
    expect(st.muts.createGroup).toHaveLength(1);
    expect(st.muts.createGroup[0]).toMatchObject({ title: "التغليف", memberIds: [2] });
    expect(st.muts.createGroup[0].operationId).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(Object.keys(st.muts.createGroup[0]).sort()).toEqual(["memberIds", "operationId", "title"]);
    const chip = screen.getByRole("button", { name: /إعجاب: 2/ });
    fireEvent.click(chip); fireEvent.click(chip);
    expect(st.muts.react).toEqual([{ messageId: 10, reaction: "like" }]);
  });

  it("تغيّر ارتفاع المحتوى (تحميل الخط/تكبير النص): من في الأسفل يبقى في الأسفل، ومن يقرأ القديم لا يُحرَّك", async () => {
    const observers: (() => void)[] = [];
    (globalThis as any).ResizeObserver = class { constructor(cb: () => void) { observers.push(cb); } observe() {} disconnect() {} };
    st.read[5] = page("team", [msg(10), msg(11)]);
    center({ conversationId: 5 });
    const sc = await screen.findByTestId("message-scroll");
    let height = 1000;
    Object.defineProperty(sc, "scrollHeight", { configurable: true, get: () => height });
    Object.defineProperty(sc, "clientHeight", { configurable: true, get: () => 400 });
    sc.scrollTop = 600; fireEvent.scroll(sc); // في الأسفل
    height = 1600; act(() => observers.forEach(cb => cb()));
    expect(sc.scrollTop).toBe(1600);
    sc.scrollTop = 100; fireEvent.scroll(sc); // صعد يقرأ القديم
    height = 2000; act(() => observers.forEach(cb => cb()));
    expect(sc.scrollTop).toBe(100);
    expect(getComputedStyle(sc).overflowAnchor === "none" || sc.className.includes("[overflow-anchor:none]")).toBe(true);
    delete (globalThis as any).ResizeObserver;
  });

  it("«تمت القراءة»: في الخاص فقط، على رسالة واحدة، وتتحدث مع الـPolling بلا إعادة تنزيل الصوت؛ لا في الاطلاع ولا المجموعات", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    const voice = msg(13, { mine: true, senderEmployeeId: 1, kind: "voice", body: null, attachments: [{ kind: "voice", mime: "audio/webm", bytes: 9, width: null, height: null, durationMs: 3000, waveform: null, purged: false }] });
    let peer: number | null = null;
    st.read[5] = () => page("direct", [msg(10, { mine: true, senderEmployeeId: 1 }), msg(11), msg(12, { mine: true, senderEmployeeId: 1, editedAt: 5 }), voice], { peerLastReadMessageId: peer });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    center({ conversationId: 5, voice: messagingVoiceHooks });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.queryAllByTestId(/^read-receipt-/)).toHaveLength(0); // وصلت فقط
    peer = 12; // الطرف الآخر قرأ حتى 12
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); }); // Polling عادي
    expect(screen.queryAllByTestId(/^read-receipt-/).map(e => e.getAttribute("data-testid"))).toEqual(["read-receipt-12"]);
    peer = 13;
    await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
    expect(screen.queryAllByTestId(/^read-receipt-/).map(e => e.getAttribute("data-testid"))).toEqual(["read-receipt-13"]);
    expect(audioController.__srcSets()).toBe(0); // التحديث لم ينزّل الصوت
    vi.useRealTimers();
    cleanup();
    // وضع الاطلاع والمجموعات: لا علامة حتى لو وصل مؤشر
    st.read[5] = page("direct", [msg(10, { mine: true })], { readOnly: true, peerLastReadMessageId: 99 });
    center({ conversationId: 5 });
    await screen.findByTestId("message-10");
    expect(screen.queryAllByTestId(/^read-receipt-/)).toHaveLength(0);
    cleanup();
    st.read[5] = page("group", [msg(10, { mine: true })], { peerLastReadMessageId: 99 });
    center({ conversationId: 5 });
    await screen.findByTestId("message-10");
    expect(screen.queryAllByTestId(/^read-receipt-/)).toHaveLength(0);
  });

  it("أهداف اللمس: كل زر في المركز ≥ 44px (min-h-11/12/14 أو h-11)", async () => {
    st.status = { enabled: true, permissions: PERMS({ voice: true, manageGroups: true, announce: true }) };
    st.read[5] = page("team", [msg(10, { mine: true, editedAt: 1, reactions: [{ reaction: "like", count: 1, mine: true }] }), msg(11)], { hasMore: true });
    center({ conversationId: 5, voice: messagingVoiceHooks });
    await screen.findByTestId("message-11");
    const small = [...document.querySelectorAll("[data-testid=messaging-center] button")].filter(b => !/(^|\s)(md:)?(min-h-(11|12|14)|h-11)\b|min-h-\[56px\]/.test(b.className));
    expect(small.map(b => b.getAttribute("data-testid") ?? b.textContent)).toEqual([]);
  });
});
