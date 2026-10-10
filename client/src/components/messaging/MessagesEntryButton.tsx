import { useCallback } from "react";
import { useLocation } from "wouter";
import { MessagesSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { messagesBasePath, useMessagingApi, type MessagingVia } from "./messagingApi";
import { CONVERSATION_LIST_POLL_MS, STATUS_STALE_MS } from "./MessagingCenter";
import { usePoller } from "./pollScheduler";

/**
 * زر «الرسائل» مع عدد غير المقروء. العلم معطل أو بلا messages.use ⇒ لا يُرسم أصلًا، ولا طلب غير `status`
 * (مخزّن 5 دقائق). داخل صفحة الرسائل نفسها لا يحدّث بنفسه (المركز يحدّث نفس الكاش) — لا Polling مزدوج.
 */
export function MessagesEntryButton({ via, className }: { via: MessagingVia; className?: string }) {
  const api = useMessagingApi(via);
  const [location, setLocation] = useLocation();
  const base = messagesBasePath(via);
  const onMessages = location === base || location.startsWith(base + "/");
  const status = api.status.useQuery(undefined, { retry: false, staleTime: STATUS_STALE_MS, refetchOnWindowFocus: false });
  const visible = Boolean(status.data?.enabled && status.data.permissions.use);
  const list = api.conversations.useQuery(undefined, { enabled: visible, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const refetch = useCallback(() => list.refetch({ throwOnError: true, cancelRefetch: false }), [list.refetch]); // eslint-disable-line react-hooks/exhaustive-deps
  usePoller(refetch, { enabled: visible && !onMessages, intervalMs: CONVERSATION_LIST_POLL_MS });
  if (!visible) return null;
  const unread = list.data && list.data.enabled ? list.data.unreadTotal : 0;
  return (
    <button
      type="button"
      onClick={() => setLocation(base)}
      className={cn("relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--radius-brand-md)] transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
      aria-label={unread ? `الرسائل — ${unread} غير مقروءة` : "الرسائل"}
      aria-current={onMessages ? "page" : undefined}
      data-readonly-safe
      data-testid="messages-entry"
    >
      <MessagesSquare className="h-5 w-5" aria-hidden="true" />
      {unread > 0 && (
        <span className="absolute -top-0.5 end-0 min-w-5 rounded-full bg-destructive px-1 text-center text-[11px] font-bold leading-5 text-destructive-foreground tabular-nums" aria-hidden="true" data-testid="messages-unread">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}
