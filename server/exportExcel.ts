import { Request, Response, Express } from "express";
import { requireAdminOrManager } from "./authMiddleware";
import XLSX from "xlsx-js-style";
import QRCode from "qrcode";
import { getOrders, getAllEmployees, getAllProducts, markOrdersAsPrinted, getAllBusinesses, getBusinessIdsByGroupId, getOrderItemsForOrders } from "./db";
import { listShippingConfiguration } from "./shippingConfigV2.service";


// ==================== SHARED HELPERS ====================

/** Sanitize notes: remove JSON fragments, internal flags, metadata */
function sanitizeNotes(raw: string | null | undefined): string {
  if (!raw) return "";
  let cleaned = raw;
  cleaned = cleaned.replace(/\{[^}]*\}/g, "");
  cleaned = cleaned.replace(/is_free_shipping:\s*(true|false)/gi, "");
  cleaned = cleaned.replace(/[a-z_]+:\s*(true|false|null|\d+)/gi, "");
  cleaned = cleaned.replace(/[\[\]{}|]/g, "");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

/** Format address cleanly for operations */
function formatAddress(address: string | null | undefined, governorate?: string): string {
  if (!address) return governorate || "";
  let clean = address.trim();
  if (governorate && clean.endsWith(governorate)) {
    clean = clean.slice(0, -governorate.length).trim().replace(/[,،\-]+$/, "").trim();
  }
  return clean || governorate || "";
}

function extractEngravingType(fullName: string): string {
  if (!fullName) return "غير محدد";
  const colonMatch = fullName.match(/نوع الحفر[:\s]+(.+)/i);
  if (colonMatch) return colonMatch[1].trim();
  const dashMatch = fullName.match(/[-–—]\s*([^-–—]+)$/);
  if (dashMatch) {
    const afterDash = dashMatch[1].trim();
    if (!afterDash.startsWith("اسورة") && !afterDash.startsWith("نوع")) return afterDash;
  }
  return fullName;
}

function parseOrderProducts(order: any) {
  const productName = order.productName || "";
  const names = productName.split("\n").map((s: string) => s.trim()).filter(Boolean);
  if (names.length === 0) names.push(productName || "غير محدد");
  return names;
}

function parseOrderProductsShort(order: any) {
  const products = parseOrderProducts(order);
  return products.map(extractEngravingType);
}

function classifyProduct(fullName: string): string {
  if (!fullName) return "حفر";
  const lower = fullName.trim();
  if (/سادة|ساده|plain/i.test(lower)) return "سادة";
  return "حفر";
}

function parseOrderProductsClassified(order: any): string[] {
  const products = parseOrderProducts(order);
  return products.map(classifyProduct);
}

// ==================== ADVANCED FILTER HELPER ====================

async function getFilteredOrders(req: Request) {
  const { fromOrder, toOrder, orderIds, dateFrom, dateTo, governorate, status, businessGroupId, websiteId, statuses: statusesParam } = req.query;

  // Determine statuses to filter
  let statuses: string[] = ["confirmed", "printed"];
  if (statusesParam) {
    statuses = String(statusesParam).split(",");
  } else if (status && String(status) !== "all") {
    statuses = [String(status)];
  }

  // Determine businessIds from group
  let businessIds: number[] | undefined;
  if (businessGroupId && String(businessGroupId) !== "all") {
    businessIds = await getBusinessIdsByGroupId(Number(businessGroupId));
  }

  // Date range
  let from: Date | undefined;
  let to: Date | undefined;
  if (dateFrom) from = new Date(String(dateFrom));
  if (dateTo) to = new Date(String(dateTo));

  const result = await getOrders({
    statuses,
    businessIds,
    websiteId: websiteId ? Number(websiteId) : undefined,
    governorate: governorate && String(governorate) !== "all" ? String(governorate) : undefined,
    dateFrom: from,
    dateTo: to,
    limit: 50000,
  });

  let orders = result.orders;

  // Filter by order number range
  if (fromOrder && toOrder) {
    const fromN = parseInt(String(fromOrder), 10);
    const toN = parseInt(String(toOrder), 10);
    if (!isNaN(fromN) && !isNaN(toN)) {
      orders = orders.filter((o: any) => {
        const num = parseInt(String(o.orderNumber), 10);
        return !isNaN(num) && num >= fromN && num <= toN;
      });
    }
  } else if (fromOrder) {
    const fromN = parseInt(String(fromOrder), 10);
    if (!isNaN(fromN)) {
      orders = orders.filter((o: any) => {
        const num = parseInt(String(o.orderNumber), 10);
        return !isNaN(num) && num >= fromN;
      });
    }
  } else if (toOrder) {
    const toN = parseInt(String(toOrder), 10);
    if (!isNaN(toN)) {
      orders = orders.filter((o: any) => {
        const num = parseInt(String(o.orderNumber), 10);
        return !isNaN(num) && num <= toN;
      });
    }
  }

  // Filter by specific order IDs
  if (orderIds) {
    const ids = String(orderIds).split(",").map(Number);
    orders = orders.filter((o: any) => ids.includes(o.id));
  }

  return orders;
}

