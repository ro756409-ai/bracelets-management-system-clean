/**
 * Script to sync orders from Excel files into the database
 * Compares by phone number + easyOrderShortId to avoid duplicates
 */
import { createConnection } from 'mysql2/promise';
import { readFileSync } from 'fs';
import XLSX from 'xlsx';

// Read DATABASE_URL from env
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

// Parse DATABASE_URL
const url = new URL(dbUrl);
const connection = await createConnection({
  host: url.hostname,
  port: parseInt(url.port) || 3306,
  user: url.username,
  password: url.password,
  database: url.pathname.slice(1),
  ssl: { rejectUnauthorized: false }
});

console.log('Connected to database');

// Get existing orders
const [existingOrders] = await connection.execute(
  'SELECT id, customerPhone, easyOrderShortId, orderNumber, businessId, source FROM orders'
);
console.log(`Existing orders in DB: ${existingOrders.length}`);

// Build lookup sets
const existingPhones = new Set(existingOrders.map(o => o.customerPhone));
const existingEasyIds = new Set(existingOrders.filter(o => o.easyOrderShortId).map(o => String(o.easyOrderShortId)));

// Get max order number
const [maxResult] = await connection.execute(
  "SELECT MAX(CAST(orderNumber AS UNSIGNED)) as maxNum FROM orders WHERE orderNumber REGEXP '^[0-9]+$'"
);
let nextOrderNum = (maxResult[0].maxNum || 0) + 1;
console.log(`Next order number: ${nextOrderNum}`);

// Get businesses
const [businesses] = await connection.execute('SELECT id, name FROM businesses');
console.log('Businesses:', businesses.map(b => `${b.id}: ${b.name}`).join(', '));

// Find business IDs
let atabaBusinessId = businesses.find(b => b.name.includes('عتبة') || b.name.includes('عتبه'))?.id;
let farhatBusinessId = businesses.find(b => b.name.includes('فرحات'))?.id;

if (!atabaBusinessId || !farhatBusinessId) {
  console.log('Business IDs not found by name, checking sources...');
  // Check what businessIds exist
  const [bizIds] = await connection.execute('SELECT DISTINCT businessId, source FROM orders LIMIT 20');
  console.log('Existing businessId/source combos:', bizIds);
  
  // Try to determine from existing data
  const [atabaOrders] = await connection.execute("SELECT DISTINCT businessId FROM orders WHERE source = 'easyorder_ataba' LIMIT 1");
  const [farhatOrders] = await connection.execute("SELECT DISTINCT businessId FROM orders WHERE source = 'easyorder_farhat' LIMIT 1");
  
  if (atabaOrders.length) atabaBusinessId = atabaOrders[0].businessId;
  if (farhatOrders.length) farhatBusinessId = farhatOrders[0].businessId;
  
  console.log(`Ataba businessId: ${atabaBusinessId}, Farhat businessId: ${farhatBusinessId}`);
}

// Get products for matching
const [products] = await connection.execute('SELECT id, name, sku FROM products');
console.log(`Products: ${products.length}`);

// Governorate normalization
const govNormalize = {
  'القاهرة': 'القاهرة', 'القاهره': 'القاهرة', 'cairo': 'القاهرة',
  'الجيزة': 'الجيزة', 'الجيزه': 'الجيزة', 'giza': 'الجيزة',
  'الإسكندرية': 'الإسكندرية', 'الاسكندرية': 'الإسكندرية', 'اسكندرية': 'الإسكندرية', 'الاسكندريه': 'الإسكندرية', 'alexandria': 'الإسكندرية',
  'الشرقية': 'الشرقية', 'الشرقيه': 'الشرقية',
  'الدقهلية': 'الدقهلية', 'الدقهليه': 'الدقهلية',
  'البحيرة': 'البحيرة', 'البحيره': 'البحيرة',
  'المنوفية': 'المنوفية', 'المنوفيه': 'المنوفية', 'منوفية': 'المنوفية',
  'الغربية': 'الغربية', 'الغربيه': 'الغربية',
  'كفر الشيخ': 'كفر الشيخ',
  'القليوبية': 'القليوبية', 'القليوبيه': 'القليوبية',
  'المنيا': 'المنيا', 'المنيه': 'المنيا', 'مينيا': 'المنيا',
  'أسيوط': 'أسيوط', 'اسيوط': 'أسيوط',
  'سوهاج': 'سوهاج',
  'قنا': 'قنا',
  'الأقصر': 'الأقصر', 'الاقصر': 'الأقصر',
  'أسوان': 'أسوان', 'اسوان': 'أسوان',
  'الفيوم': 'الفيوم',
  'بني سويف': 'بني سويف',
  'بورسعيد': 'بورسعيد',
  'الإسماعيلية': 'الإسماعيلية', 'الاسماعيلية': 'الإسماعيلية', 'الاسماعيليه': 'الإسماعيلية',
  'السويس': 'السويس',
  'دمياط': 'دمياط',
  'شمال سيناء': 'شمال سيناء',
  'جنوب سيناء': 'جنوب سيناء',
  'البحر الأحمر': 'البحر الأحمر',
  'الوادي الجديد': 'الوادي الجديد',
  'مطروح': 'مطروح',
};

