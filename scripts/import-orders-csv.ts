/**
 * Structured orders CSV importer (orders_data.csv — one clean row per order).
 *
 * This is a DIFFERENT source shape from scripts/import-legacy-orders.ts (which
 * exists to reconstruct wrapped/split rows from كل_الأوردرات.xlsx). This file's
 * rows are already well-formed — one row per order, one column per field — so
 * no token-stream reconstruction is needed, just direct column mapping.
 *
 * Default mode is DRY RUN — it never writes to the database unless invoked
 * explicitly with --commit. Always run without --commit first and review the
 * report before ever passing --commit.
 *
 * Usage:
 *   Dry run (safe, default, no writes):
 *     tsx scripts/import-orders-csv.ts --file "/path/to/orders_data.csv"
 *
 *   Commit (writes to DB — requires migration 0022 already applied):
 *     tsx scripts/import-orders-csv.ts --file "..." --commit --business-id=1 --performed-by=<employeeId>
 *
 *   Rollback a previous commit batch (preview, then require --confirm to actually delete):
 *     tsx scripts/import-orders-csv.ts --rollback <batchId> --performed-by=<employeeId>
 *     tsx scripts/import-orders-csv.ts --rollback <batchId> --performed-by=<employeeId> --confirm
 *
 * ==================== Status mapping (approved) ====================
 * The source has three separate status columns (confirmation / preparation /
 * shipping) where orders.status is a single field. The highest stage reached
 * wins, in this priority order:
 *   حالة الشحن: "🏁 تم التسليم" → delivered | "📍 مشحون" → shipped
 *   حالة التجهيز: "🚚 جاهز للشحن" → preparing | "📦 في التجهيز" → confirmed
 *   حالة التأكيد: "✅ تأكيد" → confirmed | "📅 تأجيل" → postponed |
 *                 "✗ إلغاء" → cancelled | "⏳ معلق" → new
 *
 * "السعر" is treated as the order's total amount (not a per-unit price) —
 * the values observed (e.g. 301, 405, 456 EGP) are consistent with full order
 * totals for this product line, not unit prices.
 *
 * "سبب الإلغاء/التأجيل" has free-text values that don't match the
 * orders.cancelReason enum (price/not_serious/wrong_number/duplicate), so it
 * is preserved verbatim in `notes` instead of being forced into that enum.
 *
 * "رقم الشحنة" maps to orders.bostaTrackingNumber (a tracking reference, not
 * this deployment's own Bosta shipment id).
 */
import "dotenv/config";
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { normalizeEgyptianPhone } from "../shared/phone";
import { getDb, createOrder } from "../server/db";
import { orders, products, importBatches } from "../drizzle/schema";
import { eq, sql as drizzleSql } from "drizzle-orm";

// ==================== CLI args ====================
const args = process.argv.slice(2);
function argValue(name: string, def?: string): string | undefined {
  const withEq = args.find(a => a.startsWith(`--${name}=`));
  if (withEq) return withEq.split("=").slice(1).join("=");
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1];
  return def;
}
const FILE = argValue("file")!;
const COMMIT = args.includes("--commit");
const BUSINESS_ID = Number(argValue("business-id", "1"));
const PERFORMED_BY = argValue("performed-by");
const ROLLBACK_BATCH_ID = argValue("rollback");
const CONFIRM_ROLLBACK = args.includes("--confirm");
const REPORT_DIR = argValue(
  "report-dir",
  "/private/tmp/claude-501/-Users-apple-Downloads---------------------------------------------7-/d651f46a-7f5e-48cf-a9f4-254d156a62e4/scratchpad"
)!;

// ==================== Known value maps ====================
const SOURCE_MAP: Record<string, string> = {
  "Easy Order": "easyorder",
  "Shopify": "shopify",
  "واتساب": "whatsapp",
};

