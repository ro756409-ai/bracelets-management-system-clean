import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pencil, Pin, Reply, Send, X, RotateCcw } from "lucide-react";
import { MESSAGING_LIMITS } from "@shared/messagingSpec";
import { Button } from "@/components/ui/button";
import { completeOperation, operationIdFor } from "@/lib/operationId";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "./messagingApi";

export type ComposerMode = { type: "new" } | { type: "reply"; to: ChatMessage } | { type: "edit"; message: ChatMessage };

export type SendPayload = { body: string; title?: string; isPinned?: boolean; replyToMessageId?: number; idempotencyKey: string };

/**
 * شريط الكتابة. القواعد:
 *   • Enter يرسل، Shift+Enter سطر جديد (ولا إرسال أثناء تركيب حروف IME).
 *   • معرّف العملية ثابت لنفس المسودة حتى تنجح (operationIdFor) — الضغط المزدوج وإعادة المحاولة = نفس المعرّف،
 *     والسيرفر يعيدها Replay. يُستهلك المعرّف عند النجاح فقط.
 *   • أثناء الإرسال كل أزرار الكتابة معطلة؛ عند الفشل **يبقى النص** مع رسالة عربية وزر «إعادة الإرسال».
 *   • الإعلان (لمن يملك messages.announce فقط): عنوان + تثبيت.
 */
