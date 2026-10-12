import { useState } from "react";
import { Truck } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

/**
 * المرحلة 4 — بعد مسح QR: «تسليم لمندوب الشحن» = خروج البضاعة وتثبيت تكلفة الأوردر مرة واحدة (السيرفر idempotent).
 * يظهر فقط حين يكون تقييم المخزون ودفتر الحسابات مفعّلين للنشاط (السيرفر يحرس أيضًا). لا أرقام تكلفة لموظف المخزن.
 */
export function HandoverPanel({ order }: { order: { id: number; businessId: number; orderNumber?: string; status?: string } }) {
  const status = trpc.inventoryLedger.status.useQuery({ businessId: order.businessId }, { retry: false, staleTime: 60_000 });
  const handover = trpc.inventoryLedger.handover.useMutation();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | { duplicate: boolean }>(null);
  if (!status.data?.active) return null;
  const run = async () => {
    if (busy || handover.isPending) return; // ضغط مزدوج = طلب واحد
    setBusy(true);
    try {
      const r = await handover.mutateAsync({ businessId: order.businessId, orderId: order.id });
      setDone({ duplicate: r.duplicate });
      toast.success(r.duplicate ? "سُلِّم من قبل — لا خروج مكرر" : "تم التسليم لمندوب الشحن وخرجت البضاعة وثُبتت التكلفة");
    } catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="mt-3 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" dir="rtl" data-testid="handover-panel">
      {done ? (
        <p className="text-sm font-medium" data-testid="handover-done">{done.duplicate ? "هذا الأوردر سُلِّم لمندوب الشحن من قبل." : "سُلِّم لمندوب الشحن: خرجت البضاعة من المخزن وثُبتت تكلفة الأوردر."}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">التسليم يُخرج البضاعة من المخزن ويثبّت تكلفة الأوردر مرة واحدة.</p>
          <Button className="mt-2 min-h-12 w-full" onClick={run} disabled={busy || handover.isPending} data-testid="handover-run"><Truck className="h-4 w-4 ml-1" aria-hidden="true" /> {busy || handover.isPending ? "جارٍ التسليم…" : "تسليم لمندوب الشحن"}</Button>
        </>
      )}
    </div>
  );
}
