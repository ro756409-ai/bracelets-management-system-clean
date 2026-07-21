import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Copy, CheckCircle, XCircle, AlertCircle, RefreshCw, Zap,
  Package, Phone, MapPin, Calendar, ChevronDown, ChevronUp, Info
} from "lucide-react";
import { toast } from "sonner";

const WEBHOOK_URL = `${window.location.origin}/api/webhooks/easyorder`;
const WEBHOOK_SECRET = "engzQ2JMRHB4YQ==";
const WEBHOOK_URL_WITH_SECRET = `${WEBHOOK_URL}?secret=${WEBHOOK_SECRET}`;

function StatusBadge({ status }: { status: string }) {
  if (status === "success") return <Badge className="bg-green-100 text-green-800 border-green-200 text-xs">✓ نجح</Badge>;
  if (status === "duplicate") return <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200 text-xs">⟳ مكرر</Badge>;
  if (status === "error") return <Badge className="bg-red-100 text-red-800 border-red-200 text-xs">✗ خطأ</Badge>;
  if (status === "status_update") return <Badge className="bg-blue-100 text-blue-800 border-blue-200 text-xs">↺ تحديث حالة</Badge>;
  return <Badge variant="outline" className="text-xs">{status}</Badge>;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "success") return <CheckCircle className="w-4 h-4 text-green-500 shrink-0 mt-0.5" />;
  if (status === "duplicate") return <AlertCircle className="w-4 h-4 text-yellow-500 shrink-0 mt-0.5" />;
  if (status === "error") return <XCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />;
  if (status === "status_update") return <Zap className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />;
  return <Info className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />;
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

  return (
    <div className="border rounded-lg bg-card overflow-hidden">
      <div
        className="flex items-start gap-3 p-3 hover:bg-muted/30 transition-colors cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusIcon status={entry.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={entry.status} />
            {entry.customerName && (
              <span className="text-sm font-semibold text-foreground">{entry.customerName}</span>
            )}
            {entry.externalOrderId && (
              <span className="text-xs text-muted-foreground font-mono bg-muted px-1.5 py-0.5 rounded">
                #{entry.externalOrderId}
              </span>
            )}
            {entry.governorate && (
              <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                <MapPin className="w-3 h-3" />{entry.governorate}
              </span>
            )}
            {entry.importedCount != null && entry.importedCount > 0 && (
              <span className="text-xs text-green-700 bg-green-50 px-1.5 py-0.5 rounded flex items-center gap-0.5">
                <Package className="w-3 h-3" />{entry.importedCount} أوردر
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">{entry.message}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">{formatTime(entry.receivedAt)}</span>
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
        </div>
      </div>

      {expanded && (
        <div className="border-t bg-muted/20 p-3 space-y-2 text-sm" dir="rtl">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            {entry.customerPhone && (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Phone className="w-3.5 h-3.5" />
                <span className="font-mono">{entry.customerPhone}</span>
              </div>
            )}
            {entry.totalAmount && (
              <div className="text-muted-foreground">
                <span className="font-medium">الإجمالي: </span>
                <span>{Number(entry.totalAmount).toLocaleString("ar-EG")} ج.م</span>
              </div>
            )}
            {entry.itemsCount != null && (
              <div className="text-muted-foreground">
                <span className="font-medium">عدد المنتجات: </span>
                <span>{entry.itemsCount}</span>
              </div>
            )}
            {entry.eventType && (
              <div className="text-muted-foreground">
                <span className="font-medium">نوع الحدث: </span>
                <span className="font-mono">{entry.eventType}</span>
              </div>
            )}
          </div>
          {entry.rawPayload && (
            <details className="mt-2">
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                عرض الـ Payload الكامل
              </summary>
              <pre className="mt-2 text-xs bg-background border rounded p-2 overflow-x-auto max-h-40 text-left ltr">
                {(() => {
                  try { return JSON.stringify(JSON.parse(entry.rawPayload), null, 2); }
                  catch { return entry.rawPayload; }
                })()}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

export default function WebhookSettings() {
  const [copied, setCopied] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [showSetup, setShowSetup] = useState(false);

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

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Zap className="w-6 h-6 text-orange-500" />
            سجل Easy Order
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            كل الأوردرات الواردة من Easy Order محفوظة هنا بشكل دائم — حتى بعد إعادة تشغيل السيرفر
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw className={`w-4 h-4 ml-1 ${isFetching ? "animate-spin" : ""}`} />
          تحديث
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card
          className={`cursor-pointer transition-all ${statusFilter === "all" ? "ring-2 ring-primary" : "hover:shadow-md"}`}
          onClick={() => setStatusFilter("all")}
        >
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-2xl font-bold text-foreground">{stats.total}</div>
            <div className="text-xs text-muted-foreground mt-0.5">إجمالي الأحداث</div>
          </CardContent>
        </Card>
        <Card
          className={`cursor-pointer transition-all ${statusFilter === "success" ? "ring-2 ring-green-500" : "hover:shadow-md"}`}
          onClick={() => setStatusFilter(statusFilter === "success" ? "all" : "success")}
        >
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-2xl font-bold text-green-600">{stats.success}</div>
            <div className="text-xs text-muted-foreground mt-0.5">أوردر استُقبل</div>
          </CardContent>
        </Card>
        <Card
          className={`cursor-pointer transition-all ${statusFilter === "duplicate" ? "ring-2 ring-yellow-500" : "hover:shadow-md"}`}
          onClick={() => setStatusFilter(statusFilter === "duplicate" ? "all" : "duplicate")}
        >
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-2xl font-bold text-yellow-600">{stats.duplicate}</div>
            <div className="text-xs text-muted-foreground mt-0.5">مكرر (تم تخطيه)</div>
          </CardContent>
        </Card>
        <Card
          className={`cursor-pointer transition-all ${statusFilter === "error" ? "ring-2 ring-red-500" : "hover:shadow-md"}`}
          onClick={() => setStatusFilter(statusFilter === "error" ? "all" : "error")}
        >
          <CardContent className="pt-4 pb-3 text-center">
            <div className="text-2xl font-bold text-red-600">{stats.error}</div>
            <div className="text-xs text-muted-foreground mt-0.5">خطأ</div>
          </CardContent>
        </Card>
      </div>

      {/* Setup Section (collapsible) */}
      <Card>
        <CardHeader
          className="cursor-pointer select-none"
          onClick={() => setShowSetup(!showSetup)}
        >
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap className="w-4 h-4 text-orange-500" />
              إعداد الـ Webhook في Easy Order
            </CardTitle>
            {showSetup ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </div>
        </CardHeader>
        {showSetup && (
          <CardContent className="space-y-4 pt-0">
            <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
              <li>افتح حساب Easy Order → الإعدادات → Public API → Webhooks</li>
              <li>اضغط "إنشاء Webhook"</li>
              <li>انسخ الـ URL التالي كاملاً (يتضمن الـ Secret) وضعه في خانة URL</li>
              <li>اختر النوع: <strong>Orders</strong></li>
              <li>احفظ — الأوردرات الجديدة ستصل تلقائيًا</li>
            </ol>
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800 mb-2">
              <strong>مهم:</strong> انسخ الرابط التالي كاملاً — يتضمن الـ Secret مضمنًا في الرابط نفسه
            </div>
            <div className="flex items-center gap-2 p-3 bg-muted rounded-lg border">
              <code className="flex-1 text-xs font-mono text-foreground break-all">
                {WEBHOOK_URL_WITH_SECRET}
              </code>
              <Button variant="outline" size="sm" onClick={() => { navigator.clipboard.writeText(WEBHOOK_URL_WITH_SECRET); toast.success("تم نسخ الرابط الكامل"); }} className="shrink-0">
                <Copy className="w-4 h-4" />
                نسخ
              </Button>
            </div>
            <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
              <strong>ملاحظة:</strong> الـ Secret مدمج في الرابط كـ query parameter — لا تحتاج لإضافة أي إعدادات إضافية.
            </div>
          </CardContent>
        )}
      </Card>

      {/* Log Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="w-4 h-4" />
              سجل الأحداث
              {filtered.length !== log.length && (
                <Badge variant="outline" className="text-xs font-normal">
                  {filtered.length} من {log.length}
                </Badge>
              )}
            </CardTitle>
          </div>
          {/* Filters */}
          <div className="flex gap-2 flex-wrap mt-2">
            <Input
              placeholder="بحث بالاسم أو التليفون أو رقم الأوردر..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="max-w-xs text-sm h-8"
            />
            <div className="flex gap-1">
              {[
                { key: "all", label: "الكل" },
                { key: "success", label: "نجح" },
                { key: "duplicate", label: "مكرر" },
                { key: "error", label: "خطأ" },
                { key: "status_update", label: "تحديث حالة" },
              ].map(f => (
                <Button
                  key={f.key}
                  variant={statusFilter === f.key ? "default" : "outline"}
                  size="sm"
                  className="h-8 text-xs"
                  onClick={() => setStatusFilter(f.key)}
                >
                  {f.label}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="text-center text-muted-foreground py-8">جاري التحميل...</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 space-y-3">
              <Zap className="w-12 h-12 text-muted-foreground/30 mx-auto" />
              {log.length === 0 ? (
                <>
                  <p className="text-muted-foreground font-medium">لم يصل أي Webhook بعد</p>
                  <p className="text-sm text-muted-foreground">
                    بعد إعداد الـ Webhook في Easy Order، ستظهر الأوردرات هنا تلقائيًا وتُحفظ في قاعدة البيانات
                  </p>
                </>
              ) : (
                <p className="text-muted-foreground">لا توجد نتائج تطابق الفلتر</p>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {filtered.map((entry) => (
                <LogRow key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
