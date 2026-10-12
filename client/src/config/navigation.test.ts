import { describe, it, expect } from "vitest";
import fs from "fs";
import {
  PRIMARY_DESTINATIONS, canSeeNav, visibleDestinations, visibleChildren,
  visibleToolsLinks, activeDestinationKey, ACCOUNTING_LINK,
} from "./navigation";

/**
 * حراس تنقّل Matjarak V2 — المصدر الواحد (config/navigation) + سلوك الأدوار + backward compat.
 *
 * الإخفاء مش أمان — الـroutes متحرسة على مستواها؛ ده بيتأكد إن الشل بيعرض الصح لكل دور،
 * ومفيش توسيع صلاحيات، والروابط القديمة لسه موجودة.
 */

// أدوار تمثيلية (permissions زي ما myPermissions بترجّعها).
const OWNER = { isAdmin: true, perms: ["accounting.view", "inventory_costing.view", "inventory_costing.approve"] };
// المدير: admin صناعي لكن **بدون** الصلاحيات المالية (accounting.view مشالة من myPermissions).
const MANAGER = { isAdmin: true, perms: ["inventory_costing.view", "inventory_costing.approve"] };
// موظف عادي غير إداري بصلاحيات محدودة.
const AGENT = { isAdmin: false, perms: ["dashboard.view", "orders.view"] };

describe("🔑 الوجهات الأساسية = ٨", () => {
  it("🔑 بالظبط ٨ وجهات (مش قائمة طويلة) — «الحسابات» أولًا خلف ledger.view", () => {
    expect(PRIMARY_DESTINATIONS.map(d => d.key)).toEqual([
      "ledger", "home", "orders", "operations", "inventory", "team", "reports", "settings",
    ]);
    expect(PRIMARY_DESTINATIONS[0].permission).toBe("ledger.view");
  });
});

describe("🔑 canSeeNav — permission > adminOnly > مفتوح", () => {
  it("🔑 permission بتتطلب وجودها في myPermissions", () => {
    expect(canSeeNav({ permission: "accounting.view" }, true, [])).toBe(false);
    expect(canSeeNav({ permission: "accounting.view" }, false, ["accounting.view"])).toBe(true);
  });
  it("🔑 adminOnly للأدمن فقط", () => {
    expect(canSeeNav({ adminOnly: true }, true, [])).toBe(true);
    expect(canSeeNav({ adminOnly: true }, false, [])).toBe(false);
  });
  it("🔑 بدون بوابة = مفتوح لأي جلسة مصرّح لها", () => {
    expect(canSeeNav({}, false, [])).toBe(true);
  });
});

describe("🔑 سلوك الأدوار في التنقّل", () => {
  it("🔑 المالك يشوف الوجهات السبع كلها", () => {
    const keys = visibleDestinations(OWNER.isAdmin, OWNER.perms).map(d => d.key);
    expect(keys).toEqual(["home", "orders", "operations", "inventory", "team", "reports", "settings"]);
  });

  it("🔑 النظام المحاسبي مجمّد: رابط الحسابات متخفي حتى عن المالك", () => {
    const tools = visibleToolsLinks(OWNER.isAdmin, OWNER.perms);
    expect(tools.some(l => l.path === "/accounting")).toBe(false);
  });

  it("🔑 المدير يشوف الوجهات لكن **مش** الحسابات (مفيش accounting.view)", () => {
    const keys = visibleDestinations(MANAGER.isAdmin, MANAGER.perms).map(d => d.key);
    expect(keys).toContain("team");       // admin-tier
    expect(keys).toContain("settings");
    const tools = visibleToolsLinks(MANAGER.isAdmin, MANAGER.perms);
    expect(tools.some(l => l.path === "/accounting")).toBe(false); // مفيش وصول مالي جديد
  });

  it("🔑 الموظف العادي: مفيش team/settings (adminOnly) ولا حسابات", () => {
    const keys = visibleDestinations(AGENT.isAdmin, AGENT.perms).map(d => d.key);
    expect(keys).not.toContain("team");
    expect(keys).not.toContain("settings");
    expect(keys).toContain("orders");
    const tools = visibleToolsLinks(AGENT.isAdmin, AGENT.perms);
    expect(tools.some(l => l.path === "/accounting")).toBe(false);
  });

  it("🔑 الموظف العادي مايشوفش بنود المخزون المقيّدة (goods-receipt/stocktake)", () => {
    const inv = PRIMARY_DESTINATIONS.find(d => d.key === "inventory")!;
    const childPaths = visibleChildren(inv, AGENT.isAdmin, AGENT.perms).map(c => c.path);
    expect(childPaths).toContain("/inventory");        // مفتوح
    expect(childPaths).not.toContain("/goods-receipt"); // inventory_costing.view
    expect(childPaths).not.toContain("/stocktake");
  });
});

