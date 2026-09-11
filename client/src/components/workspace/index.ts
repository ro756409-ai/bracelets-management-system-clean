/**
 * Matjarak V2 — Workspace toolkit (المرحلة A).
 *
 * نقطة استيراد واحدة لبناء وجهات V2 (الطلبات/المخزون…) بشكل موحّد. المكوّنات الجديدة هنا
 * **بتركّب فوق** المكتبة المشتركة الموجودة (`@/components/shared`) — مفيش تكرار. الصفحات
 * المفروض تستورد من هنا عشان الرأس/التبويبات/شريط الأدوات/الجدول/الحالات تبقى نسخة واحدة.
 */

// إطارات الـWorkspace الجديدة (المرحلة A).
export { WorkspaceShell } from "./WorkspaceShell";
export { DataToolbar } from "./DataToolbar";
export { StatusFilterChips, type StatusChipItem } from "./StatusFilterChips";
export { WorkspaceTabs } from "@/components/shell/WorkspaceTabs";

// إعادة تصدير البدائيات المشتركة المعتمدة للـWorkspaces — مصدر واحد، بدون مكوّنات مكرّرة.
export {
  ResponsiveDataTable, type Column, type SortState,
  StatusBadge, type StatusTone, ORDER_STATUS, ORDER_SOURCE, STOCK_STATUS,
  EmptyState, ErrorState, PermissionDeniedState, LoadingSkeleton,
  PageHeader, SectionCard, SectionHeader,
  Pagination, ConfirmDialog, Drawer,
} from "@/components/shared";
