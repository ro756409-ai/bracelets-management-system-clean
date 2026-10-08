import { describe, it, expect } from "vitest";
import { permissionsForRole } from "../../../../server/permissions";
import { visibleDestinations, visibleToolsLinks } from "@/config/navigation";
import { createMenuItems } from "./CreateMenu";
import { paletteItemsFor } from "@/components/shared/CommandPalette";

/**
 * الشل حسب الدور والصلاحيات الحقيقية (نفس جداول server/permissions): الوجهات، زر «إنشاء»، ولوحة
 * الأوامر — لا بند يظهر لجلسة لا تملك حقه. الإخفاء ليس أمانًا؛ هذا فحص اتساق مع بوابات السيرفر.
 */
const owner = { hasUser: true, isAdmin: true, permissions: [...permissionsForRole("super_admin")] };
const accountant = { hasUser: false, isAdmin: false, permissions: [...permissionsForRole("accountant"), "ledger.view", "ledger.post"] };
const manager = { hasUser: true, isAdmin: true, permissions: [...permissionsForRole("manager")] };
const dataEntry = { hasUser: false, isAdmin: false, permissions: [...permissionsForRole("data_entry")] };
const warehouse = { hasUser: false, isAdmin: false, permissions: [...permissionsForRole("warehouse")] };

const hrefs = (s: typeof owner) => paletteItemsFor(s).map(i => i.href);
const createKeys = (s: typeof owner) => createMenuItems(s).map(i => i.key);
const destKeys = (s: typeof owner) => visibleDestinations(s.isAdmin, s.permissions).map(d => d.key);

describe("🔑 الشل حسب الدور", () => {
  it("المالك: كل الوجهات، كل بنود الإنشاء، ولوحة الأوامر كاملة بما فيها الدفتر والإدارة", () => {
    expect(destKeys(owner)).toEqual(["ledger", "home", "orders", "operations", "inventory", "team", "reports", "settings"]);
    expect(createKeys(owner)).toEqual(["order", "ledger", "goods", "stocktake", "workshop", "employee", "business"]);
    const h = hrefs(owner);
    for (const p of ["/orders", "/ledger", "/ledger/transactions", "/employees", "/permissions", "/businesses", "/merge-logs", "/goods-receipt"]) expect(h).toContain(p);
    // لا مسارات محاسبة قديمة مجمّدة ولا بوابة موظفين
    for (const p of ["/accounting", "/treasury", "/expenses", "/payroll", "/collections", "/facebook-entry"]) expect(h).not.toContain(p);
  });
  it("المحاسب الممنوح ledger.view/post (جلسة موظف بلا user): الدفتر + ما تمنحه صلاحياته الحقيقية فقط (استلام بضاعة/جرد بـinventory_costing.view)، ولا /orders ولا إدارة", () => {
    // permissions.ts: المحاسب يسجّل مسودة استلام بضاعة (inventory_costing.view/manage) — فالبندان حق له فعلًا؛ لا «أوردر جديد» (مفتوح = يتطلب جلسة لوحة) ولا بنود adminOnly
    expect(createKeys(accountant)).toEqual(["ledger", "goods", "stocktake"]);
    const h = hrefs(accountant);
    expect(h).toContain("/ledger"); expect(h).toContain("/ledger/transactions");
    for (const p of ["/orders", "/dashboard", "/employees", "/businesses", "/permissions", "/merge-logs"]) expect(h).not.toContain(p);
    expect(destKeys(accountant)).toContain("ledger");
    expect(destKeys(accountant)).not.toContain("team");
  });
  it("manager بلا منح: لا Ledger في الوجهات ولا الإنشاء ولا اللوحة؛ يبقى تشغيليًا كاملًا", () => {
    expect(destKeys(manager)).not.toContain("ledger");
    expect(createKeys(manager)).not.toContain("ledger");
    expect(createKeys(manager)).toEqual(["order", "goods", "stocktake", "workshop", "employee", "business"]);
    const h = hrefs(manager);
    expect(h).not.toContain("/ledger"); expect(h).not.toContain("/ledger/transactions");
    for (const p of ["/orders", "/employees", "/inventory", "/preparation"]) expect(h).toContain(p);
    // بعد المنح يظهر الدفتر فورًا من نفس القوائم
    const granted = { ...manager, permissions: [...manager.permissions, "ledger.view", "ledger.post"] };
    expect(destKeys(granted)[0]).toBe("ledger");
    expect(createKeys(granted)).toContain("ledger");
    expect(hrefs(granted)).toContain("/ledger");
  });
  it("data_entry: لا وجهات لوحة تحكم ولا إنشاء ولا بنود لوحة أوامر مفتوحة/إدارية", () => {
    expect(createKeys(dataEntry)).toEqual([]);
    const h = hrefs(dataEntry);
    for (const p of ["/orders", "/dashboard", "/employees", "/ledger", "/inventory", "/businesses"]) expect(h).not.toContain(p);
    expect(visibleToolsLinks(dataEntry.isAdmin, dataEntry.permissions).map(l => l.path)).not.toContain("/merge-logs");
  });
  it("المخزن: نطاقه فقط — لا دفتر ولا إدارة ولا طلبات في اللوحة", () => {
    expect(createKeys(warehouse)).toEqual([]);
    const h = hrefs(warehouse);
    for (const p of ["/orders", "/ledger", "/employees", "/businesses", "/permissions"]) expect(h).not.toContain(p);
    expect(destKeys(warehouse)).not.toContain("ledger");
    expect(destKeys(warehouse)).not.toContain("team");
  });
  it("لوحة الأوامر لا تكشف أي مسار adminOnly لغير الأدمن، ولا مسارًا بصلاحية غير ممنوحة", () => {
    for (const s of [accountant, dataEntry, warehouse]) {
      const h = hrefs(s);
      for (const p of ["/employees", "/businesses", "/permissions", "/sales-channels", "/webhook-settings", "/returns", "/duplicates", "/workshop-returns", "/merge-logs"]) expect(h, p).not.toContain(p);
    }
  });
});
