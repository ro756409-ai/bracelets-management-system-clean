import { Copy } from "lucide-react";
import { toast } from "sonner";
import { PartnerLogo } from "@/components/brand/PartnerLogo";

/**
 * رقم التتبع الحقيقي اللي رجّعته بوسطة (أو اتربط بعد مراجعة) — ظاهر في الجدول مع نسخ بضغطة.
 * لو الشحنة اتعملت ورقم التتبع لسه ماوصلش (بيتحدّث من الـwebhook)، بنعرض «بوسطة» بس — مانعرضش رقم الأوردر الداخلي
 * ولا businessReference على إنه رقم تتبع.
 */
export function TrackingChip({ shipmentId, trackingNumber }: { shipmentId: string | null | undefined; trackingNumber: string | null | undefined }) {
  if (!shipmentId) return null;
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(String(trackingNumber));
      toast.success("اتنسخ رقم التتبع");
    } catch {
      toast.error("تعذّر النسخ — انسخ الرقم يدويًا");
    }
  };
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[var(--radius-brand-pill)] bg-[var(--info)]/10 px-1.5 py-0.5 text-[11px] font-bold text-[var(--info)]"
      data-testid="tracking-chip"
    >
      <PartnerLogo partner="bosta" size="xs" decorative className="!h-2.5" />
      {trackingNumber ? (
        <>
          <span className="sr-only">رقم تتبع بوسطة: </span>
          <span dir="ltr" className="font-en tabular-nums" data-testid="tracking-number">{trackingNumber}</span>
          <button
            type="button"
            onClick={copy}
            // الكارت كله زر (فتح التفاصيل بـEnter/Space) — زر النسخ مايفتحش الأوردر بالكيبورد.
            onKeyDown={e => e.stopPropagation()}
            className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-full hover:bg-[var(--info)]/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--info)]"
            aria-label={`نسخ رقم التتبع ${trackingNumber}`}
            title="نسخ رقم التتبع"
            data-testid="tracking-copy"
          >
            <Copy className="h-3 w-3" aria-hidden="true" />
          </button>
        </>
      ) : (
        <span title="رقم التتبع بيظهر أول ما بوسطة تبعته">بوسطة</span>
      )}
    </span>
  );
}
