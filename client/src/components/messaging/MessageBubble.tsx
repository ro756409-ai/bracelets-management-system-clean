import { memo, type ReactNode } from "react";
import { CheckCheck, CornerDownLeft, History, MoreVertical, Pencil, Pin, Reply, Trash2, Eye } from "lucide-react";
import { REACTIONS, REACTION_EMOJI, type Reaction } from "@shared/messagingSpec";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "./messagingApi";
import { formatFullTime, formatTime } from "./format";

const REACTION_LABEL: Record<Reaction, string> = { like: "إعجاب", done: "تم", heart: "قلب", thanks: "شكرًا" };

export type BubbleActions = {
  onReply: (m: ChatMessage) => void;
  onEdit: (m: ChatMessage) => void;
  onDelete: (m: ChatMessage) => void;
  onHistory: (m: ChatMessage) => void;
  onReact: (m: ChatMessage, r: Reaction) => void;
  onAck: (m: ChatMessage) => void;
  onReads: (m: ChatMessage) => void;
};

/**
 * فقاعة رسالة. **النص يُعرض كنص عادي** (React يهرّب كل شيء — لا HTML خام). المحذوفة تظهر كعنصر نائب بلا
 * محتوى؛ «عُدّلت» تفتح سجل النسخ من المسار المصرّح فقط. وضع الاطلاع/القراءة فقط: لا رد ولا تعديل ولا حذف
 * ولا تفاعل — السجل فقط. الصوت يُرسم عبر `voice` (منفصل ومذكّر حتى لا يُعاد تنزيله مع كل تحديث).
 */
