import { and, asc, eq } from "drizzle-orm";
import { businesses, employees, tenants } from "../drizzle/schema";
import { ledgerAccounts } from "../drizzle/ledgerV3.schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { confirmationPhrase, isValidIsoDate, type OpeningFile, type OpeningReconciliation } from "../shared/ledgerV3Activation";
import type { ApplicationState } from "../shared/ledgerV3Spec";
import { loadBalanceReport, type ReadOnlyExecutor } from "./balanceReconciliation.service";
import { verifyLedgerV3OnDatabase } from "./ledgerV3Verify.service";
import { activateLedgerV3, getLedgerStatus, LEDGER_BASE_ACCOUNTS, type LedgerDb, type LedgerStatus } from "./ledgerV3.service";

/**
 * تفعيل Ledger V3 لشركة — تخطيط (قراءة فقط) ثم تطبيق (معاملة واحدة عبر `activateLedgerV3`).
 *
 * القواعد:
 *   • لا تفعيل إلا و0040 مطبَّقة بالكامل ومطابقة للمواصفة.
 *   • لا تفعيل وفي مطابقة V2 فرق غير معتمد صراحةً (`reconciliation.acknowledgedDifferences`).
 *   • مفعّل مسبقًا بنفس تاريخ Go-Live → replay بلا تكرار؛ بتاريخ مختلف → رفض.
 *   • لا تخمين للأرصدة: ما ليس في ملف الأرصدة = صفر، ولا نسخ من تاريخ V2 أبدًا.
 *   • الفاعل والمعتمِد = مالك (`super_admin`) فعّال من نفس الشركة — مهما كانت منح tenant_role_permissions.
 *   • عبارة التأكيد تتضمن tenantId وتاريخ Go-Live حرفيًا.
 *   • لا يُرجع ولا يطبع أي رابط أو سر.
 */
export const V2_BUSINESS_TABLES = ["treasury_transactions", "financial_transactions", "financial_transaction_entries", "financial_accounts", "business_events"] as const;

export async function countV2Rows(exec: ReadOnlyExecutor, businessIds: number[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of V2_BUSINESS_TABLES) {
    if (businessIds.length === 0) { out[t] = 0; continue; }
    const ph = businessIds.map(() => "?").join(",");
    const [row] = await exec.query<{ n: number }>(`SELECT COUNT(*) n FROM \`${t}\` WHERE businessId IN (${ph})`, businessIds);
    out[t] = Number(row?.n ?? 0);
  }
  return out;
}

export type PlannedAccount = { code: string; name: string; kind: string; normalSide: string; money: boolean; exists: boolean; businesses: number[] };
export type ActivationPlan = {
  tenant: { id: number; name: string; status: string } | null;
  businesses: { id: number; name: string; isActive: boolean }[];
  /** الأنشطة التي ستُفعَّل (من الملف أو كل النشطة) */
  selectedBusinessIds: number[];
  migration: { state: ApplicationState; issues: number; present: string[] };
  flag: LedgerStatus | null;
  v2Reconciliation: { generatedAt: string; ok: boolean; lines: { businessId: number; key: string; label: string; stored: number; computed: number; difference: number; ok: boolean }[] } | null;
  accounts: PlannedAccount[];
  safeGrants: Record<string, number[]>;
  openingBalances: { code: string; amount: string; source: "file" | "zero" }[];
  openingEntry: { debits: { code: string; amount: string }[]; credit: { code: "OPENING_EQUITY"; amount: string } } | null;
  goLiveDate: string | null;
  currency: string;
  reconciliation: OpeningReconciliation | null;
  actorEmployeeId: number | null;
  blockers: string[];
  warnings: string[];
  confirmation: string | null;
};

const isActiveOwner = async (db: LedgerDb, tenantId: number, employeeId: number): Promise<{ ok: boolean; name: string | null }> => {
  const [e] = await db.select({ id: employees.id, name: employees.name, role: employees.role, isActive: employees.isActive })
    .from(employees).where(and(eq(employees.id, employeeId), eq(employees.tenantId, tenantId))).limit(1);
  // المالك وحده: الدور الحقيقي super_admin — لا admin ولا أي override
  return { ok: Boolean(e && e.isActive && e.role === "super_admin"), name: e?.name ?? null };
};

