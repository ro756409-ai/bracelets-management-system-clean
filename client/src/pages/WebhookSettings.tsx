import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { SetupJourney } from "@/components/SetupJourney";
import { PartnerLogo } from "@/components/brand/PartnerLogo";
import { PageHeader, StatCard, SectionCard, StatusBadge, SearchInput, EmptyState, LoadingSkeleton, OfflineState } from "@/components/shared";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import {
  Copy, CheckCircle, XCircle, AlertCircle, RefreshCw, Zap,
  Package, Phone, MapPin, Calendar, ChevronDown, Info, Check, ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";

const WEBHOOK_URL = `${window.location.origin}/api/webhooks/easyorder`;
const TOUCH = "min-h-11 md:min-h-9";

const STATUS_META: Record<string, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral"; icon: typeof CheckCircle }> = {
  success: { label: "نجح", tone: "success", icon: CheckCircle },
  duplicate: { label: "مكرر", tone: "warning", icon: AlertCircle },
  error: { label: "خطأ", tone: "danger", icon: XCircle },
  status_update: { label: "تحديث حالة", tone: "info", icon: Zap },
};

function EventStatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status];
  const Icon = meta?.icon ?? Info;
  return <StatusBadge status={status} label={meta?.label ?? status} tone={meta?.tone ?? "neutral"} size="sm" icon={<Icon className="h-3 w-3" aria-hidden="true" />} />;
}

