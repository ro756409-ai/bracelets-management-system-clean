import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

const conn = await mysql.createConnection(process.env.DATABASE_URL);
const [cols] = await conn.execute("DESCRIBE orders");
const dbCols = cols.map(c => c.Field);
console.log('DB columns count:', dbCols.length);
console.log('DB columns:', dbCols.join(', '));

const schemaCols = ['id','orderNumber','customerName','customerPhone','customerAddress','governorate','productId','productName','quantity','totalAmount','status','source','assignedEmployeeId','assignedAt','confirmedAt','printedAt','postponedTo','cancelReason','notes','lastUpdatedBy','importRowIndex','externalOrderId','easyOrderShortId','adName','pageName','isDuplicate','duplicateMarkedAt','duplicateMarkedBy','createdAt','updatedAt'];
console.log('Schema columns count:', schemaCols.length);

const inSchemaNotDB = schemaCols.filter(c => dbCols.indexOf(c) === -1);
const inDBNotSchema = dbCols.filter(c => schemaCols.indexOf(c) === -1);
console.log('In schema but not DB:', inSchemaNotDB);
console.log('In DB but not schema:', inDBNotSchema);

// Try inserting a test order
try {
  const [result] = await conn.execute(
    "INSERT INTO orders (orderNumber, customerName, customerPhone, customerAddress, governorate, productId, productName, quantity, totalAmount, status, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ['TEST999', 'تست', '01000000000', 'عنوان تست', 'القاهرة', 1, 'أسورة سادة', 1, '270', 'new', 'manual']
  );
  console.log('Insert test succeeded, id:', result.insertId);
  // Delete test
  await conn.execute("DELETE FROM orders WHERE orderNumber = 'TEST999'");
  console.log('Test order deleted');
} catch (e) {
  console.log('Insert test FAILED:', e.message);
}

await conn.end();