export const MessageBubble = memo(function MessageBubble(props: {
  message: ChatMessage;
  replyTo: ChatMessage | null;
  readOnly: boolean;
  canAnnounceStats: boolean;
  busy: boolean;
  /** «تمت القراءة» — تظهر على رسالة واحدة فقط (آخر رسالة لي قرأها الطرف الآخر في المحادثة الخاصة). */
  readReceipt?: boolean;
  actions: BubbleActions;
  voice?: ReactNode;
}) {
  const { message: m, readOnly, actions } = props;
  const deleted = m.deletedAt != null;
  if (m.kind === "system") {
    return (
      <div className="my-2 flex justify-center" data-testid={`message-${m.id}`}>
        <p className="max-w-[90%] rounded-[var(--radius-brand-md)] bg-muted px-3 py-2 text-center text-xs text-muted-foreground" dir="auto">{m.body}</p>
      </div>
    );
  }
  const canEdit = !readOnly && m.mine && !deleted && (m.kind === "text" || m.kind === "announcement");
  const canDelete = !readOnly && m.mine && !deleted;
  const canInteract = !readOnly && !deleted;
  const hasHistory = m.editedAt != null || deleted;
  return (
    <div className={cn("group my-1.5 flex w-full", m.mine ? "justify-end" : "justify-start")} data-testid={`message-${m.id}`}>
      <div className={cn("flex max-w-[min(85%,36rem)] min-w-0 items-start gap-1", m.mine && "flex-row-reverse")}>
        <article
          aria-label={`رسالة من ${m.mine ? "أنت" : m.senderName ?? "موظف"}`}
          className={cn(
            "min-w-0 rounded-2xl border px-3 py-2 text-sm shadow-sm",
            m.mine ? "border-primary/20 bg-primary/10" : "border-border bg-card",
            m.kind === "announcement" && "border-amber-500/40 bg-amber-500/10",
          )}
        >
          {!m.mine && <p className="mb-0.5 truncate text-xs font-semibold text-primary-text">{m.senderName ?? "موظف"}</p>}
          {props.replyTo && !deleted && (
            <div className="mb-1 flex items-start gap-1 rounded-md border-s-2 border-primary/50 bg-muted/60 px-2 py-1 text-xs text-muted-foreground">
              <CornerDownLeft className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
              <span className="line-clamp-2 break-words" dir="auto">
                {props.replyTo.deletedAt ? "رسالة محذوفة" : props.replyTo.kind === "voice" ? "رسالة صوتية" : props.replyTo.body ?? ""}
              </span>
            </div>
          )}
          {deleted ? (
            <p className="italic text-muted-foreground" data-testid={`deleted-${m.id}`}>تم حذف هذه الرسالة</p>
          ) : (
            <>
              {m.kind === "announcement" && (
                <p className="mb-1 flex items-center gap-1 font-bold" dir="auto">
                  {m.isPinned && <Pin className="h-3.5 w-3.5 shrink-0 text-amber-600" aria-label="مثبّت" />}
                  {m.title}
                </p>
              )}
              {m.kind === "voice" ? props.voice : m.body != null && <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]" dir="auto">{m.body}</p>}
            </>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            <time dateTime={new Date(m.createdAt).toISOString()} title={formatFullTime(m.createdAt)}>{formatTime(m.createdAt)}</time>
            {/* «عُدّلت»: منطقة لمس 44px بهوامش سالبة — الشكل يبقى صغيرًا داخل سطر الوقت */}
            {m.editedAt != null && !deleted && (
              <button type="button" className="-my-3 inline-flex min-h-11 min-w-11 items-center justify-center rounded px-1 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => actions.onHistory(m)} data-readonly-safe>
                عُدّلت
              </button>
            )}
            {m.kind === "voice" && m.mine && m.listens.count > 0 && <span className="text-primary-text">سمعها {m.listens.count}</span>}
            {props.readReceipt && (
              <span className="inline-flex items-center gap-0.5 text-primary-text" data-testid={`read-receipt-${m.id}`}>
                <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" /> تمت القراءة
              </span>
            )}
          </div>
          {m.reactions.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1" aria-label="التفاعلات">
              {m.reactions.map(r => (
                <button
                  key={r.reaction}
                  type="button"
                  disabled={!canInteract || props.busy}
                  aria-pressed={r.mine}
                  aria-label={`${REACTION_LABEL[r.reaction as Reaction]}: ${r.count}`}
                  onClick={() => actions.onReact(m, r.reaction as Reaction)}
                  className="group/chip -my-1.5 inline-flex min-h-11 min-w-11 items-center justify-center disabled:opacity-70 focus-visible:outline-none"
                  data-readonly-write
                >
                  <span className={cn("inline-flex h-8 items-center gap-1 rounded-full border px-2 text-xs tabular-nums group-focus-visible/chip:ring-2 group-focus-visible/chip:ring-ring", r.mine ? "border-primary bg-primary/15" : "border-border bg-background")}>
                    <span aria-hidden="true">{REACTION_EMOJI[r.reaction as Reaction]}</span>{r.count}
                  </span>
                </button>
              ))}
            </div>
          )}
          {m.kind === "announcement" && !deleted && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {!m.mine && (m.acks.mine ? (
                <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><CheckCheck className="h-3.5 w-3.5" aria-hidden="true" /> اطّلعت</span>
              ) : (
                !readOnly && (
                  <Button type="button" size="sm" variant="outline" className="min-h-11" disabled={props.busy} onClick={() => actions.onAck(m)} data-testid={`ack-${m.id}`}>
                    <CheckCheck className="h-4 w-4" aria-hidden="true" /> اطّلعت
                  </Button>
                )
              ))}
              {props.canAnnounceStats && (
                <Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={() => actions.onReads(m)} data-readonly-safe data-testid={`reads-${m.id}`}>
                  <Eye className="h-4 w-4" aria-hidden="true" /> اطّلع {m.acks.count}
                </Button>
              )}
            </div>
          )}
        </article>
        {(canInteract || hasHistory) && (
          <DropdownMenu dir="rtl">
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="min-h-11 min-w-11 shrink-0 text-muted-foreground opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 data-[state=open]:opacity-100" aria-label="خيارات الرسالة" data-readonly-safe data-testid={`menu-${m.id}`}>
                <MoreVertical className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {canInteract && (
                <div className="flex justify-between gap-1 px-1 py-1" role="group" aria-label="تفاعل">
                  {REACTIONS.map(r => (
                    <DropdownMenuItem key={r} className="min-h-11 min-w-11 justify-center text-lg" aria-label={REACTION_LABEL[r]} disabled={props.busy} onSelect={() => actions.onReact(m, r)} data-readonly-write>
                      <span aria-hidden="true">{REACTION_EMOJI[r]}</span>
                    </DropdownMenuItem>
                  ))}
                </div>
              )}
              {canInteract && <DropdownMenuSeparator />}
              {canInteract && <DropdownMenuItem className="min-h-11 gap-2" onSelect={() => actions.onReply(m)} data-readonly-write><Reply className="h-4 w-4" aria-hidden="true" /> رد</DropdownMenuItem>}
              {canEdit && <DropdownMenuItem className="min-h-11 gap-2" onSelect={() => actions.onEdit(m)} data-readonly-write data-testid={`edit-${m.id}`}><Pencil className="h-4 w-4" aria-hidden="true" /> تعديل</DropdownMenuItem>}
              {hasHistory && <DropdownMenuItem className="min-h-11 gap-2" onSelect={() => actions.onHistory(m)} data-testid={`history-${m.id}`}><History className="h-4 w-4" aria-hidden="true" /> سجل التعديلات</DropdownMenuItem>}
              {canDelete && (
                <DropdownMenuItem className="min-h-11 gap-2 text-destructive focus:text-destructive" disabled={props.busy} onSelect={() => actions.onDelete(m)} data-readonly-write data-testid={`delete-${m.id}`}>
                  <Trash2 className="h-4 w-4" aria-hidden="true" /> حذف
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
});