export function Composer(props: {
  conversationId: number;
  isAnnouncement: boolean;
  mode: ComposerMode;
  onCancelMode: () => void;
  disabledReason: string | null;
  pending: boolean;
  error: string | null;
  onSend: (p: SendPayload) => Promise<boolean>;
  onEdit: (m: ChatMessage, body: string, title?: string) => Promise<boolean>;
  voiceSlot?: ReactNode;
}) {
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const scope = `msg-send:${props.conversationId}`;
  /** آخر معرّف عملية استُخدم لهذه المسودة (بعد فشل) — يُحرَّر إذا تغيّر المحتوى. */
  const usedKey = useRef<string | null>(null);

  // وضع التعديل يملأ النص الحالي؛ الخروج منه يعيد المسودة فارغة
  useEffect(() => {
    if (usedKey.current) { completeOperation(usedKey.current); usedKey.current = null; } // تغيّر الرد/التعديل = حمولة جديدة
    if (props.mode.type === "edit") { setBody(props.mode.message.body ?? ""); setTitle(props.mode.message.title ?? ""); }
    if (props.mode.type !== "new") ref.current?.focus();
  }, [props.mode]);

  const disabled = Boolean(props.disabledReason);
  const trimmed = body.trim();
  const tooLong = body.length > MESSAGING_LIMITS.bodyMaxChars;
  const needsTitle = props.isAnnouncement && props.mode.type !== "edit" ? !title.trim() : false;
  const canSubmit = !disabled && !props.pending && trimmed.length > 0 && !tooLong && !needsTitle;

  const submit = async () => {
    if (!canSubmit) return;
    if (props.mode.type === "edit") {
      const ok = await props.onEdit(props.mode.message, trimmed, props.isAnnouncement ? title.trim() || undefined : undefined);
      if (ok) { setBody(""); setTitle(""); props.onCancelMode(); }
      return;
    }
    const idempotencyKey = operationIdFor(scope);
    usedKey.current = idempotencyKey;
    const ok = await props.onSend({
      body: trimmed,
      idempotencyKey,
      ...(props.isAnnouncement ? { title: title.trim(), isPinned: pinned } : {}),
      ...(props.mode.type === "reply" ? { replyToMessageId: props.mode.to.id } : {}),
    });
    if (ok) {
      completeOperation(idempotencyKey);
      usedKey.current = null;
      setBody(""); setTitle(""); setPinned(false);
      if (props.mode.type === "reply") props.onCancelMode();
      ref.current?.focus();
    }
  };

  // تغيير المحتوى بعد محاولة فاشلة = عملية جديدة (لا نعيد نفس المعرّف لمحتوى مختلف ⇒ لا CONFLICT)
  const releaseKey = () => { if (usedKey.current) { completeOperation(usedKey.current); usedKey.current = null; } };
  const onChangeBody = (v: string) => { releaseKey(); setBody(v); };

  if (disabled) {
    return (
      <div className="border-t border-border bg-muted/40 px-3 py-3 text-center text-sm text-muted-foreground" role="status" data-testid="composer-disabled">
        {props.disabledReason}
      </div>
    );
  }

  return (
    <form
      className="relative border-t border-border bg-card/95 px-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] pt-2 backdrop-blur md:pb-2"
      onSubmit={e => { e.preventDefault(); void submit(); }}
      aria-label="كتابة رسالة"
      data-testid="composer"
    >
      {props.mode.type !== "new" && (
        <div className="mb-1.5 flex items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
          {props.mode.type === "reply" ? <Reply className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <Pencil className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          <span className="min-w-0 flex-1 truncate" dir="auto">
            {props.mode.type === "reply" ? `رد على: ${props.mode.to.kind === "voice" ? "رسالة صوتية" : props.mode.to.body ?? ""}` : "تعديل الرسالة"}
          </span>
          <Button type="button" variant="ghost" size="icon" className="min-h-11 min-w-11" onClick={() => { if (props.mode.type === "edit") { setBody(""); setTitle(""); } props.onCancelMode(); }} aria-label="إلغاء">
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      )}
      {props.error && (
        <div className="mb-1.5 flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive" role="alert" data-testid="composer-error">
          <span className="min-w-0 flex-1">{props.error}</span>
          <Button type="submit" variant="outline" size="sm" className="min-h-11 shrink-0 gap-1" disabled={!canSubmit} data-testid="composer-retry">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> إعادة الإرسال
          </Button>
        </div>
      )}
      {props.isAnnouncement && props.mode.type !== "reply" && (
        <div className="mb-1.5 flex items-center gap-2">
          <input
            value={title}
            onChange={e => { releaseKey(); setTitle(e.target.value); }}
            maxLength={MESSAGING_LIMITS.titleMaxChars}
            placeholder="عنوان الإعلان"
            aria-label="عنوان الإعلان"
            className="min-h-11 min-w-0 flex-1 rounded-[var(--radius-brand-md)] border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            disabled={props.pending}
            data-testid="composer-title"
          />
          {props.mode.type === "new" && (
            <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 px-1 text-xs">
              <input type="checkbox" className="h-5 w-5 accent-[var(--primary)]" checked={pinned} onChange={e => { releaseKey(); setPinned(e.target.checked); }} disabled={props.pending} />
              <Pin className="h-3.5 w-3.5" aria-hidden="true" /> تثبيت
            </label>
          )}
        </div>
      )}
      <div className="flex items-end gap-1.5">
        {props.voiceSlot}
        <textarea
          ref={ref}
          value={body}
          onChange={e => onChangeBody(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
            if (e.key === "Escape" && props.mode.type !== "new") props.onCancelMode();
          }}
          rows={1}
          placeholder={props.isAnnouncement ? "نص الإعلان…" : "اكتب رسالة…"}
          aria-label="اكتب رسالة"
          aria-describedby="composer-hint"
          dir="auto"
          className={cn(
            "max-h-40 min-h-11 min-w-0 flex-1 resize-none rounded-[var(--radius-brand-md)] border border-input bg-background px-3 py-2.5 text-sm leading-5 [field-sizing:content] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            tooLong && "border-destructive",
          )}
          disabled={props.pending}
          data-testid="composer-input"
        />
        <Button type="submit" size="icon" className="min-h-11 min-w-11 shrink-0" disabled={!canSubmit} aria-label={props.mode.type === "edit" ? "حفظ التعديل" : "إرسال"} data-testid="composer-send">
          <Send className="h-4 w-4 -scale-x-100" aria-hidden="true" />
        </Button>
      </div>
      <p id="composer-hint" className="sr-only">Enter للإرسال، وShift مع Enter لسطر جديد.</p>
      {tooLong && <p className="mt-1 text-xs text-destructive" role="alert">الرسالة أطول من {MESSAGING_LIMITS.bodyMaxChars} حرف.</p>}
    </form>
  );
}