// ==================== DATA VALIDATION ====================

interface ValidationResult {
  valid: boolean;
  warnings: { orderId: number; orderNumber: string; issues: string[] }[];
}

function validateOrdersForShipping(orders: any[]): ValidationResult {
  const warnings: ValidationResult['warnings'] = [];

  for (const o of orders) {
    const issues: string[] = [];
    if (!o.customerPhone || o.customerPhone.length < 10) issues.push("رقم الهاتف غير صحيح");
    if (!o.governorate || o.governorate.trim() === "") issues.push("المحافظة غير محددة");
    if (!o.customerAddress || o.customerAddress.trim().length < 5) issues.push("العنوان ناقص أو غير واضح");
    if (!o.customerName || o.customerName.trim() === "") issues.push("اسم العميل غير موجود");

    if (issues.length > 0) {
      warnings.push({ orderId: o.id, orderNumber: o.orderNumber, issues });
    }
  }

  return { valid: warnings.length === 0, warnings };
}

// ==================== EXPORT CONFIRMED ORDERS ====================
async function exportConfirmedOrders(req: Request, res: Response) {
  try {
    const orders = await getFilteredOrders(req);
    const employees = await getAllEmployees();
    const empMap = new Map(employees.map((e: any) => [e.id, e.name]));

    const headers = [
      "رقم الأوردر", "الاسم", "الهاتف", "هاتف بديل", "العنوان", "المحافظة", "المدينة/المركز",
      "المنتج", "اللون", "المقاس", "الكمية", "المبلغ", "رسوم الشحن", "وسيلة الدفع", "المصدر", "الحالة",
      "ملاحظات العميل", "ملاحظات الموظف", "تاريخ الإنشاء", "تاريخ التأكيد",
    ];

    const rows = orders.map((o: any) => [
      o.orderNumber,
      o.customerName,
      o.customerPhone,
      o.customerPhone2 || "",
      formatAddress(o.customerAddress, o.governorate),
      o.governorate,
      o.city || "",
      o.productName,
      o.color || "",
      o.size || "",
      o.quantity,
      Number(o.totalAmount),
      Number(o.shippingFees || 0),
      o.paymentMethod === "cod" ? "كاش عند الاستلام" : o.paymentMethod || "كاش",
      o.source === "easyorder" ? "Easy Order" : o.source === "shopify" ? "Shopify" : o.source === "whatsapp" ? "WhatsApp" : o.source === "facebook" ? "فيسبوك" : "يدوي",
      o.status === "confirmed" ? "مؤكد" : o.status === "printed" ? "مطبوع" : o.status,
      sanitizeNotes(o.notes),
      sanitizeNotes(o.employeeNotes),
      o.createdAt ? new Date(o.createdAt).toLocaleDateString("ar-EG") : "",
      o.confirmedAt ? new Date(o.confirmedAt).toLocaleDateString("ar-EG") : "",
    ]);

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);

    ws["!cols"] = [
      { wch: 12 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 35 }, { wch: 14 }, { wch: 14 },
      { wch: 30 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 10 },
      { wch: 25 }, { wch: 25 }, { wch: 14 }, { wch: 14 },
    ];

    ws["!dir"] = "rtl";
    XLSX.utils.book_append_sheet(wb, ws, "الأوردرات المؤكدة");

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const filename = `confirmed_orders_${new Date().toISOString().split("T")[0]}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (error: any) {
    console.error("Export error:", error);
    res.status(500).json({ error: "حدث خطأ أثناء التصدير" });
  }
}

// ==================== STYLED SHIPPING SHEET ====================

const HEADER_FILL = { fgColor: { rgb: "8B4513" } };
const HEADER_FONT = { bold: true, color: { rgb: "FFFFFF" }, sz: 11, name: "Cairo" };
const SUB_HEADER_FILL = { fgColor: { rgb: "D2B48C" } };
const SUB_HEADER_FONT = { bold: true, color: { rgb: "000000" }, sz: 10, name: "Cairo" };
const DATA_FONT = { sz: 10, name: "Cairo" };
const BORDER_STYLE = {
  top: { style: "thin", color: { rgb: "8B4513" } },
  bottom: { style: "thin", color: { rgb: "8B4513" } },
  left: { style: "thin", color: { rgb: "8B4513" } },
  right: { style: "thin", color: { rgb: "8B4513" } },
} as any;
const CENTER_ALIGN = { horizontal: "center", vertical: "center", wrapText: true };
const RIGHT_ALIGN = { horizontal: "right", vertical: "center", wrapText: true };

function applyStyle(ws: any, ref: string, style: any) {
  if (!ws[ref]) ws[ref] = { v: "", t: "s" };
  ws[ref].s = { ...ws[ref].s, ...style };
}

async function exportShippingSheet(req: Request, res: Response) {
  try {
    const { validate } = req.query;
    const orders = await getFilteredOrders(req);

    // Validation check mode
    if (validate === "true") {
      const result = validateOrdersForShipping(orders);
      return res.json(result);
    }

    // Check for incomplete data and warn
    const validation = validateOrdersForShipping(orders);
    const skipIncomplete = req.query.skipIncomplete === "true";
    let exportOrders = orders;

    if (!skipIncomplete && !validation.valid) {
      // Still export but mark incomplete orders
    }

    const employees = await getAllEmployees();
    const empMap = new Map(employees.map((e: any) => [e.id, e.name]));
    const businesses = await getAllBusinesses();
    const bizMap = new Map(businesses.map((b: any) => [b.id, b.name]));
    const providerMap = new Map<number, string>();
    for (const businessId of [...new Set(exportOrders.map((order: any) => Number(order.businessId)))]) {
      const configuration = await listShippingConfiguration(businessId);
      for (const provider of configuration.providers) providerMap.set(provider.id, provider.displayName);
    }

    // Group orders by shipping agent
    const agentGroups: Record<string, any[]> = {};
    for (const order of exportOrders) {
      const agentName = providerMap.get(Number(order.projectedShippingProviderId)) ?? "غير محدد";
      if (!agentGroups[agentName]) agentGroups[agentName] = [];
      agentGroups[agentName].push({ ...order, shippingCost: Number(order.projectedShippingCostSnapshot ?? 0) });
    }

    const wb = XLSX.utils.book_new();
    const today = new Date().toLocaleDateString("ar-EG");

    const agentOrder = [...providerMap.values(), "غير محدد"];
    const sortedAgents = Object.entries(agentGroups).sort(([a], [b]) => {
      const ai = agentOrder.indexOf(a);
      const bi = agentOrder.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    for (const [agentName, agentOrders] of sortedAgents) {
      const isUnknown = agentName === "غير محدد";
      // Row 0: Title row
      const row0: any[] = new Array(26).fill("");
      row0[0] = "فرحات للنحاس";
      row0[19] = today;

      // Row 1: Empty spacer
      const row1: any[] = new Array(26).fill("");

      // Row 2: Agent info
      const row2: any[] = new Array(26).fill("");
      row2[0] = "الوكيل";
      row2[3] = isUnknown ? "❗ غير محدد - يجب مراجعة المحافظة" : agentName;
      row2[5] = agentOrders.length;
      row2[9] = "1";
      row2[12] = "2";
      row2[15] = "3";
      row2[20] = agentOrders.length;

      // Row 3: Column headers
      const row3 = [
        "م", "رقم الأوردر", "الاسم", "تليفون", "تليفون بديل", "العنوان", "المدينة/المركز",
        isUnknown ? "المحافظة (غير معروفة)" : "المحافظة",
        "التاكيد", "ملاحظات",
        "القطعة", "اللون", "المقاس", "عددها", "سعرها",
        "القطعة", "عددها", "سعرها",
        "القطعة", "عددها", "سعرها",
        "الشحن", "الإجمالي", "تصفية الاوردر",
        "الوكيل", "المصدر", "ملاحظات الموظف", "التاريخ"
      ];

      // Data rows
      const dataRows = agentOrders.map((o: any, i: number) => {
        const confirmedByName = o.lastUpdatedBy ? (empMap.get(o.lastUpdatedBy) || "") : "";
        const productTypes = parseOrderProductsClassified(o);
        const cleanNotes = sanitizeNotes(o.notes);
        const cleanAddress = formatAddress(o.customerAddress, o.governorate);
        const productPrice = Number(o.totalAmount);
        const shippingCost = o.shippingCost;
        const totalAmount = productPrice + shippingCost;

        // Check if data is incomplete
        const hasIssue = !o.customerPhone || o.customerPhone.length < 10 ||
          !o.governorate || !o.customerAddress || o.customerAddress.length < 5;

        const row: any[] = [
          i + 1,                          // م
          o.orderNumber,                   // رقم الأوردر
          o.customerName,                  // الاسم
          o.customerPhone,                 // تليفون
          o.customerPhone2 || "",          // تليفون بديل
          cleanAddress,                    // العنوان
          o.city || "",                    // المدينة/المركز
          o.governorate,                   // المحافظة
          confirmedByName,                 // التاكيد
          cleanNotes,                      // ملاحظات العميل
          productTypes[0] || "",           // القطعة 1
          o.color || "",                   // اللون
          o.size || "",                    // المقاس
          productTypes.length <= 1 ? o.quantity : "",
          productTypes.length <= 1 ? productPrice : "",
          productTypes[1] || "",           // القطعة 2
          "",
          "",
          productTypes[2] || "",           // القطعة 3
          "",
          "",
          shippingCost,                    // الشحن
          totalAmount,                     // الإجمالي
          "",                              // تصفية الاوردر
          agentName,                       // الوكيل
          o.source === "easyorder" ? "Easy Order" : o.source === "facebook" ? "فيسبوك" : o.source || "",
          sanitizeNotes(o.employeeNotes),  // ملاحظات الموظف
          o.createdAt ? new Date(o.createdAt).toLocaleDateString("ar-EG") : "",
        ];
        return row;
      });

      const allRows = [row0, row1, row2, row3, ...dataRows];
      const ws = XLSX.utils.aoa_to_sheet(allRows);

      // ---- STYLING ----
      for (let c = 0; c < 26; c++) {
        const ref = XLSX.utils.encode_cell({ r: 0, c });
        applyStyle(ws, ref, {
          fill: HEADER_FILL,
          font: { ...HEADER_FONT, sz: 14 },
          alignment: CENTER_ALIGN,
          border: BORDER_STYLE,
        });
      }
      ws["!merges"] = ws["!merges"] || [];
      ws["!merges"].push({ s: { r: 0, c: 0 }, e: { r: 0, c: 18 } });
      ws["!merges"].push({ s: { r: 0, c: 19 }, e: { r: 0, c: 25 } });

      const row2Fill = isUnknown ? { fgColor: { rgb: "FF4444" } } : SUB_HEADER_FILL;
      const row2Font = isUnknown ? { ...SUB_HEADER_FONT, color: { rgb: "FFFFFF" }, bold: true } : SUB_HEADER_FONT;
      for (let c = 0; c < 26; c++) {
        const ref = XLSX.utils.encode_cell({ r: 2, c });
        applyStyle(ws, ref, { fill: row2Fill, font: row2Font, alignment: CENTER_ALIGN, border: BORDER_STYLE });
      }
      ws["!merges"].push({ s: { r: 2, c: 0 }, e: { r: 2, c: 2 } });
      ws["!merges"].push({ s: { r: 2, c: 3 }, e: { r: 2, c: 4 } });
      ws["!merges"].push({ s: { r: 2, c: 9 }, e: { r: 2, c: 11 } });
      ws["!merges"].push({ s: { r: 2, c: 12 }, e: { r: 2, c: 14 } });
      ws["!merges"].push({ s: { r: 2, c: 15 }, e: { r: 2, c: 17 } });

      for (let c = 0; c < 26; c++) {
        const ref = XLSX.utils.encode_cell({ r: 3, c });
        applyStyle(ws, ref, { fill: HEADER_FILL, font: HEADER_FONT, alignment: CENTER_ALIGN, border: BORDER_STYLE });
      }

      for (let r = 4; r < allRows.length; r++) {
        const isEven = (r - 4) % 2 === 0;
        for (let c = 0; c < 26; c++) {
          const ref = XLSX.utils.encode_cell({ r, c });
          const isGovCol = c === 7;
          let rowFill = isEven ? { fgColor: { rgb: "FFF8F0" } } : { fgColor: { rgb: "FFFFFF" } };
          if (isUnknown && isGovCol) rowFill = { fgColor: { rgb: "FFEB9C" } };
          applyStyle(ws, ref, {
            font: DATA_FONT,
            alignment: c <= 2 || c === 5 || c === 9 || c === 24 ? RIGHT_ALIGN : CENTER_ALIGN,
            border: BORDER_STYLE,
            fill: rowFill,
          });
        }
      }

      ws["!cols"] = [
        { wch: 5 },  // م
        { wch: 12 }, // رقم الأوردر
        { wch: 22 }, // الاسم
        { wch: 14 }, // تليفون
        { wch: 14 }, // تليفون بديل
        { wch: 30 }, // العنوان
        { wch: 14 }, // المدينة/المركز
        { wch: 14 }, // المحافظة
        { wch: 12 }, // التاكيد
        { wch: 18 }, // ملاحظات
        { wch: 22 }, // القطعة 1
        { wch: 12 }, // اللون
        { wch: 12 }, // المقاس
        { wch: 7 },  // عددها
        { wch: 9 },  // سعرها
        { wch: 22 }, // القطعة 2
        { wch: 7 },  // عددها
        { wch: 9 },  // سعرها
        { wch: 22 }, // القطعة 3
        { wch: 7 },  // عددها
        { wch: 9 },  // سعرها
        { wch: 8 },  // الشحن
        { wch: 10 }, // الإجمالي
        { wch: 12 }, // تصفية
        { wch: 18 }, // الوكيل
        { wch: 14 }, // المصدر
        { wch: 18 }, // ملاحظات الموظف
        { wch: 14 }, // التاريخ
      ];

      ws["!rows"] = [
        { hpt: 30 }, { hpt: 10 }, { hpt: 25 }, { hpt: 25 },
      ];
      for (let r = 4; r < allRows.length; r++) {
        ws["!rows"].push({ hpt: 22 });
      }

      ws["!dir"] = "rtl";
      const sheetName = agentName.length > 31 ? agentName.substring(0, 31) : agentName;
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    }

    if (Object.keys(agentGroups).length === 0) {
      const ws = XLSX.utils.aoa_to_sheet([["لا توجد أوردرات مؤكدة للتصدير"]]);
      XLSX.utils.book_append_sheet(wb, ws, "فارغ");
    }

    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const filename = `shipping_sheet_${new Date().toISOString().split("T")[0]}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (error: any) {
    console.error("Shipping export error:", error);
    res.status(500).json({ error: "حدث خطأ أثناء تصدير شيت الشحن" });
  }
}

