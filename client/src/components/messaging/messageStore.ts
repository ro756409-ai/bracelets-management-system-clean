/**
 * دمج رسائل المحادثة المفتوحة — منطق نقي (بلا React) قابل للاختبار:
 *   • القائمة مرتبة تصاعديًا بالمعرّف وبلا تكرار؛ النسخة الأحدث للرسالة تكسب (تعديل/حذف/تفاعل/اطلاع).
 *   • الـPolling يجلب أحدث صفحة: يحدّث ما عندنا ويضيف الجديد. لو جاءت صفحة كاملة **كلها** أحدث من آخر ما
 *     عندنا فهناك فجوة → نملؤها بـafterId حتى نلحق (لا رسائل مفقودة).
 *   • الصفحات الأقدم (beforeId) تُضاف في البداية دون المساس بما وصل أثناء التحميل.
 */
export type HasId = { id: number };

export function mergeById<T extends HasId>(current: readonly T[], incoming: readonly T[]): T[] {
  if (!incoming.length) return current as T[];
  const map = new Map<number, T>();
  for (const m of current) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m); // الأحدث يكسب
  return [...map.values()].sort((a, b) => a.id - b.id);
}

export const maxId = (list: readonly HasId[]) => (list.length ? list[list.length - 1].id : 0);
export const minId = (list: readonly HasId[]) => (list.length ? list[0].id : 0);

/**
 * دمج أحدث صفحة من الـPolling. `gapAfter` ≠ null = هناك رسائل بين آخر ما عندنا وبداية الصفحة → اجلب
 * afterId=gapAfter حتى تصل الصفحة الأحدث.
 */
export function mergeLatestPage<T extends HasId>(current: readonly T[], page: readonly T[], pageHasMore: boolean): { messages: T[]; gapAfter: number | null } {
  // المعرّفات عامة عبر كل المحادثات (غير متتالية)، فالحكم الوحيد الصحيح: الصفحة لا تحتوي أي رسالة نعرفها
  // وهناك أقدم منها (hasMore) ⇒ ربما رسائل بين آخر ما عندنا وبدايتها.
  const ourMax = maxId(current);
  const gap = current.length > 0 && pageHasMore && page.length > 0 && !page.some(m => m.id <= ourMax);
  return { messages: mergeById(current, page), gapAfter: gap ? ourMax : null };
}

/** هل المستخدم قريب من أسفل القائمة (فيُسمح بالتحريك التلقائي لآخر رسالة)؟ */
export function isNearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, threshold = 120): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/** قرار التحريك لآخر رسالة بعد تحديث: أول فتح، أو المستخدم قريب من الأسفل، أو أرسل بنفسه. */
export function shouldStickToBottom(o: { firstLoad: boolean; nearBottom: boolean; sentByMe: boolean }): boolean {
  return o.firstLoad || o.sentByMe || o.nearBottom;
}

/**
 * «تمت القراءة» — علامة **واحدة** على آخر رسالة لي قرأها الطرف الآخر (محادثة خاصة فقط). المحذوفة ورسائل
 * النظام لا تحمل العلامة؛ بلا مؤشر قراءة للطرف الآخر (أو في المجموعات/الاطلاع) = لا علامة.
 */
export function readReceiptMessageId(messages: readonly { id: number; mine: boolean; deletedAt: number | null; kind: string }[], peerLastReadMessageId: number | null | undefined): number | null {
  if (!peerLastReadMessageId) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.mine && m.deletedAt == null && m.kind !== "system" && m.id <= peerLastReadMessageId) return m.id;
  }
  return null;
}
