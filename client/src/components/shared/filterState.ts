/**
 * Filter-bar logic, kept separate from the markup so it can be unit-tested without a DOM.
 *
 * Every page rolled its own "is anything filtered?" check, and most got it subtly wrong —
 * counting an empty string or a "الكل" sentinel as an active filter, so the reset button
 * appeared enabled on a pristine page.
 */

/** A value counts as unset when it is null/undefined, an empty string, or an empty list. */
export function isEmptyFilterValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof Date) return false;
  if (typeof value === "object") {
    // Range objects ({from, to}) are empty only when both ends are unset.
    return Object.values(value as Record<string, unknown>).every(isEmptyFilterValue);
  }
  return false;
}

/**
 * Sentinel values that mean "no filter" even though they are non-empty strings.
 * `all` is what the Select components use for their catch-all option.
 */
export const FILTER_SENTINELS = new Set(["all", "الكل", "any", "-1"]);

export function isActiveFilter(value: unknown): boolean {
  if (isEmptyFilterValue(value)) return false;
  if (typeof value === "string" && FILTER_SENTINELS.has(value.trim())) return false;
  if (typeof value === "boolean") return value; // `false` means "not filtering on this"
  return true;
}

export type FilterChip = {
  key: string;
  /** Human label for the field, e.g. "الحالة". */
  label: string;
  /** Human label for the value, e.g. "مؤكد". */
  value: string;
};

export type FilterDescriptor<T> = {
  key: keyof T & string;
  label: string;
  /** Renders the current value for the chip. Defaults to String(value). */
  format?: (value: any) => string;
};

/**
 * Builds the chip list for whatever is currently filtered. Order follows the descriptor
 * list so the chips do not reshuffle as the user toggles filters.
 */
export function buildFilterChips<T extends Record<string, any>>(
  filters: T,
  descriptors: FilterDescriptor<T>[]
): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const d of descriptors) {
    const value = filters[d.key];
    if (!isActiveFilter(value)) continue;
    chips.push({
      key: d.key,
      label: d.label,
      value: d.format ? d.format(value) : formatDefault(value),
    });
  }
  return chips;
}

function formatDefault(value: unknown): string {
  if (Array.isArray(value)) return value.join("، ");
  if (typeof value === "boolean") return "نعم";
  if (value instanceof Date) return value.toLocaleDateString("ar-EG");
  return String(value);
}

export function countActiveFilters<T extends Record<string, any>>(
  filters: T,
  descriptors: FilterDescriptor<T>[]
): number {
  return descriptors.reduce(
    (n, d) => (isActiveFilter(filters[d.key]) ? n + 1 : n),
    0
  );
}

/**
 * Clears one filter back to its pristine value, preserving the shape the page expects
 * (a Select stays "all", a multi-select stays an array) so controlled inputs do not
 * flip to uncontrolled.
 */
export function clearFilter<T extends Record<string, any>>(
  filters: T,
  key: keyof T & string,
  initial: T
): T {
  return { ...filters, [key]: initial[key] };
}
