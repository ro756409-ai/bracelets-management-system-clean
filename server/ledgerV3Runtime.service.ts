import jwt from "jsonwebtoken";
import type { ReadOnlyExecutor } from "./balanceReconciliation.service";
import { LEDGER_BASE_ACCOUNTS, reconcileLedgerV3, type LedgerDb } from "./ledgerV3.service";
import { V2_BUSINESS_TABLES } from "./ledgerV3Activation.service";
import { hasTenantPermission } from "./permissions";

/**
 * Smoke test بعد التفعيل — **قراءة فقط** (SELECT عبر المنفّذ القارئ + استدعاء routers القراءة بجلسات
 * حقيقية بالكوكي). لا يكتب شيئًا: الإجراء الوحيد غير القرائي المستدعى هو `period.reopen` للمحاسب،
 * والذي يُرفض في البوابة (للمالك وحده) قبل أي لمسة للقاعدة.
 */
export type RuntimeCheck = { label: string; ok: boolean; detail: string };

const q = async <T = any>(exec: ReadOnlyExecutor, sql: string, params: unknown[] = []) => exec.query<T>(sql, params);

export async function verifyLedgerV3Runtime(opts: { tenantId: number; db: LedgerDb; exec: ReadOnlyExecutor; jwtSecret?: string | null }): Promise<{ ok: boolean; checks: RuntimeCheck[] }> {
  const { tenantId, db, exec } = opts;
  const checks: RuntimeCheck[] = [];
  const push = (label: string, ok: boolean, detail: string) => { checks.push({ label, ok, detail }); };

  // 1) العلم
  let flag: { ledgerV3Enabled: number; goLiveDate: string | Date | null; openingTransactionId: number | null; enabledAt: Date | null } | undefined;
  try {
    [flag] = await q(exec, "SELECT ledgerV3Enabled, goLiveDate, openingTransactionId, enabledAt FROM ledger_tenant_flags WHERE tenantId = ?", [tenantId]);
  } catch (e: any) {
    push("جداول 0040 موجودة", false, e?.code === "ER_NO_SUCH_TABLE" ? "ledger_tenant_flags غير موجود" : String(e?.message ?? e));
    return { ok: false, checks };
  }
  // mysql2 يعيد DATE كـDate — نعرضه كـYYYY-MM-DD
  const goLive = flag?.goLiveDate instanceof Date ? new Date(flag.goLiveDate.getTime() - flag.goLiveDate.getTimezoneOffset() * 60_000).toISOString().slice(0, 10) : flag?.goLiveDate ?? "—";
  push("العلم ledgerV3Enabled مفعّل", flag?.ledgerV3Enabled === 1, flag ? `enabled=${flag.ledgerV3Enabled} · Go-Live ${goLive} · enabledAt ${flag.enabledAt ? new Date(flag.enabledAt).toISOString() : "—"}` : "لا صف علم لهذه الشركة");

  // 2) الحسابات الأساسية مرة واحدة
  const codes = await q<{ code: string; n: number }>(exec, "SELECT code, COUNT(*) n FROM ledger_accounts WHERE tenantId = ? GROUP BY code", [tenantId]);
  const byCode = new Map(codes.map(c => [c.code, Number(c.n)]));
  const missing = LEDGER_BASE_ACCOUNTS.filter(a => !byCode.has(a.code)).map(a => a.code);
  const dup = [...byCode.entries()].filter(([, n]) => n !== 1).map(([c, n]) => `${c}×${n}`);
  push("الحسابات الأساسية التسعة موجودة مرة واحدة", missing.length === 0 && dup.length === 0, `${byCode.size} كود${missing.length ? ` · ناقص: ${missing.join(", ")}` : ""}${dup.length ? ` · مكرر: ${dup.join(", ")}` : ""}`);

  // 3) الربط بالأنشطة
  const activeBiz = (await q<{ id: number }>(exec, "SELECT id FROM businesses WHERE tenantId = ? AND isActive = 1", [tenantId])).map(r => Number(r.id));
  const grants = await q<{ code: string; businessId: number; bt: number | null; active: number | null }>(exec,
    `SELECT a.code, ab.businessId, b.tenantId bt, b.isActive active FROM ledger_account_businesses ab
     JOIN ledger_accounts a ON a.id = ab.accountId LEFT JOIN businesses b ON b.id = ab.businessId WHERE ab.tenantId = ?`, [tenantId]);
  const foreign = grants.filter(g => g.bt !== tenantId || !g.active);
  // الأنشطة المفعَّلة = التي لها أي ربط؛ كل واحد منها يجب أن يكون مربوطًا بالحسابات غير النقدية الأربعة كلها.
  // نشاط نشط بلا أي ربط ليس خطأ (لم يُفعَّل عمدًا في ملف الأرصدة) — يُذكر فقط.
  const grantedBiz = [...new Set(grants.map(g => Number(g.businessId)))];
  const nonMoneyMissing: string[] = [];
  for (const a of LEDGER_BASE_ACCOUNTS.filter(a => !a.money)) for (const b of grantedBiz) if (!grants.some(g => g.code === a.code && Number(g.businessId) === b)) nonMoneyMissing.push(`${a.code}→#${b}`);
  const ungranted = activeBiz.filter(b => !grantedBiz.includes(b));
  push("الربط بالأنشطة صحيح (لا نشاط أجنبي/غير نشط، وكل نشاط مفعَّل مربوط بالحسابات غير النقدية كلها)", grants.length > 0 && foreign.length === 0 && nonMoneyMissing.length === 0,
    `${grants.length} ربط · أنشطة مفعَّلة ${grantedBiz.length}/${activeBiz.length} نشطة${ungranted.length ? ` (بلا ربط: ${ungranted.map(b => `#${b}`).join(", ")})` : ""}${foreign.length ? ` · أجنبي/غير نشط: ${foreign.length}` : ""}${nonMoneyMissing.length ? ` · ناقص: ${nonMoneyMissing.join(", ")}` : ""}`);

  // 4) القيد الافتتاحي
  const openings = await q<{ id: number }>(exec, "SELECT id FROM ledger_transactions WHERE tenantId = ? AND kind = 'opening_balance'", [tenantId]);
  if (flag?.openingTransactionId == null) {
    push("openingTransactionId = NULL ولا قيد افتتاحي (أرصدة صفرية)", openings.length === 0, `قيود افتتاحية موجودة: ${openings.length}`);
  } else {
    const sums = await q<{ side: string; s: string }>(exec, "SELECT side, SUM(amount) s FROM ledger_entries WHERE tenantId = ? AND transactionId = ? GROUP BY side", [tenantId, flag.openingTransactionId]);
    const debit = sums.find(s => s.side === "debit")?.s ?? "0", credit = sums.find(s => s.side === "credit")?.s ?? "0";
    const one = openings.length === 1 && Number(openings[0].id) === Number(flag.openingTransactionId);
    push("openingTransactionId يشير إلى قيد افتتاحي واحد متوازن", one && debit === credit, `قيود افتتاحية ${openings.length} · #${flag.openingTransactionId} · مدين ${debit} / دائن ${credit}`);
  }

  // 5) مطابقة V3
  try {
    const rec = await reconcileLedgerV3(tenantId, db);
    const bad = rec.lines.filter(l => !l.ok);
    push("مطابقة V3 = صفر فروق (currentBalance = مجموع القيود لكل حساب)", rec.ok, bad.length ? bad.map(l => `${(l as any).code ?? l.accountId}: مخزّن ${l.stored} ≠ محسوب ${l.computed}`).join(" | ") : `${rec.lines.length} حساب مطابق`);
  } catch (e: any) { push("مطابقة V3", false, String(e?.message ?? e)); }

  // 6) لا كتابة في V2 في نافذة التفعيل (±5 ثوانٍ حول enabledAt)
  const allBiz = (await q<{ id: number }>(exec, "SELECT id FROM businesses WHERE tenantId = ?", [tenantId])).map(r => Number(r.id));
  if (!flag?.enabledAt) push("لا كتابة في V2 في نافذة التفعيل", false, "enabledAt فارغ");
  else if (allBiz.length === 0) push("لا كتابة في V2 في نافذة التفعيل", true, "لا أنشطة");
  else {
    const ph = allBiz.map(() => "?").join(",");
    const hits: string[] = [];
    for (const t of V2_BUSINESS_TABLES) {
      const [r] = await q<{ n: number }>(exec, `SELECT COUNT(*) n FROM \`${t}\` WHERE businessId IN (${ph}) AND createdAt BETWEEN DATE_SUB(?, INTERVAL 5 SECOND) AND DATE_ADD(?, INTERVAL 5 SECOND)`, [...allBiz, flag.enabledAt, flag.enabledAt]);
      if (Number(r?.n ?? 0) > 0) hits.push(`${t}=${r.n}`);
    }
    push("لا كتابة في V2 في نافذة التفعيل (±5s حول enabledAt)", hits.length === 0, hits.length ? hits.join(", ") : "صفر صفوف V2 في النافذة");
  }

  // 7) Routers القراءة بجلسات حقيقية: المالك والمحاسب
  const secret = opts.jwtSecret ?? process.env.JWT_SECRET ?? null;
  if (!secret) push("routers الدفتر تستجيب للمالك/المحاسب", false, "JWT_SECRET غير مضبوط — لا يمكن بناء جلسة اختبار");
  else {
    const { appRouter } = await import("./routers");
    const { createContext } = await import("./_core/context");
    const callerFor = async (employeeId: number) => appRouter.createCaller(await createContext({
      req: { protocol: "https", headers: {}, cookies: { employee_token: jwt.sign({ employeeId }, secret) } },
      res: { clearCookie: () => {}, cookie: () => {} },
    } as any)) as any;
    const codeOf = async (fn: () => Promise<unknown>) => { try { await fn(); return "ok"; } catch (e: any) { return e?.code ?? "ERR"; } };

    const [owner] = await q<{ id: number; name: string }>(exec, "SELECT id, name FROM employees WHERE tenantId = ? AND role = 'super_admin' AND isActive = 1 ORDER BY id LIMIT 1", [tenantId]);
    if (!owner) push("المالك: routers القراءة", false, "لا مالك (super_admin) فعّال لهذه الشركة");
    else {
      try {
        const c = await callerFor(Number(owner.id));
        const st = await c.ledger.status();
        const accounts = await c.ledger.accounts.list();
        const txs = await c.ledger.transactions.list({ page: 1, limit: 5 });
        const rec = await c.ledger.reconciliation();
        push("المالك: status/accounts.list/transactions.list/reconciliation تستجيب", st.enabled === true && Array.isArray(accounts) && typeof txs.total === "number" && rec.ok === true,
          `enabled=${st.enabled} · حسابات ${accounts.length} · حركات ${txs.total} · مطابقة ${rec.ok}`);
      } catch (e: any) { push("المالك: routers القراءة", false, `${e?.code ?? "ERR"}: ${e?.message ?? e}`); }
    }

    const [acct] = await q<{ id: number; name: string }>(exec, "SELECT id, name FROM employees WHERE tenantId = ? AND role = 'accountant' AND isActive = 1 ORDER BY id LIMIT 1", [tenantId]);
    if (!acct) push("المحاسب: routers حسب المنح", true, "لا محاسب فعّال لهذه الشركة — تخطٍّ");
    else {
      const expectView = await hasTenantPermission(tenantId, "accountant", "ledger.view");
      const c = await callerFor(Number(acct.id));
      const got = await codeOf(() => c.ledger.status());
      const reopen = await codeOf(() => c.ledger.period.reopen({ period: "2000-01", reason: "فحص تشغيلي — يجب أن يُرفض" }));
      push("المحاسب: القراءة حسب ledger.view، وإعادة فتح الشهر مرفوضة دائمًا (للمالك وحده)",
        (expectView ? got === "ok" : got === "FORBIDDEN") && reopen === "FORBIDDEN",
        `ledger.view ${expectView ? "ممنوحة" : "غير ممنوحة"} → status=${got} · period.reopen=${reopen}`);
    }
  }

  return { ok: checks.every(c => c.ok), checks };
}
