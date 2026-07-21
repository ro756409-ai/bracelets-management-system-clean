/**
 * تحليل أعمق: webhook_logs لها 43 طلب، لكن الأوردرات من webhook 66
 * المشكلة: بعض الـ webhook_logs لها نفس التليفون لكن أوردرات مختلفة
 */

import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// جلب webhook_logs اليوم مع التفاصيل
const [wlogs] = await conn.execute(`
  SELECT id, customerPhone, externalOrderId, itemsCount, receivedAt
  FROM webhook_logs 
  WHERE DATE(receivedAt) = '2026-04-18' AND status = 'success'
  ORDER BY receivedAt ASC
`);
console.log(`webhook_logs اليوم: ${wlogs.length}`);

// جلب أوردرات من webhook (بعد أول webhook)
const [webhookOrders] = await conn.execute(`
  SELECT id, orderNumber, customerPhone, productName, createdAt
  FROM orders 
  WHERE createdAt >= '2026-04-18T04:06:22.000Z'
  AND createdAt < '2026-04-18 22:00:00'
  ORDER BY createdAt ASC
`);
console.log(`أوردرات من webhook (بعد 04:06): ${webhookOrders.length}`);

// مقارنة: كل تليفون في webhook_logs مع أوردراته
const phoneToLogs = {};
for (const log of wlogs) {
  if (!phoneToLogs[log.customerPhone]) phoneToLogs[log.customerPhone] = [];
  phoneToLogs[log.customerPhone].push(log);
}

const phoneToOrders = {};
for (const order of webhookOrders) {
  if (!phoneToOrders[order.customerPhone]) phoneToOrders[order.customerPhone] = [];
  phoneToOrders[order.customerPhone].push(order);
}

// تليفونات لها أكثر من أوردر في webhook
let extraOrders = 0;
for (const [phone, orders] of Object.entries(phoneToOrders)) {
  const logs = phoneToLogs[phone] || [];
  if (orders.length > logs.length) {
    extraOrders += orders.length - logs.length;
    console.log(`  ${phone}: ${logs.length} webhook_log → ${orders.length} أوردر (زيادة: ${orders.length - logs.length})`);
    orders.forEach(o => console.log(`    #${o.orderNumber} ${o.productName.substring(0, 50)} @ ${o.createdAt}`));
  }
}

console.log(`\nإجمالي أوردرات زيادة من webhook: ${extraOrders}`);
console.log(`المتوقع: 66 - 43 = ${66 - 43}`);

// فحص: هل في webhook_logs لها نفس التليفون مكررة؟
const dupPhones = Object.entries(phoneToLogs).filter(([p, logs]) => logs.length > 1);
console.log(`\nتليفونات مكررة في webhook_logs: ${dupPhones.length}`);
dupPhones.forEach(([p, logs]) => {
  console.log(`  ${p}: ${logs.length} طلب`);
  logs.forEach(l => console.log(`    ${l.externalOrderId} @ ${l.receivedAt}`));
});

await conn.end();
