#!/usr/bin/env node
import { db } from "../server/db.ts";
import { orders, salesChannels } from "../drizzle/schema.ts";
import { eq, and, inArray, sql } from "drizzle-orm";

async function fixOrders() {
  console.log("🔧 جاري إصلاح الأوردرات...\n");

  try {
    // Step 1: فحص قنوات البيع
    console.log("📊 Step 1: فحص قنوات البيع");
    const channels = await db.select().from(salesChannels);
    console.log("القنوات الموجودة:");
    channels.forEach(ch => {
      console.log(`  - ID: ${ch.id}, Name: ${ch.name}, Platform: ${ch.platform}`);
    });

    // Step 2: فحص الأوردرات من يوم 1-2 يونيو
    console.log("\n📊 Step 2: فحص الأوردرات من يوم 1-2 يونيو");
    const juneOrders = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        createdAt: orders.createdAt,
        source: orders.source,
        websiteId: orders.websiteId,
      })
      .from(orders)
      .where(
        sql`DATE(${orders.createdAt}) IN ('2026-06-01', '2026-06-02')`
      )
      .limit(10);

    console.log(`وجدنا ${juneOrders.length} أوردر من يوم 1-2 يونيو`);
    juneOrders.forEach(o => {
      console.log(`  - ID: ${o.id}, Source: ${o.source}, WebsiteID: ${o.websiteId}, Date: ${o.createdAt}`);
    });

    // Step 3: حذف الأوردرات الغلط
    console.log("\n🗑️ Step 3: حذف الأوردرات الغلط");
    const deleteResult = await db
      .delete(orders)
      .where(
        and(
          sql`DATE(${orders.createdAt}) IN ('2026-06-01', '2026-06-02')`,
          inArray(orders.source, ['easyorder_farhat', 'easyorder_ataba']),
          eq(orders.websiteId, 26) // flash box
        )
      );

    console.log(`✅ تم حذف الأوردرات الغلط`);

    // Step 4: التحقق من النتائج
    console.log("\n📊 Step 4: التحقق من النتائج");
    const totalCount = await db
      .select({ count: sql`COUNT(*)` })
      .from(orders);
    
    console.log(`✅ إجمالي الأوردرات المتبقية: ${totalCount[0].count}`);

    console.log("\n✅ تم إصلاح الأوردرات بنجاح!");

  } catch (error) {
    console.error("❌ خطأ:", error.message);
    process.exit(1);
  }
}

fixOrders();
