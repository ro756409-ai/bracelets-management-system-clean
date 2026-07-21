import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// جلب webhook_logs مع short_id من rawPayload
const [logs] = await conn.execute(`
  SELECT externalOrderId, rawPayload 
  FROM webhook_logs 
  WHERE status = 'success' AND rawPayload IS NOT NULL
`);

console.log(`webhook_logs للمعالجة: ${logs.length}`);

let updated = 0;
let notFound = 0;

for (const log of logs) {
  const match = log.rawPayload?.match(/"short_id":(\d+)/);
  if (match && log.externalOrderId) {
    const shortId = parseInt(match[1]);
    const [result] = await conn.execute(
      'UPDATE orders SET easyOrderShortId = ? WHERE externalOrderId = ? AND easyOrderShortId IS NULL',
      [shortId, log.externalOrderId]
    );
    if (result.affectedRows > 0) updated++;
    else notFound++;
  }
}

console.log(`تم تحديث: ${updated} أوردر`);
console.log(`لم يُوجد: ${notFound}`);

// التحقق
const [sample] = await conn.execute(`
  SELECT orderNumber, easyOrderShortId 
  FROM orders 
  WHERE easyOrderShortId IS NOT NULL 
  ORDER BY CAST(orderNumber AS UNSIGNED) DESC 
  LIMIT 10
`);
console.log('\nعينة من الأوردرات المحدثة:');
sample.forEach(r => console.log(`  #${r.orderNumber} → Easy Order #${r.easyOrderShortId}`));

const [nullCount] = await conn.execute(`
  SELECT COUNT(*) as cnt FROM orders 
  WHERE source = 'easyorder' AND easyOrderShortId IS NULL
`);
console.log(`\nأوردرات Easy Order بدون shortId: ${nullCount[0].cnt}`);

await conn.end();
