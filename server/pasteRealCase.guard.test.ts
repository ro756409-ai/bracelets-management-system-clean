import { describe, it, expect } from "vitest";
import fs from "fs";

/**
 * حارس: اختبارات اللصق بتضرب **مسار الإنتاج الحقيقي** — مش نسخة من المنطق جوه الاختبار.
 *
 * الخطر اللي بيقفله: اختبار بيركّب parser + مطابقة + توزيع بنفسه يقدر ينجح بينما
 * الـendpoint نفسه متوصّل غلط. فبنثبت ٣ حاجات بالمصدر:
 *   ١. الـendpoint بيستدعي `analyzePaste` وبس — مفيش منطق تحليل/مطابقة مكرر في الراوتر.
 *   ٢. اختبار DB بيستدعي الـendpoints الحقيقية عبر `appRouter.createCaller`.
 *   ٣. ملفات الاختبار مابتعرّفش دوال تحليل/مطابقة/توزيع خاصة بيها.
 */

const routers = fs.readFileSync("server/routers.ts", "utf-8");
const pasteLines = fs.readFileSync("server/pasteLines.ts", "utf-8");
const dbTest = fs.readFileSync("server/pasteRealCase.db.test.ts", "utf-8");
const unitTest = fs.readFileSync("server/pasteParserRealCase.test.ts", "utf-8");

function endpointBlock(): string {
  const start = routers.indexOf("parsePaste: employeePortalProcedure");
  expect(start).toBeGreaterThan(-1);
  const end = routers.indexOf("}),", start);
  return routers.slice(start, end);
}

describe("🔒 الـendpoint بيفوّض لمسار إنتاج واحد", () => {
  it("🔒 parsePaste بيفوّض لـanalyzePaste(input.text, catalog) وanalyzePasteV2 على نفس الكتالوج", () => {
    const block = endpointBlock();
    expect(block).toContain("analyzePaste(input.text, catalog)");
    expect(block).toContain("analyzePasteV2(input.text, catalog");
  });
  it("🔒 مفيش منطق تحليل/مطابقة مكرر جوه الـendpoint", () => {
    const block = endpointBlock();
    for (const fn of [
      "parsePasteMessage(", "matchImportItem(", "expandSegments(",
      "allocateQuantities(", "distributeSubtotal(", "buildDraftLines(",
    ]) {
      expect(block, fn).not.toContain(fn);
    }
  });
  it("🔒 الكتالوج من نطاق نشاط الموظف — مش من الـinput", () => {
    const block = endpointBlock();
    expect(block).toContain("employeeCatalogBusinessIds(empScope(ctx))");
    expect(block).toContain("getMatchCatalog(undefined, businessIds)");
  });
  it("🔑 analyzePaste بتستخدم الـparser والمطابقة والتوزيع الحقيقيين", () => {
    expect(pasteLines).toContain("parsePasteMessage(text)");
    expect(pasteLines).toContain("buildPasteLines(parsed, catalog)");
    expect(pasteLines).toContain("expandSegments(parsed.productSegments");
    expect(pasteLines).toContain("allocateQuantities(expanded, parsed.quantity, parsed.quantityGiven)");
    expect(pasteLines).toContain("distributeSubtotal(");
    expect(pasteLines).toContain("matchImportItem(");
  });
});

describe("🔒 اختبار DB بيضرب الـendpoints الحقيقية", () => {
  it("🔒 بيستخدم appRouter.createCaller", () => {
    expect(dbTest).toContain('import { appRouter } from "./routers"');
    expect(dbTest).toContain("appRouter.createCaller(");
  });
  it("🔒 بيستدعي facebookEntry.parsePaste و facebookEntry.addOrder", () => {
    expect(dbTest).toContain(".facebookEntry.parsePaste({ text: REAL })");
    expect(dbTest).toContain(".facebookEntry.addOrder(");
  });
  it("🔒 بيقرا النتيجة من قاعدة البيانات مش من الذاكرة", () => {
    expect(dbTest).toContain("getOrderItemsForOrders(");
    expect(dbTest).toContain(".select().from(orders)");
  });
});

describe("🔒 ملفات الاختبار مابتعيدش تنفيذ المنطق", () => {
  // أي تعريف دالة بالأسماء دي جوه الاختبار = نسخة موازية ممكن تختلف عن الإنتاج.
  const forbidden = /\b(?:function|const)\s+(parse\w*|match\w*|allocate\w*|expand\w*|distribute\w*|build\w*Lines|analyze\w*)\b/g;
  for (const [name, src] of [
    ["pasteRealCase.db.test.ts", dbTest],
    ["pasteParserRealCase.test.ts", unitTest],
  ] as const) {
    it(`🔒 ${name} مافيهوش دوال تحليل/مطابقة خاصة`, () => {
      expect(src.match(forbidden) ?? []).toEqual([]);
    });
  }
  it("🔑 الاختبار غير الـDB بيستدعي analyzePaste (نفس اللي الـendpoint بيرجّعه)", () => {
    expect(unitTest).toContain('import { analyzePaste } from "./pasteLines"');
    expect(unitTest).toContain("analyzePaste(REAL, CATALOG)");
  });
});
