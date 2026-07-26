import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export type SectionCardProps = {
  title?: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  /** Right-aligned controls in the card header (a toggle, a count, a small button). */
  action?: ReactNode;
  children: ReactNode;
  /** Removes the content padding — use when the card wraps a full-bleed table. */
  flush?: boolean;
  className?: string;
  contentClassName?: string;
};

/**
 * A titled content block. Wraps the shadcn Card with consistent padding and header
 * layout so sections stop drifting apart page to page.
 */
export function SectionCard({
  title,
  description,
  icon,
  action,
  children,
  flush = false,
  className,
  contentClassName,
}: SectionCardProps) {
  return (
    <Card className={cn("shadow-[var(--shadow-card)]", className)}>
      {(title || action) && (
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 pb-3">
          <div className="min-w-0 space-y-1">
            {title && (
              <CardTitle className="flex items-center gap-2 text-base">
                {icon}
                {title}
              </CardTitle>
            )}
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </CardHeader>
      )}
      <CardContent
        className={cn(
          flush ? "p-0" : "p-[var(--space-card)]",
          (title || action) && !flush && "pt-0",
          contentClassName
        )}
      >
        {children}
      </CardContent>
    </Card>
  );
}