const CONFIRM_STATUS_MAP: Record<string, string> = {
  "⏳ معلق": "new",
  "✅ تأكيد": "confirmed",
  "✗ إلغاء": "cancelled",
  "📅 تأجيل": "postponed",
};
const PREP_STATUS_MAP: Record<string, string> = {
  "📦 في التجهيز": "confirmed",
  "🚚 جاهز للشحن": "preparing",
};
const SHIPPING_STATUS_MAP: Record<string, string> = {
  "📍 مشحون": "shipped",
  "🏁 تم التسليم": "delivered",
};

const GOVERNORATE_NORMALIZE: Record<string, string> = {
  "بور سعيد": "بورسعيد",
};
const KNOWN_GOVERNORATES = new Set([
  "القاهرة", "الجيزة", "الإسكندرية", "أسيوط", "أسوان", "الإسماعيلية", "الفيوم", "المنيا",
  "بني سويف", "سوهاج", "قنا", "الدقهلية", "الغربية", "المنوفية", "القليوبية", "الشرقية",
  "البحيرة", "كفر الشيخ", "الأقصر", "البحر الأحمر", "الوادي الجديد", "مطروح",
  "شمال سيناء", "جنوب سيناء", "بورسعيد", "السويس", "دمياط",
]);

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || String(v).trim() === "";
}
function s(v: unknown): string {
  return String(v ?? "").trim();
}

// ==================== Row → order mapping ====================
interface RawRow {
  [key: string]: any;
}

interface ValidatedOrder {
  rowIndex: number;
  legacyOrderNumber: string;
  customerName: string;
  customerPhoneRaw: string;
  customerPhone: string;
  customerAddress: string;
  governorateRaw: string;
  governorate: string;
  governorateKnown: boolean;
  productRaw: string;
  quantity: number;
  total: number | null;
  sourceRaw: string;
  source: string;
  sourceKnown: boolean;
  status: string;
  statusKnown: boolean;
  notes: string;
  bostaTrackingNumber: string;
  createdAt: Date | null;
  confirmedAt: Date | null;
  issues: string[];
  rejected: boolean;
  rejectReason: string;
}

function deriveStatus(row: RawRow): { status: string; known: boolean; raw: string } {
  const shipRaw = s(row["حالة الشحن"]);
  const prepRaw = s(row["حالة التجهيز"]);
  const confirmRaw = s(row["حالة التأكيد"]);

  if (shipRaw) {
    if (SHIPPING_STATUS_MAP[shipRaw]) return { status: SHIPPING_STATUS_MAP[shipRaw], known: true, raw: shipRaw };
    return { status: "new", known: false, raw: shipRaw };
  }
  if (prepRaw) {
    if (PREP_STATUS_MAP[prepRaw]) return { status: PREP_STATUS_MAP[prepRaw], known: true, raw: prepRaw };
    return { status: "new", known: false, raw: prepRaw };
  }
  if (confirmRaw) {
    if (CONFIRM_STATUS_MAP[confirmRaw]) return { status: CONFIRM_STATUS_MAP[confirmRaw], known: true, raw: confirmRaw };
    return { status: "new", known: false, raw: confirmRaw };
  }
  return { status: "new", known: true, raw: "" };
}

