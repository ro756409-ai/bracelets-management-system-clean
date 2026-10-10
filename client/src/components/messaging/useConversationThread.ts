import { useCallback, useEffect, useRef, useState } from "react";
import { MESSAGING_LIMITS } from "@shared/messagingSpec";
import { errorCode, useMessagingUtils, type ChatMessage, type MessagingVia, type ReadResult } from "./messagingApi";
import { maxId, mergeById, mergeLatestPage, minId } from "./messageStore";
import { usePoller } from "./pollScheduler";

export const OPEN_CONVERSATION_POLL_MS = 4_000;
const MAX_GAP_FILL_PAGES = 5;

export type ThreadState = {
  status: "loading" | "ready" | "error" | "denied" | "notfound";
  error: unknown;
  meta: Omit<ReadResult, "messages" | "hasMore"> | null;
  messages: ChatMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  /** يزيد مع كل دمج جديد — لقرار التحريك في العرض. */
  version: number;
  firstLoadVersion: number;
};

const EMPTY: ThreadState = { status: "loading", error: null, meta: null, messages: [], hasOlder: false, loadingOlder: false, version: 0, firstLoadVersion: -1 };

/**
 * حالة المحادثة المفتوحة: أول صفحة، ثم تحديث كل 4 ثوانٍ (بلا تداخل، متوقف والصفحة مخفية/Offline، Backoff
 * عند الخطأ)، وصفحات أقدم عند الطلب، وملء أي فجوة. نتائج محادثة سابقة تُهمل (تبديل سريع بين المحادثات).
 */
export function useConversationThread(via: MessagingVia, conversationId: number | null) {
  const utils = useMessagingUtils(via);
  const [state, setState] = useState<ThreadState>(EMPTY);
  const stateRef = useRef(state);
  stateRef.current = state;
  const generation = useRef(0);

  const fetchPage = useCallback(
    (input: { conversationId: number; beforeId?: number; afterId?: number; limit?: number }) => utils.read.fetch(input, { staleTime: 0, gcTime: 0 }),
    [utils],
  );

  // أول تحميل عند تغيير المحادثة
  useEffect(() => {
    const gen = ++generation.current;
    if (conversationId == null) { setState(EMPTY); return; }
    setState({ ...EMPTY });
    fetchPage({ conversationId })
      .then(res => {
        if (gen !== generation.current) return;
        const { messages, hasMore, ...meta } = res;
        setState(s => ({ ...s, status: "ready", error: null, meta, messages: mergeById([], messages), hasOlder: hasMore, version: s.version + 1, firstLoadVersion: s.version + 1 }));
      })
      .catch(err => {
        if (gen !== generation.current) return;
        const code = errorCode(err);
        setState(s => ({ ...s, status: code === "FORBIDDEN" ? "denied" : code === "NOT_FOUND" ? "notfound" : "error", error: err }));
      });
  }, [conversationId, fetchPage]);

  /** تحديث: أحدث صفحة + ملء الفجوة. يرمي عند الخطأ (لـBackoff الجدولة). */
  const refresh = useCallback(async () => {
    const gen = generation.current;
    if (conversationId == null || stateRef.current.status !== "ready") return;
    const latest = await fetchPage({ conversationId });
    if (gen !== generation.current) return;
    let { messages, gapAfter } = mergeLatestPage(stateRef.current.messages, latest.messages, latest.hasMore);
    for (let i = 0; gapAfter != null && i < MAX_GAP_FILL_PAGES; i++) {
      const fill = await fetchPage({ conversationId, afterId: gapAfter, limit: MESSAGING_LIMITS.pageSize });
      if (gen !== generation.current) return;
      messages = mergeById(messages, fill.messages);
      gapAfter = fill.hasMore && fill.messages.length ? maxId(fill.messages) : null;
    }
    const { messages: _m, hasMore: _h, ...meta } = latest;
    setState(s => (gen !== generation.current ? s : { ...s, meta, messages: mergeById(s.messages, messages), version: s.version + 1 }));
  }, [conversationId, fetchPage]);

  const poller = usePoller(refresh, { enabled: conversationId != null && state.status === "ready", intervalMs: OPEN_CONVERSATION_POLL_MS });

  /** الصفحة الأقدم — لا تحمّل مرتين بالتوازي، ولا تمس ما وصل أثناء التحميل. */
  const loadOlder = useCallback(async () => {
    const s = stateRef.current;
    if (conversationId == null || s.loadingOlder || !s.hasOlder || !s.messages.length) return;
    const gen = generation.current;
    setState(x => ({ ...x, loadingOlder: true }));
    try {
      const older = await fetchPage({ conversationId, beforeId: minId(s.messages) });
      if (gen !== generation.current) return;
      setState(x => ({ ...x, loadingOlder: false, hasOlder: older.hasMore, messages: mergeById(x.messages, older.messages) }));
    } catch (err) {
      if (gen === generation.current) setState(x => ({ ...x, loadingOlder: false, error: err }));
    }
  }, [conversationId, fetchPage]);

  const retry = useCallback(() => {
    if (conversationId == null) return;
    const gen = ++generation.current;
    setState({ ...EMPTY });
    fetchPage({ conversationId })
      .then(res => {
        if (gen !== generation.current) return;
        const { messages, hasMore, ...meta } = res;
        setState(s => ({ ...s, status: "ready", meta, messages: mergeById([], messages), hasOlder: hasMore, version: 1, firstLoadVersion: 1 }));
      })
      .catch(err => { if (gen === generation.current) setState(s => ({ ...s, status: "error", error: err })); });
  }, [conversationId, fetchPage]);

  return { ...state, loadOlder, refreshNow: poller.trigger, retry };
}
