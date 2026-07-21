import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

console.log('Step 1: Drop unique index...');
try { await conn.execute('ALTER TABLE orders DROP INDEX orders_orderNumber_unique'); } catch(e) { console.log('Index not found, skipping'); }

console.log('Step 2: Set all orderNumbers to temp values (id-based)...');
await conn.execute('UPDATE orders SET orderNumber = CONCAT("T", id)');

console.log('Step 3: Get ordered IDs...');
const [rows] = await conn.execute('SELECT id FROM orders ORDER BY createdAt ASC, id ASC');

console.log(`Step 4: Renumbering ${rows.length} orders in batches...`);
// Build single UPDATE with CASE WHEN for speed
const batchSize = 500;
for (let i = 0; i < rows.length; i += batchSize) {
  const batch = rows.slice(i, i + batchSize);
  const cases = batch.map((r, j) => `WHEN ${r.id} THEN '${i + j + 1}'`).join(' ');
  const ids = batch.map(r => r.id).join(',');
  await conn.execute(`UPDATE orders SET orderNumber = CASE id ${cases} END WHERE id IN (${ids})`);
  console.log(`  Processed ${Math.min(i + batchSize, rows.length)}/${rows.length}`);
}

console.log('Step 5: Restore unique index...');
await conn.execute('ALTER TABLE orders ADD UNIQUE INDEX orders_orderNumber_unique (orderNumber)');

const [total] = await conn.execute('SELECT COUNT(*) c, MIN(CAST(orderNumber AS UNSIGNED)) minN, MAX(CAST(orderNumber AS UNSIGNED)) maxN FROM orders');
console.log('\n=== Done ===');
console.log('Total orders:', total[0].c);
console.log('Range:', total[0].minN, '-', total[0].maxN);

await conn.end();
process.exit(0);
