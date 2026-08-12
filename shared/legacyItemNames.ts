/**
 * الصفوف القديمة اللي نوع الحفر متلزّق جوه اسمها.
 *
 * قبل الإصلاح، البند الجاي من الموقع كان بيتخزّن باسم مركّب:
 *
 *     productName = "أسورة نحاس - ذكر التحصين"
 *     variantId   = <ذكر التحصين>
 *
 * نفس المعلومة في مكانين. الملف ده بيقرر **مين يستاهل يتصلّح ومين لأ** — والقرار
 * منفصل عن قاعدة البيانات عن قصد: تصنيف بيمس بيانات إنتاج لازم يكون قابل للاختبار
 * بالتشغيل، مش موصوف في تعليق جنب استعلام.
 *
 * **مفيش قص نص أعمى هنا.** الصف مابيتصلّحش غير لما نقدر **نثبت** الاسم الصح من
 * الكتالوج: المنتج موجود، والزيادة اللي في الاسم هي بالظبط نوع من أنواع نفس المنتج.
 * أي حاجة غير كده بتتساب زي ما هي وبتتعرض للمالك.
 */

/** الفاصل الوحيد المعتبر. أي شكل تاني معناه إن الاسم اتكتب بإيد ومش نمط معروف. */
export const NAME_SEPARATOR = " - ";

export type ItemNameStatus = "clean" | "safe" | "ambiguous";

export type ItemNameInput = {
  /** الاسم المتخزّن في `order_items.productName`. */
  currentName: string;
  /** اسم المنتج من `products.name` — `null` يعني المنتج مش موجود. */
  canonicalProductName: string | null;
  /** هل الصف مربوط بمنتج أصلاً؟ */
  hasProductId: boolean;
  /**
   * أسماء **كل** أنواع المنتج ده من `product_variants`.
   *
   * مش نوع الصف الحالي بس: الصف المسموم ساعات بيبقى فيه نوع قديم في الاسم ونوع جديد
   * في `variantId` — وده بالظبط اللي بيحصل لما الموظف يغيّر النوع. لو الزيادة نوع
   * معروف للمنتج ده، يبقى إثباتها قايم.
   */
  productVariantNames: string[];
};

export type ItemNameVerdict = {
  status: ItemNameStatus;
  /** الاسم اللي هيتكتب — للـ`safe` بس. */
  proposedName: string | null;
  /** سبب القرار، بالعربي، للعرض في التقرير. */
  reason: string;
};

/**
 * القرار لصف واحد.
 *
 * التسلسل مقصود: كل خطوة بتشيل احتمال، واللي بيوصل لآخر سطر يبقى إحنا **مش** متأكدين
 * منه — فبيتساب.
 */
export function classifyItemName(input: ItemNameInput): ItemNameVerdict {
  const current = input.currentName.trim();

  if (!input.hasProductId) {
    return {
      status: "ambiguous",
      proposedName: null,
      reason: "البند مش مربوط بمنتج — مفيش اسم canonical نقارن بيه",
    };
  }
  if (!input.canonicalProductName) {
    return {
      status: "ambiguous",
      proposedName: null,
      reason: "المنتج مش موجود في الكتالوج (اتمسح؟) — الاسم المحفوظ هو كل اللي عندنا",
    };
  }

  const canonical = input.canonicalProductName.trim();
  if (!canonical) {
    return {
      status: "ambiguous",
      proposedName: null,
      reason: "اسم المنتج في الكتالوج فاضي",
    };
  }

  if (current === canonical) {
    return { status: "clean", proposedName: null, reason: "الاسم مطابق للكتالوج" };
  }

  // الاسم لازم يبدأ باسم المنتج بالحرف. لو مابيبدأش بيه، يبقى ده اسم تاني خالص —
  // منتج اتغيّر اسمه، أو اسم اتكتب بإيد — والتصحيح هنا هيمسح معلومة مش هيصلّح واحدة.
  if (!current.startsWith(canonical + NAME_SEPARATOR)) {
    return {
      status: "ambiguous",
      proposedName: null,
      reason: `الاسم مش «${canonical}» + نوع — مايتقصّش على الأعمى`,
    };
  }

  const suffix = current.slice(canonical.length + NAME_SEPARATOR.length).trim();
  if (!suffix) {
    return {
      status: "ambiguous",
      proposedName: null,
      reason: "فيه فاصل من غير نوع بعده",
    };
  }

  // الإثبات: الزيادة لازم تكون **نوع معروف لنفس المنتج**.
  //
  // مش نوع الصف الحالي بالذات — الصف المسموم فيه نوع قديم في الاسم ونوع جديد في
  // `variantId`، ودي الحالة اللي إحنا بنصلّحها أصلاً.
  const known = input.productVariantNames.some(
    name => (name ?? "").trim() === suffix
  );
  if (!known) {
    return {
      status: "ambiguous",
      proposedName: null,
      reason: `«${suffix}» مش نوع معروف للمنتج ده — ممكن يكون تخصيص مكتوب بإيد`,
    };
  }

  return {
    status: "safe",
    proposedName: canonical,
    reason: `الزيادة «${suffix}» نوع معروف للمنتج — الاسم الصح مثبت من الكتالوج`,
  };
}

/** إحصاء نتيجة التصنيف — للتقرير. */
export function summariseVerdicts(verdicts: ItemNameVerdict[]) {
  return {
    total: verdicts.length,
    clean: verdicts.filter(v => v.status === "clean").length,
    safe: verdicts.filter(v => v.status === "safe").length,
    ambiguous: verdicts.filter(v => v.status === "ambiguous").length,
  };
}
