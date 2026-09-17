/**
 * Bootstrap أول Platform Admin — **سكربت يدوي فقط، مش endpoint**.
 *
 * قواعد أمان:
 *   • يشتغل فقط لو جدول platform_admins **فاضي** — يرفض إنشاء أدمن ثانٍ (idempotent-safe).
 *   • ياخد البيانات من environment variables (مش من arguments عشان ماتظهرش في shell history):
 *       PLATFORM_ADMIN_USERNAME   (إلزامي)
 *       PLATFORM_ADMIN_PASSWORD   (إلزامي، ≥ 12 حرف)
 *       PLATFORM_ADMIN_EMAIL      (اختياري)
 *   • bcrypt hash (cost 12). **مايطبعش** الباسورد ولا الـhash إطلاقًا.
 *   • مفيش أي credentials ثابتة في الكود.
 *
 * التشغيل (لاحقًا، مش دلوقتي) — مثال بلا قيم:
 *   PLATFORM_ADMIN_USERNAME=... PLATFORM_ADMIN_PASSWORD=... [PLATFORM_ADMIN_EMAIL=...] \
 *   DATABASE_URL="mysql://.../matjarak_test" node --import tsx scripts/bootstrap-platform-admin.ts
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import { countPlatformAdmins, createPlatformAdmin } from "../server/db";

async function main() {
  const username = String(process.env.PLATFORM_ADMIN_USERNAME ?? "").trim().toLowerCase();
  const password = String(process.env.PLATFORM_ADMIN_PASSWORD ?? "");
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase() || null;

  if (!username || !password) {
    throw new Error("PLATFORM_ADMIN_USERNAME و PLATFORM_ADMIN_PASSWORD إلزاميان.");
  }
  if (password.length < 12) {
    throw new Error("PLATFORM_ADMIN_PASSWORD لازم ≥ 12 حرف.");
  }

  const existing = await countPlatformAdmins();
  if (existing > 0) {
    throw new Error(`يوجد ${existing} أدمن منصة بالفعل — رفض إنشاء أدمن ثانٍ من هذا السكربت.`);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const id = await createPlatformAdmin({ username, email, passwordHash });

  // لا نطبع الباسورد ولا الـhash — بس تأكيد بالـusername والـid.
  console.log(JSON.stringify({ created: true, id, username }));
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error("[bootstrap-platform-admin]", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
