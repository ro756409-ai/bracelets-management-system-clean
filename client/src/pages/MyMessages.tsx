import { useLocation, useRoute } from "wouter";
import { MessagesSquare } from "lucide-react";
import { EmployeeShell } from "@/components/shell/EmployeeShell";
import { MessagingCenter } from "@/components/messaging/MessagingCenter";
import { messagingVoiceHooks } from "@/components/messaging/voiceHooks";

/**
 * مركز رسائل الموظف — داخل بوابته (هوية كوكي البوابة فقط: `trpc.employeePortal.messages.*`)، فلا تتأثر بجلسة
 * مالك مفتوحة في نفس المتصفح. نفس المكونات المشتركة؛ الاختلاف في الصلاحيات من السيرفر فقط.
 */
export default function MyMessages() {
  const [, setLocation] = useLocation();
  const [, params] = useRoute<{ id: string }>("/my-messages/:id");
  const id = params?.id && /^\d+$/.test(params.id) ? Number(params.id) : null;
  return (
    <EmployeeShell title="الرسائل" icon={MessagesSquare}>
      <MessagingCenter
        via="portal"
        conversationId={id}
        onOpen={next => setLocation(next == null ? "/my-messages" : `/my-messages/${next}`)}
        topOffset="3.75rem"
        desktopHeight="calc(100dvh - 6.5rem)"
        voice={messagingVoiceHooks}
      />
    </EmployeeShell>
  );
}
