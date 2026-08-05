import { useMemo } from "react";
import { useOperationalOptions } from "./useOperationalOptions";
import { ORDER_SOURCE } from "@/components/shared";

/**
 * Which order sources to offer, everywhere an order is created by hand.
 *
 * Same shape and same reason as useGovernorateOptions: the per-business configuration
 * table is empty in production, so `useOperationalOptions("order_source")` came back with
 * nothing and the select rendered with no options at all. Source is a required column on
 * `orders`, so an empty list is not a cosmetic problem — it makes the form unsubmittable.
 *
 * The fallback is not invented vocabulary. ORDER_SOURCE is the map the badges, the
 * dashboard and the order details screen already use to *read* the values sitting in
 * production today, so offering exactly those keys keeps what we write and what we render
 * on the same alphabet.
 */
export function useOrderSourceOptions() {
  const query = useOperationalOptions("order_source");
  const configured = query.options.filter(option => option.value);

  const options = useMemo(
    () =>
      configured.length > 0
        ? configured
        : Object.entries(ORDER_SOURCE).map(([value, def]) => ({
            value,
            label: def.label,
          })),
    [configured.map(option => option.value).join("|")]
  );

  return {
    /** Sources to render, never empty. */
    options,
    isLoading: query.isLoading,
    /** True when the list came from the business's own configuration. */
    isConfigured: configured.length > 0,
  };
}
