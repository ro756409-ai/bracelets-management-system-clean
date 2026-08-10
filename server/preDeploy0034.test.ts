import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * حاجز ما قبل النشر لهجرة 0034.
 *
 * الكود ده هينزل على الإنتاج **قبل** ما الـmigration تشتغل. Drizzle بيفكّ `db.select()`
 * لقائمة أعمدة صريحة، فأي عمود يعرفه `schema.ts` ومش موجود في قاعدة البيانات بيخلّي
 * **كل** استعلام على جدوله يفشل — مش الاستعلام اللي محتاج العمود بس. دي نفس الآلية
 * اللي خلّت الأوردرات تختفي قبل كده.
 *
 * الاختبارات دي بتفشل لو حد ربط الأعمدة الجديدة قبل ما الهجرة تنزل. بعد ما الهجرة
 * تشتغل على الإنتاج فعلًا، الملف ده بيتشال في نفس الـcommit اللي بيربط `schema.ts`.
 */

/** الأعمدة اللي 0034 بتضيفها. الأسماء دي هي عقد الاختبار. */
const NEW_RECEIPT_COLUMNS = [
  "supplierId", "invoiceNumber", "invoiceDate",
  "paidAmount", "headerDiscount", "shippingCost", "notes",
] as const;
const NEW_ITEM_COLUMNS = ["grossUnitCost", "discount", "extraCost"] as const;
const NEW_TABLES = ["suppliers", "supplier_payments"] as const;

const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");
const migration = fs.readFileSync("drizzle/0034_supplier_ledger.sql", "utf-8");

/** كتلة تعريف جدول واحد في schema.ts. */
function tableBlock(exportName: string): string {
  const start = schema.indexOf(`export const ${exportName} = mysqlTable`);
  expect(start, `${exportName} مش موجود في schema.ts`).toBeGreaterThan(-1);
  const next = schema.indexOf("\nexport const ", start + 1);
  return schema.slice(start, next > start ? next : undefined);
}

/** كل ملفات السيرفر والمشترك، من غير الاختبارات. */
function sourceFiles(dirs = ["server", "shared", "client/src"]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|ts)$/.test(entry.name) && !entry.name.includes(".test."))
        out.push(full);
    }
  };
  dirs.forEach(walk);
  return out;
}

describe("الهجرة نفسها بتضيف اللي إحنا بنحرس عليه", () => {
  // لو الأسماء اتغيّرت في الهجرة ومحدش غيّرها هنا، الحراسة بتبقى بتحرس على لا حاجة.
  it("🔑 كل عمود في قائمة الحراسة موجود فعلًا في 0034", () => {
    for (const col of [...NEW_RECEIPT_COLUMNS, ...NEW_ITEM_COLUMNS]) {
      expect(migration, col).toContain(`\`${col}\``);
    }
    for (const table of NEW_TABLES) {
      expect(migration, table).toContain(`CREATE TABLE \`${table}\``);
    }
  });
});

describe("🔑 schema.ts لسه ما يعرفش الأعمدة الجديدة", () => {
  it("purchase_receipts", () => {
    const block = tableBlock("purchaseReceipts");
    for (const col of NEW_RECEIPT_COLUMNS) {
      expect(block, `purchase_receipts.${col} اتربط قبل ما الهجرة تنزل`)
        .not.toContain(`"${col}"`);
    }
  });

  it("purchase_receipt_items", () => {
    const block = tableBlock("purchaseReceiptItems");
    for (const col of NEW_ITEM_COLUMNS) {
      expect(block, `purchase_receipt_items.${col} اتربط قبل ما الهجرة تنزل`)
        .not.toContain(`"${col}"`);
    }
  });

  it("🔑 الجدولين الجداد لسه مش معرّفين", () => {
    expect(schema).not.toContain('mysqlTable("suppliers"');
    expect(schema).not.toContain('mysqlTable("supplier_payments"');
    expect(schema).not.toContain("export const suppliers ");
    expect(schema).not.toContain("export const supplierPayments ");
  });
});

