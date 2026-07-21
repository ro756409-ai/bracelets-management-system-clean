/**
 * سكريبت لاستعادة الأوردرات الفاشلة من webhook_logs
 * يقرأ rawPayload لكل سجل فاشل ويحاول إعادة استيراد الأوردرات
 */
import { createPool } from 'mysql2/promise';
import { fileURLToPath } from 'url';

const pool = createPool(process.env.DATABASE_URL);

// نفس منطق normalizeGov من easyorderWebhook.ts
const GOV_MAP = {
  "القاهرة": "القاهرة", "cairo": "القاهرة",
  "الجيزة": "الجيزة", "giza": "الجيزة",
  "الإسكندرية": "الإسكندرية", "الاسكندرية": "الإسكندرية", "alexandria": "الإسكندرية",
  "الشرقية": "الشرقية", "sharqia": "الشرقية",
  "الدقهلية": "الدقهلية", "dakahlia": "الدقهلية",
  "المنوفية": "المنوفية", "monufia": "المنوفية",
  "البحيرة": "البحيرة", "beheira": "البحيرة",
  "الغربية": "الغربية", "gharbia": "الغربية",
  "كفر الشيخ": "كفر الشيخ", "kafr el-sheikh": "كفر الشيخ",
  "الفيوم": "الفيوم", "fayoum": "الفيوم",
  "بني سويف": "بني سويف", "beni suef": "بني سويف",
  "المنيا": "المنيا", "minya": "المنيا",
  "أسيوط": "أسيوط", "asyut": "أسيوط",
  "سوهاج": "سوهاج", "sohag": "سوهاج",
  "قنا": "قنا", "qena": "قنا",
  "الأقصر": "الأقصر", "luxor": "الأقصر",
  "أسوان": "أسوان", "aswan": "أسوان",
  "البحر الأحمر": "البحر الأحمر", "red sea": "البحر الأحمر",
  "شمال سيناء": "شمال سيناء", "north sinai": "شمال سيناء",
  "جنوب سيناء": "جنوب سيناء", "south sinai": "جنوب سيناء",
  "مطروح": "مطروح", "matrouh": "مطروح",
  "الوادي الجديد": "الوادي الجديد", "new valley": "الوادي الجديد",
  "بورسعيد": "بورسعيد", "port said": "بورسعيد",
  "الإسماعيلية": "الإسماعيلية", "ismailia": "الإسماعيلية",
  "السويس": "السويس", "suez": "السويس",
  "دمياط": "دمياط", "damietta": "دمياط",
  "القليوبية": "القليوبية", "qalyubia": "القليوبية",
};

function normalizeGov(raw) {
  if (!raw) return "";
  const lower = raw.trim().toLowerCase();
  for (const [key, val] of Object.entries(GOV_MAP)) {
    if (lower.includes(key.toLowerCase())) return val;
  }
  return raw.trim();
}

async function generateOrderNumber(conn) {
  const [rows] = await conn.execute("SELECT MAX(CAST(orderNumber AS UNSIGNED)) as maxN FROM orders WHERE orderNumber REGEXP '^[0-9]+$'");
  const maxN = Number(rows[0].maxN ?? 0);
  return String(maxN + 1);
}

async function main() {
  const conn = await pool.getConnection();
  
  // جلب كل الأوردرات الفاشلة
  const [failedLogs] = await conn.execute(
    "SELECT id, externalOrderId, rawPayload, customerName FROM webhook_logs WHERE status='error' ORDER BY id ASC"
  );
  
  console.log(`Found ${failedLogs.length} failed webhook logs to retry`);
  
  // جلب المنتجات
  const [products] = await conn.execute("SELECT id, name FROM products");
  
  let totalImported = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  
  for (const log of failedLogs) {
    let payload;
    try {
      payload = JSON.parse(log.rawPayload);
    } catch (e) {
      console.log(`[SKIP] Log ${log.id}: invalid JSON payload`);
      totalSkipped++;
      continue;
    }
    
    // التحقق من التكرار — هل الأوردر موجود بالفعل؟
    const [existing] = await conn.execute(
      "SELECT COUNT(*) c FROM orders WHERE customerPhone = ? AND customerName = ? AND source = 'easyorder' AND createdAt > DATE_SUB(NOW(), INTERVAL 30 DAY)",
      [
        (payload.phone || "").replace(/\s+/g, ""),
        payload.full_name
      ]
    );
    
    const cartItems = payload.cart_items || [];
    const phone = (payload.phone || "").replace(/\s+/g, "");
    const governorate = normalizeGov(payload.government || "");
    
    let importedCount = 0;
    
    for (let i = 0; i < cartItems.length; i++) {
      const item = cartItems[i];
      const productName = item.product?.name || "";
      
      // إيجاد المنتج المطابق
      const matchedProduct = products.find(p => 
        p.name.toLowerCase().includes(productName.toLowerCase()) ||
        productName.toLowerCase().includes(p.name.toLowerCase())
      );
      
      // توليد رقم أوردر جديد
      const orderNumber = await generateOrderNumber(conn);
      
      try {
        await conn.execute(
          `INSERT INTO orders (orderNumber, customerName, customerPhone, customerAddress, governorate, productId, productName, quantity, totalAmount, status, source, notes, createdAt, updatedAt) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', 'easyorder', ?, NOW(), NOW())`,
          [
            orderNumber,
            payload.full_name,
            phone,
            payload.address || "",
            governorate,
            matchedProduct?.id ?? 1,
            matchedProduct?.name ?? productName,
            item.quantity || 1,
            String(item.price * (item.quantity || 1)),
            matchedProduct ? null : `منتج غير مطابق: ${productName}`,
          ]
        );
        importedCount++;
        totalImported++;
        console.log(`[OK] ${payload.full_name} | ${productName} | #${orderNumber}`);
      } catch (err) {
        console.log(`[ERR] ${payload.full_name} | ${productName} | ${err.message.slice(0, 80)}`);
        totalErrors++;
      }
    }
    
    // تحديث حالة السجل لـ success إذا تم الاستيراد
    if (importedCount > 0) {
      await conn.execute(
        "UPDATE webhook_logs SET status='success', message=CONCAT('إعادة استيراد ناجحة: ', ?) WHERE id=?",
        [`${importedCount} أوردر`, log.id]
      );
    }
  }
  
  console.log(`\n=== النتيجة ===`);
  console.log(`تم استيراد: ${totalImported} أوردر`);
  console.log(`تم تخطي: ${totalSkipped}`);
  console.log(`أخطاء: ${totalErrors}`);
  
  // إجمالي الأوردرات الآن
  const [total] = await conn.execute("SELECT COUNT(*) c FROM orders");
  console.log(`إجمالي الأوردرات الآن: ${total[0].c}`);
  
  conn.release();
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
