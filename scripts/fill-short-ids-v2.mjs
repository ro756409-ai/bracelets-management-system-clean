/**
 * ملء easyOrderShortId للأوردرات الموجودة
 * الربط: orders.externalOrderId = webhook_logs.externalOrderId
 * استخراج short_id من rawPayload
 */
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// جلب كل webhook_logs مع short_id
const [logs] = await conn.execute(`
  SELECT externalOrderId, rawPayload 
  FROM webhook_logs 
  WHERE rawPayload IS NOT NULL
`);

console.log(`webhook_logs: ${logs.length}`);

// بناء map: externalOrderId → shortId
const shortIdMap = new Map();
for (const log of logs) {
  const match = log.rawPayload?.match(/"short_id":(\d+)/);
  if (match && log.externalOrderId) {
    shortIdMap.set(log.externalOrderId, parseInt(match[1]));
  }
}
console.log(`short_ids مستخرجة: ${shortIdMap.size}`);

// تحديث orders عبر externalOrderId
let updated = 0;
for (const [extId, shortId] of shortIdMap) {
  const [result] = await conn.execute(
    'UPDATE orders SET easyOrderShortId = ? WHERE externalOrderId = ?',
    [shortId, extId]
  );
  if (result.affectedRows > 0) updated++;
}

console.log(`تم تحديث: ${updated} أوردر`);

// التحقق
const [sample] = await conn.execute(`
  SELECT orderNumber, easyOrderShortId, externalOrderId
  FROM orders 
  WHERE easyOrderShortId IS NOT NULL 
  ORDER BY easyOrderShortId DESC
  LIMIT 10
`);
console.log('\nعينة:');
sample.forEach(r => console.log(`  #${r.orderNumber} → Easy Order #${r.easyOrderShortId}`));

const [stats] = await conn.execute(`
  SELECT 
    COUNT(*) as total,
    SUM(CASE WHEN easyOrderShortId IS NOT NULL THEN 1 ELSE 0 END) as withShortId,
    SUM(CASE WHEN source = 'easyorder' AND easyOrderShortId IS NULL THEN 1 ELSE 0 END) as easyOrderWithout
  FROM orders
`);
console.log(`\nإجمالي: ${stats[0].total} | لها shortId: ${stats[0].withShortId} | Easy Order بدون shortId: ${stats[0].easyOrderWithout}`);

await conn.end();
