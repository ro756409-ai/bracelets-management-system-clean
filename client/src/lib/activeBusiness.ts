import type { QueryClient } from "@tanstack/react-query";
import { DRAFT_PREFIX } from "./employeeScope";

/**
 * النشاط الفعّال (activeBusinessId) على العميل — قواعد نقية قابلة للاختبار بلا React.
 *
 * **القاعدة:** الأنشطة المتاحة بتيجي من السيرفر بنطاق الجلسة (`businesses.activeList`)؛
 * العميل بيختار من بينها بس ومابيوسّعش حاجة — السيرفر بيعيد فحص أي businessId
 * (`scopeBusinessId`). نشاط واحد متاح = بيتحدد تلقائيًا بلا ضغطة (مالك بنشاط واحد،
 * أو موظف مربوط بنشاطه).
 */

/** علامة النشاط الفعّال في مفتاح المسودة — تبديل النشاط مايرجّعش مسودة نشاط تاني. */
export const ACTIVE_BUSINESS_TAG = ":ab";

/**
 * يقرّر النشاط الفعّال من القايمة المتاحة والاختيار المخزّن:
 *   • نشاط واحد → هو (تلقائيًا، حتى لو المخزّن غيره).
 *   • أكتر من نشاط → المخزّن لو لسه متاح، وإلا undefined («كل الأنشطة»/لم يُختر).
 *   • القايمة لسه ماوصلتش (فاضية) → المخزّن كما هو لحد ما توصل.
 */
export function resolveActiveBusinessId(
  available: { id: number }[],
  stored: number | undefined
): number | undefined {
  if (available.length === 0) return stored;
  if (available.length === 1) return available[0].id;
  return stored != null && available.some(b => b.id === stored) ? stored : undefined;
}

/** مفتاح مسودة شاشة الإدخال للحساب + النشاط الفعّال + القالب. */
export function activeDraftKey(
  accountDraftKey: string,
  activeBusinessId: number | undefined,
  entryMode: string
): string {
  return `${accountDraftKey}${ACTIVE_BUSINESS_TAG}${activeBusinessId ?? "x"}:${entryMode}`;
}

/**
 * يمسح مسودات الإدخال اللي مش بتاعة النشاط الفعّال (وأي مسودة بلا علامة نشاط —
 * مالهاش صاحب معروف). `keep = undefined` = امسح كل المسودات.
 */
export function purgeDraftsForOtherBusinesses(keep: number | undefined): void {
  try {
    const wanted = keep != null ? `${ACTIVE_BUSINESS_TAG}${keep}:` : null;
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(DRAFT_PREFIX)) continue;
      if (wanted == null || !k.includes(wanted)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* localStorage مقفول — مفيش مسودات نمسحها */
  }
}

/**
 * تبديل النشاط الفعّال = **كل بيانات النشاط السابق تتشال من العميل**: cache
 * الاستعلامات بيتصفّر (والفعّال منها بيتحمّل تاني بالنطاق الجديد) والمسودات التانية
 * بتتمسح. مش استعلامات مختارة — القايمة بتكبر مع كل ميزة والنسيان هو الثغرة.
 */
export function resetForBusinessSwitch(
  queryClient: Pick<QueryClient, "resetQueries">,
  nextBusinessId: number | undefined
): void {
  purgeDraftsForOtherBusinesses(nextBusinessId);
  void queryClient.resetQueries();
}
