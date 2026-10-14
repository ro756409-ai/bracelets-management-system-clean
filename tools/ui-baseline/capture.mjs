#!/usr/bin/env node
/**
 * Matjarak 2.0 — المرحلة 0: لقطات مرجعية للواجهة الحالية + فحص axe في متصفح حقيقي (Chrome headless عبر CDP).
 * يعمل على البيئة المحلية المؤقتة فقط (tools/ui-baseline/live.sh): الرابط يجب أن يكون localhost، والجلسات تُوقَّع
 * بسر الاختبار المحلي نفسه — لا كلمات مرور ولا حسابات حقيقية ولا أي اتصال خارجي.
 *
 * الاستخدام:
 *   node tools/ui-baseline/capture.mjs --out <dir> --owner <id> --accountant <id> --dataentry <id> --order <orderId> [--base http://localhost:3008]
 * الناتج: <dir>/<screen>__<width>__<light|dark>.png و <screen>__1280__ltr.png و report.json (axe + أخطاء الكونسول + التحويلات).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const BASE = args.base ?? "http://localhost:3008";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(BASE)) throw new Error(`refusing: ${BASE} is not a local URL`);
const OUT = path.resolve(args.out ?? "ui-baseline-out");
// سر الجلسة المحلي: من البيئة أو من الملف الذي يكتبه live.sh خارج المستودع — لا قيمة ثابتة في الكود.
const SECRET_FILE = path.join(process.env.TMPDIR ?? "/tmp", "matjarak-ui-baseline.secret");
const SECRET = process.env.JWT_SECRET ?? (fs.existsSync(SECRET_FILE) ? fs.readFileSync(SECRET_FILE, "utf-8").trim() : null);
if (!SECRET) throw new Error("JWT_SECRET missing: run tools/ui-baseline/live.sh first (it writes the local session secret outside the repo)");
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const AXE = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf-8");
const WIDTHS = (args.widths ?? "360,390,768,1280,1440").split(",").map(Number);
const THEMES = ["light", "dark"];
const OWNER = Number(args.owner), ACCOUNTANT = Number(args.accountant), DATAENTRY = Number(args.dataentry), ORDER = Number(args.order);
if (!OWNER || !ACCOUNTANT || !DATAENTRY || !ORDER) throw new Error("--owner, --accountant, --dataentry and --order are required");

/** الشاشات: [اسم الملف، المسار، الدور]. المالك بجلسة الويب؛ المحاسب وإدخال البيانات بجلسة بوابة الموظف (نفس مسار الدخول الفعلي). */
const SCREENS = [
  ["dashboard", "/dashboard", "owner"], ["orders", "/orders", "owner"], ["order-details", `/order/${ORDER}`, "owner"],
  ["facebook-entry", "/facebook-entry", "dataentry"], ["preparation", "/preparation", "owner"], ["scan-orders", "/scan-orders", "owner"],
  ["inventory", "/inventory", "owner"], ["employees", "/employees", "owner"], ["permissions", "/permissions", "owner"],
  ["ledger-daily", "/ledger", "owner"], ["ledger-transactions", "/ledger/transactions", "owner"], ["ledger-report", "/ledger/report", "owner"],
  ["ledger-accounts", "/ledger/accounts", "owner"], ["ledger-periods", "/ledger/periods", "owner"], ["ledger-statements", "/ledger/statements", "owner"],
  ["ledger-carrier", "/ledger/carrier", "owner"], ["ledger-payroll", "/ledger/payroll", "owner"], ["ledger-suppliers", "/ledger/suppliers", "owner"],
  ["accountant-ledger", "/ledger", "accountant"], ["login", "/login", "guest"],
];
const only = args.only ? new Set(args.only.split(",")) : null;

