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

const WIDTH: Record<DrawerWidth, string> = {
  sm: "sm:max-w-[420px]",
  md: "sm:max-w-[560px]",
  lg: "sm:max-w-[720px]",
};

export type DrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  width?: DrawerWidth;
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * Side panel for record detail / editing — the order-row drawer, a variant editor, etc.
 * Full-width on mobile (the sheet primitive already does this), a fixed max-width on
 * larger screens so the panel does not swallow the whole desktop viewport.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  width = "md",
  children,
  footer,
}: DrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className={cn("flex w-full flex-col overflow-y-auto", WIDTH[width])}
        dir="rtl"
      >
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div className="flex-1 space-y-4 px-4">{children}</div>
        {footer && <SheetFooter className="px-4 pb-4">{footer}</SheetFooter>}
      </SheetContent>
    </Sheet>
  );
}
