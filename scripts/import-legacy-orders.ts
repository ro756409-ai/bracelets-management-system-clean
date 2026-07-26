/**
 * Legacy historical-orders importer (كل_الأوردرات.xlsx).
 *
 * Default mode is DRY RUN — it never writes to the database unless invoked
 * explicitly with --commit. Always run without --commit first and review
 * the report before ever passing --commit.
 *
 * Usage:
 *   Dry run (safe, default, no writes):
 *     tsx scripts/import-legacy-orders.ts --file "/path/to/كل_الأوردرات.xlsx"
 *
 *   Optional: override sheet auto-detection (defaults to a sheet named "الأوردرات",
 *   falling back to the first sheet in the workbook, if not given):
 *     tsx scripts/import-legacy-orders.ts --file "..." --sheet "الأوردرات"
 *
 *   Commit (writes to DB — requires the 0022 migration to be applied first,
 *   since it adds the import_batches table and the easyorder_flashbox/roles enum values):
 *     tsx scripts/import-legacy-orders.ts --file "..." --commit --business-id=1 --performed-by=<employeeId>
 *
 *   Rollback a previous commit batch (preview, then require --confirm to actually delete):
 *     tsx scripts/import-legacy-orders.ts --rollback <batchId> --performed-by=<employeeId>
 *     tsx scripts/import-legacy-orders.ts --rollback <batchId> --performed-by=<employeeId> --confirm
 *
 * ==================== Row-wrapping pattern (confirmed by manual inspection) ====================
 * The source export skips empty cells and re-flows the remaining values, sometimes across
 * more than one physical spreadsheet row, and — critically — a single "continuation" row
 * can carry BOTH one more fragment of free text (more address, or more notes) in column 0
 * AND the start of the compacted trailing fields (governorate onward) in the columns after
 * it, in the same row. There is no fixed shift amount that explains every case.
 *
 * So reconstruction here does NOT rely on column position at all beyond the very first
 * column (used only to detect where a *new* order begins). Instead, every non-empty cell
 * from the point a new order starts until the next order boundary is collected into one
 * flat token stream (reading left-to-right, row after row), and each token is classified
 * by what it looks like (phone shape, date shape, known status/source/bosta/governorate
 * value, decimal-with-cents vs bare small integer) rather than by which column it happened
 * to land in. This uniformly handles plain single-row orders, pure address continuations,
 * "shifted" detail rows, and the hybrid rows that combine both — with one mechanism.
 */
import "dotenv/config";
import * as XLSX from "xlsx";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizeEgyptianPhone } from "../shared/phone";
import { getDb, createOrder, replaceOrderItems } from "../server/db";
import { orders, products, productVariants, importBatches } from "../drizzle/schema";
import { eq, and, sql as drizzleSql } from "drizzle-orm";
import { matchExternalItem, type MatchCatalog } from "../server/productMatching";

// ==================== Parent product / variant matching (2026-07-25 refactor) ====================
// "أسورة نحاس" is one product with engraving-type variants (آية الكرسي, عين حورس, ...) — NOT
// separate products. Other lines (مسند سيارة, كفر مرتبة ووتر بروف, ...) remain standalone
// products with no variant. See PROJECT_CONTEXT.md for the full model.
const PARENT_PRODUCT_NAME = "أسورة نحاس";
const BRACELET_PREFIX_RE = /^(أسورة|اسورة|آسورة|آسوره)\s*/;

export function isBraceletItem(text: string): boolean {
  return /أسورة|اسورة|آسورة|آسوره/.test(text);
}

/** Splits "X + Y ×2 + Z" into [{text, qty}] — one entry per order item. */
export function splitCompoundProduct(raw: string): { text: string; qty: number }[] {
  return raw
    .split("+")
    .map(seg => {
      const t = seg.trim();
      const m = t.match(/^(.*?)\s*[×xX]\s*(\d+)$/);
      if (m) return { text: m[1].trim(), qty: Math.max(1, parseInt(m[2], 10)) };
      return { text: t, qty: 1 };
    })
    .filter(s => s.text.length > 0);
}

export type CatalogProduct = { id: number; name: string; price: string | null };
export type CatalogVariant = { id: number; name: string | null; price: string | null };

/** Exact match first, then single-candidate substring containment — never guesses. */
export function matchByName<T extends { name: string | null }>(target: string, candidates: T[]): T | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const t = norm(target);
  if (!t) return null;
  const exact = candidates.filter(c => c.name && norm(c.name) === t);
  if (exact.length === 1) return exact[0];
  const contains = candidates.filter(c => c.name && (t.includes(norm(c.name!)) || norm(c.name!).includes(t)));
  if (contains.length === 1) return contains[0];
  return null;
}

export interface SegmentResolution {
  ok: boolean;
  reason?: string;
  /** True when the lookup found several equally-plausible candidates rather than none. */
  ambiguous?: boolean;
  productId?: number;
  productName?: string;
  variantId?: number;
  variantLabel?: string;
  unitPrice?: string | null;
}

/** Resolves one split-out item description to a (product, variant?) pair — or a rejection reason. */
export function resolveSegment(
  text: string,
  standaloneProducts: CatalogProduct[],
  parentProduct: CatalogProduct | undefined,
  parentVariants: CatalogVariant[]
): SegmentResolution {
  // Keep the specific diagnostic for a missing parent product — "the catalog has no
  // أسورة نحاس" is far more actionable than the generic "nothing matched" the shared
  // matcher would return, and it points straight at an unbootstrapped catalog.
  if (isBraceletItem(text) && !parentProduct) {
    return { ok: false, reason: `لا يوجد منتج أب "${PARENT_PRODUCT_NAME}" في الكتالوج` };
  }

  // Delegates to the shared matcher used by the EasyOrder webhook and manual sync, so the
  // legacy import and live imports resolve products identically. Its Arabic normalization
  // (alef/hamza/ta-marbuta/alef-maqsura/diacritics) is what lets legacy spellings like
  // "اية الكرسي" / "فالله خير حافظا" match the catalog's "آية الكرسي" / "فالله خير حافظاً".
  const catalog: MatchCatalog = {
    products: [
      ...(parentProduct ? [{ id: parentProduct.id, name: parentProduct.name, sku: null, price: parentProduct.price }] : []),
      ...standaloneProducts.map(p => ({ id: p.id, name: p.name, sku: null, price: p.price })),
    ],
    variants: parentProduct
      ? parentVariants.map(v => ({
          id: v.id,
          productId: parentProduct.id,
          name: v.name,
          sku: null,
          price: v.price,
          isActive: true,
        }))
      : [],
  };

  const result = matchExternalItem({ name: text }, catalog);
  if (!result.matched) {
    return { ok: false, reason: result.reason, ambiguous: result.ambiguous };
  }
  return {
    ok: true,
    productId: result.productId,
    productName: result.productName,
    variantId: result.variantId,
    variantLabel: result.variantName,
    unitPrice: result.unitPrice,
  };
}

