import { computeTenantAccess, TENANT_ACCESS_MESSAGES, type TenantAccessLevel, type TenantAccessReason } from "./tenantAccess";

/**
 * معاينة الإنفاذ (قراءة فقط) — ماذا سيحدث لكل شركة **لو** فُعّل TENANT_ACCESS_ENFORCEMENT_ENABLED. دالة نقية؛
 * السكربت يقرأ البيانات بجلسة قراءة فقط ويطبعها. حالتان آمنتان افتراضيًا لكنهما تحتاجان مراجعة يدوية قبل التفعيل
 * تظهران في قسمي تحذير مستقلين بالأسماء والمعرّفات. لا تغيير لحالة أي شركة.
 */
export type PreviewTenant = { id: number; name: string; status: string; trialEndsMs: number | null };
export type PreviewRow = { tenantId: number; name: string; status: string; level: TenantAccessLevel; reason: TenantAccessReason; message: string; until: string | null };
export type TenantAccessPreview = {
  rows: PreviewRow[];
  counts: Record<TenantAccessLevel, number>;
  warnings: { trialWithoutEndDate: PreviewRow[]; pastDueWithoutPeriod: PreviewRow[] };
};

export function buildTenantAccessPreview(tenants: PreviewTenant[], pastDueEndMsByTenant: Map<number, number | null>, now: Date): TenantAccessPreview {
  const rows = tenants.map(t => {
    const since = pastDueEndMsByTenant.get(Number(t.id));
    const a = computeTenantAccess({ status: t.status, trialEndsAt: t.trialEndsMs == null ? null : new Date(Number(t.trialEndsMs)) }, since == null ? null : new Date(Number(since)), now);
    return { tenantId: Number(t.id), name: t.name, status: t.status, level: a.level, reason: a.reason, message: TENANT_ACCESS_MESSAGES[a.reason], until: a.until?.toISOString() ?? null };
  });
  const counts = { full: 0, read_only: 0, blocked: 0 } as Record<TenantAccessLevel, number>;
  for (const r of rows) counts[r.level]++;
  return {
    rows, counts,
    warnings: {
      trialWithoutEndDate: rows.filter(r => r.reason === "trial_no_end_date"),
      pastDueWithoutPeriod: rows.filter(r => r.reason === "past_due_unknown_period"),
    },
  };
}

export function formatTenantAccessPreview(p: TenantAccessPreview): string {
  const line = (r: PreviewRow) => `  #${r.tenantId} ${r.name} [${r.status}] ⇒ ${r.level} — ${r.message}${r.until ? ` (${r.until})` : ""}`;
  const out = [
    `معاينة الإنفاذ (قراءة فقط) — ${p.rows.length} شركة · full ${p.counts.full} · read_only ${p.counts.read_only} · blocked ${p.counts.blocked}`,
    "",
    `⚠️ تحذير — trialing بلا trialEndsAt (ستصبح read_only كحالة آمنة) — ${p.warnings.trialWithoutEndDate.length}:`,
    ...(p.warnings.trialWithoutEndDate.length ? p.warnings.trialWithoutEndDate.map(line) : ["  لا يوجد"]),
    "",
    `⚠️ تحذير — past_due بلا فترة اشتراك معروفة (ستصبح read_only فورًا) — ${p.warnings.pastDueWithoutPeriod.length}:`,
    ...(p.warnings.pastDueWithoutPeriod.length ? p.warnings.pastDueWithoutPeriod.map(line) : ["  لا يوجد"]),
    "",
    "كل الشركات:",
    ...p.rows.map(line),
    "",
    "لا تفعّل TENANT_ACCESS_ENFORCEMENT_ENABLED قبل مراجعة هذه النتيجة يدويًا. هذه المعاينة لم تغيّر حالة أي شركة.",
  ];
  return out.join("\n");
}
