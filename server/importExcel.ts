import type { Express, Request, Response } from "express";
import { requireAdminOrManager } from "./authMiddleware";
import multer from "multer";
import * as XLSX from "xlsx";
import * as db from "./db";
import { normalizeEgyptianPhone } from "../shared/phone";
import { findPotentialDuplicates, type ExistingOrderForDuplicateCheck } from "./duplicateDetection";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel" ||
      file.originalname.endsWith(".xlsx") ||
      file.originalname.endsWith(".xls")
    ) {
      cb(null, true);
    } else {
      cb(new Error("يرجى رفع ملف Excel فقط (.xlsx أو .xls)"));
    }
  },
});

// Normalize Egyptian governorate names
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

/**
 * Normalize Arabic text: unify hamza/alef, ta marbuta, alef maqsura
 */
function normalizeArabic(s: string): string {
  return s
    .replace(/[إأآا]/g, "ا")
    .replace(/[ةه]/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\u0622/g, "ا") // آ → ا
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Smart product matching: handles Easy Order format like
 * "اسورة نحاس آحمر طبي - نوع الحفر: ذكر التحصين"
 * Also handles variant column: "نوع الحفر: اية الكرسي" → "آية الكرسي"
 */

// خريطة أسماء بديلة للمنتجات (اسم بديل → جزء من اسم المنتج في قاعدة البيانات)
const PRODUCT_KEYWORD_MAP: Record<string, string> = {
  // آية الكرسي
  "اية الكرسي": "آية الكرسي",
  "آية الكرسي": "آية الكرسي",
  "ايه الكرسي": "آية الكرسي",
  "اايه الكرسي": "آية الكرسي",
  // ذكر التحصين
  "ذكر التحصين": "ذكر التحصين",
  "التحصين": "ذكر التحصين",
  // عين حورس
  "عين حورس": "عين حورس",
  "عين هورس": "عين حورس",
  // فالله خير حافظاً
  "فالله خير حافظا": "فالله خير حافظاً",
  "فالله خير حافظاً": "فالله خير حافظاً",
  "فالله": "فالله خير حافظاً",
  // منقوش
  "منقوش": "منقوش",
  // سادة
  "ساده": "سادة",
  "سادة": "سادة",
  // قل أعوذ
  "قل اعوذ": "قل أعوذ",
  "قل أعوذ": "قل أعوذ",
  "الفلق": "قل أعوذ",
  // إنه من سليمان
  "انه من سليمان": "إنه من سليمان",
  "إنه من سليمان": "إنه من سليمان",
  "سليمان": "إنه من سليمان",
  // كهيعص
  "كهيعص": "كهيعص",
};

function matchProduct(productNameRaw: string, products: any[], variantRaw?: string): any | null {
  if (!products.length) return null;

  const engravePatterns = [
    /نوع\s*الحفر\s*[:\-]\s*(.+)/,
    /الحفر\s*[:\-]\s*(.+)/,
    /النوع\s*[:\-]\s*(.+)/,
    /حفر\s*[:\-]\s*(.+)/,
  ];

  // Helper: try to match a single string against all products
  function tryMatch(text: string): any | null {
    if (!text) return null;
    const t = text.trim();
    const tNorm = normalizeArabic(t);

    // Exact
    let m = products.find(p => t === p.name || tNorm === normalizeArabic(p.name));
    if (m) return m;

    // Includes (both directions)
    m = products.find(p => t.includes(p.name) || p.name.includes(t));
    if (m) return m;

    // Normalized includes
    m = products.find(p => {
      const pn = normalizeArabic(p.name);
      return tNorm.includes(pn) || pn.includes(tNorm);
    });
    if (m) return m;

    // Keyword map lookup: map common aliases to canonical product name fragment
    const mappedName = PRODUCT_KEYWORD_MAP[t] || PRODUCT_KEYWORD_MAP[tNorm];
    if (mappedName) {
      const mappedNorm = normalizeArabic(mappedName);
      m = products.find(p => normalizeArabic(p.name).includes(mappedNorm));
      if (m) return m;
    }
    // Also check if any map key is contained in the text
    for (const [alias, canonical] of Object.entries(PRODUCT_KEYWORD_MAP)) {
      if (tNorm.includes(normalizeArabic(alias))) {
        const canonNorm = normalizeArabic(canonical);
        m = products.find(p => normalizeArabic(p.name).includes(canonNorm));
        if (m) return m;
      }
    }

    // Keyword match (all keywords must be present)
    for (const p of products) {
      const keywords = normalizeArabic(p.name).split(/\s+/).filter((w: string) => w.length > 2);
      if (keywords.length > 0 && keywords.every((kw: string) => tNorm.includes(kw))) return p;
    }

    return null;
  }

  const raw = (productNameRaw || "").trim();

  // 1) Try full combined string (product + variant)
  const variantFirst = (variantRaw || "").split("\n")[0].trim();
  if (variantFirst) {
    const combined = raw + " - " + variantFirst;
    const m = tryMatch(combined);
    if (m) return m;
  }

  // 2) Try product name alone
  const m1 = tryMatch(raw);
  if (m1) return m1;

  // 3) Extract engrave value from variant column
  if (variantFirst) {
    for (const pattern of engravePatterns) {
      const match = variantFirst.match(pattern);
      if (match) {
        const engraveName = match[1].trim();
        const m = tryMatch(engraveName);
        if (m) return m;
        // Special case: "سادة" (no "أسورة" prefix) → "أسورة سادة"
        if (normalizeArabic(engraveName) === normalizeArabic("سادة")) {
          const plain = products.find(p => normalizeArabic(p.name).includes(normalizeArabic("سادة")));
          if (plain) return plain;
        }
      }
    }
    // Also try variant directly
    const m2 = tryMatch(variantFirst);
    if (m2) return m2;
  }

  // 4) Extract engrave value from product name column
  for (const pattern of engravePatterns) {
    const match = raw.match(pattern);
    if (match) {
      const engraveName = match[1].trim();
      const m = tryMatch(engraveName);
      if (m) return m;
    }
  }

  // 5) Split by " - " and check each part
  const parts = raw.split(" - ").map((s: string) => s.trim());
  for (const part of parts) {
    const m = tryMatch(part);
    if (m) return m;
  }

  // 6) Normalize: strip bracelet prefix and match remainder
  const stripped = normalizeArabic(raw)
    .replace(/اسوره?\s*/g, "")
    .replace(/نحاس\s*/g, "")
    .replace(/احمر\s*/g, "")
    .replace(/طبي\s*/g, "")
    .replace(/نوع\s*الحفر\s*[:\-]?\s*/g, "")
    .replace(/[\-–—]\s*/g, "")
    .trim();
  if (stripped) {
    const m = tryMatch(stripped);
    if (m) return m;
  }

  // 7) Fallback: if product name looks like a generic bracelet with no engrave → "أسورة سادة"
  const rawNorm = normalizeArabic(raw);
  const isGenericBracelet = (
    rawNorm.includes("اسوره") ||
    rawNorm.includes("سوار") ||
    rawNorm.includes("نحاس")
  ) && !rawNorm.includes("حفر") && !variantFirst;
  if (isGenericBracelet) {
    const plain = products.find(p => normalizeArabic(p.name).includes("ساده"));
    if (plain) return plain;
  }

  return null;
}

function normalizeGov(raw: string): string {
  if (!raw) return "غير محدد";
  const trimmed = raw.trim();
  // Check direct match
  if (GOVERNORATE_MAP[trimmed]) return GOVERNORATE_MAP[trimmed];
  // Check partial match (city name might be embedded)
  for (const [key, val] of Object.entries(GOVERNORATE_MAP)) {
    if (trimmed.includes(key) || key.includes(trimmed)) return val;
  }
  // Return first word if it looks like a city name
  const firstWord = trimmed.split(/[\s,،]/)[0];
  if (GOVERNORATE_MAP[firstWord]) return GOVERNORATE_MAP[firstWord];
  return trimmed.length > 30 ? "غير محدد" : trimmed;
}

function normalizePhone(raw: string): string {
  return normalizeEgyptianPhone(raw);
}

function parseExcelRows(buffer: Buffer): {
  preview: any[];
  errors: string[];
} {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  if (rawRows.length < 2) {
    return { preview: [], errors: ["الملف فارغ أو لا يحتوي على بيانات"] };
  }

  const headers = rawRows[0].map((h: any) => String(h).trim().toLowerCase());
  const errors: string[] = [];
  const preview: any[] = [];

  // Column index mapping
  const colIdx = {
    id: headers.findIndex(h => h === "id"),
    status: headers.findIndex(h => h === "status"),
    fullName: headers.findIndex(h => h === "fullname" || h === "full name" || h === "name"),
    phone: headers.findIndex(h => h === "phone"),
    city: headers.findIndex(h => h === "city"),
    address: headers.findIndex(h => h === "address"),
    totalCost: headers.findIndex(h => h === "total cost" || h === "totalcost"),
    productName: headers.findIndex(h => h === "product name" || h === "productname"),
    variant: headers.findIndex(h => h === "variant"),
    quantity: headers.findIndex(h => h === "quantity"),
    sku: headers.findIndex(h => h === "sku"),
    itemPrice: headers.findIndex(h => h === "item price" || h === "itemprice"),
    note: headers.findIndex(h => h === "note" || h === "notes"),
    altPhone: headers.findIndex(h => h === "alt phone" || h === "altphone"),
    createdAt: headers.findIndex(h => h === "createdat" || h === "created at"),
    externalId: headers.findIndex(h => h === "external order id" || h === "externalorderid"),
    orderId: headers.findIndex(h => h === "order id" || h === "orderid"),
    utmCampaign: headers.findIndex(h => h === "utm campaign" || h === "utmcampaign"),
    utmSource: headers.findIndex(h => h === "utm source" || h === "utmsource"),
    ref: headers.findIndex(h => h === "ref" || h === "referral code"),
  };

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row || row.every((c: any) => !c)) continue;

    const get = (idx: number) => (idx >= 0 ? String(row[idx] ?? "").trim() : "");

    const customerName = get(colIdx.fullName);
    const customerPhoneRaw = get(colIdx.phone);
    // تنظيف رقم الهاتف: إزالة الرموز (* / - . ,) والمسافات، واستخراج أول رقم مصري صالح
    const customerPhone = normalizePhone(customerPhoneRaw);
    const city = get(colIdx.city);
    const address = get(colIdx.address);
    const totalCostRaw = get(colIdx.totalCost);
    const productNameRaw = get(colIdx.productName);
    const quantityRaw = get(colIdx.quantity);
    const externalId = get(colIdx.externalId) || get(colIdx.id);
    const orderId = get(colIdx.orderId); // UUID - unique per store
    const utmCampaign = get(colIdx.utmCampaign); // store name (e.g. "فرحات للنحاس")
    const utmSource = get(colIdx.utmSource);

    if (!customerName) {
      errors.push(`صف ${i + 1}: اسم العميل مفقود`);
      continue;
    }
    if (!customerPhone) {
      errors.push(`صف ${i + 1}: رقم الهاتف مفقود أو غير صالح (${customerPhoneRaw})`);
      continue;
    }

    // Handle multi-product rows (separated by \n)
    const productNames = productNameRaw.split("\n").map(s => s.trim()).filter(Boolean);
    const quantities = quantityRaw.split("\n").map(s => s.trim()).filter(Boolean);

    const mainProduct = productNames[0] || "غير محدد";
    const mainQty = parseInt(quantities[0] || "1") || 1;
    const totalQty = quantities.reduce((sum, q) => sum + (parseInt(q) || 1), 0);

    const totalAmount = parseFloat(totalCostRaw.replace(/[^0-9.]/g, "")) || 0;
    const governorate = normalizeGov(city);
    const notes = get(colIdx.note);
    const variantRaw = get(colIdx.variant); // full variant column (may have \n)
    const variantFirst = variantRaw.split("\n")[0].trim();

    // Build display productName: product + variant for readability
    const displayProductName = mainProduct + (variantFirst ? ` - ${variantFirst}` : "");

    preview.push({
      rowIndex: i + 1,
      externalId,
      orderId,
      utmCampaign,
      utmSource,
      customerName,
      customerPhone,
      customerAddress: address || city,
      governorate,
      productName: displayProductName,
      variantRaw,         // keep for smart matching
      quantity: totalQty || mainQty,
      totalAmount: totalAmount.toFixed(2),
      source: "easyorder",
      notes: notes || undefined,
      multiProduct: productNames.length > 1,
      allProducts: productNames,
    });
  }

  return { preview, errors };
}

