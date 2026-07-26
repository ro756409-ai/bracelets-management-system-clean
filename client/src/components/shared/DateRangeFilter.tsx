import DateRangePicker, { type DateRange } from "@/components/DateRangePicker";

export type { DateRange };

/**
 * Filter-bar wrapper around the existing DateRangePicker (calendar UI, presets, and RTL
 * month grid already built and in production use on the shipping schedule). Re-exported
 * here under the shared-component name from the design-system spec, rather than
 * duplicating working calendar logic.
 */
export function DateRangeFilter(props: {
  value: DateRange;
  onChange: (range: DateRange) => void;
  placeholder?: string;
}) {
  return <DateRangePicker {...props} />;
}
