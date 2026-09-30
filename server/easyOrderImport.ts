import * as XLSX from "xlsx";
import { normalizeEgyptianPhone, toAsciiDigits } from "../shared/phone";
import { resolveGovernorate } from "../shared/egyptGovernorates";
import { matchImportItem, type MatchCatalog } from "./productMatching";

/**
 * استيراد Easy Order من Excel — **قراءة وتصنيف نقيّان** (بلا قاعدة بيانات)، الراوتر بيربطهم
 * بالنطاق والكتابة.
 *
 *   • القراءة من **الخلايا الفعلية** لا من `dimension` المعلن (ملفات Easy Order بتكتب A1
 *     رغم إن البيانات لحد AD93). الصفوف الفارغة بس هي اللي بتتجاهل.
 *   • القيم نصوص كما هي (`raw:false`) — الهاتف مايتحوّلش لرقم ولا يتخترع له صفر.
 *   • الأوردر متعدد الأصناف: Product Name / Variant / Quantity / SKU / Item Price مفصولين
 *     بـnewline وبيتربطوا **بالفهرس**؛ اختلاف الأعداد = صف مرفوض بسبب واضح، بلا دمج ولا تخمين.
 *   • المحافظة: من City لو موجودة، وإلا من Address بمطابقة «يقين أو فراغ» (أسماء ومدن
 *     ومرادفات المشروع) — لو مفيش يقين الأوردر بيتستورد للمراجعة، ومفيش محافظة تتختار غلط.
 *   • مفتاح الـidempotency: Order ID (UUID) → `externalOrderId` داخل النشاط.
 */

export type RowStatus = "new" | "review" | "existing" | "rejected";

export interface ImportItem {
  index: number;
  productName: string;
  variantText: string;
  quantity: number;
  sku: string;
  unitPrice: number | null;
  color: string;
  size: string;
  baseName: string;
  /** المطابقة (بعد التصنيف على كتالوج النشاط). */
  match?: { productId: number; productName: string; variantId: number | null; color: string | null; size: string | null; unitPrice: string | null } | null;
  matchReason?: string;
}

export interface ImportRow {
  rowIndex: number;
  /** مفتاح الـidempotency: Order ID ثم External Order ID ثم ID. */
  orderKey: string;
  orderIdRaw: string;
  externalOrderIdRaw: string;
  idRaw: string;
  customerName: string;
  phoneRaw: string;
  /** الرقم المصري الصالح المطبَّع، أو "" لو مش صالح. */
  phone: string;
  phoneValid: boolean;
  altPhone: string;
  city: string;
  address: string;
  governorate: string;
  resolvedCity: string;
  governorateResolved: boolean;
  totalAmount: number;
  notes: string;
  utmCampaign: string;
  utmSource: string;
  items: ImportItem[];
  totalQuantity: number;
  status: RowStatus;
  /** أسباب المراجعة (الصف بيتستورد بـneedsReview). */
  reviewReasons: string[];
  /** أسباب الرفض (الصف مابيتستوردش). */
  rejectReasons: string[];
  /** للعرض: المنتج الأول + عدد الأصناف. */
  productName: string;
  multiProduct: boolean;
}

// ── أعمدة Easy Order المعروفة (بعد توحيد الاسم: lowercase وبلا مسافات/رموز) ──
const COLUMN_ALIASES: Record<string, string[]> = {
  id: ["id"],
  status: ["status"],
  fullName: ["fullname", "name", "customername", "الاسم", "اسمالعميل"],
  phone: ["phone", "phonenumber", "mobile", "الهاتف", "رقمالهاتف"],
  altPhone: ["altphone", "alternativephone", "phone2", "رقماخر"],
  city: ["city", "المدينة", "المحافظة"],
  address: ["address", "العنوان"],
  totalCost: ["totalcost", "total", "الاجمالي", "الإجمالي"],
  productCost: ["productcost"],
  shippingCost: ["shippingcost", "shipping"],
  productName: ["productname", "product", "المنتج", "اسمالمنتج"],
  variant: ["variant", "variants", "النوع"],
  quantity: ["quantity", "qty", "الكمية"],
  sku: ["sku"],
  itemPrice: ["itemprice", "price", "unitprice"],
  createdAt: ["createdat", "date"],
  note: ["note", "notes", "ملاحظات"],
  utmCampaign: ["utmcampaign"],
  utmSource: ["utmsource"],
  ref: ["ref", "referralcode"],
  orderId: ["orderid"],
  externalOrderId: ["externalorderid"],
};

