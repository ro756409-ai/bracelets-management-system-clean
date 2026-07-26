import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type StickyActionBarProps = {
  /** Leading info block — a running total, a selection count. */
  info?: ReactNode;
  children: ReactNode;
  className?: string;
};

/**
 * A footer that stays reachable while a long form scrolls. On a 2000px-tall order form,
 * the save button used to be a full swipe away; this keeps it one thumb's reach from
 * anywhere on the page.
 *
 * Positioned `sticky` within its scroll container rather than `fixed` to the viewport, so
 * it does not float over unrelated content when embedded in a drawer or dialog.
 */
export function StickyActionBar({ info, children, className }: StickyActionBarProps) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-20 -mx-4 mt-4 border-t border-border bg-card/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6",
        className
      )}
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        {info && <div className="min-w-0 flex-1">{info}</div>}
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      </div>
    </div>
  );
}
