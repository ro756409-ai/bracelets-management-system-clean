/**
 * حذف الأوردرات المكررة من الاستيراد اليدوي
 * 
 * المنطق:
 * - الأوردرات اللي جاءت من webhook (تليفونها موجود في webhook_logs اليوم) = صحيحة
 * - الأوردرات اللي جاءت من الاستيراد اليدوي ونفس تليفونها في webhook = مكررة → تُحذف
 * - الأوردرات اللي من الاستيراد اليدوي وتليفونها مش في webhook = حقيقية → تبقى
 * 
 * لكن: الأوردرات من webhook جاءت بالمنطق القديم (أوردر لكل منتج)
 * وبعضها اتدمج بالفعل في سكريبت cleanup-duplicates
 * 
 * الحل الأبسط:
 * لكل تليفون في webhook_logs اليوم:
 *   - ابحث عن الأوردر المقابل في DB (من webhook)
 *   - احذف أي أوردر آخر لنفس التليفون في نفس اليوم (من الاستيراد)
 */

import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

console.log('=== حذف الأوردرات المكررة من الاستيراد اليدوي ===\n');

// جلب webhook_logs اليوم
const [wlogs] = await conn.execute(`
  SELECT customerPhone, externalOrderId, receivedAt
  FROM webhook_logs 
  WHERE DATE(receivedAt) = '2026-04-18' AND status = 'success'
  ORDER BY receivedAt ASC
`);

console.log(`webhook_logs اليوم: ${wlogs.length}`);

// لكل تليفون في webhook_logs:
// 1. ابحث عن الأوردر الأحدث (من webhook) - هو الصحيح
// 2. احذف أي أوردرات أقدم لنفس التليفون في نفس اليوم
let deletedCount = 0;
let keptCount = 0;

for (const log of wlogs) {
  const phone = log.customerPhone;
  
  // جلب كل أوردرات هذا التليفون اليوم
  const [orders] = await conn.execute(`
    SELECT id, orderNumber, productName, createdAt
    FROM orders 
    WHERE customerPhone = ? 
    AND createdAt >= '2026-04-17 22:00:00' 
    AND createdAt < '2026-04-18 22:00:00'
    ORDER BY createdAt ASC
  `, [phone]);
  
  if (orders.length <= 1) {
    keptCount++;
    continue;
  }
  
  // الأوردر الأحدث هو من webhook (جاء بعد تفعيل الـ webhook)
  // الأوردرات الأقدم هي من الاستيراد اليدوي
  // نبقي الأحدث ونحذف الأقدم
  const toKeep = orders[orders.length - 1]; // الأحدث
  const toDelete = orders.slice(0, orders.length - 1); // الأقدم
  
  for (const order of toDelete) {
    await conn.execute('DELETE FROM orders WHERE id = ?', [order.id]);
    deletedCount++;
    console.log(`  حذف #${order.orderNumber} (${phone}) - ${order.productName.substring(0, 40)}`);
  }
  
  keptCount++;
}

console.log(`\nتم حذف ${deletedCount} أوردر مكرر`);
console.log(`تم الإبقاء على ${keptCount} أوردر`);

// التحقق النهائي
const [total] = await conn.execute('SELECT COUNT(*) as cnt FROM orders');
const [today] = await conn.execute(`
  SELECT COUNT(*) as cnt FROM orders 
  WHERE createdAt >= '2026-04-17 22:00:00' AND createdAt < '2026-04-18 22:00:00'
`);

console.log(`\nإجمالي الأوردرات: ${total[0].cnt}`);
console.log(`أوردرات اليوم: ${today[0].cnt}`);

await conn.end();
