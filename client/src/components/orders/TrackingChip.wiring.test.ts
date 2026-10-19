/** حارس نصّي: جدول الأوردرات بيعرض رقم تتبع بوسطة الحقيقي مع نسخ، ولوحة الحسم مافيهاش زر بيفتح الإرسال مباشرة. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("بوسطة في الواجهة", () => {
  it("OrdersTable يستخدم TrackingChip (رقم التتبع + زر نسخ)", () => {
    expect(read("components/orders/OrdersTable.tsx")).toContain("<TrackingChip shipmentId={order.bostaShipmentId} trackingNumber={order.bostaTrackingNumber} />");
    const chip = code("components/orders/TrackingChip.tsx");
    expect(chip).toContain("navigator.clipboard.writeText(String(trackingNumber))");
    expect(chip).toContain('aria-label={`نسخ رقم التتبع ${trackingNumber}`}');
    expect(chip).not.toMatch(/businessReference|orderNumber/);
  });
  it("لوحة الحسم: ربط / طلب / اعتماد بس — مفيش sendToBosta", () => {
    const panel = read("components/orders/BostaResolutionPanel.tsx");
    for (const m of ["bostaLinkShipment", "bostaRequestReset", "bostaApproveReset"]) expect(panel).toContain(`trpc.orders.${m}.useMutation`);
    expect(panel).not.toContain("sendToBosta");
  });
});
