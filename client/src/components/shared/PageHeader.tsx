import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type PageHeaderProps = {
  title: string;
  /** One line saying what the page is for — every page should answer this. */
  description?: string;
  icon?: ReactNode;
  /** The single most important action. Keep it to one; everything else goes in `actions`. */
  primaryAction?: ReactNode;
  /** Secondary actions — prefer an overflow menu once there are more than two. */
  actions?: ReactNode;
  /** Stat cards or tabs rendered under the title block. */
  children?: ReactNode;
  className?: string;
};

/**
 * Standard page heading. Titles, descriptions and action placement were hand-rolled on
 * every page, so no two agreed on spacing or on which button looked primary.
 *
 * On mobile the actions drop below the title and stretch, rather than being squeezed
 * next to a long Arabic heading.
 */
export function PageHeader({
  title,
  description,
  icon,
  primaryAction,
  actions,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn("space-y-4", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {icon && (
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)] bg-accent text-accent-foreground">
              {icon}
            </span>
          )}
          <div className="min-w-0 space-y-1">
            {/* No truncation: an Arabic page title must be readable in full. */}
            <h1 className="text-xl font-bold sm:text-2xl">{title}</h1>
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>

        {(primaryAction || actions) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 [&>*]:flex-1 sm:[&>*]:flex-none">
            {actions}
            {primaryAction}
          </div>
        )}
      </div>
      {children}
    </header>
  );
}
