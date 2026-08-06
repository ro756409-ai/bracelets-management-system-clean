import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  costPerOrder, costPerMessage, conversionRate, roas,
  rankCampaigns, summariseCampaigns, perUnit, type CampaignRow,
} from "@shared/adMetrics";

/**
 * الإعلانات.
 *
 * كل رقم في الشاشة دي قسمة، وكل قسمة معرّضة للصفر: حملة صرفت وجابت صفر أوردر، أو حملة
 * لسه مادخلهاش مقاييس. الاختبارات دي بتقفل إن الصفر بيرجّع **null** مش Infinity ولا NaN
 * ولا صفر — لأن «مالهاش تكلفة أوردر» غير «تكلفة أوردرها صفر»، والتانية كذب بيتاخد عليه
 * قرار.
 *
 * وبتقفل إن الصرف بيمر من `adSpendCreate` الموجود — مصروف واحد بقيد فريد على expenseId،
 * فمفيش مسار مصروفات تاني ومفيش صرف بيتسجّل مرتين.
 */

const routers = fs.readFileSync("server/routers.ts", "utf-8");
const db = fs.readFileSync("server/db.ts", "utf-8");
const page = fs.readFileSync("client/src/pages/Advertising.tsx", "utf-8");
const schema = fs.readFileSync("drizzle/schema.ts", "utf-8");

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");

const listFn = codeOnly(db).slice(
  codeOnly(db).indexOf("export async function listAdCampaigns"),
  codeOnly(db).indexOf("export async function getTreasuryHistoryWithBalances")
);

// ───────────────── القسمة على صفر ─────────────────

describe("🔑 الصفر بيرجّع «مالهاش» مش صفر", () => {
  it("تكلفة الأوردر من غير أوردرات = null", () => {
    expect(costPerOrder(500, 0)).toBeNull();
    expect(costPerOrder(500, "")).toBeNull();
  });

  it("تكلفة الرسالة من غير رسايل = null", () => {
    expect(costPerMessage(500, 0)).toBeNull();
  });

  it("🔑 مش Infinity ولا NaN", () => {
    for (const v of [costPerOrder(500, 0), costPerMessage(500, 0), perUnit(1, 0)]) {
      expect(Number.isFinite(v as number)).toBe(false);
      expect(v).toBeNull();
    }
  });

  it("والقسمة الصح بتشتغل عادي", () => {
    expect(costPerOrder(500, 20)).toBe(25);
    expect(costPerMessage(600, 40)).toBe(15);
  });
});

describe("نسبة التحويل", () => {
  it("الأوردرات ÷ الرسايل كنسبة", () => {
    expect(conversionRate(10, 40)).toBe(25);
  });

  it("من غير رسايل = null", () => {
    expect(conversionRate(10, 0)).toBeNull();
  });
});

describe("العائد على الإنفاق", () => {
  it("الإيراد ÷ المصروف", () => {
    expect(roas(4000, 1000)).toBe(4);
  });

  it("🔑 من غير إيراد متسجّل = null مش صفر", () => {
    expect(roas(null, 1000)).toBeNull();
    expect(roas(undefined, 1000)).toBeNull();
    expect(roas("", 1000)).toBeNull();
  });

  it("إيراد صفر متسجّل فعلًا = صفر مش null", () => {
    expect(roas(0, 1000)).toBe(0);
  });

  it("من غير مصروف = null", () => {
    expect(roas(4000, 0)).toBeNull();
  });
});

// ───────────────── الترتيب ─────────────────

const sales = (name: string, spend: number, orders: number, revenue: number | null = null): CampaignRow =>
  ({ campaignName: name, kind: "sales", spend, orders, messages: 0, revenue });
const msgs = (name: string, spend: number, messages: number, orders = 0): CampaignRow =>
  ({ campaignName: name, kind: "messages", spend, orders, messages, revenue: null });

