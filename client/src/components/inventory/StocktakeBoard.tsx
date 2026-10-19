import { useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { usePermission } from "@/hooks/usePermission";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { variantLabel, type CatalogVariant } from "@/components/orders/OrderItemsEditor";
import { createInFlightGuard } from "@/components/orders/confirmGuard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  SectionCard, StatCard, StatusBadge, StickyActionBar, ResponsiveDataTable, EmptyState, ErrorState, LoadingSkeleton, OfflineState, UNAVAILABLE_LABEL, type Column,
} from "@/components/shared";
import { ArrowRight, CheckCircle2, ClipboardCheck, Plus, Send, Save } from "lucide-react";
import { toast } from "sonner";
import { AR_LOCALE } from "@/lib/format";

/**
 * لوحة الجرد للمالك/المدير/موظف المخزن (المرحلة 7C) — **نفس الـendpoints ونفس التدفق** الذي يستخدمه
 * مكوّن المحاسب `AccStocktake` (لم يُمس): بدء جلسة ← عدّ (countedQuantity فقط، لا تحريك للرصيد) ←
 * إرسال للاعتماد ← اعتماد صريح (inventory_costing.approve) يحرّك المخزون. لا نظام جرد موازٍ: لا منطق
 * أعمال هنا، فقط عرض Copper Signature: الكمية المسجلة/الفعلية/الفرق/حالة السطر (مطابق/زيادة/عجز)،
 * ملخص قبل الاعتماد، وحوار تأكيد بدل window.confirm. سبب الفرق غير مطلوب حاليًا على السيرفر
 * (stocktakeLineUpdate لا يقبل سببًا) فلا حقل له.
 */

