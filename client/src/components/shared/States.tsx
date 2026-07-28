import type { ReactNode } from "react";
import { AlertTriangle, Inbox, Lock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * The three states every data view needs and most pages were missing: nothing yet,
 * something broke, and still loading. Blank screens with no explanation were the norm.
 */

export type EmptyStateProps = {
  title: string;
  /** Say what to do next, not just that there is nothing. */
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
};

/**
 * Empty state carries the most brand of any system surface — it is the one moment the product
 * has nothing to show and therefore only its own character to show. Built from the brand book:
 * the §22 dot-grid texture, a purple-tinted icon tile (§19 illustration is purple+navy only,
 * flat and outlined), the §16 `lg` radius reserved for hero surfaces, and the generous
 * whitespace the identity asks for.
 */
export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "bg-dot-grid flex flex-col items-center justify-center gap-4 rounded-[var(--radius-brand-lg)]",
        "border border-border bg-card/60 px-6 py-16 text-center",
        className
      )}
    >
      <span
        className={cn(
          "flex h-14 w-14 items-center justify-center rounded-[var(--radius-brand-lg)]",
          "bg-accent text-accent-foreground ring-1 ring-primary/15"
        )}
        aria-hidden="true"
      >
        {icon ?? <Inbox className="h-7 w-7" />}
      </span>
      <div className="space-y-1.5">
        <p className="type-subheading">{title}</p>
        {description && (
          <p className="mx-auto max-w-sm type-body text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

export type ErrorStateProps = {
  title?: string;
  /** User-facing Arabic message. Never pass a raw stack trace or provider error here. */
  message?: string;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
};

export function ErrorState({
  title = "تعذّر تحميل البيانات",
  message,
  onRetry,
  retrying = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-[var(--radius-brand-md)] border border-destructive/30 bg-destructive/5 px-6 py-10 text-center",
        className
      )}
      role="alert"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-6 w-6" />
      </span>
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {message && (
          <p className="mx-auto max-w-md text-sm text-muted-foreground">{message}</p>
        )}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying} className="gap-1">
          <RefreshCw className={cn("h-3.5 w-3.5", retrying && "animate-spin")} />
          إعادة المحاولة
        </Button>
      )}
    </div>
  );
}

/** Shown instead of a page the current role may not open. */
export function PermissionDeniedState({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-[var(--radius-brand-md)] border border-border px-6 py-12 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Lock className="h-6 w-6" />
      </span>
      <div className="space-y-1">
        <p className="font-medium">لا تملك صلاحية الوصول</p>
        <p className="mx-auto max-w-sm text-sm text-muted-foreground">
          {message ?? "هذه الصفحة متاحة لأدوار محددة. راجع مدير النظام إذا كنت تحتاجها."}
        </p>
      </div>
    </div>
  );
}

export type LoadingSkeletonProps = {
  /** `table` for row lists, `cards` for card grids, `form` for field stacks. */
  variant?: "table" | "cards" | "form";
  rows?: number;
  className?: string;
};

export function LoadingSkeleton({ variant = "table", rows = 5, className }: LoadingSkeletonProps) {
  // Every variant announces itself, not just the table one: a screen-reader user waiting on a
  // card grid or a form got silence before. `aria-busy` + a single visually-hidden label is
  // enough — the individual bones are decorative and stay hidden.
  const a11y = {
    "aria-busy": true as const,
    "aria-live": "polite" as const,
    role: "status" as const,
  };
  const srLabel = <span className="sr-only">جاري التحميل…</span>;

  if (variant === "cards") {
    return (
      <div className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-3", className)} {...a11y}>
        {srLabel}
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} aria-hidden="true" className="space-y-2 rounded-[var(--radius-brand-md)] border border-border p-4">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        ))}
      </div>
    );
  }

  if (variant === "form") {
    return (
      <div className={cn("space-y-4", className)} {...a11y}>
        {srLabel}
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} aria-hidden="true" className="space-y-1.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-10 w-full" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)} {...a11y}>
      {srLabel}
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="flex items-center gap-3 rounded-[var(--radius-brand-md)] border border-border p-3"
        >
          <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
          <Skeleton className="h-6 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}
