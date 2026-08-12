/**
 * ══════════════════════════════════════════════════════════
 *  LEGACY MAINTENANCE SCRIPT — MANUAL USE ONLY
 * ══════════════════════════════════════════════════════════
 *
 * دمج الأوردرات المكررة اللي المنطق القديم أنشأها (أوردر لكل منتج في الطلب الواحد).
 * المكرر = نفس التليفون + فرق وقت إنشاء ≤ ١٠ دقايق. الأول يفضل، الباقي يتدمج فيه ويتحذف.
 *
 *   node scripts/cleanup-duplicates.mjs                 ← معاينة (مفيش كتابة)
 *   node scripts/cleanup-duplicates.mjs --business 7    ← معاينة لنشاط واحد
 *   node scripts/cleanup-duplicates.mjs --apply         ← تنفيذ
 *
 * **إعادة الترقيم متشالت** — ممنوعة بقاعدة المشروع (راجع renumber.mjs). السكربت ده
 * بيدمج ويحذف المكرر بس.
 */

import mysql from "mysql2/promise";
import { assertScriptSafety } from "./_safety.mjs";

const { apply } = assertScriptSafety({ name: "cleanup-duplicates", destructive: true });

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const businessId = argValue("business");

const conn = await mysql.createConnection(process.env.DATABASE_URL);

const scopeClause = businessId ? "WHERE businessId = ?" : "";
const scopeArgs = businessId ? [Number(businessId)] : [];

const [allOrders] = await conn.execute(
  `SELECT id, orderNumber, customerPhone, productName, quantity, totalAmount, createdAt
   FROM orders ${scopeClause} ORDER BY id ASC`,
  scopeArgs
);

console.log(`إجمالي الأوردرات${businessId ? ` (نشاط ${businessId})` : ""}: ${allOrders.length}`);

// تجميع المكرر: نفس التليفون + فرق وقت ≤ ١٠ دقايق
const groups = [];
const processed = new Set();
for (let i = 0; i < allOrders.length; i++) {
  if (processed.has(allOrders[i].id)) continue;
  const base = allOrders[i];
  const group = [base];
  processed.add(base.id);
  const baseTime = new Date(base.createdAt).getTime();
  for (let j = i + 1; j < allOrders.length; j++) {
    if (processed.has(allOrders[j].id)) continue;
    const cand = allOrders[j];
    if (
      cand.customerPhone === base.customerPhone &&
      Math.abs(new Date(cand.createdAt).getTime() - baseTime) <= 10 * 60 * 1000
    ) {
      group.push(cand);
      processed.add(cand.id);
    }
  }
  if (group.length > 1) groups.push(group);
}

const totalDupes = groups.reduce((sum, g) => sum + g.length - 1, 0);
console.log(`مجموعات مكررة: ${groups.length}`);
console.log(`أوردرات هتتحذف: ${totalDupes}`);
console.log(`الأوردرات بعد الدمج: ${allOrders.length - totalDupes}\n`);

// عيّنة من اللي هيحصل — في المعاينة والتنفيذ.
for (const group of groups.slice(0, 5)) {
  const parts = group.map(o => {
    const q = o.quantity || 1;
    return q > 1 ? `${o.productName || ""} ×${q}` : o.productName || "";
  });
  console.log(`دمج: ${group.map(o => "#" + o.orderNumber).join(", ")} → #${group[0].orderNumber}`);
  console.log(`  → ${parts.join(" + ").slice(0, 80)}`);
}

if (!apply) {
  console.log("\nدي معاينة. مفيش أي أوردر اتغيّر. للتنفيذ زوّد --apply — وخُد Backup الأول.\n");
  await conn.end();
  process.exit(0);
}

let merged = 0;
let deleted = 0;
for (const group of groups) {
  const primary = group[0];
  const parts = [];
  let totalQty = 0;
  let totalAmt = 0;
  for (const o of group) {
    const q = o.quantity || 1;
    parts.push(q > 1 ? `${o.productName || ""} ×${q}` : o.productName || "");
    totalQty += q;
    totalAmt += parseFloat(o.totalAmount || "0");
  }
  await conn.execute(
    "UPDATE orders SET productName = ?, quantity = ?, totalAmount = ? WHERE id = ?",
    [parts.join(" + "), totalQty, totalAmt.toFixed(2), primary.id]
  );
  for (const dup of group.slice(1)) {
    await conn.execute("DELETE FROM orders WHERE id = ?", [dup.id]);
    deleted++;
  }
  merged++;
}

console.log(`\n✓ اتدمج ${merged} مجموعة واتحذف ${deleted} أوردر مكرر.`);
console.log("إعادة الترقيم متشالت عن قصد — ممنوعة بقاعدة المشروع.\n");
await conn.end();
process.exit(0);
