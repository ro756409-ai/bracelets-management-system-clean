/**
 * تدقيق سلامة العلاقات (Orphan / Data Integrity) — **قراءة فقط**.
 *
 * السكربت ده **مابيكتبش ولا حرف**. مفيش insert/update/delete/transaction، وفيه اختبار
 * حارس (`scripts/auditIntegrity.test.ts`) بيقفل ده. تقدر تشغّله على الإنتاج مطمّن.
 *
 *   corepack pnpm tsx scripts/auditIntegrity.ts
 *   corepack pnpm tsx scripts/auditIntegrity.ts --show orphan   (أو wrong_parent)
 *
 * لكل علاقة (طفل → أب) بيصنّف الصفوف:
 *   • MATCH        — الأب موجود، ولو الاتنين ليهم businessId فهما متطابقين.
 *   • ORPHAN       — المرجع مش null لكن الأب مش موجود (سجل يتيم).
 *   • WRONG_PARENT — الأب موجود لكن businessId بتاعه مختلف عن الطفل (ربط عابر للشركات).
 *   • NULL_REF     — المرجع اختياري وفاضي (مش يتيم، بس غير محدَّد) — للعلم مش خطأ.
 *
 * مفيش أي إصلاح تلقائي. الأرقام + أمثلة بس. لو ظهر ORPHAN/WRONG_PARENT كتير، ده مدخل
 * خطة تنظيف منفصلة قبل أي Foreign Keys (D6).
 *
 * **خارج النطاق هنا:** «حركات المورّد → مورّد» (مفيش جدول suppliers بمفتاح صريح — الدفتر
 * مُشتق)، و«مراجع business_events» (sourceReference نص حر مش مفتاح أجنبي). بيتذكروا في
 * التقرير كـN/A بدل تخمين غلط.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../server/db";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

type Relation = {
  label: string;
  childTable: string;
  childRef: string;
  parentTable: string;
  /** هل المرجع اختياري (nullable)؟ لو لأ، NULL_REF بيبقى مستحيل. */
  nullable: boolean;
  /** يقارن businessId بين الطفل والأب لو الاتنين عندهم العمود. */
  compareBusiness: boolean;
};

const RELATIONS: Relation[] = [
  // order_items مالوش عمود businessId — النطاق بيتورّث من الأوردر — فمفيش مقارنة business
  // على مستوى السطر (WRONG_PARENT مش قابل للفحص هنا، بيتحسب 0).
  { label: "order_items → orders", childTable: "order_items", childRef: "orderId", parentTable: "orders", nullable: false, compareBusiness: false },
  { label: "order_items → products", childTable: "order_items", childRef: "productId", parentTable: "products", nullable: true, compareBusiness: false },
  { label: "order_items → product_variants", childTable: "order_items", childRef: "variantId", parentTable: "product_variants", nullable: true, compareBusiness: false },
  { label: "product_variants → products", childTable: "product_variants", childRef: "productId", parentTable: "products", nullable: false, compareBusiness: false },
  { label: "inventory_movements → products", childTable: "inventory_movements", childRef: "productId", parentTable: "products", nullable: false, compareBusiness: true },
  { label: "inventory_movements → product_variants", childTable: "inventory_movements", childRef: "variantId", parentTable: "product_variants", nullable: true, compareBusiness: false },
  { label: "payroll_items → payroll_periods", childTable: "payroll_items", childRef: "periodId", parentTable: "payroll_periods", nullable: false, compareBusiness: true },
  { label: "payroll_items → employees", childTable: "payroll_items", childRef: "employeeId", parentTable: "employees", nullable: false, compareBusiness: false },
];

type Verdict = {
  label: string;
  total: number;
  matched: number;
  orphan: number;
  wrongParent: number;
  nullRef: number;
};

