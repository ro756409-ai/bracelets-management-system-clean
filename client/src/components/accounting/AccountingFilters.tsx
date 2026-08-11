import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * فلتر واحد لكل شاشات الحسابات.
 *
 * كانت كل شاشة بتعمل الفلتر بطريقتها: واحدة بتاريخين، وواحدة بأزرار، وواحدة بمنتقي
 * مدى. التاجر بيتعلّم الفلتر من أول، وكل شاشة بتبدأ بيه من الأول تاني.
 *
 * الفترات هنا **مقفولة**: اليوم · أمس · هذا الشهر · مخصص. ولو الشاشة محتاجة نوع حركة
 * أو بحث، بيتحطوا في نفس السطر بعد الأزرار — نفس المكان في كل مرة.
 */

export type PresetKey = "today" | "yesterday" | "month" | "custom";

export const PRESETS: { key: PresetKey; label: string }[] = [
  { key: "today", label: "اليوم" },
  { key: "yesterday", label: "أمس" },
  { key: "month", label: "هذا الشهر" },
  { key: "custom", label: "مخصص" },
];

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * الفترة بالتواريخ. `to` **حصري** — يعني «أقل من» مش «أقل من أو يساوي».
 *
 * ده بيمنع أشهر بُق: نهاية اليوم كـ23:59:59 بتفقد الحركة اللي حصلت 23:59:59.5،
 * والحد الحصري على أول اليوم اللي بعده بيمسك اليوم كامل.
 */
export function presetRange(
  key: PresetKey,
  now: Date
): { from: Date | null; toExclusive: Date | null } {
  const today = startOfDay(now);
  switch (key) {
    case "today":
      return { from: today, toExclusive: null };
    case "yesterday": {
      const from = new Date(today);
      from.setDate(from.getDate() - 1);
      return { from, toExclusive: today };
    }
    case "month":
      return { from: new Date(now.getFullYear(), now.getMonth(), 1), toExclusive: null };
    case "custom":
      return { from: null, toExclusive: null };
  }
}

export function AccountingFilters({
  preset,
  onPreset,
  customFrom,
  customTo,
  onCustomFrom,
  onCustomTo,
  children,
}: {
  preset: PresetKey;
  onPreset: (key: PresetKey) => void;
  customFrom?: string;
  customTo?: string;
  onCustomFrom?: (value: string) => void;
  onCustomTo?: (value: string) => void;
  /** نوع الحركة أو البحث — بيتحطوا بعد الأزرار في نفس السطر. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card px-4 py-3">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map(item => (
          <Button
            key={item.key}
            size="sm"
            variant={preset === item.key ? "default" : "outline"}
            onClick={() => onPreset(item.key)}
          >
            {item.label}
          </Button>
        ))}
      </div>

      {/* حقول التاريخ بتظهر مع «مخصص» بس — غير كده بتبقى مساحة مشغولة بلا داعي. */}
      {preset === "custom" && (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label className="text-xs">من</Label>
            <Input
              className="mt-1 h-9"
              type="date"
              value={customFrom ?? ""}
              onChange={event => onCustomFrom?.(event.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">إلى</Label>
            <Input
              className="mt-1 h-9"
              type="date"
              value={customTo ?? ""}
              onChange={event => onCustomTo?.(event.target.value)}
            />
          </div>
        </div>
      )}

      {children}
    </div>
  );
}
