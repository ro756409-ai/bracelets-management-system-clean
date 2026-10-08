import { and, eq } from "drizzle-orm";
import { employees, tenants } from "../drizzle/schema";
import { ledgerTenantFlags, ledgerTransactions } from "../drizzle/ledgerV3.schema";
import { disableLedgerV3, type LedgerDb } from "./ledgerV3.service";

/**
 * تعطيل دفتر V3 لشركة تشغيليًا — **العلم فقط** عبر `disableLedgerV3`: لا حذف جداول ولا حركات ولا حسابات.
 * dry-run افتراضيًا؛ `apply` يتطلب مالكًا (super_admin) فعّالًا من نفس الشركة، سببًا، وعبارة تأكيد تتضمن
 * معرّف الشركة. معطّل مسبقًا → replay بلا تغيير. يُسجَّل الفاعل والسبب والتوقيت في صف العلم.
 */
export const disableConfirmationPhrase = (tenantId: number) => `DISABLE LEDGER V3 TENANT ${tenantId}`;

export type DisableResult = { ok: boolean; applied: boolean; replay: boolean; refused: string | null; lines: string[] };

export async function runDisableLedgerV3(opts: { tenantId: number; db: LedgerDb; actorEmployeeId: number; reason: string; apply: boolean; confirm?: string | null }): Promise<DisableResult> {
  const { tenantId, db } = opts;
  const lines: string[] = [];
  const refuse = (why: string): DisableResult => { lines.push(`✗ مرفوض — لا كتابة: ${why}`); return { ok: false, applied: false, replay: false, refused: why, lines }; };

  const [tenant] = await db.select({ id: tenants.id, name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) return refuse(`الشركة #${tenantId} غير موجودة`);
  lines.push(`الشركة: #${tenant.id} «${tenant.name}» · الوضع: ${opts.apply ? "APPLY" : "dry-run (لا تغيير)"}`);

  const [actor] = await db.select({ id: employees.id, name: employees.name, role: employees.role, isActive: employees.isActive, tenantId: employees.tenantId })
    .from(employees).where(and(eq(employees.id, opts.actorEmployeeId), eq(employees.tenantId, tenantId))).limit(1);
  if (!actor || !actor.isActive) return refuse(`الفاعل #${opts.actorEmployeeId} ليس موظفًا فعّالًا في هذه الشركة`);
  if (actor.role !== "super_admin") return refuse(`الفاعل #${actor.id} (${actor.role}) ليس مالكًا (super_admin) — التعطيل للمالك وحده`);
  lines.push(`الفاعل: #${actor.id} ${actor.name} (super_admin)`);
  if (!opts.reason?.trim() || opts.reason.trim().length < 3) return refuse("السبب إلزامي (3 أحرف على الأقل)");

  let flag: { ledgerV3Enabled: number; goLiveDate: string | null; disabledAt: Date | null; disabledReason: string | null } | undefined;
  try { [flag] = await db.select({ ledgerV3Enabled: ledgerTenantFlags.ledgerV3Enabled, goLiveDate: ledgerTenantFlags.goLiveDate, disabledAt: ledgerTenantFlags.disabledAt, disabledReason: ledgerTenantFlags.disabledReason })
    .from(ledgerTenantFlags).where(eq(ledgerTenantFlags.tenantId, tenantId)).limit(1); }
  catch (e: any) { if (e?.code === "ER_NO_SUCH_TABLE" || e?.cause?.code === "ER_NO_SUCH_TABLE") return refuse("جداول 0040 غير موجودة — لا شيء لتعطيله"); throw e; }
  if (!flag) return refuse("الشركة لم تُفعَّل قط (لا صف علم) — لا شيء لتعطيله");
  const [{ n: txCount }] = await db.select({ n: ledgerTransactions.id }).from(ledgerTransactions).where(eq(ledgerTransactions.tenantId, tenantId)).then(rows => [{ n: rows.length }]);
  lines.push(`العلم: ${flag.ledgerV3Enabled === 1 ? `مفعّل (Go-Live ${flag.goLiveDate})` : `معطّل مسبقًا${flag.disabledAt ? ` منذ ${new Date(flag.disabledAt).toISOString()}` : ""}${flag.disabledReason ? ` — السبب: ${flag.disabledReason}` : ""}`} · الحركات المحفوظة: ${txCount} (لا تُمس)`);
  lines.push("الأثر: إيقاف الكتابة في الدفتر فقط؛ الجداول والحسابات والحركات والفترات تبقى كما هي، والقراءة متاحة.");

  if (!opts.apply) { lines.push(`للتنفيذ: --apply --confirm "${disableConfirmationPhrase(tenantId)}"`); return { ok: true, applied: false, replay: false, refused: null, lines }; }
  if ((opts.confirm ?? "") !== disableConfirmationPhrase(tenantId)) return refuse(`عبارة التأكيد غير مطابقة — المطلوب حرفيًا: ${disableConfirmationPhrase(tenantId)}`);
  if (flag.ledgerV3Enabled !== 1) { lines.push("↻ معطّل مسبقًا — replay بلا أي تغيير"); return { ok: true, applied: false, replay: true, refused: null, lines }; }

  await disableLedgerV3({ tenantId, actor: { type: "employee", employeeId: actor.id }, reason: opts.reason.trim() }, db);
  const [after] = await db.select({ ledgerV3Enabled: ledgerTenantFlags.ledgerV3Enabled, disabledAt: ledgerTenantFlags.disabledAt }).from(ledgerTenantFlags).where(eq(ledgerTenantFlags.tenantId, tenantId)).limit(1);
  lines.push(`✓ تم تعطيل العلم (enabled=${after?.ledgerV3Enabled}) في ${after?.disabledAt ? new Date(after.disabledAt).toISOString() : "—"} · الفاعل #${actor.id} · السبب مسجَّل · الحركات ${txCount} كما هي`);
  return { ok: after?.ledgerV3Enabled === 0, applied: true, replay: false, refused: null, lines };
}