export function registerImportRoutes(app: Express) {
  // Preview endpoint - parse without saving
  app.post(
    "/api/import/preview",
    requireAdminOrManager,
    upload.single("file"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "لم يتم رفع أي ملف" });
        }
        const { preview, errors } = parseExcelRows(req.file.buffer);
        return res.json({ preview, errors, total: preview.length });
      } catch (err: any) {
        return res.status(400).json({ error: err.message || "خطأ في قراءة الملف" });
      }
    }
  );

  // Import endpoint - save to database
  app.post(
    "/api/import/execute",
    requireAdminOrManager,
    upload.single("file"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "لم يتم رفع أي ملف" });
        }

        // تحديد النشاط المختار من الفلتر
        const businessId = req.body?.businessId ? parseInt(req.body.businessId) : 1;

        const { preview, errors } = parseExcelRows(req.file.buffer);

        if (preview.length === 0) {
          return res.json({ imported: 0, skipped: 0, errors });
        }

        let imported = 0;
        let skipped = 0;
        let duplicates = 0;
        const importErrors: string[] = [...errors];

        // Get all products for matching (filter by business if specified)
        const products = await db.getAllProducts(businessId || undefined);

        // جلب كل الأوردرات الموجودة لكشف التكرار
        const existingOrders = await db.getOrders({ limit: 100000 });
        const existingOrdersById = new Map(existingOrders.orders.map((o: any) => [o.id, o]));
        // ملاحظة: productId غير مُمرَّر عمدًا هنا — المطابقة تتم بالاسم مثل السلوك السابق تمامًا
        const existingForDuplicateCheck: ExistingOrderForDuplicateCheck[] = existingOrders.orders.map((o: any) => ({
          id: o.id,
          customerPhone: o.customerPhone,
          productName: o.productName,
          externalOrderId: o.externalOrderId,
        }));

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // كشف التكرار داخل الملف نفسه
        const fileUUIDs = new Set<string>();
        const filePhoneProductKeys = new Set<string>();

        for (const row of preview) {
          try {
            const phone = row.customerPhone.replace(/\s+/g, '');

            // كشف التكرار بالـ UUID (Order ID) فقط — فريد عالمياً بين كل الستورات
            // الـ ID الرقمي (externalId) ممكن يتكرر بين ستورين مختلفين فلا يصلح لكشف التكرار
            const uuid = row.orderId || '';

            const dbMatches = findPotentialDuplicates(
              { customerPhone: row.customerPhone, productName: row.productName, externalOrderId: uuid || undefined },
              existingForDuplicateCheck
            );

            const isDuplicateByUUID =
              Boolean(uuid) &&
              (dbMatches.some(m => m.signals.includes("sameExternalOrderId")) || fileUUIDs.has(uuid));

            if (isDuplicateByUUID) {
              duplicates++;
              importErrors.push(`صف ${row.rowIndex}: تم تخطيه - أوردر مكرر بالـ UUID (${uuid})`);
              continue;
            }

            // كشف التكرار بالهاتف + المنتج + نفس اليوم
            const phoneProductKey = `${phone}|${row.productName}`;
            const isDuplicateByPhoneProductToday = dbMatches.some(m => {
              if (!m.signals.includes("samePhoneAndProduct")) return false;
              const existingOrder = existingOrdersById.get(m.orderId) as any;
              if (!existingOrder) return false;
              const orderDate = new Date(existingOrder.createdAt);
              orderDate.setHours(0, 0, 0, 0);
              return orderDate.getTime() === today.getTime();
            });
            const isDuplicateByPhoneProduct = isDuplicateByPhoneProductToday || filePhoneProductKeys.has(phoneProductKey);
            if (isDuplicateByPhoneProduct) {
              duplicates++;
              importErrors.push(`صف ${row.rowIndex}: تم تخطيه - أوردر مكرر (نفس الهاتف + المنتج اليوم)`);
              continue;
            }

            // تسجيل لكشف التكرار داخل نفس الملف
            if (uuid) fileUUIDs.add(uuid);
            filePhoneProductKeys.add(phoneProductKey);

            // Find matching product using smart matching (pass variant for better accuracy)
            const matchedProduct = matchProduct(row.productName, products, row.variantRaw);
            if (!matchedProduct) {
              // Do NOT fallback to first product — report for manual review
              importErrors.push(`صف ${row.rowIndex}: منتج غير مطابق "${row.productName}" — يحتاج مراجعة يدوية`);
              skipped++;
              continue;
            }

            // دائماً نولد orderNumber تلقائي من السيستم — الـ ID الرقمي من Easy Order ممكن يتكرر بين ستورين
            const finalOrderNumber = await db.generateOrderNumber();

            // تحديد اسم البيدج/الكامبين من utm_campaign
            const utmStoreName = (row.utmCampaign || '').trim();
            const adName = utmStoreName || undefined;

            // تحديد المصدر كـ easyorder موحد
            const orderSource = 'easyorder' as const;

            await db.createOrder({
              orderNumber: finalOrderNumber,
              customerName: row.customerName,
              customerPhone: row.customerPhone,
              customerAddress: row.customerAddress,
              governorate: row.governorate,
              productId: matchedProduct.id,
              productName: row.productName,
              quantity: row.quantity,
              totalAmount: row.totalAmount,
              source: orderSource,
              status: "new",
              notes: row.notes,
              importRowIndex: row.rowIndex,
              externalOrderId: row.orderId || undefined,
              adName: adName || undefined,
              businessId: businessId,
            });
            imported++;
          } catch (err: any) {
            skipped++;
            importErrors.push(`صف ${row.rowIndex}: ${err.message}`);
          }
        }

        return res.json({ imported, skipped, duplicates, errors: importErrors });
      } catch (err: any) {
        return res.status(400).json({ error: err.message || "خطأ في استيراد الملف" });
      }
    }
  );
}

