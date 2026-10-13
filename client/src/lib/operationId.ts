import { readEmployeeScope, scopeFingerprint } from "./employeeScope";

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
 * عمليات الإنشاء (أوردر فيسبوك، إرسال الورشة — 0052): نفس العقد لكن المعرّف **محفوظ في تخزين التبويب** (sessionStorage) أيضًا:
 *  • يبقى بعد انقطاع الشبكة وبعد إعادة تحميل نفس التبويب — الرد الضائع بعد نجاح الحفظ ثم إعادة المحاولة = نفس المعرّف ⇒ نفس النتيجة.
 *  • لكل تبويب معرّفه: تبويبان = عمليتان مستقلتان لا تتشاركان مفتاحًا. التبويب **المكرَّر** (المتصفح ينسخ sessionStorage) يُكتشف
 *    بحارس التبويبات: يعلن معرّف تبويبه، وإن ردّ تبويب حيّ يملك نفس المعرّف يُسقط المفاتيح المنسوخة ويأخذ معرّف تبويب جديدًا.
 *  • النطاق يحمل الشركة والنشاط والمستخدم ونوع العملية والمسودة (يبنيه المستدعي).
 *  • يتغيّر فقط عند النجاح (completeOperation) أو بإجراء صريح من المستخدم (discardOperation: «بدء عملية جديدة»/«مسح النموذج») —
 *    **لا** يتغيّر تلقائيًا عند CONFLICT. التخزين غير المتاح = ذاكرة فقط.
 */
const PERSIST_PREFIX = "matjarak:op:";
const TAB_KEY = "matjarak:op-tab";
const VALID_ID = /^[A-Za-z0-9_-]{8,80}$/;
const persisted = new Set<string>();
function storage(): Storage | null { try { return globalThis.sessionStorage ?? null; } catch { return null; } }

type TabMessage = { type: "hello" | "taken"; tabId: string; nonce: string };
type TabChannel = { postMessage(m: TabMessage): void; onmessage: ((ev: { data: unknown }) => void) | null; close?(): void };

/** حارس التبويب المكرَّر — مستقل وقابل للاختبار (تخزين وقناة محقونان). */
export function createTabGuard(deps: { storage: () => Storage | null; channel: TabChannel | null; onDuplicate: () => void }) {
  const read = () => { try { return deps.storage()?.getItem(TAB_KEY) ?? null; } catch { return null; } };
  const write = (v: string) => { try { deps.storage()?.setItem(TAB_KEY, v); } catch { /* ذاكرة فقط */ } };
  let tabId = read();
  if (!tabId || !VALID_ID.test(tabId)) { tabId = newId(); write(tabId); }
  const nonce = newId();
  const guard = { get tabId() { return tabId as string; } };
  if (deps.channel) {
    deps.channel.onmessage = ev => {
      const m = ev.data as TabMessage;
      if (!m || typeof m !== "object") return;
      if (m.type === "hello" && m.tabId === tabId && m.nonce !== nonce) deps.channel!.postMessage({ type: "taken", tabId: m.tabId, nonce: m.nonce });
      else if (m.type === "taken" && m.nonce === nonce) { tabId = newId(); write(tabId); deps.onDuplicate(); }
    };
    deps.channel.postMessage({ type: "hello", tabId, nonce });
  }
  return guard;
}

/** التبويب نسخة من تبويب حيّ: المفاتيح المنسوخة تخص عمليات التبويب الأصلي — تُسقط هنا (والأصلي يحتفظ بها). */
function dropCopiedKeys(): void {
  const s = storage();
  try { if (s) for (let i = s.length - 1; i >= 0; i--) { const k = s.key(i); if (k?.startsWith(PERSIST_PREFIX)) s.removeItem(k); } } catch { /* لا شيء */ }
  for (const sc of persisted) byScope.delete(sc);
  persisted.clear();
}

let tabGuardStarted = false;
function ensureTabGuard(): void {
  if (tabGuardStarted) return;
  tabGuardStarted = true;
  let channel: TabChannel | null = null;
  try { const BC = (globalThis as any).BroadcastChannel; if (BC && typeof window !== "undefined") channel = new BC("matjarak-op-tabs"); } catch { channel = null; }
  createTabGuard({ storage, channel, onDuplicate: dropCopiedKeys });
}
if (typeof window !== "undefined") ensureTabGuard();

export function persistentOperationIdFor(scope: string): string {
  ensureTabGuard();
  let id: string | null = byScope.get(scope) ?? null;
  if (!id) {
    try { id = storage()?.getItem(PERSIST_PREFIX + scope) ?? null; } catch { id = null; }
    if (!id || !VALID_ID.test(id)) id = newId();
  }
  byScope.set(scope, id); persisted.add(scope);
  // كتابة في كل مرة (حتى لو كان في الذاكرة) — فلا يضيع بإعادة تحميل التبويب
  try { storage()?.setItem(PERSIST_PREFIX + scope, id); } catch { /* ذاكرة فقط */ }
  return id;
}

/** بدء عملية جديدة **بإجراء صريح من المستخدم** («بدء عملية جديدة»، «مسح النموذج») — المعرّف التالي جديد. */
export function discardOperation(scope: string): void {
  byScope.delete(scope); persisted.delete(scope);
  try { storage()?.removeItem(PERSIST_PREFIX + scope); } catch { /* لا شيء */ }
}

/** هوية الجلسة للنطاق: الموظف (شركة/نشاط/موظف) أو المالك (مستخدم/شركة) — حتى لا يرث حساب آخر على نفس التبويب مفتاحًا. */
export function sessionFingerprint(): string {
  const emp = readEmployeeScope();
  if (emp) return scopeFingerprint(emp);
  try {
    const u = JSON.parse(globalThis.localStorage?.getItem("manus-runtime-user-info") ?? "null");
    if (u && (typeof u.id === "number" || typeof u.id === "string")) return `t${u.tenantId ?? "x"}:u${u.id}`;
  } catch { /* بلا هوية */ }
  return "anon";
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