// ==================== VALIDATE SHIPPING DATA ====================

async function validateShippingData(req: Request, res: Response) {
  try {
    const orders = await getFilteredOrders(req);
    const result = validateOrdersForShipping(orders);
    res.json({ totalOrders: orders.length, ...result });
  } catch (error: any) {
    console.error("Validation error:", error);
    res.status(500).json({ error: "حدث خطأ أثناء التحقق من البيانات" });
  }
}

// ==================== PRINTABLE PDF SHIPPING LABELS ====================

function getSourceBranding(order: any): { logo: string; name: string; color: string } {
  const source = (order.source || '').toLowerCase();
  const adName = (order.adName || '').trim();

  if (source === 'facebook') {
    return {
      logo: 'https://d2xsxph8kpxj0f.cloudfront.net/310519663375135838/HcrR8sAS4ry64VmnqEHaLw/farahat-logo_f7ceef8f.png',
      name: adName || 'فيسبوك',
      color: '#8B4513',
    };
  }

  if (source === 'easyorder') {
    const lowerAd = adName.toLowerCase();
    if (lowerAd.includes('فرحات') || lowerAd.includes('farhat')) {
      return {
        logo: 'https://d2xsxph8kpxj0f.cloudfront.net/310519663375135838/HcrR8sAS4ry64VmnqEHaLw/farahat-logo_f7ceef8f.png',
        name: 'فرحات للنحاس',
        color: '#8B4513',
      };
    }
    return {
      logo: 'https://d2xsxph8kpxj0f.cloudfront.net/310519663375135838/HcrR8sAS4ry64VmnqEHaLw/ataba-logo_82bee04f.jpg',
      name: adName || 'عتبه - Ataba',
      color: '#2d6a4f',
    };
  }

  return {
    logo: 'https://d2xsxph8kpxj0f.cloudfront.net/310519663375135838/HcrR8sAS4ry64VmnqEHaLw/farahat-logo_f7ceef8f.png',
    name: adName || source || 'غير محدد',
    color: '#8B4513',
  };
}

