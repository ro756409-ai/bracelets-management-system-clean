/**
 * المرحلة 6 — أصول الشعارات: كل ملف في الـManifest موجود فعلًا، المصادر رسمية (قائمة نطاقات مسموحة)،
 * SVG منظّف (لا script/image/روابط خارجية)، أحجام محدودة، ولا أي صورة خارجية وقت التشغيل في المكوّنات المربوطة.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..", "..", "..");
const pub = path.join(root, "public", "brand");
const src = path.join(root, "src");
const manifest = JSON.parse(readFileSync(path.join(pub, "partner-assets.json"), "utf8")) as { basePath: string; partners: Array<{ id: string; name: string; nameAr: string; light?: { file: string; width: number; height: number; format: string }; dark?: { file: string; width: number; height: number; format: string }; source: string; downloadedAt: string; originalFormat: string }> };
const icons = JSON.parse(readFileSync(path.join(pub, "icons-3d.json"), "utf8")) as { icons: Array<{ id: string; status: string; file?: string; fileDark?: string }> };

/** المصادر الرسمية فقط — صفحات الهوية/المواقع الرسمية أو CDN تشير إليه تلك الصفحات */
const OFFICIAL_HOSTS = ["bosta.co", "storage.googleapis.com/bosta-fe", "easy-orders.net", "about.meta.com", "www.instapay.eg", "web.vodafone.com.eg"];
const EXPECTED_IDS = ["bosta", "easyorders", "whatsapp", "meta", "facebook", "instapay", "vodafone_cash"];
const MAX_BYTES = 16 * 1024;

describe("📁 partner-assets.json", () => {
  it("الجهات السبع بالترتيب، ولكل جهة اسم عربي ومصدر وتاريخ وصيغة أصلية", () => {
    expect(manifest.basePath).toBe("/brand/partners/");
    expect(manifest.partners.map(p => p.id)).toEqual(EXPECTED_IDS);
    for (const p of manifest.partners) {
      expect(p.nameAr, p.id).toMatch(/[؀-ۿ]/);
      expect(p.downloadedAt, p.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.originalFormat, p.id).toBeTruthy();
      expect(p.light, p.id).toBeTruthy();
    }
  });
  it("كل ملف موجود فعلًا بأبعاد موجبة وحجم ≤ 16KB؛ PNG صالح؛ SVG بلا script/image/روابط خارجية/معرّفات محرر", () => {
    for (const p of manifest.partners) {
      for (const v of [p.light, p.dark].filter(Boolean) as NonNullable<typeof p.light>[]) {
        const f = path.join(pub, "partners", v.file);
        expect(existsSync(f), `${p.id}: ${v.file}`).toBe(true);
        expect(statSync(f).size, `${p.id}: ${v.file} size`).toBeLessThanOrEqual(MAX_BYTES);
        expect(v.width, `${p.id} width`).toBeGreaterThan(0); expect(v.height, `${p.id} height`).toBeGreaterThan(0);
        if (v.format === "svg") {
          const s = readFileSync(f, "utf8");
          expect(s.startsWith("<svg"), `${v.file} starts with <svg`).toBe(true);
          expect(s).not.toMatch(/<script|<image|<foreignObject|javascript:|on\w+=|<metadata|data-name=|id="/);
          expect(s.replace(/xmlns(:xlink)?="http:\/\/www\.w3\.org\/[^"]+"/g, "")).not.toMatch(/https?:\/\//);
          expect(s).toContain('viewBox="');
        } else {
          const head = readFileSync(f).subarray(0, 8);
          expect(Array.from(head), `${v.file} PNG signature`).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        }
      }
    }
  });
  it("كل مصدر رسمي (نطاق من القائمة المسموحة) — لا Google Images ولا مواقع تجميع", () => {
    for (const p of manifest.partners) expect(OFFICIAL_HOSTS.some(h => p.source.includes(h)), `${p.id}: ${p.source}`).toBe(true);
    for (const p of manifest.partners) expect(p.source).not.toMatch(/google\.com\/images|wikimedia|seeklogo|brandfetch|logowik|freepik|vectorlogo/i);
  });
  it("نسخة Dark فقط حيث وفّرتها الجهة رسميًا (Meta mono white)", () => {
    expect(manifest.partners.filter(p => p.dark).map(p => p.id)).toEqual(["meta"]);
  });
});

describe("🧊 icons-3d.json — Slots الحزمة ثلاثية الأبعاد", () => {
  it("الأقسام الثمانية كلها placeholder (لم تُنتَج بعد) — ولا ملف يُدّعى جاهزًا بلا وجود فعلي", () => {
    expect(icons.icons.map(i => i.id)).toEqual(["orders", "inventory", "accounts", "shipping", "employees", "reports", "integrations", "settings"]);
    for (const i of icons.icons) {
      if (i.status === "ready") { expect(i.file, i.id).toBeTruthy(); expect(existsSync(path.join(pub, "icons-3d", i.file!)), i.id).toBe(true); }
      else expect(i.status, i.id).toBe("placeholder");
    }
    expect(icons.icons.every(i => i.status === "placeholder")).toBe(true);
  });
});

describe("🌐 لا أصول خارجية وقت التشغيل", () => {
  const files = ["components/brand/PartnerLogo.tsx", "components/brand/SectionIcon.tsx", "components/shared/StatusBadge.tsx", "components/shared/WhatsAppButton.tsx", "components/IntegrationsMarketplace.tsx", "components/BostaConnectDialog.tsx", "components/orders/OrdersTable.tsx", "pages/ledger/LedgerDaily.tsx", "pages/OrderDetails.tsx", "pages/SalesChannels.tsx"];
  it("المكوّنات المربوطة لا تحمّل صورًا من http(s) ولا hotlink؛ المسار المحلي /brand/partners/ فقط", () => {
    for (const f of files) {
      const s = readFileSync(path.join(src, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(s, f).not.toMatch(/src=\{?["'`]https?:\/\//);
      expect(s, f).not.toMatch(/<img[^>]*src=["']https?:/);
    }
    const logo = readFileSync(path.join(src, "components/brand/PartnerLogo.tsx"), "utf8");
    expect(logo).toContain('PARTNER_BASE_PATH = "/brand/partners/"');
    expect(logo).toContain('loading: eager ? ("eager" as const) : ("lazy" as const)');
  });
  it("WhatsAppButton لم يعد يحمل مسار SVG مضمّنًا؛ OrdersTable يعرض شعار بوسطة داخل شارة الشحنة فقط", () => {
    expect(readFileSync(path.join(src, "components/shared/WhatsAppButton.tsx"), "utf8")).not.toContain("M17.472 14.382");
    const t = readFileSync(path.join(src, "components/orders/OrdersTable.tsx"), "utf8");
    const i = t.indexOf('<PartnerLogo partner="bosta"'); const guard = t.lastIndexOf("order.bostaShipmentId && (", i);
    expect(i).toBeGreaterThan(0); expect(guard).toBeGreaterThan(0); expect(i - guard).toBeLessThan(400);
  });
});
