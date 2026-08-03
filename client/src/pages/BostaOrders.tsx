import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eye, Printer } from "lucide-react";
import {
  PageHeader,
  StatCard,
  SearchInput,
  ResponsiveDataTable,
  type Column,
  MobileOrderCard,
  Pagination,
  WhatsAppButton,
} from "@/components/shared";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useGovernorateOptions } from "@/hooks/useGovernorateOptions";

type BostaCategory =
  | "sent_today"
  | "awaiting_update"
  | "in_transit"
  | "delivered"
  | "returned"
  | "send_failed";

const CATEGORY_LABELS: Record<BostaCategory, string> = {
  sent_today: "أُرسلت اليوم",
  in_transit: "في الطريق",
  delivered: "تم التسليم",
  returned: "مرتجع",
  send_failed: "فشل الإرسال",
  awaiting_update: "بانتظار التحديث",
};

function categorizeOrder(order: any): BostaCategory {
  if (order.bostaLastError && !order.bostaShipmentId) return "send_failed";
  if (order.status === "delivered") return "delivered";
  if (order.status === "returned") return "returned";
  if (order.status === "shipped") return "in_transit";
  return "awaiting_update";
}

const CATEGORY_TONE: Record<BostaCategory, { bg: string; text: string }> = {
  sent_today: { bg: "bg-accent", text: "text-accent-foreground" },
  in_transit: { bg: "bg-[var(--info)]/10", text: "text-[var(--info)]" },
  delivered: { bg: "bg-[var(--success)]/10", text: "text-[var(--success)]" },
  returned: { bg: "bg-destructive/10", text: "text-destructive" },
  send_failed: { bg: "bg-destructive/10", text: "text-destructive" },
  awaiting_update: {
    bg: "bg-[var(--warning)]/10",
    text: "text-[var(--warning)]",
  },
};

function CategoryBadge({ order }: { order: any }) {
  const cat = categorizeOrder(order);
  const tone = CATEGORY_TONE[cat];
  return (
    <div className="flex flex-col gap-1">
      <span
        className={`inline-flex w-fit items-center px-2 py-0.5 rounded-full text-xs font-medium ${tone.bg} ${tone.text}`}
      >
        {CATEGORY_LABELS[cat]}
      </span>
      {order.bostaStatus && order.bostaStatus !== "sent" && (
        <span className="text-[10px] text-muted-foreground">
          {order.bostaStatus}
        </span>
      )}
    </div>
  );
}

