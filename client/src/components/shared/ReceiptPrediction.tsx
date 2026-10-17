import { cn } from "@/lib/utils";

/**
 * «توقع الاستلام» (Theme Spec §4 عمود 9 و§8): **توقع لا ضمان**، ولا يصدر قرارًا.
 *   • بلا مصدر بيانات حقيقي (`probability` غير رقم 0–100) → «غير متاح» رمادي بلا رقم ولا لون نجاح.
 *   • مع رقم حقيقي: حلقة + % + وصف + شريط 10px بالنطاق: 85–100 أخضر، 70–84 rx-good، 50–69 برتقالي،
 *     <50 أحمر مع «راجع قبل الشحن». الأسباب تُعرض فقط إن وُجدت من المصدر.
 *   • لا قيمة افتراضية ولا تخمين — المكوّن لا يحسب شيئًا.
 */
export type ReceiptBand = "high" | "good" | "medium" | "low";

export function receiptBand(p: number): ReceiptBand {
  if (p >= 85) return "high";
  if (p >= 70) return "good";
  if (p >= 50) return "medium";
  return "low";
}

const BAND_META: Record<ReceiptBand, { label: string; color: string; track: string }> = {
  high: { label: "احتمال مرتفع", color: "text-[var(--success)]", track: "bg-[var(--success)]" },
  good: { label: "احتمال جيد", color: "text-rx-good", track: "bg-rx-good" },
  medium: { label: "احتمال متوسط", color: "text-[var(--warning)]", track: "bg-[var(--warning)]" },
  low: { label: "راجع قبل الشحن", color: "text-destructive", track: "bg-destructive" },
};

export const PREDICTION_UNAVAILABLE = "غير متاح";

export type ReceiptPredictionProps = {
  /** احتمال الاستلام 0–100 من مصدر حقيقي فقط؛ `null`/`undefined` = لا مصدر */
  probability?: number | null;
  /** أسباب من المصدر نفسه؛ تُعرض فقط إن وُجدت */
  reasons?: string[] | null;
  compact?: boolean;
  className?: string;
};

export function ReceiptPrediction({ probability, reasons, compact = false, className }: ReceiptPredictionProps) {
  const known = typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 100;
  if (!known) {
    return (
      <span
        className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)}
        data-testid="receipt-prediction"
        data-state="unavailable"
        aria-label={`توقع الاستلام: ${PREDICTION_UNAVAILABLE}`}
      >
        <span className="h-2 w-2 shrink-0 rounded-full border border-border bg-muted" aria-hidden="true" />
        <span>{PREDICTION_UNAVAILABLE}</span>
      </span>
    );
  }
  const p = Math.round(probability);
  const band = receiptBand(p);
  const meta = BAND_META[band];
  const r = 9, c = 2 * Math.PI * r;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)} data-testid="receipt-prediction" data-state="known" data-band={band} aria-label={`توقع الاستلام ${p}% — ${meta.label} (توقع لا ضمان)`}>
      <span className={cn("flex items-center gap-1.5", meta.color)}>
        <svg width="24" height="24" viewBox="0 0 24 24" className="shrink-0" aria-hidden="true">
          <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
          <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 12 12)" />
        </svg>
        <span className="font-en text-sm font-bold tabular-nums" dir="ltr">{p}%</span>
        {!compact && <span className="text-xs font-medium">{meta.label}</span>}
        <span className="sr-only">توقع لا ضمان</span>
      </span>
      {!compact && (
        <span className="h-[10px] w-24 max-w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <span className={cn("block h-full rounded-full", meta.track)} style={{ width: `${p}%` }} />
        </span>
      )}
      {!compact && reasons && reasons.length > 0 && (
        <ul className="m-0 list-none p-0 text-[11px] leading-snug text-muted-foreground brand-v2:text-xs" data-testid="receipt-prediction-reasons">
          {reasons.map(r => <li key={r}>• {r}</li>)}
        </ul>
      )}
    </div>
  );
}