function parseDate(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}
function parseTotal(v: string): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validateRow(row: RawRow, rowIndex: number): ValidatedOrder {
  const issues: string[] = [];

  const legacyOrderNumber = s(row["رقم الأوردر"]);
  if (!legacyOrderNumber) issues.push("رقم الأوردر مفقود");

  const customerName = s(row["اسم العميل"]);
  if (!customerName) issues.push("اسم العميل مفقود");

  const customerPhoneRaw = s(row["رقم الهاتف"]);
  const customerPhone = normalizeEgyptianPhone(customerPhoneRaw);
  if (!customerPhoneRaw) issues.push("رقم الهاتف مفقود");
  else if (!customerPhone || customerPhone.length !== 11) issues.push(`رقم هاتف غير صالح: "${customerPhoneRaw}"`);

  const customerAddress = s(row["العنوان الكامل"]);
  if (!customerAddress) issues.push("العنوان مفقود");

  const governorateRaw = s(row["المحافظة"]);
  const governorate = GOVERNORATE_NORMALIZE[governorateRaw] ?? governorateRaw;
  const governorateKnown = !governorateRaw || KNOWN_GOVERNORATES.has(governorate);
  if (governorateRaw && !governorateKnown) issues.push(`محافظة غير معروفة: "${governorateRaw}"`);

  const productRaw = s(row["المنتج"]);
  if (!productRaw) issues.push("المنتج مفقود");

  const quantityRaw = s(row["الكمية"]);
  const quantity = quantityRaw ? Number(quantityRaw) : 1;
  if (quantityRaw && !Number.isFinite(quantity)) issues.push(`كمية غير صالحة: "${quantityRaw}"`);

  const totalRaw = s(row["السعر"]);
  const total = parseTotal(totalRaw);
  if (!totalRaw) issues.push("السعر مفقود");
  else if (total === null) issues.push(`سعر غير صالح: "${totalRaw}"`);

  const sourceRaw = s(row["المصدر"]);
  const sourceKnown = !sourceRaw || SOURCE_MAP[sourceRaw] !== undefined;
  const source = sourceRaw ? SOURCE_MAP[sourceRaw] ?? "" : "manual";
  if (sourceRaw && !sourceKnown) issues.push(`مصدر غير معروف: "${sourceRaw}"`);

  const { status, known: statusKnown, raw: statusRaw } = deriveStatus(row);
  if (statusRaw && !statusKnown) issues.push(`حالة غير معروفة: "${statusRaw}"`);

  const createdAt = parseDate(s(row["تاريخ الاستقبال"]));
  if (row["تاريخ الاستقبال"] && !createdAt) issues.push(`تاريخ استقبال غير صالح: "${s(row["تاريخ الاستقبال"])}"`);
  const confirmedAt = parseDate(s(row["تاريخ التأكيد"]));
  if (row["تاريخ التأكيد"] && !confirmedAt && s(row["تاريخ التأكيد"])) {
    issues.push(`تاريخ تأكيد غير صالح: "${s(row["تاريخ التأكيد"])}"`);
  }

  const cancelPostponeReason = s(row["سبب الإلغاء/التأجيل"]);
  const notesParts = [s(row["ملاحظات"])];
  if (cancelPostponeReason) notesParts.push(`سبب الإلغاء/التأجيل: ${cancelPostponeReason}`);
  const notes = notesParts.filter(Boolean).join(" | ");

  const bostaTrackingNumber = s(row["رقم الشحنة"]);

  let rejected = false;
  let rejectReason = "";
  if (!customerName || !customerPhone || customerPhone.length !== 11 || !productRaw || !legacyOrderNumber) {
    rejected = true;
    rejectReason = "حقول أساسية مفقودة (رقم أوردر/اسم/هاتف صالح/منتج) — لا يمكن استيراده تلقائيًا";
  }

  return {
    rowIndex, legacyOrderNumber, customerName, customerPhoneRaw, customerPhone,
    customerAddress, governorateRaw, governorate, governorateKnown, productRaw,
    quantity: Number.isFinite(quantity) ? quantity : 1, total, sourceRaw, source, sourceKnown,
    status, statusKnown, notes, bostaTrackingNumber, createdAt, confirmedAt,
    issues, rejected, rejectReason,
  };
}