function normalizeGov(city) {
  if (!city) return 'القاهرة';
  const trimmed = city.trim();
  // Direct match
  if (govNormalize[trimmed]) return govNormalize[trimmed];
  // Case insensitive search
  const lower = trimmed.toLowerCase();
  for (const [key, val] of Object.entries(govNormalize)) {
    if (key.toLowerCase() === lower) return val;
  }
  // Partial match
  for (const [key, val] of Object.entries(govNormalize)) {
    if (trimmed.includes(key) || key.includes(trimmed)) return val;
  }
  return trimmed;
}

function matchProduct(productName, variant) {
  const fullText = `${productName || ''} ${variant || ''}`.toLowerCase();
  
  // Try to match by variant/engraving type
  if (fullText.includes('آية الكرسي') || fullText.includes('اية الكرسي') || fullText.includes('آيه الكرسي') || fullText.includes('ايه الكرسي')) {
    return products.find(p => p.name.includes('آية الكرسي'));
  }
  if (fullText.includes('ذكر التحصين') || fullText.includes('التحصين')) {
    return products.find(p => p.name.includes('ذكر التحصين'));
  }
  if (fullText.includes('كهيعص')) {
    return products.find(p => p.name.includes('كهيعص'));
  }
  if (fullText.includes('سليمان') || fullText.includes('انه من سليمان')) {
    return products.find(p => p.name.includes('سليمان'));
  }
  if (fullText.includes('سادة') || fullText.includes('ساده') || fullText.includes('سادا')) {
    return products.find(p => p.name.includes('سادة'));
  }
  if (fullText.includes('الفلق') || fullText.includes('فلق')) {
    return products.find(p => p.name.includes('الفلق'));
  }
  if (fullText.includes('الناس')) {
    return products.find(p => p.name.includes('الناس'));
  }
  
  // Default to first product
  return products[0];
}

// Process Excel files
function readExcel(filepath) {
  const workbook = XLSX.readFile(filepath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
}

const atabaData = readExcel('/home/ubuntu/upload/1780515593910536525-orders-2026-06-03.xlsx');
const farhatData = readExcel('/home/ubuntu/upload/1780515867531673170-orders-2026-06-03.xlsx');

console.log(`\nRead ${atabaData.length} rows from عتبة`);
console.log(`Read ${farhatData.length} rows from فرحات`);

// Process and insert missing orders
let inserted = 0;
let skipped = 0;
let errors = [];

async function processOrders(data, businessId, sourceName) {
  for (const row of data) {
    const easyId = String(row['ID'] || '');
    const phone = String(row['Phone'] || '').trim();
    
    if (!phone || !easyId) {
      skipped++;
      continue;
    }
    
    // Check if already exists by easyOrderShortId OR phone+same business
    if (existingEasyIds.has(easyId)) {
      skipped++;
      continue;
    }
    
    // Also check by phone in same business to avoid duplicates
    const existsInBusiness = existingOrders.find(o => 
      o.customerPhone === phone && o.businessId === businessId
    );
    if (existsInBusiness) {
      skipped++;
      continue;
    }
    
    const product = matchProduct(row['Product Name'], row['Variant']);
    if (!product) {
      errors.push(`No product match for: ${row['Product Name']} - ${row['Variant']}`);
      continue;
    }
    
    const gov = normalizeGov(row['City']);
    const quantity = parseInt(row['Quantity']) || 1;
    const totalAmount = parseFloat(row['Total Cost']) || 270;
    const shippingCost = parseFloat(row['Shipping Cost']) || 0;
    const altPhone = String(row['Alt Phone'] || '').trim();
    const note = String(row['Note'] || '').replace(/is_free_shipping:\s*(true|false)\n?/g, '').trim();
    const orderNum = String(nextOrderNum);
    
    // Clean notes
    let cleanNote = note.replace(/\\n/g, '\n').trim();
    if (cleanNote === '' || cleanNote === 'undefined') cleanNote = null;
    
    try {
      await connection.execute(
        `INSERT INTO orders (orderNumber, businessId, customerName, customerPhone, customerPhone2, customerAddress, governorate, productId, productName, quantity, totalAmount, shippingFees, status, source, easyOrderShortId, notes, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, NOW(), NOW())`,
        [
          orderNum,
          businessId,
          row['FullName'] || 'غير معروف',
          phone,
          altPhone || null,
          row['Address'] || '',
          gov,
          product.id,
          product.name,
          quantity,
          totalAmount,
          shippingCost,
          sourceName,
          parseInt(easyId),
          cleanNote || null
        ]
      );
      inserted++;
      nextOrderNum++;
      
      // Add to existing sets to prevent duplicates within same run
      existingEasyIds.add(easyId);
      existingPhones.add(phone);
    } catch (err) {
      errors.push(`Error inserting ${easyId} (${phone}): ${err.message}`);
    }
  }
}

await processOrders(atabaData, atabaBusinessId, 'easyorder_ataba');
await processOrders(farhatData, farhatBusinessId, 'easyorder_farhat');

console.log(`\n=== Results ===`);
console.log(`Inserted: ${inserted}`);
console.log(`Skipped (already exists): ${skipped}`);
console.log(`Errors: ${errors.length}`);
if (errors.length > 0) {
  console.log('\nFirst 10 errors:');
  errors.slice(0, 10).forEach(e => console.log(`  - ${e}`));
}

await connection.end();
console.log('\nDone!');
