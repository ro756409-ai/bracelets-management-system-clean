import { describe, it, expect } from "vitest";
import fs from "fs";
import * as XLSX from "xlsx";
import { execSync } from "child_process";
import {
  readSheetRows, rowsFromSheet, parseEasyOrderRows, markExisting, matchRowItems, summarize, rowReportLine,
  classifyPhone, resolveLocation, mapColumns, GOV_REVIEW_REASON,
} from "./easyOrderImport";
import type { MatchCatalog } from "./productMatching";

/**
 * قراءة/تصنيف ملف Easy Order — نقي (بلا قاعدة بيانات). الملف الحقيقي من Production
 * بيتقرا لو موجود على الجهاز؛ الباقي على ملفات مبنية في الاختبار.
 */
const REAL_PATH = "/Users/apple/Downloads/1790763367920093571-orders-2026-09-30.xlsx";
const HAS_REAL = fs.existsSync(REAL_PATH);

const HEADERS = ["ID", "Status", "FullName", "Phone", "City", "Address", "Total Cost", "Product Cost", "Shipping Cost", "Coupon", "Coupon Discount", "Product Name", "Variant", "Quantity", "SKU", "Item Price", "CreatedAt", "Extra Data", "Extra Data2", "Alt Phone", "Note", "Ref", "Utm Source", "Utm Campaign", "Payment Method", "Payment Status", "Funnel ID", "Order ID", "Referral Code", "External Order ID"];