// ==================== Rollback ====================
async function runRollback(batchIdRaw: string) {
  const batchId = Number(batchIdRaw);
  if (!Number.isInteger(batchId) || batchId <= 0) {
    throw new Error(`رقم دفعة غير صالح: "${batchIdRaw}"`);
  }
  const db = await getDb();
  if (!db) throw new Error("لا يوجد اتصال بقاعدة البيانات — لا يمكن تنفيذ التراجع.");
  if (!PERFORMED_BY) throw new Error("--performed-by <employeeId> مطلوب لتسجيل من نفّذ التراجع.");

  const [batch] = await db.select().from(importBatches).where(eq(importBatches.id, batchId)).limit(1);
  if (!batch) throw new Error(`لا توجد دفعة استيراد بالرقم ${batchId}.`);
  if (batch.status === "rolled_back") {
    console.log(`[rollback] الدفعة #${batchId} تم التراجع عنها بالفعل بتاريخ ${batch.rolledBackAt}.`);
    return;
  }

  const affected = await db.select({ id: orders.id }).from(orders).where(eq(orders.importBatchId, batchId));
  console.log(`[rollback] الدفعة #${batchId} — "${batch.label}" — حالتها الحالية: ${batch.status}`);
  console.log(`[rollback] عدد الأوردرات التي سيتم حذفها: ${affected.length}`);

  if (!CONFIRM_ROLLBACK) {
    console.log("[rollback] هذا استعراض فقط. لتنفيذ الحذف فعليًا أضف --confirm إلى نفس الأمر.");
    return;
  }

  await db.delete(orders).where(eq(orders.importBatchId, batchId));
  await db.update(importBatches).set({
    status: "rolled_back",
    rolledBackAt: new Date(),
    rolledBackBy: Number(PERFORMED_BY),
  }).where(eq(importBatches.id, batchId));

  console.log(`[rollback] تم بنجاح: حُذف ${affected.length} أوردر، وتم تحديث حالة الدفعة #${batchId} إلى "rolled_back".`);
}

