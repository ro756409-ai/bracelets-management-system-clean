import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// webhook_logs اليوم
const [wlogs] = await conn.execute(`
  SELECT customerPhone, externalOrderId FROM webhook_logs 
  WHERE DATE(receivedAt) = '2026-04-18' AND status = 'success'
`);
const webhookPhones = new Set(wlogs.map(r => r.customerPhone));
console.log('تليفونات في webhook_logs اليوم:', webhookPhones.size);

// أوردرات اليوم
const [todayOrders] = await conn.execute(`
  SELECT orderNumber, customerPhone, productName, createdAt 
  FROM orders 
  WHERE createdAt >= '2026-04-17 22:00:00' AND createdAt < '2026-04-18 22:00:00' 
  ORDER BY createdAt
`);
console.log('أوردرات اليوم الإجمالية:', todayOrders.length);

const inWebhook = todayOrders.filter(o => webhookPhones.has(o.customerPhone));
const notInWebhook = todayOrders.filter(o => !webhookPhones.has(o.customerPhone));

console.log('أوردرات اليوم في webhook_logs:', inWebhook.length);
console.log('أوردرات اليوم مش في webhook_logs:', notInWebhook.length);

console.log('\nأوردرات اليوم مش في webhook (أول 20):');
notInWebhook.slice(0, 20).forEach(r => console.log(`  #${r.orderNumber} ${r.customerPhone} ${r.productName.substring(0, 40)}`));

// ملخص: 
// 43 في webhook = 43 طلب وصل من Easy Order اليوم
// 80 - 43 = 37 أوردر جاءت من استيراد يدوي قديم
// Easy Order يقول 59 = 43 webhook + 16 استيراد قديم حقيقي

console.log('\n=== ملخص ===');
console.log(`webhook اليوم: ${inWebhook.length}`);
console.log(`استيراد يدوي اليوم: ${notInWebhook.length}`);
console.log(`Easy Order يقول: 59`);
console.log(`الفرق: ${notInWebhook.length} - (59 - ${inWebhook.length}) = ${notInWebhook.length - (59 - inWebhook.length)} أوردر زيادة من الاستيراد`);

await conn.end();
