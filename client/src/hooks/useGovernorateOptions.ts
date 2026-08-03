import { useMemo } from "react";
import { useOperationalOptions } from "./useOperationalOptions";
import { GOVERNORATE_NAMES } from "@shared/egyptLocations";

/**
 * Which governorates to offer, everywhere.
 *
 * Every screen used to read `useOperationalOptions("governorate")` directly. That reads a
 * per-business configuration table nobody had populated, so the list came back empty and
 * the control rendered with no options — on the owner's order form, on the data-entry
 * employee's create form, and on the manager and Bosta filters alike. Each screen had the
 * same bug for the same reason, and fixing them one at a time is how the fourth one gets
 * missed.
 *
 * The curated list still wins when a business has one — a merchant who only ships to Cairo
 * and Giza should see two options, not twenty-seven — and the full national list is the
 * floor underneath it.
 */
export function useGovernorateOptions() {
  const query = useOperationalOptions("governorate");

  const values = useMemo(() => {
    const configured = (query.values ?? []).filter(Boolean);
    return configured.length > 0 ? configured : GOVERNORATE_NAMES;
  }, [query.values]);

  return {
    /** Governorate names to render, never empty. */
    values,
    /** True while the business's curated list is still loading. */
    isLoading: query.isLoading,
    /** True when the curated list could not be fetched — the fallback is showing. */
    isError: query.isError,
    /** True when the list came from the business's own configuration rather than the fallback. */
    isConfigured: (query.values ?? []).filter(Boolean).length > 0,
  };
}