// ============================================================
// WhatsApp Group Import Parser
// ============================================================

/**
 * Parse a single WhatsApp order block text into structured data.
 * Format example:
 *   بيدج:  Nova    التاريخ: 21/4
 *   الاسم : هيثم محمد
 *   العنوان : ...
 *   رقم الفون(1): 01288215851
 *   رقم الفون(2):
 *   نوع المنتج :  أيه الكرسي وتحصين وساده عدد القطع:   3
 *   السعر:  380 الشحن: مجاني    الاجمالي: 380
 */
function parseWhatsAppBlock(text: string, rowIndex: number): {
  data: any | null;
  error: string | null;
} {
  if (!text || typeof text !== "string") return { data: null, error: `صف ${rowIndex}: نص فارغ` };

  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const fullText = text;

  // Helper: extract value after a label pattern
  function extract(patterns: RegExp[]): string {
    for (const pat of patterns) {
      const m = fullText.match(pat);
      if (m && m[1]) return m[1].trim();
    }
    return "";
  }

  // Page/badge name
  const pageName = extract([
    /بيدج\s*[:\-]\s*(.+?)(?:\s{2,}|\t|التاريخ|$)/,
    /بيدج\s*[:\-]\s*(.+)/,
  ]).split(/\s{2,}|\t/)[0].trim();

  // Customer name — يزيل رقم الهاتف لو كان في بداية الاسم
  let customerName = extract([
    /الاسم\s*[:\/\-]\s*(.+)/,
    /الاسم\s*[:\/\-]?\s*(.+)/,
  ]);
  // تنظيف: إزالة رقم هاتف من بداية الاسم (مثل: 01234محمد)
  customerName = customerName.replace(/^0[0-9]{9,10}\s*/, "").trim();
  // إزالة "الاسم" لو تكررت كـ prefix
  customerName = customerName.replace(/^الاسم\s*[:\/\-]?\s*/, "").trim();

  // Address
  const customerAddress = extract([
    /العنوان\s*\.?\s*[\/:\-]\s*(.+)/,
    /العنوان\s*[\/:\-]\s*(.+)/,
  ]);

  // Phone 1 — يدعم كل الأنماط:
  // 1. رقم الفون(1): 01234...
  // 2. رقم التليفون/01234... أو رقم التليفون:01234...
  // 3. الرقم مكتوب في سطر الاسم: الاسم:01234محمد
  // 4. الرقم في سطر منفصل بدون label
  let phone1Raw = extract([
    /رقم\s*الفون\s*\(1\)\s*[:\/\-]\s*(0[0-9]{9,10})/,
    /رقم\s*التليفون\s*[:\/\-]\s*(0[0-9]{9,10})/,
    /تليفون\s*[:\/\-]\s*(0[0-9]{9,10})/,
    /رقم\s*الفون\s*[:\/\-]\s*(0[0-9]{9,10})/,
  ]);
  // إذا لم يُعثر على رقم بـ label، ابحث عن رقم مصري في سطر الاسم
  if (!phone1Raw) {
    const nameLineMatch = fullText.match(/الاسم\s*[:\/\-]\s*(0[0-9]{9,10})/);
    if (nameLineMatch) phone1Raw = nameLineMatch[1];
  }
  // إذا لا يزال فارغاً، ابحث عن رقم في سطر منفصل (يبدأ بـ 01 ويكون 11 رقم)
  if (!phone1Raw) {
    const standaloneMatch = fullText.match(/(?:^|\n)\s*(01[0-9]{9})\s*(?:\n|$)/);
    if (standaloneMatch) phone1Raw = standaloneMatch[1];
  }
  // إذا لا يزال فارغاً، ابحث عن أي رقم مصري في النص كله
  if (!phone1Raw) {
    const anyPhoneMatch = fullText.match(/(01[0-9]{9})/);
    if (anyPhoneMatch) phone1Raw = anyPhoneMatch[1];
  }
  const customerPhone = normalizeEgyptianPhone(phone1Raw);

  // Phone 2 (optional)
  const phone2Raw = extract([
    /رقم\s*الفون\s*\(2\)\s*[:\-]\s*([0-9\s]+)/,
  ]);
  const customerPhone2 = normalizeEgyptianPhone(phone2Raw) || undefined;

  // Product + quantity — format: "نوع المنتج : xxx عدد القطع: N"
  const productMatch = fullText.match(
    /نوع\s*المنتج\s*[:\-]\s*(.+?)\s+عدد\s*القطع\s*[:\-]\s*(\d+)/
  );
  const productName = productMatch ? productMatch[1].trim() : extract([
    /نوع\s*المنتج\s*[:\-]\s*(.+)/,
  ]);
  const quantityRaw = productMatch ? productMatch[2] : extract([
    /عدد\s*القطع\s*[:\-]\s*(\d+)/,
  ]);
  const quantity = parseInt(quantityRaw) || 1;

  // Total amount — "الاجمالي: 380" or "الاجمالي:380"
  const totalRaw = extract([
    /الاجمالي\s*[:\-]\s*([0-9]+(?:\.[0-9]+)?)/,
    /الإجمالي\s*[:\-]\s*([0-9]+(?:\.[0-9]+)?)/,
  ]);
  const totalAmount = parseFloat(totalRaw) || 0;

  // Governorate: extract from address (first city-like word)
  const governorate = normalizeGov(customerAddress);

  // Validation
  if (!customerName) return { data: null, error: `صف ${rowIndex}: اسم العميل مفقود` };
  if (!customerPhone) return { data: null, error: `صف ${rowIndex}: رقم الهاتف مفقود` };
  if (!productName) return { data: null, error: `صف ${rowIndex}: اسم المنتج مفقود` };

  return {
    data: {
      rowIndex,
      externalId: "",
      customerName,
      customerPhone,
      customerPhone2,
      customerAddress,
      governorate,
      productName,
      quantity,
      totalAmount: totalAmount.toFixed(2),
      source: "facebook",
      pageName: pageName || undefined,
      notes: undefined,
      multiProduct: false,
      allProducts: [productName],
    },
    error: null,
  };
}

