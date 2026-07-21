import mysql from 'mysql2/promise';

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// جلب rawPayload كامل
const [rows] = await conn.execute('SELECT rawPayload, externalOrderId FROM webhook_logs ORDER BY receivedAt DESC LIMIT 1');

if (rows[0]) {
  console.log('externalOrderId (UUID):', rows[0].externalOrderId);
  try {
    const payload = JSON.parse(rows[0].rawPayload);
    console.log('\nTop-level keys:', Object.keys(payload));
    // طباعة الحقول البسيطة
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' || typeof v === 'number') {
        console.log(`  ${k}: ${v}`);
      }
    }
    // البحث عن رقم الطلب (6276, 6277...)
    console.log('\nالبحث عن رقم الطلب:');
    console.log('  payload.id:', payload.id);
    console.log('  payload.reference:', payload.reference);
    console.log('  payload.order_number:', payload.order_number);
    console.log('  payload.number:', payload.number);
    console.log('  payload.display_id:', payload.display_id);
  } catch (e) {
    console.log('JSON parse error:', e.message);
    console.log('First 500 chars:', rows[0].rawPayload?.substring(0, 500));
  }
}

await conn.end();
