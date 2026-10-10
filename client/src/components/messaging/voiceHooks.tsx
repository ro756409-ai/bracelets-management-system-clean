import type { MessagingStatus, MessagingVia } from "./messagingApi";
import type { VoiceHooks } from "./ConversationView";
import { VoicePlayer } from "./VoicePlayer";
import { VoiceRecorder } from "./VoiceRecorder";

/**
 * ربط الصوت بالمركز: المشغّل لكل من يقرأ المحادثة (من المسار المصرّح فقط)، وزر التسجيل لمن يملك
 * messages.voice فقط (السيرفر يفحصها مجددًا في كل رفع).
 */
export function messagingVoiceHooks(perms: MessagingStatus["permissions"], via: MessagingVia): VoiceHooks {
  return {
    renderPlayer: m => <VoicePlayer via={via} message={m} />,
    renderRecorder: ctx => (perms.voice ? <VoiceRecorder key={ctx.conversationId} via={via} {...ctx} /> : null),
  };
}
