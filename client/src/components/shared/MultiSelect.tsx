import { useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

export type MultiSelectOption = { value: string; label: string };

export type MultiSelectProps = {
  options: MultiSelectOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  /** Label shown once more than this many are selected, e.g. "٣ محافظات". */
  countLabel?: (n: number) => string;
  className?: string;
};

/**
 * Checkbox-style multi-select for filters (governorate, employee, product…) that need
 * more than one value at once — a plain Select can only hold one.
 */
export function MultiSelect({
  options,
  selected,
  onChange,
  placeholder = "اختر…",
  countLabel,
  className,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value]
    );
  };

  const summary =
    selected.length === 0
      ? placeholder
      : selected.length <= 2
      ? options
          .filter((o) => selected.includes(o.value))
          .map((o) => o.label)
          .join("، ")
      : countLabel?.(selected.length) ?? `${selected.length} مُحدَّد`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn("h-10 min-w-[10rem] justify-between font-normal", className)}
        >
          <span className={cn("truncate", selected.length === 0 && "text-muted-foreground")}>
            {summary}
          </span>
          <ChevronDown className="ms-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start" dir="rtl">
        <Command>
          <CommandInput placeholder="بحث…" />
          <CommandList>
            <CommandEmpty>لا نتائج</CommandEmpty>
            <CommandGroup>
              {options.map((opt) => {
                const isSelected = selected.includes(opt.value);
                return (
                  <CommandItem key={opt.value} onSelect={() => toggle(opt.value)}>
                    <span
                      className={cn(
                        "flex h-4 w-4 items-center justify-center rounded border border-primary",
                        isSelected ? "bg-primary text-primary-foreground" : "opacity-50"
                      )}
                    >
                      {isSelected && <Check className="h-3 w-3" />}
                    </span>
                    <span className="mr-2">{opt.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
          {selected.length > 0 && (
            <div className="border-t border-border p-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="w-full gap-1 text-xs text-muted-foreground"
                onClick={() => onChange([])}
              >
                <X className="h-3 w-3" />
                مسح التحديد
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Selected values rendered as removable chips below the trigger — optional companion. */
export function MultiSelectChips({
  options,
  selected,
  onChange,
}: Pick<MultiSelectProps, "options" | "selected" | "onChange">) {
  if (selected.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {options
        .filter((o) => selected.includes(o.value))
        .map((o) => (
          <Badge key={o.value} variant="secondary" className="gap-1">
            {o.label}
            <button
              type="button"
              onClick={() => onChange(selected.filter((v) => v !== o.value))}
              aria-label={`إزالة ${o.label}`}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
        ))}
    </div>
  );
}