// ==================== CLI args ====================
const args = process.argv.slice(2);
function argValue(name: string, def?: string): string | undefined {
  const withEq = args.find(a => a.startsWith(`--${name}=`));
  if (withEq) return withEq.split("=").slice(1).join("=");
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1];
  return def;
}
const FILE = argValue("file", "/Users/apple/Downloads/كل_الأوردرات.xlsx")!;
const SHEET_NAME_ARG = argValue("sheet");
/**
 * Optional path to a JSON catalog snapshot, so a DRY RUN can produce the full
 * product/variant matching report without a live database connection:
 *   { "products": [{ "id", "name", "price" }], "variants": [{ "id", "name", "price" }] }
 * Variants are assumed to belong to the PARENT_PRODUCT_NAME product. Ignored in --commit
 * mode, which always reads the real catalog from the database.
 */
const CATALOG_JSON = argValue("catalog-json");
const COMMIT = args.includes("--commit");
const BUSINESS_ID = Number(argValue("business-id", "1"));
const PERFORMED_BY = argValue("performed-by");
const ROLLBACK_BATCH_ID = argValue("rollback");
const CONFIRM_ROLLBACK = args.includes("--confirm");
const REPORT_DIR = argValue(
  "report-dir",
  "/private/tmp/claude-501/-Users-apple-Downloads---------------------------------------------7-/d651f46a-7f5e-48cf-a9f4-254d156a62e4/scratchpad"
)!;

// ==================== Known value sets (confirmed exhaustively against the real file) ====================
const STATUS_MAP: Record<string, string> = {
  printed: "printed", confirmed: "confirmed", cancelled: "cancelled", new: "new",
  postponed: "postponed", no_answer: "no_answer",
};
// "shipped" appears exactly once in the raw file (likely a one-off manual entry / typo) —
// intentionally NOT auto-mapped; it will fall through to "unknown status" for manual review.

const SOURCE_MAP: Record<string, string> = {
  easyorder_farhat: "easyorder_farhat", easyorder_ataba: "easyorder_ataba", easyorder: "easyorder",
  facebook: "facebook", manual: "manual", whatsapp: "whatsapp",
  // easyorder_flashbox: confirmed real legacy source value (299 raw occurrences), added to
  // orders.source enum in drizzle/0022_giant_slapstick.sql — no longer flagged as an issue.
  easyorder_flashbox: "easyorder_flashbox",
};

const BOSTA_STATUS_MAP: Record<string, string> = {
  "تم التحديث": "تم التحديث",
  "failed": "failed",
  "sent": "sent",
};

const GOVERNORATE_MAP: Record<string, string> = {
  "القاهره": "القاهرة", "القاهرة": "القاهرة",
  "الجيزه": "الجيزة", "الجيزة": "الجيزة",
  "الاسكندريه": "الإسكندرية", "الاسكندرية": "الإسكندرية", "اسكندرية": "الإسكندرية", "الإسكندرية": "الإسكندرية",
  "اسيوط": "أسيوط", "الاسيوط": "أسيوط", "أسيوط": "أسيوط",
  "اسوان": "أسوان", "أسوان": "أسوان",
  "الاسماعيليه": "الإسماعيلية", "اسماعيلية": "الإسماعيلية", "الاسماعيلية": "الإسماعيلية", "الاسمعيلية": "الإسماعيلية", "الإسماعيلية": "الإسماعيلية",
  "الفيوم": "الفيوم", "فيوم": "الفيوم",
  "المنيا": "المنيا", "منيا": "المنيا",
  "بنى سويف": "بني سويف", "بني سويف": "بني سويف",
  "سوهاج": "سوهاج", "قنا": "قنا",
  "الدقهليه": "الدقهلية", "الدقهلية": "الدقهلية", "دقهلية": "الدقهلية",
  "الغربيه": "الغربية", "الغربية": "الغربية", "غربية": "الغربية",
  "المنوفيه": "المنوفية", "المنوفية": "المنوفية", "منوفية": "المنوفية",
  "القليوبيه": "القليوبية", "القليوبية": "القليوبية", "قليوبية": "القليوبية",
  "الشرقيه": "الشرقية", "الشرقية": "الشرقية", "شرقية": "الشرقية",
  "البحيره": "البحيرة", "البحيرة": "البحيرة", "بحيرة": "البحيرة",
  "كفر الشيخ": "كفر الشيخ", "كفرالشيخ": "كفر الشيخ",
  "الاقصر": "الأقصر", "الأقصر": "الأقصر", "اقصر": "الأقصر",
  "البحر الاحمر": "البحر الأحمر", "البحر الأحمر": "البحر الأحمر",
  "الوادي الجديد": "الوادي الجديد",
  "مطروح": "مطروح",
  "شمال سيناء": "شمال سيناء", "جنوب سيناء": "جنوب سيناء",
  "بورسعيد": "بورسعيد", "السويس": "السويس", "دمياط": "دمياط",
};
const GOVERNORATE_TOKENS = new Set(Object.keys(GOVERNORATE_MAP));

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || String(v).trim() === "";
}
function looksLikeOrderNumber(v: string): boolean {
  const t = v.trim();
  // Real legacy order numbers observed are short sequential digits (1-6 digits) — an 11-digit
  // all-digit string is almost certainly a phone number, not an order number, so it must be
  // excluded here or it gets mistaken for a new-order boundary.
  //
  // Two additional legacy order-number formats were found (2026-07-25 investigation) that this
  // regex originally missed entirely, causing whole runs of orders to be silently swallowed as
  // free text into whichever preceding order happened to still be "open" (confirmed: 339
  // "ORD-YYYY-NNNNNN" orders and 298 single-segment "FB-NNNN" orders were lost this way,
  // concentrated in 3 blocks that absorbed 83/127/854 rows each instead of starting new orders):
  //   - "ORD-2026-000678" — ORD-<4-digit year>-<sequence>
  //   - "FB-3297"          — FB-<short sequence>, distinct from the existing FB-<13-digit
  //                          timestamp>-<sequence> two-segment format below
  return (
    /^\d{1,6}$/.test(t) ||
    /^FB-\d+-\d+$/.test(t) ||
    /^FB-\d{1,10}$/.test(t) ||
    /^ORD-\d{4}-\d+$/.test(t)
  );
}
function looksLikeDateTime(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v.trim());
}
function looksLikeMoney(v: string): boolean {
  return /^\d+\.\d{2}$/.test(v.trim());
}
function looksLikeSmallInt(v: string): boolean {
  return /^\d{1,2}$/.test(v.trim());
}
function looksLikeProduct(v: string): boolean {
  return v.includes("أسورة") || v.includes("اسورة") || v.includes("اسوره");
}