describe("أحسن وأسوأ حملة", () => {
  it("🔑 الأرخص أحسن والأغلى أسوأ", () => {
    const r = rankCampaigns([
      sales("أ", 1000, 50),   // 20
      sales("ب", 1000, 20),   // 50
      sales("ج", 900, 45),    // 20 — نفس أ
    ]);
    expect(r.best?.unitCost).toBe(20);
    expect(r.worst?.row.campaignName).toBe("ب");
    expect(r.worst?.unitCost).toBe(50);
  });

  it("🔑 حملة الرسايل بتتقاس بتكلفة الرسالة مش الأوردر", () => {
    const r = rankCampaigns([msgs("رسايل", 600, 60, 3)]);
    // 600 ÷ 60 رسالة = 10، مش 600 ÷ 3 أوردر = 200
    expect(r.best?.unitCost).toBe(10);
  });

  it("🔑 اللي صرفت ومجابتش نتيجة بتتشال من الترتيب وبتتقال لوحدها", () => {
    const r = rankCampaigns([sales("شغالة", 1000, 50), sales("فاضية", 800, 0)]);
    expect(r.best?.row.campaignName).toBe("شغالة");
    expect(r.worst?.row.campaignName).toBe("شغالة");
    expect(r.withoutResults.map(c => c.campaignName)).toEqual(["فاضية"]);
  });

  it("مفيش حملات = مفيش أحسن ولا أسوأ", () => {
    const r = rankCampaigns([]);
    expect(r.best).toBeNull();
    expect(r.worst).toBeNull();
  });

  it("حملة بصفر صرف مش «بلا نتيجة»", () => {
    expect(rankCampaigns([sales("مالهاش صرف", 0, 0)]).withoutResults).toEqual([]);
  });
});

describe("الإجماليات", () => {
  it("🔑 بتجمع الصرف والأوردرات والرسايل", () => {
    const t = summariseCampaigns([sales("أ", 1000, 50), msgs("ب", 600, 60, 5)]);
    expect(t.spend).toBe(1600);
    expect(t.orders).toBe(55);
    expect(t.messages).toBe(60);
  });

  it("متوسط تكلفة الأوردر على الإجمالي مش متوسط المتوسطات", () => {
    const t = summariseCampaigns([sales("أ", 1000, 50), sales("ب", 1000, 10)]);
    // 2000 ÷ 60 = 33.33 — مش (20 + 100) ÷ 2
    expect(t.avgCostPerOrder).toBeCloseTo(33.333, 2);
  });

  it("🔑 العائد null لو مفيش ولا حملة مسجّلة إيراد", () => {
    expect(summariseCampaigns([sales("أ", 1000, 50)]).roas).toBeNull();
    expect(summariseCampaigns([sales("أ", 1000, 50, 4000)]).roas).toBe(4);
  });
});

// ───────────────── مسار الصرف ─────────────────

describe("🔑 الصرف بيمر من المسار الموجود", () => {
  it("الشاشة بتنادي adSpendCreate وبس", () => {
    const mutations = [...page.matchAll(/trpc\.[\w.]+\.(\w+)\.useMutation/g)].map(m => m[1]);
    expect(mutations).toEqual(["adSpendCreate"]);
  });

  it("🔑 ومفيش أي مسار مصروفات تاني في الشاشة", () => {
    for (const forbidden of ["expenseCreate", "treasuryCreate", "expensePay"]) {
      expect(page, forbidden).not.toContain(forbidden);
    }
  });

  it("🔑 القيد الفريد على expenseId هو اللي بيمنع الصرف يتسجّل مرتين", () => {
    expect(schema).toContain('uniqueIndex("ad_spend_expense_unique").on(table.expenseId)');
  });

  it("المقاييس بتروح في manualMetrics — الحقل الحر الموجود", () => {
    expect(page).toContain("manualMetrics: Object.keys(metrics).length ? metrics : undefined");
    expect(schema).toContain('manualMetricsJson: text("manualMetricsJson")');
  });

  it("🔑 مفيش جدول ولا عمود اتضاف للإعلانات", () => {
    expect(schema).not.toContain("ad_campaigns");
    expect(schema).not.toContain("campaignType");
  });
});