// ==================== Main ====================
async function main() {
  if (ROLLBACK_BATCH_ID) {
    await runRollback(ROLLBACK_BATCH_ID);
    return;
  }

  if (!FILE) throw new Error("--file <path> مطلوب.");
  console.log(`[import-orders-csv] Reading: ${FILE}`);
  console.log(`[import-orders-csv] Mode: ${COMMIT ? "*** COMMIT (writes to DB) ***" : "DRY RUN (no writes)"}`);

  const buf = fs.readFileSync(FILE);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: false, raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false }) as RawRow[];

  const validated = rawRows.map((r, i) => validateRow(r, i + 2));

  const uniqueOrderNumbers = new Set(validated.map(v => v.legacyOrderNumber)).size;
  const seen = new Map<string, ValidatedOrder[]>();
  for (const v of validated) {
    const arr = seen.get(v.legacyOrderNumber) ?? [];
    arr.push(v);
    seen.set(v.legacyOrderNumber, arr);
  }
  const duplicatesInFile = [...seen.entries()].filter(([, arr]) => arr.length > 1);

  let existingExternalIds = new Set<string>();
  let dbAvailable = false;
  let liveProducts: (typeof products.$inferSelect)[] = [];
  try {
    const db = await getDb();
    if (db) {
      dbAvailable = true;
      const existing = await db.select({ externalOrderId: orders.externalOrderId }).from(orders);
      existingExternalIds = new Set(existing.map(o => o.externalOrderId).filter((x): x is string => !!x));
      liveProducts = await db.select().from(products).where(eq(products.businessId, BUSINESS_ID));
    }
  } catch {
    dbAvailable = false;
  }
  const alreadyInDb = validated.filter(v => existingExternalIds.has(v.legacyOrderNumber));

  function matchProduct(productRaw: string) {
    const norm = (str: string) => str.trim().toLowerCase();
    const target = norm(productRaw);
    const exact = liveProducts.filter(p => norm(p.name) === target);
    if (exact.length === 1) return exact[0];
    const contains = liveProducts.filter(p => target.includes(norm(p.name)) || norm(p.name).includes(target));
    if (contains.length === 1) return contains[0];
    return null;
  }
  const unmatchedProductRows = dbAvailable ? validated.filter(v => v.productRaw && !matchProduct(v.productRaw)) : [];

  const rejected = validated.filter(v => v.rejected);
  const importable = validated.filter(v => !v.rejected && v.issues.length === 0);
  const importableWithWarnings = validated.filter(v => !v.rejected && v.issues.length > 0);

  const unknownSources = validated.filter(v => v.sourceRaw && !v.sourceKnown);
  const unknownGovs = validated.filter(v => v.governorateRaw && !v.governorateKnown);
  const unknownStatuses = validated.filter(v => !v.statusKnown);

  console.log("\n" + "=".repeat(70));
  console.log("تقرير الـ Dry-Run — استيراد orders_data.csv");
  console.log("=".repeat(70));
  console.log(`إجمالي الصفوف: ${rawRows.length}`);
  console.log(`عدد أرقام الأوردر الفريدة: ${uniqueOrderNumbers}`);
  console.log(`أرقام أوردر مكررة داخل الملف نفسه: ${duplicatesInFile.length} ${duplicatesInFile.length ? JSON.stringify(duplicatesInFile.map(([k]) => k)) : ""}`);
  console.log(`أوردرات صالحة للاستيراد التلقائي بلا أي ملاحظة: ${importable.length}`);
  console.log(`أوردرات صالحة جزئيًا (بها ملاحظات): ${importableWithWarnings.length}`);
  console.log(`أوردرات مرفوضة (حقول أساسية مفقودة): ${rejected.length}`);
  console.log(`اتصال بقاعدة البيانات متاح؟ ${dbAvailable ? "نعم" : "لا (تم تخطي فحص التكرار ومطابقة المنتج مقابل القاعدة الحية)"}`);
  if (dbAvailable) {
    console.log(`أوردرات موجودة بالفعل في القاعدة (externalOrderId مطابق): ${alreadyInDb.length}`);
    console.log(`منتجات في الملف (${liveProducts.length} منتج نشط في العمل رقم ${BUSINESS_ID} متاح للمطابقة): ${new Set(validated.map(v => v.productRaw)).size} اسم فريد`);
    console.log(`أوردرات بدون مطابقة منتج مؤكدة (لن تُستورد تلقائيًا حتى مع --commit): ${unmatchedProductRows.length}`);
  }
  console.log(`مصادر غير معروفة: ${unknownSources.length}`);
  console.log(`محافظات غير معروفة: ${unknownGovs.length}`);
  console.log(`حالات غير معروفة: ${unknownStatuses.length}`);

  if (rejected.length) {
    console.log("\n--- الأوردرات المرفوضة ---");
    for (const v of rejected) {
      console.log(`صف ${v.rowIndex} | رقم: "${v.legacyOrderNumber}" | ${v.rejectReason} | ${v.issues.join(" — ")}`);
    }
  }
  if (importableWithWarnings.length) {
    console.log("\n--- أوردرات بها ملاحظات (تُستورد تلقائيًا فقط لو بلا ملاحظات إطلاقًا) ---");
    for (const v of importableWithWarnings) {
      console.log(`صف ${v.rowIndex} | رقم: "${v.legacyOrderNumber}" | ${v.issues.join(" — ")}`);
    }
  }
  if (unknownSources.length) console.log("\n--- قيم مصدر غير معروفة ---", [...new Set(unknownSources.map(v => v.sourceRaw))]);
  if (unknownGovs.length) console.log("\n--- قيم محافظة غير معروفة ---", [...new Set(unknownGovs.map(v => v.governorateRaw))]);
  if (unknownStatuses.length) console.log("\n--- قيم حالة غير معروفة ---", [...new Set(unknownStatuses.map(v => v.status))]);
  if (dbAvailable && unmatchedProductRows.length) {
    console.log("\n--- أسماء منتجات في الملف بدون مطابقة مؤكدة في جدول products ---");
    console.log([...new Set(unmatchedProductRows.map(v => v.productRaw))]);
    console.log(`(منتجات العمل رقم ${BUSINESS_ID} حاليًا: ${liveProducts.map(p => p.name).join(" | ") || "لا يوجد"})`);
  }

  // ==================== CSV exports ====================
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const allCsvPath = path.join(REPORT_DIR, `orders-csv-import-all-${stamp}.csv`);
  const issuesCsvPath = path.join(REPORT_DIR, `orders-csv-import-issues-${stamp}.csv`);

  function esc(v: any): string {
    return `"${String(v ?? "").replace(/"/g, '""')}"`;
  }
  function toCsv(rowsArr: ValidatedOrder[]): string {
    const header = [
      "legacyOrderNumber", "customerName", "customerPhone", "customerAddress", "governorate",
      "productRaw", "quantity", "total", "status", "source", "notes", "bostaTrackingNumber",
      "createdAt", "confirmedAt", "rejected", "rejectReason", "issues",
    ];
    const lines = [header.join(",")];
    for (const v of rowsArr) {
      lines.push([
        esc(v.legacyOrderNumber), esc(v.customerName), v.customerPhone, esc(v.customerAddress),
        esc(v.governorate), esc(v.productRaw), v.quantity, v.total ?? "", v.status, v.source,
        esc(v.notes), esc(v.bostaTrackingNumber),
        v.createdAt ? v.createdAt.toISOString() : "", v.confirmedAt ? v.confirmedAt.toISOString() : "",
        v.rejected, esc(v.rejectReason), esc(v.issues.join(" | ")),
      ].join(","));
    }
    return lines.join("\n");
  }
  fs.writeFileSync(allCsvPath, toCsv(validated), "utf-8");
  fs.writeFileSync(issuesCsvPath, toCsv([...rejected, ...importableWithWarnings]), "utf-8");
  console.log(`\nتقرير كامل: ${allCsvPath}`);
  console.log(`تقرير المشاكل: ${issuesCsvPath}`);

  if (!COMMIT) {
    console.log("\n[import-orders-csv] وضع Dry-Run — لم يتم أي كتابة لقاعدة البيانات.");
    return;
  }

  console.warn("\n[import-orders-csv] *** COMMIT MODE *** — سيتم الكتابة الآن في قاعدة البيانات.");
  const db = await getDb();
  if (!db) throw new Error("لا يوجد اتصال بقاعدة البيانات — لا يمكن تنفيذ الاستيراد الفعلي.");
  if (!PERFORMED_BY) throw new Error("--performed-by <employeeId> مطلوب لتسجيل من نفّذ الاستيراد.");

  const toImport = importable.filter(v => !existingExternalIds.has(v.legacyOrderNumber));
  console.log(`مرشح للاستيراد الفعلي: ${toImport.length} أوردر.`);

  const allProducts = await db.select().from(products).where(eq(products.businessId, BUSINESS_ID));
  function matchProduct(productRaw: string) {
    const norm = (str: string) => str.trim().toLowerCase();
    const target = norm(productRaw);
    const exact = allProducts.filter(p => norm(p.name) === target);
    if (exact.length === 1) return exact[0];
    const contains = allProducts.filter(p => target.includes(norm(p.name)) || norm(p.name).includes(target));
    if (contains.length === 1) return contains[0];
    return null;
  }

  const [batchInsertResult] = await db.insert(importBatches).values({
    label: `استيراد orders_data.csv — ${path.basename(FILE)} — ${new Date().toISOString()}`,
    source: "orders_csv",
    status: "running",
    totalRows: toImport.length,
    performedBy: Number(PERFORMED_BY),
  });
  const batchId = (batchInsertResult as any).insertId as number;
  console.log(`تم إنشاء دفعة استيراد رقم #${batchId}.`);

  const maxOrderNumRow = await db.select({ maxNum: drizzleSql<string>`MAX(CAST(orderNumber AS UNSIGNED))` }).from(orders);
  let nextOrderNumber = Number(maxOrderNumRow[0]?.maxNum ?? 0) + 1;

  let importedCount = 0;
  let skippedNoProductMatch = 0;
  const unmatchedProducts: { legacyOrderNumber: string; productRaw: string }[] = [];
  const importErrors: { legacyOrderNumber: string; error: string }[] = [];

  for (const v of toImport) {
    const product = matchProduct(v.productRaw);
    if (!product) {
      skippedNoProductMatch++;
      unmatchedProducts.push({ legacyOrderNumber: v.legacyOrderNumber, productRaw: v.productRaw });
      continue;
    }
    try {
      const orderNumber = String(nextOrderNumber);
      await createOrder({
        businessId: BUSINESS_ID,
        orderNumber,
        customerName: v.customerName,
        customerPhone: v.customerPhone,
        customerAddress: v.customerAddress,
        governorate: v.governorate,
        productId: product.id,
        productName: product.name,
        quantity: v.quantity,
        totalAmount: String(v.total ?? 0),
        status: v.status as any,
        source: v.source as any,
        notes: v.notes || null,
        bostaTrackingNumber: v.bostaTrackingNumber || null,
        confirmedAt: v.confirmedAt,
        createdAt: v.createdAt ?? new Date(),
        externalOrderId: v.legacyOrderNumber,
        importBatchId: batchId,
      } as any);
      nextOrderNumber++;
      importedCount++;
    } catch (err: any) {
      importErrors.push({ legacyOrderNumber: v.legacyOrderNumber, error: String(err?.message ?? err) });
    }
  }

  const skippedCount = rejected.length + importableWithWarnings.length + skippedNoProductMatch + importErrors.length;
  const finalStatus = importErrors.length > 0 && importedCount === 0 ? "failed" : "completed";

  await db.update(importBatches).set({
    status: finalStatus,
    importedCount,
    skippedCount,
    duplicateCount: alreadyInDb.length,
    completedAt: new Date(),
    errorSummary: importErrors.length
      ? `${importErrors.length} خطأ أثناء الإدخال. أول خطأ: ${importErrors[0].error}`
      : (skippedNoProductMatch ? `${skippedNoProductMatch} أوردر بدون مطابقة منتج مؤكدة.` : null),
  }).where(eq(importBatches.id, batchId));

  if (unmatchedProducts.length || importErrors.length) {
    const errPath = path.join(REPORT_DIR, `orders-csv-commit-errors-batch${batchId}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
    const lines = ["legacyOrderNumber,type,detail"];
    for (const u of unmatchedProducts) lines.push(`${u.legacyOrderNumber},no_product_match,"${u.productRaw.replace(/"/g, '""')}"`);
    for (const e of importErrors) lines.push(`${e.legacyOrderNumber},insert_error,"${e.error.replace(/"/g, '""')}"`);
    fs.writeFileSync(errPath, lines.join("\n"), "utf-8");
    console.log(`تقرير أخطاء الاستيراد الفعلي: ${errPath}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log(`[import-orders-csv] انتهى الاستيراد الفعلي — دفعة #${batchId} (${finalStatus})`);
  console.log(`تم استيراده فعليًا: ${importedCount}`);
  console.log(`تم تخطيه: ${skippedCount} (مرفوض: ${rejected.length}، ملاحظات: ${importableWithWarnings.length}، بدون منتج مطابق: ${skippedNoProductMatch}، خطأ إدخال: ${importErrors.length})`);
  console.log(`موجود بالفعل (مكرر): ${alreadyInDb.length}`);
  console.log(`للتراجع عن هذه الدفعة لاحقًا:`);
  console.log(`  tsx scripts/import-orders-csv.ts --rollback ${batchId} --performed-by=${PERFORMED_BY} --confirm`);
  console.log("=".repeat(70));
}

main().catch(err => {
  console.error("[import-orders-csv] فشل:", err);
  process.exit(1);
});
