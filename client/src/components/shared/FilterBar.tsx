import { useEffect, useState, type ReactNode } from "react";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { FilterChip } from "./filterState";

export type SearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Milliseconds to wait after typing stops. 0 disables debouncing. */
  debounceMs?: number;
  className?: string;
  "aria-label"?: string;
};

/**
 * Search box with built-in debouncing. Pages were calling the API on every keystroke;
 * the debounce lives here so no page has to remember it.
 *
 * The input stays fully controlled by local state while typing, and only the *outward*
 * notification is delayed — so the field never lags behind the keyboard.
 */
export function SearchInput({
  value,
  onChange,
  placeholder = "بحث…",
  debounceMs = 300,
  className,
  ...rest
}: SearchInputProps) {
  const [local, setLocal] = useState(value);

  // Re-sync when the parent resets filters from outside.
  useEffect(() => setLocal(value), [value]);

  useEffect(() => {
    if (local === value) return;
    if (debounceMs === 0) {
      onChange(local);
      return;
    }
    const t = setTimeout(() => onChange(local), debounceMs);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, debounceMs]);

  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        placeholder={placeholder}
        className="h-10 pr-9 pl-9"
        aria-label={rest["aria-label"] ?? placeholder}
      />
      {local && (
        <button
          type="button"
          onClick={() => setLocal("")}
          aria-label="مسح البحث"
          className="absolute left-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

export type FilterBarProps = {
  /** The search control, rendered first and always visible. */
  search?: ReactNode;
  /** The filter controls themselves. Collapse into a drawer on mobile. */
  children?: ReactNode;
  chips?: FilterChip[];
  onClearChip?: (key: string) => void;
  onReset?: () => void;
  activeCount?: number;
  className?: string;
};

/**
 * Search + filters + active-filter chips.
 *
 * On phones the filter controls move into a drawer instead of stacking into a tall wall
 * of selects that pushes the data off-screen. The chips stay visible either way, so it is
 * always obvious *why* the list is short.
 */
export function FilterBar({
  search,
  children,
  chips = [],
  onClearChip,
  onReset,
  activeCount = 0,
  className,
}: FilterBarProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center gap-2">
        {search && <div className="min-w-0 flex-1 lg:max-w-xs">{search}</div>}

        {children && (
          <>
            {/* Mobile: filters live in a drawer */}
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" className="h-10 shrink-0 gap-1.5 lg:hidden">
                  <SlidersHorizontal className="h-4 w-4" />
                  فلاتر
                  {activeCount > 0 && (
                    <Badge className="h-5 min-w-5 justify-center px-1 tabular-nums">
                      {activeCount}
                    </Badge>
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[min(22rem,90vw)] overflow-y-auto" dir="rtl">
                <SheetHeader>
                  <SheetTitle>الفلاتر</SheetTitle>
                </SheetHeader>
                <div className="grid gap-3 px-4 pb-6">{children}</div>
              </SheetContent>
            </Sheet>

            {/* Desktop: filters inline */}
            <div className="hidden flex-wrap items-center gap-2 lg:flex">{children}</div>
          </>
        )}

        {onReset && activeCount > 0 && (
          <Button
            variant="ghost"
            className="h-10 shrink-0 gap-1 text-muted-foreground"
            onClick={onReset}
          >
            <X className="h-4 w-4" />
            <span className="hidden sm:inline">مسح الفلاتر</span>
          </Button>
        )}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">مُفلتر بـ:</span>
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1 rounded-[var(--radius-brand-pill)] border border-border bg-muted px-2 py-1 text-xs"
            >
              <span className="text-muted-foreground">{chip.label}:</span>
              <span className="font-medium">{chip.value}</span>
              {onClearChip && (
                <button
                  type="button"
                  onClick={() => onClearChip(chip.key)}
                  aria-label={`إزالة فلتر ${chip.label}`}
                  className="rounded-full text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
