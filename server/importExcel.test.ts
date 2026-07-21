import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";

// Re-export the parsing logic for testing
function normalizeGov(raw: string): string {
  if (!raw) return "غير محدد";
  const GOVERNORATE_MAP: Record<string, string> = {
    "القاهره": "القاهرة",
    "الجيزه": "الجيزة",
    "الاسكندريه": "الإسكندرية",
    "الاسكندرية": "الإسكندرية",
    "اسكندرية": "الإسكندرية",
    "Alexandria": "الإسكندرية",
    "اسيوط": "أسيوط",
    "الاسيوط": "أسيوط",
    "اسوان": "أسوان",
    "الاسماعيليه": "الإسماعيلية",
    "الاسماعيلية": "الإسماعيلية",
    "اسماعيلية": "الإسماعيلية",
    "الأقصر": "الأقصر",
    "الفيوم": "الفيوم",
    "فيوم": "الفيوم",
    "المنيا": "المنيا",
    "منيا": "المنيا",
    "بنى سويف": "بني سويف",
    "بني سويف": "بني سويف",
    "سوهاج": "سوهاج",
    "قنا": "قنا",
    "الدقهليه": "الدقهلية",
    "الدقهلية": "الدقهلية",
    "دقهلية": "الدقهلية",
    "الغربيه": "الغربية",
    "الغربية": "الغربية",
    "غربية": "الغربية",
    "المنوفيه": "المنوفية",
    "المنوفية": "المنوفية",
    "منوفية": "المنوفية",
    "القليوبيه": "القليوبية",
    "القليوبية": "القليوبية",
    "قليوبية": "القليوبية",
    "الشرقيه": "الشرقية",
    "الشرقية": "الشرقية",
    "شرقية": "الشرقية",
    "البحيره": "البحيرة",
    "البحيرة": "البحيرة",
    "بحيرة": "البحيرة",
    "كفر الشيخ": "كفر الشيخ",
    "كفرالشيخ": "كفر الشيخ",
    "دمياط": "دمياط",
    "بورسعيد": "بورسعيد",
    "السويس": "السويس",
    "سيناء": "شمال سيناء",
    "شمال سيناء": "شمال سيناء",
    "جنوب سيناء": "جنوب سيناء",
    "مطروح": "مطروح",
    "الوادى الجديد": "الوادي الجديد",
    "الوادي الجديد": "الوادي الجديد",
    "البحر الاحمر": "البحر الأحمر",
    "البحر الأحمر": "البحر الأحمر",
  };
  const trimmed = raw.trim();
  if (GOVERNORATE_MAP[trimmed]) return GOVERNORATE_MAP[trimmed];
  for (const [key, val] of Object.entries(GOVERNORATE_MAP)) {
    if (trimmed.includes(key) || key.includes(trimmed)) return val;
  }
  const firstWord = trimmed.split(/[\s,،]/)[0];
  if (GOVERNORATE_MAP[firstWord]) return GOVERNORATE_MAP[firstWord];
  return trimmed.length > 30 ? "غير محدد" : trimmed;
}

