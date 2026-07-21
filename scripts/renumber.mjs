import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// إزالة unique index
try { await conn.execute('ALTER TABLE orders DROP INDEX orderNumber'); console.log('removed index'); } catch(e) { console.log('no index to remove'); }

// جلب الأوردرات مرتبة
const [rows] = await conn.execute('SELECT id FROM orders ORDER BY createdAt ASC, id ASC');
console.log('عدد الأوردرات:', rows.length);

// إعادة الترقيم بـ batch (50 في كل مرة)
const batchSize = 50;
for (let i = 0; i < rows.length; i += batchSize) {
  const batch = rows.slice(i, i + batchSize);
  const caseStmt = batch.map((r, j) => `WHEN ${r.id} THEN '${i + j + 1}'`).join(' ');
  const ids = batch.map(r => r.id).join(',');
  await conn.execute(`UPDATE orders SET orderNumber = CASE id ${caseStmt} END WHERE id IN (${ids})`);
  if ((i + batchSize) % 200 === 0) console.log(`تم: ${Math.min(i + batchSize, rows.length)}/${rows.length}`);
}

// إعادة unique index
try { 
  await conn.execute('ALTER TABLE orders ADD UNIQUE INDEX orderNumber (orderNumber)'); 
  console.log('added unique index');
} catch(e) { console.log('index error:', e.message); }

const [minMax] = await conn.execute('SELECT MIN(CAST(orderNumber AS UNSIGNED)) as mn, MAX(CAST(orderNumber AS UNSIGNED)) as mx FROM orders');
console.log('نطاق الترقيم:', minMax[0].mn, '->', minMax[0].mx);

await conn.end();
console.log('اكتمل الترقيم');
