import { parsePasteMessage, type ParsedPaste } from "./pasteParser";
import { matchImportItem, isExactCatalogTerm, type MatchCatalog } from "./productMatching";
import {
  buildDraftLines,
  distributeSubtotal,
  expandSegments,
  allocateQuantities,
} from "../shared/orderLines";

/**
 * رسالة العميل الملصوقة → الحقول + سطور السلة مطابَقة على كتالوج النشاط.
 *
 * **ده المسار الوحيد.** `facebookEntry.parsePaste` بيجيب كتالوج نشاط الموظف وبيستدعي
 * الدالة دي وبس — مفيش توصيل تاني في الراوتر. والاختبارات بتستدعيها هي نفسها (أو
 * الـendpoint)، فمستحيل اختبار يعدّي على منطق مكتوب جوّاه بيختلف عن اللي في الإنتاج.
 * حارس المصدر في `pasteRealCase.guard.test.ts` بيثبت ده.
 *
 * `catalog` لازم يكون **كتالوج النشاط المعزول** — الدالة مابتعملش أي فلترة نطاق.
 */

export interface PasteMatch {
  productId: number;
  productName: string;
  variantId: number | null;
  sku: string | null;
  color: string | null;
  size: string | null;
  unitPrice: string | null;
}

export interface PasteLine {
  term: string;
  color: string | null;
  size: string | null;
  quantity: number;
  unitPrice: number;
  match: PasteMatch | null;
  matchReason: string | null;
}

export interface PasteResult {
  parsed: ParsedPaste;
  lines: PasteLine[];
  /** المطابقة المفردة القديمة — متسيبة للتوافق مع أي متصل قديم. */
  match: PasteMatch | null;
  matchReason: string | null;
}

function shape(m: ReturnType<typeof matchImportItem>): PasteMatch | null {
  return m.matched
    ? {
        productId: m.productId,
        productName: m.productName,
        variantId: m.variantId ?? null,
        sku: m.sku ?? null,
        color: m.color ?? null,
        size: m.size ?? null,
        unitPrice: m.unitPrice,
      }
    : null;
}

/** السطور من رسالة محلَّلة بالفعل. */
export function buildPasteLines(parsed: ParsedPaste, catalog: MatchCatalog): PasteLine[] {
  // **سطر لكل نوع مذكور.** مصدرين للسطور:
  //   • أزواج لون/مقاس متعددة («بيج مقاس 10 اسود مقاس 6») → سطر لكل زوج.
  //   • غير كده: أجزاء سطر المنتج بكمياتها («٢ ساده، 1 نقش وعين حورس»)، و«و» بتتفصل
  //     **ضد كتالوج النشاط** بمطابقة دقيقة، والكميات الناقصة من باقي «عدد القطع».
  const draft =
    parsed.colorSizePairs.length > 1
      ? buildDraftLines(parsed.productTerms, parsed.quantity, parsed.colorSizePairs)
      : (() => {
          const expanded = expandSegments(parsed.productSegments, t =>
            isExactCatalogTerm(t, catalog)
          );
          const lines = allocateQuantities(expanded, parsed.quantity, parsed.quantityGiven);
          // زوج لون/مقاس واحد بيتطبّق على السطر الوحيد بس — مايتنسخش على كل نوع.
          const pair = parsed.colorSizePairs[0];
          if (pair && lines.length === 1) {
            lines[0].color = pair.color || undefined;
            lines[0].size = pair.size || undefined;
          }
          return lines;
        })();

  // إجمالي **الأصناف** (مش شامل الشحن) بيتوزّع على القطع بالقرش.
  const { unitPrices } = distributeSubtotal(
    draft.map(l => l.quantity),
    parsed.itemsSubtotal
  );

  return draft.map((l, i) => {
    // كل سطر بلونه ومقاسه ونوعه هو. المطابقة على كتالوج النشاط الممرَّر بس.
    const m =
      l.term || l.color || l.size
        ? matchImportItem(
            {
              name: l.term,
              // النوع المذكور بيتبعت كـvariantText كمان، عشان يتطابق على اسم التركيبة
              // جوه المنتج لو المنتج اتحدد بطريقة تانية.
              variantText: l.term || undefined,
              color: l.color ?? null,
              size: l.size ?? null,
            },
            catalog
          )
        : null;
    return {
      term: l.term,
      color: l.color ?? null,
      size: l.size ?? null,
      quantity: l.quantity,
      unitPrice: unitPrices[i] ?? 0,
      match: m ? shape(m) : null,
      // سطر مش متطابق **بيفضل** بكميته وسعره، ومعلّم بسبب واضح للمراجعة.
      matchReason: m && !m.matched ? m.reason : l.term ? null : "اختر المنتج والنوع يدويًا",
    };
  });
}

/** نص خام → الحقول + السطور. ده اللي `facebookEntry.parsePaste` بيرجّعه بالظبط. */
export function analyzePaste(text: string, catalog: MatchCatalog): PasteResult {
  const parsed = parsePasteMessage(text);
  const lines = buildPasteLines(parsed, catalog);
  const legacy = matchImportItem(
    { name: parsed.productName, color: parsed.color, size: parsed.size },
    catalog
  );
  return {
    parsed,
    lines,
    match: shape(legacy),
    matchReason: legacy.matched ? null : legacy.reason,
  };
}
