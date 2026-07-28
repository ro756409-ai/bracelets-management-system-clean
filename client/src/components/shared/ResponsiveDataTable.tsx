import { useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown, Columns3 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingSkeleton } from "./States";

export type Density = "comfortable" | "compact";

export type Column<T> = {
  /** Stable id, also used for column-visibility state. */
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Enables the sort control on this column's header. */
  sortable?: boolean;
  /** Right-align numeric columns and give them tabular figures. */
  numeric?: boolean;
  /** Keeps the column pinned while the table scrolls horizontally. */
  sticky?: boolean;
  /** Never offered in the column-visibility menu (e.g. the actions column). */
  alwaysVisible?: boolean;
  /** Hidden until the user opts in via the column menu. */
  defaultHidden?: boolean;
  className?: string;
  headerClassName?: string;
};

export type SortState = { column: string; direction: "asc" | "desc" } | null;

export type ResponsiveDataTableProps<T> = {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string | number;

  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;

  empty?: { title: string; description?: string; action?: ReactNode };

  density?: Density;

  sort?: SortState;
  onSortChange?: (sort: SortState) => void;

  /** Row selection. Omit both to disable selection entirely. */
  selectedKeys?: Set<string | number>;
  onSelectionChange?: (keys: Set<string | number>) => void;

  onRowClick?: (row: T) => void;

  /** Column ids currently hidden. Omit to disable the visibility menu. */
  hiddenColumns?: Set<string>;
  onHiddenColumnsChange?: (hidden: Set<string>) => void;

  /**
   * Rendered instead of the table below `lg`. Without this the table still renders and
   * scrolls inside its own container — but a card list is almost always better on a phone.
   */
  mobileRow?: (row: T) => ReactNode;

  /** Toolbar content shown above the table (density switch, exports…). */
  toolbar?: ReactNode;

  /**
   * Rendered in a bar that only appears while rows are selected. Lives here rather than in
   * each page so every table in the product surfaces bulk actions the same way — and so the
   * "N selected / clear" affordance is written once.
   */
  bulkActions?: (selected: Set<string | number>) => ReactNode;

  className?: string;
};

const ROW_H: Record<Density, string> = {
  comfortable: "h-[var(--row-h-comfortable)]",
  compact: "h-[var(--row-h-compact)]",
};

/**
 * The shared table. Sixteen pages hand-rolled a `<table>` inside `overflow-x-auto`, which
 * on a phone meant dragging a 9-column grid sideways to read a customer's name.
 *
 * Behaviour worth knowing:
 * - Sorting is *controlled*: this component reports intent, the page decides how to sort.
 *   That keeps server-side sorting and client-side sorting on the same interface.
 * - Below `lg`, `mobileRow` replaces the table wholesale. The table itself never causes
 *   page-level horizontal scroll — it scrolls inside its own container.
 * - The header is sticky so column meaning survives a long list.
 */