function cookieFor(role) {
  if (role === "owner") return { name: "app_session_id", value: jwt.sign({ employeeId: OWNER }, SECRET) };
  if (role === "accountant") return { name: "employee_token", value: jwt.sign({ employeeId: ACCOUNTANT }, SECRET) };
  if (role === "dataentry") return { name: "employee_token", value: jwt.sign({ employeeId: DATAENTRY }, SECRET) };
  return null;
}

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ui-baseline-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--hide-scrollbars", "--lang=ar", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = ""; const t = setTimeout(() => reject(new Error("chrome did not start")), 20000);
    proc.stderr.on("data", d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
  });
  const port = new URL(wsUrl).port;
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
  return { proc, profile, pageWs: target.webSocketDebuggerUrl };
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const pending = new Map(); const listeners = new Set();
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else for (const l of listeners) l(msg);
  };
  const ready = new Promise(r => (ws.onopen = r));
  return {
    ready, close: () => ws.close(),
    send: (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); }),
    on: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function settle(c) {
  // انتظار هدوء الشبكة (لا طلبات معلّقة 600ms) ثم الخطوط — حد أقصى 15 ثانية
  let inflight = 0, last = Date.now();
  const off = c.on(m => {
    if (m.method === "Network.requestWillBeSent") { inflight++; last = Date.now(); }
    if (m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") { inflight = Math.max(0, inflight - 1); last = Date.now(); }
  });
  const start = Date.now();
  while (Date.now() - start < 15000 && !(inflight === 0 && Date.now() - last > 600)) await sleep(100);
  off();
  await c.send("Runtime.evaluate", { expression: "document.fonts.ready.then(() => true)", awaitPromise: true });
  await sleep(250);
}

async function shot(c, file, width) {
  const { cssContentSize } = await c.send("Page.getLayoutMetrics");
  const height = Math.min(Math.ceil(cssContentSize.height), 4000);
  const { data } = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
  fs.writeFileSync(path.join(OUT, file), Buffer.from(data, "base64"));
}

async function axeRun(c) {
  await c.send("Runtime.evaluate", { expression: AXE });
  const { result } = await c.send("Runtime.evaluate", {
    awaitPromise: true, returnByValue: true,
    expression: `axe.run(document, { resultTypes: ["violations"] }).then(r => r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, count: v.nodes.length, targets: v.nodes.slice(0, 3).map(n => n.target.join(" ")) })))`,
  });
  return result.value;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { proc, profile, pageWs } = await launch();
  const c = cdp(pageWs); await c.ready;
  await Promise.all(["Page.enable", "Network.enable", "Runtime.enable"].map(m => c.send(m)));
  const report = { base: BASE, capturedAt: new Date().toISOString(), screens: {} };
  const consoleErrors = [];
  c.on(m => {
    if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails?.exception?.description?.split("\n")[0] ?? m.params.exceptionDetails?.text);
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors.push(m.params.args?.map(a => a.value ?? a.description).join(" ").slice(0, 300));
  });
  try {
    for (const [name, route, role] of SCREENS) {
      if (only && !only.has(name)) continue;
      await c.send("Network.clearBrowserCookies");
      const ck = cookieFor(role);
      if (ck) await c.send("Network.setCookie", { url: BASE, ...ck, httpOnly: true });
      const entry = (report.screens[name] = { route, role, finalUrl: {}, axe: {}, consoleErrors: [] });
      for (const theme of THEMES) {
        await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
        for (const width of WIDTHS) {
          const mobile = width < 768;
          await c.send("Emulation.setDeviceMetricsOverride", { width, height: mobile ? 800 : width < 1024 ? 1024 : 900, deviceScaleFactor: 1, mobile });
          await c.send("Emulation.setTouchEmulationEnabled", { enabled: mobile });
          consoleErrors.length = 0;
          await c.send("Page.navigate", { url: BASE + route });
          await settle(c);
          const { result } = await c.send("Runtime.evaluate", { expression: "location.pathname", returnByValue: true });
          entry.finalUrl[`${width}-${theme}`] = result.value;
          await shot(c, `${name}__${width}__${theme}.png`, width);
          if (width === 1280) {
            entry.axe[theme] = await axeRun(c);
            if (theme === "light") {
              await c.send("Runtime.evaluate", { expression: "document.documentElement.dir = 'ltr'; document.documentElement.lang = 'en'; true" });
              await sleep(300);
              await shot(c, `${name}__1280__ltr.png`, width);
            }
          }
          entry.consoleErrors.push(...consoleErrors.filter(Boolean).map(e => `${width}-${theme}: ${e}`));
          process.stdout.write(".");
        }
      }
      process.stdout.write(` ${name}\n`);
    }
  } finally {
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
    c.close(); proc.kill();
    await new Promise(r => (proc.exitCode != null ? r() : proc.once("exit", r)));
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ملف مؤقت للمتصفح — لا يؤثر على النتائج */ }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
