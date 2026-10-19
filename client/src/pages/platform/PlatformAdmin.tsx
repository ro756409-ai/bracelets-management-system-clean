import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ShieldCheck, LogOut, RefreshCw, CheckCircle2, XCircle, ChevronDown } from "lucide-react";
import { StatusBadge, EmptyState, LoadingSkeleton } from "@/components/shared";
import { PlatformBillingPanel } from "./PlatformBillingPanel";
import { AR_LOCALE } from "@/lib/format";

type Status = "pending" | "approved" | "rejected";
interface SignupRequest {
  id: number; ownerName: string; businessName: string; phone: string; email: string;
  username: string; status: Status; rejectionReason: string | null;
  reviewedAt: string | null; createdTenantId: number | null; createdAt: string;
}

const STATUS_LABEL: Record<Status, string> = { pending: "قيد المراجعة", approved: "مقبول", rejected: "مرفوض" };
const STATUS_TONE: Record<Status, "warning" | "success" | "danger"> = { pending: "warning", approved: "success", rejected: "danger" };
const TOUCH = "min-h-11 md:min-h-9";

/**
 * لوحة إدارة المنصة (طلبات التسجيل) — نفس الـREST (/api/platform/*) ونفس القبول/الرفض بتأكيد.
 * المرحلة 7H (عرض فقط): tokens الهوية، تبويبات 44px مع aria-pressed، شارات الحالة، صفوف قابلة للفتح
 * بزر aria-expanded، حالات Loading/Empty، وحارس `busy` كما هو على القبول/الرفض.
 */
