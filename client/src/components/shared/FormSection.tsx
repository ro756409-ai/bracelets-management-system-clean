import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type FormSectionProps = {
  title?: string;
  description?: string;
  /** 1 column on mobile always; this controls tablet/desktop. */
  columns?: 1 | 2 | 3;
  children: ReactNode;
  className?: string;
};

const COLS: Record<1 | 2 | 3, string> = {
  1: "sm:grid-cols-1",
  2: "sm:grid-cols-2",
  3: "sm:grid-cols-2 lg:grid-cols-3",
};

/**
 * A titled group of fields inside a form, laid out on a responsive grid: one column on
 * mobile always, so a long Arabic label and its input never fight for a half-width column
 * on a 360px screen.
 */
export function FormSection({
  title,
  description,
  columns = 2,
  children,
  className,
}: FormSectionProps) {
  return (
    <section className={cn("space-y-3", className)}>
      {(title || description) && (
        <div className="space-y-0.5">
          {title && <h3 className="text-sm font-semibold">{title}</h3>}
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      )}
      <div className={cn("grid grid-cols-1 gap-4", COLS[columns])}>{children}</div>
    </section>
  );
}

/** A single field slot — label, control, help/error text, required indicator. */
export function FormField({
  label,
  htmlFor,
  required,
  error,
  hint,
  children,
  /** Field should span every column of its FormSection (e.g. a long address or notes box). */
  span,
  className,
}: {
  label: string;
  htmlFor?: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: ReactNode;
  span?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", span && "sm:col-span-full", className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label}
        {required && <span className="mr-1 text-destructive">*</span>}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
