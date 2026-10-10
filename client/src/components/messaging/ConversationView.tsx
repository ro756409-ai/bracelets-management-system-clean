import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, Eye, ShieldAlert } from "lucide-react";
import type { Reaction } from "@shared/messagingSpec";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, LoadingSkeleton } from "@/components/shared";
import { useTenantAccess } from "@/contexts/TenantAccessContext";
import { READ_ONLY_MESSAGE } from "@/lib/tenantReadOnly";
import { cn } from "@/lib/utils";
import { Composer, type ComposerMode, type SendPayload } from "./Composer";
import { MessageBubble, type BubbleActions } from "./MessageBubble";
import { HistoryDialog, ReadsDialog } from "./MessagingDialogs";
import { MessagingError } from "./MessagingStates";
import { conversationTitle, KIND_LABEL, useOnline } from "./format";
import { isNearBottom, maxId, minId, readReceiptMessageId, shouldStickToBottom } from "./messageStore";
import { messagingErrorText, useMessagingApi, useMessagingUtils, type ChatMessage, type MessagingStatus, type MessagingVia } from "./messagingApi";
import { useConversationThread } from "./useConversationThread";

export type VoiceHooks = {
  /** مشغّل الرسالة الصوتية (مذكّر — لا يُعاد تنزيل الملف مع كل تحديث). */
  renderPlayer: (m: ChatMessage, conversationId: number) => ReactNode;
  /** زر التسجيل في شريط الكتابة (أو null لمن لا يملك messages.voice). */
  renderRecorder: (ctx: { conversationId: number; replyToMessageId?: number; disabled: boolean; onSent: () => void }) => ReactNode;
};

