import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// جلب الأوردرات بدون عنوان
const [emptyOrders] = await conn.execute(`
  SELECT id, orderNumber, customerName, customerPhone, customerAddress, governorate, externalOrderId
  FROM orders 
  WHERE customerAddress IS NULL OR customerAddress = '' OR TRIM(customerAddress) = ''
  LIMIT 5
`);

console.log(`أوردرات بدون عنوان: ${emptyOrders.length}`);

for (const order of emptyOrders) {
  console.log(`\n#${order.orderNumber} - ${order.customerName} - ${order.customerPhone}`);
  
  // البحث في webhook_logs بالـ externalOrderId أو التليفون
  let logs = [];
  if (order.externalOrderId) {
    const [r] = await conn.execute(
      'SELECT rawPayload FROM webhook_logs WHERE externalOrderId = ? LIMIT 1',
      [order.externalOrderId]
    );
    logs = r;
  }
  
  if (!logs.length) {
    const [r] = await conn.execute(
      'SELECT rawPayload FROM webhook_logs WHERE customerPhone = ? LIMIT 1',
      [order.customerPhone]
    );
    logs = r;
  }
  
  if (logs[0]?.rawPayload) {
    const addrMatch = logs[0].rawPayload.match(/"address":"([^"]+)"/);
    console.log('  address in payload:', addrMatch ? addrMatch[1] : 'NOT FOUND');
  } else {
    console.log('  No webhook_log found - came from manual import');
  }
}

// إجمالي
const [total] = await conn.execute(`SELECT COUNT(*) as cnt FROM orders WHERE customerAddress IS NULL OR customerAddress = ''`);
console.log(`\nإجمالي بدون عنوان: ${total[0].cnt}`);

// هل هذه من استيراد يدوي؟
const [importCount] = await conn.execute(`
  SELECT COUNT(*) as cnt FROM orders 
  WHERE (customerAddress IS NULL OR customerAddress = '') 
  AND importRowIndex IS NOT NULL
`);
console.log(`منها من استيراد يدوي: ${importCount[0].cnt}`);

const [webhookCount] = await conn.execute(`
  SELECT COUNT(*) as cnt FROM orders 
  WHERE (customerAddress IS NULL OR customerAddress = '') 
  AND source = 'easyorder' AND importRowIndex IS NULL
`);
console.log(`منها من webhook: ${webhookCount[0].cnt}`);

await conn.end();
