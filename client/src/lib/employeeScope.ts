import type { QueryClient } from "@tanstack/react-query";

/**
 * هوية نطاق الموظف على العميل — **عشان حالة حساب ماتعيشش في حساب تاني على نفس الجهاز**.
 *
 * الحادثة اللي الملف ده بيقفلها: مفتاح المسودة كان ثابتًا (`manualEntryDraft`)، وكتالوج
 * شاشة الإدخال بيتخزّن في react-query تحت مفتاح **بلا أي هوية**، والخروج مكانش بيمسح ولا
 * واحد فيهم. فموظف نشاط A يشتغل على الجهاز، يخرج، يدخل موظف نشاط B — فيلاقي كتالوج A
 * معروضًا فورًا من الـcache ومسودة A مسترجعة، بما فيها منتجات وتركيبات مش بتاعة نشاطه.
 *
 * **دي طبقة واجهة بس.** العزل الحقيقي على السيرفر (`empScope` → نشاط الموظف)، والقيم
 * هنا مابتتبعتش كفلتر في أي استعلام — لو اتزوّرت في localStorage أقصى أثرها إن الواجهة
 * تمسح مسودتها. مفيش قرار صلاحية بيتبني عليها.
 */

export interface EmployeeScope {
  employeeId: number;
  businessId: number | null;
  tenantId: number | null;
}

export const EMPLOYEE_SESSION_KEY = "employee_session";
/** بادئة كل مسودات شاشة الإدخال — المفتاح الكامل بيتلزق بيه هوية النطاق. */
export const DRAFT_PREFIX = "manualEntryDraft:";

/** جلسة الموظف المخزّنة محليًا (اللي /login بيحطها). null لو مفيش/تالفة. */
export function readEmployeeScope(): EmployeeScope | null {
  try {
    const raw = localStorage.getItem(EMPLOYEE_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (typeof s?.id !== "number") return null;
    return {
      employeeId: s.id,
      businessId: typeof s.businessId === "number" ? s.businessId : null,
      tenantId: typeof s.tenantId === "number" ? s.tenantId : null,
    };
  } catch {
    return null;
  }
}

/** بصمة الحساب: tenant + نشاط + موظف. بتدخل في مفتاح المسودة ومفاتيح الـqueries. */
export function scopeFingerprint(s: EmployeeScope | null): string {
  if (!s) return "anon";
  return `t${s.tenantId ?? "x"}:b${s.businessId ?? "x"}:e${s.employeeId}`;
}

/** مفتاح مسودة شاشة الإدخال للحساب الحالي. */
export function draftKey(s: EmployeeScope | null): string {
  return `${DRAFT_PREFIX}${scopeFingerprint(s)}`;
}

/**
 * يمسح **كل** مسودات الحسابات التانية على الجهاز، ويسيب بتاعة الحساب الحالي بس.
 * `keep = null` معناها امسح الكل (خروج).
 */
export function purgeForeignDrafts(keep: EmployeeScope | null): void {
  try {
    const wanted = keep ? draftKey(keep) : null;
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      // المفتاح العام القديم بيتشال دايمًا — مالوش هوية فمستحيل نعرف صاحبه.
      if (k === "manualEntryDraft" || (k.startsWith(DRAFT_PREFIX) && k !== wanted))
        doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    // localStorage مقفول (وضع خاص/إعدادات المتصفح) — مفيش حالة محفوظة نمسحها أصلاً.
  }
}

/**
 * تغيّرت هوية الجلسة (دخول/خروج) → **امسح كل حالة العميل**: cache الاستعلامات كله
 * ومسودات الحسابات التانية. بنمسح الـcache بالكامل مش استعلامات مختارة، لأن قايمة
 * الاستعلامات اللي بتحمل بيانات نشاط بتكبر مع كل ميزة — والنسيان هو نفسه الثغرة.
 */
export function resetEmployeeClientState(
  queryClient: Pick<QueryClient, "clear">,
  keep: EmployeeScope | null
): void {
  queryClient.clear();
  purgeForeignDrafts(keep);
}

/**
 * يعقّم بنود مسودة مسترجعة مقابل كتالوج الحساب الحالي.
 *
 * درجتان، مش حذف للكل:
 *   • **المنتج نفسه مش في الكتالوج** → البند بيتشال (مفيش حاجة نبني عليها).
 *   • **المنتج سليم لكن التركيبة مش تابعة له** (أو مش موجودة) → بنمسح `variantId`
 *     والخصائص المشتقّة منه بس، وبنسيب المنتج والكمية والسعر، وبنعلّم السطر
 *     `needsVariantReview` عشان الموظف يختار النوع من جديد.
 *
 * الفرق مهم: حذف السطر كان بيضيّع على الموظف المنتج والكمية والسعر اللي كتبهم
 * عشان التركيبة بايظة لوحدها. السيرفر بيعيد التحقق من كل معرّف في الحالتين.
 */
export interface SanitizedDraftItem {
  /** التركيبة اتمسحت لأنها مش تابعة لمنتج البند — لازم اختيار جديد قبل الحفظ. */
  needsVariantReview?: boolean;
}

export function sanitizeDraftItems<
  T extends {
    productId?: number | null;
    variantId?: number | null;
    color?: string | null;
    size?: string | null;
    optionLabel?: string | null;
    sku?: string | null;
  },
>(
  items: T[],
  catalog: {
    products: { id: number }[];
    variants: { id: number; productId: number }[];
  }
): { items: (T & SanitizedDraftItem)[]; dropped: number; needsReview: number } {
  const productIds = new Set(catalog.products.map(p => p.id));
  const variantById = new Map(catalog.variants.map(v => [v.id, v.productId]));
  let dropped = 0;
  let needsReview = 0;
  const kept: (T & SanitizedDraftItem)[] = [];
  for (const it of items) {
    if (it.productId == null || !productIds.has(it.productId)) {
      dropped++;
      continue;
    }
    if (it.variantId == null) {
      kept.push(it);
      continue;
    }
    // التركيبة لازم تكون تابعة **لنفس المنتج** — نفس شرط السيرفر في addOrder.
    if (variantById.get(it.variantId) === it.productId) {
      kept.push(it);
      continue;
    }
    needsReview++;
    kept.push({
      ...it,
      variantId: undefined,
      color: null,
      size: null,
      sku: null,
      optionLabel: null,
      needsVariantReview: true,
    });
  }
  return { items: kept, dropped, needsReview };
}
