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

/**
 * عمليات الإنشاء (أوردر فيسبوك، إرسال الورشة — 0052): نفس العقد لكن المعرّف **محفوظ على الجهاز** أيضًا، فيبقى بعد انقطاع
 * الشبكة وحتى إعادة تحميل الصفحة: الرد الضائع بعد نجاح الحفظ ثم إعادة المحاولة = نفس المعرّف ⇒ نفس النتيجة بلا تكرار.
 * يتغيّر فقط عند النجاح (completeOperation) أو بدء عملية جديدة صراحةً (discardOperation). التخزين غير المتاح = ذاكرة فقط.
 */
const PERSIST_PREFIX = "matjarak:op:";
const persisted = new Set<string>();
function storage(): Storage | null { try { return globalThis.localStorage ?? null; } catch { return null; } }

export function persistentOperationIdFor(scope: string): string {
  let id: string | null = byScope.get(scope) ?? null;
  if (!id) {
    try { id = storage()?.getItem(PERSIST_PREFIX + scope) ?? null; } catch { id = null; }
    if (!id || !/^[A-Za-z0-9_-]{8,80}$/.test(id)) id = newId();
  }
  byScope.set(scope, id); persisted.add(scope);
  // كتابة دائمة في كل مرة (حتى لو كان في الذاكرة) — فلا يضيع بإعادة التحميل
  try { storage()?.setItem(PERSIST_PREFIX + scope, id); } catch { /* ذاكرة فقط */ }
  return id;
}

/** بدء عملية جديدة صراحةً (مسح النموذج، أو رفض «نفس المعرّف ببيانات مختلفة») — المعرّف التالي جديد. */
export function discardOperation(scope: string): void {
  byScope.delete(scope); persisted.delete(scope);
  try { storage()?.removeItem(PERSIST_PREFIX + scope); } catch { /* لا شيء */ }
}

/** يُستدعى عند نجاح أي mutation تحمل operationId — يحرّر النطاق للعملية التالية. */
export function completeOperation(operationId: unknown): void {
  if (typeof operationId !== "string") return;
  for (const [scope, id] of byScope) if (id === operationId) { if (persisted.has(scope)) discardOperation(scope); else byScope.delete(scope); }
}

/** للاختبارات: يحاكي إعادة تحميل الصفحة — يمسح الذاكرة فقط والتخزين يبقى. */
export function __forgetInMemoryForTests(scope: string): void { byScope.delete(scope); persisted.delete(scope); }

/** للاختبارات. */
export function __pendingOperationScopes(): string[] {
  return [...byScope.keys()];
}
