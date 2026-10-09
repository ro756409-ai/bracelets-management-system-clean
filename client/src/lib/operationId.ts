/**
 * معرّف العملية (Idempotency) لأفعال الأوردر — **ثابت طوال دورة العملية**، لا جديد مع كل نقرة.
 *
 * `operationIdFor(scope)` يرجّع نفس المعرّف لنفس النطاق (مثل `confirm:123`) حتى تنجح العملية: الضغط المزدوج
 * وإعادة المحاولة بعد خطأ شبكة يرسلان نفس المعرّف، والسيرفر يعيدها Replay بلا تكرار. عند **النجاح** فقط
 * يُستهلك المعرّف (مستمع MutationCache في main.tsx)، فالعملية التالية على نفس الأوردر تأخذ معرّفًا جديدًا.
 * الأزرار نفسها معطلة أثناء isPending — هذا حماية إضافية لا بديل عنها.
 */
const byScope = new Map<string, string>();

function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, "");
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function operationIdFor(scope: string): string {
  let id = byScope.get(scope);
  if (!id) { id = newId(); byScope.set(scope, id); }
  return id;
}

/** يُستدعى عند نجاح أي mutation تحمل operationId — يحرّر النطاق للعملية التالية. */
export function completeOperation(operationId: unknown): void {
  if (typeof operationId !== "string") return;
  for (const [scope, id] of byScope) if (id === operationId) byScope.delete(scope);
}

/** للاختبارات. */
export function __pendingOperationScopes(): string[] {
  return [...byScope.keys()];
}