export default function PlatformAdmin() {
  const [, setLocation] = useLocation();
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Status>("pending");
  const [rows, setRows] = useState<SignupRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<SignupRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  // قسم الفوترة (0055) — السيرفر بيرجّع 503 لو SUBSCRIPTION_BILLING_ENABLED مقفول، والرسالة بتظهر جوه اللوحة.
  const [section, setSection] = useState<"requests" | "billing">("requests");

  // حارس: لازم جلسة Platform Admin؛ وإلا للدخول.
  useEffect(() => {
    (async () => {
      const res = await fetch("/api/platform/auth/me", { credentials: "include" });
      if (!res.ok) { setLocation("/platform-admin/login"); return; }
      setReady(true);
    })();
  }, [setLocation]);

  const load = useCallback(async (status: Status) => {
    setMsg(""); setLoading(true);
    try {
      const res = await fetch(`/api/platform/signup-requests?status=${status}`, { credentials: "include" });
      if (res.status === 401) { setLocation("/platform-admin/login"); return; }
      const data = await res.json().catch(() => ({ requests: [] }));
      setRows(data.requests ?? []);
    } finally { setLoading(false); }
  }, [setLocation]);

  useEffect(() => { if (ready) load(tab); }, [ready, tab, load]);

  const logout = async () => {
    await fetch("/api/platform/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
    setLocation("/platform-admin/login");
  };

  const approve = async (r: SignupRequest) => {
    if (!confirm(`تأكيد قبول طلب "${r.businessName}"؟ هيتم إنشاء حساب ومساحة عمل جديدة.`)) return;
    setBusy(true); setMsg("");
    try {
      const res = await fetch(`/api/platform/signup-requests/${r.id}/approve`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) { setMsg(data.error || "تعذّر القبول"); return; }
      setMsg("تم القبول وإنشاء الحساب.");
      setSelected(null); await load(tab);
    } finally { setBusy(false); }
  };

  const reject = async (r: SignupRequest) => {
    const reason = prompt(`سبب رفض طلب "${r.businessName}"؟ (اختياري)`) ?? undefined;
    if (!confirm(`تأكيد رفض طلب "${r.businessName}"؟`)) return;
    setBusy(true); setMsg("");
    try {
      const res = await fetch(`/api/platform/signup-requests/${r.id}/reject`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) { setMsg(data.error || "تعذّر الرفض"); return; }
      setMsg("تم رفض الطلب.");
      setSelected(null); await load(tab);
    } finally { setBusy(false); }
  };

  if (!ready) return null;

  return (
    <div className="min-h-screen bg-background" dir="rtl" data-testid="platform-admin">
      <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-card/95 px-4 py-2 backdrop-blur sm:px-6">
        <div className="flex items-center gap-2 font-bold"><span className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-brand-md)] bg-accent text-accent-foreground" aria-hidden="true"><ShieldCheck className="h-5 w-5" /></span> لوحة إدارة المنصة</div>
        <Button variant="outline" size="sm" onClick={logout} className={`${TOUCH} gap-1`} data-testid="platform-logout"><LogOut className="h-4 w-4" aria-hidden="true" /> خروج</Button>
      </header>

      <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
        <div className="flex gap-2 border-b border-border" role="group" aria-label="أقسام لوحة المنصة">
          {([["requests", "طلبات التسجيل"], ["billing", "الفوترة"]] as const).map(([k, label]) => (
            <button key={k} type="button" onClick={() => setSection(k)} aria-pressed={section === k} data-testid={`platform-section-${k}`}
              className={`-mb-px min-h-11 border-b-2 px-3 text-sm font-semibold ${section === k ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>{label}</button>
          ))}
        </div>
        {section === "billing" ? <PlatformBillingPanel onUnauthorized={() => setLocation("/platform-admin/login")} /> : <>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="حالة الطلبات">
          {(["pending", "approved", "rejected"] as Status[]).map(s => (
            <button key={s} type="button" onClick={() => setTab(s)} aria-pressed={tab === s} data-testid={`platform-tab-${s}`}
              className={`min-h-11 rounded-[var(--radius-brand-pill,9999px)] border px-4 text-sm font-medium transition-colors duration-[var(--duration-fast)] md:min-h-9 ${tab === s ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:bg-muted"}`}>
              {STATUS_LABEL[s]}
            </button>
          ))}
          <Button variant="ghost" size="sm" className={`${TOUCH} ms-auto gap-1`} onClick={() => load(tab)} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" /> تحديث</Button>
        </div>

        {msg && <div className="rounded-[var(--radius-brand-md)] border border-border bg-card p-3 text-sm" role="status" data-testid="platform-msg">{msg}</div>}

        {loading && rows.length === 0 ? (
          <LoadingSkeleton variant="cards" rows={3} />
        ) : rows.length === 0 ? (
          <EmptyState title="لا توجد طلبات في هذه الحالة." description={tab === "pending" ? "طلبات التسجيل الجديدة تظهر هنا للمراجعة." : undefined} />
        ) : (
          <ul className="space-y-2" data-testid="platform-requests">
            {rows.map(r => {
              const openRow = selected?.id === r.id;
              return (
                <li key={r.id} className="rounded-[var(--radius-brand-md)] border border-border bg-card" data-testid={`platform-request-${r.id}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                    <button type="button" className="flex min-h-11 min-w-0 flex-1 items-center gap-2 text-start md:min-h-0" onClick={() => setSelected(openRow ? null : r)} aria-expanded={openRow} aria-controls={`platform-request-details-${r.id}`}>
                      <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[var(--duration-fast)] ${openRow ? "rotate-180" : ""}`} aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-foreground">{r.businessName}</span>
                        <span className="block truncate text-sm text-muted-foreground">{r.ownerName} · <span dir="ltr">{r.email}</span> · <span dir="ltr">{r.phone}</span></span>
                      </span>
                    </button>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={r.status} label={STATUS_LABEL[r.status]} tone={STATUS_TONE[r.status]} size="sm" />
                      {r.status === "pending" && (
                        <>
                          <Button size="sm" className={`${TOUCH} gap-1`} disabled={busy} onClick={() => approve(r)} data-testid={`platform-approve-${r.id}`}><CheckCircle2 className="h-4 w-4" aria-hidden="true" /> قبول</Button>
                          <Button size="sm" variant="outline" className={`${TOUCH} gap-1`} disabled={busy} onClick={() => reject(r)} data-testid={`platform-reject-${r.id}`}><XCircle className="h-4 w-4" aria-hidden="true" /> رفض</Button>
                        </>
                      )}
                    </div>
                  </div>
                  {openRow && (
                    <dl id={`platform-request-details-${r.id}`} className="grid grid-cols-1 gap-2 border-t border-border px-4 py-3 text-sm text-muted-foreground sm:grid-cols-2">
                      <div><dt className="inline">اسم المستخدم: </dt><dd className="inline text-foreground" dir="ltr">{r.username}</dd></div>
                      <div><dt className="inline">تاريخ الطلب: </dt><dd className="inline">{new Date(r.createdAt).toLocaleString(AR_LOCALE)}</dd></div>
                      {r.reviewedAt && <div><dt className="inline">تاريخ المراجعة: </dt><dd className="inline">{new Date(r.reviewedAt).toLocaleString(AR_LOCALE)}</dd></div>}
                      {r.createdTenantId && <div><dt className="inline">Tenant: </dt><dd className="inline" dir="ltr">#{r.createdTenantId}</dd></div>}
                      {r.rejectionReason && <div className="sm:col-span-2"><dt className="inline">سبب الرفض: </dt><dd className="inline">{r.rejectionReason}</dd></div>}
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        </>}
      </main>
    </div>
  );
}
