import { useRef, useState } from "react";
import { Search, Loader2, ReceiptText, Undo2, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { StatusBadge, EmptyState, type StatusTone } from "@/components/shared";
import { SUBSCRIPTION_PLANS, SUBSCRIPTION_PLAN_CODES, type SubscriptionPlanCode, type BillingState } from "@shared/billing";
import { AR_LOCALE } from "@/lib/format";

/**
 * فوترة المنصة (/api/platform/billing/*) — عرض حالة اشتراك شركة، تسجيلها في النموذج (قرار انتقال صريح لكل شركة)، تسجيل دفع
 * يدوي بمرجع + دليل، واسترداد بسبب. الكتابة لأدمن فوترة مخوَّل بس (السيرفر بيرفض غيره ويسجّل الرفض) — الواجهة مابتقررش صلاحية.
 * مفتاح منع التكرار بيتولّد مرة لكل نموذج دفع، فإعادة الإرسال بعد انقطاع = نفس الدفع.
 */
type Overview = {
  tenantId: number; enrolled: boolean;
  status: { state: BillingState; paidUntil: string | null; graceEndsAt: string | null } | null;
  periods: Array<{ id: number; paymentId: number; startsAt: string; endsAt: string; voidedAt: string | null }>;
  payments: Array<{ id: number; planCode: SubscriptionPlanCode; amountMinor: number; provider: string; status: string; paymentReference: string | null; createdAt: string; succeededAt: string | null }>;
};
const STATE_LABEL: Record<BillingState, string> = { pending_payment: "في انتظار الدفع", active: "فعّال", grace: "سماح 72 ساعة", expired: "منتهي" };
const STATE_TONE: Record<BillingState, StatusTone> = { pending_payment: "warning", active: "success", grace: "amber", expired: "danger" };
const PLAN_LABEL: Record<SubscriptionPlanCode, string> = { month_1: "شهر", month_5: "5 شهور", month_12: "سنة" };
const TOUCH = "min-h-11 md:min-h-9";
const fmtDate = (d: string | null) => (d ? new Date(d).toLocaleString(AR_LOCALE, { dateStyle: "medium", timeStyle: "short" }) : "—");
const newKey = () => `pa-${crypto.randomUUID()}`;

async function call(path: string, body?: object) {
  const res = await fetch(path, body
    ? { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { credentials: "include" });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export function PlatformBillingPanel({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [tenantInput, setTenantInput] = useState("");
  const [ov, setOv] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [form, setForm] = useState({ planCode: "month_1" as SubscriptionPlanCode, paymentReference: "", evidenceUrl: "", note: "" });
  const key = useRef(newKey());

  // keepMsg: إعادة التحميل بعد كتابة ناجحة ماتمسحش رسالة النجاح.
  const load = async (id = ov?.tenantId ?? Number(tenantInput), keepMsg = false) => {
    if (!Number.isInteger(id) || id <= 0) { setMsg({ tone: "err", text: "اكتب رقم شركة صحيح" }); return; }
    setLoading(true); if (!keepMsg) setMsg(null);
    try {
      const r = await call(`/api/platform/billing/tenants/${id}`);
      if (r.status === 401) return onUnauthorized();
      if (!r.ok) { setOv(null); setMsg({ tone: "err", text: r.data.error || "تعذّر التحميل" }); return; }
      setOv(r.data as Overview);
    } finally { setLoading(false); }
  };

  const write = async (path: string, body: object, okText: string, after?: () => void) => {
    setBusy(true); setMsg(null);
    try {
      const r = await call(path, body);
      if (r.status === 401) return onUnauthorized();
      if (!r.ok || !r.data.success) { setMsg({ tone: "err", text: r.data.error || "تعذّر التنفيذ" }); return; }
      setMsg({ tone: "ok", text: r.data.replay ? "الدفع ده متسجّل بالفعل — مفيش تكرار." : okText });
      after?.();
      await load(undefined, true);
    } finally { setBusy(false); }
  };

  const enroll = () => {
    if (!ov || !confirm(`تسجيل الشركة #${ov.tenantId} في نظام الاشتراك؟ بعد التسجيل (والعلم مفعّل) الشركة هتبقى «في انتظار الدفع» لحد أول دفع.`)) return;
    void write(`/api/platform/billing/tenants/${ov.tenantId}/enroll`, {}, "تم التسجيل.");
  };
  const recordPayment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!ov) return;
    const p = SUBSCRIPTION_PLANS[form.planCode];
    if (!confirm(`تسجيل دفع ${PLAN_LABEL[form.planCode]} بمبلغ ${p.amount} ج.م للشركة #${ov.tenantId} بالمرجع «${form.paymentReference.trim()}»؟ الاشتراك هيتفعّل فورًا.`)) return;
    void write(`/api/platform/billing/tenants/${ov.tenantId}/manual-payment`,
      { planCode: form.planCode, idempotencyKey: key.current, paymentReference: form.paymentReference, evidenceUrl: form.evidenceUrl || undefined, note: form.note || undefined },
      "تم تسجيل الدفع وتفعيل الفترة.",
      () => { key.current = newKey(); setForm(f => ({ ...f, paymentReference: "", evidenceUrl: "", note: "" })); });
  };
  const refund = (paymentId: number) => {
    const reason = prompt("سبب الاسترداد (إلزامي، 5 حروف على الأقل):")?.trim();
    if (!reason) return;
    if (!confirm(`تأكيد استرداد الدفع #${paymentId}؟ الفترة المرتبطة بيه هتتلغي.`)) return;
    void write(`/api/platform/billing/payments/${paymentId}/refund`, { reason }, "تم الاسترداد وإلغاء الفترة.");
  };

  return (
    <section className="space-y-4" aria-labelledby="billing-title" data-testid="platform-billing">
      <h2 id="billing-title" className="text-lg font-bold">فوترة الاشتراك</h2>
      <form role="search" className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); void load(Number(tenantInput)); }}>
        <div>
          <Label htmlFor="billing-tenant">رقم الشركة (Tenant)</Label>
          <Input id="billing-tenant" inputMode="numeric" dir="ltr" value={tenantInput} onChange={e => setTenantInput(e.target.value.replace(/\D/g, ""))} className="mt-1 min-h-11 w-40" />
        </div>
        <Button type="submit" className={`${TOUCH} gap-1`} disabled={loading}>{loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Search className="h-4 w-4" aria-hidden="true" />} عرض</Button>
      </form>

      {msg && <div role={msg.tone === "err" ? "alert" : "status"} className={`rounded-[var(--radius-brand-md)] border p-3 text-sm ${msg.tone === "err" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-card"}`} data-testid="billing-msg">{msg.text}</div>}

      {!ov ? (
        <EmptyState title="اختار شركة لعرض اشتراكها" description="الشركات الحالية مش داخلة نظام الاشتراك تلقائيًا — التسجيل قرار صريح لكل شركة." />
      ) : (
        <div className="space-y-4">
          <div className="rounded-[var(--radius-brand-md)] border border-border bg-card p-4" data-testid="billing-overview">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-semibold">الشركة <span dir="ltr">#{ov.tenantId}</span></p>
              {ov.enrolled && ov.status
                ? <StatusBadge status={ov.status.state} label={STATE_LABEL[ov.status.state]} tone={STATE_TONE[ov.status.state]} />
                : <StatusBadge status="legacy" label="غير مسجّلة — سلوكها الحالي" tone="neutral" />}
            </div>
            {ov.enrolled && ov.status ? (
              <dl className="mt-3 grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
                <div><dt className="inline">مدفوع لحد: </dt><dd className="inline text-foreground">{fmtDate(ov.status.paidUntil)}</dd></div>
                <div><dt className="inline">نهاية السماح: </dt><dd className="inline text-foreground">{fmtDate(ov.status.graceEndsAt)}</dd></div>
              </dl>
            ) : (
              <Button className={`${TOUCH} mt-3 gap-1`} onClick={enroll} disabled={busy} data-testid="billing-enroll"><UserPlus className="h-4 w-4" aria-hidden="true" /> تسجيل في نظام الاشتراك</Button>
            )}
          </div>

          {ov.enrolled && (
            <form onSubmit={recordPayment} className="space-y-3 rounded-[var(--radius-brand-md)] border border-border bg-card p-4" data-testid="billing-manual-form">
              <h3 className="flex items-center gap-2 font-semibold"><ReceiptText className="h-4 w-4" aria-hidden="true" /> تسجيل دفع يدوي</h3>
              <fieldset className="flex flex-wrap gap-2" aria-label="الخطة">
                {SUBSCRIPTION_PLAN_CODES.map(c => (
                  <label key={c} className={`inline-flex ${TOUCH} cursor-pointer items-center gap-2 rounded-[var(--radius-brand-md)] border px-3 text-sm ${form.planCode === c ? "border-primary bg-accent" : "border-border"}`}>
                    <input type="radio" name="plan" value={c} checked={form.planCode === c} onChange={() => setForm(f => ({ ...f, planCode: c }))} />
                    {PLAN_LABEL[c]} — {SUBSCRIPTION_PLANS[c].amount} ج.م
                  </label>
                ))}
              </fieldset>
              <div>
                <Label htmlFor="billing-ref">مرجع الدفع (رقم التحويل/العملية) *</Label>
                <Input id="billing-ref" required minLength={3} maxLength={120} dir="ltr" value={form.paymentReference} onChange={e => setForm(f => ({ ...f, paymentReference: e.target.value }))} className="mt-1 min-h-11" />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="billing-evidence">رابط الدليل (https)</Label>
                  <Input id="billing-evidence" type="url" dir="ltr" placeholder="https://" value={form.evidenceUrl} onChange={e => setForm(f => ({ ...f, evidenceUrl: e.target.value }))} className="mt-1 min-h-11" />
                </div>
                <div>
                  <Label htmlFor="billing-note">وصف الدليل (لو مفيش رابط، 10 حروف على الأقل)</Label>
                  <Input id="billing-note" value={form.note} onChange={e => setForm(f => ({ ...f, note: e.target.value }))} className="mt-1 min-h-11" />
                </div>
              </div>
              <Button type="submit" className={`${TOUCH}`} disabled={busy || form.paymentReference.trim().length < 3 || (!form.evidenceUrl && form.note.trim().length < 10)} data-testid="billing-record">تسجيل الدفع وتفعيل الفترة</Button>
            </form>
          )}

          {ov.enrolled && (
            <div className="overflow-x-auto rounded-[var(--radius-brand-md)] border border-border bg-card">
              <table className="w-full min-w-[640px] text-sm" data-testid="billing-payments">
                <caption className="p-3 text-start font-semibold">المدفوعات</caption>
                <thead className="bg-muted/60 text-xs text-muted-foreground">
                  <tr><th scope="col" className="px-3 py-2 text-start">#</th><th scope="col" className="px-3 py-2 text-start">الخطة</th><th scope="col" className="px-3 py-2 text-start">المبلغ</th><th scope="col" className="px-3 py-2 text-start">الحالة</th><th scope="col" className="px-3 py-2 text-start">المرجع</th><th scope="col" className="px-3 py-2 text-start">التاريخ</th><th scope="col" className="px-3 py-2"><span className="sr-only">إجراء</span></th></tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {ov.payments.length === 0 && <tr><td colSpan={7} className="p-3 text-muted-foreground">مفيش مدفوعات.</td></tr>}
                  {ov.payments.map(p => (
                    <tr key={p.id}>
                      <td className="px-3 py-2" dir="ltr">{p.id}</td>
                      <td className="px-3 py-2">{PLAN_LABEL[p.planCode]}</td>
                      <td className="px-3 py-2 tabular-nums">{(p.amountMinor / 100).toLocaleString(AR_LOCALE)} ج.م</td>
                      <td className="px-3 py-2"><StatusBadge status={p.status} label={p.status} tone={p.status === "succeeded" ? "success" : p.status === "refunded" ? "neutral" : p.status === "failed" ? "danger" : "warning"} size="sm" /></td>
                      <td className="px-3 py-2" dir="ltr">{p.paymentReference ?? "—"}</td>
                      <td className="px-3 py-2">{fmtDate(p.succeededAt ?? p.createdAt)}</td>
                      <td className="px-3 py-2">{p.status === "succeeded" && <Button size="sm" variant="outline" className={`${TOUCH} gap-1`} disabled={busy} onClick={() => refund(p.id)} data-testid={`billing-refund-${p.id}`}><Undo2 className="h-4 w-4" aria-hidden="true" /> استرداد</Button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
