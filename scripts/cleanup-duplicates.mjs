/**
 * سكريبت تنظيف الأوردرات المكررة
 * 
 * المشكلة: المنطق القديم كان ينشئ أوردر لكل منتج في الطلب الواحد
 * الحل: دمج الأوردرات المكررة (نفس تليفون + نفس وقت الإنشاء ± 5 دقائق) في أوردر واحد
 * 
 * الخطوات:
 * 1. تحديد مجموعات المكررات
 * 2. دمج كل مجموعة في أوردر واحد (الأول يبقى، الباقي تُحذف)
 * 3. إعادة الترقيم من 1
 */

import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

console.log('=== بدء تنظيف الأوردرات المكررة ===\n');

// ==================== خطوة 1: تحليل المكررات ====================

// جلب كل الأوردرات مرتبة بالوقت
const [allOrders] = await conn.execute(`
  SELECT id, orderNumber, customerPhone, customerName, productName, quantity, 
         totalAmount, status, source, governorate, customerAddress, 
         assignedEmployeeId, assignedAt, confirmedAt, postponedTo, 
         cancelReason, notes, createdAt
  FROM orders 
  ORDER BY id ASC
`);

console.log(`إجمالي الأوردرات: ${allOrders.length}`);

// تجميع الأوردرات المكررة: نفس التليفون + فرق وقت ≤ 10 دقائق
const groups = [];
const processed = new Set();

for (let i = 0; i < allOrders.length; i++) {
  if (processed.has(allOrders[i].id)) continue;
  
  const base = allOrders[i];
  const group = [base];
  processed.add(base.id);
  
  const baseTime = new Date(base.createdAt).getTime();
  
  for (let j = i + 1; j < allOrders.length; j++) {
    if (processed.has(allOrders[j].id)) continue;
    
    const candidate = allOrders[j];
    const candTime = new Date(candidate.createdAt).getTime();
    
    // نفس التليفون + فرق وقت ≤ 10 دقائق
    if (
      candidate.customerPhone === base.customerPhone &&
      Math.abs(candTime - baseTime) <= 10 * 60 * 1000
    ) {
      group.push(candidate);
      processed.add(candidate.id);
    }
  }
  
  if (group.length > 1) {
    groups.push(group);
  }
}

console.log(`مجموعات مكررة: ${groups.length}`);
const totalDupes = groups.reduce((sum, g) => sum + g.length - 1, 0);
console.log(`أوردرات زيادة: ${totalDupes}`);
console.log(`الأوردرات بعد الدمج: ${allOrders.length - totalDupes}\n`);

// ==================== خطوة 2: دمج كل مجموعة ====================

let mergedCount = 0;
let deletedCount = 0;

for (const group of groups) {
  // الأوردر الأول هو الأساسي (يبقى)
  const primary = group[0];
  const duplicates = group.slice(1);
  
  // دمج أسماء المنتجات
  const productParts = [];
  let totalQty = 0;
  let totalAmt = 0;
  
  for (const order of group) {
    const qty = order.quantity || 1;
    const name = order.productName || '';
    productParts.push(qty > 1 ? `${name} ×${qty}` : name);
    totalQty += qty;
    totalAmt += parseFloat(order.totalAmount || '0');
  }
  
  const combinedProductName = productParts.join(' + ');
  
  // تحديث الأوردر الأساسي
  await conn.execute(`
    UPDATE orders SET 
      productName = ?,
      quantity = ?,
      totalAmount = ?
    WHERE id = ?
  `, [combinedProductName, totalQty, totalAmt.toFixed(2), primary.id]);
  
  // حذف الأوردرات الزيادة
  for (const dup of duplicates) {
    await conn.execute('DELETE FROM orders WHERE id = ?', [dup.id]);
    deletedCount++;
  }
  
  mergedCount++;
  
  if (mergedCount <= 5) {
    console.log(`دمج: ${group.map(o => '#' + o.orderNumber).join(', ')} → #${primary.orderNumber}`);
    console.log(`  المنتجات: ${combinedProductName.substring(0, 80)}`);
    console.log(`  الكمية: ${totalQty} | المبلغ: ${totalAmt.toFixed(2)}`);
  }
}

console.log(`\nتم دمج ${mergedCount} مجموعة وحذف ${deletedCount} أوردر زيادة`);

// ==================== خطوة 3: إعادة الترقيم ====================

console.log('\n=== إعادة الترقيم ===');

// جلب كل الأوردرات بعد الحذف مرتبة بالوقت
const [remaining] = await conn.execute(`
  SELECT id FROM orders ORDER BY createdAt ASC, id ASC
`);

console.log(`الأوردرات المتبقية: ${remaining.length}`);

// إزالة unique index مؤقتاً
try {
  await conn.execute('ALTER TABLE orders DROP INDEX orderNumber');
  console.log('تم إزالة unique index');
} catch (e) {
  console.log('unique index غير موجود أو تم إزالته مسبقاً');
}

// إعادة الترقيم
for (let i = 0; i < remaining.length; i++) {
  const newNum = String(i + 1);
  await conn.execute('UPDATE orders SET orderNumber = ? WHERE id = ?', [newNum, remaining[i].id]);
}

// إعادة unique index
try {
  await conn.execute('ALTER TABLE orders ADD UNIQUE INDEX orderNumber (orderNumber)');
  console.log('تم إعادة unique index');
} catch (e) {
  console.log('خطأ في إعادة unique index:', e.message);
}

// التحقق النهائي
const [finalCount] = await conn.execute('SELECT COUNT(*) as cnt FROM orders');
const [minMax] = await conn.execute('SELECT MIN(CAST(orderNumber AS UNSIGNED)) as min, MAX(CAST(orderNumber AS UNSIGNED)) as max FROM orders');

console.log(`\n=== النتيجة النهائية ===`);
console.log(`إجمالي الأوردرات: ${finalCount[0].cnt}`);
console.log(`نطاق الترقيم: ${minMax[0].min} → ${minMax[0].max}`);

await conn.end();
console.log('\n✓ اكتمل التنظيف بنجاح');
