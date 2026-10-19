import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "fs";
import { resolveDeployEnv, isLocalDeployEnv } from "./deployEnv";
import {
  resolveBostaEndpoint, effectiveBostaBaseUrl, probeBostaKey,
  BOSTA_LIVE_BASE_URL, BOSTA_MOCK_BASE_URL, BOSTA_ENDPOINT_MISSING_MESSAGE, __resetBostaEndpointWarningForTests,
} from "./carrierAccounts.service";

/**
 * عنوان بوسطة لكل بيئة — فشل مغلق بلا أي fallback بين البيئات (بلا قاعدة بيانات، بلا شبكة).
 */
// B1 (2026-10-20): في staging/preview العنوان لازم يكون في BOSTA_SANDBOX_ORIGINS — STG هنا عنوان اختبار وهمي، مش Sandbox رسمي.
const STG = "https://stg-app.bosta.co/api/v2";
const LIVE_HOST = "app.bosta.co";

const ENV_KEYS = ["DEPLOY_ENV", "NODE_ENV", "VITEST", "BOSTA_BASE_URL", "BOSTA_SANDBOX_ORIGINS"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]])); __resetBostaEndpointWarningForTests(); });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } });
const setEnv = (o: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(o)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };

describe("🌍 resolveDeployEnv — بلا تخمين", () => {
  it.each([
    [{ DEPLOY_ENV: "production" }, "production"],
    [{ DEPLOY_ENV: "Staging" }, "staging"],
    [{ DEPLOY_ENV: "preview" }, "preview"],
    [{ DEPLOY_ENV: "weird-value" }, "preview"], // غير معروف → الأكثر تحفظًا
    [{ DEPLOY_ENV: undefined, NODE_ENV: "test", VITEST: undefined }, "test"],
    [{ DEPLOY_ENV: undefined, NODE_ENV: "production", VITEST: undefined }, "production"],
    [{ DEPLOY_ENV: undefined, NODE_ENV: "development", VITEST: undefined }, "development"],
    [{ DEPLOY_ENV: undefined, NODE_ENV: undefined, VITEST: undefined }, "development"],
  ])("%o → %s", (env, expected) => {
    expect(resolveDeployEnv(env as any)).toBe(expected);
  });
  it("محلي = development/test فقط", () => {
    expect(isLocalDeployEnv({ DEPLOY_ENV: "development" } as any)).toBe(true);
    expect(isLocalDeployEnv({ DEPLOY_ENV: "test" } as any)).toBe(true);
    for (const d of ["production", "staging", "preview"]) expect(isLocalDeployEnv({ DEPLOY_ENV: d } as any)).toBe(false);
  });
});

