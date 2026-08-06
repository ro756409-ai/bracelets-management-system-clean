import { useEffect, useState } from "react";
import { useBusinessContext } from "@/contexts/BusinessContext";

/**
 * Which brands a screen may act on, and which one is currently chosen.
 *
 * Three screens shipped the same shape by hand — auto-select when there is exactly one
 * brand, render a picker when there is more than one — and all three died the same way in
 * production, because none of them handled *none*. With an empty list there was no
 * auto-selection and no picker, so `businessId` stayed empty forever: the goods receipt
 * screen left its warehouse select permanently disabled behind the message "choose the
 * brand first", and salary preparation rendered a blank card saying the same thing. Both
 * asked the user to do something the screen gave them no way to do.
 *
 * The empty list is not hypothetical. getBusinessGroupsWithBusinesses attaches a business
 * to a group by `b.groupId === g.id`, so every business whose groupId is null belongs to no
 * group at all and `currentGroup.businesses` comes back empty while the business plainly
 * exists. That is why this reads the group first and then falls back to the flat list.
 *
 * `isEmpty` exists so a screen can say "there are no brands" instead of pretending the user
 * simply has not picked one yet.
 */
export function useBrandOptions() {
  const { currentGroup, businesses, isLoading } = useBusinessContext();

  const fromGroup = currentGroup?.businesses ?? [];
  const brands = fromGroup.length > 0 ? fromGroup : businesses;

  const [selected, setSelected] = useState("");

  // Must be an effect, not lazy initial state: the list arrives from a query, so on the
  // first render it is empty and an initial value would latch to "" and never update.
  useEffect(() => {
    if (brands.length !== 1) return;
    const only = String(brands[0].id);
    setSelected(current => (current === only ? current : only));
  }, [brands]);

  // A brand that vanished — group switched, business archived — must not stay selected, or
  // the screen keeps posting to something the user can no longer see.
  useEffect(() => {
    if (!selected || brands.length === 0) return;
    if (!brands.some(b => String(b.id) === selected)) setSelected("");
  }, [brands, selected]);

  return {
    /** Never derived from a single source — group first, then every brand in the tenant. */
    brands,
    selected,
    setSelected,
    /** The chosen brand as a number, or undefined while nothing is chosen. */
    selectedId: Number(selected) || undefined,
    /** True when the user genuinely has to pick — more than one, none chosen yet. */
    needsChoice: brands.length > 1 && !selected,
    /** True when there is nothing to pick at all. Say so; do not ask for a choice. */
    isEmpty: !isLoading && brands.length === 0,
    isLoading,
  };
}