describe("🔑 مفيش توسيع صلاحيات", () => {
  it("🔑 كل بند مقيّد بيستخدم permission أو adminOnly — مفيش بند مالي مفتوح", () => {
    // الحسابات لازم تفضل خلف accounting.view.
    expect(ACCOUNTING_LINK.permission).toBe("accounting.view");
    // بنود الجرد/الاستلام خلف inventory_costing.view.
    const inv = PRIMARY_DESTINATIONS.find(d => d.key === "inventory")!;
    for (const path of ["/goods-receipt", "/stocktake"]) {
      const child = inv.children!.find(c => c.path === path)!;
      expect(child.permission, path).toBe("inventory_costing.view");
    }
  });
});

describe("🔑 active destination — أطول تطابق", () => {
  it("🔑 المسارات الفرعية بتحلّ لوجهتها", () => {
    expect(activeDestinationKey("/stocktake")).toBe("inventory");
    expect(activeDestinationKey("/goods-receipt")).toBe("inventory");
    expect(activeDestinationKey("/bosta-orders")).toBe("orders");
    expect(activeDestinationKey("/dashboard")).toBe("home");
    expect(activeDestinationKey("/orders/123")).toBe("orders");
  });
});

// ───────────────── source guards ─────────────────

describe("🔑 Business Switcher من المصدر المعتمد", () => {
  const sw = fs.readFileSync("client/src/components/shell/BusinessSwitcher.tsx", "utf-8");
  it("🔑 بيستهلك BusinessContext (مش مصدر جديد ولا hand-derive)", () => {
    expect(sw).toContain("useBusinessContext");
    expect(sw).not.toMatch(/businesses\.length\s*(===|!==)\s*1/);
  });
});

describe("🔑 Sprint 2 — Business-first scope (النشاط وحدة النطاق، مش المجموعة)", () => {
  const ctx = fs.readFileSync("client/src/contexts/BusinessContext.tsx", "utf-8");
  const sw = fs.readFileSync("client/src/components/shell/BusinessSwitcher.tsx", "utf-8");
  it("🔑 currentBusinessIds مشتقّ من currentBusinessId (نشاط محدد → [id]، كل الأنشطة → undefined)", () => {
    expect(ctx).toContain("currentBusinessId != null ? [currentBusinessId] : undefined");
    // مش مشتقّ من المجموعة بعد كده.
    expect(ctx).not.toContain("currentGroup.businesses.map(b => b.id)");
  });
  it("🔑 currentBusinessId بقى state حقيقي بيتخزّن (مش no-op)", () => {
    expect(ctx).toContain("BUSINESS_STORAGE_KEY");
    expect(ctx).toContain("setCurrentBusinessIdState");
  });
  it("🔑 المجموعات تفضل للتوافق (currentGroupId موجود) لكن مش بتقود النطاق", () => {
    expect(ctx).toContain("currentGroupId"); // طبقة تجميع اختيارية باقية
  });
  it("🔑 المبدّل يقود اختيار النشاط (كل الأنشطة أو نشاط واحد) — مفيش اختيار مجموعة يغيّر النطاق", () => {
    expect(sw).toContain("setCurrentBusinessId(undefined)"); // كل الأنشطة
    expect(sw).toContain("setCurrentBusinessId(b.id)");      // نشاط واحد
    expect(sw).not.toContain("setCurrentGroupId");           // المجموعة مابتغيّرش النطاق
  });
});

describe("🔑 backward compatibility — الروابط القديمة لسه موجودة", () => {
  const app = fs.readFileSync("client/src/App.tsx", "utf-8");
  it("🔑 كل الـroutes القديمة المهمة لسه في App.tsx", () => {
    for (const path of [
      "/dashboard", "/orders", "/workspace", "/employees", "/inventory", "/reports",
      "/accountant", "/accounting", "/treasury", "/expenses", "/collections", "/payroll",
      "/closings", "/daily-ledger", "/goods-receipt", "/stocktake", "/stock-transfer",
      "/workshop-returns", "/returns", "/duplicates", "/printed-orders", "/print-logs",
      "/scan-orders", "/scan-logs", "/activity-log", "/merge-logs", "/bosta-orders",
      "/sales-channels", "/webhook-settings", "/businesses", "/preparation",
    ]) {
      // App.tsx بيخلط بين path="/x" وpath={"/x"} — نتأكد إن المسار موجود كـroute بأي شكل.
      expect(app, path).toContain(`"${path}"`);
    }
  });
});

