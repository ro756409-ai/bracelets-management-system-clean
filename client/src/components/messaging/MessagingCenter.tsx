import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { MessagesSquare, WifiOff } from "lucide-react";
import { LoadingSkeleton, PermissionDeniedState } from "@/components/shared";
import { useTenantAccess } from "@/contexts/TenantAccessContext";
import { cn } from "@/lib/utils";
import { ConversationList } from "./ConversationList";
import { ConversationView, type VoiceHooks } from "./ConversationView";
import { NewDirectDialog, NewGroupDialog } from "./MessagingDialogs";
import { MessagingError, MessagingUnavailable } from "./MessagingStates";
import { OFFLINE_TEXT, errorCode, messagingErrorText, useMessagingApi, type MessagingStatus, type MessagingVia } from "./messagingApi";
import { conversationTitle, useOnline } from "./format";
import { usePoller } from "./pollScheduler";

export const CONVERSATION_LIST_POLL_MS = 20_000;
export const STATUS_STALE_MS = 5 * 60 * 1000;

export type MessagingCenterProps = {
  via: MessagingVia;
  /** المحادثة المفتوحة من المسار (للتنقل فقط — السيرفر يقرر الوصول). */
  conversationId: number | null;
  onOpen: (id: number | null) => void;
  /** ارتفاع المركز على الديسكتوب (القائمة + المحادثة جنبًا إلى جنب). */
  desktopHeight: string;
  voice?: (perms: MessagingStatus["permissions"], via: MessagingVia) => VoiceHooks | undefined;
};

/**
 * مركز الرسائل (مشترك بين المالك والموظف): الحالة أولًا (`status`) — العلم معطل = «غير متاح» **ولا أي طلب آخر**؛
 * بلا messages.use = رفض واضح. بعدها القائمة (تحديث كل 20 ثانية) والمحادثة المفتوحة (كل 4 ثوانٍ).
 */
export function MessagingCenter(props: MessagingCenterProps) {
  const api = useMessagingApi(props.via);
  const status = api.status.useQuery(undefined, { retry: false, staleTime: STATUS_STALE_MS, refetchOnWindowFocus: false });
  if (status.isLoading) return <div className="p-4" data-testid="messaging-loading"><LoadingSkeleton variant="cards" rows={5} /></div>;
  if (status.error) {
    if (errorCode(status.error) === "FORBIDDEN") return <PermissionDeniedState message="مركز الرسائل غير متاح لحسابك." />;
    return <MessagingError message={messagingErrorText(status.error)} onRetry={() => status.refetch()} />;
  }
  if (!status.data?.enabled) return <MessagingUnavailable />;
  if (!status.data.permissions.use) return <PermissionDeniedState message="ليست لديك صلاحية استخدام الرسائل. راجع المالك إذا كنت تحتاجها." />;
  return <CenterBody {...props} permissions={status.data.permissions} />;
}

