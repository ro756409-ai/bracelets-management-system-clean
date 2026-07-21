import { readFileSync } from 'fs';
import { createConnection } from 'mysql2/promise';
import { config } from 'dotenv';
import { resolve } from 'path';

config({ path: resolve('/home/ubuntu/bracelets_management_system', '.env') });

const orders = JSON.parse(readFileSync('/home/ubuntu/whatsapp_orders.json', 'utf-8'));

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) throw new Error('DATABASE_URL not found');

const urlMatch = dbUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:/]+):?(\d+)?\/([^?]+)/);
if (!urlMatch) throw new Error('Cannot parse DATABASE_URL');
const [, user, password, host, port, database] = urlMatch;

const conn = await createConnection({
  host,
  port: port ? parseInt(port) : 3306,
  user,
  password,
  database,
  ssl: { rejectUnauthorized: false }
});

console.log('✅ Connected to database');

// تحميل المنتجات للمطابقة
const [productRows] = await conn.execute('SELECT id, name FROM products');
const products = productRows;

function findProductId(productName) {
  if (!productName) return 1;
  const lower = productName.toLowerCase();
  // مطابقة تامة
  let match = products.find(p => p.name === productName);
  if (match) return match.id;
  // مطابقة جزئية
  match = products.find(p => lower.includes(p.name.toLowerCase()) || p.name.toLowerCase().includes(lower));
  if (match) return match.id;
  // كلمات مفتاحية
  if (lower.includes('ساده') || lower.includes('سادة') || lower.includes('ساد')) return 1;
  if (lower.includes('اية الكرسي') || lower.includes('آية الكرسي') || lower.includes('الكرسي')) return 2;
  if (lower.includes('تحصين')) return 3;
  if (lower.includes('فالله') || lower.includes('خير حافظا')) return 4;
  if (lower.includes('منقوش')) return 5;
  if (lower.includes('عين حورس') || lower.includes('حورس')) return 6;
  if (lower.includes('فلق')) return 7;
  return 1; // افتراضي
}

// الحصول على أعلى orderNumber حالي
const [rows] = await conn.execute('SELECT MAX(orderNumber) as maxNum FROM orders');
let nextOrderNum = (rows[0].maxNum || 10000) + 1;
console.log(`📋 بداية ترقيم الأوردرات من: ${nextOrderNum}`);

let inserted = 0;
let skipped = 0;

for (const order of orders) {
  try {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const productId = findProductId(order.productName);
    await conn.execute(
      `INSERT INTO orders (
        orderNumber, customerName, customerPhone,
        customerAddress, governorate, productName, productId, quantity,
        totalAmount, source, status, notes, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nextOrderNum++,
        order.customerName,
        order.customerPhone,
        order.customerAddress || '',
        order.governorate || 'غير محدد',
        order.productName,
        productId,
        order.quantity || 1,
        parseFloat(order.totalAmount) || 0,
        'facebook',
        'new',
        order.notes || null,
        now,
        now,
      ]
    );
    inserted++;
    if (inserted % 20 === 0) console.log(`  📥 تم إدخال ${inserted} أوردر...`);
  } catch (err) {
    console.error(`❌ خطأ في أوردر ${order.customerName}: ${err.message}`);
    skipped++;
  }
}

await conn.end();
console.log(`\n✅ تم إدخال ${inserted} أوردر بنجاح في قاعدة البيانات بـ source=facebook`);
if (skipped > 0) console.log(`⚠️ تم تخطي ${skipped} أوردر بسبب أخطاء`);
