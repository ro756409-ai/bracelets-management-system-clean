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
 *
 * Matjarak 2.0 (1C-5C): تحت v2 فقط — مسافات أوسع بين الأيقونة والعنوان والوصف، والأيقونة في مساحة ناعمة rounded-xl
 * (نفس زوايا أيقونات StatCard)، والإجراءات مسموح لها تلتف جنب العنوان بدل ما تدفع الصف خارج الشاشة.
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
    <header className={cn("space-y-4 brand-v2:space-y-5", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between brand-v2:gap-4">
        <div className="flex min-w-0 items-start gap-3 brand-v2:gap-3.5">
          {icon && (
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)] bg-accent text-accent-foreground brand-v2:mt-0 brand-v2:h-10 brand-v2:w-10 brand-v2:rounded-xl brand-v2:sm:h-11 brand-v2:sm:w-11">
              {icon}
            </span>
          )}
          <div className="min-w-0 space-y-1 brand-v2:space-y-1.5">
            {/* No truncation: an Arabic page title must be readable in full. */}
            <h1 className="text-xl font-bold sm:text-2xl brand-v2:text-2xl brand-v2:sm:text-[28px]">{title}</h1>
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>

        {(primaryAction || actions) && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 [&>*]:flex-1 sm:[&>*]:flex-none brand-v2:min-w-0 brand-v2:sm:shrink brand-v2:sm:justify-end">
            {actions}
            {primaryAction}
          </div>
        )}
      </div>
      {children}
    </header>
  );
}
