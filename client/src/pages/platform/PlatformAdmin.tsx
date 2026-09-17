import { useEffect, useState, useCallback } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, LogOut, RefreshCw, CheckCircle2, XCircle } from "lucide-react";

type Status = "pending" | "approved" | "rejected";
interface SignupRequest {
  id: number; ownerName: string; businessName: string; phone: string; email: string;
  username: string; status: Status; rejectionReason: string | null;
  reviewedAt: string | null; createdTenantId: number | null; createdAt: string;
}

const STATUS_LABEL: Record<Status, string> = { pending: "قيد المراجعة", approved: "مقبول", rejected: "مرفوض" };
const STATUS_CLS: Record<Status, string> = {
  pending: "bg-[var(--warning)]/10 text-[var(--warning)] border-[var(--warning)]/30",
  approved: "bg-[var(--success)]/10 text-[var(--success)] border-[var(--success)]/30",
  rejected: "bg-destructive/10 text-destructive border-destructive/30",
};

export default function PlatformAdmin() {
  const [, setLocation] = useLocation();
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Status>("pending");
  const [rows, setRows] = useState<SignupRequest[]>([]);
  const [selected, setSelected] = useState<SignupRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // حارس: لازم جلسة Platform Admin؛ وإلا للدخول.
  useEffect(() => {
    (async () => {
      const res = await fetch("/api/platform/auth/me", { credentials: "include" });
      if (!res.ok) { setLocation("/platform-admin/login"); return; }
      setReady(true);
    })();
  }, [setLocation]);

  const load = useCallback(async (status: Status) => {
    setMsg("");
    const res = await fetch(`/api/platform/signup-requests?status=${status}`, { credentials: "include" });
    if (res.status === 401) { setLocation("/platform-admin/login"); return; }
    const data = await res.json().catch(() => ({ requests: [] }));
    setRows(data.requests ?? []);
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
    <div className="min-h-screen bg-muted/30" dir="rtl">
      <header className="flex items-center justify-between border-b bg-card px-6 py-3">
        <div className="flex items-center gap-2 font-bold"><ShieldCheck className="h-5 w-5 text-primary" /> لوحة إدارة المنصة</div>
        <Button variant="outline" size="sm" onClick={logout} className="gap-1"><LogOut className="h-4 w-4" /> خروج</Button>
      </header>

      <main className="mx-auto max-w-5xl p-6 space-y-4">
        <div className="flex items-center gap-2">
          {(["pending", "approved", "rejected"] as Status[]).map(s => (
            <button key={s} onClick={() => setTab(s)}
              className={`rounded-[var(--radius-brand-pill,9999px)] border px-3 py-1.5 text-sm font-medium ${tab === s ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-muted-foreground hover:bg-muted"}`}>
              {STATUS_LABEL[s]}
            </button>
          ))}
          <Button variant="ghost" size="sm" className="ms-auto gap-1" onClick={() => load(tab)}><RefreshCw className="h-4 w-4" /> تحديث</Button>
        </div>

        {msg && <div className="rounded-lg border bg-card p-3 text-sm">{msg}</div>}

        {rows.length === 0 ? (
          <Card><CardContent className="py-10 text-center text-muted-foreground">لا توجد طلبات في هذه الحالة.</CardContent></Card>
        ) : (
          <div className="space-y-2">
            {rows.map(r => (
              <Card key={r.id} className="cursor-pointer" onClick={() => setSelected(selected?.id === r.id ? null : r)}>
                <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
                  <div>
                    <p className="font-semibold text-foreground">{r.businessName}</p>
                    <p className="text-sm text-muted-foreground">{r.ownerName} · {r.email} · {r.phone}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className={`border ${STATUS_CLS[r.status]}`}>{STATUS_LABEL[r.status]}</Badge>
                    {r.status === "pending" && (
                      <>
                        <Button size="sm" className="gap-1" disabled={busy} onClick={e => { e.stopPropagation(); approve(r); }}><CheckCircle2 className="h-4 w-4" /> قبول</Button>
                        <Button size="sm" variant="outline" className="gap-1" disabled={busy} onClick={e => { e.stopPropagation(); reject(r); }}><XCircle className="h-4 w-4" /> رفض</Button>
                      </>
                    )}
                  </div>
                  {selected?.id === r.id && (
                    <div className="w-full border-t pt-3 text-sm text-muted-foreground grid grid-cols-2 gap-2">
                      <div>اسم المستخدم: <span className="text-foreground" dir="ltr">{r.username}</span></div>
                      <div>تاريخ الطلب: {new Date(r.createdAt).toLocaleString("ar-EG")}</div>
                      {r.reviewedAt && <div>تاريخ المراجعة: {new Date(r.reviewedAt).toLocaleString("ar-EG")}</div>}
                      {r.createdTenantId && <div>Tenant: #{r.createdTenantId}</div>}
                      {r.rejectionReason && <div className="col-span-2">سبب الرفض: {r.rejectionReason}</div>}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
