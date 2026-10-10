import { Eye, Hash, Megaphone, MessageSquarePlus, Users, UsersRound, UserRound, Building2 } from "lucide-react";
import type { ConversationKind } from "@shared/messagingSpec";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ConversationRow, MonitorRow } from "./messagingApi";
import { conversationTitle, formatTime, previewText } from "./format";

const ICON: Record<ConversationKind, typeof Hash> = { announcement: Megaphone, team: Users, business: Building2, group: UsersRound, direct: UserRound };

/**
 * قائمة المحادثات: القنوات (الإعلانات/الفريق/الأنشطة) ثم المجموعات ثم الخاص، وقسم منفصل «اطلاع المالك» (قراءة
 * فقط) يظهر فقط حين يعيد السيرفر قائمة الاطلاع. كل صف زر ≥ 56px بأسماء عربية واضحة؛ المعاينة نص عادي.
 * أزرار «محادثة جديدة» و«مجموعة جديدة» داخل منطقة القراءة الآمنة فقط للفتح — الإنشاء نفسه كتابة.
 */
export function ConversationList(props: {
  conversations: ConversationRow[];
  monitor: MonitorRow[];
  activeId: number | null;
  onOpen: (id: number) => void;
  canCreateGroup: boolean;
  onNewDirect: () => void;
  onNewGroup: () => void;
  writeDisabled: boolean;
}) {
  const channels = props.conversations.filter(c => c.kind === "announcement" || c.kind === "team" || c.kind === "business");
  const groups = props.conversations.filter(c => c.kind === "group");
  const direct = props.conversations.filter(c => c.kind === "direct");
  return (
    <nav aria-label="المحادثات" className="flex h-full min-h-0 flex-col" data-testid="conversation-list">
      <div className="flex items-center gap-2 border-b border-border p-2" data-readonly-safe>
        <Button type="button" variant="outline" className="min-h-11 flex-1 gap-1.5" onClick={props.onNewDirect} disabled={props.writeDisabled} data-testid="new-direct">
          <MessageSquarePlus className="h-4 w-4" aria-hidden="true" /> محادثة جديدة
        </Button>
        {props.canCreateGroup && (
          <Button type="button" variant="outline" className="min-h-11 flex-1 gap-1.5" onClick={props.onNewGroup} disabled={props.writeDisabled} data-testid="new-group">
            <UsersRound className="h-4 w-4" aria-hidden="true" /> مجموعة جديدة
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-readonly-safe>
        <Section title="القنوات" rows={channels} {...props} />
        <Section title="المجموعات" rows={groups} {...props} />
        <Section title="الخاص" rows={direct} {...props} />
        {props.monitor.length > 0 && (
          <section aria-labelledby="monitor-heading" className="border-t border-border pt-1" data-testid="monitor-section">
            <h3 id="monitor-heading" className="flex items-center gap-1.5 px-3 pb-1 pt-3 text-xs font-semibold text-muted-foreground">
              <Eye className="h-3.5 w-3.5" aria-hidden="true" /> اطلاع المالك — قراءة فقط ومسجَّل
            </h3>
            <ul>
              {props.monitor.map(m => (
                <li key={m.id}>
                  <button
                    type="button"
                    onClick={() => props.onOpen(m.id)}
                    aria-current={props.activeId === m.id ? "true" : undefined}
                    className={cn("flex min-h-14 w-full items-center gap-3 px-3 py-2 text-start transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", props.activeId === m.id && "bg-accent")}
                    data-testid={`monitor-${m.id}`}
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true"><Eye className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{m.kind === "group" ? m.title ?? "مجموعة" : m.participants.join(" ↔ ")}</span>
                      <span className="block truncate text-xs text-muted-foreground">{m.kind === "group" ? m.participants.join("، ") : "محادثة خاصة"}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">{formatTime(m.lastMessageAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </nav>
  );
}

function Section({ title, rows, activeId, onOpen }: { title: string; rows: ConversationRow[]; activeId: number | null; onOpen: (id: number) => void }) {
  if (!rows.length) return null;
  return (
    <section aria-label={title}>
      <h3 className="px-3 pb-1 pt-3 text-xs font-semibold text-muted-foreground">{title}</h3>
      <ul>
        {rows.map(c => {
          const Icon = ICON[c.kind];
          const active = activeId === c.id;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onOpen(c.id)}
                aria-current={active ? "true" : undefined}
                aria-label={`${conversationTitle(c)}${c.unread ? ` — ${c.unread} غير مقروءة` : ""}`}
                className={cn("flex min-h-14 w-full items-center gap-3 px-3 py-2 text-start transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset", active && "bg-accent")}
                data-testid={`conversation-${c.id}`}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary" aria-hidden="true"><Icon className="h-4 w-4" /></span>
                <span className="min-w-0 flex-1">
                  <span className={cn("block truncate text-sm", c.unread ? "font-bold" : "font-medium")}>{conversationTitle(c)}</span>
                  <span className="block truncate text-xs text-muted-foreground" dir="auto">{previewText(c.last)}</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-[11px] text-muted-foreground">{formatTime(c.lastMessageAt)}</span>
                  {c.unread > 0 && (
                    <span className="min-w-5 rounded-full bg-primary px-1.5 text-center text-[11px] font-bold leading-5 text-primary-foreground tabular-nums" aria-hidden="true" data-testid={`unread-${c.id}`}>
                      {c.unread > 99 ? "99+" : c.unread}
                    </span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
