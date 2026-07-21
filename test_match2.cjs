const XLSX = require('xlsx');
const { readFileSync } = require('fs');
const mysql = require('mysql2/promise');
require('dotenv').config({ quiet: true });

function normalizeArabic(s) {
  return s
    .replace(/[إأآا]/g, "ا")
    .replace(/[ةه]/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\u0622/g, "ا")
    .replace(/\s+/g, " ")
    .trim();
}

const PRODUCT_KEYWORD_MAP = {
  "اية الكرسي": "آية الكرسي",
  "آية الكرسي": "آية الكرسي",
  "ايه الكرسي": "آية الكرسي",
  "ذكر التحصين": "ذكر التحصين",
  "التحصين": "ذكر التحصين",
  "عين حورس": "عين حورس",
  "عين هورس": "عين حورس",
  "فالله خير حافظا": "فالله خير حافظاً",
  "فالله خير حافظاً": "فالله خير حافظاً",
  "فالله": "فالله خير حافظاً",
  "منقوش": "منقوش",
  "ساده": "سادة",
  "سادة": "سادة",
  "قل اعوذ": "قل أعوذ",
  "قل أعوذ": "قل أعوذ",
  "الفلق": "قل أعوذ",
  "انه من سليمان": "إنه من سليمان",
  "سليمان": "إنه من سليمان",
  "كهيعص": "كهيعص",
};

function tryMatch(text, products) {
  if (!text) return null;
  const t = text.trim();
  const tNorm = normalizeArabic(t);

  let m = products.find(p => t === p.name || tNorm === normalizeArabic(p.name));
  if (m) return m;

  m = products.find(p => t.includes(p.name) || p.name.includes(t));
  if (m) return m;

  m = products.find(p => {
    const pn = normalizeArabic(p.name);
    return tNorm.includes(pn) || pn.includes(tNorm);
  });
  if (m) return m;

  const mappedName = PRODUCT_KEYWORD_MAP[t] || PRODUCT_KEYWORD_MAP[tNorm];
  if (mappedName) {
    const mappedNorm = normalizeArabic(mappedName);
    m = products.find(p => normalizeArabic(p.name).includes(mappedNorm));
    if (m) return m;
  }
  for (const [alias, canonical] of Object.entries(PRODUCT_KEYWORD_MAP)) {
    if (tNorm.includes(normalizeArabic(alias))) {
      const canonNorm = normalizeArabic(canonical);
      m = products.find(p => normalizeArabic(p.name).includes(canonNorm));
      if (m) return m;
    }
  }

  for (const p of products) {
    const keywords = normalizeArabic(p.name).split(/\s+/).filter(w => w.length > 2);
    if (keywords.length > 0 && keywords.every(kw => tNorm.includes(kw))) return p;
  }

  return null;
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL);
  const [products] = await conn.query('SELECT id, name FROM products WHERE isActive = 1');
  
  const buffer = readFileSync('/home/ubuntu/upload/1777568414612888938-orders-2026-04-30.xlsx');
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
  
  let matched = 0, unmatched = 0;
  const unmatchedSamples = [];
  
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => !c)) continue;
    
    const productNameRaw = String(row[11] || '').split('\n')[0].trim();
    const variantRaw = String(row[12] || '');
    const variantFirst = variantRaw.split('\n')[0].trim();
    
    // Extract engrave from variant
    const engraveMatch = variantFirst.match(/نوع\s*الحفر\s*[:\-]\s*(.+)/);
    const engraveName = engraveMatch ? engraveMatch[1].trim() : '';
    
    // Try matching
    let result = tryMatch(productNameRaw + (variantFirst ? ' - ' + variantFirst : ''), products);
    if (!result) result = tryMatch(productNameRaw, products);
    if (!result && engraveName) result = tryMatch(engraveName, products);
    if (!result) {
      // Strip prefix
      const stripped = normalizeArabic(productNameRaw)
        .replace(/اسوره?\s*/g, "")
        .replace(/نحاس\s*/g, "")
        .replace(/احمر\s*/g, "")
        .replace(/طبي\s*/g, "")
        .trim();
      if (stripped) result = tryMatch(stripped, products);
    }
    
    if (result) {
      matched++;
    } else {
      unmatched++;
      if (unmatchedSamples.length < 5) {
        unmatchedSamples.push('product="' + productNameRaw + '" engrave="' + engraveName + '"');
      }
    }
  }
  
  console.log('Matched:', matched, '/', (matched + unmatched));
  console.log('Unmatched:', unmatched);
  if (unmatchedSamples.length > 0) {
    console.log('Unmatched samples:');
    unmatchedSamples.forEach(s => console.log(' -', s));
  }
  
  await conn.end();
}

main().catch(console.error);