async function generateQRDataURL(text: string): Promise<string> {
  try {
    return await QRCode.toDataURL(text, { width: 120, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
  } catch {
    return '';
  }
}

async function buildLabelHTML(order: any, _shippingCost?: number): Promise<string> {
  const products = parseOrderProducts(order);
  const cleanAddress = formatAddress(order.customerAddress, order.governorate);
  const totalCost = Number(order.totalAmount);
  const branding = getSourceBranding(order);
  const orderDate = order.createdAt ? new Date(order.createdAt).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long', day: 'numeric' }) : '';

  let productInfoHTML = "";
  const orderItems = Array.isArray(order.items) ? order.items : [];
  if (orderItems.length > 0) {
    // عرض كل صنف/حفر بعدده المستقل
    productInfoHTML = orderItems.map((it: any) => {
      const parts = String(it.productName || "").split(" - ");
      const name = parts[0] || it.productName || "صنف";
      const variant = parts[1] || "";
      return `<tr><td class="lbl">${name}${variant ? ` (${variant})` : ""}</td><td>× ${it.quantity || 1}</td></tr>`;
    }).join("");
    const totalQty = orderItems.reduce((s: number, it: any) => s + (Number(it.quantity) || 0), 0);
    productInfoHTML += `<tr><td class="lbl"><strong>إجمالي القطع</strong></td><td><strong>${totalQty || order.quantity || 1}</strong></td></tr>`;
    if (order.color) productInfoHTML += `<tr><td class="lbl">اللون</td><td>${order.color}</td></tr>`;
    if (order.size) productInfoHTML += `<tr><td class="lbl">المقاس</td><td>${order.size}</td></tr>`;
  } else if (products.length <= 1) {
    const productName = products[0] || order.productName || "N/A";
    const parts = productName.split(" - ");
    const name = parts[0] || productName;
    const variant = parts[1] || "";
      productInfoHTML = `
      <tr><td class="lbl">المنتج</td><td>${name}</td></tr>
      ${variant ? `<tr><td class="lbl">النوع</td><td>${variant}</td></tr>` : ''}
      ${order.color ? `<tr><td class="lbl">اللون</td><td>${order.color}</td></tr>` : ''}
      ${order.size ? `<tr><td class="lbl">المقاس</td><td>${order.size}</td></tr>` : ''}
      <tr><td class="lbl">الكمية</td><td>${order.quantity || 1}</td></tr>
    `;
  } else {
    productInfoHTML = products.map((p: string, i: number) => {
      const parts = p.split(" - ");
      const name = parts[0] || p;
      const variant = parts[1] || "";
      return `<tr><td class="lbl">منتج ${i + 1}</td><td>${name}${variant ? ` (${variant})` : ""}</td></tr>`;
    }).join("");
    productInfoHTML += `
      <tr><td class="lbl">الكمية</td><td>${order.quantity || products.length}</td></tr>
    `;
  }

  const qrText = order.serialNumber || `ORD-${new Date(order.createdAt || Date.now()).getFullYear()}-${String(order.id).padStart(6, '0')}`;
  const qrDataURL = await generateQRDataURL(qrText);

  const cleanNotes = sanitizeNotes(order.notes);
  return `
    <div class="label" dir="rtl">
      <!-- HEADER: Logo + Title + QR -->
      <div class="label-header" style="border-bottom-color: ${branding.color}">
        <img src="${branding.logo}" alt="${branding.name}" class="brand-logo" />
        <div class="header-center">
          <h1 class="title" style="color: ${branding.color}">بوليصة شحن</h1>
          <div class="order-meta">
            <span><strong>#</strong> ${order.orderNumber || order.id}</span>
            ${orderDate ? `<span>${orderDate}</span>` : ''}
            <span class="source-badge" style="background: ${branding.color}">${branding.name}</span>
          </div>
        </div>
        <div class="qr-block">
          ${qrDataURL ? `<img src="${qrDataURL}" alt="QR" class="qr-img" />` : ''}
          <div class="serial-num">${qrText}</div>
        </div>
      </div>

      <!-- TWO COLUMNS: Customer + Order Details -->
      <div class="two-col">
        <div class="col">
          <div class="col-title" style="color:${branding.color}">بيانات العميل</div>
          <table class="info-table">
            <tr><td class="lbl">الاسم</td><td>${order.customerName || 'N/A'}</td></tr>
            <tr><td class="lbl">التليفون</td><td>${order.customerPhone || 'N/A'}</td></tr>
            ${order.customerPhone2 ? `<tr><td class="lbl">بديل</td><td>${order.customerPhone2}</td></tr>` : ''}
            <tr><td class="lbl">المحافظة</td><td>${order.governorate || 'غير محدد'}</td></tr>
            ${order.city ? `<tr><td class="lbl">المدينة</td><td>${order.city}</td></tr>` : ''}
            <tr><td class="lbl">العنوان</td><td class="addr">${cleanAddress}</td></tr>
          </table>
        </div>
        <div class="col">
          <div class="col-title" style="color:${branding.color}">تفاصيل الأوردر</div>
          <table class="info-table">
            ${productInfoHTML}
          </table>
          <div class="payment-box" style="border-color:${branding.color}">
            <span class="pay-label">المبلغ المطلوب:</span>
            <span class="pay-amount" style="color:${branding.color}">${totalCost.toLocaleString()} ج.م</span>
          </div>
        </div>
      </div>

      ${cleanNotes ? `
      <div class="notes-row">
        <span class="notes-title">ملاحظات:</span>
        <span class="notes-val">${cleanNotes}</span>
      </div>` : ''}
    </div>
  `;
}

async function exportPrintLabels(req: Request, res: Response) {
  try {
    const { orderIds } = req.query;

    if (!orderIds) {
      return res.status(400).json({ error: "يرجى تحديد أوردرات للطباعة" });
    }

    const ids = String(orderIds).split(",").map(Number).filter(Boolean);
    if (ids.length === 0) {
      return res.status(400).json({ error: "لم يتم تحديد أوردرات صالحة" });
    }

    const result = await getOrders({ limit: 100000 });
    const orders = result.orders.filter((o: any) => ids.includes(o.id));

    if (orders.length === 0) {
      return res.status(404).json({ error: "لم يتم العثور على الأوردرات المحددة" });
    }

    // إرفاق بنود كل أوردر (order_items) لإظهار التفصيل في اللابل
    const itemsMap = await getOrderItemsForOrders(ids);
    for (const o of orders) {
      (o as any).items = itemsMap.get(o.id) || [];
    }

    await markOrdersAsPrinted(ids);

    const labelsHTML = (await Promise.all(orders.map((order: any) => buildLabelHTML(order)))).join("");

    const fullHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Shipping Labels - ${orders.length} orders</title>
  <style>
    @page { size: A4 portrait; margin: 10mm 12mm; }
    @media print { .no-print { display: none !important; } body { background: #fff; } .label { box-shadow: none; margin: 0; } }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Arial', 'Helvetica Neue', sans-serif; font-size: 11px; color: #111; background: #f0f0f0; direction: rtl; }
    .print-bar { position: fixed; top: 0; left: 0; right: 0; background: #8B4513; color: #fff; padding: 8px 20px; display: flex; align-items: center; justify-content: space-between; z-index: 1000; }
    .print-bar button { background: #fff; color: #8B4513; border: none; padding: 6px 20px; font-size: 13px; font-weight: bold; border-radius: 4px; cursor: pointer; }
    .labels-container { margin-top: 55px; }
    .label { page-break-after: always; page-break-inside: avoid; padding: 12px 16px; max-width: 186mm; margin: 10px auto; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.15); }
    .label:last-child { page-break-after: auto; }
    /* HEADER */
    .label-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-bottom: 8px; border-bottom: 2px solid #2d6a4f; margin-bottom: 10px; }
    .brand-logo { height: 48px; width: auto; object-fit: contain; flex-shrink: 0; }
    .header-center { flex: 1; text-align: center; }
    .title { font-size: 17px; font-weight: bold; margin-bottom: 4px; }
    .order-meta { display: flex; flex-wrap: wrap; gap: 6px 14px; justify-content: center; font-size: 10px; color: #444; }
    .source-badge { display: inline-block; color: #fff; padding: 2px 10px; border-radius: 12px; font-size: 10px; font-weight: bold; }
    .qr-block { display: flex; flex-direction: column; align-items: center; gap: 2px; flex-shrink: 0; }
    .qr-img { width: 72px; height: 72px; border: 1px solid #ccc; border-radius: 3px; }
    .serial-num { font-size: 8px; font-weight: bold; color: #333; text-align: center; max-width: 72px; word-break: break-all; }
    /* TWO COLUMNS */
    .two-col { display: flex; gap: 10px; margin-bottom: 8px; }
    .col { flex: 1; border: 1px solid #ddd; border-radius: 5px; padding: 7px 10px; }
    .col-title { font-size: 12px; font-weight: bold; margin-bottom: 6px; padding-bottom: 4px; border-bottom: 1px solid #eee; }
    .info-table { width: 100%; border-collapse: collapse; }
    .info-table tr { border-bottom: 1px solid #f0f0f0; }
    .info-table tr:last-child { border-bottom: none; }
    .info-table td { padding: 3px 2px; font-size: 11px; line-height: 1.5; vertical-align: top; }
    .info-table td.lbl { font-weight: bold; color: #555; white-space: nowrap; padding-left: 8px; width: 60px; }
    .info-table td.addr { font-size: 10.5px; line-height: 1.5; }
    /* PAYMENT */
    .payment-box { margin-top: 8px; border: 2px solid #2d6a4f; border-radius: 5px; padding: 5px 10px; display: flex; align-items: center; justify-content: space-between; background: #f0f7f0; }
    .pay-label { font-size: 11px; font-weight: bold; color: #333; }
    .pay-amount { font-size: 16px; font-weight: bold; }
    /* NOTES */
    .notes-row { background: #fffde7; border: 1px solid #f9a825; border-radius: 5px; padding: 5px 10px; font-size: 10.5px; line-height: 1.6; }
    .notes-title { font-weight: bold; color: #e65100; margin-left: 6px; }
    .notes-val { color: #333; white-space: pre-wrap; word-break: break-word; }
  </style>
</head>
<body>
  <div class="print-bar no-print">
    <span>Shipping Labels — ${orders.length} order(s)</span>
    <button onclick="window.print()">\u{1F5A8} Print / Save as PDF</button>
  </div>
  <div class="labels-container">
    ${labelsHTML}
  </div>
  <script>
    window.addEventListener('load', function() {
      setTimeout(function() { window.print(); }, 500);
    });
  </script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(fullHTML);
  } catch (error: any) {
    console.error("Print labels error:", error);
    res.status(500).json({ error: "حدث خطأ أثناء إنشاء ملف الطباعة" });
  }
}

// ==================== REGISTER ROUTES ====================

export function registerExportRoutes(app: Express) {
  app.get("/api/export/confirmed", requireAdminOrManager, exportConfirmedOrders);
  app.get("/api/export/shipping", requireAdminOrManager, exportShippingSheet);
  app.get("/api/export/shipping/validate", requireAdminOrManager, validateShippingData);
  app.get("/api/export/print-labels", requireAdminOrManager, exportPrintLabels);
}
