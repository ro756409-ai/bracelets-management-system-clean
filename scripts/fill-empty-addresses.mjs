/**
 * ملء العناوين الفارغة في orders من webhook_logs
 * يستخدم externalOrderId للربط، وإلا يستخدم customerPhone
 */
import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// جلب الأوردرات بدون عنوان
const [emptyOrders] = await conn.execute(`
  SELECT id, orderNumber, customerName, customerPhone, externalOrderId
  FROM orders 
  WHERE (customerAddress IS NULL OR customerAddress = '' OR TRIM(customerAddress) = '')
  AND source = 'easyorder'
`);

console.log(`أوردرات بدون عنوان: ${emptyOrders.length}`);

let updated = 0;
let notFound = 0;

for (const order of emptyOrders) {
  let rawPayload = null;
  
  // محاولة 1: البحث بـ externalOrderId
  if (order.externalOrderId) {
    const [r] = await conn.execute(
      'SELECT rawPayload FROM webhook_logs WHERE externalOrderId = ? AND rawPayload IS NOT NULL LIMIT 1',
      [order.externalOrderId]
    );
    if (r[0]) rawPayload = r[0].rawPayload;
  }
  
  // محاولة 2: البحث بالتليفون
  if (!rawPayload && order.customerPhone) {
    const [r] = await conn.execute(
      'SELECT rawPayload FROM webhook_logs WHERE customerPhone = ? AND rawPayload IS NOT NULL LIMIT 1',
      [order.customerPhone]
    );
    if (r[0]) rawPayload = r[0].rawPayload;
  }
  
  if (!rawPayload) {
    notFound++;
    console.log(`  لم يُوجد payload لـ #${order.orderNumber} - ${order.customerName}`);
    continue;
  }
  
  // استخراج العنوان من rawPayload
  // العنوان قد يحتوي على أحرف خاصة، نستخدم regex بسيط
  const addrMatch = rawPayload.match(/"address"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!addrMatch) {
    notFound++;
    console.log(`  لم يُوجد عنوان في payload لـ #${order.orderNumber}`);
    continue;
  }
  
  // تنظيف العنوان: إزالة escape sequences
  let address = addrMatch[1]
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, '')
    .replace(/\\t/g, ' ')
    .replace(/\\/g, '')
    .trim();
  
  if (!address) {
    notFound++;
    continue;
  }
  
  // تحديث الأوردر
  await conn.execute(
    'UPDATE orders SET customerAddress = ? WHERE id = ?',
    [address, order.id]
  );
  updated++;
  console.log(`  ✓ #${order.orderNumber} - ${order.customerName}: ${address.substring(0, 60)}...`);
}

console.log(`\nتم تحديث: ${updated} أوردر`);
console.log(`لم يُوجد: ${notFound}`);

// التحقق
const [remaining] = await conn.execute(`
  SELECT COUNT(*) as cnt FROM orders 
  WHERE (customerAddress IS NULL OR customerAddress = '') AND source = 'easyorder'
`);
console.log(`متبقي بدون عنوان: ${remaining[0].cnt}`);

await conn.end();