describe("🔒 resolveBostaEndpoint — عنوان واحد لكل بيئة", () => {
  it("BOSTA_BASE_URL مضبوط → هو فقط، في أي بيئة (حتى production)", () => {
    for (const d of ["production", "staging", "preview", "development", "test"]) {
      const ep = resolveBostaEndpoint({ DEPLOY_ENV: d, BOSTA_BASE_URL: STG, BOSTA_SANDBOX_ORIGINS: new URL(STG).origin } as any);
      // B1: في staging/preview العنوان المعتمد بيتعلّم guarded (نداءات بلا redirects) — نفس العنوان، ومفيش غيره.
      expect(ep).toEqual({ ok: true, baseUrl: STG, source: "env", ...(d === "staging" || d === "preview" ? { guarded: true } : {}) });
    }
    // شرطة مائلة أخيرة وبادئة "BOSTA_BASE_URL=" الملصوقة بالخطأ تُنظَّفان
    expect(resolveBostaEndpoint({ BOSTA_BASE_URL: `BOSTA_BASE_URL=${STG}/` } as any)).toMatchObject({ ok: true, baseUrl: STG });
  });
  it("BOSTA_BASE_URL غير https → رفض", () => {
    expect(resolveBostaEndpoint({ BOSTA_BASE_URL: "http://stg-app.bosta.co/api/v2" } as any).ok).toBe(false);
  });
  it("production بلا متغير → Live الافتراضي (مع تحذير داخلي مرة واحدة)", () => {
    const warns: string[] = [];
    const orig = console.warn; console.warn = (m: any) => { warns.push(String(m)); };
    try {
      const ep1 = resolveBostaEndpoint({ DEPLOY_ENV: "production" } as any);
      const ep2 = resolveBostaEndpoint({ DEPLOY_ENV: "production" } as any);
      expect(ep1).toEqual({ ok: true, baseUrl: BOSTA_LIVE_BASE_URL, source: "live_default" });
      expect(ep2).toEqual(ep1);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain("BOSTA_BASE_URL");
      expect(warns[0]).not.toMatch(/key|secret|token/i);
    } finally { console.warn = orig; }
  });
  it("staging/preview بلا متغير → فشل مغلق برسالة إعداد، لا Live", () => {
    for (const d of ["staging", "preview", "unknown-env"]) {
      const ep = resolveBostaEndpoint({ DEPLOY_ENV: d } as any);
      expect(ep).toEqual({ ok: false, error: BOSTA_ENDPOINT_MISSING_MESSAGE });
    }
  });
  it("development/test بلا متغير → عنوان Mock لا يُحلّ أبدًا (.invalid)", () => {
    for (const d of ["development", "test"]) {
      const ep = resolveBostaEndpoint({ DEPLOY_ENV: d } as any);
      expect(ep).toEqual({ ok: true, baseUrl: BOSTA_MOCK_BASE_URL, source: "mock" });
    }
    expect(new URL(BOSTA_MOCK_BASE_URL).hostname.endsWith(".invalid")).toBe(true);
  });
});

describe("🔒 effectiveBostaBaseUrl — العنوان المخزّن لا يتجاوز بيئة التشغيل", () => {
  it("production بلا متغير: المخزّن يُحترم فقط لو على أصل Live (يميّز v0/v2)", () => {
    const env = { DEPLOY_ENV: "production" } as any;
    expect(effectiveBostaBaseUrl("https://app.bosta.co/api/v0", env)).toMatchObject({ ok: true, baseUrl: "https://app.bosta.co/api/v0" });
    expect(effectiveBostaBaseUrl(STG, env)).toMatchObject({ ok: true, baseUrl: BOSTA_LIVE_BASE_URL });
    expect(effectiveBostaBaseUrl("garbage", env)).toMatchObject({ ok: true, baseUrl: BOSTA_LIVE_BASE_URL });
  });
  it("Staging بعنوان مضبوط: صف قاعدة بيانات منسوخ من Production (apiBaseUrl = Live) → Staging لا Live", () => {
    const env = { DEPLOY_ENV: "staging", BOSTA_BASE_URL: STG, BOSTA_SANDBOX_ORIGINS: new URL(STG).origin } as any;
    expect(effectiveBostaBaseUrl("https://app.bosta.co/api/v2", env)).toMatchObject({ ok: true, baseUrl: STG });
  });
  it("Staging بلا عنوان: فشل مغلق حتى لو الصف يحمل عنوانًا", () => {
    expect(effectiveBostaBaseUrl("https://app.bosta.co/api/v2", { DEPLOY_ENV: "staging" } as any).ok).toBe(false);
  });
});

