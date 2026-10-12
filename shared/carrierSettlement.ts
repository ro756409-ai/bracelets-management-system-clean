import { toMinorUnits } from "./accountingMoney";

/**
 * كشف تسوية شركة الشحن (المرحلة 3) — صيغة CSV موحّدة موثّقة (لا تخمين لصيغة بوسطة):
 *   shipment,cod,fees,net
 *   رقم الشحنة أو رقم التتبع, مبلغ التحصيل, رسوم الشحن والتحصيل (شاملة الضريبة كما في الكشف), الصافي
 * المعادلة إلزامية لكل سطر: cod − fees = net (الصافي قد يكون سالبًا لسطر رسوم فقط، مثل مرتجع).
 */
export type SettlementLine = { row: number; shipment: string; cod: string; fees: string; net: string };
export type SettlementParse = { lines: SettlementLine[]; errors: { row: number; reason: string }[] };

const AMOUNT = /^-?\d{1,14}(\.\d{1,4})?$/;

export function parseSettlementCsv(text: string): SettlementParse {
  const rows = text.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  const out: SettlementParse = { lines: [], errors: [] };
  if (rows.length === 0) return out;
  const header = rows[0].split(",").map(h => h.trim().toLowerCase());
  const idx = (k: string) => header.indexOf(k);
  const [iS, iC, iF, iN] = ["shipment", "cod", "fees", "net"].map(idx);
  if ([iS, iC, iF, iN].some(i => i < 0)) { out.errors.push({ row: 1, reason: "العناوين المطلوبة: shipment,cod,fees,net" }); return out; }
  const seen = new Set<string>();
  rows.slice(1).forEach((r, k) => {
    const row = k + 2;
    const c = r.split(",").map(x => x.trim());
    const line = { row, shipment: c[iS] ?? "", cod: c[iC] ?? "", fees: c[iF] ?? "", net: c[iN] ?? "" };
    if (!line.shipment) return out.errors.push({ row, reason: "رقم الشحنة فارغ" });
    if (![line.cod, line.fees, line.net].every(v => AMOUNT.test(v))) return out.errors.push({ row, reason: "مبلغ غير صالح (أرقام عشرية حتى 4 خانات، بلا فواصل آلاف)" });
    if (line.cod.startsWith("-") || line.fees.startsWith("-")) return out.errors.push({ row, reason: "التحصيل والرسوم لا يكونان سالبين" });
    if (toMinorUnits(line.cod.replace("-", "")) - toMinorUnits(line.fees.replace("-", "")) !== signed(line.net)) return out.errors.push({ row, reason: `المعادلة غير متسقة: ${line.cod} − ${line.fees} ≠ ${line.net}` });
    if (seen.has(line.shipment)) return out.errors.push({ row, reason: `الشحنة ${line.shipment} مكررة في نفس الكشف` });
    seen.add(line.shipment);
    out.lines.push(line);
  });
  return out;
}

export const signed = (v: string) => (v.startsWith("-") ? -toMinorUnits(v.slice(1)) : toMinorUnits(v));