// ==================== Token stream extraction ====================
interface OrderBlock {
  legacyOrderNumber: string;
  sourceRowNumbers: number[];
  tokens: string[]; // every non-empty cell after the order-number cell, in reading order
}

function splitIntoBlocks(dataRows: any[][]): { blocks: OrderBlock[]; skippedBlankRows: number; orphanTokenRows: number[] } {
  const blocks: OrderBlock[] = [];
  let skippedBlankRows = 0;
  const orphanTokenRows: number[] = [];
  let current: OrderBlock | null = null;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowNum = i + 2;
    if (row.every((c: any) => isBlank(c))) {
      skippedBlankRows++;
      continue;
    }

    const first = String(row[0] ?? "").trim();
    if (!isBlank(first) && looksLikeOrderNumber(first)) {
      if (current) blocks.push(current);
      current = { legacyOrderNumber: first, sourceRowNumbers: [rowNum], tokens: [] };
      for (let c = 1; c < row.length; c++) {
        if (!isBlank(row[c])) current.tokens.push(String(row[c]).trim());
      }
    } else if (current) {
      current.sourceRowNumbers.push(rowNum);
      for (let c = 0; c < row.length; c++) {
        if (!isBlank(row[c])) current.tokens.push(String(row[c]).trim());
      }
    } else {
      // Tokens with no order-core row seen yet at all (shouldn't happen except at file start).
      orphanTokenRows.push(rowNum);
    }
  }
  if (current) blocks.push(current);
  return { blocks, skippedBlankRows, orphanTokenRows };
}

// ==================== Token classification into fields ====================
interface ReconOrder {
  legacyOrderNumber: string;
  sourceRowNumbers: number[];
  mergedRowCount: number; // sourceRowNumbers.length - 1
  customerName: string;
  customerPhoneRaw: string;
  customerAddress: string;
  governorateRaw: string;
  productRaw: string;
  quantityRaw: string;
  totalRaw: string;
  statusRaw: string;
  sourceRaw: string;
  notes: string;
  createdAtRaw: string;
  confirmedAtRaw: string;
  bostaStatusRaw: string;
  unclassifiedTokens: string[];
}

function classifyBlock(block: OrderBlock): ReconOrder {
  const rec: ReconOrder = {
    legacyOrderNumber: block.legacyOrderNumber,
    sourceRowNumbers: block.sourceRowNumbers,
    mergedRowCount: block.sourceRowNumbers.length - 1,
    customerName: "", customerPhoneRaw: "", customerAddress: "", governorateRaw: "",
    productRaw: "", quantityRaw: "", totalRaw: "", statusRaw: "", sourceRaw: "",
    notes: "", createdAtRaw: "", confirmedAtRaw: "", bostaStatusRaw: "",
    unclassifiedTokens: [],
  };

  let addressClosed = false; // once we hit the first "structured" field, address stops accepting free text
  const addressParts: string[] = [];
  const notesParts: string[] = [];
  let dateSeen = 0;

  for (const tokenRaw of block.tokens) {
    const token = tokenRaw.trim();
    if (!token) continue;

    // Structured fields first (in a priority order chosen to avoid ambiguity)
    if (!rec.statusRaw && STATUS_MAP[token] !== undefined) { rec.statusRaw = token; addressClosed = true; continue; }
    if (!rec.sourceRaw && SOURCE_MAP[token] !== undefined) { rec.sourceRaw = token; addressClosed = true; continue; }
    if (!rec.bostaStatusRaw && BOSTA_STATUS_MAP[token] !== undefined) { rec.bostaStatusRaw = token; addressClosed = true; continue; }
    if (looksLikeDateTime(token)) {
      if (!rec.createdAtRaw) rec.createdAtRaw = token;
      else if (!rec.confirmedAtRaw) rec.confirmedAtRaw = token;
      else rec.unclassifiedTokens.push(`تاريخ إضافي غير متوقع: ${token}`);
      addressClosed = true;
      continue;
    }
    if (!rec.governorateRaw && GOVERNORATE_TOKENS.has(token)) { rec.governorateRaw = token; addressClosed = true; continue; }
    if (!rec.customerPhoneRaw && normalizeEgyptianPhone(token).length === 11) { rec.customerPhoneRaw = token; continue; }
    if (!rec.totalRaw && looksLikeMoney(token)) { rec.totalRaw = token; addressClosed = true; continue; }
    if (!rec.quantityRaw && looksLikeSmallInt(token)) { rec.quantityRaw = token; addressClosed = true; continue; }
    if (!rec.productRaw && looksLikeProduct(token)) { rec.productRaw = token; addressClosed = true; continue; }

    // Free text: name (first), then address (until closed), then product
    // (if not yet set and no qty/total/status/source seen yet — product always
    // precedes those in the natural field order, e.g. "مسند سيارة..." which
    // isn't caught by the أسورة/اسورة keyword check above), then notes.
    if (!rec.customerName) { rec.customerName = token; continue; }
    if (!addressClosed) { addressParts.push(token); continue; }
    if (!rec.productRaw && !rec.quantityRaw && !rec.totalRaw && !rec.statusRaw && !rec.sourceRaw) {
      rec.productRaw = token;
      continue;
    }
    notesParts.push(token);
  }

  rec.customerAddress = addressParts.join(" ");
  rec.notes = [rec.notes, notesParts.join(" ")].filter(Boolean).join(" ");
  return rec;
}

