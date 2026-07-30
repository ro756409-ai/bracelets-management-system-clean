import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SectionHeaderProps = {
  /** ما يفعله هذا القسم — سطر واحد، بدون تكرار عنوان الصفحة. */
  description?: string;
  actions?: ReactNode;
  /** بطاقات إحصائيات أو أي محتوى يقف تحت السطر. */
  children?: ReactNode;
  className?: string;
};

/**
 * ترويسة قسم داخل صفحة — مش ترويسة صفحة.
 *
 * `PageHeader` بيرندر عنوان بحجم `type-heading`، وهو صح لما يبقى واحد في الصفحة. لما
 * أربع أقسام بقوا تابات في صفحة واحدة، أربع `PageHeader` كانوا بيدّوا أربع عناوين بنفس
 * وزن عنوان الصفحة، والعين مابقتش تعرف مين الأصل ومين الفرع. القسم هنا مالوش عنوان
 * أصلاً — التاب هو العنوان — وله سطر وصف وأزرار وبطاقات بس.
 */
export function SectionHeader({ description, actions, children, className }: SectionHeaderProps) {
  const hasTopRow = Boolean(description || actions);
  return (
    <div className={cn("space-y-3", className)}>
      {hasTopRow && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {description && <p className="type-body text-muted-foreground">{description}</p>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
