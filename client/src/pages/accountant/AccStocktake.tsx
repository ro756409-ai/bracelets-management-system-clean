import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, ArrowRight, Send, ClipboardCheck, CheckCircle2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { usePermission } from "@/hooks/usePermission";
import { variantLabel, type CatalogVariant } from "@/components/orders/OrderItemsEditor";
import {
  AccCard, AccSectionTitle, AccField, AccInput, AccSelect, AccButton, AccTable, accMoney, AccStatus,
} from "./ui";

const STATUS: Record<string, { label: string; tone: "green" | "amber" | "rose" | "slate" }> = {
  draft: { label: "مسودة", tone: "slate" },
  pending_approval: { label: "بانتظار الاعتماد", tone: "amber" },
  approved: { label: "معتمد", tone: "green" },
  cancelled: { label: "ملغي", tone: "rose" },
};

/**
 * الجرد — بدء جلسة + عدّ + إرسال للاعتماد (المحاسب)، والاعتماد (المالك/المدير).
 *
 * المحاسب بيعدّ ويرسل (draft → pending_approval). الاعتماد بيحرّك المخزون ويسجّل العجز
 * كخسارة والزيادة كربح — بيظهر لصاحب `inventory_costing.approve` فقط، وللجلسة المرسَلة
 * للاعتماد فقط. بعد الاعتماد الجلسة read-only.
 */