function parseWhatsAppExcel(buffer: Buffer): {
  preview: any[];
  errors: string[];
} {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rawRows: any[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });

  const errors: string[] = [];
  const preview: any[] = [];
  let rowIndex = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    if (!row) continue;
    // Find the cell with the order block text (column B = index 1)
    const cellText = row[1];
    if (!cellText || typeof cellText !== "string") continue;
    if (!cellText.includes("بيدج") && !cellText.includes("الاسم")) continue;

    rowIndex++;
    const { data, error } = parseWhatsAppBlock(cellText, rowIndex);
    if (error) {
      errors.push(error);
    } else if (data) {
      preview.push(data);
    }
  }

  if (preview.length === 0 && errors.length === 0) {
    errors.push("لم يتم العثور على أوردرات في الملف. تأكد من أن الملف بالصيغة الصحيحة.");
  }

  return { preview, errors };
}

export function registerWhatsAppImportRoutes(app: Express) {
  // Preview WhatsApp orders
  app.post(
    "/api/import/whatsapp/preview",
    requireAdminOrManager,
    upload.single("file"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "لم يتم رفع أي ملف" });
        }
        const { preview, errors } = parseWhatsAppExcel(req.file.buffer);
        return res.json({ preview, errors, total: preview.length });
      } catch (err: any) {
        return res.status(400).json({ error: err.message || "خطأ في قراءة الملف" });
      }
    }
  );

  // Execute WhatsApp import
  app.post(
    "/api/import/whatsapp/execute",
    requireAdminOrManager,
    upload.single("file"),
    async (req: Request, res: Response) => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "لم يتم رفع أي ملف" });
        }

        // تحديد النشاط المختار من الفلتر
        const businessId = req.body?.businessId ? parseInt(req.body.businessId) : 1;

        const { preview, errors } = parseWhatsAppExcel(req.file.buffer);

        if (preview.length === 0) {
          return res.json({ imported: 0, skipped: 0, errors });
        }

        let imported = 0;
        let skipped = 0;
        const importErrors: string[] = [...errors];

        const products = await db.getAllProducts(businessId || undefined);

        for (const row of preview) {
          try {
            const matchedProduct = matchProduct(row.productName, products);

            if (!matchedProduct) {
              importErrors.push(`صف ${row.rowIndex}: منتج غير مطابق "${row.productName}" — يحتاج مراجعة يدوية`);
              skipped++;
              continue;
            }

            const finalOrderNumber = await db.generateOrderNumber();

            await db.createOrder({
              orderNumber: finalOrderNumber,
              customerName: row.customerName,
              customerPhone: row.customerPhone,
              customerAddress: row.customerAddress,
              governorate: row.governorate,
              productId: matchedProduct.id,
              productName: row.productName,
              quantity: row.quantity,
              totalAmount: row.totalAmount,
              source: "facebook",
              status: "new",
              notes: row.notes,
              pageName: row.pageName || undefined,
              importRowIndex: row.rowIndex,
              businessId: businessId,
            });
            imported++;
          } catch (err: any) {
            skipped++;
            importErrors.push(`صف ${row.rowIndex}: ${err.message}`);
          }
        }

        return res.json({ imported, skipped, errors: importErrors });
      } catch (err: any) {
        return res.status(400).json({ error: err.message || "خطأ في استيراد الملف" });
      }
    }
  );
}