export function normalizeHeader(h: unknown): string {
  return String(h ?? "").trim().toLowerCase().replace(/[\s_\-./()]+/g, "");
}

export function mapColumns(headers: unknown[]): Record<keyof typeof COLUMN_ALIASES, number> {
  const norm = headers.map(normalizeHeader);
  const out = {} as Record<keyof typeof COLUMN_ALIASES, number>;
  for (const key of Object.keys(COLUMN_ALIASES) as (keyof typeof COLUMN_ALIASES)[]) {
    out[key] = norm.findIndex(h => COLUMN_ALIASES[key].includes(h));
  }
  return out;
}

/** يقرأ الورقة من **الخلايا الفعلية** — مش من !ref/dimension المعلن. */
export function readSheetRows(buffer: Buffer): string[][] {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  return rowsFromSheet(sheet);
}

/** الصفوف من ورقة محمّلة: المدى بيتحسب من الخلايا الموجودة فعلًا (يتجاهل !ref المعلن). */
export function rowsFromSheet(sheet: XLSX.WorkSheet): string[][] {
  let maxR = -1, maxC = -1;
  for (const key of Object.keys(sheet)) {
    if (key[0] === "!") continue;
    const a = XLSX.utils.decode_cell(key);
    if (a.r > maxR) maxR = a.r;
    if (a.c > maxC) maxC = a.c;
  }
  if (maxR < 0) return [];
  sheet["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: "", raw: false, blankrows: false });
  return rows.map(r => (r as any[]).map(c => (c == null ? "" : String(c))));
}

/** خلية متعددة الأسطر → أسطر كما هي (السطور الفارغة بتفضل في مكانها للمحاذاة بالفهرس). */
function splitLines(cell: string): string[] {
  return String(cell ?? "").replace(/\r/g, "").split("\n").map(s => s.trim());
}

/** اللون/المقاس/الاسم الأساسي من نص Easy Order («المقاس: من 6 ل 8 سنين اللون: آسود»). */
export function extractColorSizeFromText(text: string): { color: string; size: string; baseName: string } {
  let color = "", size = "";
  const colorM = text.match(/(?:اللون|color)\s*[:：]\s*([^\/|,،\n]+?)(?=\s*(?:المقاس|الحجم|المقاسات|size)\s*[:：]|[\/|,،\n]|$)/i);
  if (colorM) color = colorM[1].trim();
  const sizeM = text.match(/(?:المقاس|الحجم|المقاسات|size)\s*[:：]\s*([^\/|\n]+?)(?=\s*(?:اللون|color)\s*[:：]|[\/|\n]|$)/i);
  if (sizeM) size = sizeM[1].trim();
  let baseName = text;
  const cut = text.search(/(?:اللون|المقاس|الحجم|المقاسات|color|size)\s*[:：]/i);
  if (cut >= 0) baseName = text.slice(0, cut);
  baseName = baseName.replace(/[-–—:\s]+$/u, "").trim();
  return { color, size, baseName };
}

const num = (s: string): number | null => {
  const m = toAsciiDigits(String(s ?? "")).replace(/[^\d.,-]/g, "").replace(",", ".");
  if (!m) return null;
  const n = parseFloat(m);
  return Number.isFinite(n) ? n : null;
};

/** الهاتف: يُقبل فقط لو رقم مصري 01xxxxxxxxx (بعد إزالة الرموز/المسافات/+20). غير كده يبقى نصًا كما هو للمراجعة. */
export function classifyPhone(raw: string): { phone: string; valid: boolean } {
  const ascii = toAsciiDigits(String(raw ?? "")).trim();
  if (!ascii) return { phone: "", valid: false };
  const normalized = normalizeEgyptianPhone(ascii);
  return /^01\d{9}$/.test(normalized) ? { phone: normalized, valid: true } : { phone: ascii.replace(/[^\d+]/g, "").slice(0, 20), valid: false };
}

/** المحافظة: City أولًا، ثم العنوان — يقين أو فراغ. */
export function resolveLocation(city: string, address: string): { governorate: string; city: string; resolved: boolean } {
  const fromCity = city ? resolveGovernorate(city) : { governorate: "", city: "" };
  if (fromCity.governorate) return { governorate: fromCity.governorate, city: fromCity.city || city, resolved: true };
  const fromAddress = resolveGovernorate(address);
  if (fromAddress.governorate) return { governorate: fromAddress.governorate, city: fromAddress.city, resolved: true };
  return { governorate: "", city: city || "", resolved: false };
}

export const GOV_REVIEW_REASON = "المحافظة غير محددة — راجع العنوان";

/** صفوف الورقة → صفوف استيراد مصنّفة أوليًا (بلا كتالوج ولا قاعدة بيانات). */
export function parseEasyOrderRows(rows: string[][]): { rows: ImportRow[]; fileErrors: string[] } {
  if (rows.length < 2) return { rows: [], fileErrors: ["الملف فارغ أو لا يحتوي على بيانات"] };
  const col = mapColumns(rows[0]);
  const fileErrors: string[] = [];
  for (const [key, label] of [["fullName", "FullName"], ["phone", "Phone"], ["productName", "Product Name"]] as const) {
    if (col[key] < 0) fileErrors.push(`العمود ${label} غير موجود في الملف`);
  }
  if (fileErrors.length) return { rows: [], fileErrors };

  const out: ImportRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => !String(c ?? "").trim())) continue;
    const get = (idx: number) => (idx >= 0 ? String(r[idx] ?? "").trim() : "");

    const rejectReasons: string[] = [];
    const reviewReasons: string[] = [];
    const customerName = get(col.fullName);
    if (!customerName) rejectReasons.push("اسم العميل مفقود");

    const phoneRaw = get(col.phone);
    const ph = classifyPhone(phoneRaw);
    if (!phoneRaw) rejectReasons.push("رقم الهاتف مفقود");
    else if (!ph.valid) reviewReasons.push(`رقم الهاتف غير صالح: ${phoneRaw}`);

    const city = get(col.city), address = get(col.address);
    const loc = resolveLocation(city, address);
    if (!loc.resolved) reviewReasons.push(GOV_REVIEW_REASON);

    // ── الأصناف: index-by-index ──
    const names = splitLines(get(col.productName)).filter(Boolean);
    const variants = splitLines(get(col.variant));
    const qtys = splitLines(get(col.quantity));
    const skus = splitLines(get(col.sku));
    const prices = splitLines(get(col.itemPrice));
    // محاذاة بالفهرس: العمود الفاضي كله = غياب؛ أسطر فاضية زائدة في الآخر بتتشال؛ غير كده
    // اختلاف العدد = رفض واضح (بلا دمج ولا تخمين).
    const aligned = (arr: string[], label: string): string[] | null => {
      if (arr.every(x => x === "")) return names.map(() => "");
      let a = arr;
      while (a.length > names.length && a[a.length - 1] === "") a = a.slice(0, -1);
      const nonEmpty = a.filter(x => x !== "").length;
      if (a.length === names.length) return a;
      rejectReasons.push(`عدد ${label} (${nonEmpty}) لا يساوي عدد المنتجات (${names.length})`);
      return null;
    };
    const items: ImportItem[] = [];
    if (names.length === 0) rejectReasons.push("اسم المنتج مفقود");
    else {
      const v = aligned(variants, "الأنواع"), q = aligned(qtys, "الكميات"), s = aligned(skus, "SKU"), p = aligned(prices, "الأسعار");
      if (v && q && s && p) {
        names.forEach((name, idx) => {
          const qn = q[idx] === "" ? 1 : Math.floor(num(q[idx]) ?? 0);
          if (!(qn >= 1)) rejectReasons.push(`كمية غير صالحة للصنف رقم ${idx + 1}: "${q[idx]}"`);
          const ext = extractColorSizeFromText(`${name} ${v[idx]}`.trim());
          items.push({
            index: idx + 1, productName: name, variantText: v[idx], quantity: Math.max(1, qn || 1), sku: s[idx],
            unitPrice: p[idx] === "" ? null : num(p[idx]), color: ext.color, size: ext.size, baseName: ext.baseName || name,
          });
        });
      }
    }
    const totalQuantity = items.reduce((sum, it) => sum + it.quantity, 0);
    const orderIdRaw = get(col.orderId), externalOrderIdRaw = get(col.externalOrderId), idRaw = get(col.id);
    const orderKey = orderIdRaw || externalOrderIdRaw || idRaw;
    if (!orderKey) reviewReasons.push("بلا معرّف أوردر — لا يمكن منع التكرار تلقائيًا");

    out.push({
      rowIndex: i + 1,
      orderKey, orderIdRaw, externalOrderIdRaw, idRaw,
      customerName, phoneRaw, phone: ph.valid ? ph.phone : ph.phone, phoneValid: ph.valid,
      altPhone: get(col.altPhone), city, address,
      governorate: loc.governorate, resolvedCity: loc.city, governorateResolved: loc.resolved,
      totalAmount: num(get(col.totalCost)) ?? 0,
      notes: get(col.note), utmCampaign: get(col.utmCampaign), utmSource: get(col.utmSource),
      items, totalQuantity,
      status: rejectReasons.length ? "rejected" : reviewReasons.length ? "review" : "new",
      reviewReasons, rejectReasons,
      productName: items.length > 1 ? `${items[0].productName} (+${items.length - 1})` : (items[0]?.productName ?? ""),
      multiProduct: items.length > 1,
    });
  }
  return { rows: out, fileErrors };
}

