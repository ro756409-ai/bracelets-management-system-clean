#!/usr/bin/env node
/**
 * ══════════════════════════════════════════════════════════
 *  LEGACY MAINTENANCE SCRIPT — MANUAL USE ONLY
 * ══════════════════════════════════════════════════════════
 *
 * حذف أوردرات غلط اتسجّلت من قناة flash box (websiteId 26) في يومين محددين
 * (١-٢ يونيو ٢٠٢٦). سكربت لمرة واحدة بتواريخ ثابتة — مش أداة عامة.
 *
 *   node scripts/fix-orders.mjs           ← معاينة (بيعرض اللي هيتحذف، مفيش كتابة)
 *   node scripts/fix-orders.mjs --apply   ← تنفيذ
 */

import { assertScriptSafety } from "./_safety.mjs";
import { db } from "../server/db.ts";
import { orders, salesChannels } from "../drizzle/schema.ts";
import { eq, and, inArray, sql } from "drizzle-orm";

const { apply } = assertScriptSafety({ name: "fix-orders", destructive: true });

const DATE_FILTER = sql`DATE(${orders.createdAt}) IN ('2026-06-01', '2026-06-02')`;
const BAD_SOURCES = ["easyorder_farhat", "easyorder_ataba"];
const BAD_WEBSITE_ID = 26; // flash box

async function main() {
  const channels = await db.select().from(salesChannels);
  console.log("القنوات:");
  channels.forEach(ch => console.log(`  - #${ch.id} ${ch.name} (${ch.platform})`));

  const targets = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      source: orders.source,
      websiteId: orders.websiteId,
      createdAt: orders.createdAt,
    })
    .from(orders)
    .where(and(DATE_FILTER, inArray(orders.source, BAD_SOURCES), eq(orders.websiteId, BAD_WEBSITE_ID)));

  console.log(`\nأوردرات مرشّحة للحذف: ${targets.length}`);
  targets.slice(0, 10).forEach(o =>
    console.log(`  - #${o.orderNumber} (${o.source}, website ${o.websiteId}, ${o.createdAt})`)
  );

  if (!apply) {
    console.log("\nدي معاينة. مفيش أي أوردر اتحذف. للتنفيذ زوّد --apply — وخُد Backup الأول.\n");
    process.exit(0);
  }

  await db
    .delete(orders)
    .where(and(DATE_FILTER, inArray(orders.source, BAD_SOURCES), eq(orders.websiteId, BAD_WEBSITE_ID)));

  const [{ count }] = await db.select({ count: sql`COUNT(*)` }).from(orders);
  console.log(`\n✓ اتحذف ${targets.length} أوردر. إجمالي المتبقي: ${count}\n`);
  process.exit(0);
}

main().catch(err => {
  console.error("❌ خطأ:", err.message);
  process.exit(1);
});
