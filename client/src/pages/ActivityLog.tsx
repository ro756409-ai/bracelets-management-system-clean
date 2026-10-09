import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { RefreshCw, Activity, Filter } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { PageHeader, SectionCard, StatusBadge, ResponsiveDataTable, Pagination, OfflineState, type Column } from "@/components/shared";

const ACTION_LABELS: Record<string, string> = {
  confirm_order: "تأكيد أوردر",
  cancel_order: "إلغاء أوردر",
  postpone_order: "تأجيل أوردر",
  assign_orders: "توزيع أوردرات",
  delete_order: "حذف أوردر",
  bulk_delete_orders: "حذف أوردرات",
  edit_order: "تعديل أوردر",
  import_orders: "استيراد أوردرات",
  print_orders: "طباعة أوردرات",
  add_product: "إضافة منتج",
  reclaim_orders: "استرداد أوردرات",
};

const ENTITY_LABELS: Record<string, string> = {
  order: "أوردر",
  product: "منتج",
  employee: "موظف",
  inventory: "مخزون",
};

const ACTION_TONE = (a: string): "success" | "danger" | "warning" | "info" | "neutral" =>
  a === "confirm_order" ? "success" : a === "cancel_order" || a.includes("delete") ? "danger" : a === "postpone_order" ? "warning" : a ? "info" : "neutral";

const TOUCH = "min-h-11 md:min-h-9";
const LIMIT = 50;

/**
 * سجل الأنشطة — نفس الاستعلام (activityLog.list بحد 50 ونطاق النشاط). المرحلة 7I (عرض فقط): PageHeader،
 * فلاتر معنونة 44px («الكل» يعني بلا فلتر — كان يُرسل "all" حرفيًا للسيرفر)، جدول Desktop/بطاقات Mobile،
 * شارات للعملية والدور، ترقيم مشترك، وحالات Loading/Empty/Error/Offline.
 */
export default function ActivityLogPage() {
  const { currentBusinessIds } = useBusinessContext();
  const online = useOnlineStatus();
  const [page, setPage] = useState(1);
  const [actionFilter, setActionFilter] = useState<string>("");
  const [entityFilter, setEntityFilter] = useState<string>("");

  const { data, isLoading, isError, error, refetch } = trpc.activityLog.list.useQuery({
    page,
    limit: LIMIT,
    action: actionFilter && actionFilter !== "all" ? actionFilter : undefined,
    entityType: entityFilter && entityFilter !== "all" ? entityFilter : undefined,
    businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : undefined,
  });

  const formatDate = (date: any) => {
    if (!date) return "-";
    return new Date(date).toLocaleString("ar-EG", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const hasFilters = (actionFilter && actionFilter !== "all") || (entityFilter && entityFilter !== "all");

  const roleBadge = (role: string) => role === "admin"
    ? <StatusBadge status="admin" label="مدير" tone="danger" size="sm" icon={null} />
    : <StatusBadge status="employee" label="موظف" tone="info" size="sm" icon={null} />;
  const actionBadge = (a: string) => <StatusBadge status={a} label={ACTION_LABELS[a] || a} tone={ACTION_TONE(a)} size="sm" icon={null} />;

  const columns: Column<any>[] = [
    { id: "date", header: "التاريخ", alwaysVisible: true, cell: l => <span className="whitespace-nowrap text-xs tabular-nums">{formatDate(l.createdAt)}</span> },
    { id: "action", header: "العملية", alwaysVisible: true, cell: l => actionBadge(l.action) },
    { id: "description", header: "الوصف", alwaysVisible: true, cell: l => <span className="block max-w-[300px] truncate" title={l.description}>{l.description}</span> },
    { id: "by", header: "بواسطة", cell: l => <span className="whitespace-nowrap">{l.performedByName}</span> },
    { id: "role", header: "الدور", cell: l => roleBadge(l.performedByRole) },
  ];

  return (
    <div className="space-y-6" dir="rtl" data-testid="activity-log-page">
      <PageHeader
        title="سجل الأنشطة"
        description="تتبع كل العمليات داخل النظام"
        icon={<Activity className="h-5 w-5" aria-hidden="true" />}
        actions={<Button variant="outline" size="sm" className={TOUCH} onClick={() => refetch()} data-testid="activity-refresh"><RefreshCw className="h-4 w-4 ml-1" aria-hidden="true" /> تحديث</Button>}
      />

      {!online && <OfflineState onRetry={() => refetch()} className="py-6" />}

      {/* Filters */}
      <SectionCard testId="activity-filters">
        <div className="flex flex-wrap items-end gap-3 [&_[role=combobox]]:min-h-[max(2.75rem,44px)] md:[&_[role=combobox]]:min-h-9">
          <Filter className="mb-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <div>
            <Label htmlFor="activity-action" className="mb-1 block text-xs text-muted-foreground">نوع العملية</Label>
            <Select value={actionFilter} onValueChange={v => { setActionFilter(v); setPage(1); }}>
              <SelectTrigger id="activity-action" className="w-[180px]" data-testid="activity-action">
                <SelectValue placeholder="نوع العملية" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                {Object.entries(ACTION_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="activity-entity" className="mb-1 block text-xs text-muted-foreground">نوع الكيان</Label>
            <Select value={entityFilter} onValueChange={v => { setEntityFilter(v); setPage(1); }}>
              <SelectTrigger id="activity-entity" className="w-[180px]" data-testid="activity-entity">
                <SelectValue placeholder="نوع الكيان" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">الكل</SelectItem>
                {Object.entries(ENTITY_LABELS).map(([key, label]) => (
                  <SelectItem key={key} value={key}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {hasFilters && <Button variant="ghost" size="sm" className={TOUCH} onClick={() => { setActionFilter(""); setEntityFilter(""); setPage(1); }}>مسح الفلاتر</Button>}
        </div>
      </SectionCard>

      {/* Log Table */}
      <SectionCard title={<span>{total ? `${total.toLocaleString("ar-EG")} عملية مسجلة` : "لا توجد عمليات مسجلة"}</span>} flush testId="activity-list">
        <ResponsiveDataTable<any>
          rows={items}
          columns={columns}
          rowKey={l => l.id}
          loading={isLoading}
          error={isError ? ((error as any)?.message || "تعذّر تحميل السجل") : null}
          onRetry={() => refetch()}
          empty={{ title: "لا توجد أنشطة مسجلة بعد", description: hasFilters ? "عدّل الفلاتر." : "سيتم تسجيل كل عملية تأكيد أو إلغاء أو توزيع أو حذف تلقائياً" }}
          cardsBelow="md"
          mobileRow={l => (
            <article className="space-y-1.5 rounded-[var(--radius-brand-md)] border border-border bg-card p-3" data-testid={`activity-card-${l.id}`}>
              <div className="flex items-start justify-between gap-2">{actionBadge(l.action)}<span className="text-xs tabular-nums text-muted-foreground">{formatDate(l.createdAt)}</span></div>
              <p className="text-sm">{l.description}</p>
              <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{l.performedByName}</span>{roleBadge(l.performedByRole)}</div>
            </article>
          )}
        />
        {total > LIMIT && <div className="border-t border-border p-3"><Pagination page={page} pageSize={LIMIT} total={total} onPageChange={setPage} /></div>}
      </SectionCard>
    </div>
  );
}
