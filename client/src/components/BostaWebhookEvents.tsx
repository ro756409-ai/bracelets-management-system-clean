import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

const STATUS_LABEL: Record<string, string> = {
  unmatched: "بلا أوردر مطابق",
  failed: "فشلت المعالجة",
  ignored: "للمراجعة — بلا تعديل",
};

/**
 * أحداث بوسطة اللي محتاجة مراجعة **للنشاط الحالي**: شحنة بلا أوردر مطابق، معالجة فشلت، أو
 * حالة اتحفظت بلا تعديل (102–105 / كود غير معروف / حدث قديم). النطاق والصلاحية على السيرفر:
 * القائمة للأدمن داخل نشاطه، وإعادة المعالجة للمالك فقط. الـpayload الخام مابيوصلش للمتصفح.
 */
export function BostaWebhookEvents({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const input = { businessId, statuses: ["unmatched", "failed", "ignored"] as ("unmatched" | "failed" | "ignored")[], limit: 30 };
  const events = trpc.carrierAccounts.webhookEvents.useQuery(input, { enabled: businessId > 0 });
  const reprocess = trpc.carrierAccounts.reprocessWebhookEvent.useMutation({
    onSuccess: r => {
      if (r.ok && r.status === "processed") toast.success("تمت معالجة الحدث وتحديث الأوردر");
      else toast.message(r.reason ?? STATUS_LABEL[r.status] ?? "لم يتغيّر شيء");
      utils.carrierAccounts.webhookEvents.invalidate({ businessId });
    },
    onError: e => toast.error(e.message),
  });

  const rows = events.data ?? [];
  if (events.isLoading || rows.length === 0) return null;

  return (
    <div className="space-y-1.5 border-t pt-3" data-testid="bosta-webhook-events">
      <p className="text-xs font-medium">أحداث بوسطة تحتاج مراجعة ({rows.length})</p>
      <ul className="max-h-48 space-y-1.5 overflow-y-auto text-xs">
        {rows.map(e => (
          <li key={e.id} className="rounded-md border p-2" data-testid={`bosta-event-${e.id}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant={e.processingStatus === "ignored" ? "secondary" : "destructive"}>{STATUS_LABEL[e.processingStatus] ?? e.processingStatus}</Badge>
              <span>{e.stateLabel}</span>
              {e.trackingNumber && <span className="text-muted-foreground" dir="ltr">#{e.trackingNumber}</span>}
            </div>
            {e.failureReason && <p className="mt-1 text-muted-foreground">{e.failureReason}</p>}
            {(e.processingStatus === "unmatched" || e.processingStatus === "failed") && (
              <Button
                type="button" variant="outline" size="sm" className="mt-1.5 h-7 text-xs"
                onClick={() => reprocess.mutate({ businessId, eventId: e.id })}
                disabled={reprocess.isPending}
                data-testid={`bosta-event-reprocess-${e.id}`}
              >
                <RefreshCw className={`h-3 w-3 ml-1 ${reprocess.isPending ? "animate-spin" : ""}`} /> إعادة المعالجة
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