describe("🔑 الشل بيستهلك المصدر الواحد", () => {
  const layout = fs.readFileSync("client/src/components/DashboardLayout.tsx", "utf-8");
  it("🔑 DashboardLayout بيبني التنقّل من config/navigation", () => {
    expect(layout).toContain('from "@/config/navigation"');
    expect(layout).toContain("visibleDestinations");
    // مفيش قائمة تنقّل ثابتة تانية جوّه الشل.
    expect(layout).not.toContain("const MENU_GROUPS");
  });
  it("🔑 فيه mobile bottom nav", () => {
    expect(layout).toContain("MobileBottomNav");
  });
});

describe("🔑 regression Sprint 2 — الوجهة ذات البند الواحد ماتختفيش (الفريق/التقارير)", () => {
  const layout = fs.readFileSync("client/src/components/DashboardLayout.tsx", "utf-8");
  it("🔑 collapsible مشروط بعدد الأبناء — الوجهة ذات البند الواحد تظهر مباشرة", () => {
    // الباج القديم: كل الوجهات collapsible:true، والعنوان بيظهر فقط لو items>1 —
    // فالفريق/التقارير (بند واحد) كانت تختفي (لا عنوان يفتحها ولا محتوى).
    expect(layout).toContain("collapsible: items.length > 1");
    // بلوك بناء الوجهات مايخليش كلها collapsible ثابتة.
    const builder = layout.slice(
      layout.indexOf("navDestinations.map"),
      layout.indexOf('label: "المزيد"')
    );
    expect(builder).not.toContain("collapsible: true");
  });
  it("🔑 الفريق والتقارير وجهات ذات بند واحد فعلًا (فتبان مباشرة)", () => {
    // «الفرق» ابن ثانٍ خلف flag: بلا الميزة (الافتراضي) تبقى الوجهة ببند مرئي واحد؛ ومعها تصير مجموعة قابلة للطي (items>1).
    for (const key of ["team", "reports"]) {
      const dest = PRIMARY_DESTINATIONS.find(d => d.key === key)!;
      expect(visibleChildren(dest, true, ["teams.view_all"]).length, key).toBeLessThanOrEqual(1);
      expect((dest.children ?? []).filter(c => !c.flag).length, key).toBeLessThanOrEqual(1);
    }
  });
});

describe("🚩 بوابة flag — «الفرق» خلف TEAMS_ENABLED + teams.view_all", () => {
  const teamPaths = (isAdmin: boolean, perms: string[], flags: ("teams")[] = []) => {
    const dest = visibleDestinations(isAdmin, perms, flags).find(d => d.key === "team");
    return dest ? visibleChildren(dest, isAdmin, perms, flags).map(c => c.path) : [];
  };
  it("الميزة مقفولة (بلا flags): الرابط مخفي حتى للمالك صاحب الصلاحية", () => {
    expect(teamPaths(true, ["teams.view_all"])).not.toContain("/teams");
    expect(canSeeNav({ flag: "teams" }, true, ["teams.view_all"])).toBe(false);
  });
  it("الميزة مفعّلة + teams.view_all: يظهر؛ بلا الصلاحية: مخفي", () => {
    expect(teamPaths(true, ["teams.view_all"], ["teams"])).toContain("/teams");
    expect(teamPaths(true, [], ["teams"])).not.toContain("/teams");
  });
});

describe("🚩 «فريقي» على الويب (المدير القائد) — teamLeader + teams.view_own", () => {
  const paths = (perms: string[], flags: ("teams" | "teamLeader")[]) => {
    const dest = visibleDestinations(true, perms, flags).find(d => d.key === "team");
    return dest ? visibleChildren(dest, true, perms, flags).map(c => c.path) : [];
  };
  it("يظهر فقط مع قيادة فعّالة (flag teamLeader) والصلاحية", () => {
    expect(paths(["teams.view_own"], ["teams", "teamLeader"])).toContain("/team-leader-dashboard");
    expect(paths(["teams.view_own"], ["teams"])).not.toContain("/team-leader-dashboard"); // قائد سابق/غير قائد
    expect(paths([], ["teams", "teamLeader"])).not.toContain("/team-leader-dashboard"); // صلاحية مسحوبة
  });
});

describe("🎯 بند القائمة النشط", () => {
  it("أطول مسار مطابق فقط: /ledger لا يُضاء مع صفحات الدفتر الفرعية", async () => {
    const { activeLinkPath } = await import("./navigation");
    const paths = ["/ledger", "/ledger/transactions", "/ledger/accounts", "/ledger/periods", "/ledger/opening", "/orders"];
    expect(activeLinkPath("/ledger", paths)).toBe("/ledger");
    expect(activeLinkPath("/ledger/opening", paths)).toBe("/ledger/opening");
    expect(activeLinkPath("/ledger/periods/x", paths)).toBe("/ledger/periods");
    expect(activeLinkPath("/ledgerx", paths)).toBeNull();
    expect(activeLinkPath("/orders/5", paths)).toBe("/orders");
  });
});
