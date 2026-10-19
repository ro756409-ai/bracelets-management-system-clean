import { describe, it, expect, afterEach, beforeEach } from "vitest";
import {
  resolveBostaEndpoint, guardBostaRequest, probeBostaKey, bostaSandboxOrigins, normalizeBostaOrigin,
  BOSTA_LIVE_BASE_URL, BOSTA_MOCK_BASE_URL, BOSTA_LIVE_BLOCKED_MESSAGE, BOSTA_SANDBOX_NOT_ALLOWED_MESSAGE, BOSTA_ENDPOINT_MISSING_MESSAGE,
  __resetBostaEndpointWarningForTests,
} from "./carrierAccounts.service";

/**
 * B1 — Staging/Preview مايتصلوش بـBosta Live أبدًا (بلا شبكة، بلا قاعدة بيانات). العناوين هنا **وهمية للاختبار** (`*.example.test`)
 * — مش عناوين Sandbox رسمية.
 */
const SANDBOX = "https://bosta-sandbox.example.test/api/v2";
const SANDBOX_ORIGIN = new URL(SANDBOX).origin;
const LIVE_VARIANTS = [
  BOSTA_LIVE_BASE_URL, "https://app.bosta.co/api/v0", "https://APP.Bosta.CO/api/v2", "https://app.bosta.co./api/v2", "https://app.bosta.co:443/api/v2",
];
const ENV_KEYS = ["DEPLOY_ENV", "NODE_ENV", "VITEST", "BOSTA_BASE_URL", "BOSTA_SANDBOX_ORIGINS"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]])); __resetBostaEndpointWarningForTests(); });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } });
const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe("🛡️ B1 — resolveBostaEndpoint في staging/preview", () => {
  for (const deploy of ["staging", "preview"]) {
    it(`${deploy}: أي صيغة لعنوان Live مرفوضة — حتى لو اتكتب في قائمة السماح بالغلط`, () => {
      for (const live of LIVE_VARIANTS) {
        expect(resolveBostaEndpoint(env({ DEPLOY_ENV: deploy, BOSTA_BASE_URL: live })), live).toEqual({ ok: false, error: BOSTA_LIVE_BLOCKED_MESSAGE });
        expect(resolveBostaEndpoint(env({ DEPLOY_ENV: deploy, BOSTA_BASE_URL: live, BOSTA_SANDBOX_ORIGINS: `${new URL(live).origin},${SANDBOX_ORIGIN}` })), live)
          .toEqual({ ok: false, error: BOSTA_LIVE_BLOCKED_MESSAGE });
      }
    });
    it(`${deploy}: عنوان مش في القائمة مرفوض — مش فحص اسم دومين (IP، عنوان بديل، http، بيانات دخول)`, () => {
      const allow = { BOSTA_SANDBOX_ORIGINS: SANDBOX_ORIGIN };
      for (const bad of ["https://stg-app.bosta.co/api/v2", "https://13.248.169.48/api/v2", "https://api.bosta.co/v2", "https://bosta-sandbox.example.test.evil.test/api",
        "https://bosta-sandbox.example.test:8443/api/v2", "https://user:pw@bosta-sandbox.example.test/api/v2"])
        expect(resolveBostaEndpoint(env({ DEPLOY_ENV: deploy, BOSTA_BASE_URL: bad, ...allow })), bad).toEqual({ ok: false, error: BOSTA_SANDBOX_NOT_ALLOWED_MESSAGE });
      expect(resolveBostaEndpoint(env({ DEPLOY_ENV: deploy, BOSTA_BASE_URL: "http://bosta-sandbox.example.test/api/v2", ...allow })).ok).toBe(false);
    });
    it(`${deploy}: Sandbox معتمد في القائمة ⇒ مسموح ومعلّم guarded`, () => {
      expect(resolveBostaEndpoint(env({ DEPLOY_ENV: deploy, BOSTA_BASE_URL: SANDBOX, BOSTA_SANDBOX_ORIGINS: ` ${SANDBOX_ORIGIN.toUpperCase()} , https://other.example.test` })))
        .toEqual({ ok: true, baseUrl: SANDBOX, source: "env", guarded: true });
    });
    it(`${deploy}: من غير عنوان ⇒ فشل مغلق زي ما كان (القائمة لوحدها مابتفتحش حاجة)`, () => {
      expect(resolveBostaEndpoint(env({ DEPLOY_ENV: deploy, BOSTA_SANDBOX_ORIGINS: SANDBOX_ORIGIN }))).toEqual({ ok: false, error: BOSTA_ENDPOINT_MISSING_MESSAGE });
    });
  }
  it("القائمة نفسها: بتتجاهل Live وhttp والقيم البايظة", () => {
    expect([...bostaSandboxOrigins(env({ BOSTA_SANDBOX_ORIGINS: `${BOSTA_LIVE_BASE_URL},http://x.example.test,garbage,${SANDBOX}` }))]).toEqual([SANDBOX_ORIGIN]);
    expect(normalizeBostaOrigin("https://u:p@x.example.test")).toBeNull();
  });
});

