import { useEffect, useState } from "react";
import type { ConversationKind } from "@shared/messagingSpec";

/** أرقام لاتينية داخل نص عربي (نفس قرار الهوية: ar-EG-u-nu-latn). */
const LOCALE = "ar-EG-u-nu-latn";

export function formatTime(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return "";
  const d = new Date(ms), n = new Date(now);
  const sameDay = d.toDateString() === n.toDateString();
  if (sameDay) return d.toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date(n); yesterday.setDate(n.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "أمس";
  return d.toLocaleDateString(LOCALE, { day: "numeric", month: "short", ...(d.getFullYear() !== n.getFullYear() ? { year: "numeric" } : {}) });
}

export function formatFullTime(ms: number | null | undefined): string {
  if (!ms) return "";
  return new Date(ms).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const KIND_LABEL: Record<ConversationKind, string> = {
  announcement: "الإعلانات",
  team: "فريق الشركة",
  business: "قناة النشاط",
  group: "مجموعة",
  direct: "محادثة خاصة",
};

/** عنوان المحادثة للعرض — الإعلانات/الفريق بأسماء ثابتة، والباقي من السيرفر. */
export function conversationTitle(c: { kind: ConversationKind; title: string | null }): string {
  if (c.kind === "announcement") return "الإعلانات";
  if (c.kind === "team") return "فريق الشركة";
  return c.title?.trim() || KIND_LABEL[c.kind];
}

/** نص المعاينة في القائمة — نص عادي فقط، بلا تفاصيل تقنية. */
export function previewText(last: { kind: string; title: string | null; preview: string | null; deleted: boolean; senderName: string | null } | null): string {
  if (!last) return "لا رسائل بعد";
  if (last.deleted) return "رسالة محذوفة";
  const who = last.senderName ? `${last.senderName}: ` : "";
  if (last.kind === "voice") return `${who}رسالة صوتية`;
  if (last.kind === "attachment") return `${who}مرفق`;
  if (last.kind === "announcement") return `${who}${last.title ?? "إعلان"}`;
  return `${who}${last.preview ?? ""}`;
}

/** حالة الاتصال (navigator.onLine + أحداث online/offline). */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener("online", up); window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);
  return online;
}
