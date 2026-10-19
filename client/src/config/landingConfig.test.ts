import { describe, it, expect } from "vitest";
import { LANDING_VIDEOS, validCover, validYoutubeId, youtubeEmbedUrl } from "./landingVideos";
import { supportFromEnv } from "./support";
import { planMath } from "@/components/public/PricingCards";

describe("🎬 إعداد الفيديوهات", () => {
  it("كل الخانات المطلوبة موجودة بعنوان ووصف عربي/إنجليزي، ومفيش معرّف أو غلاف وهمي", () => {
    expect(LANDING_VIDEOS.map(v => v.slot).sort()).toEqual(["hero", "integrations", "inventory", "orders", "walkthrough"]);
    for (const v of LANDING_VIDEOS) {
      for (const l of ["ar", "en"] as const) { expect(v.title[l].trim()).not.toBe(""); expect(v.description[l].trim()).not.toBe(""); }
      expect(v.youtubeId).toBeNull(); expect(v.cover).toBeNull();
    }
  });
  it("التحقق من معرّف يوتيوب والغلاف؛ التضمين من youtube-nocookie بس", () => {
    expect(validYoutubeId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    for (const bad of ["", "short", "https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ\"><script>", null]) expect(validYoutubeId(bad as any)).toBeNull();
    expect(youtubeEmbedUrl("dQw4w9WgXcQ")).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
    expect(validCover("/landing/orders.webp")).toBe("/landing/orders.webp");
    for (const bad of ["https://cdn.example/x.png", "/landing/../secret.png", "/landing/x.svg"]) expect(validCover(bad)).toBeNull();
  });
});

describe("💬 الدعم", () => {
  it("مش متضبط ⇒ مفيش روابط؛ متضبط صح ⇒ wa.me/mailto؛ قيم غلط مترفوضة", () => {
    expect(supportFromEnv({})).toEqual({ whatsappUrl: null, email: null });
    expect(supportFromEnv({ VITE_SUPPORT_WHATSAPP: "201000000000", VITE_SUPPORT_EMAIL: "help@example.com" })).toEqual({ whatsappUrl: "https://wa.me/201000000000", email: "help@example.com" });
    expect(supportFromEnv({ VITE_SUPPORT_WHATSAPP: "+20 100", VITE_SUPPORT_EMAIL: "not-an-email" })).toEqual({ whatsappUrl: null, email: null });
  });
});

describe("💰 حساب الأسعار", () => {
  it("500/1999/3999 والمتوسط الشهري والتوفير محسوبين من نفس المصدر", () => {
    expect(planMath("month_1")).toMatchObject({ amount: 500, perMonth: 500, savings: 0 });
    expect(planMath("month_5")).toMatchObject({ amount: 1999, perMonth: 399.8, savings: 501 });
    expect(planMath("month_12")).toMatchObject({ amount: 3999, perMonth: 333.25, savings: 2001 });
  });
});