const STATUS: Record<string, { label: string; tone: "neutral" | "warning" | "success" | "danger" }> = {
  draft: { label: "مسودة", tone: "neutral" },
  pending_approval: { label: "بانتظار الاعتماد", tone: "warning" },
  approved: { label: "معتمد", tone: "success" },
  cancelled: { label: "ملغي", tone: "danger" },
};
const TOUCH = "min-h-11 md:min-h-9";
const money = (n: unknown) => Number(n ?? 0).toLocaleString(AR_LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type LineState = "matched" | "surplus" | "shortage";
/** حالة السطر من الفرق المحسوب على السيرفر (differenceQuantity) — لا حساب جديد. */
export function lineState(differenceQuantity: number): LineState {
  if (differenceQuantity > 0) return "surplus";
  if (differenceQuantity < 0) return "shortage";
  return "matched";
}
const LINE_STATE: Record<LineState, { label: string; tone: "neutral" | "success" | "danger" }> = {
  matched: { label: "مطابق", tone: "success" },
  surplus: { label: "زيادة", tone: "neutral" },
  shortage: { label: "عجز", tone: "danger" },
};

export default function StocktakeBoard({ businessId }: { businessId: number }) {
  const [openId, setOpenId] = useState<number | null>(null);
  if (openId != null) {
    return <StocktakeSession businessId={businessId} stocktakeId={openId} onBack={() => setOpenId(null)} />;
  }
  return <StocktakeList businessId={businessId} onOpen={setOpenId} onCreated={setOpenId} />;
}

// ───────────────────────── القائمة + بدء جلسة ─────────────────────────

function StocktakeList({ businessId, onOpen, onCreated }: { businessId: number; onOpen: (id: number) => void; onCreated: (id: number) => void }) {
  const utils = trpc.useUtils();
  const online = useOnlineStatus();
  const canManage = usePermission("inventory_costing.manage");
  const warehouses = trpc.businesses.warehouses.useQuery({ businessId });
  const list = trpc.accountingV2.stocktakeList.useQuery({ businessId });
  const [warehouseId, setWarehouseId] = useState("");
  const createGuard = useRef(createInFlightGuard<string>()).current;

  const create = trpc.accountingV2.stocktakeCreate.useMutation({
    onSuccess: async (r: any) => {
      toast.success("اتبدت جلسة الجرد");
      await utils.accountingV2.stocktakeList.invalidate();
      if (r?.stocktakeId) onCreated(r.stocktakeId);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const ws: any[] = (warehouses.data ?? []).filter((w: any) => w.isActive);
  const rows: any[] = list.data ?? [];
  const whName = (id: number) => ws.find(w => w.id === id)?.name ?? `#${id}`;

  const start = () => {
    if (!warehouseId) return;
    createGuard.run("create", create.isPending, done => create.mutate({ businessId, warehouseId: Number(warehouseId) }, { onSettled: done }));
  };

  const columns: Column<any>[] = [
    { id: "date", header: "التاريخ", cell: r => <span className="whitespace-nowrap tabular-nums">{new Date(r.createdAt).toLocaleDateString(AR_LOCALE)}</span>, alwaysVisible: true },
    { id: "warehouse", header: "المخزن", cell: r => whName(r.warehouseId) },
    { id: "status", header: "الحالة", cell: r => <StatusBadge status={r.status} label={STATUS[r.status]?.label ?? r.status} tone={STATUS[r.status]?.tone ?? "neutral"} size="sm" /> },
    { id: "by", header: "بواسطة", cell: r => <span className="text-muted-foreground">{r.createdByName}</span> },
    { id: "open", header: "", sticky: "end", alwaysVisible: true, cell: r => <Button type="button" size="sm" variant="outline" className={`${TOUCH} gap-1`} onClick={() => onOpen(r.id)} data-testid={`stocktake-open-${r.id}`}>فتح <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Button> },
  ];

  return (
    <div className="space-y-4" data-testid="stocktake-list">
      {!online && <OfflineState onRetry={() => list.refetch()} className="py-6" />}
      {canManage ? (
        <SectionCard title="بدء جردة جديدة" icon={<ClipboardCheck className="h-4 w-4" aria-hidden="true" />} testId="stocktake-start">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div>
              <Label htmlFor="st-warehouse">المخزن <span className="text-destructive">*</span></Label>
              <Select value={warehouseId} onValueChange={setWarehouseId} disabled={warehouses.isLoading}>
                <SelectTrigger id="st-warehouse" className={`mt-1 ${TOUCH}`} data-testid="stocktake-warehouse"><SelectValue placeholder={warehouses.isLoading ? "جارٍ التحميل…" : ws.length ? "— اختار —" : "مفيش مخازن نشطة"} /></SelectTrigger>
                <SelectContent>{ws.map(w => <SelectItem key={w.id} value={String(w.id)} className={TOUCH}>{w.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <Button type="button" className={`${TOUCH} gap-1`} disabled={!warehouseId || create.isPending} onClick={start} aria-busy={create.isPending || undefined} data-testid="stocktake-create">
              <Plus className="h-4 w-4" aria-hidden="true" /> {create.isPending ? "جاري البدء..." : "بدء الجرد"}
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            بتتاخد لقطة لأرصدة المخزن دلوقتي، وتدخل العدد الفعلي لكل صنف. الاعتماد وتحريك المخزون خطوة صريحة منفصلة — العدّ وحده لا يغيّر الرصيد.
          </p>
        </SectionCard>
      ) : (
        <p className="rounded-[var(--radius-brand-md)] border border-border bg-muted/40 p-3 text-sm text-muted-foreground" data-testid="stocktake-readonly">بدء الجرد والعدّ يتطلبان صلاحية إدارة تكلفة المخزون — العرض متاح لك.</p>
      )}

      <SectionCard title="جلسات الجرد" flush testId="stocktake-sessions">
        <ResponsiveDataTable<any>
          rows={rows}
          columns={columns}
          rowKey={r => r.id}
          loading={list.isLoading}
          error={list.error ? (list.error.message || "تعذّر تحميل جلسات الجرد") : null}
          onRetry={() => list.refetch()}
          empty={{ title: "مفيش جلسات جرد", description: canManage ? "ابدأ أول جردة من الأعلى." : undefined }}
          cardsBelow="md"
          mobileRow={r => (
            <article className="flex items-center justify-between gap-3 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`stocktake-card-${r.id}`}>
              <div className="min-w-0">
                <p className="font-semibold">{whName(r.warehouseId)}</p>
                <p className="text-xs tabular-nums text-muted-foreground">{new Date(r.createdAt).toLocaleDateString(AR_LOCALE)} · {r.createdByName}</p>
                <div className="mt-1"><StatusBadge status={r.status} label={STATUS[r.status]?.label ?? r.status} tone={STATUS[r.status]?.tone ?? "neutral"} size="sm" /></div>
              </div>
              <Button type="button" variant="outline" className="min-h-11 shrink-0 gap-1" onClick={() => onOpen(r.id)} data-testid={`stocktake-open-m-${r.id}`}>فتح <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" /></Button>
            </article>
          )}
        />
      </SectionCard>
    </div>
  );
}

// ───────────────────────── جلسة واحدة (عدّ) ─────────────────────────

function StocktakeSession({ businessId, stocktakeId, onBack }: { businessId: number; stocktakeId: number; onBack: () => void }) {
  const utils = trpc.useUtils();
  const online = useOnlineStatus();
  const session = trpc.accountingV2.stocktakeGet.useQuery({ businessId, stocktakeId }, { retry: false });
  const { data: products } = trpc.products.list.useQuery({ businessIds: [businessId] });
  const { data: variants } = trpc.variants.all.useQuery({ businessIds: [businessId] });
  const canManage = usePermission("inventory_costing.manage");
  // الاعتماد بيحرّك المخزون → على inventory_costing.approve. المحاسب معاهوش الصلاحية دي،
  // فالزر يختفي عنه — والباك بيرفضها كمان (مفيش اعتماد على إخفاء الواجهة).
  const canApprove = usePermission("inventory_costing.approve");

  const productName = (id: number) => (products ?? []).find((p: any) => p.id === id)?.name ?? `#${id}`;
  const variantName = (id?: number | null) => {
    if (id == null) return null;
    const v = ((variants ?? []) as CatalogVariant[]).find(x => x.id === id);
    return v ? variantLabel(v) : `#${id}`;
  };

  /** مسودّات العدّ لكل سطر (قبل الحفظ) + أخطاء لكل سطر */
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [lineErrors, setLineErrors] = useState<Record<number, string>>({});
  const [savingLine, setSavingLine] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<"submit" | "approve" | null>(null);
  const submitGuard = useRef(createInFlightGuard<string>()).current;

  const lineUpdate = trpc.accountingV2.stocktakeLineUpdate.useMutation({
    onSuccess: async (_r: any, vars: any) => {
      await utils.accountingV2.stocktakeGet.invalidate({ businessId, stocktakeId });
      setDrafts(d => { const n = { ...d }; delete n[vars.lineId]; return n; });
    },
    onError: (e: any, vars: any) => { toast.error(e.message); setLineErrors(le => ({ ...le, [vars.lineId]: e.message })); },
    onSettled: () => setSavingLine(null),
  });
  const submit = trpc.accountingV2.stocktakeSubmit.useMutation({
    onSuccess: async () => {
      toast.success("اتبعت للاعتماد");
      setConfirm(null);
      await Promise.all([
        utils.accountingV2.stocktakeGet.invalidate({ businessId, stocktakeId }),
        utils.accountingV2.stocktakeList.invalidate(),
      ]);
    },
    onError: (e: any) => toast.error(e.message),
  });
  const approve = trpc.accountingV2.stocktakeApprove.useMutation({
    onSuccess: async () => {
      toast.success("تم الاعتماد — العجز اتسجّل خسارة مخزون والزيادة ربح مخزون، والمخزون اتحرّك.");
      setConfirm(null);
      await Promise.all([
        utils.accountingV2.stocktakeGet.invalidate({ businessId, stocktakeId }),
        utils.accountingV2.stocktakeList.invalidate(),
      ]);
    },
    onError: (e: any) => toast.error(e.message),
  });

  const data = session.data;
  const lines: any[] = data?.lines ?? [];
  const isDraft = data?.status === "draft";
  const isPendingApproval = data?.status === "pending_approval";
  const anyPending = lineUpdate.isPending || submit.isPending || approve.isPending;

  // الملخص من أرقام السيرفر نفسها (differenceQuantity / differenceValue) — لا تسوية مالية مخترعة
  const totals = useMemo(() => lines.reduce((s, l) => {
    const v = Number(l.differenceValue);
    const st = lineState(Number(l.differenceQuantity));
    return {
      shortage: s.shortage + (st === "shortage" ? -v : 0),
      surplus: s.surplus + (st === "surplus" ? v : 0),
      matched: s.matched + (st === "matched" ? 1 : 0),
      surplusCount: s.surplusCount + (st === "surplus" ? 1 : 0),
      shortageCount: s.shortageCount + (st === "shortage" ? 1 : 0),
    };
  }, { shortage: 0, surplus: 0, matched: 0, surplusCount: 0, shortageCount: 0 }), [lines]);

  /** حفظ عدّ سطر: رقم صحيح ≥ 0 — نفس قاعدة AccStocktake والسيرفر (int().min(0)) */
  const commit = (line: any) => {
    const raw = drafts[line.id];
    if (raw == null) return;
    const counted = Number(raw);
    if (raw.trim() === "" || !Number.isInteger(counted) || counted < 0) { setLineErrors(le => ({ ...le, [line.id]: "رقم صحيح مش سالب" })); return; }
    setLineErrors(le => { const n = { ...le }; delete n[line.id]; return n; });
    if (counted === line.countedQuantity) { setDrafts(d => { const n = { ...d }; delete n[line.id]; return n; }); return; }
    setSavingLine(line.id);
    lineUpdate.mutate({ businessId, stocktakeId, lineId: line.id, countedQuantity: counted });
  };
  const unsavedCount = Object.keys(drafts).length;

  if (session.isLoading) return <LoadingSkeleton variant="form" rows={6} />;
  if (session.isError) return <ErrorState message={(session.error as any)?.message || "تعذّر تحميل جلسة الجرد"} onRetry={() => session.refetch()} />;
  if (!data) return <EmptyState title="الجلسة مش موجودة" action={<Button type="button" variant="outline" className={TOUCH} onClick={onBack}>رجوع</Button>} />;
  const st = STATUS[data.status] ?? { label: data.status, tone: "neutral" as const };

  const countedCell = (l: any) => {
    const draft = drafts[l.id];
    const dirty = draft != null;
    const error = lineErrors[l.id];
    const id = `st-count-${l.id}`;
    if (!isDraft || !canManage) return <span className="tabular-nums" data-testid={`st-counted-${l.id}`}>{l.countedQuantity}</span>;
    return (
      <div className="flex items-center gap-1">
        <Input
          id={id} type="number" inputMode="numeric" min="0" step="1" dir="ltr" aria-label={`العدد الفعلي — ${productName(l.productId)}`}
          value={dirty ? draft : String(l.countedQuantity)}
          onChange={e => setDrafts(d => ({ ...d, [l.id]: e.target.value }))}
          onBlur={() => commit(l)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commit(l); } }}
          disabled={savingLine === l.id}
          aria-invalid={!!error || undefined} aria-describedby={error ? `${id}-error` : undefined}
          className={`${TOUCH} w-24 text-center tabular-nums ${dirty ? "border-[var(--warning)]" : ""}`}
          data-testid={`st-count-input-${l.id}`}
        />
        <Button type="button" size="sm" variant={dirty ? "default" : "ghost"} className={`${TOUCH} min-w-11 px-2 md:min-w-9`} onClick={() => commit(l)} disabled={!dirty || savingLine === l.id} aria-label="حفظ العدّ" data-testid={`st-count-save-${l.id}`}>
          <Save className="h-4 w-4" aria-hidden="true" />
        </Button>
        {error && <p id={`${id}-error`} className="text-xs text-destructive" role="alert">{error}</p>}
      </div>
    );
  };
  const diffCell = (l: any) => {
    const d = Number(l.differenceQuantity);
    const s = lineState(d);
    return <span className={`font-semibold tabular-nums ${s === "shortage" ? "text-destructive" : s === "surplus" ? "text-[var(--info)]" : "text-muted-foreground"}`} data-testid={`st-diff-${l.id}`}>{d > 0 ? `+${d}` : d}</span>;
  };
  const stateBadge = (l: any) => { const s = lineState(Number(l.differenceQuantity)); return <StatusBadge status={s} label={LINE_STATE[s].label} tone={LINE_STATE[s].tone} size="sm" />; };

  const columns: Column<any>[] = [
    { id: "item", header: "الصنف", alwaysVisible: true, cell: l => <div className="min-w-0"><p className="font-medium">{productName(l.productId)}</p>{variantName(l.variantId) && <p className="text-xs text-[var(--info)]">{variantName(l.variantId)}</p>}</div> },
    { id: "system", header: "الكمية المسجلة", numeric: true, cell: l => <span className="tabular-nums text-muted-foreground">{l.systemQuantity}</span> },
    { id: "counted", header: "الكمية الفعلية", numeric: true, cell: countedCell },
    { id: "diff", header: "الفرق", numeric: true, cell: diffCell },
    { id: "state", header: "حالة السطر", cell: stateBadge },
    { id: "unitCost", header: "تكلفة الوحدة", numeric: true, cell: l => <span className="tabular-nums text-muted-foreground">{money(l.unitCostSnapshot)}</span> },
    { id: "value", header: "قيمة الفرق", numeric: true, cell: l => <span className="tabular-nums">{money(l.differenceValue)}</span> },
  ];

  return (
    <div className="space-y-4 pb-[120px] md:pb-0" data-testid="stocktake-session">
      {!online && <OfflineState onRetry={() => session.refetch()} className="py-6" />}
      <SectionCard
        title={<span className="flex flex-wrap items-center gap-2">جردة #{data.id} <StatusBadge status={data.status} label={st.label} tone={st.tone} size="sm" /></span>}
        description={`${new Date(data.createdAt).toLocaleDateString(AR_LOCALE)} · ${data.createdByName} · لقطة الأرصدة وقت بدء الجرد`}
        icon={<ClipboardCheck className="h-4 w-4" aria-hidden="true" />}
        action={<Button type="button" variant="ghost" className={`${TOUCH} gap-1`} onClick={onBack} data-testid="stocktake-back"><ArrowRight className="h-4 w-4" aria-hidden="true" /> رجوع</Button>}
        testId="stocktake-header"
      >
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="stocktake-summary">
          <StatCard label="الأسطر" value={lines.length.toLocaleString(AR_LOCALE)} hint="من لقطة الجلسة" />
          <StatCard label="مطابق" value={totals.matched.toLocaleString(AR_LOCALE)} tone="success" hint="الفرق = 0" />
          <StatCard label="زيادة" value={totals.surplusCount.toLocaleString(AR_LOCALE)} tone="info" hint={`${money(totals.surplus)} ج.م`} />
          <StatCard label="عجز" value={totals.shortageCount.toLocaleString(AR_LOCALE)} tone={totals.shortageCount > 0 ? "danger" : "default"} hint={`${money(totals.shortage)} ج.م`} />
          <StatCard label="غير محفوظ" value={unsavedCount.toLocaleString(AR_LOCALE)} tone={unsavedCount > 0 ? "warning" : "default"} hint={unsavedCount > 0 ? "احفظ العدّ (Enter أو زر الحفظ)" : "كل العدّ محفوظ"} />
        </div>
      </SectionCard>

      <SectionCard title="الأسطر" description={isDraft ? "اكتب العدد الفعلي ثم احفظ السطر — العدّ لا يغيّر الرصيد؛ الاعتماد خطوة صريحة." : "الجلسة للعرض فقط بعد الإرسال."} flush testId="stocktake-lines">
        <ResponsiveDataTable<any>
          rows={lines}
          columns={columns}
          rowKey={l => l.id}
          empty={{ title: "مفيش أصناف في المخزن ده." }}
          cardsBelow="md"
          mobileRow={l => {
            const s = lineState(Number(l.differenceQuantity));
            return (
              <article className={`space-y-2 rounded-[var(--radius-brand-md)] border bg-card p-3 ${s === "shortage" ? "border-destructive/40" : s === "surplus" ? "border-[var(--info)]/40" : "border-border"}`} data-testid={`st-card-${l.id}`} data-state={s}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><p className="font-semibold">{productName(l.productId)}</p>{variantName(l.variantId) && <p className="text-sm text-[var(--info)]">{variantName(l.variantId)}</p>}</div>
                  {stateBadge(l)}
                </div>
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  <div><dt className="text-muted-foreground">المسجلة</dt><dd className="text-base tabular-nums">{l.systemQuantity}</dd></div>
                  <div><dt className="text-muted-foreground">الفرق</dt><dd className="text-base">{diffCell(l)}</dd></div>
                  <div><dt className="text-muted-foreground">قيمة الفرق</dt><dd className="tabular-nums">{money(l.differenceValue)}</dd></div>
                </dl>
                <div><p className="mb-1 text-xs text-muted-foreground">الكمية الفعلية</p>{countedCell(l)}</div>
              </article>
            );
          }}
        />
        <p className="p-4 pt-3 text-xs text-muted-foreground">
          الأرقام لقطة وقت بدء الجرد. عند الاعتماد يتحرّك المخزون بفرق كل صنف على رصيده الحالي: العجز يُسجَّل خسارة مخزون والزيادة ربح مخزون. بعد الاعتماد الجلسة للعرض فقط.
        </p>
      </SectionCard>

      {(isDraft || (isPendingApproval && canApprove)) && canManage !== undefined && (
        <StickyActionBar
          className="fixed inset-x-0 bottom-[var(--bottom-nav-h,0px)] z-30 mx-0 mt-0 mb-0 px-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] md:static md:mx-0 md:mt-4 md:border-0 md:bg-transparent md:px-0 md:pb-0 md:backdrop-blur-0"
          info={<span className="text-xs text-muted-foreground">{totals.shortageCount} عجز · {totals.surplusCount} زيادة · {totals.matched} مطابق{unsavedCount > 0 ? ` · ${unsavedCount} غير محفوظ` : ""}</span>}
        >
          {isDraft && canManage && (
            <Button type="button" className={`${TOUCH} gap-1`} disabled={anyPending || unsavedCount > 0} onClick={() => setConfirm("submit")} data-testid="stocktake-submit">
              <Send className="h-4 w-4" aria-hidden="true" /> إرسال للاعتماد
            </Button>
          )}
          {isPendingApproval && canApprove && (
            <Button type="button" className={`${TOUCH} gap-1`} disabled={anyPending} onClick={() => setConfirm("approve")} data-testid="stocktake-approve">
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> اعتماد وتحريك المخزون
            </Button>
          )}
        </StickyActionBar>
      )}

      {/* ملخص قبل الإرسال/الاعتماد — الفروق كلها ظاهرة؛ لا شيء يُنفَّذ بمجرد تغيير حقل */}
      <Dialog open={confirm != null} onOpenChange={o => { if (!o && !anyPending) setConfirm(null); }}>
        <DialogContent className="max-w-md" data-testid="stocktake-confirm-dialog">
          <DialogHeader>
            <DialogTitle>{confirm === "approve" ? "اعتماد الجرد وتحريك المخزون" : "إرسال الجرد للاعتماد"}</DialogTitle>
            <DialogDescription>{confirm === "approve" ? "هيحرّك المخزون ويسجّل العجز كخسارة والزيادة كربح، ومايتراجعش." : "بعد الإرسال مايتعدّلش العدّ."}</DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-3 gap-2 text-center text-sm">
            <div className="rounded-[var(--radius-brand-md)] border border-border p-2"><dt className="text-xs text-muted-foreground">مطابق</dt><dd className="font-bold tabular-nums">{totals.matched}</dd></div>
            <div className="rounded-[var(--radius-brand-md)] border border-[var(--info)]/40 p-2"><dt className="text-xs text-muted-foreground">زيادة</dt><dd className="font-bold tabular-nums">{totals.surplusCount}<span className="block text-xs font-normal">{money(totals.surplus)} ج.م</span></dd></div>
            <div className="rounded-[var(--radius-brand-md)] border border-destructive/40 p-2"><dt className="text-xs text-muted-foreground">عجز</dt><dd className="font-bold tabular-nums text-destructive">{totals.shortageCount}<span className="block text-xs font-normal">{money(totals.shortage)} ج.م</span></dd></div>
          </dl>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" className={TOUCH} onClick={() => setConfirm(null)} disabled={anyPending}>رجوع</Button>
            {confirm === "submit" ? (
              <Button type="button" className={TOUCH} disabled={anyPending} data-testid="stocktake-submit-confirm"
                onClick={() => submitGuard.run("submit", submit.isPending, done => submit.mutate({ businessId, stocktakeId }, { onSettled: done }))}>
                {submit.isPending ? "جاري الإرسال..." : "تأكيد الإرسال"}
              </Button>
            ) : (
              <Button type="button" className={TOUCH} disabled={anyPending} data-testid="stocktake-approve-confirm"
                onClick={() => submitGuard.run("approve", approve.isPending, done => approve.mutate({ businessId, stocktakeId }, { onSettled: done }))}>
                {approve.isPending ? "جاري الاعتماد..." : "تأكيد الاعتماد"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
