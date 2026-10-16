import { describe, it, expect } from "vitest";
import fs from "fs";
import { buildLabelHTML, escapeHtml } from "./exportExcel";

/**
 * SEC-1 — بوليصة الشحن (GET /api/export/print-labels) بتتخدم text/html على نفس الدومين.
 * أي بيانات أوردر (اسم/عنوان/ملاحظات/منتج/مصدر) لازم تظهر كنص، ولا يتنفّذ منها أي HTML أو سكربت.
 */
const EVIL = `<img src=x onerror="alert(1)"><script>alert(2)</script>'"&`;

function evilOrder(shape: "items" | "single" | "multi"): any {
  return {
    id: 7, orderNumber: EVIL, serialNumber: EVIL, customerName: EVIL, customerPhone: EVIL, customerPhone2: EVIL,
    governorate: EVIL, city: EVIL, customerAddress: EVIL, notes: EVIL, color: EVIL, size: EVIL, quantity: EVIL,
    totalAmount: "100", source: "easyorder", adName: EVIL, createdAt: new Date("2026-10-01T10:00:00Z"),
    productName: shape === "multi" ? `${EVIL} - ${EVIL}\n${EVIL} - ${EVIL}` : `${EVIL} - ${EVIL}`,
    items: shape === "items" ? [{ productName: `${EVIL} - ${EVIL}`, quantity: EVIL }] : [],
  };
}

describe("🛡️ SEC-1 — بوليصة الشحن لا تنفّذ HTML من بيانات الأوردر", () => {
  it("escapeHtml يحوّل الرموز الخمسة، وnull/undefined = نص فاضي", () => {
    expect(escapeHtml(`<>"'&`)).toBe("&lt;&gt;&quot;&#39;&amp;");
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  for (const shape of ["items", "single", "multi"] as const) {
    it(`كل حقول العميل والمنتج والمصدر مهرّبة (${shape})`, async () => {
      const html = await buildLabelHTML(evilOrder(shape));
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<img src=x/i);
      expect(html).not.toMatch(/onerror="/i);
      expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    });
  }

  it("صفحة الطباعة: CSP بـnonce، nosniff، ولا onclick inline", () => {
    const src = fs.readFileSync("server/exportExcel.ts", "utf-8");
    expect(src).toContain('"Content-Security-Policy"');
    expect(src).toContain("script-src 'nonce-${nonce}'");
    expect(src).toContain('<script nonce="${nonce}">');
    expect(src).toContain('"X-Content-Type-Options", "nosniff"');
    expect(src).not.toMatch(/onclick=/);
  });
});
