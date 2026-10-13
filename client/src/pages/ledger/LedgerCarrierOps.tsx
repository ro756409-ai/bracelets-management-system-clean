import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard, StatusBadge } from "@/components/shared";
import { toast } from "sonner";
import { WEEKDAY_LABELS, weekdaysText } from "@shared/ledgerSettings";
import { money } from "./ledgerUi";

/**
 * أقسام ما بعد 0047 في صفحة «تسوية شركة الشحن» — للمالك ومدير الحسابات (السيرفر يرفض نطاق النشاط الواحد فتختفي الأقسام):
 * الكشوف ومواعيد تحويلها، طابور المراجعة الدائم، والإعدادات المُدخلة. قبل 0047 (available=false) تختفي الأقسام بلا خطأ.
 */

export function StatementsSection() {
  const list = trpc.ledger.carrier.statements.useQuery(undefined, { retry: false });
  if (list.error || !list.data?.length) return null;
  return (
    <SectionCard title="الكشوف المسوّاة" testId="carrier-statements">
      <ul className="divide-y divide-border text-sm">
        {list.data.map((s: any) => (
          <li key={s.statementRef} className="flex flex-wrap items-center justify-between gap-2 py-2" data-testid={`statement-${s.statementRef}`}>
            <span><b dir="ltr">{s.statementRef}</b> · {s.statementDate} · {s.lines} سطر</span>
            <span className="flex items-center gap-2">
              <span className="tabular-nums">{money(s.net)} ج.م</span>
              {s.payoutTransactionId ? <StatusBadge status="paid" label="وصل التحويل" tone="success" size="sm" icon={null} />
                : s.overdue ? <StatusBadge status="overdue" label={`متأخر — كان متوقعًا ${s.expectedPayoutOn}`} tone="danger" size="sm" icon={null} />
                : s.expectedPayoutOn ? <StatusBadge status="waiting" label={`متوقع ${s.expectedPayoutOn}`} tone="info" size="sm" icon={null} />
                : <StatusBadge status="unknown" label="بلا موعد — أيام الصرف غير مُدخلة" tone="warning" size="sm" icon={null} />}
            </span>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}

const SOURCE_LABEL: Record<string, string> = { delivery: "تسليم", settlement: "تسوية", payout: "تحويل" };

export function ReviewsSection() {
  const utils = trpc.useUtils();
  const list = trpc.ledger.carrier.reviews.list.useQuery({ status: "open" }, { retry: false });
  const resolve = trpc.ledger.carrier.reviews.resolve.useMutation();
  const [open, setOpen] = useState<{ id: number; status: "resolved" | "dismissed" } | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (list.error || !list.data?.available) return null;
  const items = list.data.items as any[];
  const run = async () => {
    if (!open || busy) return;
    setBusy(true);
    try { await resolve.mutateAsync({ id: open.id, status: open.status, note: note.trim() }); toast.success(open.status === "resolved" ? "أُغلق العنصر" : "استُبعد العنصر"); setOpen(null); setNote(""); await utils.ledger.carrier.reviews.list.invalidate(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <SectionCard title={`مراجعة الشحن (${items.length})`} testId="carrier-reviews">
      {items.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="reviews-empty">لا عناصر مفتوحة.</p> : (
        <ul className="divide-y divide-border text-sm">
          {items.map(it => (
            <li key={it.id} className="py-2" data-testid={`review-${it.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <StatusBadge status={it.source} label={SOURCE_LABEL[it.source] ?? it.source} tone="warning" size="sm" icon={null} />
                  {it.shipmentId && <span className="ms-2 font-mono text-xs" dir="ltr">{it.shipmentId}</span>}
                  <p className="mt-1 break-words text-xs text-muted-foreground">{it.reason}</p>
                </div>
                <span className="flex gap-2">
                  <Button size="sm" variant="outline" className="min-h-11" onClick={() => { setOpen({ id: it.id, status: "resolved" }); setNote(""); }} data-testid={`review-resolve-${it.id}`}>تمت المعالجة</Button>
                  <Button size="sm" variant="ghost" className="min-h-11" onClick={() => { setOpen({ id: it.id, status: "dismissed" }); setNote(""); }} data-testid={`review-dismiss-${it.id}`}>استبعاد</Button>
                </span>
              </div>
              {open?.id === it.id && (
                <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                  <Input aria-label="سبب الإغلاق" value={note} onChange={e => setNote(e.target.value)} placeholder="ماذا تم؟ (إلزامي)" className="min-h-11" data-testid="review-note" />
                  <Button className="min-h-11" onClick={run} disabled={busy || note.trim().length < 3} data-testid="review-run">تأكيد</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

export function SettingsSection() {
  const utils = trpc.useUtils();
  const list = trpc.ledger.settings.list.useQuery(undefined, { retry: false });
  const set = trpc.ledger.settings.set.useMutation();
  const clear = trpc.ledger.settings.clear.useMutation();
  const [edit, setEdit] = useState<{ key: string; scopeBusinessId: number } | null>(null);
  const [value, setValue] = useState("");
  const [mask, setMask] = useState(0);
  const [busy, setBusy] = useState(false);
  if (list.error || !list.data?.available) return null;
  const { settings, businesses } = list.data as any;
  const scopes = (def: any) => (def.scope === "company" ? [{ id: 0, name: "الشركة" }] : businesses);
  const valueOf = (def: any, scopeId: number) => def.values.find((v: any) => v.scopeBusinessId === scopeId)?.value ?? null;
  const shown = (def: any, v: any) => (v == null ? "غير مُدخل" : def.type === "weekdays" ? weekdaysText(Number(v)) : def.type === "percent" ? `${money(v)}٪` : def.type === "minutes" ? `${v} دقيقة` : `${money(v)} ج.م`);
  const save = async () => {
    if (!edit || busy) return;
    const def = settings.find((s: any) => s.key === edit.key);
    setBusy(true);
    try { await set.mutateAsync({ key: edit.key, scopeBusinessId: edit.scopeBusinessId, value: def.type === "weekdays" ? mask : value.trim() }); toast.success("حُفظ الإعداد"); setEdit(null); await utils.ledger.settings.list.invalidate(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async (key: string, scopeBusinessId: number) => {
    if (busy) return;
    setBusy(true);
    try { await clear.mutateAsync({ key, scopeBusinessId }); toast.success("أصبح الإعداد غير مُدخل"); await utils.ledger.settings.list.invalidate(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <SectionCard title="الإعدادات المُدخلة" testId="ledger-settings">
      <p className="text-xs text-muted-foreground">تُستخدم للمقارنة والتنبيه وموعد التحويل فقط — الكشف الفعلي هو الحقيقة، والإعداد غير المُدخل لا يُخمَّن.</p>
      <ul className="mt-2 divide-y divide-border text-sm">
        {settings.map((def: any) => scopes(def).map((sc: any) => {
          const v = valueOf(def, sc.id);
          const editing = edit?.key === def.key && edit?.scopeBusinessId === sc.id;
          return (
            <li key={`${def.key}:${sc.id}`} className="py-2" data-testid={`setting-${def.key}-${sc.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{def.label}{def.scope === "business" ? ` — ${sc.name}` : ""}: <b className={v == null ? "text-muted-foreground" : ""}>{shown(def, v)}</b></span>
                <span className="flex gap-2">
                  <Button size="sm" variant="outline" className="min-h-11" onClick={() => { setEdit({ key: def.key, scopeBusinessId: sc.id }); setValue(v == null || def.type === "weekdays" ? "" : String(v)); setMask(def.type === "weekdays" ? Number(v ?? 0) : 0); }} data-testid={`setting-edit-${def.key}-${sc.id}`}>تعديل</Button>
                  {v != null && <Button size="sm" variant="ghost" className="min-h-11" onClick={() => remove(def.key, sc.id)}>حذف</Button>}
                </span>
              </div>
              {editing && (
                <div className="mt-2 flex flex-col gap-2 rounded-md border border-border p-3">
                  <p className="text-xs text-muted-foreground">{def.hint}</p>
                  {def.type === "weekdays" ? (
                    <div className="flex flex-wrap gap-2" role="group" aria-label={def.label}>
                      {WEEKDAY_LABELS.map((d, i) => (
                        <label key={d} className="flex min-h-11 items-center gap-1 rounded-md border border-border px-2">
                          <input type="checkbox" checked={Boolean(mask & (1 << i))} onChange={() => setMask(m => m ^ (1 << i))} data-testid={`weekday-${i}`} /> {d}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <div><Label htmlFor="setting-value">{def.label}</Label><Input id="setting-value" inputMode="decimal" value={value} onChange={e => setValue(e.target.value)} className="mt-1 min-h-11" dir="ltr" data-testid="setting-value" /></div>
                  )}
                  <div className="flex gap-2">
                    <Button className="min-h-11" onClick={save} disabled={busy || (def.type === "weekdays" ? mask === 0 : !value.trim())} data-testid="setting-save">حفظ</Button>
                    <Button variant="ghost" className="min-h-11" onClick={() => setEdit(null)}>إلغاء</Button>
                  </div>
                </div>
              )}
            </li>
          );
        }))}
      </ul>
    </SectionCard>
  );
}
