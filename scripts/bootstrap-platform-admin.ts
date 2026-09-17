/**
 * Bootstrap أول Platform Admin — **سكربت يدوي فقط، مش endpoint**.
 *
 * قواعد أمان:
 *   • يشتغل فقط لو جدول platform_admins **فاضي** — يرفض إنشاء أدمن ثانٍ. لو الجدول مش موجود
 *     الاستعلام بيفشل → السكربت بيقف (fail-closed).
 *   • username/email من environment variables؛ كلمة السر:
 *       - لو PLATFORM_ADMIN_PASSWORD مضبوط مسبقًا في بيئة Coolify (secret) → تُقرأ منه،
 *         والأمر نفسه **مايحتوي قيمتها** (فمش في shell history/process list).
 *       - وإلا → **prompt تفاعلي مخفي بدون echo** (تُقرأ من TTY).
 *   • كلمة السر 12..72 UTF-8 bytes (bcrypt بيقصّ بعد 72 بايت).
 *   • bcrypt(12). **مايطبعش** الباسورد ولا الـhash إطلاقًا.
 *   • مفيش أي credentials ثابتة في الكود.
 *
 * التشغيل (لاحقًا، مش دلوقتي) — بدون قيمة الباسورد في الأمر:
 *   # (أ) السر مضبوط مسبقًا في بيئة الحاوية (Coolify secret):
 *   PLATFORM_ADMIN_USERNAME=... [PLATFORM_ADMIN_EMAIL=...] \
 *     DATABASE_URL="mysql://.../matjarak_test" node --import tsx scripts/bootstrap-platform-admin.ts
 *   # (ب) بدون secret في البيئة → السكربت هيسأل عن الباسورد بشكل مخفي.
 */
import "dotenv/config";
import bcrypt from "bcryptjs";
import readline from "node:readline";
import { countPlatformAdmins, createPlatformAdmin } from "../server/db";

const PASSWORD_MIN_BYTES = 12;
const PASSWORD_MAX_BYTES = 72;

/** قراءة كلمة السر بشكل مخفي من الـTTY (بدون echo). */
function readHiddenPassword(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("لا يوجد TTY تفاعلي؛ اضبط PLATFORM_ADMIN_PASSWORD في بيئة الحاوية بدلًا من ذلك."));
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // كتم الإخراج: مانطبعش الأحرف المكتوبة.
    const asMutable = rl as unknown as { _writeToOutput?: (s: string) => void };
    const original = asMutable._writeToOutput?.bind(rl);
    asMutable._writeToOutput = (s: string) => {
      if (s.includes(promptText)) original?.(s); // اطبع نص السؤال مرة واحدة فقط
      // غير كده: لا تطبع شيء (كتم الأحرف).
    };
    rl.question(promptText, answer => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main() {
  const username = String(process.env.PLATFORM_ADMIN_USERNAME ?? "").trim().toLowerCase();
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase() || null;
  if (!username) throw new Error("PLATFORM_ADMIN_USERNAME إلزامي.");

  // يرفض التكرار **قبل** طلب الباسورد. لو الجدول غير موجود، الاستعلام بيرمي → وقوف آمن.
  const existing = await countPlatformAdmins();
  if (existing > 0) {
    throw new Error(`يوجد ${existing} أدمن منصة بالفعل — رفض إنشاء أدمن ثانٍ.`);
  }

  const password = process.env.PLATFORM_ADMIN_PASSWORD ?? (await readHiddenPassword("كلمة سر أدمن المنصة: "));
  const bytes = Buffer.byteLength(password, "utf8");
  if (bytes < PASSWORD_MIN_BYTES || bytes > PASSWORD_MAX_BYTES) {
    throw new Error(`كلمة السر لازم تكون بين ${PASSWORD_MIN_BYTES} و${PASSWORD_MAX_BYTES} بايت (UTF-8).`);
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