describe("🛡️ B1 — Production والبيئات المعزولة من غير تغيير", () => {
  it("production: BOSTA_BASE_URL زي ما هو (من غير guarded)، ومن غيره Live الافتراضي", () => {
    expect(resolveBostaEndpoint(env({ DEPLOY_ENV: "production", BOSTA_BASE_URL: BOSTA_LIVE_BASE_URL }))).toEqual({ ok: true, baseUrl: BOSTA_LIVE_BASE_URL, source: "env" });
    expect(resolveBostaEndpoint(env({ DEPLOY_ENV: "production" }))).toEqual({ ok: true, baseUrl: BOSTA_LIVE_BASE_URL, source: "live_default" });
  });
  it("test/development: Mock زي ما هو حتى لو القائمة مضبوطة", () => {
    for (const d of ["test", "development"]) expect(resolveBostaEndpoint(env({ DEPLOY_ENV: d, BOSTA_SANDBOX_ORIGINS: SANDBOX_ORIGIN }))).toEqual({ ok: true, baseUrl: BOSTA_MOCK_BASE_URL, source: "mock" });
  });
  it("guardBostaRequest في production: الـinit بيرجع بالظبط (من غير redirect)", () => {
    const init = { method: "GET" };
    const g = guardBostaRequest(`${BOSTA_LIVE_BASE_URL}/pickup-locations`, init, env({ DEPLOY_ENV: "production" }));
    expect(g).toEqual({ ok: true, init });
  });
});

describe("🛡️ B1 — حاجز النداء الخارجي", () => {
  const stg = env({ DEPLOY_ENV: "staging", BOSTA_BASE_URL: SANDBOX, BOSTA_SANDBOX_ORIGINS: SANDBOX_ORIGIN });
  it("نفس الأصل المعتمد ⇒ redirect: \"error\" (Sandbox بيحوّل لـLive = فشل، مش متابعة)", () => {
    const g = guardBostaRequest(`${SANDBOX}/deliveries`, { method: "POST" }, stg);
    expect(g).toEqual({ ok: true, init: { method: "POST", redirect: "error" } });
  });
  it("رابط على أصل تاني (عنوان مخزّن قديم/Live/مختلف) ⇒ مرفوض قبل الشبكة", () => {
    expect(guardBostaRequest(`${BOSTA_LIVE_BASE_URL}/deliveries`, {}, stg)).toEqual({ ok: false, error: BOSTA_LIVE_BLOCKED_MESSAGE });
    expect(guardBostaRequest("https://other.example.test/deliveries", {}, stg)).toEqual({ ok: false, error: BOSTA_SANDBOX_NOT_ALLOWED_MESSAGE });
  });
  it("probeBostaKey: Live في staging ⇒ صفر نداء؛ Sandbox معتمد ⇒ كل نداء بـredirect: error", async () => {
    const calls: Array<{ url: string; redirect?: string }> = [];
    const f = (async (url: any, init: any) => { calls.push({ url: String(url), redirect: init?.redirect }); return new Response(JSON.stringify({ data: [] }), { status: 200 }); }) as unknown as typeof fetch;
    Object.assign(process.env, { DEPLOY_ENV: "staging", BOSTA_BASE_URL: BOSTA_LIVE_BASE_URL, BOSTA_SANDBOX_ORIGINS: SANDBOX_ORIGIN });
    expect(await probeBostaKey("key-xxxxxxxx", f)).toEqual({ ok: false, error: BOSTA_LIVE_BLOCKED_MESSAGE });
    expect(calls).toHaveLength(0);
    process.env.BOSTA_BASE_URL = SANDBOX;
    expect((await probeBostaKey("key-xxxxxxxx", f)).ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(c => c.url.startsWith(SANDBOX) && c.redirect === "error")).toBe(true);
  });
  it("نداء بيحاول redirect فعلًا ⇒ fetch بيرمي (محاكاة سلوك redirect: error)", async () => {
    const f = (async (_url: any, init: any) => { if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect"); return Response.redirect(BOSTA_LIVE_BASE_URL, 302); }) as unknown as typeof fetch;
    Object.assign(process.env, { DEPLOY_ENV: "staging", BOSTA_BASE_URL: SANDBOX, BOSTA_SANDBOX_ORIGINS: SANDBOX_ORIGIN });
    const r = await probeBostaKey("key-xxxxxxxx", f);
    expect(r.ok).toBe(false);
  });
});
