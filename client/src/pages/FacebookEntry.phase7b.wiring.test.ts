/**
 * المرحلة 7B — حارس نصّي لنموذج الإدخال اليدوي/Facebook: نفس الاستعلامات والـmutations والحوارات
 * (قبل = بعد، بلا إضافة)، نفس المسودة ومفتاحها، نفس الحفظ والتحقق، والعرض فقط أعيد تنظيمه في
 * 7 أقسام مرقّمة قابلة للطي داخل المسار نفسه (لا معالج متعدد الصفحات).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const page = strip(readFileSync(path.join(root, "pages/FacebookEntry.tsx"), "utf8"));

/** كما كان قبل 7B (commit 4518027) — لا إضافة ولا حذف ولا إعادة ترتيب */
const HOOKS_BEFORE = [
  "trpc.facebookEntry.entryConfig.useQuery", "trpc.employeePortal.me.useQuery", "trpc.facebookEntry.catalog.useQuery",
  "trpc.facebookEntry.myOrders.useQuery", "trpc.facebookEntry.addOrder.useMutation", "trpc.facebookEntry.updateOrder.useMutation",
  "trpc.facebookEntry.deleteOrder.useMutation",
];

describe("🔌 Queries/Mutations/Dialogs قبل = بعد", () => {
  it("نفس 7 hooks بالترتيب نفسه + parsePaste.fetch؛ لا hook آخر", () => {
    const used = [...page.matchAll(/trpc\.[a-zA-Z.]+\.use(Query|Mutation)/g)].map(m => m[0]);
    expect(used).toEqual(HOOKS_BEFORE);
    expect((page.match(/utils\.facebookEntry\.parsePaste\.fetch/g) ?? []).length).toBe(1);
    expect(page).toContain("trpc.facebookEntry.entryConfig.useQuery()");
  });
  it("حواران فقط (تعديل + حذف) كما كانا، وmutation الإضافة تُستدعى مرة واحدة", () => {
    expect((page.match(/<Dialog open=/g) ?? []).length).toBe(2);
    expect(page).toContain("تعديل الأوردر #{editingOrder?.orderNumber}");
    expect(page).toContain("حذف الأوردر؟");
    expect((page.match(/addOrderMutation\.mutate\(/g) ?? []).length).toBe(1);
    expect((page.match(/updateOrderMutation\.mutate\(/g) ?? []).length).toBe(1);
    expect((page.match(/deleteOrderMutation\.mutate\(/g) ?? []).length).toBe(1);
  });
});

describe("💾 المسودة ومفتاحها والحفظ كما هما", () => {
  it("مفتاح المسودة لكل حساب/نشاط/قالب — لا مفتاح مشترك؛ sanitizeDraftItems عند الاسترجاع", () => {
    expect(page).toContain("activeDraftKey(draftKey(readEmployeeScope()), activeBusinessId, entryMode)");
    expect(page).toContain("draftKey(readEmployeeScope())");
    expect(page).not.toContain('const DRAFT_KEY = "manualEntryDraft"');
    expect(page).toContain("sanitizeDraftItems(");
    expect(page).toContain("localStorage.setItem(DRAFT_KEY, JSON.stringify({ cust, items, parseV2, parseToken, analyzedText }))");
    expect(page).not.toMatch(/localStorage\.(getItem|setItem)\("(mode|entryMode)/);
    expect(page).not.toContain("URLSearchParams");
  });
  it("الحفظ: نفس التحقق (اسم/هاتف/محافظة/عنوان) ونفس payload ونفس الموانع", () => {
    for (const s of [
      'if (!cust.customerName.trim()) return toast.error("اسم العميل مطلوب");',
      'if (!cust.customerPhone.trim()) return toast.error("رقم الهاتف مطلوب");',
      'if (!cust.governorate.trim()) return toast.error("المحافظة مطلوبة");',
      'if (!cust.customerAddress.trim()) return toast.error("العنوان مطلوب");',
      "if (blockers.length > 0) return toast.error(blockers[0]);",
      "selectedProducts: buildSelectedProducts(items),",
      "totalAmount: total,",
      "shippingCost: Number(cust.shipping) || 0,",
      "variantId: first.variantId,",
      "...pastePayload,",
      "summarizeCart(items", "saveBlockers(items", 'data-testid="save-blockers"',
      "disabled={addOrderMutation.isPending || blockers.length > 0}",
    ]) expect(page, s).toContain(s);
    const sub = page.slice(page.indexOf("function buildSelectedProducts"), page.indexOf("function buildSelectedProducts") + 800);
    expect(sub).toContain("variantId: it.variantId"); expect(sub).toContain("unitPrice: it.unitPrice"); expect(sub).toContain("productName: it.productName,"); expect(sub).not.toContain("optionLabel");
    const add = page.slice(page.indexOf("addOrderMutation.mutate("), page.indexOf("addOrderMutation.mutate(") + 900);
    expect(add).toContain("city: cust.city.trim() || undefined");
    const upd = page.slice(page.indexOf("updateOrderMutation.mutate("), page.indexOf("updateOrderMutation.mutate(") + 900);
    expect(upd).toContain("city: editCust.city.trim() || undefined");
  });
  it("المنتقيان كما هما (Legacy/Variant) والتحليل (parseAndFill) كما هو", () => {
    for (const s of ["<LegacyEngravingPicker catalog={catalog} value={items} onChange={setItems} suggestedUnitPrice={suggestedUnitPrice} />", "<VariantOrderPicker catalog={catalog} value={items} onChange={setItems} />", "function parseAndFill", "(res.lines ?? []).map", "needsPick: !m", "matchReason", "quantity: l.quantity,", "<GovernorateCitySelect", "useGovernorateOptions()", "v !== c.governorate", 'city: ""']) expect(page, s).toContain(s);
    expect(page).not.toContain("Math.min(p.quantity"); expect(page).not.toContain("availableStock)");
  });
  it("لا businessId ثابت، لا نص براند، لا منطق قديم", () => {
    expect(page).not.toMatch(/businessId:\s*\d/);
    expect(page).not.toMatch(/afandy|أفندي|الأساور|أسورة|اساور/);
    for (const s of ["WATERPROOF_PRODUCT_ID", "نوع الحفر", "waterproofVariants", "confidenceTone", "عدد الأساور"]) expect(page, s).not.toContain(s);
  });
});

describe("🧭 سبعة أقسام مرقّمة داخل المسار نفسه + مراجعة لكل سطر", () => {
  it("الأقسام 1..7 بالترتيب، قابلة للطي (details/summary) لا معالج صفحات", () => {
    const ids = [...page.matchAll(/<EntrySection n=\{(\d)\}/g)].map(m => Number(m[1]));
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(page).toContain("data-testid={`entry-section-${n}`}");
    expect(page).toContain("<details"); expect(page).toContain("<summary");
    // الصفحة خارج DashboardLayout → <main> واحد تملكه الصفحة نفسها
    expect((page.match(/<main\b/g) ?? []).length).toBe(1);
    // أهداف اللمس للمكوّنات المشتركة (منتقي التركيبات/المحافظة) محصورة بنطاق هذا النموذج لا بتعديلها
    expect(page).toContain("const TOUCH_SCOPE = ");
    expect((page.match(/\$\{TOUCH_SCOPE\}|className=\{TOUCH_SCOPE\}/g) ?? []).length).toBe(3);
    expect(page).not.toMatch(/step\s*===\s*\d|currentStep|setStep\(/);
  });
  it("ملخّص الأخطاء أعلى النموذج + خطأ بجانب الحقل، مشتق من الحالة (إصلاح حقل يزيل سببه فقط)", () => {
    expect(page).toContain('data-testid="review-summary"');
    expect(page).toContain("const fieldIssues = useMemo(");
    for (const k of ["customerName", "customerPhone", "governorate", "customerAddress"]) expect(page, k).toContain(`fieldIssues.${k}`);
    expect(page).toContain('aria-invalid={!!issues?.customerPhone');
    expect(page).toContain("{customerFields(cust, setCust, fieldIssues)}");
    expect(page).toContain("{addressFields(cust, setCust, fieldIssues)}");
    // الشعار فقط لأن السيرفر يسجّل المصدر facebook فعلًا
    expect(page).toContain('<PartnerLogo partner="facebook"');
    expect(page).toContain("isValidEgyptianMobile(");
  });
  it("مراجعة لكل سطر باسم رقم السطر (سطر N) — لا دمج للحفر في قيمة واحدة", () => {
    expect(page).toContain('data-testid={`line-review-${i}`}');
    expect(page).toContain("سطر {i + 1}");
    expect(page).not.toMatch(/\.join\(["'][,،]\s*["']\)\s*\}\s*<\/span>\s*\)\s*\}\s*$/m);
  });
  it("شريط الحفظ sticky مع زر ≥44px وحفظ مسودة ومسح كما كان", () => {
    expect(page).toContain('data-testid="save-bar"');
    // حارس الضغط المكرر: mutation واحدة لكل ضغطة حتى onSettled
    expect(page).toContain("createInFlightGuard<string>()");
    expect(page).toContain("saveGuard.run(DRAFT_KEY, addOrderMutation.isPending, done => addOrderMutation.mutate({");
    // حالات: Loading (me) / Error (الكتالوج) / Offline — بلا تغيير قواعد الحفظ
    expect(page).toContain("<ErrorState"); expect(page).toContain("<OfflineState"); expect(page).toContain("useOnlineStatus()");
    expect(page).toContain('data-testid="save-order"');
    // ثابت أسفل الهاتف (sticky كان لا يلتصق فعليًا داخل النموذج) + حشو سفلي للنموذج حتى لا يغطي آخر حقل
    expect(page).toContain("fixed inset-x-0 bottom-0 z-20");
    expect(page).toContain("pb-[88px] sm:pb-0");
    // لا <form> حول النموذج: Radix Select داخل form يمسح المحافظة عند الاسترجاع البرمجي (select أصلي مخفي) — الحفظ بزر صريح
    expect(page).not.toMatch(/<form\b/);
    expect(page).toContain("onClick={submit}");
    expect(page).toContain("onClick={saveDraft}"); expect(page).toContain("onClick={clearForm}");
  });
  it("أهداف اللمس: كل Button في الصفحة min-h-11 أو h-11", () => {
    const buttons = page.match(/<Button\b(?:=>|> 0|[^>])*>/gs) ?? []; // `=>` و`> 0` داخل الخصائص ليسا نهاية الوسم
    expect(buttons.length).toBeGreaterThan(6);
    expect(page).toContain('const TOUCH = "min-h-11";');
    for (const b of buttons) expect(b, b.slice(0, 80)).toMatch(/min-h-11|h-11|\{TOUCH\}|\$\{TOUCH\}/);
  });
});