async function checkRelation(db: any, r: Relation): Promise<Verdict> {
  // الأعمدة بأسماء الجداول الحقيقية — أسماء ثابتة من القايمة فوق مش من مدخلات، فمفيش حقن.
  const c = "c";
  const p = "p";
  const bizCompare = r.compareBusiness
    ? sql.raw(`SUM(${p}.id IS NOT NULL AND ${c}.businessId <> ${p}.businessId)`)
    : sql.raw(`0`);
  const query = sql`
    SELECT
      COUNT(*) AS total,
      SUM(${sql.raw(`${c}.${r.childRef}`)} IS NULL) AS nullRef,
      SUM(${sql.raw(`${c}.${r.childRef}`)} IS NOT NULL AND ${sql.raw(`${p}.id`)} IS NULL) AS orphan,
      ${bizCompare} AS wrongParent
    FROM ${sql.raw(r.childTable)} ${sql.raw(c)}
    LEFT JOIN ${sql.raw(r.parentTable)} ${sql.raw(p)}
      ON ${sql.raw(`${c}.${r.childRef}`)} = ${sql.raw(`${p}.id`)}
  `;
  const [rows]: any = await db.execute(query);
  const row = rows?.[0] ?? {};
  const num = (v: any) => Number(v ?? 0);
  const total = num(row.total);
  const nullRef = num(row.nullRef);
  const orphan = num(row.orphan);
  const wrongParent = num(row.wrongParent);
  const matched = total - nullRef - orphan - wrongParent;
  return { label: r.label, total, matched, orphan, wrongParent, nullRef };
}

async function examples(db: any, r: Relation, kind: "orphan" | "wrong_parent"): Promise<any[]> {
  const c = "c";
  const p = "p";
  const cond =
    kind === "orphan"
      ? sql.raw(`${c}.${r.childRef} IS NOT NULL AND ${p}.id IS NULL`)
      : sql.raw(`${p}.id IS NOT NULL AND ${c}.businessId <> ${p}.businessId`);
  const query = sql`
    SELECT ${sql.raw(`${c}.id`)} AS childId, ${sql.raw(`${c}.${r.childRef}`)} AS ref
    FROM ${sql.raw(r.childTable)} ${sql.raw(c)}
    LEFT JOIN ${sql.raw(r.parentTable)} ${sql.raw(p)}
      ON ${sql.raw(`${c}.${r.childRef}`)} = ${sql.raw(`${p}.id`)}
    WHERE ${cond}
    LIMIT 10
  `;
  const [rows]: any = await db.execute(query);
  return rows ?? [];
}

async function main() {
  const db = await getDb();
  if (!db) {
    console.error("❌ مفيش اتصال بقاعدة البيانات. ظبّط DATABASE_URL وجرّب تاني.");
    process.exit(1);
  }
  const show = (arg("show") ?? "").toLowerCase();

  console.log("\n════════════════════════════════════════════════════════");
  console.log("  تدقيق سلامة العلاقات — قراءة فقط، مفيش أي كتابة");
  console.log("════════════════════════════════════════════════════════\n");

  let anyIssue = false;
  for (const r of RELATIONS) {
    const v = await checkRelation(db, r);
    const flag = v.orphan > 0 || v.wrongParent > 0 ? "❌" : "✅";
    if (v.orphan > 0 || v.wrongParent > 0) anyIssue = true;
    console.log(`${flag} ${v.label}`);
    console.log(
      `     total ${v.total} · MATCH ${v.matched} · ORPHAN ${v.orphan} · WRONG_PARENT ${v.wrongParent} · NULL_REF ${v.nullRef}`
    );
    if (
      (show === "orphan" && v.orphan > 0) ||
      (show === "wrong_parent" && v.wrongParent > 0)
    ) {
      const ex = await examples(db, r, show as "orphan" | "wrong_parent");
      for (const e of ex)
        console.log(`       ${show}: child #${e.childId} → ref ${e.ref}`);
    }
  }

  console.log("\n──────────────────────────────────────────────────────");
  console.log("  خارج النطاق (N/A):");
  console.log("   • حركات المورّد → مورّد: مفيش جدول suppliers بمفتاح صريح.");
  console.log("   • مراجع business_events: sourceReference نص حر مش مفتاح أجنبي.");
  console.log("──────────────────────────────────────────────────────");
  console.log("  مفيش أي رقم اتغيّر. ده تشخيص بس — مدخل خطة تنظيف/FKs (D6).");
  console.log("════════════════════════════════════════════════════════\n");

  process.exit(anyIssue ? 2 : 0);
}

if (process.argv[1]?.includes("auditIntegrity")) {
  main().catch(error => {
    console.error("فشل التدقيق:", error?.message ?? error);
    process.exit(1);
  });
}
