import type { ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

export type DrawerWidth = "sm" | "md" | "lg";

export type DrawerWidthKey = DrawerWidth | "xl";

const WIDTH: Record<DrawerWidthKey, string> = {
  sm: "sm:max-w-[420px]",
  md: "sm:max-w-[560px]",
  lg: "sm:max-w-[720px]",
  // A record you actually work inside (status, notes, timeline, next/prev) needs room to
  // breathe without becoming a second page.
  xl: "sm:max-w-[860px]",
};

export type DrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** ReactNode, not string — a workspace header carries a record id, status and badges. */
  title: ReactNode;
  description?: ReactNode;
  width?: DrawerWidthKey;
  /** Sits opposite the title in the fixed header — prev/next navigation, overflow menu. */
  headerExtra?: ReactNode;
  /** Fixed under the header and above the scroll area — tabs, or a status/action strip. */
  subHeader?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * Side panel for working on one record — the order workspace, a variant editor, etc.
 *
 * Three fixed zones rather than one scrolling column: header and footer stay put while only
 * the body scrolls. Previously `overflow-y-auto` sat on the whole panel, so the record's
 * identity and its primary actions scrolled out of view exactly when a long record made them
 * most useful.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  width = "md",
  headerExtra,
  subHeader,
  children,
  footer,
}: DrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className={cn("flex w-full flex-col gap-0 p-0", WIDTH[width])}
        dir="rtl"
      >
        {/* pr-10 clears the sheet's absolutely-positioned close button (physical top-right). */}
        <SheetHeader className="shrink-0 gap-1 border-b border-border px-4 py-3 pr-10">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-base">{title}</SheetTitle>
              {description && <SheetDescription>{description}</SheetDescription>}
            </div>
            {headerExtra && <div className="flex shrink-0 items-center gap-1">{headerExtra}</div>}
          </div>
        </SheetHeader>

        {subHeader && <div className="shrink-0 border-b border-border px-4 py-2">{subHeader}</div>}

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">{children}</div>

        {footer && (
          <SheetFooter className="shrink-0 border-t border-border bg-card px-4 py-3">
            {footer}
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
