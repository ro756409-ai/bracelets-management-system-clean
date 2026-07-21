/**
 * حذف الأوردرات المكررة من الاستيراد اليدوي
 * 
 * المنطق المحدث:
 * - الأوردرات 417-430 جاءت من استيراد يدوي (قبل تفعيل webhook)
 * - الأوردرات 431+ جاءت من webhook
 * - لكل تليفون موجود في webhook_logs اليوم:
 *   إذا كان له أوردر من الاستيراد (أرقام 417-430 أو 463-468) = مكرر → يُحذف
 */

import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

console.log('=== تحليل الأوردرات المكررة ===\n');

// جلب webhook_logs اليوم
const [wlogs] = await conn.execute(`
  SELECT customerPhone, externalOrderId, receivedAt
  FROM webhook_logs 
  WHERE DATE(receivedAt) = '2026-04-18' AND status = 'success'
`);
const webhookPhones = new Set(wlogs.map(r => r.customerPhone));
console.log(`تليفونات في webhook اليوم: ${webhookPhones.size}`);

// جلب أوردرات اليوم
const [todayOrders] = await conn.execute(`
  SELECT id, orderNumber, customerPhone, productName, createdAt
  FROM orders 
  WHERE createdAt >= '2026-04-17 22:00:00' AND createdAt < '2026-04-18 22:00:00'
  ORDER BY createdAt ASC
`);
console.log(`أوردرات اليوم: ${todayOrders.length}`);

// تحديد أوقات وصول webhook
const [firstWebhook] = await conn.execute(`
  SELECT MIN(receivedAt) as first FROM webhook_logs 
  WHERE DATE(receivedAt) = '2026-04-18' AND status = 'success'
`);
const webhookStartTime = new Date(firstWebhook[0].first);
console.log(`أول webhook اليوم: ${webhookStartTime.toISOString()}`);

// الأوردرات من الاستيراد = جاءت قبل أول webhook
// الأوردرات من webhook = جاءت بعد أول webhook أو في نفس الوقت
const importOrders = todayOrders.filter(o => new Date(o.createdAt) < webhookStartTime);
const webhookOrders = todayOrders.filter(o => new Date(o.createdAt) >= webhookStartTime);

console.log(`\nأوردرات من الاستيراد (قبل ${webhookStartTime.toISOString()}): ${importOrders.length}`);
console.log(`أوردرات من webhook (بعد): ${webhookOrders.length}`);

// الأوردرات من الاستيراد اللي تليفونها موجود في webhook = مكررة
const dupImportOrders = importOrders.filter(o => webhookPhones.has(o.customerPhone));
const uniqueImportOrders = importOrders.filter(o => !webhookPhones.has(o.customerPhone));

console.log(`\nأوردرات استيراد مكررة (تليفونها في webhook): ${dupImportOrders.length}`);
console.log(`أوردرات استيراد فريدة (تليفونها مش في webhook): ${uniqueImportOrders.length}`);

console.log('\nأوردرات ستُحذف:');
dupImportOrders.forEach(o => console.log(`  #${o.orderNumber} ${o.customerPhone} ${o.productName.substring(0, 40)}`));

// حذف المكررات
let deletedCount = 0;
for (const order of dupImportOrders) {
  await conn.execute('DELETE FROM orders WHERE id = ?', [order.id]);
  deletedCount++;
}

console.log(`\nتم حذف ${deletedCount} أوردر مكرر`);

// التحقق النهائي
const [total] = await conn.execute('SELECT COUNT(*) as cnt FROM orders');
const [today] = await conn.execute(`
  SELECT COUNT(*) as cnt FROM orders 
  WHERE createdAt >= '2026-04-17 22:00:00' AND createdAt < '2026-04-18 22:00:00'
`);
console.log(`\nإجمالي الأوردرات: ${total[0].cnt}`);
console.log(`أوردرات اليوم: ${today[0].cnt}`);
console.log(`Easy Order يقول: 59`);
console.log(`الفرق: ${today[0].cnt - 59}`);

await conn.end();
