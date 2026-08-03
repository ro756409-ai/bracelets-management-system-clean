import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

/**
 * مصدر المحافظات — واحد لكل الشاشات.
 *
 * كل شاشة كانت بتنادي `useOperationalOptions("governorate")` بنفسها. ده بيقرا جدول إعدادات
 * لكل نشاط محدش ملاه، فالقائمة كانت بترجع فاضية والقائمة المنسدلة بتترسم من غير خيارات —
 * في شاشة المالك، وفي شاشة موظف إدخال البيانات، وفي فلاتر المدير وبوسطة. نفس العلة في خمس
 * حتت، وإصلاحها واحدة واحدة هو السبب إن الخامسة دايمًا بتتنسى.
 */

function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
}

/** كل ملفات الواجهة (tsx/ts) ما عدا الاختبارات. */
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

const files = clientFiles();
const HOOK = "client/src/hooks/useGovernorateOptions.ts";

describe("مصدر واحد للمحافظات", () => {
  it("🔑 مفيش شاشة بتقرا جدول الإعدادات مباشرة", () => {
    const offenders = files
      .filter(f => f !== HOOK)
      .filter(f => codeOnly(fs.readFileSync(f, "utf-8")).includes('useOperationalOptions("governorate")'));
    expect(offenders, `شاشات لسه بتقرا المصدر الخام: ${offenders.join(", ")}`).toEqual([]);
  });

  it("الـhook هو الوحيد اللي بينادي المصدر الخام", () => {
    const hook = fs.readFileSync(HOOK, "utf-8");
    expect(hook).toContain('useOperationalOptions("governorate")');
  });

  it("🔑 بيرجع للقايمة الوطنية لما إعدادات النشاط تبقى فاضية", () => {
    const hook = codeOnly(fs.readFileSync(HOOK, "utf-8"));
    expect(hook).toContain("configured.length > 0 ? configured : GOVERNORATE_NAMES");
  });

  it("القايمة المضبوطة بتكسب لما تكون موجودة", () => {
    const hook = codeOnly(fs.readFileSync(HOOK, "utf-8"));
    expect(hook).toContain("(query.values ?? []).filter(Boolean)");
  });
});

describe("الشاشات اللي بتنشئ أو تعدّل أوردر", () => {
  const ORDER_SCREENS = [
    ["شاشة المالك", "client/src/pages/Orders.tsx"],
    ["شاشة التأكيدات", "client/src/pages/EmployeeDashboard.tsx"],
    ["إدخال البيانات", "client/src/pages/FacebookEntry.tsx"],
  ] as const;

  it("🔑 كلهم على المصدر المشترك", () => {
    for (const [name, file] of ORDER_SCREENS) {
      expect(fs.readFileSync(file, "utf-8"), name).toContain("useGovernorateOptions()");
    }
  });

  it("🔑 كلهم بيستخدموا نفس مكوّن المحافظة/المدينة", () => {
    // المالك والتأكيدات عن طريق OrderEditDialog، وإدخال البيانات مباشرة.
    const dialog = fs.readFileSync("client/src/components/orders/OrderEditDialog.tsx", "utf-8");
    expect(dialog).toContain("<GovernorateCitySelect");
    const dataEntry = fs.readFileSync("client/src/pages/FacebookEntry.tsx", "utf-8");
    expect(dataEntry).toContain("<GovernorateCitySelect");
  });

  it("🔑 مفيش نسخة تانية من مكوّن المحافظات", () => {
    const components = files.filter(f =>
      /GovernorateCitySelect/i.test(path.basename(f))
    );
    expect(components).toEqual(["client/src/components/orders/GovernorateCitySelect.tsx"]);
  });

  it("🔑 مفيش قائمة محافظات مكتوبة على المباشر في أي شاشة", () => {
    // القايمة الوطنية مكانها shared/egyptLocations.ts وبس.
    const offenders = files
      .filter(f => !f.includes("egyptLocations"))
      .filter(f => {
        const code = codeOnly(fs.readFileSync(f, "utf-8"));
        return code.includes('"الإسكندرية"') && code.includes('"الدقهلية"');
      });
    expect(offenders, `قوائم مكتوبة يدويًا: ${offenders.join(", ")}`).toEqual([]);
  });
});

describe("المدينة بتتحفظ لموظف إدخال البيانات", () => {
  const page = fs.readFileSync("client/src/pages/FacebookEntry.tsx", "utf-8");
  const routers = fs.readFileSync("server/routers.ts", "utf-8");

  it("🔑 فورم التعديل بيبعت المدينة — مكانش بيبعتها خالص", () => {
    const save = page.slice(page.indexOf("updateOrderMutation.mutate({"));
    expect(save.slice(0, save.indexOf("});"))).toContain("city: editForm.city || undefined");
  });

  it("🔑 السيرفر بيقبل المدينة في التعديل — مكانتش في الـschema", () => {
    const proc = routers.slice(routers.indexOf("    updateOrder: employeePortalProcedure"));
    const input = proc.slice(0, proc.indexOf(".mutation("));
    expect(input).toContain("city: z.string().max(100).optional()");
  });

  it("🔑 السيرفر بيكتب المدينة فعلًا في الأوردر", () => {
    const proc = routers.slice(routers.indexOf("    updateOrder: employeePortalProcedure"));
    expect(proc.slice(0, 4000)).toContain("city: input.city ?? null");
  });

  it("فورم الإنشاء لسه بيبعت المدينة", () => {
    const save = page.slice(page.indexOf("addOrderMutation.mutate({"));
    expect(save.slice(0, save.indexOf("});"))).toContain("city: form.city || undefined");
  });
});

describe("المدينة بتتصفّر لما المحافظة تتغيّر", () => {
  it("🔑 في الشاشات التلاتة", () => {
    const dialog = fs.readFileSync("client/src/components/orders/OrderEditDialog.tsx", "utf-8");
    expect(dialog).toContain("value !== header.governorate");

    const dataEntry = fs.readFileSync("client/src/pages/FacebookEntry.tsx", "utf-8");
    // الإنشاء والتعديل الاتنين
    expect((dataEntry.match(/v !== f\.governorate/g) ?? []).length).toBe(2);
  });

  it("المدن بتتفلتر حسب المحافظة المختارة", () => {
    const select = fs.readFileSync(
      "client/src/components/orders/GovernorateCitySelect.tsx", "utf-8"
    );
    expect(select).toContain("citiesOf(governorate)");
  });
});