describe("🔑 مفيش كود بيقرا الأعمدة الجديدة", () => {
  const files = sourceFiles();

  it("مفيش إشارة لـpurchaseReceipts.<عمود جديد>", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, "utf-8");
      for (const col of NEW_RECEIPT_COLUMNS) {
        if (src.includes(`purchaseReceipts.${col}`)) offenders.push(`${file} → ${col}`);
      }
      for (const col of NEW_ITEM_COLUMNS) {
        if (src.includes(`purchaseReceiptItems.${col}`)) offenders.push(`${file} → ${col}`);
      }
    }
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });

  it("مفيش إشارة للجدولين الجداد لا بالـORM ولا بـSQL خام", () => {
    const offenders: string[] = [];
    for (const file of files) {
      // **الكود من غير التعليقات.** التعليق اللي بيشرح ليه الجدول ده ممنوع لازم يذكر
      // اسمه، فالفحص على النص الخام كان بيوقّع على الشرح نفسه. نفس السبب اللي خلّى
      // باقي الحُرّاس في المشروع تستخدم `codeOnly` — الفحص المفروض يقيس كود.
      const src = fs
        .readFileSync(file, "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*/g, "");
      if (/\bsupplierPayments\b/.test(src)) offenders.push(`${file} → supplierPayments`);
      if (/\bsupplier_payments\b/.test(src)) offenders.push(`${file} → supplier_payments`);
      // `suppliers` كلمة عامة، فبنفتش على استخدامها كجدول مش كنص
      if (/from\(suppliers\)|insert\(suppliers\)|update\(suppliers\)/.test(src))
        offenders.push(`${file} → suppliers table`);
    }
    expect(offenders, offenders.join(" | ")).toEqual([]);
  });

  it("🔑 والاستعلامات الحالية على الجدولين لسه بتقرا الأعمدة القديمة بس", () => {
    // getInventoryControlData بيعمل db.select().from(purchaseReceipts) — وده اللي
    // هيقع أول واحد لو schema.ts اتربط بدري. بنتأكد إنه لسه موجود عشان الحارس ده
    // يفضل ليه معنى.
    const service = fs.readFileSync("server/inventoryV2.service.ts", "utf-8");
    expect(service).toContain("db.select().from(purchaseReceipts)");
  });
});

describe("الكود الحالي بيشتغل من غير الهجرة", () => {
  it("🔑 مفيش استعلام في الدفتر اليومي بيلمس عمود جديد", () => {
    const db = fs.readFileSync("server/db.ts", "utf-8");
    const fn = db.slice(
      db.indexOf("export async function getDailyLedgerSummary"),
      db.indexOf("// ==================== PAYROLL")
    );
    for (const col of NEW_RECEIPT_COLUMNS) {
      expect(fn, col).not.toContain(`purchaseReceipts.${col}`);
    }
    // بيقرا الأعمدة القديمة دي، وكلها موجودة في الإنتاج دلوقتي
    expect(fn).toContain("purchaseReceipts.totalAmount");
    expect(fn).toContain("purchaseReceipts.paymentStatus");
    expect(fn).toContain("purchaseReceipts.approvedAt");
    expect(fn).toContain("purchaseReceipts.status");
  });

  it("🔑 شاشة إذن الاستلام مابتبعتش أي حقل جديد للسيرفر", () => {
    const page = fs.readFileSync("client/src/pages/GoodsReceipt.tsx", "utf-8");
    const send = page.slice(page.indexOf("createMutation.mutate({"));
    const body = send.slice(0, send.indexOf("});"));
    for (const col of [...NEW_RECEIPT_COLUMNS, ...NEW_ITEM_COLUMNS]) {
      if (col === "notes") continue; // اسم حقل في الواجهة، مابيتبعتش كعمود
      expect(body, col).not.toContain(`${col}:`);
    }
  });

  it("🔑 عقد الـAPI مابيقبلش أي حقل جديد لسه", () => {
    const routers = fs.readFileSync("server/routers.ts", "utf-8");
    const i = routers.indexOf("    purchaseReceiptCreate: permissionProcedure");
    const input = routers.slice(i, routers.indexOf(".mutation(", i));
    for (const col of ["supplierId", "invoiceNumber", "invoiceDate", "paidAmount"]) {
      expect(input, col).not.toContain(col);
    }
  });
});
