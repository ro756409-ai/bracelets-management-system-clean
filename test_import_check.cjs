const XLSX = require('xlsx');
const { readFileSync } = require('fs');

const buffer = readFileSync('/home/ubuntu/upload/1777568414612888938-orders-2026-04-30.xlsx');
const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
const sheet = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
const headers = rows[0].map(h => String(h).trim().toLowerCase());

console.log('Total rows:', rows.length);
console.log('Headers:', headers.join(', '));

let parsed = 0, skipped = 0;
const errors = [];

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  if (!row || row.every(c => !c)) continue;
  const get = (idx) => (idx >= 0 ? String(row[idx] || '').trim() : '');
  const customerName = get(2);
  const customerPhone = get(3);
  
  if (!customerName) { errors.push('Row ' + (i+1) + ': no name'); skipped++; continue; }
  if (!customerPhone) { errors.push('Row ' + (i+1) + ': no phone'); skipped++; continue; }
  
  parsed++;
}
console.log('Parsed:', parsed, 'Skipped:', skipped);
console.log('Errors:', errors.slice(0, 5));

// Check products
console.log('\nSample products:');
for (let i = 1; i <= 5; i++) {
  const row = rows[i];
  if (row) console.log('  Row ' + (i+1) + ': product="' + row[11] + '", variant="' + row[12] + '"');
}
