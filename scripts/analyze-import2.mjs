import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// webhook_logs اليوم
const [wlogs] = await conn.execute(`
  SELECT customerPhone FROM webhook_logs 
  WHERE DATE(receivedAt) = '2026-04-18' AND status = 'success'
`);
const webhookPhones = new Set(wlogs.map(r => r.customerPhone));

// أوردرات الاستيراد الثاني (10:51 UTC = 12:51 القاهرة)
// هذه الأوردرات جاءت في نفس الوقت تقريباً (10:51)
const [import2] = await conn.execute(`
  SELECT id, orderNumber, customerPhone, productName, createdAt
  FROM orders 
  WHERE createdAt >= '2026-04-18 14:50:00' AND createdAt <= '2026-04-18 14:52:00'
`);
console.log('أوردرات في نطاق 14:50-14:52 UTC:', import2.length);

// فحص نطاق أوسع
const [allImport] = await conn.execute(`
  SELECT id, orderNumber, customerPhone, productName, createdAt
  FROM orders 
  WHERE createdAt >= '2026-04-18 14:00:00' AND createdAt <= '2026-04-18 15:00:00'
  ORDER BY createdAt
`);
console.log('أوردرات في نطاق 14:00-15:00 UTC:', allImport.length);

// فحص: الأوردرات 463-485 بالـ id
const [byNum] = await conn.execute(`
  SELECT id, orderNumber, customerPhone, productName, createdAt
  FROM orders 
  WHERE CAST(orderNumber AS UNSIGNED) BETWEEN 463 AND 485
  ORDER BY CAST(orderNumber AS UNSIGNED)
`);
console.log('\nأوردرات 463-485:');
byNum.forEach(o => {
  const inWH = webhookPhones.has(o.customerPhone) ? 'في webhook' : 'مش في webhook';
  console.log(`  #${o.orderNumber} ${o.customerPhone} ${inWH} @ ${o.createdAt}`);
});

// تحليل الأوردرات اللي مش في webhook_logs
const notInWebhook = byNum.filter(o => !webhookPhones.has(o.customerPhone));
const inWebhook = byNum.filter(o => webhookPhones.has(o.customerPhone));
console.log(`\nمن 463-485: ${inWebhook.length} في webhook, ${notInWebhook.length} مش في webhook`);

// الأوردرات الكاملة اليوم
const [todayAll] = await conn.execute(`
  SELECT id, orderNumber, customerPhone, productName, createdAt
  FROM orders 
  WHERE createdAt >= '2026-04-17 22:00:00' AND createdAt < '2026-04-18 22:00:00'
  ORDER BY createdAt
`);

const todayNotInWebhook = todayAll.filter(o => !webhookPhones.has(o.customerPhone));
const todayInWebhook = todayAll.filter(o => webhookPhones.has(o.customerPhone));

console.log(`\nأوردرات اليوم الإجمالية: ${todayAll.length}`);
console.log(`في webhook_logs: ${todayInWebhook.length}`);
console.log(`مش في webhook_logs: ${todayNotInWebhook.length}`);
console.log(`Easy Order يقول: 59`);
console.log(`الفرق (زيادة): ${todayAll.length - 59}`);

// الأوردرات اللي مش في webhook - هل هي طلبات حقيقية؟
console.log('\nأوردرات اليوم مش في webhook (كلها):');
todayNotInWebhook.forEach(o => console.log(`  #${o.orderNumber} ${o.customerPhone} ${o.productName.substring(0, 40)} @ ${o.createdAt}`));

await conn.end();
