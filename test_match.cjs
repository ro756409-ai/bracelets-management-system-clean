const XLSX = require('xlsx');
const { readFileSync } = require('fs');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [products] = await conn.query('SELECT id, name FROM products WHERE isActive = 1');
  console.log('Products in DB:', products.map(p => p.name));
  
  const buffer = readFileSync('/home/ubuntu/upload/1777568414612888938-orders-2026-04-30.xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  
  // Check first 10 rows
  const unmatched = new Set();
  for (let i = 1; i <= Math.min(20, rows.length - 1); i++) {
    const row = rows[i];
    const productName = String(row[11] || '').split('\n')[0].trim();
    const variant = String(row[12] || '').split('\n')[0].trim();
    
    // Extract engrave type from variant
    const engraveMatch = variant.match(/نوع\s*الحفر\s*[:\-]\s*(.+)/);
    const engraveName = engraveMatch ? engraveMatch[1].trim() : '';
    
    // Try to match
    const matched = products.find(p => 
      p.name.includes(engraveName) || 
      engraveName.includes(p.name) ||
      p.name === productName
    );
    
    if (!matched) {
      unmatched.add(`product="${productName}" | variant="${variant}" | engrave="${engraveName}"`);
    }
  }
  
  console.log('\nUnmatched samples:');
  unmatched.forEach(u => console.log(' -', u));
  
  await conn.end();
}

main().catch(console.error);