/** يبني ملفًا بنفس أعمدة Easy Order. */
function buildXlsx(rows: Record<string, string>[]): Buffer {
  const aoa = [HEADERS, ...rows.map(r => HEADERS.map(h => r[h] ?? ""))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
const base = (o: Partial<Record<string, string>> = {}): Record<string, string> => ({
  ID: "451", Status: "pending", FullName: "عميل", Phone: "01012345678", City: "", Address: "الجيزة الهرم شارع 5",
  "Total Cost": "600", "Product Name": "بدلة اطفالي", Variant: "المقاس: من 6 ل 8 سنين اللون: آسود", Quantity: "1", SKU: "", "Item Price": "550",
  "Order ID": "uuid-451", "External Order ID": "", ...o,
});

const CATALOG: MatchCatalog = {
  products: [{ id: 1, name: "بدلة اطفالي", sku: null, price: "550", isActive: true } as any],
  variants: [
    { id: 11, productId: 1, name: null, sku: "AFK-BLK-8", price: "550", color: "أسود", size: "8", isActive: true },
    { id: 12, productId: 1, name: null, sku: "AFK-BLK-12", price: "550", color: "أسود", size: "12", isActive: true },
    { id: 13, productId: 1, name: null, sku: "AFK-BEG-10", price: "550", color: "بيج", size: "10", isActive: true },
  ] as any,
};
const classify = (buf: Buffer, existing = new Set<string>()) =>
  markExisting(parseEasyOrderRows(readSheetRows(buf)).rows, existing).map(r => matchRowItems(r, CATALOG));

describe("🔑 قراءة الملف", () => {
  it("🔑 المدى المعلن (!ref/dimension) = A1 لكن الخلايا موجودة لحد آخر صف → كل الصفوف بتتقرا", () => {
    const buf = buildXlsx([base(), base({ ID: "452", "Order ID": "uuid-452" }), base({ ID: "453", "Order ID": "uuid-453" })]);
    const wb = XLSX.read(buf, { type: "buffer" }); const ws = wb.Sheets.Sheet1;
    ws["!ref"] = "A1"; // زي ملفات Easy Order: dimension غلط والخلايا كلها موجودة
    expect(XLSX.utils.sheet_to_json(ws, { header: 1 }).length).toBe(1); // القراءة الساذجة بتشوف صفًا واحدًا
    const rows = rowsFromSheet(ws);
    expect(rows.length).toBe(4); // header + 3
    expect(parseEasyOrderRows(rows).rows.length).toBe(3);
  });
  it("🔑 الصفوف الفارغة بس هي اللي بتتجاهل، وأسماء الأعمدة بتتوحّد (حالة الأحرف/المسافات)", () => {
    const aoa = [["full name", "PHONE", "Product Name", "Quantity", "Order ID", "Address"], ["أ", "01011111111", "بدلة اطفالي", "1", "u1", "القاهرة"], ["", "", "", "", "", ""], ["ب", "01022222222", "بدلة اطفالي", "2", "u2", "الجيزة"]];
    const ws = XLSX.utils.aoa_to_sheet(aoa); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "S");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const col = mapColumns(aoa[0]);
    expect([col.fullName, col.phone, col.productName, col.quantity, col.orderId]).toEqual([0, 1, 2, 3, 4]);
    const { rows } = parseEasyOrderRows(readSheetRows(buf));
    expect(rows.map(r => [r.rowIndex, r.customerName, r.totalQuantity])).toEqual([[2, "أ", 1], [4, "ب", 2]]);
  });
  it("🔒 الهاتف نص كما هو: رقم مصري يُطبَّع؛ رقم بلا صفر أو أجنبي يبقى نصًا للمراجعة بلا اختراع صفر", () => {
    expect(classifyPhone("01095286405")).toEqual({ phone: "01095286405", valid: true });
    expect(classifyPhone("+20 109 528 6405")).toEqual({ phone: "01095286405", valid: true });
    expect(classifyPhone("10903863290")).toEqual({ phone: "10903863290", valid: false });
    expect(classifyPhone("96401950100")).toEqual({ phone: "96401950100", valid: false });
    expect(classifyPhone("١٠٤٠١٠٤٦٦٣٠")).toEqual({ phone: "10401046630", valid: false });
  });
});

describe("🔑 الأوردر متعدد الأصناف (newline، index-by-index)", () => {
  it("🔑 منتجان + نوعان + كميتان → بندان صحيحان ومجموع الكميات = 2", () => {
    const rows = classify(buildXlsx([base({ "Product Name": "بدلة اطفالي\nبدلة اطفالي", Variant: "المقاس: من10 ل 12 سنه اللون: آسود \nالمقاس: من 6 ل 8 سنين اللون: آسود ", Quantity: "1\n1", SKU: "\n", "Item Price": "550\n550" })]));
    const r = rows[0];
    expect(r.status).toBe("new"); expect(r.multiProduct).toBe(true);
    expect(r.items.map(it => [it.index, it.quantity, it.color, it.size, it.match?.variantId])).toEqual([[1, 1, "آسود", "من10 ل 12 سنه", 12], [2, 1, "آسود", "من 6 ل 8 سنين", 11]]);
    expect(r.totalQuantity).toBe(2);
  });
  it("🔒 عدد المنتجات ≠ عدد الأنواع/الكميات → مرفوض بسبب واضح، بلا دمج ولا تخمين", () => {
    const rows = classify(buildXlsx([base({ "Product Name": "بدلة اطفالي\nبدلة اطفالي", Variant: "المقاس: من 6 ل 8 سنين اللون: آسود", Quantity: "1\n1\n1" })]));
    expect(rows[0].status).toBe("rejected");
    expect(rows[0].rejectReasons.join(" ")).toContain("عدد الأنواع (1) لا يساوي عدد المنتجات (2)");
    expect(rows[0].rejectReasons.join(" ")).toContain("عدد الكميات (3) لا يساوي عدد المنتجات (2)");
    expect(rows[0].items).toEqual([]);
  });
  it("🔒 صنف غير موجود في كتالوج النشاط → الصف مرفوض بسبب يذكر رقم الصنف", () => {
    const rows = classify(buildXlsx([base({ "Product Name": "بدلة اطفالي\nمنتج غريب", Variant: "المقاس: من 6 ل 8 سنين اللون: آسود\nالمقاس: 40", Quantity: "1\n1", "Item Price": "550\n100" })]));
    expect(rows[0].status).toBe("rejected");
    expect(rows[0].rejectReasons[0]).toContain("الصنف رقم 2 «منتج غريب»");
  });
});

describe("🔑 المحافظة والمدينة", () => {
  it("🔑 City فارغة والعنوان فيه محافظة معروفة → تتحدد (يقين)", () => {
    expect(resolveLocation("", "بني سويف مركز الواسطى قريه الحومه")).toMatchObject({ governorate: "بني سويف", resolved: true });
    expect(resolveLocation("", "محافظه قنا - مركز دشنا - شارع مصر أسوان")).toMatchObject({ governorate: "قنا", resolved: true });
    expect(resolveLocation("الجيزة", "شارع 5")).toMatchObject({ governorate: "الجيزة", resolved: true });
  });
  it("🔒 عنوان غير قابل للمطابقة أو ملتبس → review بسبب «المحافظة غير محددة — راجع العنوان»، ولا محافظة خاطئة", () => {
    const rows = classify(buildXlsx([base({ Address: "Maadi Street 77" }), base({ ID: "452", "Order ID": "u2", Address: "القاهره جسر السويس شارع جمال" })]));
    for (const r of rows) {
      expect(r.status).toBe("review"); expect(r.governorate).toBe(""); expect(r.reviewReasons).toContain(GOV_REVIEW_REASON);
    }
  });
});

describe("🔒 الهاتف غير الصالح والتكرار", () => {
  it("🔒 هاتف غير صالح → الصف للمراجعة بسطر تقرير «الصف N — الأوردر ID — …»، وباقي الصفوف سليمة", () => {
    const rows = classify(buildXlsx([base(), base({ ID: "414", "Order ID": "u414", Phone: "10903863290" }), base({ ID: "453", "Order ID": "u453" })]));
    expect(rows.map(r => r.status)).toEqual(["new", "review", "new"]);
    expect(rows[1].phone).toBe("10903863290");
    expect(rowReportLine(rows[1])).toBe("الصف 3 — الأوردر 414 — رقم الهاتف غير صالح: 10903863290");
  });
  it("🔒 Order ID موجود مسبقًا أو مكرر داخل الملف → existing (مايتكتبش)", () => {
    const rows = classify(buildXlsx([base(), base({ ID: "452", "Order ID": "uuid-451" }), base({ ID: "453", "Order ID": "uuid-old" })]), new Set(["uuid-old"]));
    expect(rows.map(r => r.status)).toEqual(["new", "existing", "existing"]);
    expect(rows[1].rejectReasons[0]).toContain("مكرر داخل الملف");
    expect(rows[2].rejectReasons[0]).toContain("موجود مسبقًا");
    expect(summarize(rows)).toEqual({ new: 1, review: 0, existing: 2, rejected: 0 });
  });
});

describe.runIf(HAS_REAL)("🔑 الملف الحقيقي (Production 2026-09-30)", () => {
  const buf = fs.readFileSync(REAL_PATH);
  it("🔑 92 صفًا رغم dimension=A1 داخل XML، 16 متعدد الأصناف، Order ID فريد للكل", () => {
    const xml = execSync(`unzip -p "${REAL_PATH}" xl/worksheets/sheet1.xml`).toString("utf8").slice(0, 600);
    expect(xml).toContain('<dimension ref="A1">'); // المعلن في الملف الحقيقي
    const { rows } = parseEasyOrderRows(readSheetRows(buf));
    expect(rows.length).toBe(92);
    expect(rows.filter(r => r.multiProduct).length).toBe(16);
    expect(new Set(rows.map(r => r.orderKey)).size).toBe(92);
    expect(rows.every(r => /^[0-9a-f-]{36}$/.test(r.orderKey))).toBe(true);
  });
  it("🔑 4 هواتف غير صالحة للمراجعة بلا تعديل، وCity فارغة والمحافظة من العنوان لأغلب الصفوف", () => {
    const { rows } = parseEasyOrderRows(readSheetRows(buf));
    const badPhones = rows.filter(r => !r.phoneValid);
    expect(badPhones.map(r => [r.rowIndex, r.idRaw, r.phone])).toEqual([[39, "414", "10903863290"], [45, "408", "96401950100"], [57, "396", "10401046630"], [58, "395", "10401046630"]]);
    expect(rows.every(r => r.city === "")).toBe(true);
    expect(rows.filter(r => r.governorateResolved).length).toBeGreaterThanOrEqual(80);
    expect(rows.filter(r => !r.governorateResolved).every(r => r.reviewReasons.includes(GOV_REVIEW_REASON))).toBe(true);
  });
  it("🔑 بكتالوج 8 تركيبات (لون × مقاس) كل الصفوف تتطابق: 77 جديد + 15 مراجعة، صفر مرفوض؛ الأصناف المتعددة بندان", () => {
    const catalog: MatchCatalog = {
      products: [{ id: 1, name: "بدلة اطفالي", sku: null, price: "550", isActive: true } as any],
      variants: [] as any,
    };
    let id = 10;
    for (const color of ["أسود", "بيج"]) for (const size of ["6", "8", "10", "12"]) (catalog.variants as any[]).push({ id: id++, productId: 1, name: null, sku: `AFK-${color}-${size}`, price: "550", color, size, isActive: true });
    const rows = markExisting(parseEasyOrderRows(readSheetRows(buf)).rows, new Set()).map(r => matchRowItems(r, catalog));
    expect(summarize(rows)).toEqual({ new: 77, review: 15, existing: 0, rejected: 0 });
    const multi = rows.filter(r => r.multiProduct);
    expect(multi.every(r => r.items.length >= 2 && r.items.every(it => it.match) && r.totalQuantity === r.items.reduce((s, it) => s + it.quantity, 0))).toBe(true);
  });
});