// ==================== Validation ====================
function parseDate(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function parseTotal(v: string): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface ValidatedOrder extends ReconOrder {
  customerPhone: string;
  governorate: string;
  governorateKnown: boolean;
  quantity: number;
  total: number | null;
  status: string;
  statusKnown: boolean;
  source: string;
  sourceKnown: boolean;
  bostaStatus: string;
  createdAt: Date | null;
  confirmedAt: Date | null;
  issues: string[];
  rejected: boolean;
  rejectReason: string;
}

function validate(rec: ReconOrder): ValidatedOrder {
  const issues: string[] = [];
  const phone = normalizeEgyptianPhone(rec.customerPhoneRaw);
  if (!rec.customerPhoneRaw) issues.push("رقم الهاتف مفقود");
  else if (!phone || phone.length !== 11) issues.push(`رقم هاتف غير صالح: "${rec.customerPhoneRaw}"`);

  const govKnown = !rec.governorateRaw || GOVERNORATE_TOKENS.has(rec.governorateRaw);
  const governorate = rec.governorateRaw ? GOVERNORATE_MAP[rec.governorateRaw] ?? rec.governorateRaw : "";
  if (rec.governorateRaw && !govKnown) issues.push(`محافظة غير معروفة: "${rec.governorateRaw}"`);

  const statusKnown = !rec.statusRaw || STATUS_MAP[rec.statusRaw] !== undefined;
  const status = rec.statusRaw ? STATUS_MAP[rec.statusRaw] ?? "" : "new";
  if (rec.statusRaw && !statusKnown) issues.push(`حالة غير معروفة: "${rec.statusRaw}"`);

  const sourceKnown = !rec.sourceRaw || SOURCE_MAP[rec.sourceRaw] !== undefined;
  const source = rec.sourceRaw ? SOURCE_MAP[rec.sourceRaw] ?? "" : "manual";
  if (rec.sourceRaw && !sourceKnown) issues.push(`مصدر غير معروف: "${rec.sourceRaw}"`);

  const total = parseTotal(rec.totalRaw);
  if (rec.totalRaw && total === null) issues.push(`إجمالي غير صالح: "${rec.totalRaw}"`);
  if (!rec.totalRaw) issues.push("الإجمالي مفقود");

  const createdAt = parseDate(rec.createdAtRaw);
  if (rec.createdAtRaw && !createdAt) issues.push(`تاريخ إنشاء غير صالح: "${rec.createdAtRaw}"`);
  const confirmedAt = parseDate(rec.confirmedAtRaw);
  if (rec.confirmedAtRaw && !confirmedAt) issues.push(`تاريخ تأكيد غير صالح: "${rec.confirmedAtRaw}"`);

  const quantity = rec.quantityRaw ? Number(rec.quantityRaw) : 1;

  if (!rec.legacyOrderNumber) issues.push("رقم الأوردر القديم مفقود");
  if (!rec.customerName) issues.push("اسم العميل مفقود");
  if (!rec.customerAddress) issues.push("العنوان مفقود");
  if (!rec.productRaw) issues.push("المنتج مفقود");
  for (const u of rec.unclassifiedTokens) issues.push(u);

  let rejected = false;
  let rejectReason = "";
  if (!rec.customerName || !phone || phone.length !== 11 || !rec.productRaw) {
    rejected = true;
    rejectReason = "حقول أساسية مفقودة (اسم/هاتف صالح/منتج) — لا يمكن استيراده تلقائيًا";
  }

  return {
    ...rec,
    customerPhone: phone || rec.customerPhoneRaw,
    governorate, governorateKnown: govKnown,
    quantity: Number.isFinite(quantity) ? quantity : 1,
    total, status, statusKnown, source, sourceKnown,
    bostaStatus: rec.bostaStatusRaw,
    createdAt, confirmedAt,
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

  const affected = await db.select({ id: orders.id, orderNumber: orders.orderNumber, externalOrderId: orders.externalOrderId })
    .from(orders).where(eq(orders.importBatchId, batchId));

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

  console.log(`[import-legacy-orders] Reading: ${FILE}`);
  console.log(`[import-legacy-orders] Mode: ${COMMIT ? "*** COMMIT (writes to DB) ***" : "DRY RUN (no writes)"}`);

  const buf = fs.readFileSync(FILE);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });

  let sheetName: string;
  if (SHEET_NAME_ARG) {
    if (!wb.SheetNames.includes(SHEET_NAME_ARG)) {
      throw new Error(`الشيت "${SHEET_NAME_ARG}" غير موجود في الملف. الشيتات المتاحة: ${wb.SheetNames.join(", ")}`);
    }
    sheetName = SHEET_NAME_ARG;
  } else {
    sheetName = wb.SheetNames.includes("الأوردرات") ? "الأوردرات" : wb.SheetNames[0];
  }
  console.log(`[import-legacy-orders] Sheet: "${sheetName}" (متاح: ${wb.SheetNames.join(", ")})`);
  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false, blankrows: true }) as any[][];
  const dataRows = rows.slice(1);

  const { blocks, skippedBlankRows, orphanTokenRows } = splitIntoBlocks(dataRows);
  const recon = blocks.map(classifyBlock);
  const validated = recon.map(validate);

  const totalSourceRows = dataRows.length;
  const mergedRowsTotal = validated.reduce((s, v) => s + v.mergedRowCount, 0);
  const uniqueLegacyNumbers = new Set(validated.map(v => v.legacyOrderNumber)).size;

  const seen = new Map<string, ValidatedOrder[]>();
  for (const v of validated) {
    const arr = seen.get(v.legacyOrderNumber) ?? [];
    arr.push(v);
    seen.set(v.legacyOrderNumber, arr);
  }
  const duplicatesInFile = [...seen.entries()].filter(([, arr]) => arr.length > 1);

  let existingExternalIds = new Set<string>();
  let dbAvailable = false;
  try {
    const db = await getDb();
    if (db) {
      dbAvailable = true;
      const existing = await db.select({ externalOrderId: orders.externalOrderId }).from(orders);
      existingExternalIds = new Set(existing.map(o => o.externalOrderId).filter((x): x is string => !!x));
    }
  } catch {
    dbAvailable = false;
  }
  const alreadyInDb = validated.filter(v => existingExternalIds.has(v.legacyOrderNumber));

  const rejected = validated.filter(v => v.rejected);
  const importable = validated.filter(v => !v.rejected && v.issues.length === 0);
  const importableWithWarnings = validated.filter(v => !v.rejected && v.issues.length > 0);

  const unknownStatuses = validated.filter(v => v.statusRaw && !v.statusKnown);
  const unknownSources = validated.filter(v => v.sourceRaw && !v.sourceKnown);
  const unknownGovs = validated.filter(v => v.governorateRaw && !v.governorateKnown);
  const badPhones = validated.filter(v => !v.customerPhone || v.customerPhone.length !== 11);
  const badTotals = validated.filter(v => v.total === null);
  const missingProduct = validated.filter(v => !v.productRaw);

  // ==================== Product/variant match preview (runs in dry-run too, when DB is live) ====================
  let standaloneProducts: CatalogProduct[] = [];
  let parentProduct: CatalogProduct | undefined;
  let parentVariants: CatalogVariant[] = [];
  let unresolvableOrders: { legacyOrderNumber: string; productRaw: string; reasons: string[]; ambiguous: boolean }[] = [];
  // Quantity roll-up across every order that would actually import, keyed by
  // "product" or "product — variant", so the totals can be sanity-checked against
  // real-world expectations before any write.
  const qtyByProduct = new Map<string, { orders: number; pieces: number }>();
  let expectedOrderItems = 0;
  let fullyResolvedOrders = 0;
  let ambiguousOrderCount = 0;
  // Catalog source: the live DB when available, otherwise an explicitly-supplied JSON
  // snapshot so the dry-run report is complete even without database access.
  let catalogLoaded = false;
  if (dbAvailable) {
    const db = await getDb();
    if (db) {
      const allProducts = await db.select().from(products).where(eq(products.businessId, BUSINESS_ID));
      parentProduct = allProducts.find(p => p.name.trim() === PARENT_PRODUCT_NAME);
      standaloneProducts = allProducts.filter(p => p.id !== parentProduct?.id);
      if (parentProduct) {
        parentVariants = await db.select().from(productVariants)
          .where(and(eq(productVariants.productId, parentProduct.id), eq(productVariants.isActive, true)));
      }
      catalogLoaded = true;
    }
  } else if (CATALOG_JSON && !COMMIT) {
    const snapshot = JSON.parse(fs.readFileSync(CATALOG_JSON, "utf-8"));
    const snapProducts: any[] = snapshot.products ?? [];
    parentProduct = snapProducts.find((p: any) => String(p.name).trim() === PARENT_PRODUCT_NAME);
    standaloneProducts = snapProducts.filter((p: any) => p.id !== parentProduct?.id);
    parentVariants = (snapshot.variants ?? []) as CatalogVariant[];
    catalogLoaded = true;
    console.log(`[import-legacy-orders] Catalog: snapshot من ${CATALOG_JSON} (${snapProducts.length} منتج، ${parentVariants.length} نوع)`);
  }

  if (catalogLoaded) {
    {
      for (const v of importable) {
        const segments = splitCompoundProduct(v.productRaw);
        const resolutions = segments.map(s => ({
          qty: s.qty,
          res: resolveSegment(s.text, standaloneProducts, parentProduct, parentVariants),
        }));
        const failures = resolutions.filter(r => !r.res.ok);

        if (failures.length > 0) {
          const isAmbiguous = failures.some(f => f.res.ambiguous);
          if (isAmbiguous) ambiguousOrderCount++;
          unresolvableOrders.push({
            legacyOrderNumber: v.legacyOrderNumber,
            productRaw: v.productRaw,
            reasons: failures.map(f => f.res.reason!),
            ambiguous: isAmbiguous,
          });
          continue;
        }

        // Fully resolved → this is what a real import would write.
        fullyResolvedOrders++;
        expectedOrderItems += resolutions.length;
        for (const { qty, res } of resolutions) {
          const key = res.variantLabel ? `${res.productName} — ${res.variantLabel}` : res.productName!;
          const acc = qtyByProduct.get(key) ?? { orders: 0, pieces: 0 };
          acc.orders += 1;
          acc.pieces += qty;
          qtyByProduct.set(key, acc);
        }
      }
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("تقرير الـ Dry-Run (بعد تحسين خوارزمية إعادة البناء) — استيراد الأوردرات القديمة");
  console.log("=".repeat(70));
  console.log(`إجمالي صفوف المصدر: ${totalSourceRows}`);
  console.log(`صفوف فارغة تمامًا (مُتجاهَلة): ${skippedBlankRows}`);
  console.log(`صفوف يتيمة بلا أوردر أساسي سابق (مُتجاهَلة، تحتاج مراجعة يدوية): ${orphanTokenRows.length} ${orphanTokenRows.length ? JSON.stringify(orphanTokenRows) : ""}`);
  console.log(`عدد الأوردرات الفريدة (Unique Orders، بحسب رقم الأوردر القديم): ${uniqueLegacyNumbers}`);
  console.log(`إجمالي كتل الأوردرات المُعاد بناؤها: ${validated.length}`);
  console.log(`عدد الصفوف التي تم دمجها (Merged Rows، أي صفوف تكملة استُهلكت ضمن أوردر آخر): ${mergedRowsTotal}`);
  console.log(`  تحقق: ${totalSourceRows} - ${skippedBlankRows} - ${orphanTokenRows.length} = ${totalSourceRows - skippedBlankRows - orphanTokenRows.length} = عدد كتل (${validated.length}) + صفوف مدموجة (${mergedRowsTotal})`);
  console.log(`أوردرات صالحة للاستيراد التلقائي بلا أي ملاحظة: ${importable.length}`);
  console.log(`أوردرات صالحة جزئيًا (بها ملاحظات لكن ليست حقولًا أساسية مفقودة): ${importableWithWarnings.length}`);
  console.log(`أوردرات مرفوضة (حقول أساسية مفقودة — لا يمكن استيرادها تلقائيًا): ${rejected.length}`);
  console.log(`أرقام أوردر مكررة داخل الملف نفسه (بعد إعادة البناء): ${duplicatesInFile.length}`);
  console.log(`اتصال بقاعدة البيانات متاح؟ ${dbAvailable ? "نعم" : "لا (تم تخطي فحص التكرار مقابل القاعدة الحية)"}`);
  if (dbAvailable) {
    console.log(`أوردرات موجودة بالفعل في القاعدة (externalOrderId مطابق): ${alreadyInDb.length}`);
  } else {
    console.log(`⚠️ فحص التكرار مقابل القاعدة الحية لم يُنفَّذ — شغّل هذا الأمر على بيئة بها DATABASE_URL لمعرفة عدد الأوردرات الموجودة بالفعل.`);
  }
  if (catalogLoaded) {
    console.log(`منتج أب "${PARENT_PRODUCT_NAME}" موجود في الكتالوج؟ ${parentProduct ? `نعم (#${parentProduct.id}، ${parentVariants.length} نوع نشط)` : "لا"}`);
    console.log(`أوردرات (من الصالحة تمامًا) لن تُستورد تلقائيًا بسبب عدم تطابق منتج/نوع: ${unresolvableOrders.length}`);
    console.log(`  منها غامضة (يطابق أكثر من منتج/نوع): ${ambiguousOrderCount}`);
    console.log(`  منها بلا أي تطابق: ${unresolvableOrders.length - ambiguousOrderCount}`);
    console.log(`✅ أوردرات ستُستورد فعليًا (كل أصنافها مُطابَقة): ${fullyResolvedOrders}`);
    console.log(`✅ إجمالي صفوف order_items المتوقَّعة: ${expectedOrderItems}`);
  } else {
    console.log(`⚠️ مطابقة المنتج/النوع لم تُنفَّذ — لا قاعدة بيانات ولا --catalog-json.`);
  }
  console.log(`منتج مفقود: ${missingProduct.length}`);
  console.log(`حالات (status) غير معروفة: ${unknownStatuses.length}`);
  console.log(`مصادر (source) غير معروفة: ${unknownSources.length}`);
  console.log(`محافظات غير معروفة: ${unknownGovs.length}`);
  console.log(`أرقام هواتف غير صالحة الصيغة: ${badPhones.length}`);
  console.log(`إجماليات غير صالحة/مفقودة: ${badTotals.length}`);

  console.log("\n--- سبب الرفض لكل أوردر مرفوض (أول 15) ---");
  for (const v of rejected.slice(0, 15)) {
    console.log(`صفوف ${JSON.stringify(v.sourceRowNumbers)} | رقم قديم: "${v.legacyOrderNumber}" | ${v.rejectReason} | التفاصيل: ${v.issues.join(" — ")}`);
  }

  if (unknownStatuses.length) {
    console.log("\n--- قيم status غير معروفة (فريدة) ---");
    console.log([...new Set(unknownStatuses.map(v => v.statusRaw))]);
  }
  if (unknownSources.length) {
    console.log("\n--- قيم source غير معروفة (فريدة) ---");
    console.log([...new Set(unknownSources.map(v => v.sourceRaw))]);
  }
  if (unknownGovs.length) {
    console.log("\n--- قيم محافظة غير معروفة (فريدة، أول 20) ---");
    console.log([...new Set(unknownGovs.map(v => v.governorateRaw))].slice(0, 20));
  }

  if (qtyByProduct.size > 0) {
    console.log("\n" + "=".repeat(70));
    console.log("إجمالي الكميات حسب المنتج/النوع (للأوردرات التي ستُستورد فعليًا)");
    console.log("=".repeat(70));
    const rows = [...qtyByProduct.entries()].sort((a, b) => b[1].pieces - a[1].pieces);
    const nameWidth = Math.min(50, Math.max(...rows.map(([k]) => k.length)));
    console.log(`${"المنتج / النوع".padEnd(nameWidth)} | ${"عدد الأوردرات".padStart(13)} | ${"عدد القطع".padStart(10)}`);
    console.log("-".repeat(nameWidth + 30));
    for (const [key, val] of rows) {
      console.log(`${key.padEnd(nameWidth)} | ${String(val.orders).padStart(13)} | ${String(val.pieces).padStart(10)}`);
    }
    console.log("-".repeat(nameWidth + 30));
    const totalOrders = rows.reduce((s, [, v]) => s + v.orders, 0);
    const totalPieces = rows.reduce((s, [, v]) => s + v.pieces, 0);
    console.log(`${"الإجمالي".padEnd(nameWidth)} | ${String(totalOrders).padStart(13)} | ${String(totalPieces).padStart(10)}`);
  }

  // ==================== CSV exports ====================
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const allCsvPath = path.join(REPORT_DIR, `legacy-import-all-${stamp}.csv`);
  const issuesCsvPath = path.join(REPORT_DIR, `legacy-import-issues-${stamp}.csv`);

  function esc(s: any): string {
    return `"${String(s ?? "").replace(/"/g, '""')}"`;
  }
  function toCsv(rowsArr: ValidatedOrder[]): string {
    const header = [
      "legacyOrderNumber", "sourceRows", "mergedRows", "customerName", "customerPhone",
      "customerAddress", "governorate", "productRaw", "quantity", "total", "status", "source",
      "notes", "createdAt", "confirmedAt", "bostaStatus", "rejected", "rejectReason", "issues",
    ];
    const lines = [header.join(",")];
    for (const v of rowsArr) {
      lines.push([
        esc(v.legacyOrderNumber), esc(v.sourceRowNumbers.join(";")), v.mergedRowCount,
        esc(v.customerName), v.customerPhone, esc(v.customerAddress), esc(v.governorate),
        esc(v.productRaw), v.quantity, v.total ?? "", v.status, v.source, esc(v.notes),
        v.createdAt ? v.createdAt.toISOString() : "", v.confirmedAt ? v.confirmedAt.toISOString() : "",
        esc(v.bostaStatus), v.rejected, esc(v.rejectReason), esc(v.issues.join(" | ")),
      ].join(","));
    }
    return lines.join("\n");
  }
  fs.writeFileSync(allCsvPath, toCsv(validated), "utf-8");
  fs.writeFileSync(issuesCsvPath, toCsv([...rejected, ...importableWithWarnings]), "utf-8");
  console.log(`\nتقرير كامل بكل الأوردرات المُعاد بناؤها: ${allCsvPath}`);
  console.log(`تقرير الأوردرات المرفوضة + التي بها ملاحظات: ${issuesCsvPath}`);

  if (unresolvableOrders.length) {
    const unresolvedCsvPath = path.join(REPORT_DIR, `legacy-import-unmatched-products-${stamp}.csv`);
    const lines = ["legacyOrderNumber,productRaw,reasons"];
    for (const u of unresolvableOrders) {
      lines.push(`${u.legacyOrderNumber},"${u.productRaw.replace(/"/g, '""')}","${u.reasons.join(" | ").replace(/"/g, '""')}"`);
    }
    fs.writeFileSync(unresolvedCsvPath, lines.join("\n"), "utf-8");
    console.log(`تقرير الأوردرات التي لن تُستورد لعدم تطابق منتج/نوع: ${unresolvedCsvPath}`);
  }

  if (!COMMIT) {
    console.log("\n[import-legacy-orders] وضع Dry-Run — لم يتم أي كتابة لقاعدة البيانات.");
    return;
  }

  console.warn("\n[import-legacy-orders] *** COMMIT MODE *** — سيتم الكتابة الآن في قاعدة البيانات.");
  const db = await getDb();
  if (!db) throw new Error("لا يوجد اتصال بقاعدة البيانات — لا يمكن تنفيذ الاستيراد الفعلي.");
  if (!PERFORMED_BY) throw new Error("--performed-by <employeeId> مطلوب لتسجيل من نفّذ الاستيراد.");

  // فقط الأوردرات الصالحة تمامًا (بلا أي ملاحظة) وغير الموجودة بالفعل بنفس رقم الأوردر القديم.
  const toImport = importable.filter(v => !existingExternalIds.has(v.legacyOrderNumber));
  const skippedAsWarning = importableWithWarnings.length; // بها ملاحظات — لا تُستورد تلقائيًا أبدًا
  console.log(`مرشح للاستيراد الفعلي: ${toImport.length} أوردر (صالح تمامًا وغير موجود بالفعل).`);
  console.log(`سيُتخطى تلقائيًا: ${rejected.length} مرفوض، ${skippedAsWarning} به ملاحظات، ${alreadyInDb.length} موجود بالفعل.`);

  // مطابقة المنتج/النوع: "أسورة نحاس" منتج أب واحد بأنواع نقش مختلفة (variants) — أي وصف
  // يحتوي "أسورة"/"اسورة" يُطابَق مقابل أنواع هذا المنتج فقط. أي وصف آخر (مسند سيارة، إلخ)
  // يُطابَق كمنتج مستقل كالسابق. تطابق تام أولاً، ثم احتواء نصي وحيد فقط — لا تخمين أبدًا.
  const allProducts = await db.select().from(products).where(eq(products.businessId, BUSINESS_ID));
  const commitParentProduct = allProducts.find(p => p.name.trim() === PARENT_PRODUCT_NAME);
  const commitStandaloneProducts = allProducts.filter(p => p.id !== commitParentProduct?.id);
  const commitParentVariants = commitParentProduct
    ? await db.select().from(productVariants)
        .where(and(eq(productVariants.productId, commitParentProduct.id), eq(productVariants.isActive, true)))
    : [];

  const [batchInsertResult] = await db.insert(importBatches).values({
    label: `استيراد الأوردرات القديمة — ${path.basename(FILE)} — ${new Date().toISOString()}`,
    source: "legacy_excel",
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
    // Split "X + Y ×2" into one or more order items, and resolve each independently.
    // All-or-nothing per order: if ANY item can't be resolved confidently, the whole order
    // is skipped and logged — never import a partial order or guess a variant.
    const segments = splitCompoundProduct(v.productRaw);
    const resolved = segments.map(s => ({ ...s, resolution: resolveSegment(s.text, commitStandaloneProducts, commitParentProduct, commitParentVariants) }));
    const failed = resolved.filter(r => !r.resolution.ok);
    if (failed.length > 0) {
      skippedNoProductMatch++;
      unmatchedProducts.push({ legacyOrderNumber: v.legacyOrderNumber, productRaw: v.productRaw });
      continue;
    }

    try {
      const orderNumber = String(nextOrderNumber);
      const first = resolved[0].resolution;
      const totalQuantity = resolved.reduce((s, r) => s + r.qty, 0);
      const orderId = await createOrder({
        businessId: BUSINESS_ID,
        orderNumber,
        customerName: v.customerName,
        customerPhone: v.customerPhone,
        customerAddress: v.customerAddress,
        governorate: v.governorate,
        productId: first.productId!,
        productName: first.variantLabel ? `${first.productName} - ${first.variantLabel}` : first.productName!,
        variantId: first.variantId,
        quantity: totalQuantity,
        totalAmount: String(v.total ?? 0),
        // NOTE: the legacy workbook has no shipping column — the reconstructed fields are
        // name/phone/address/governorate/product/qty/total/status/source/bosta/dates only.
        // shippingFees is therefore left at the column default (0) rather than inventing a
        // value; the recorded totalAmount is the figure the source actually stated.
        status: v.status as any,
        source: v.source as any,
        notes: v.notes || null,
        bostaStatus: v.bostaStatus || null,
        confirmedAt: v.confirmedAt,
        createdAt: v.createdAt ?? new Date(),
        externalOrderId: v.legacyOrderNumber,
        importBatchId: batchId,
        // Original source row preserved verbatim for audit / re-processing.
        externalRawPayload: JSON.stringify({
          sourceRows: v.sourceRowNumbers,
          mergedRowCount: v.mergedRowCount,
          legacyOrderNumber: v.legacyOrderNumber,
          customerName: v.customerName,
          customerPhoneRaw: v.customerPhoneRaw,
          customerAddress: v.customerAddress,
          governorateRaw: v.governorateRaw,
          productRaw: v.productRaw,
          quantityRaw: v.quantityRaw,
          totalRaw: v.totalRaw,
          statusRaw: v.statusRaw,
          sourceRaw: v.sourceRaw,
          bostaStatusRaw: v.bostaStatusRaw,
          createdAtRaw: v.createdAtRaw,
          confirmedAtRaw: v.confirmedAtRaw,
          notes: v.notes,
        }),
      } as any);
      if (orderId) {
        await replaceOrderItems(orderId, resolved.map(r => ({
          productId: r.resolution.productId,
          productName: r.resolution.variantLabel ? `${r.resolution.productName} - ${r.resolution.variantLabel}` : r.resolution.productName!,
          quantity: r.qty,
          unitPrice: r.resolution.unitPrice != null ? Number(r.resolution.unitPrice) : undefined,
          variantId: r.resolution.variantId,
        })));
      }
      nextOrderNumber++;
      importedCount++;
    } catch (err: any) {
      importErrors.push({ legacyOrderNumber: v.legacyOrderNumber, error: String(err?.message ?? err) });
    }
  }

  const skippedCount = rejected.length + skippedAsWarning + skippedNoProductMatch + importErrors.length;

  // ==================== Strict post-import verification ====================
  // Never trust the in-memory `importedCount` counter alone — it only reflects what this
  // process *attempted* and didn't throw on, not what the database actually persisted.
  // Re-query the database itself for the authoritative count before saying anything succeeded.
  const [verifyRow] = await db
    .select({ cnt: drizzleSql<string>`COUNT(*)` })
    .from(orders)
    .where(eq(orders.importBatchId, batchId));
  const actualInsertedCount = Number(verifyRow?.cnt ?? 0);

  if (actualInsertedCount !== importedCount) {
    const mismatchSummary =
      `تناقض حرج بعد الاستيراد: العداد الداخلي يقول ${importedCount} أوردر مُدرَج، ` +
      `لكن قاعدة البيانات تؤكد ${actualInsertedCount} فقط لدفعة #${batchId}.`;
    await db.update(importBatches).set({
      status: "failed",
      importedCount: actualInsertedCount,
      skippedCount,
      duplicateCount: alreadyInDb.length,
      completedAt: new Date(),
      errorSummary: mismatchSummary,
    }).where(eq(importBatches.id, batchId));
    throw new Error(`${mismatchSummary} تم تعليم الدفعة "failed" تلقائيًا. لا تعتمد على أي رسالة نجاح سابقة لهذا التحقق.`);
  }

  // A run with importable candidates but zero rows actually persisted (e.g. every single
  // order was silently skipped for lack of a confident product match) is a failure, even
  // though no exception was ever thrown — "completed" must never be printed for this case.
  const allSkippedNoProduct = toImport.length > 0 && actualInsertedCount === 0 && skippedNoProductMatch === toImport.length;
  const finalStatus = actualInsertedCount > 0 || toImport.length === 0 ? "completed" : "failed";

  await db.update(importBatches).set({
    status: finalStatus,
    importedCount: actualInsertedCount,
    skippedCount,
    duplicateCount: alreadyInDb.length,
    completedAt: new Date(),
    errorSummary: importErrors.length
      ? `${importErrors.length} خطأ أثناء الإدخال. أول خطأ: ${importErrors[0].error}`
      : allSkippedNoProduct
        ? `فشل كامل: كل الأوردرات المرشحة (${toImport.length}) تم تخطيها بسبب عدم تطابق المنتج — لم يُستورَد أي أوردر. راجع كتالوج المنتجات (businessId=${BUSINESS_ID}) وقارنه بأسماء المنتجات في الملف.`
        : (skippedNoProductMatch ? `${skippedNoProductMatch} أوردر بدون مطابقة منتج مؤكدة.` : null),
  }).where(eq(importBatches.id, batchId));

  if (unmatchedProducts.length || importErrors.length) {
    const errPath = path.join(REPORT_DIR, `legacy-import-commit-errors-batch${batchId}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
    const lines = ["legacyOrderNumber,type,detail"];
    for (const u of unmatchedProducts) lines.push(`${u.legacyOrderNumber},no_product_match,"${u.productRaw.replace(/"/g, '""')}"`);
    for (const e of importErrors) lines.push(`${e.legacyOrderNumber},insert_error,"${e.error.replace(/"/g, '""')}"`);
    fs.writeFileSync(errPath, lines.join("\n"), "utf-8");
    console.log(`تقرير أخطاء الاستيراد الفعلي: ${errPath}`);
  }

  console.log("\n" + "=".repeat(70));
  console.log(`[import-legacy-orders] انتهى الاستيراد الفعلي — دفعة #${batchId} (${finalStatus})`);
  console.log(`تم التحقق من قاعدة البيانات مباشرة: ${actualInsertedCount} صف فعلي في orders لهذه الدفعة (مطابق للعداد الداخلي).`);
  if (allSkippedNoProduct) {
    console.log(`⚠️  فشل كامل: كل الأوردرات المرشحة (${toImport.length}) تخطّت بسبب عدم تطابق المنتج. لا يوجد أي أوردر مستورَد.`);
  }
  console.log(`تم استيراده فعليًا (مؤكَّد من القاعدة): ${actualInsertedCount}`);
  console.log(`تم تخطيه: ${skippedCount} (مرفوض: ${rejected.length}، ملاحظات: ${skippedAsWarning}، بدون منتج مطابق: ${skippedNoProductMatch}، خطأ إدخال: ${importErrors.length})`);
  console.log(`موجود بالفعل (مكرر): ${alreadyInDb.length}`);
  if (finalStatus === "completed") {
    console.log(`للتراجع عن هذه الدفعة لاحقًا:`);
    console.log(`  tsx scripts/import-legacy-orders.ts --rollback ${batchId} --performed-by=${PERFORMED_BY} --confirm`);
  }
  console.log("=".repeat(70));

  if (finalStatus === "failed") {
    throw new Error(`دفعة الاستيراد #${batchId} انتهت بحالة "failed" — راجع الأسباب أعلاه قبل أي إعادة محاولة.`);
  }
}

// Only run when executed directly (tsx scripts/import-legacy-orders.ts) — not when imported
// as a module (e.g. by import-legacy-orders.test.ts for its pure matching-logic functions).
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  main().catch(err => {
    console.error("[import-legacy-orders] فشل:", err);
    process.exit(1);
  });
}