/** المطابقة على كتالوج النشاط لكل صنف — صنف بلا مطابقة = صف مرفوض بسبب واضح. */
export function matchRowItems(row: ImportRow, catalog: MatchCatalog): ImportRow {
  if (row.status === "rejected" || row.status === "existing") return row;
  const items = row.items.map(it => {
    const m = matchImportItem({ sku: it.sku || undefined, name: it.baseName, color: it.color || undefined, size: it.size || undefined, variantText: it.variantText || undefined }, catalog);
    return m.matched
      ? { ...it, match: { productId: m.productId, productName: m.productName, variantId: m.variantId ?? null, color: m.color ?? null, size: m.size ?? null, unitPrice: m.unitPrice }, matchReason: undefined }
      : { ...it, match: null, matchReason: `الصنف رقم ${it.index} «${it.productName}» (اللون: ${it.color || "—"}، المقاس: ${it.size || "—"}) — ${m.reason}` };
  });
  const unmatched = items.filter(it => !it.match);
  if (unmatched.length) {
    return { ...row, items, status: "rejected", rejectReasons: [...row.rejectReasons, ...unmatched.map(u => u.matchReason as string)] };
  }
  return { ...row, items };
}

/** كشف التكرار: مفتاح الأوردر داخل النشاط (موجود مسبقًا) أو مكرر داخل الملف. */
export function markExisting(rows: ImportRow[], existingKeys: Set<string>): ImportRow[] {
  const seen = new Set<string>();
  return rows.map(row => {
    if (!row.orderKey) return row;
    if (existingKeys.has(row.orderKey))
      return { ...row, status: "existing", rejectReasons: [...row.rejectReasons, `موجود مسبقًا (Order ID ${row.orderKey})`] };
    if (seen.has(row.orderKey))
      return { ...row, status: "existing", rejectReasons: [...row.rejectReasons, `مكرر داخل الملف (Order ID ${row.orderKey})`] };
    seen.add(row.orderKey);
    return row;
  });
}

export function summarize(rows: ImportRow[]) {
  const c = { new: 0, review: 0, existing: 0, rejected: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

/** سطر تقرير لصف: «الصف 39 — الأوردر 414 — رقم الهاتف غير صالح». */
export function rowReportLine(row: ImportRow): string {
  const reasons = [...row.rejectReasons, ...row.reviewReasons];
  return `الصف ${row.rowIndex} — الأوردر ${row.idRaw || row.orderKey || "—"} — ${reasons.join("؛ ") || "سليم"}`;
}