export default function AccStocktake({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const [openId, setOpenId] = useState<number | null>(null);

  if (openId != null) {
    return <StocktakeSession businessId={businessId} stocktakeId={openId} onBack={() => setOpenId(null)} />;
  }
  return <StocktakeList businessId={businessId} onOpen={setOpenId} onCreated={setOpenId} utils={utils} />;
}

// ───────────────────────── القائمة + بدء جلسة ─────────────────────────

function StocktakeList({
  businessId, onOpen, onCreated, utils,
}: { businessId: number; onOpen: (id: number) => void; onCreated: (id: number) => void; utils: any }) {
  const warehouses = trpc.businesses.warehouses.useQuery({ businessId });
  const list = trpc.accountingV2.stocktakeList.useQuery({ businessId });
  const [warehouseId, setWarehouseId] = useState("");

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

  return (
    <div className="space-y-5">
      <AccCard>
        <AccSectionTitle>بدء جردة جديدة</AccSectionTitle>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <AccField label="المخزن" required>
            <AccSelect value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
              <option value="">— اختار —</option>
              {ws.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </AccSelect>
          </AccField>
          <div className="flex items-end">
            <AccButton
              disabled={!warehouseId || create.isPending}
              onClick={() => create.mutate({ businessId, warehouseId: Number(warehouseId) })}
            >
              <Plus className="h-4 w-4" /> {create.isPending ? "جاري البدء..." : "بدء الجرد"}
            </AccButton>
          </div>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          بيتاخد لقطة لأرصدة المخزن دلوقتي، وتدخل العدد الفعلي لكل صنف. الاعتماد وتحريك
          المخزون بيتمّوا من المالك لاحقًا — المحاسب بيعدّ ويرسل بس.
        </p>
      </AccCard>

      <AccCard>
        <AccSectionTitle>جلسات الجرد</AccSectionTitle>
        <AccTable head={["التاريخ", "المخزن", "الحالة", "بواسطة", ""]}
          empty={list.isLoading ? "جاري التحميل..." : "مفيش جلسات جرد."}>
          {rows.map(r => {
            const st = STATUS[r.status] ?? { label: r.status, tone: "slate" as const };
            return (
              <tr key={r.id} className="border-b border-slate-100 last:border-0">
                <td className="px-3 py-2.5 whitespace-nowrap tabular-nums text-slate-600">
                  {new Date(r.createdAt).toLocaleDateString("ar-EG")}
                </td>
                <td className="px-3 py-2.5">{whName(r.warehouseId)}</td>
                <td className="px-3 py-2.5"><AccStatus tone={st.tone}>{st.label}</AccStatus></td>
                <td className="px-3 py-2.5 text-slate-500">{r.createdByName}</td>
                <td className="px-3 py-2.5 text-left">
                  <AccButton variant="ghost" className="px-2.5 py-1.5" onClick={() => onOpen(r.id)}>
                    فتح <ArrowRight className="h-3.5 w-3.5" />
                  </AccButton>
                </td>
              </tr>
            );
          })}
        </AccTable>
      </AccCard>
    </div>
  );
}

// ───────────────────────── جلسة واحدة (عدّ) ─────────────────────────

function StocktakeSession({
  businessId, stocktakeId, onBack,
}: { businessId: number; stocktakeId: number; onBack: () => void }) {
  const utils = trpc.useUtils();
  const session = trpc.accountingV2.stocktakeGet.useQuery({ businessId, stocktakeId }, { retry: false });
  const { data: products } = trpc.products.list.useQuery({ businessIds: [businessId] });
  const { data: variants } = trpc.variants.all.useQuery({ businessIds: [businessId] });

  const productName = (id: number) => (products ?? []).find((p: any) => p.id === id)?.name ?? `#${id}`;
  const variantName = (id?: number | null) => {
    if (id == null) return null;
    const v = ((variants ?? []) as CatalogVariant[]).find(x => x.id === id);
    return v ? variantLabel(v) : `#${id}`;
  };

  const lineUpdate = trpc.accountingV2.stocktakeLineUpdate.useMutation({
    onSuccess: () => utils.accountingV2.stocktakeGet.invalidate({ businessId, stocktakeId }),
    onError: (e: any) => toast.error(e.message),
  });
  const submit = trpc.accountingV2.stocktakeSubmit.useMutation({
    onSuccess: async () => {
      toast.success("اتبعت للاعتماد");
      await Promise.all([
        utils.accountingV2.stocktakeGet.invalidate({ businessId, stocktakeId }),
        utils.accountingV2.stocktakeList.invalidate(),
      ]);
    },
    onError: (e: any) => toast.error(e.message),
  });

  // الاعتماد بيحرّك المخزون → على inventory_costing.approve. المحاسب معاهوش الصلاحية دي،
  // فالزر يختفي عنه — والباك بيرفضها كمان (مفيش اعتماد على إخفاء الواجهة).
  const canApprove = usePermission("inventory_costing.approve");
  const approve = trpc.accountingV2.stocktakeApprove.useMutation({
    onSuccess: async () => {
      toast.success("تم الاعتماد — العجز اتسجّل خسارة مخزون والزيادة ربح مخزون، والمخزون اتحرّك.");
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

  const totals = useMemo(() => lines.reduce((s, l) => {
    const v = Number(l.differenceValue);
    return {
      shortage: s.shortage + (l.differenceQuantity < 0 ? -v : 0),
      surplus: s.surplus + (l.differenceQuantity > 0 ? v : 0),
    };
  }, { shortage: 0, surplus: 0 }), [lines]);

  const commit = (line: any, raw: string) => {
    const counted = Number(raw);
    if (!Number.isInteger(counted) || counted < 0) { toast.error("رقم صحيح مش سالب"); return; }
    if (counted === line.countedQuantity) return;
    lineUpdate.mutate({ businessId, stocktakeId, lineId: line.id, countedQuantity: counted });
  };

  if (session.isLoading) return <AccCard><div className="h-24 animate-pulse rounded bg-slate-100" /></AccCard>;
  if (!data) return <AccCard><p className="p-4 text-sm text-slate-500">الجلسة مش موجودة.</p></AccCard>;
  const st = STATUS[data.status] ?? { label: data.status, tone: "slate" as const };

  return (
    <div className="space-y-5">
      <AccCard>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-slate-500" />
            <div>
              <p className="font-bold text-slate-800">جردة #{data.id}</p>
              <p className="text-xs text-slate-500">
                {new Date(data.createdAt).toLocaleDateString("ar-EG")} · {data.createdByName}
              </p>
            </div>
            <AccStatus tone={st.tone}>{st.label}</AccStatus>
          </div>
          <div className="flex gap-2">
            <AccButton variant="ghost" onClick={onBack}>رجوع</AccButton>
            {isDraft && (
              <AccButton disabled={submit.isPending} onClick={() => {
                if (!confirm("تبعت الجرد للاعتماد؟ بعدها مايتعدّلش.")) return;
                submit.mutate({ businessId, stocktakeId });
              }}>
                <Send className="h-4 w-4" /> {submit.isPending ? "جاري الإرسال..." : "إرسال للاعتماد"}
              </AccButton>
            )}
            {isPendingApproval && canApprove && (
              <AccButton disabled={approve.isPending} onClick={() => {
                if (!confirm("اعتماد الجرد؟ هيحرّك المخزون ويسجّل العجز كخسارة والزيادة كربح، ومايتراجعش.")) return;
                approve.mutate({ businessId, stocktakeId });
              }}>
                <CheckCircle2 className="h-4 w-4" /> {approve.isPending ? "جاري الاعتماد..." : "اعتماد وتحريك المخزون"}
              </AccButton>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-rose-50 p-3 text-center">
            <p className="text-xs text-rose-600">إجمالي قيمة العجز</p>
            <p className="text-lg font-bold tabular-nums text-rose-700">{accMoney(totals.shortage)}</p>
          </div>
          <div className="rounded-xl bg-emerald-50 p-3 text-center">
            <p className="text-xs text-emerald-600">إجمالي قيمة الزيادة</p>
            <p className="text-lg font-bold tabular-nums text-emerald-700">{accMoney(totals.surplus)}</p>
          </div>
        </div>
      </AccCard>

      <AccCard>
        <AccTable head={["الصنف", "رصيد السيستم", "العدد الفعلي", "الفرق", "تكلفة الوحدة", "قيمة الفرق"]}
          empty="مفيش أصناف في المخزن ده.">
          {lines.map(l => (
            <tr key={l.id} className="border-b border-slate-100 last:border-0">
              <td className="px-3 py-2.5">
                {productName(l.productId)}
                {variantName(l.variantId) && <span className="text-slate-500"> — {variantName(l.variantId)}</span>}
              </td>
              <td className="px-3 py-2.5 tabular-nums text-slate-600">{l.systemQuantity}</td>
              <td className="px-3 py-2.5">
                {isDraft ? (
                  <input
                    type="number" min="0" dir="ltr" defaultValue={l.countedQuantity}
                    disabled={lineUpdate.isPending}
                    onBlur={e => commit(l, e.target.value)}
                    className="w-24 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm tabular-nums outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                  />
                ) : (
                  <span className="tabular-nums">{l.countedQuantity}</span>
                )}
              </td>
              <td className="px-3 py-2.5 tabular-nums font-medium"
                style={{ color: l.differenceQuantity < 0 ? "#dc2626" : l.differenceQuantity > 0 ? "#0f766e" : "#64748b" }}>
                {l.differenceQuantity > 0 ? `+${l.differenceQuantity}` : l.differenceQuantity}
              </td>
              <td className="px-3 py-2.5 tabular-nums text-slate-500">{accMoney(l.unitCostSnapshot)}</td>
              <td className="px-3 py-2.5 tabular-nums font-medium"
                style={{ color: l.differenceQuantity < 0 ? "#dc2626" : l.differenceQuantity > 0 ? "#0f766e" : "#64748b" }}>
                {accMoney(l.differenceValue)}
              </td>
            </tr>
          ))}
        </AccTable>
        <p className="mt-3 text-xs text-slate-400">
          الأرقام لقطة وقت بدء الجرد. عند الاعتماد بيتحرّك المخزون بفرق كل صنف على رصيده
          الحالي: العجز بيتسجّل <span className="text-rose-600">خسارة مخزون</span> والزيادة
          <span className="text-emerald-600"> ربح مخزون</span> في الحسابات. بعد الاعتماد
          الجلسة بتبقى للعرض فقط.
        </p>
      </AccCard>
    </div>
  );
}