function CenterBody(props: MessagingCenterProps & { permissions: MessagingStatus["permissions"] }) {
  const { via, permissions, conversationId } = props;
  const api = useMessagingApi(via);
  const tenant = useTenantAccess();
  const tenantReadOnly = tenant.readOnly || tenant.blocked;
  const online = useOnline();
  const list = api.conversations.useQuery(undefined, { retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false });
  const refetchList = useCallback(async () => {
    const r = await list.refetch({ throwOnError: true, cancelRefetch: false }); // لا يلغي/يكرر طلبًا جاريًا
    return r;
  }, [list.refetch]); // eslint-disable-line react-hooks/exhaustive-deps
  const listPoller = usePoller(refetchList, { enabled: true, intervalMs: CONVERSATION_LIST_POLL_MS });

  // القنوات الافتراضية مرة لكل فتح (كتابة — تُتجاوز في وضع القراءة فقط)
  const bootstrap = api.bootstrap.useMutation();
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current || tenantReadOnly) return;
    booted.current = true;
    bootstrap.mutate(undefined, { onSettled: () => listPoller.trigger() });
  }, [tenantReadOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const [dialog, setDialog] = useState<null | "direct" | "group">(null);
  const voice = props.voice?.(permissions, via);
  const data = list.data && list.data.enabled ? list.data : null;
  const noConversations = data && data.conversations.length === 0 && data.monitor.length === 0;
  const titleHint = (() => {
    if (!data || conversationId == null) return null;
    const row = data.conversations.find(c => c.id === conversationId);
    if (row) return conversationTitle(row);
    const mon = data.monitor.find(m => m.id === conversationId);
    return mon ? (mon.kind === "group" ? mon.title ?? "مجموعة" : mon.participants.join(" ↔ ")) : null;
  })();

  return (
    <div className="flex min-h-0 flex-col" data-testid="messaging-center" dir="rtl">
      {!online && (
        <div className="mb-2 flex items-center gap-2 rounded-[var(--radius-brand-md)] border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-200" role="status" data-testid="messaging-offline">
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" /> {OFFLINE_TEXT}
        </div>
      )}
      <div
        className="grid min-h-0 overflow-hidden rounded-[var(--radius-brand-lg)] border border-border bg-card md:h-[var(--msg-desktop-h)] md:grid-cols-[minmax(16rem,20rem)_1fr]"
        style={{ "--msg-desktop-h": props.desktopHeight } as CSSProperties}
      >
        <div className={cn("min-h-0 md:flex md:flex-col md:border-e md:border-border", conversationId != null ? "hidden" : "flex flex-col")}>
          {list.isLoading ? (
            <div className="p-3"><LoadingSkeleton variant="cards" rows={6} /></div>
          ) : list.error && !data ? (
            <MessagingError message={messagingErrorText(list.error)} onRetry={() => listPoller.trigger()} />
          ) : noConversations ? (
            <div className="p-6 text-center text-sm text-muted-foreground" data-testid="no-conversations">
              {bootstrap.isPending ? "جارٍ تجهيز قنواتك…" : "لا محادثات بعد."}
            </div>
          ) : data ? (
            <ConversationList
              conversations={data.conversations}
              monitor={data.monitor}
              activeId={conversationId}
              onOpen={id => props.onOpen(id)}
              canCreateGroup={permissions.manageGroups}
              onNewDirect={() => setDialog("direct")}
              onNewGroup={() => setDialog("group")}
              writeDisabled={tenantReadOnly || !online}
            />
          ) : null}
        </div>

        {conversationId != null ? (
          // الموبايل: شاشة المحادثة كاملة من أعلى الشاشة (برأسها وزر الرجوع) وحتى أعلى القائمة السفلية (--bottom-nav-h) —
          // بلا تخمين لارتفاع شريط الصفحة المضيفة (يتغير مع حجم الخط). الديسكتوب: العمود الثاني.
          <div className="fixed inset-x-0 bottom-[var(--bottom-nav-h,0px)] top-0 z-[45] flex min-h-0 flex-col bg-background pt-[env(safe-area-inset-top)] md:static md:z-auto md:pt-0">
            <ConversationView
              key={conversationId}
              via={via}
              conversationId={conversationId}
              permissions={permissions}
              onBack={() => props.onOpen(null)}
              onListChanged={() => listPoller.trigger()}
              titleHint={titleHint}
              voice={voice}
            />
          </div>
        ) : (
          <div className="hidden min-h-0 flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground md:flex" data-testid="no-selection">
            <MessagesSquare className="h-10 w-10" aria-hidden="true" />
            <p className="text-sm">اختر محادثة من القائمة.</p>
          </div>
        )}
      </div>

      <NewDirectDialog via={via} open={dialog === "direct"} onOpenChange={o => setDialog(o ? "direct" : null)} onCreated={id => { listPoller.trigger(); props.onOpen(id); }} />
      {permissions.manageGroups && (
        <NewGroupDialog via={via} open={dialog === "group"} onOpenChange={o => setDialog(o ? "group" : null)} onCreated={id => { listPoller.trigger(); props.onOpen(id); }} />
      )}
    </div>
  );
}
