/**
 * Matjarak shared UI component library (Phase A of the redesign).
 *
 * These wrap the existing shadcn primitives in `components/ui/` with consistent spacing,
 * brand tokens, and RTL/Arabic behaviour. Pages should compose from here rather than
 * hand-rolling headers, tables, filters, or empty states again.
 */

export { PageHeader, type PageHeaderProps } from "./PageHeader";
export { SectionHeader, type SectionHeaderProps } from "./SectionHeader";
export { SectionCard, type SectionCardProps } from "./SectionCard";
export { StatCard, type StatCardProps, type StatTone } from "./StatCard";
export {
  StatusBadge,
  type StatusBadgeProps,
  type StatusTone,
  ORDER_STATUS,
  ORDER_SOURCE,
  STOCK_STATUS,
} from "./StatusBadge";
export {
  EmptyState,
  type EmptyStateProps,
  ErrorState,
  type ErrorStateProps,
  OfflineState,
  type OfflineStateProps,
  PermissionDeniedState,
  LoadingSkeleton,
  type LoadingSkeletonProps,
} from "./States";
// المرحلة 3 — مكوّنات صفحة الطلبات المعتمدة (Theme Spec §3–§4)؛ غير مربوطة بـOrders.tsx بعد (المرحلة 4)
export { UnderlineTabs, type UnderlineTabsProps, type UnderlineTab } from "./UnderlineTabs";
export { ScopeBar, type ScopeBarProps, type ScopeOption } from "./ScopeBar";
export { ReviewAttentionBanner, type ReviewAttentionBannerProps } from "./ReviewAttentionBanner";
export { OrderToolbar, type OrderToolbarProps, type OrderSearch, type SearchField } from "./OrderToolbar";
export { CustomerCell, type CustomerCellProps } from "./CustomerCell";
export { TwoLineCell, type TwoLineCellProps } from "./TwoLineCell";
export { AttemptsCell, type AttemptsCellProps, UNAVAILABLE_LABEL } from "./AttemptsCell";
export { ReceiptPrediction, type ReceiptPredictionProps, type ReceiptBand, receiptBand, PREDICTION_UNAVAILABLE } from "./ReceiptPrediction";
export { useMediaQuery } from "./useMediaQuery";
export { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";
export { SearchInput, type SearchInputProps, FilterBar, type FilterBarProps } from "./FilterBar";
export {
  isEmptyFilterValue,
  isActiveFilter,
  FILTER_SENTINELS,
  buildFilterChips,
  countActiveFilters,
  clearFilter,
  type FilterChip,
  type FilterDescriptor,
} from "./filterState";
export {
  ResponsiveDataTable,
  type ResponsiveDataTableProps,
  type Column,
  type Density,
  type SortState,
} from "./ResponsiveDataTable";
export { MobileOrderCard, type MobileOrderCardProps } from "./MobileOrderCard";
export { FormSection, FormField, type FormSectionProps } from "./FormSection";
export { StickyActionBar, type StickyActionBarProps } from "./StickyActionBar";
export { Pagination, type PaginationProps, buildPageList } from "./Pagination";
export { DateRangeFilter, type DateRange } from "./DateRangeFilter";
export { MultiSelect, MultiSelectChips, type MultiSelectOption } from "./MultiSelect";
export { Drawer, type DrawerProps, type DrawerWidth } from "./Drawer";
export { toast } from "./toast";
export { InfoTooltip } from "./InfoTooltip";
export { WhatsAppButton, type WhatsAppButtonProps } from "./WhatsAppButton";
export { CommandPalette } from "./CommandPalette";
