import type { StatusTone } from "@/components/shared";

/**
 * شرائح فلترة الحالة (Status workflow) — صفّ chips قابلة للنقر بعدّاد لكل حالة، + «الكل».
 *
 * ده «summary strip» بتاع الـWorkspace: بيوري توزيع الحالات وبيفلتر بضغطة، بدل كروت متفرقة
 * بتكرّر نفس الأرقام. عرض بحت — الصفحة بتمرّر العدّات (من نفس نطاق البيانات/السيرفر) وبتتحكم
 * في القيمة المختارة. بيستخدم نفس نظام النغمات (StatusTone) الموحّد.
 */
export type StatusChipItem = {
  key: string;
  label: string;
  count?: number;
  tone?: StatusTone;
};

const TONE_ACTIVE: Record<StatusTone, string> = {
  neutral: "bg-muted text-foreground border-border",
  primary: "bg-primary text-primary-foreground border-primary",
  success: "bg-[var(--success)] text-[var(--success-foreground)] border-[var(--success)]",
  warning: "bg-[var(--warning)] text-[var(--warning-foreground)] border-[var(--warning)]",
  danger: "bg-destructive text-destructive-foreground border-destructive",
  info: "bg-[var(--info)] text-[var(--info-foreground)] border-[var(--info)]",
  purple: "bg-[var(--purple)] text-[var(--purple-foreground)] border-[var(--purple)]",
  cyan: "bg-[var(--cyan)] text-[var(--cyan-foreground)] border-[var(--cyan)]",
  amber: "bg-[var(--amber)] text-[var(--amber-foreground)] border-[var(--amber)]",
  orange: "bg-[var(--orange)] text-[var(--orange-foreground)] border-[var(--orange)]",
  delivered: "bg-[var(--delivered)] text-[var(--delivered-foreground)] border-[var(--delivered)]",
};

export function StatusFilterChips({
  chips,
  /** المفتاح المختار، أو null = «الكل». */
  value,
  onChange,
  /** إجمالي «الكل» (اختياري). */
  totalCount,
}: {
  chips: StatusChipItem[];
  value: string | null;
  onChange: (key: string | null) => void;
  totalCount?: number;
}) {
  const base =
    "inline-flex items-center gap-1.5 rounded-[var(--radius-brand-pill)] border px-3 py-1.5 text-sm font-medium transition-colors";
  const idle = "border-border bg-card text-muted-foreground hover:bg-muted";

  return (
    <div className="flex flex-wrap gap-2" dir="rtl" role="tablist" aria-label="فلترة الحالة">
      <button
        type="button"
        role="tab"
        aria-selected={value == null}
        onClick={() => onChange(null)}
        className={`${base} ${value == null ? "border-primary bg-primary text-primary-foreground" : idle}`}
      >
        الكل
        {typeof totalCount === "number" && <Count active={value == null}>{totalCount}</Count>}
      </button>

      {chips.map(chip => {
        const active = value === chip.key;
        const activeClass = TONE_ACTIVE[chip.tone ?? "neutral"];
        return (
          <button
            key={chip.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(active ? null : chip.key)}
            className={`${base} ${active ? activeClass : idle}`}
          >
            {chip.label}
            {typeof chip.count === "number" && <Count active={active}>{chip.count}</Count>}
          </button>
        );
      })}
    </div>
  );
}

function Count({ children, active }: { children: React.ReactNode; active: boolean }) {
  return (
    <span
      className={`inline-flex min-w-5 items-center justify-center rounded-full px-1 text-xs font-bold tabular-nums ${
        active ? "bg-white/20" : "bg-muted-foreground/10"
      }`}
    >
      {children}
    </span>
  );
}