function formatTime(val: string | Date | null | undefined): string {
  if (!val) return "—";
  try {
    return new Date(val as string).toLocaleString("ar-EG", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return String(val);
  }
}

function LogRow({ entry }: { entry: any }) {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[entry.status];
  const Icon = meta?.icon ?? Info;
  const toneClass = meta?.tone === "success" ? "text-[var(--success)]" : meta?.tone === "warning" ? "text-[var(--warning)]" : meta?.tone === "danger" ? "text-destructive" : meta?.tone === "info" ? "text-[var(--info)]" : "text-muted-foreground";

  return (
    <li className="overflow-hidden rounded-[var(--radius-brand-md)] border border-border bg-card" data-testid={`webhook-log-${entry.id}`}>
      <button
        type="button"
        className="flex min-h-11 w-full items-start gap-3 p-3 text-start transition-colors duration-[var(--duration-fast)] hover:bg-muted/30"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-controls={`webhook-log-details-${entry.id}`}
      >
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${toneClass}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <EventStatusBadge status={entry.status} />
            {entry.customerName && (
              <span className="text-sm font-semibold text-foreground">{entry.customerName}</span>
            )}
            {entry.externalOrderId && (
              <span className="rounded-[var(--radius-brand-sm,0.375rem)] bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground" dir="ltr">
                #{entry.externalOrderId}
              </span>
            )}
            {entry.governorate && (
              <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                <MapPin className="h-3 w-3" aria-hidden="true" />{entry.governorate}
              </span>
            )}
            {entry.importedCount != null && entry.importedCount > 0 && (
              <span className="flex items-center gap-0.5 rounded-[var(--radius-brand-sm,0.375rem)] bg-[var(--success)]/10 px-1.5 py-0.5 text-xs text-[var(--success)]">
                <Package className="h-3 w-3" aria-hidden="true" />{entry.importedCount} أوردر
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-xs text-muted-foreground">{entry.message}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">{formatTime(entry.receivedAt)}</span>
          <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-[var(--duration-fast)] ${expanded ? "rotate-180" : ""}`} aria-hidden="true" />
        </div>
      </button>

      {expanded && (
        <div id={`webhook-log-details-${entry.id}`} className="space-y-2 border-t border-border bg-muted/20 p-3 text-sm" dir="rtl">
          <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
            {entry.customerPhone && (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Phone className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="font-mono" dir="ltr">{entry.customerPhone}</span>
              </div>
            )}
            {entry.totalAmount && (
              <div className="text-muted-foreground">
                <span className="font-medium">الإجمالي: </span>
                <span className="tabular-nums">{Number(entry.totalAmount).toLocaleString("ar-EG")} ج.م</span>
              </div>
            )}
            {entry.itemsCount != null && (
              <div className="text-muted-foreground">
                <span className="font-medium">عدد المنتجات: </span>
                <span className="tabular-nums">{entry.itemsCount}</span>
              </div>
            )}
            {entry.eventType && (
              <div className="text-muted-foreground">
                <span className="font-medium">نوع الحدث: </span>
                <span className="font-mono" dir="ltr">{entry.eventType}</span>
              </div>
            )}
          </div>
          {entry.rawPayload && (
            <details className="mt-2">
              <summary className="min-h-11 cursor-pointer text-xs text-muted-foreground hover:text-foreground md:min-h-0">
                عرض الـ Payload الكامل
              </summary>
              <pre className="ltr mt-2 max-h-40 overflow-x-auto rounded-[var(--radius-brand-sm,0.375rem)] border border-border bg-background p-2 text-left text-xs">
                {(() => {
                  try { return JSON.stringify(JSON.parse(entry.rawPayload), null, 2); }
                  catch { return entry.rawPayload; }
                })()}
              </pre>
            </details>
          )}
        </div>
      )}
    </li>
  );
}

const FILTERS = [
  { key: "all", label: "الكل" },
  { key: "success", label: "نجح" },
  { key: "duplicate", label: "مكرر" },
  { key: "error", label: "خطأ" },
  { key: "status_update", label: "تحديث حالة" },
];

/**
 * سجل Easy Order (Webhook) — نفس الاستعلام (webhook.log كل 30 ثانية) ونفس الفلاتر والبحث والإحصاءات.
 * المرحلة 7H (عرض فقط): PageHeader بشعار EasyOrder الرسمي، بطاقات إحصاء تعمل كفلتر، خطوات الإعداد في
 * قسم قابل للطي بزر aria-expanded، الـSecret لا يُعرض أبدًا، صفوف السجل أزرار 44px مع تفاصيل، وحالات
 * Loading/Empty/Offline.
 */
export default function WebhookSettings() {
  const [copied, setCopied] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const online = useOnlineStatus();

  const { data, isLoading, refetch, isFetching } = trpc.webhook.log.useQuery(undefined, {
    refetchInterval: 30_000,
  });

  const log = data?.log ?? [];

  // Stats
  const stats = useMemo(() => ({
    total: log.length,
    success: log.filter(e => e.status === "success").length,
    duplicate: log.filter(e => e.status === "duplicate").length,
    error: log.filter(e => e.status === "error").length,
    statusUpdate: log.filter(e => e.status === "status_update").length,
  }), [log]);

  // Filtered log
  const filtered = useMemo(() => {
    return log.filter(e => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        return (
          (e.customerName?.toLowerCase().includes(q)) ||
          (e.externalOrderId?.toLowerCase().includes(q)) ||
          (e.customerPhone?.includes(q)) ||
          (e.governorate?.includes(q)) ||
          (e.message?.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [log, statusFilter, search]);

  function copyUrl() {
    navigator.clipboard.writeText(WEBHOOK_URL);
    setCopied(true);
    toast.success("تم نسخ الـ URL");
    setTimeout(() => setCopied(false), 2000);
  }

  const toggleFilter = (key: string) => setStatusFilter(statusFilter === key ? "all" : key);

  return (
    <div className="mx-auto max-w-5xl space-y-6" dir="rtl" data-testid="webhook-settings-page">
      <PageHeader
        title="سجل Easy Order"
        description="إعداد ومتابعة ربط Easy Order: كل الأوردرات الواردة عبر الـWebhook مسجّلة هنا بشكل دائم — حتى بعد إعادة تشغيل السيرفر. لإضافة/تعديل بيانات الربط، افتح قناة EasyOrder من صفحة قنوات البيع."
        icon={<PartnerLogo partner="easyorders" size="sm" decorative />}
        actions={
          <Button variant="outline" size="sm" className={TOUCH} onClick={() => refetch()} disabled={isFetching} data-testid="webhook-refresh">
            <RefreshCw className={`h-4 w-4 ml-1 ${isFetching ? "animate-spin" : ""}`} aria-hidden="true" />
            تحديث
          </Button>
        }
      >
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="إحصاءات الأحداث" data-testid="webhook-stats">
          <StatCard label="إجمالي الأحداث" value={stats.total.toLocaleString("ar-EG")} hint="من webhook.log" active={statusFilter === "all"} onClick={() => setStatusFilter("all")} loading={isLoading} />
          <StatCard label="أوردر استُقبل" value={stats.success.toLocaleString("ar-EG")} tone="success" active={statusFilter === "success"} onClick={() => toggleFilter("success")} loading={isLoading} />
          <StatCard label="مكرر (تم تخطيه)" value={stats.duplicate.toLocaleString("ar-EG")} tone="warning" active={statusFilter === "duplicate"} onClick={() => toggleFilter("duplicate")} loading={isLoading} />
          <StatCard label="خطأ" value={stats.error.toLocaleString("ar-EG")} tone="danger" active={statusFilter === "error"} onClick={() => toggleFilter("error")} loading={isLoading} />
        </section>
      </PageHeader>

      <SetupJourney current="easyorder" />

      {!online && <OfflineState onRetry={() => refetch()} className="py-6" />}

      {/* Setup Section (collapsible) */}
      <SectionCard
        title={<span className="inline-flex items-center gap-2"><Zap className="h-4 w-4 text-primary" aria-hidden="true" /> إعداد الـ Webhook في Easy Order</span>}
        action={<Button variant="ghost" size="sm" className={`${TOUCH} gap-1`} onClick={() => setShowSetup(!showSetup)} aria-expanded={showSetup} aria-controls="webhook-setup" data-testid="webhook-setup-toggle"><ChevronDown className={`h-4 w-4 transition-transform duration-[var(--duration-fast)] ${showSetup ? "rotate-180" : ""}`} aria-hidden="true" /> {showSetup ? "إخفاء الخطوات" : "عرض الخطوات"}</Button>}
        testId="webhook-setup-card"
      >
        {showSetup ? (
          <div id="webhook-setup" className="space-y-4">
            <ol className="list-inside list-decimal space-y-2 text-sm text-muted-foreground">
              <li>افتح حساب Easy Order ← الإعدادات ← Public API ← Webhooks</li>
              <li>اضغط "إنشاء Webhook"</li>
              <li>انسخ الـ URL التالي وضعه في خانة URL</li>
              <li>استخدم الـ Secret المحفوظ في إعدادات قناة البيع كـ query parameter أو header</li>
              <li>اختر النوع: <strong>Orders</strong></li>
              <li>احفظ — الأوردرات الجديدة ستصل تلقائيًا</li>
            </ol>
            <div className="flex items-start gap-2 rounded-[var(--radius-brand-md)] border border-[var(--warning)]/30 bg-[var(--warning)]/10 p-3 text-sm text-[var(--warning)]">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p><strong>مهم:</strong> النظام لا يعرض الـ Secret في المتصفح. اضبطه من إعدادات قناة البيع فقط.</p>
            </div>
            <div className="flex items-center gap-2 rounded-[var(--radius-brand-md)] border border-border bg-muted p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground" dir="ltr" data-testid="webhook-url">
                {WEBHOOK_URL}
              </code>
              <Button variant="outline" size="sm" onClick={copyUrl} className={`${TOUCH} shrink-0`} data-testid="webhook-copy">
                {copied ? <Check className="h-4 w-4 text-[var(--success)]" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                {copied ? "تم النسخ" : "نسخ"}
              </Button>
            </div>
            <div className="flex items-start gap-2 rounded-[var(--radius-brand-md)] border border-[var(--info)]/30 bg-[var(--info)]/10 p-3 text-sm text-[var(--info)]">
              <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p><strong>ملاحظة:</strong> الطلبات من غير Secret مربوط بقناة نشطة يتم رفضها لحماية عزل بيانات التجار.</p>
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">خطوات الربط ورابط الـWebhook — اضغط «عرض الخطوات».</p>
        )}
      </SectionCard>

      {/* Log Section */}
      <SectionCard
        title={<span className="inline-flex items-center gap-2"><Calendar className="h-4 w-4" aria-hidden="true" /> سجل الأحداث {filtered.length !== log.length && <StatusBadge status="count" label={`${filtered.length.toLocaleString("ar-EG")} من ${log.length.toLocaleString("ar-EG")}`} tone="neutral" size="sm" icon={null} />}</span>}
        testId="webhook-log"
      >
        {/* Filters */}
        <div className="mb-4 flex flex-wrap items-center gap-2" data-testid="webhook-filters">
          <SearchInput value={search} onChange={setSearch} placeholder="بحث بالاسم أو التليفون أو رقم الأوردر..." className="w-full sm:max-w-xs" />
          <div className="flex flex-wrap gap-1" role="group" aria-label="فلتر الحالة">
            {FILTERS.map(f => (
              <Button
                key={f.key}
                variant={statusFilter === f.key ? "default" : "outline"}
                size="sm"
                className={`${TOUCH} rounded-[var(--radius-brand-pill)] text-xs`}
                aria-pressed={statusFilter === f.key}
                onClick={() => setStatusFilter(f.key)}
                data-testid={`webhook-filter-${f.key}`}
              >
                {f.label}
              </Button>
            ))}
          </div>
        </div>
        {isLoading ? (
          <LoadingSkeleton variant="table" rows={4} />
        ) : filtered.length === 0 ? (
          log.length === 0 ? (
            <EmptyState icon={<Zap className="h-6 w-6" aria-hidden="true" />} title="لم يصل أي Webhook بعد" description="بعد إعداد الـ Webhook في Easy Order، ستظهر الأوردرات هنا تلقائيًا وتُحفظ في قاعدة البيانات" />
          ) : (
            <EmptyState title="لا توجد نتائج تطابق الفلتر" description="عدّل البحث أو اختر حالة أخرى." />
          )
        ) : (
          <ul className="space-y-2">
            {filtered.map((entry) => (
              <LogRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
