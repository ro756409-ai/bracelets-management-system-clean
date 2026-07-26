import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Which page numbers to show around the current page, with `null` standing in for an
 * ellipsis. Pure function so the truncation logic (the fiddly part) is unit-testable
 * without rendering anything.
 *
 * Example: page 7 of 20 → [1, null, 6, 7, 8, null, 20]
 */
export function buildPageList(current: number, total: number, siblings = 1): (number | null)[] {
  if (total <= 0) return [];

  // Below this many pages, an ellipsis would hide fewer pages than it costs in width —
  // just list them all.
  const noEllipsisThreshold = siblings * 2 + 5;
  if (total <= noEllipsisThreshold) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  const pages: (number | null)[] = [];
  const start = Math.max(2, current - siblings);
  const end = Math.min(total - 1, current + siblings);

  pages.push(1);
  if (start > 2) pages.push(null);
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < total - 1) pages.push(null);
  pages.push(total);

  return pages;
}

export type PaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  pageSizeOptions?: number[];
  onPageSizeChange?: (size: number) => void;
  className?: string;
};

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  pageSizeOptions,
  onPageSizeChange,
  className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pages = buildPageList(page, totalPages);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className={className}>
      <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
        <p className="text-xs text-muted-foreground tabular-nums">
          {total === 0 ? "لا نتائج" : `${from}–${to} من ${total}`}
        </p>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            disabled={page <= 1}
            onClick={() => onPageChange(page - 1)}
            aria-label="الصفحة السابقة"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>

          {pages.map((p, i) =>
            p === null ? (
              <span key={`gap-${i}`} className="px-1 text-sm text-muted-foreground">
                …
              </span>
            ) : (
              <Button
                key={p}
                variant={p === page ? "default" : "outline"}
                size="icon"
                className="h-9 w-9 tabular-nums"
                onClick={() => onPageChange(p)}
                aria-current={p === page ? "page" : undefined}
              >
                {p}
              </Button>
            )
          )}

          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9"
            disabled={page >= totalPages}
            onClick={() => onPageChange(page + 1)}
            aria-label="الصفحة التالية"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>

        {pageSizeOptions && onPageSizeChange && (
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
            <SelectTrigger className="h-9 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} / صفحة
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}