export async function planLedgerV3Activation(opts: {
  tenantId: number; db: LedgerDb; exec: ReadOnlyExecutor; opening?: OpeningFile | null; goLiveDate?: string | null; actorEmployeeId?: number | null;
}): Promise<ActivationPlan> {
  const { tenantId, db, exec } = opts;
  const opening = opts.opening ?? null;
  const blockers: string[] = [];
  const warnings: string[] = [];

  const [tenantRow] = await db.select({ id: tenants.id, name: tenants.name, status: tenants.status }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const tenant = tenantRow ? { id: tenantRow.id, name: tenantRow.name, status: String(tenantRow.status) } : null;
  if (!tenant) blockers.push(`الشركة #${tenantId} غير موجودة`);
  else if (["canceled", "suspended", "expired"].includes(tenant.status)) blockers.push(`حالة الشركة «${tenant.status}» — لا تفعيل`);

  const bizRows = tenant
    ? (await db.select({ id: businesses.id, name: businesses.name, isActive: businesses.isActive }).from(businesses).where(eq(businesses.tenantId, tenantId)).orderBy(asc(businesses.id)))
        .map(b => ({ id: b.id, name: b.name, isActive: Boolean(b.isActive) }))
    : [];
  const activeIds = bizRows.filter(b => b.isActive).map(b => b.id);

  const mig = await verifyLedgerV3OnDatabase(exec);
  const migration = { state: mig.state, issues: mig.issues.length, present: mig.present };
  if (mig.state !== "applied") blockers.push(`الترحيلة 0040 ${mig.state === "not_applied" ? "غير مطبَّقة" : "مطبَّقة جزئيًا"} (${mig.issues.length} فرق عن المواصفة) — لا تفعيل قبل تطبيقها كاملة والتحقق`);
  else if (mig.issues.length > 0) blockers.push(`الترحيلة 0040 موجودة لكن المخطط لا يطابق المواصفة (${mig.issues.length} فرق) — راجع verify-ledger-v3`);

  const flag = migration.present.includes("ledger_tenant_flags") && tenant ? await getLedgerStatus(tenantId, db) : null;

  const goLiveDate = opening?.goLiveDate ?? opts.goLiveDate ?? null;
  if (!goLiveDate) blockers.push("تاريخ Go-Live مطلوب (goLiveDate في ملف الأرصدة أو --go-live YYYY-MM-DD)");
  else if (!isValidIsoDate(goLiveDate)) blockers.push(`تاريخ Go-Live غير صالح: ${goLiveDate}`);
  if (flag?.enabled) {
    if (flag.goLiveDate === goLiveDate) warnings.push(`الشركة مفعّلة مسبقًا بنفس تاريخ Go-Live (${flag.goLiveDate}) — --apply يعيد نتيجة replay بلا أي تكرار`);
    else blockers.push(`الشركة مفعّلة مسبقًا بتاريخ Go-Live ${flag.goLiveDate} ≠ ${goLiveDate} — لا تفعيل ثانٍ`);
  }

  const selectedBusinessIds = opening?.businessIds ?? activeIds;
  for (const id of selectedBusinessIds) {
    const b = bizRows.find(x => x.id === id);
    if (!b) blockers.push(`النشاط #${id} ليس تابعًا لهذه الشركة`);
    else if (!b.isActive) blockers.push(`النشاط #${id} (${b.name}) غير نشط`);
  }
  if (tenant && selectedBusinessIds.length === 0) blockers.push("لا أنشطة نشطة للشركة — لا تفعيل");

  const safeGrants: Record<string, number[]> = {};
  for (const a of LEDGER_BASE_ACCOUNTS) {
    if (!a.money) continue;
    const ids = opening?.safeGrants?.[a.code] ?? selectedBusinessIds;
    for (const id of ids) if (!selectedBusinessIds.includes(id)) blockers.push(`safeGrants.${a.code}: النشاط #${id} ليس ضمن الأنشطة المفعَّلة`);
    safeGrants[a.code] = ids;
  }

  let v2Reconciliation: ActivationPlan["v2Reconciliation"] = null;
  if (tenant && bizRows.length > 0) {
    const report = await loadBalanceReport(exec, bizRows.map(b => b.id));
    v2Reconciliation = {
      generatedAt: report.generatedAt, ok: report.ok,
      lines: report.lines.map(l => ({ businessId: l.businessId, key: l.key, label: l.label, stored: l.stored, computed: l.computed, difference: l.difference, ok: l.ok })),
    };
    if (!report.ok && !opening?.reconciliation?.acknowledgedDifferences)
      blockers.push(`مطابقة الأرصدة القديمة بها ${report.mismatches.length} فرق غير معتمد — راجع التقرير ثم ضع reconciliation.acknowledgedDifferences=true في ملف الأرصدة`);
  }

  let reconciliation: OpeningReconciliation | null = opening?.reconciliation ?? null;
  if (!reconciliation) {
    if (opts.actorEmployeeId != null && v2Reconciliation?.ok)
      reconciliation = { reportGeneratedAt: v2Reconciliation.generatedAt, approvedByEmployeeId: opts.actorEmployeeId, approvedAt: new Date().toISOString(), acknowledgedDifferences: false };
    else if (tenant) blockers.push("اعتماد تقرير المطابقة مطلوب: reconciliation في ملف الأرصدة، أو --actor <المالك> مع مطابقة V2 بلا فروق");
  }
  if (reconciliation && tenant) {
    const ap = await isActiveOwner(db, tenantId, reconciliation.approvedByEmployeeId);
    if (!ap.ok) blockers.push(`المعتمِد #${reconciliation.approvedByEmployeeId} ليس مالكًا (super_admin) فعّالًا في هذه الشركة`);
  }
  if (opts.actorEmployeeId != null && tenant) {
    const ac = await isActiveOwner(db, tenantId, opts.actorEmployeeId);
    if (!ac.ok) blockers.push(`الفاعل #${opts.actorEmployeeId} ليس مالكًا (super_admin) فعّالًا — التفعيل للمالك وحده مهما كانت المنح`);
  }

  const existing = migration.present.includes("ledger_accounts") && tenant
    ? (await db.select({ code: ledgerAccounts.code }).from(ledgerAccounts).where(eq(ledgerAccounts.tenantId, tenantId))).map(r => r.code)
    : [];
  const accounts: PlannedAccount[] = LEDGER_BASE_ACCOUNTS.map(a => ({
    code: a.code, name: a.name, kind: a.kind, normalSide: a.normalSide, money: a.money, exists: existing.includes(a.code),
    businesses: a.money ? safeGrants[a.code] : selectedBusinessIds,
  }));

  let total = 0n;
  const openingBalances: ActivationPlan["openingBalances"] = LEDGER_BASE_ACCOUNTS.filter(a => a.money).map(a => {
    const fromFile = opening?.openingBalances[a.code];
    const amount = fromFile ?? "0";
    total += toMinorUnits(amount);
    return { code: a.code, amount: fromMinorUnits(toMinorUnits(amount)), source: fromFile !== undefined ? "file" : "zero" };
  });
  const openingEntry = total > 0n
    ? { debits: openingBalances.filter(o => toMinorUnits(o.amount) > 0n).map(o => ({ code: o.code, amount: o.amount })), credit: { code: "OPENING_EQUITY" as const, amount: fromMinorUnits(total) } }
    : null;
  if (!opening) warnings.push("لا ملف أرصدة: كل الأرصدة الافتتاحية صفر (تفعيل صفري بلا قيد افتتاحي) — لا تخمين ولا نسخ من V2");

  return {
    tenant, businesses: bizRows, selectedBusinessIds, migration, flag, v2Reconciliation, accounts, safeGrants, openingBalances, openingEntry,
    goLiveDate, currency: opening?.currency ?? "EGP", reconciliation, actorEmployeeId: opts.actorEmployeeId ?? null, blockers, warnings,
    confirmation: goLiveDate ? confirmationPhrase(tenantId, goLiveDate) : null,
  };
}

export type ActivationApplyResult = {
  replay: boolean; openingTransactionId: number | null; accounts: Record<string, number>;
  v2Before: Record<string, number>; v2After: Record<string, number>; v2Changed: string[];
};

export async function applyLedgerV3Activation(opts: { tenantId: number; plan: ActivationPlan; db: LedgerDb; exec: ReadOnlyExecutor; actorEmployeeId: number; confirm: string }): Promise<ActivationApplyResult> {
  const { tenantId, plan, db, exec } = opts;
  if (plan.blockers.length > 0) throw new Error(`موانع التفعيل: ${plan.blockers.join(" | ")}`);
  if (!plan.confirmation || opts.confirm !== plan.confirmation) throw new Error("عبارة التأكيد غير مطابقة — لا كتابة");
  if (plan.actorEmployeeId !== opts.actorEmployeeId) throw new Error("الفاعل يختلف عن الخطة — أعد التخطيط بنفس --actor");
  const actor = await isActiveOwner(db, tenantId, opts.actorEmployeeId);
  if (!actor.ok) throw new Error("التفعيل للمالك (super_admin) الفعّال وحده — مهما كانت المنح");
  if (!plan.goLiveDate || !plan.reconciliation) throw new Error("خطة ناقصة (تاريخ Go-Live أو الاعتماد)");

  const bizIds = plan.businesses.map(b => b.id);
  const v2Before = await countV2Rows(exec, bizIds);
  const r = await activateLedgerV3({
    tenantId, goLiveDate: plan.goLiveDate, currency: plan.currency, actor: { type: "employee", employeeId: opts.actorEmployeeId },
    reconciliation: { reportGeneratedAt: plan.reconciliation.reportGeneratedAt, approvedByEmployeeId: plan.reconciliation.approvedByEmployeeId, approvedAt: plan.reconciliation.approvedAt },
    openingBalances: Object.fromEntries(plan.openingBalances.map(o => [o.code, o.amount])),
    businessIds: plan.selectedBusinessIds, safeGrants: plan.safeGrants,
  }, db);
  const v2After = await countV2Rows(exec, bizIds);
  const v2Changed = Object.keys(v2Before).filter(k => v2Before[k] !== v2After[k]);
  return { replay: r.replay, openingTransactionId: r.openingTransactionId, accounts: r.accounts, v2Before, v2After, v2Changed };
}

/** عرض نصي للخطة بلا أسرار (للـCLI والاختبارات). */
export function renderActivationPlan(plan: ActivationPlan): string {
  const L: string[] = [];
  L.push(`الشركة: ${plan.tenant ? `#${plan.tenant.id} «${plan.tenant.name}» (${plan.tenant.status})` : "غير موجودة"}`);
  L.push(`الأنشطة: ${plan.businesses.length ? plan.businesses.map(b => `#${b.id} ${b.name}${b.isActive ? "" : " (غير نشط)"}`).join("، ") : "—"}`);
  L.push(`الأنشطة المفعَّلة: ${plan.selectedBusinessIds.map(id => `#${id}`).join("، ") || "—"}`);
  L.push(`جداول 0040: ${plan.migration.state}${plan.migration.issues ? ` (${plan.migration.issues} فرق)` : ""} — الموجود: ${plan.migration.present.join(", ") || "لا شيء"}`);
  L.push(`ledgerV3Enabled: ${plan.flag ? (plan.flag.enabled ? `مفعّل (Go-Live ${plan.flag.goLiveDate}, opening #${plan.flag.openingTransactionId ?? "—"})` : "غير مفعّل") : "— (الجداول غير موجودة)"}`);
  L.push(`تاريخ Go-Live: ${plan.goLiveDate ?? "—"} · العملة: ${plan.currency}`);
  if (plan.v2Reconciliation) {
    L.push(`مطابقة V2: ${plan.v2Reconciliation.ok ? "✓ بلا فروق" : "✗ فروق"} (${plan.v2Reconciliation.lines.length} سطر)`);
    for (const l of plan.v2Reconciliation.lines) L.push(`  ${l.ok ? "✓" : "✗"} [${l.businessId}] ${l.key} — ${l.label}: مخزّن ${l.stored} · محسوب ${l.computed} · فرق ${l.difference}`);
  } else L.push("مطابقة V2: — (لا أنشطة)");
  L.push("الحسابات التسعة:");
  for (const a of plan.accounts) L.push(`  ${a.exists ? "=" : "+"} ${a.code} «${a.name}» ${a.kind}/${a.normalSide} → الأنشطة: ${a.businesses.map(id => `#${id}`).join("، ") || "—"}`);
  L.push("الأرصدة الافتتاحية المقترحة:");
  for (const o of plan.openingBalances) L.push(`  ${o.code}: ${o.amount} (${o.source === "file" ? "من الملف" : "صفر — غير مذكور"})`);
  L.push(plan.openingEntry ? `القيد الافتتاحي: مدين ${plan.openingEntry.debits.map(d => `${d.code} ${d.amount}`).join(" + ")} / دائن OPENING_EQUITY ${plan.openingEntry.credit.amount}` : "القيد الافتتاحي: لا شيء (أرصدة صفرية)");
  L.push(`الاعتماد: ${plan.reconciliation ? `تقرير ${plan.reconciliation.reportGeneratedAt} · معتمِد #${plan.reconciliation.approvedByEmployeeId} في ${plan.reconciliation.approvedAt}${plan.reconciliation.acknowledgedDifferences ? " · مع إقرار بالفروق" : ""}` : "—"}`);
  for (const w of plan.warnings) L.push(`⚠️ ${w}`);
  L.push(plan.blockers.length ? `موانع التفعيل (${plan.blockers.length}):` : "✓ لا موانع");
  for (const b of plan.blockers) L.push(`  ✗ ${b}`);
  if (plan.confirmation) L.push(`عبارة التأكيد المطلوبة لـ--apply: ${plan.confirmation}`);
  return L.join("\n");
}