describe("🔒 probeBostaKey (اختبار الاتصال) — لا نداء Live من Staging", () => {
  const recorder = (reply: (url: string) => Response | Error) => {
    const calls: string[] = [];
    const f = (async (url: any) => { calls.push(String(url)); const r = reply(String(url)); if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch;
    return { calls, f };
  };
  it("Staging URL يفشل (401) → لا يوجد أي نداء إلى Live، وخطأ واضح لنفس البيئة", async () => {
    setEnv({ DEPLOY_ENV: "staging", BOSTA_BASE_URL: STG, BOSTA_SANDBOX_ORIGINS: new URL(STG).origin });
    const { calls, f } = recorder(() => new Response("{}", { status: 401 }));
    const r = await probeBostaKey("staging-key-xxxxxxxx", f);
    expect(r.ok).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(u => u.startsWith(STG))).toBe(true);
    expect(calls.some(u => new URL(u).hostname === LIVE_HOST)).toBe(false); // (stg-app.bosta.co ≠ app.bosta.co)
  });
  it("Staging URL ينجح → نداء واحد فقط إلى Staging", async () => {
    setEnv({ DEPLOY_ENV: "staging", BOSTA_BASE_URL: STG, BOSTA_SANDBOX_ORIGINS: new URL(STG).origin });
    const { calls, f } = recorder(() => new Response(JSON.stringify({ data: [{ _id: "L1", locationName: "x" }] }), { status: 200 }));
    const r = await probeBostaKey("staging-key-xxxxxxxx", f);
    expect(r.ok).toBe(true); expect(r.baseUrl).toBe(STG);
    expect(calls).toEqual([`${STG}/pickup-locations`]);
  });
  it("timeout على Staging → لا محاولة ثانية على بيئة أخرى", async () => {
    setEnv({ DEPLOY_ENV: "staging", BOSTA_BASE_URL: STG, BOSTA_SANDBOX_ORIGINS: new URL(STG).origin });
    const { calls, f } = recorder(() => Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }));
    const r = await probeBostaKey("staging-key-xxxxxxxx", f);
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1); expect(calls[0].startsWith(STG)).toBe(true);
  });
  it("404 على Staging (مسار خاطئ) → يبقى على نفس العنوان ولا يسقط على Live", async () => {
    setEnv({ DEPLOY_ENV: "staging", BOSTA_BASE_URL: STG, BOSTA_SANDBOX_ORIGINS: new URL(STG).origin });
    const { calls, f } = recorder(() => new Response("{}", { status: 404 }));
    const r = await probeBostaKey("staging-key-xxxxxxxx", f);
    expect(r.ok).toBe(false);
    expect(calls.every(u => u.startsWith(STG))).toBe(true);
  });
  it("Staging بلا BOSTA_BASE_URL → فشل مغلق قبل الشبكة (صفر نداء)", async () => {
    setEnv({ DEPLOY_ENV: "staging", BOSTA_BASE_URL: undefined });
    const { calls, f } = recorder(() => new Response("{}", { status: 200 }));
    const r = await probeBostaKey("staging-key-xxxxxxxx", f);
    expect(r).toEqual({ ok: false, error: BOSTA_ENDPOINT_MISSING_MESSAGE });
    expect(calls).toHaveLength(0);
  });
  it("Production بلا BOSTA_BASE_URL → Live فقط", async () => {
    setEnv({ DEPLOY_ENV: "production", BOSTA_BASE_URL: undefined });
    const orig = console.warn; console.warn = () => {};
    try {
      const { calls, f } = recorder(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
      const r = await probeBostaKey("live-key-xxxxxxxx", f);
      expect(r.ok).toBe(true);
      expect(calls).toEqual([`${BOSTA_LIVE_BASE_URL}/pickup-locations`]);
    } finally { console.warn = orig; }
  });
});

describe("🔒 حراس المصدر — لا عنوان Live مكتوبًا في مسارات النداء", () => {
  const svc = fs.readFileSync("server/bosta.service.ts", "utf-8");
  const acct = fs.readFileSync("server/carrierAccounts.service.ts", "utf-8");
  it("bosta.service لا يحمل app.bosta.co ولا يبني العنوان بنفسه", () => {
    expect(svc).not.toContain("app.bosta.co");
    expect(svc).toContain("resolveBostaEndpoint()");
    expect((svc.match(/conn\.baseUrl/g) ?? []).length).toBeGreaterThanOrEqual(2); // الإنشاء + AWB
  });
  it("carrierAccounts.service: قائمة عناوين الحوض القديمة أُزيلت والعنوان من resolveBostaEndpoint", () => {
    expect(acct).not.toContain("V2_BASE_URL");
    expect(acct).not.toContain("ENV_BASE_URL");
    expect(acct).toContain("const bases = [ep.baseUrl];");
    expect((acct.match(/app\.bosta\.co/g) ?? []).length).toBe(1); // BOSTA_LIVE_BASE_URL فقط
  });
});
