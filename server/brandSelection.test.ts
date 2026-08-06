import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * اختيار البراند — مصدر واحد، وكل شاشة ليها مخرج.
 *
 * تلات شاشات كتبت نفس المنطق بإيدها: اختار لوحدك لو براند واحد، اعرض قائمة لو أكتر من
 * واحد. وتلاتتهم وقعوا بنفس الطريقة على الإنتاج، لأن **ولا واحد فيهم عالج الصفر**. مع
 * قائمة فاضية مفيش اختيار تلقائي ومفيش قائمة تظهر، فالبراند بيفضل فاضي للأبد: شاشة إذن
 * الاستلام سابت «مكان الاستلام» مقفول ورا رسالة «اختار النشاط الأول»، وتجهيز المرتبات
 * رسمت كارت فاضي بيقول «اختر البراند الأول». الاتنين طلبوا من المستخدم حاجة الشاشة
 * نفسها مادتهوش وسيلة يعملها.
 *
 * والقايمة الفاضية مش احتمال نظري: getBusinessGroupsWithBusinesses بتربط النشاط
 * بالمجموعة بـ`b.groupId === g.id`، فأي نشاط `groupId` بتاعه NULL مالوش مجموعة أصلاً
 * و`currentGroup.businesses` بترجع فاضية والنشاط موجود فعلًا.
 */

const HOOK = "client/src/hooks/useBrandOptions.ts";
const hook = fs.readFileSync(HOOK, "utf-8");

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

/** الشاشات اللي بتشتغل على براند واحد متختار. */
const BRAND_SCOPED = [
  ["إذن استلام بضاعة", "client/src/pages/GoodsReceipt.tsx"],
  ["تحويل مخزون", "client/src/pages/StockTransfer.tsx"],
  ["تجهيز المرتبات", "client/src/pages/SalaryPreparation.tsx"],
] as const;

function clientFiles(dir = "client/src"): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...clientFiles(full));
    else if (/\.(tsx?|ts)$/.test(entry.name) && !entry.name.includes(".test."))
      out.push(full);
  }
  return out;
}

describe("الهوك بيغطي التلات حالات", () => {
  const code = codeOnly(hook);

  it("🔑 واحد → بيتختار لوحده", () => {
    expect(code).toContain("brands.length !== 1");
    expect(code).toContain("String(brands[0].id)");
  });

  it("🔑 صفر → isEmpty، مش «اختار» ", () => {
    expect(code).toContain("isEmpty: !isLoading && brands.length === 0");
  });

  it("🔑 بيرجع للقايمة المسطحة لما المجموعة تبقى فاضية", () => {
    // النشاط اللي groupId بتاعه NULL مش بيبان في أي مجموعة
    expect(code).toContain("fromGroup.length > 0 ? fromGroup : businesses");
  });

  it("🔑 لازم effect مش قيمة ابتدائية — القايمة بتيجي من استعلام", () => {
    expect(code).toContain("useEffect");
    expect(code).not.toMatch(/useState\([^)]*brands/);
  });

  it("🔑 براند اختفى مابيفضلش متختار", () => {
    expect(code).toContain("!brands.some(b => String(b.id) === selected)");
  });
});

describe("🔑 كل شاشة براند بتستخدم المصدر الواحد", () => {
  it("التلاتة على useBrandOptions", () => {
    for (const [name, file] of BRAND_SCOPED) {
      expect(fs.readFileSync(file, "utf-8"), name).toContain("useBrandOptions()");
    }
  });

  it("🔑 مفيش شاشة بتشتق البراند بإيدها تاني", () => {
    const offenders = clientFiles()
      .filter(f => f !== HOOK)
      .filter(f => {
        const code = codeOnly(fs.readFileSync(f, "utf-8"));
        // الشكل اللي وقع: «لو الطول واحد بالظبط خد الأول»
        return /businesses\.length\s*(===|!==)\s*1/.test(code)
            || /brands\.length\s*===\s*1\s*\?/.test(code);
      });
    expect(offenders, `شاشات لسه بتشتق البراند بنفسها: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("🔑 مفيش شاشة بتطلب اختيار من غير ما تدّي وسيلة", () => {
  it("كل شاشة عندها رسالة صريحة لما مفيش أنشطة", () => {
    for (const [name, file] of BRAND_SCOPED) {
      const src = fs.readFileSync(file, "utf-8");
      expect(src, `${name}: مش بيقرا isEmpty`).toContain("isEmpty: noBrands");
      expect(src, `${name}: مفيش رسالة «مفيش أنشطة»`).toContain("مفيش أنشطة متاحة");
    }
  });

  it("🔑 والقائمة بتتعرض لما يكون فيه أكتر من واحد", () => {
    for (const [name, file] of BRAND_SCOPED) {
      expect(fs.readFileSync(file, "utf-8"), name).toContain("brands.length > 1 &&");
    }
  });
});

describe("المستند مايوقفش المسودة", () => {
  const routers = fs.readFileSync("server/routers.ts", "utf-8");
  const service = fs.readFileSync("server/inventoryV2.service.ts", "utf-8");
  const page = fs.readFileSync("client/src/pages/GoodsReceipt.tsx", "utf-8");

  it("🔑 العقد بقى اختياري عند الإنشاء", () => {
    const i = routers.indexOf("    purchaseReceiptCreate: permissionProcedure");
    const input = routers.slice(i, routers.indexOf(".mutation(", i));
    expect(input).toContain("evidenceUrl: z.string().max(500).optional()");
  });

  it("🔑 والحاجز اتنقل للاعتماد — مش اتشال", () => {
    const approve = codeOnly(service).slice(
      codeOnly(service).indexOf("export async function approvePurchaseReceipt"),
      codeOnly(service).indexOf("export async function voidPurchaseReceipt")
    );
    expect(approve).toContain("receipt.evidenceUrl");
    expect(approve).toContain("الاعتماد يتطلب مستند");
  });

  it("🔑 الشاشة مابتمنعش الحفظ عشان المستند", () => {
    const validate = page.slice(page.indexOf("const validate = ()"));
    const body = validate.slice(0, validate.indexOf("\n  };"));
    expect(body).not.toContain("evidenceUrl");
  });

  it("🔑 والشاشة بتقول إنه اختياري دايمًا", () => {
    expect(page).toContain("اختياري دايمًا");
  });

  it("الفاضي بيتبعت undefined مش نص فاضي", () => {
    expect(page).toContain("evidenceUrl: attachmentUrl.trim() || undefined");
  });
});
