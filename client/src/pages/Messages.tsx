import { useLocation, useRoute } from "wouter";
import { MessagingCenter } from "@/components/messaging/MessagingCenter";
import { messagingVoiceHooks } from "@/components/messaging/voiceHooks";

/**
 * مركز الرسائل للمالك/الأدمن/المدير — داخل DashboardLayout (جلسة الويب: `trpc.messages.*`).
 * المعرّف في الرابط للتنقل فقط (/messages/:id)؛ السيرفر يقرر الوصول والصلاحيات.
 */
export default function Messages() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute<{ id: string }>("/messages/:id");
  const id = params?.id && /^\d+$/.test(params.id) ? Number(params.id) : null;
  return (
    <MessagingCenter
      via="web"
      conversationId={id}
      onOpen={next => setLocation(next == null ? "/messages" : `/messages/${next}`)}
      topOffset="3.5rem"
      desktopHeight="calc(100dvh - 7rem)"
      voice={messagingVoiceHooks}
    />
  );
}
