import { cn } from "@/lib/utils";

/** خلية العميل (Theme Spec §4 عمود 3): أول حرف على سطح `accent` + الاسم + الهاتف LTR بخط DM Sans. */
export type CustomerCellProps = { name: string; phone?: string | null; secondaryPhone?: string | null; className?: string };

export function CustomerCell({ name, phone, secondaryPhone, className }: CustomerCellProps) {
  const initial = name.trim().charAt(0) || "؟";
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)} data-testid="customer-cell">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground" aria-hidden="true">{initial}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{name}</span>
        {phone && <span className="font-en truncate text-xs text-muted-foreground tabular-nums" dir="ltr">{phone}{secondaryPhone ? ` · ${secondaryPhone}` : ""}</span>}
      </span>
    </div>
  );
}