export function ConversationView(props: {
  via: MessagingVia;
  conversationId: number;
  permissions: MessagingStatus["permissions"];
  onBack: () => void;
  onListChanged: () => void;
  /** عنوان من صف القائمة (أسماء أطراف الخاص/الاطلاع) — المسار المفتوح لا يعيد الأسماء. */
  titleHint?: string | null;
  voice?: VoiceHooks;
}) {
  const { via, conversationId, permissions } = props;
  const api = useMessagingApi(via);
  const utils = useMessagingUtils(via);
  const thread = useConversationThread(via, conversationId);
  const tenant = useTenantAccess();
  const online = useOnline();

  const send = api.send.useMutation();
  const edit = api.edit.useMutation();
  const remove = api.remove.useMutation();
  const react = api.react.useMutation();
  const ack = api.ack.useMutation();
  const markRead = api.markRead.useMutation();

  const [mode, setMode] = useState<ComposerMode>({ type: "new" });
  const [sendError, setSendError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<number | null>(null);
  const [readsId, setReadsId] = useState<number | null>(null);
  const [toDelete, setToDelete] = useState<ChatMessage | null>(null);

  // تغيير المحادثة = مسودة/أوضاع جديدة
  useEffect(() => { setMode({ type: "new" }); setSendError(null); setActionError(null); }, [conversationId]);

  const meta = thread.meta;
  const conv = meta?.conversation;
  const readOnly = Boolean(meta?.readOnly);
  const isAnnouncement = conv?.kind === "announcement";
  const tenantReadOnly = tenant.readOnly || tenant.blocked;

  const disabledReason = readOnly
    ? "وضع الاطلاع — قراءة فقط. لا يمكنك الكتابة أو التفاعل في هذه المحادثة."
    : tenantReadOnly
      ? READ_ONLY_MESSAGE
      : isAnnouncement && !permissions.announce
        ? "الإعلانات للقراءة — النشر لأصحاب صلاحية الإعلانات."
        : !online
          ? "لا يوجد اتصال — الإرسال متوقف حتى يعود الاتصال."
          : null;
  const interactive = !readOnly && !tenantReadOnly;

  // ── التحريك ──
  const scrollRef = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const sentByMe = useRef(false);
  const prev = useRef({ height: 0, firstId: 0, lastId: 0, conv: 0 });
  const [showJump, setShowJump] = useState(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || thread.status !== "ready") return;
    const firstId = minId(thread.messages), lastId = maxId(thread.messages);
    const p = prev.current;
    const firstLoad = p.conv !== conversationId;
    if (!firstLoad && firstId < p.firstId && lastId === p.lastId) {
      el.scrollTop += el.scrollHeight - p.height; // صفحة أقدم: احفظ موضع القراءة
    } else if (shouldStickToBottom({ firstLoad, nearBottom: nearBottom.current, sentByMe: sentByMe.current })) {
      el.scrollTop = el.scrollHeight;
      nearBottom.current = true;
      setShowJump(false);
    } else if (lastId > p.lastId) {
      setShowJump(true); // رسائل جديدة والمستخدم يقرأ القديم — لا نحرّكه
    }
    sentByMe.current = false;
    prev.current = { height: el.scrollHeight, firstId, lastId, conv: conversationId };
  }, [thread.version, thread.messages, thread.status, conversationId]);

  // تغيّر ارتفاع المحتوى بعد الرسم (تحميل الخط، تكبير النص، صورة/موجة): من كان في الأسفل يبقى في الأسفل.
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current, content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (nearBottom.current) el.scrollTop = el.scrollHeight;
      prev.current.height = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [thread.status]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottom.current = isNearBottom(el);
    if (nearBottom.current) setShowJump(false);
    prev.current.height = el.scrollHeight;
  };
  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    nearBottom.current = true;
    setShowJump(false);
  };

  // ── علامة القراءة (ليست للمطّلع، ولا في وضع القراءة فقط للشركة) ──
  const lastMarked = useRef<{ conv: number; id: number }>({ conv: 0, id: 0 });
  const lastId = maxId(thread.messages);
  useEffect(() => {
    if (!interactive || thread.status !== "ready" || !lastId || !nearBottom.current) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    const base = lastMarked.current.conv === conversationId ? lastMarked.current.id : meta?.lastReadMessageId ?? 0;
    if (lastId <= base || markRead.isPending) return;
    lastMarked.current = { conv: conversationId, id: lastId };
    markRead.mutate({ conversationId, messageId: lastId }, { onSuccess: () => props.onListChanged() });
    // يُعاد الفحص بعد كل تحديث (version) — فعودة ظهور الصفحة أو الوصول للأسفل تعلّم القراءة حتى بلا رسائل جديدة.
  }, [lastId, interactive, thread.status, conversationId, showJump, thread.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // فاصل «رسائل جديدة»: لقطة عند أول فتح
  const unreadFrom = useRef<{ conv: number; id: number | null }>({ conv: 0, id: null });
  if (thread.status === "ready" && unreadFrom.current.conv !== conversationId && meta) {
    const lr = meta.lastReadMessageId ?? 0;
    // المطّلع ليس عضوًا (لا مؤشر قراءة له) — لا فاصل «رسائل جديدة»
    unreadFrom.current = { conv: conversationId, id: meta.readOnly ? null : thread.messages.find(m => m.id > lr && !m.mine && m.kind !== "system")?.id ?? null };
  }

  const afterChange = useCallback(() => { thread.refreshNow(); props.onListChanged(); }, [thread.refreshNow, props.onListChanged]); // eslint-disable-line react-hooks/exhaustive-deps

  // حارس متزامن: isPending لا يتغير قبل إعادة الرسم، فضغطتان في نفس اللحظة كانتا تمرّان معًا.
  const writing = useRef(false);
  const onSend = async (p: SendPayload) => {
    if (writing.current || send.isPending) return false;
    writing.current = true;
    setSendError(null);
    try {
      await send.mutateAsync({ conversationId, ...p });
      sentByMe.current = true;
      afterChange();
      return true;
    } catch (e) {
      setSendError(messagingErrorText(e));
      return false;
    } finally {
      writing.current = false;
    }
  };
  const onEdit = async (m: ChatMessage, body: string, title?: string) => {
    if (writing.current || edit.isPending) return false;
    writing.current = true;
    setSendError(null);
    try {
      await edit.mutateAsync({ messageId: m.id, body, ...(title ? { title } : {}) });
      afterChange();
      return true;
    } catch (e) {
      setSendError(messagingErrorText(e));
      return false;
    } finally {
      writing.current = false;
    }
  };

  const busy = react.isPending || ack.isPending || remove.isPending;
  const inFlight = useRef(new Set<string>());
  const once = useCallback((key: string, run: (done: () => void) => void) => {
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    run(() => inFlight.current.delete(key));
  }, []);
  const actions: BubbleActions = useMemo(() => ({
    onReply: m => setMode({ type: "reply", to: m }),
    onEdit: m => setMode({ type: "edit", message: m }),
    onDelete: m => setToDelete(m),
    onHistory: m => setHistoryId(m.id),
    // التفاعل toggle: ضغطتان متتاليتان قبل إعادة الرسم كانتا تلغيان بعضهما — حارس متزامن لكل فعل
    onReact: (m, r: Reaction) => once(`react:${m.id}`, done => react.mutate({ messageId: m.id, reaction: r }, { onSuccess: afterChange, onError: e => setActionError(messagingErrorText(e)), onSettled: done })),
    onAck: m => once(`ack:${m.id}`, done => ack.mutate({ messageId: m.id }, { onSuccess: afterChange, onError: e => setActionError(messagingErrorText(e)), onSettled: done })),
    onReads: m => setReadsId(m.id),
  }), [react, ack, afterChange, once]);

  const byId = useMemo(() => new Map(thread.messages.map(m => [m.id, m])), [thread.messages]);
  // محادثة خاصة وعضو فقط (المطّلع يأخذ null من السيرفر) — تتحدث مع الـPolling العادي بلا طلب إضافي
  const receiptId = useMemo(
    () => (conv?.kind === "direct" && !readOnly ? readReceiptMessageId(thread.messages, meta?.peerLastReadMessageId) : null),
    [conv?.kind, readOnly, thread.messages, meta?.peerLastReadMessageId],
  );

  const title = props.titleHint || (conv ? conversationTitle(conv) : "");
  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label={title || "المحادثة"} data-testid="conversation-view">
      <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-border bg-card px-2" data-readonly-safe>
        <Button type="button" variant="ghost" size="icon" className="min-h-11 min-w-11 md:hidden" onClick={props.onBack} aria-label="رجوع للمحادثات" data-testid="thread-back">
          <ArrowRight className="h-5 w-5" aria-hidden="true" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-bold">{title}</h2>
          {conv && <p className="truncate text-xs text-muted-foreground">{KIND_LABEL[conv.kind]}</p>}
        </div>
        {readOnly && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-800 dark:text-amber-300" data-testid="readonly-badge">
            <Eye className="h-3.5 w-3.5" aria-hidden="true" /> قراءة فقط
          </span>
        )}
      </header>

      {meta?.privacyNotice && (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-muted/60 px-3 py-2 text-xs text-muted-foreground" role="note" data-testid="privacy-notice">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p>{readOnly ? "أنت تطّلع على محادثة خاصة بين موظفين (قراءة فقط). هذا الاطلاع مسجَّل. " : ""}{meta.privacyNotice}</p>
        </div>
      )}
      {actionError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive" role="alert">
          <span className="flex-1">{actionError}</span>
          <Button type="button" variant="ghost" size="sm" className="min-h-11" onClick={() => setActionError(null)} data-readonly-safe>إغلاق</Button>
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overflow-x-hidden overscroll-contain px-2 py-2 [overflow-anchor:none] md:px-4" data-testid="message-scroll" aria-live="polite" aria-relevant="additions">
          {thread.status === "loading" && <LoadingSkeleton variant="cards" rows={4} />}
          {thread.status === "denied" && <MessagingError message="لست عضوًا في هذه المحادثة أو ليست لديك صلاحية عرضها." />}
          {thread.status === "notfound" && <MessagingError message="المحادثة غير موجودة." />}
          {thread.status === "error" && <MessagingError message={messagingErrorText(thread.error)} onRetry={thread.retry} />}
          {thread.status === "ready" && (
            <div ref={contentRef}>
              {thread.hasOlder && (
                <div className="flex justify-center py-2" data-readonly-safe>
                  <Button type="button" variant="outline" size="sm" className="min-h-11" onClick={() => void thread.loadOlder()} disabled={thread.loadingOlder} data-testid="load-older">
                    {thread.loadingOlder ? "جارٍ التحميل…" : "تحميل رسائل أقدم"}
                  </Button>
                </div>
              )}
              {thread.messages.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground" data-testid="thread-empty">لا رسائل بعد. ابدأ المحادثة.</p>}
              {thread.messages.map(m => (
                <div key={m.id}>
                  {unreadFrom.current.id === m.id && (
                    <div className="my-2 flex items-center gap-2 text-xs font-semibold text-primary-text" role="separator" aria-label="رسائل جديدة" data-testid="unread-divider">
                      <span className="h-px flex-1 bg-primary/40" />رسائل جديدة<span className="h-px flex-1 bg-primary/40" />
                    </div>
                  )}
                  <MessageBubble
                    message={m}
                    replyTo={m.replyToMessageId ? byId.get(m.replyToMessageId) ?? null : null}
                    readOnly={!interactive}
                    canAnnounceStats={permissions.announce && m.kind === "announcement"}
                    busy={busy}
                    readReceipt={receiptId === m.id}
                    actions={actions}
                    voice={m.kind === "voice" && props.voice ? props.voice.renderPlayer(m, conversationId) : undefined}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
        {showJump && (
          <Button type="button" size="sm" className="absolute inset-x-0 bottom-3 mx-auto w-fit min-h-11 gap-1 rounded-full shadow-md" onClick={jumpToBottom} data-readonly-safe data-testid="jump-new">
            <ArrowDown className="h-4 w-4" aria-hidden="true" /> رسائل جديدة
          </Button>
        )}
      </div>

      {thread.status === "ready" && (
        <Composer
          conversationId={conversationId}
          isAnnouncement={isAnnouncement && permissions.announce}
          mode={mode}
          onCancelMode={() => setMode({ type: "new" })}
          disabledReason={disabledReason}
          pending={send.isPending || edit.isPending}
          error={sendError}
          onSend={onSend}
          onEdit={onEdit}
          voiceSlot={props.voice && permissions.voice && !isAnnouncement
            ? props.voice.renderRecorder({ conversationId, replyToMessageId: mode.type === "reply" ? mode.to.id : undefined, disabled: send.isPending, onSent: () => { sentByMe.current = true; afterChange(); } })
            : null}
        />
      )}

      <HistoryDialog via={via} messageId={historyId} onOpenChange={o => { if (!o) setHistoryId(null); }} />
      <ReadsDialog via={via} messageId={readsId} onOpenChange={o => { if (!o) setReadsId(null); }} />
      <ConfirmDialog
        open={toDelete != null}
        onOpenChange={o => { if (!o && !remove.isPending) setToDelete(null); }}
        title="حذف الرسالة"
        description="ستظهر للجميع كرسالة محذوفة. يبقى نصها في سجل التعديلات."
        confirmLabel="حذف"
        tone="destructive"
        pending={remove.isPending}
        onConfirm={async () => {
          if (!toDelete || remove.isPending || inFlight.current.has("remove")) return;
          inFlight.current.add("remove");
          try { await remove.mutateAsync({ messageId: toDelete.id }); setToDelete(null); afterChange(); utils.history.invalidate(); }
          catch (e) { setActionError(messagingErrorText(e)); setToDelete(null); }
          finally { inFlight.current.delete("remove"); }
        }}
      />
    </section>
  );
}