export function ResponsiveDataTable<T>({
  rows,
  columns,
  rowKey,
  loading = false,
  error = null,
  onRetry,
  empty,
  density = "comfortable",
  sort = null,
  onSortChange,
  selectedKeys,
  onSelectionChange,
  onRowClick,
  hiddenColumns,
  onHiddenColumnsChange,
  mobileRow,
  toolbar,
  bulkActions,
  className,
}: ResponsiveDataTableProps<T>) {
  const selectable = Boolean(selectedKeys && onSelectionChange);

  // Roving-tabindex keyboard navigation. A data table is a grid, not a list of links: only one
  // row is in the tab order at a time, and ↑/↓ moves within it. Without this, tabbing through a
  // 50-row table means 50 stops before reaching the pagination.
  const [focusedRow, setFocusedRow] = useState(0);
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);

  const moveFocus = (to: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, to));
    setFocusedRow(clamped);
    rowRefs.current[clamped]?.focus();
  };

  const visibleColumns = useMemo(
    () => columns.filter((c) => c.alwaysVisible || !hiddenColumns?.has(c.id)),
    [columns, hiddenColumns]
  );

  const allSelected =
    selectable && rows.length > 0 && rows.every((r) => selectedKeys!.has(rowKey(r)));
  const someSelected =
    selectable && rows.some((r) => selectedKeys!.has(rowKey(r))) && !allSelected;

  const toggleAll = () => {
    if (!selectable) return;
    const next = new Set(selectedKeys);
    if (allSelected) {
      rows.forEach((r) => next.delete(rowKey(r)));
    } else {
      rows.forEach((r) => next.add(rowKey(r)));
    }
    onSelectionChange!(next);
  };

  // Shift-click range selection. Was hand-rolled inside the Orders page against a raw
  // <input type="checkbox">; promoted here so every table gets it and no page re-implements
  // selection. `shiftHeld` is captured on mousedown because Radix's onCheckedChange only
  // reports the next checked state, not the originating mouse event.
  const lastSelectedIndex = useRef<number | null>(null);
  const shiftHeld = useRef(false);

  const toggleRow = (key: string | number, index?: number) => {
    if (!selectable) return;
    const next = new Set(selectedKeys);

    if (shiftHeld.current && lastSelectedIndex.current !== null && index !== undefined) {
      const [from, to] = [lastSelectedIndex.current, index].sort((a, b) => a - b);
      for (let i = from; i <= to; i++) next.add(rowKey(rows[i]));
    } else {
      if (next.has(key)) next.delete(key);
      else next.add(key);
      if (index !== undefined) lastSelectedIndex.current = index;
    }

    onSelectionChange!(next);
  };

  const handleSort = (columnId: string) => {
    if (!onSortChange) return;
    if (sort?.column !== columnId) {
      onSortChange({ column: columnId, direction: "asc" });
    } else if (sort.direction === "asc") {
      onSortChange({ column: columnId, direction: "desc" });
    } else {
      onSortChange(null); // third click clears the sort
    }
  };

  if (error) {
    return <ErrorState message={error} onRetry={onRetry} />;
  }

  if (loading) {
    return (
      <div className={className}>
        {toolbar}
        <LoadingSkeleton variant="table" rows={6} />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className={cn("space-y-3", className)}>
        {toolbar}
        <EmptyState
          title={empty?.title ?? "لا توجد بيانات"}
          description={empty?.description}
          action={empty?.action}
        />
      </div>
    );
  }

  return (
    <div className={cn("space-y-3", className)}>
      {(toolbar || onHiddenColumnsChange) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">{toolbar}</div>
          {onHiddenColumnsChange && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="hidden h-9 gap-1.5 lg:inline-flex">
                  <Columns3 className="h-4 w-4" />
                  الأعمدة
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>إظهار الأعمدة</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {columns
                  .filter((c) => !c.alwaysVisible)
                  .map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.id}
                      checked={!hiddenColumns?.has(c.id)}
                      onCheckedChange={(checked) => {
                        const next = new Set(hiddenColumns);
                        if (checked) next.delete(c.id);
                        else next.add(c.id);
                        onHiddenColumnsChange(next);
                      }}
                    >
                      {typeof c.header === "string" ? c.header : c.id}
                    </DropdownMenuCheckboxItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}

      {/* Bulk-action bar — only present while something is selected, so it never occupies
          vertical space during normal scanning. */}
      {selectable && bulkActions && selectedKeys!.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-brand-md)] border border-primary/30 bg-accent px-3 py-2">
          <span className="text-sm font-semibold text-accent-foreground tabular-nums">
            {selectedKeys!.size.toLocaleString("ar-EG")} محدد
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-accent-foreground hover:bg-primary/10"
            onClick={() => onSelectionChange!(new Set())}
          >
            إلغاء التحديد
          </Button>
          <span className="mx-1 hidden h-4 w-px bg-primary/20 sm:block" />
          {bulkActions(selectedKeys!)}
        </div>
      )}

      {/* Mobile: card list */}
      {mobileRow && (
        <div className="space-y-2 lg:hidden">
          {rows.map((row) => (
            <div key={rowKey(row)}>{mobileRow(row)}</div>
          ))}
        </div>
      )}

      {/* Desktop table — scrolls inside itself, never widening the page */}
      <div
        className={cn(
          "overflow-x-auto rounded-[var(--radius-brand-md)] border border-border",
          mobileRow && "hidden lg:block"
        )}
      >
        <table className="w-full min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-muted/60 backdrop-blur">
            <tr>
              {selectable && (
                <th className="w-10 px-3 py-2.5 text-right">
                  <Checkbox
                    checked={allSelected || (someSelected && "indeterminate")}
                    onCheckedChange={toggleAll}
                    aria-label="تحديد كل الصفوف"
                  />
                </th>
              )}
              {visibleColumns.map((col) => (
                <th
                  key={col.id}
                  scope="col"
                  className={cn(
                    "px-3 py-2.5 text-right text-xs font-semibold text-muted-foreground",
                    col.numeric && "text-left tabular-nums",
                    col.sticky && "sticky left-0 z-10 bg-muted/60",
                    col.headerClassName
                  )}
                >
                  {col.sortable && onSortChange ? (
                    <button
                      type="button"
                      onClick={() => handleSort(col.id)}
                      className="inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`ترتيب حسب ${typeof col.header === "string" ? col.header : col.id}`}
                    >
                      {col.header}
                      {sort?.column === col.id ? (
                        sort.direction === "asc" ? (
                          <ArrowUp className="h-3 w-3" />
                        ) : (
                          <ArrowDown className="h-3 w-3" />
                        )
                      ) : (
                        <ChevronsUpDown className="h-3 w-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => {
              const key = rowKey(row);
              const isSelected = selectable && selectedKeys!.has(key);
              return (
                <tr
                  key={key}
                  ref={(el) => { rowRefs.current[rowIndex] = el; }}
                  tabIndex={rowIndex === Math.min(focusedRow, rows.length - 1) ? 0 : -1}
                  onFocus={() => setFocusedRow(rowIndex)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowDown") { e.preventDefault(); moveFocus(rowIndex + 1); }
                    else if (e.key === "ArrowUp") { e.preventDefault(); moveFocus(rowIndex - 1); }
                    else if (e.key === "Home") { e.preventDefault(); moveFocus(0); }
                    else if (e.key === "End") { e.preventDefault(); moveFocus(rows.length - 1); }
                    else if (e.key === "Enter" && onRowClick) { e.preventDefault(); onRowClick(row); }
                    // Space toggles selection rather than scrolling — the row is a grid cell here.
                    else if (e.key === " " && selectable) { e.preventDefault(); toggleRow(key); }
                  }}
                  className={cn(
                    "border-t border-border transition-colors duration-[var(--duration-fast)]",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    ROW_H[density],
                    onRowClick && "cursor-pointer",
                    isSelected ? "bg-accent/50" : "hover:bg-muted/40"
                  )}
                >
                  {selectable && (
                    <td className="px-3" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={isSelected}
                        onMouseDown={(e) => { shiftHeld.current = e.shiftKey; }}
                        onCheckedChange={() => toggleRow(key, rowIndex)}
                        aria-label="تحديد الصف"
                      />
                    </td>
                  )}
                  {visibleColumns.map((col) => (
                    <td
                      key={col.id}
                      className={cn(
                        "px-3 py-2 align-middle",
                        col.numeric && "text-left tabular-nums",
                        col.sticky && "sticky left-0 z-[1] bg-card",
                        col.className
                      )}
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