function createTestExcel(rows: any[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["ID", "Status", "FullName", "Phone", "City", "Address", "Total Cost",
     "Product Cost", "Shipping Cost", "Coupon", "Coupon Discount",
     "Product Name", "Variant", "Quantity", "SKU", "Item Price", "CreatedAt"],
    ...rows,
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return Buffer.from(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
}

describe("normalizeGov", () => {
  it("normalizes common misspellings", () => {
    expect(normalizeGov("الاسكندريه")).toBe("الإسكندرية");
    expect(normalizeGov("اسكندرية")).toBe("الإسكندرية");
    expect(normalizeGov("Alexandria")).toBe("الإسكندرية");
    expect(normalizeGov("اسيوط")).toBe("أسيوط");
    expect(normalizeGov("الاسماعيليه")).toBe("الإسماعيلية");
    expect(normalizeGov("القاهره")).toBe("القاهرة");
    expect(normalizeGov("الجيزه")).toBe("الجيزة");
  });

  it("returns unchanged for already correct names", () => {
    expect(normalizeGov("القاهرة")).toBe("القاهرة");
    expect(normalizeGov("الجيزة")).toBe("الجيزة");
    expect(normalizeGov("الإسكندرية")).toBe("الإسكندرية");
  });

  it("returns غير محدد for empty input", () => {
    expect(normalizeGov("")).toBe("غير محدد");
  });

  it("returns غير محدد for very long unrecognized strings", () => {
    const longStr = "هذا نص طويل جداً لا يمثل اسم محافظة صحيح في مصر";
    expect(normalizeGov(longStr)).toBe("غير محدد");
  });
});

describe("Excel file creation", () => {
  it("creates valid xlsx buffer", () => {
    const buf = createTestExcel([
      [1, "pending", "أحمد محمد", "01012345678", "القاهرة", "مدينة نصر", 250, 250, 0, "", 0,
       "اسورة نحاس", "سادة", "1", "", "250", new Date()],
    ]);
    expect(buf).toBeDefined();
    expect(buf.length).toBeGreaterThan(0);
  });

  it("parses created excel correctly", () => {
    const buf = createTestExcel([
      [1, "pending", "محمد علي", "01098765432", "الجيزة", "6 أكتوبر", 480, 480, 0, "", 0,
       "اسورة نحاس آحمر طبي", "منقوش", "2", "", "240", new Date()],
    ]);
    const wb = XLSX.read(buf, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
    expect(rows.length).toBe(2); // header + 1 data row
    expect(rows[1][2]).toBe("محمد علي");
    expect(rows[1][3]).toBe("01098765432");
  });
});

describe("Multi-product order parsing", () => {
  it("handles newline-separated products", () => {
    const productNames = "اسورة نحاس آحمر طبي\nاسورة نحاس آحمر طبي";
    const quantities = "1\n1";
    const products = productNames.split("\n").map(s => s.trim()).filter(Boolean);
    const qtys = quantities.split("\n").map(s => parseInt(s.trim()) || 1);
    const totalQty = qtys.reduce((sum, q) => sum + q, 0);
    expect(products.length).toBe(2);
    expect(totalQty).toBe(2);
  });

  it("handles single product without newlines", () => {
    const productNames = "اسورة نحاس آحمر طبي";
    const quantities = "1";
    const products = productNames.split("\n").map(s => s.trim()).filter(Boolean);
    const qtys = quantities.split("\n").map(s => parseInt(s.trim()) || 1);
    expect(products.length).toBe(1);
    expect(qtys[0]).toBe(1);
  });
});

// =====================================================
// Updated matchProduct with variant support (mirrors importExcel.ts)
// =====================================================
function normalizeArabic(s: string): string {
  return s
    .replace(/[إأآا]/g, "ا")
    .replace(/[ةه]/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

function matchProduct(productNameRaw: string, products: any[], variantRaw?: string): any | null {
  if (!products.length) return null;

  const engravePatterns = [
    /نوع\s*الحفر\s*[:\-]\s*(.+)/,
    /الحفر\s*[:\-]\s*(.+)/,
    /النوع\s*[:\-]\s*(.+)/,
    /حفر\s*[:\-]\s*(.+)/,
  ];

  function tryMatch(text: string): any | null {
    if (!text) return null;
    const t = text.trim();
    const tNorm = normalizeArabic(t);

    let m = products.find((p: any) => t === p.name || tNorm === normalizeArabic(p.name));
    if (m) return m;

    m = products.find((p: any) => t.includes(p.name) || p.name.includes(t));
    if (m) return m;

    m = products.find((p: any) => {
      const pn = normalizeArabic(p.name);
      return tNorm.includes(pn) || pn.includes(tNorm);
    });
    if (m) return m;

    for (const p of products) {
      const keywords = normalizeArabic(p.name).split(/\s+/).filter((w: string) => w.length > 2);
      if (keywords.length > 0 && keywords.every((kw: string) => tNorm.includes(kw))) return p;
    }

    return null;
  }

  const raw = (productNameRaw || "").trim();
  const variantFirst = (variantRaw || "").split("\n")[0].trim();

  // 1) Try combined
  if (variantFirst) {
    const m = tryMatch(raw + " - " + variantFirst);
    if (m) return m;
  }

  // 2) Try product name alone
  const m1 = tryMatch(raw);
  if (m1) return m1;

  // 3) Extract engrave value from variant
  if (variantFirst) {
    for (const pattern of engravePatterns) {
      const match = variantFirst.match(pattern);
      if (match) {
        const engraveName = match[1].trim();
        const m = tryMatch(engraveName);
        if (m) return m;
        // "سادة" → "أسورة سادة"
        if (normalizeArabic(engraveName) === normalizeArabic("سادة")) {
          const plain = products.find((p: any) => normalizeArabic(p.name).includes(normalizeArabic("سادة")));
          if (plain) return plain;
        }
      }
    }
    const m2 = tryMatch(variantFirst);
    if (m2) return m2;
  }

  // 4) Extract engrave from product name
  for (const pattern of engravePatterns) {
    const match = raw.match(pattern);
    if (match) {
      const m = tryMatch(match[1].trim());
      if (m) return m;
    }
  }

  // 5) Split by " - " and check each part
  const parts = raw.split(" - ").map((s: string) => s.trim());
  for (const part of parts) {
    const m = tryMatch(part);
    if (m) return m;
  }

  // 6) Strip bracelet prefix
  const stripped = normalizeArabic(raw)
    .replace(/اسوره?\s*/g, "")
    .replace(/نحاس\s*/g, "")
    .replace(/احمر\s*/g, "")
    .replace(/طبي\s*/g, "")
    .replace(/نوع\s*الحفر\s*[:\-]?\s*/g, "")
    .replace(/[-–—]\s*/g, "")
    .trim();
  if (stripped) {
    const m = tryMatch(stripped);
    if (m) return m;
  }

  return null;
}

const DB_PRODUCTS = [
  { id: 1, name: 'أسورة سادة' },
  { id: 2, name: 'آية الكرسي' },
  { id: 3, name: 'ذكر التحصين' },
  { id: 4, name: 'فالله خير حافظاً' },
  { id: 5, name: 'منقوش' },
  { id: 6, name: 'عين حورس' },
  { id: 7, name: 'أسورة إنه من سليمان' },
  { id: 8, name: 'أسورة كهيعص' },
];

describe("Smart Product Matching - productName only (old format)", () => {
  it("يطابق Easy Order format: اسورة نحاس أحمر طبي - نوع الحفر: ذكر التحصين", () => {
    const result = matchProduct("اسورة نحاس أحمر طبي - نوع الحفر: ذكر التحصين", DB_PRODUCTS);
    expect(result).toBeDefined();
    expect(result!.name).toBe("ذكر التحصين");
  });

  it("يطابق Easy Order format: اسورة نحاس أحمر طبي - نوع الحفر: اية الكرسي", () => {
    const result = matchProduct("اسورة نحاس أحمر طبي - نوع الحفر: اية الكرسي", DB_PRODUCTS);
    expect(result).toBeDefined();
    expect(result!.name).toBe("آية الكرسي");
  });

  it("يطابق اسم منتج مباشر: ذكر التحصين", () => {
    const result = matchProduct("ذكر التحصين", DB_PRODUCTS);
    expect(result).toBeDefined();
    expect(result!.name).toBe("ذكر التحصين");
  });

  it("يطابق منتج سادة من variant keyword", () => {
    const result = matchProduct("اسورة نحاس أحمر طبي - سادة", DB_PRODUCTS);
    expect(result).toBeDefined();
    expect(result!.name).toBe("أسورة سادة");
  });

  it("يطابق منتج منقوش", () => {
    const result = matchProduct("اسورة نحاس أحمر طبي - نوع الحفر: منقوش", DB_PRODUCTS);
    expect(result).toBeDefined();
    expect(result!.name).toBe("منقوش");
  });

  it("يطابق عين حورس", () => {
    const result = matchProduct("اسورة نحاس أحمر طبي - نوع الحفر: عين حورس", DB_PRODUCTS);
    expect(result).toBeDefined();
    expect(result!.name).toBe("عين حورس");
  });

  it("يطابق فالله خير حافظاً", () => {
    const result = matchProduct("اسورة نحاس أحمر طبي - نوع الحفر: فالله خير حافظاً", DB_PRODUCTS);
    expect(result).toBeDefined();
    expect(result!.name).toBe("فالله خير حافظاً");
  });

  it("يطابق أسورة كهيعص", () => {
    const result = matchProduct("اسورة نحاس أحمر طبي - كهيعص", DB_PRODUCTS);
    expect(result).toBeDefined();
    expect(result!.name).toBe("أسورة كهيعص");
  });

  it("يطابق أسورة إنه من سليمان", () => {
    const result = matchProduct("اسورة نحاس أحمر طبي - إنه من سليمان", DB_PRODUCTS);
    expect(result).toBeDefined();
    expect(result!.name).toBe("أسورة إنه من سليمان");
  });

  it("يرجع null لمنتج غير موجود", () => {
    const result = matchProduct("منتج غير موجود أبداً", DB_PRODUCTS);
    expect(result).toBeNull();
  });

  it("يرجع null لنص فارغ", () => {
    const result = matchProduct("", DB_PRODUCTS);
    expect(result).toBeNull();
  });
});

describe("Smart Product Matching - variant column (new Easy Order format)", () => {
  // هذا هو الفورمات الجديد: productName = "اسورة نحاس آحمر طبي", variant = "نوع الحفر: اية الكرسي "
  it("يطابق آية الكرسي من variant column", () => {
    const result = matchProduct(
      "اسورة نحاس آحمر طبي",
      DB_PRODUCTS,
      "نوع الحفر: اية الكرسي "
    );
    expect(result).toBeDefined();
    expect(result!.name).toBe("آية الكرسي");
  });

  it("يطابق سادة من variant column → أسورة سادة", () => {
    const result = matchProduct(
      "اسورة نحاس آحمر طبي",
      DB_PRODUCTS,
      "نوع الحفر: سادة "
    );
    expect(result).toBeDefined();
    expect(result!.name).toBe("أسورة سادة");
  });

  it("يطابق ذكر التحصين من variant column", () => {
    const result = matchProduct(
      "اسورة نحاس آحمر طبي",
      DB_PRODUCTS,
      "نوع الحفر: ذكر التحصين "
    );
    expect(result).toBeDefined();
    expect(result!.name).toBe("ذكر التحصين");
  });

  it("يطابق فالله خير حافظا (بدون همزة) من variant column", () => {
    const result = matchProduct(
      "اسورة نحاس آحمر طبي",
      DB_PRODUCTS,
      "نوع الحفر: فالله خير حافظا"
    );
    expect(result).toBeDefined();
    expect(result!.name).toBe("فالله خير حافظاً");
  });

  it("يطابق عين حورس من variant column", () => {
    const result = matchProduct(
      "اسورة نحاس آحمر طبي",
      DB_PRODUCTS,
      "نوع الحفر: عين حورس"
    );
    expect(result).toBeDefined();
    expect(result!.name).toBe("عين حورس");
  });

  it("يطابق منقوش من variant column", () => {
    const result = matchProduct(
      "اسورة نحاس آحمر طبي",
      DB_PRODUCTS,
      "نوع الحفر: منقوش"
    );
    expect(result).toBeDefined();
    expect(result!.name).toBe("منقوش");
  });

  it("يطابق multi-line variant (يأخذ السطر الأول فقط)", () => {
    const result = matchProduct(
      "اسورة نحاس آحمر طبي",
      DB_PRODUCTS,
      "نوع الحفر: سادة \nنوع الحفر: اية الكرسي "
    );
    // يأخذ السطر الأول = سادة
    expect(result).toBeDefined();
    expect(result!.name).toBe("أسورة سادة");
  });

  it("يرجع null إذا لم يوجد تطابق في variant أيضاً", () => {
    const result = matchProduct(
      "اسورة نحاس آحمر طبي",
      DB_PRODUCTS,
      "نوع الحفر: نقش غير موجود"
    );
    expect(result).toBeNull();
  });
});

describe("Phone normalization", () => {
  it("removes spaces from phone numbers", () => {
    const phone = "012 21110069";
    const normalized = phone.replace(/\s+/g, "");
    expect(normalized).toBe("01221110069");
  });

  it("handles phone with country code", () => {
    const phone = "+201012345678";
    const normalized = phone.replace(/\s+/g, "");
    expect(normalized).toBe("+201012345678");
  });
});