export default function BostaOrders() {
  const { values: GOVERNORATES } = useGovernorateOptions();
  const [, setLocation] = useLocation();
  const { currentBusinessIds } = useBusinessContext();
  const [category, setCategory] = useState<BostaCategory | undefined>(
    undefined
  );
  const [governorate, setGovernorate] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const filters = {
    category,
    governorate,
    search: search.trim() || undefined,
    page,
    limit: 50,
    businessIds: currentBusinessIds,
  };

  const { data: summary } = trpc.orders.bostaOrdersSummary.useQuery({
    businessIds: currentBusinessIds,
  });
  const { data, isLoading } = trpc.orders.bostaOrders.useQuery(filters);

  const bostaOrders = data?.orders ?? [];
  const total = data?.total ?? 0;

  const columns: Column<any>[] = [
    {
      id: "identifier",
      header: "المعرّف",
      alwaysVisible: true,
      cell: order => (
        <div>
          <span className="font-mono text-sm font-bold px-2 py-0.5 rounded bg-muted">
            {order.orderNumber}
          </span>
          {order.bostaShipmentId && (
            <p className="text-[10px] text-muted-foreground font-mono mt-0.5">
              شحنة: {order.bostaShipmentId}
            </p>
          )}
          {order.bostaTrackingNumber && (
            <p className="text-[10px] text-muted-foreground font-mono">
              تتبع: {order.bostaTrackingNumber}
            </p>
          )}
        </div>
      ),
    },
    {
      id: "customer",
      header: "العميل",
      alwaysVisible: true,
      cell: order => (
        <div>
          <p className="font-semibold text-sm">{order.customerName}</p>
          <p className="text-xs text-muted-foreground font-mono" dir="ltr">
            {order.customerPhone}
          </p>
        </div>
      ),
    },
    {
      id: "address",
      header: "العنوان",
      cell: order => (
        <div className="max-w-[220px]">
          <p className="text-sm leading-snug break-words line-clamp-2">
            {order.customerAddress || order.governorate || "—"}
          </p>
          <p className="text-xs text-muted-foreground">{order.governorate}</p>
        </div>
      ),
    },
    {
      id: "product",
      header: "المنتج",
      cell: order => (
        <div className="max-w-[180px]">
          <p className="text-sm break-words line-clamp-2">
            {order.productName}
          </p>
        </div>
      ),
    },
    {
      id: "total",
      header: "المبلغ",
      numeric: true,
      alwaysVisible: true,
      cell: order => (
        <span className="font-bold text-sm">
          {Number(order.totalAmount).toLocaleString("ar-EG")}
        </span>
      ),
    },
    {
      id: "status",
      header: "حالة الشحن",
      alwaysVisible: true,
      cell: order => <CategoryBadge order={order} />,
    },
    {
      id: "sentAt",
      header: "تاريخ الإرسال",
      cell: order => (
        <div className="text-xs text-muted-foreground whitespace-nowrap">
          {order.bostaSentAt
            ? new Date(order.bostaSentAt).toLocaleDateString("ar-EG", {
                year: "numeric",
                month: "numeric",
                day: "numeric",
              })
            : "—"}
        </div>
      ),
    },
    {
      id: "updatedAt",
      header: "آخر تحديث",
      cell: order => (
        <div className="text-xs text-muted-foreground whitespace-nowrap">
          {order.updatedAt
            ? new Date(order.updatedAt).toLocaleDateString("ar-EG", {
                year: "numeric",
                month: "numeric",
                day: "numeric",
              })
            : "—"}
        </div>
      ),
    },
    {
      id: "actions",
      header: "إجراءات",
      alwaysVisible: true,
      sticky: true,
      cell: order => (
        <div className="flex items-center gap-1">
          <WhatsAppButton
            phone={order.customerPhone}
            iconOnly
            size="icon-sm"
            className="h-7 w-7"
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-[var(--info)] hover:bg-[var(--info)]/10"
            onClick={() => setLocation(`/order/${order.id}`)}
            title="عرض تفاصيل الأوردر"
            aria-label="عرض تفاصيل الأوردر"
          >
            <Eye className="h-4 w-4" />
          </Button>
          {order.bostaShipmentId && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-primary hover:bg-primary/10"
              onClick={() =>
                window.open(
                  `/api/orders/${order.id}/bosta-awb`,
                  "_blank",
                  "noopener,noreferrer"
                )
              }
              title="طباعة AWB"
              aria-label="طباعة AWB"
            >
              <Printer className="h-4 w-4" />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="طلبات بوسطة"
        description={`إجمالي: ${total.toLocaleString("ar-EG")} طلب`}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <StatCard
            label="أُرسلت اليوم"
            value={(summary?.sentToday ?? 0).toLocaleString("ar-EG")}
            tone="primary"
            active={category === "sent_today"}
            onClick={() =>
              setCategory(c => (c === "sent_today" ? undefined : "sent_today"))
            }
          />
          <StatCard
            label="في الطريق"
            value={(summary?.inTransit ?? 0).toLocaleString("ar-EG")}
            tone="info"
            active={category === "in_transit"}
            onClick={() =>
              setCategory(c => (c === "in_transit" ? undefined : "in_transit"))
            }
          />
          <StatCard
            label="تم التسليم"
            value={(summary?.delivered ?? 0).toLocaleString("ar-EG")}
            tone="success"
            active={category === "delivered"}
            onClick={() =>
              setCategory(c => (c === "delivered" ? undefined : "delivered"))
            }
          />
          <StatCard
            label="مرتجع"
            value={(summary?.returned ?? 0).toLocaleString("ar-EG")}
            tone="danger"
            active={category === "returned"}
            onClick={() =>
              setCategory(c => (c === "returned" ? undefined : "returned"))
            }
          />
          <StatCard
            label="فشل الإرسال"
            value={(summary?.sendFailed ?? 0).toLocaleString("ar-EG")}
            tone="danger"
            active={category === "send_failed"}
            onClick={() =>
              setCategory(c =>
                c === "send_failed" ? undefined : "send_failed"
              )
            }
          />
          <StatCard
            label="بانتظار التحديث"
            value={(summary?.awaitingUpdate ?? 0).toLocaleString("ar-EG")}
            tone="warning"
            active={category === "awaiting_update"}
            onClick={() =>
              setCategory(c =>
                c === "awaiting_update" ? undefined : "awaiting_update"
              )
            }
          />
        </div>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={search}
          onChange={v => {
            setSearch(v);
            setPage(1);
          }}
          placeholder="بحث برقم التتبع، الهاتف، أو رقم الأوردر"
          className="w-64"
        />
        <Select
          value={governorate ?? "all"}
          onValueChange={v => {
            setGovernorate(v === "all" ? undefined : v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40 h-9">
            <SelectValue placeholder="المحافظة" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل المحافظات</SelectItem>
            {GOVERNORATES.map(g => (
              <SelectItem key={g} value={g}>
                {g}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {category && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCategory(undefined)}
          >
            مسح فلتر الحالة ({CATEGORY_LABELS[category]}) ×
          </Button>
        )}
      </div>

      <ResponsiveDataTable
        rows={bostaOrders}
        columns={columns}
        rowKey={o => o.id}
        loading={isLoading}
        empty={{
          title: "لا توجد طلبات بوسطة",
          description: "لسه مفيش أي أوردر اتبعت لبوسطة يطابق الفلتر الحالي",
        }}
        mobileRow={(order: any) => (
          <MobileOrderCard
            orderNumber={order.orderNumber}
            customerName={order.customerName}
            customerPhone={order.customerPhone}
            governorate={order.governorate}
            statusBadge={<CategoryBadge order={order} />}
            productSummary={order.productName}
            total={`${Number(order.totalAmount).toLocaleString("ar-EG")} ج.م`}
            dateLabel={
              order.bostaSentAt
                ? new Date(order.bostaSentAt).toLocaleDateString("ar-EG", {
                    day: "numeric",
                    month: "short",
                  })
                : undefined
            }
            expanded={false}
            onToggle={() => {}}
            details={
              <div className="flex flex-wrap gap-1.5">
                <WhatsAppButton phone={order.customerPhone} size="sm" />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 gap-1"
                  onClick={() => setLocation(`/order/${order.id}`)}
                >
                  <Eye className="h-3.5 w-3.5" /> تفاصيل
                </Button>
                {order.bostaShipmentId && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1"
                    onClick={() =>
                      window.open(
                        `/api/orders/${order.id}/bosta-awb`,
                        "_blank",
                        "noopener,noreferrer"
                      )
                    }
                  >
                    <Printer className="h-3.5 w-3.5" /> AWB
                  </Button>
                )}
              </div>
            }
          />
        )}
      />

      {total > 50 && (
        <Pagination
          page={page}
          pageSize={50}
          total={total}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
