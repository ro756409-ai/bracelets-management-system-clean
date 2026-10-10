import type { MessagingStatus, MessagingVia } from "./messagingApi";
import type { VoiceHooks } from "./ConversationView";

/** نقطة ربط الصوت (التسجيل/التشغيل) — تُملأ في مرحلة الصوت؛ حتى ذلك الحين لا صوت في الواجهة. */
export function messagingVoiceHooks(_perms: MessagingStatus["permissions"], _via: MessagingVia): VoiceHooks | undefined {
  return undefined;
}