describe("القراءة", () => {
  it("🔑 قراءة بحتة", () => {
    expect(listFn).not.toContain(".insert(");
    expect(listFn).not.toContain(".update(");
    expect(listFn).not.toContain(".delete(");
  });

  it("بتقرا المقاييس من الحقل الحر ومابتقعش على بيانات مكسورة", () => {
    expect(listFn).toContain("JSON.parse(r.metricsJson)");
    expect(listFn).toContain("catch");
  });

  it("🔑 النوع مشتق من وجود رسايل — مفيش عمود نوع", () => {
    expect(listFn).toContain('metrics.messages > 0 ? ("messages" as const) : ("sales" as const)');
  });

  it("الحالة بتترجع عشان المعلن يعرف إن الصرف لسه مستحق", () => {
    expect(listFn).toContain("expenseStatus");
    expect(listFn).toContain("paidAmount");
  });
});

describe("الواجهة", () => {
  it("🔑 عربي RTL", () => {
    expect(page).toContain('dir="rtl"');
    expect(page).toContain("الإعلانات");
  });

  it("🔑 الحقول اللي طلبها التاجر", () => {
    for (const label of [
      "الصفحة", "اسم الحملة", "نوع الحملة", "المصروف",
      "عدد الأوردرات", "عدد الرسايل", "أوردرات ناتجة من الرسايل", "الإيراد",
    ]) {
      expect(page, label).toContain(label);
    }
  });

  it("🔑 نوع الحملة: مبيعات أو رسايل، والحقول بتتغيّر معاه", () => {
    expect(page).toContain('<SelectItem value="sales">مبيعات</SelectItem>');
    expect(page).toContain('<SelectItem value="messages">رسايل</SelectItem>');
    expect(page).toContain('kind === "sales" ? (');
  });

  it("كروت اللوحة اللي طلبها", () => {
    for (const label of [
      "صرف النهاردة", "صرف الفترة", "أوردرات", "رسايل",
      "متوسط تكلفة الأوردر", "متوسط تكلفة الرسالة", "العائد على الإنفاق",
    ]) {
      expect(page, label).toContain(label);
    }
    expect(page).toContain("أحسن حملة");
    expect(page).toContain("أغلى حملة");
  });

  it("🔑 الشاشة مابتحسبش بنفسها — بتنادي المعادلة المشتركة", () => {
    expect(page).toContain('from "@shared/adMetrics"');
    expect(page).toContain("summariseCampaigns(asCampaignRows)");
    expect(page).toContain("rankCampaigns(asCampaignRows)");
    expect(codeOnly(page)).not.toMatch(/\/\s*orders\b/);
  });

  it("🔑 وبتقول بصراحة إن الصرف لسه مستحق", () => {
    expect(page).toContain("مصروف مستحق");
    expect(page).toContain("مابتخرجش من الخزنة دلوقتي");
  });

  it("التحقق: الأوردرات الناتجة ماتزيدش عن الرسايل", () => {
    const v = page.slice(page.indexOf("const validate = ()"));
    const body = v.slice(0, v.indexOf("\n  };"));
    expect(body).toContain("الأوردرات الناتجة ماتزيدش عن عدد الرسايل");
    expect(body).toContain("المصروف لازم يكون أكبر من صفر");
  });

  it("موبايل والجدول بيسكرول لوحده", () => {
    expect(page).toContain("grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4");
    expect(page).toContain("overflow-x-auto");
  });
});

describe("العقد", () => {
  it("🔑 المرفق اختياري — الإعلان بيتسجّل كل يوم", () => {
    const i = routers.indexOf("    adSpendCreate: permissionProcedure");
    const input = routers.slice(i, routers.indexOf(".mutation(", i));
    expect(input).toContain("evidenceUrl: z.string().max(500).optional()");
  });

  it("القراءة على accounting.view", () => {
    expect(routers).toContain('adCampaigns: permissionProcedure("accounting.view")');
  });
});
