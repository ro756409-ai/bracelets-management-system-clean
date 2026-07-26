import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Plus, Edit, Trash2, Globe, ExternalLink, Power, PowerOff, KeyRound, Eye, EyeOff, X,
  RefreshCw, CheckCircle2, AlertCircle, Clock, PlugZap, History,
} from "lucide-react";
import { toast } from "sonner";

const PLATFORM_LABELS: Record<string, string> = {
  easyorder: "EasyOrder",
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  whatsapp: "واتساب",
  facebook: "فيسبوك",
  instagram: "إنستجرام",
  manual: "يدوي",
  other: "أخرى",
};

const PLATFORM_COLORS: Record<string, string> = {
  easyorder: "bg-blue-100 text-blue-800",
  shopify: "bg-green-100 text-green-800",
  woocommerce: "bg-purple-100 text-purple-800",
  whatsapp: "bg-emerald-100 text-emerald-800",
  facebook: "bg-indigo-100 text-indigo-800",
  instagram: "bg-pink-100 text-pink-800",
  manual: "bg-gray-100 text-gray-800",
  other: "bg-yellow-100 text-yellow-800",
};

interface ChannelForm {
  name: string;
  domain: string;
  platform: string;
  apiToken: string;
  webhookSecret: string;
  businessId: number | null;
}

const emptyForm: ChannelForm = {
  name: "",
  domain: "",
  platform: "other",
  apiToken: "",
  webhookSecret: "",
  businessId: null,
};

const fmtDateTime = (d: Date) =>
  d.toLocaleString("ar-EG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Credential/connection health, from the read-only connection test.
 * Deliberately separate from sync status: a failed import must not look like broken
 * credentials, and working credentials must not imply a successful import.
 */
function ConnectionStatus({ channel }: { channel: any }) {
  const status = channel.lastConnectionStatus as "never" | "connected" | "failed" | undefined;
  const testedAt = channel.lastConnectionTestAt ? new Date(channel.lastConnectionTestAt) : null;

  const config =
    status === "connected"
      ? { icon: CheckCircle2, cls: "bg-green-100 text-green-700", label: "متصل" }
      : status === "failed"
      ? { icon: AlertCircle, cls: "bg-red-100 text-red-700", label: "فشل الاتصال" }
      : { icon: Clock, cls: "bg-gray-100 text-gray-600", label: "لم يُختبر الاتصال بعد" };
  const Icon = config.icon;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge className={`text-xs gap-1 border-0 ${config.cls}`}>
          <Icon className="h-3 w-3" />
          {config.label}
        </Badge>
        {channel.externalStoreName && (
          <Badge variant="outline" className="text-xs gap-1">
            <Globe className="h-3 w-3" />
            {channel.externalStoreName}
          </Badge>
        )}
        {testedAt && (
          <span className="text-xs text-muted-foreground">آخر اختبار: {fmtDateTime(testedAt)}</span>
        )}
      </div>
      {status === "failed" && channel.lastConnectionError && (
        <p className="text-xs text-destructive line-clamp-2">{channel.lastConnectionError}</p>
      )}
    </div>
  );
}

/** Order-sync outcome — distinct from credential health above. */
function SyncStatus({ channel }: { channel: any }) {
  const status = channel.lastSyncStatus as "never" | "success" | "error" | undefined;
  const lastSync = channel.lastSyncAt ? new Date(channel.lastSyncAt) : null;
  if (!lastSync && status === "never") return null;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge
          variant="outline"
          className={`text-xs gap-1 ${status === "error" ? "text-destructive border-destructive/40" : ""}`}
        >
          <RefreshCw className="h-3 w-3" />
          {status === "success" ? "آخر مزامنة ناجحة" : status === "error" ? "فشلت آخر مزامنة" : "لم تتم مزامنة"}
        </Badge>
        {lastSync && (
          <span className="text-xs text-muted-foreground">
            {fmtDateTime(lastSync)}
            {channel.lastSyncedOrderCount > 0 && ` — ${channel.lastSyncedOrderCount} أوردر`}
          </span>
        )}
      </div>
      {status === "error" && channel.lastSyncError && (
        <p className="text-xs text-destructive line-clamp-2">{channel.lastSyncError}</p>
      )}
    </div>
  );
}

/** Default sync range: the last 7 days. */
function defaultSyncRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 7);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(to) };
}

export default function SalesChannels() {
  const { currentBusinessIds } = useBusinessContext();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ChannelForm>(emptyForm);
  const [showArchived, setShowArchived] = useState(false);
  const [syncDialogChannel, setSyncDialogChannel] = useState<any | null>(null);
  const [syncRange, setSyncRange] = useState(defaultSyncRange);
  const [logsChannelId, setLogsChannelId] = useState<number | null>(null);
  const [testingChannelId, setTestingChannelId] = useState<number | null>(null);
  const utils = trpc.useUtils();
  // Which stored secrets the currently-edited channel already has (the values themselves
  // are never sent to the client, so we only ever know "configured / not configured").
  const [editingSecrets, setEditingSecrets] = useState<{ hasApiToken: boolean; hasWebhookSecret: boolean }>({
    hasApiToken: false,
    hasWebhookSecret: false,
  });

  const { data: channels, isLoading, refetch } = trpc.salesChannels.list.useQuery({
    businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : undefined,
    includeInactive: true,
  });

  const { data: businesses } = trpc.businesses.activeList.useQuery();

  const { data: syncLogs } = trpc.salesChannels.syncLogs.useQuery(
    { channelId: logsChannelId ?? undefined, limit: 20 },
    { enabled: logsChannelId !== null }
  );

  const visibleChannels = (channels ?? []).filter((c: any) => showArchived || c.isActive);

  const createMutation = trpc.salesChannels.create.useMutation({
    onSuccess: () => {
      toast.success("تم إضافة قناة البيع بنجاح");
      setDialogOpen(false);
      setForm(emptyForm);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const updateMutation = trpc.salesChannels.update.useMutation({
    onSuccess: () => {
      toast.success("تم تحديث قناة البيع بنجاح");
      setDialogOpen(false);
      setEditingId(null);
      setForm(emptyForm);
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = trpc.salesChannels.delete.useMutation({
    onSuccess: () => {
      toast.success("تم أرشفة قناة البيع");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const reactivateMutation = trpc.salesChannels.reactivate.useMutation({
    onSuccess: () => {
      toast.success("تم إعادة تفعيل قناة البيع");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const syncNowMutation = trpc.salesChannels.syncNow.useMutation({
    onSuccess: (r) => {
      if (r.status === "error") {
        toast.error(`فشلت المزامنة: ${r.error ?? "خطأ غير معروف"}`);
      } else {
        const parts = [
          `${r.created} جديد`,
          r.updated > 0 && `${r.updated} محدَّث`,
          r.duplicates > 0 && `${r.duplicates} مكرر`,
          r.needsReview > 0 && `${r.needsReview} يحتاج مراجعة`,
          r.failed > 0 && `${r.failed} فشل`,
        ].filter(Boolean).join(" · ");
        if (r.status === "partial") toast.warning(`اكتملت جزئيًا — ${parts}`);
        else toast.success(`تمت المزامنة — ${parts}`);
      }
      setSyncDialogChannel(null);
      refetch();
      utils.salesChannels.syncLogs.invalidate();
    },
    onError: (err) => toast.error(err.message),
  });

  const testConnectionMutation = trpc.salesChannels.testConnection.useMutation({
    onSuccess: (r) => {
      if (r.connected) {
        toast.success(
          r.storeName
            ? `الاتصال ناجح — المتجر: ${r.storeName}`
            : "الاتصال ناجح — بيانات الاعتماد صحيحة"
        );
      } else {
        toast.error(`فشل الاتصال [${r.errorCode ?? "UNKNOWN"}]: ${r.errorMessage ?? ""}`);
      }
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const clearSecretMutation = trpc.salesChannels.clearSecret.useMutation({
    onSuccess: (_data, vars) => {
      toast.success(vars.field === "apiToken" ? "تم حذف الـ API Token" : "تم حذف الـ Webhook Secret");
      setEditingSecrets((s) => ({
        ...s,
        ...(vars.field === "apiToken" ? { hasApiToken: false } : { hasWebhookSecret: false }),
      }));
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleOpenCreate = () => {
    setEditingId(null);
    setForm({ ...emptyForm, businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : null });
    setEditingSecrets({ hasApiToken: false, hasWebhookSecret: false });
    setDialogOpen(true);
  };

  const handleOpenEdit = (channel: any) => {
    setEditingId(channel.id);
    setForm({
      name: channel.name,
      domain: channel.domain || "",
      platform: channel.platform,
      // Secrets are deliberately left blank: the API never returns them, and an empty
      // value on submit means "keep the stored one unchanged".
      apiToken: "",
      webhookSecret: "",
      businessId: channel.businessId,
    });
    setEditingSecrets({
      hasApiToken: Boolean(channel.hasApiToken),
      hasWebhookSecret: Boolean(channel.hasWebhookSecret),
    });
    setDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!form.name.trim()) {
      toast.error("يرجى إدخال اسم القناة");
      return;
    }
    if (!form.businessId) {
      toast.error("يرجى اختيار النشاط");
      return;
    }
    if (form.webhookSecret.trim() && form.webhookSecret.trim().length < 8) {
      toast.error("سر الـ webhook يجب أن يكون 8 أحرف على الأقل");
      return;
    }

    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        name: form.name.trim(),
        domain: form.domain.trim() || undefined,
        platform: form.platform as any,
        // Omitted when blank → server keeps the existing secret.
        apiToken: form.apiToken.trim() || undefined,
        webhookSecret: form.webhookSecret.trim() || undefined,
      });
    } else {
      createMutation.mutate({
        businessId: form.businessId,
        name: form.name.trim(),
        domain: form.domain.trim() || undefined,
        platform: form.platform as any,
        apiToken: form.apiToken.trim() || undefined,
        webhookSecret: form.webhookSecret.trim() || undefined,
      });
    }
  };

  const handleToggleActive = (channel: any) => {
    if (channel.isActive) {
      deleteMutation.mutate({ id: channel.id });
    } else {
      reactivateMutation.mutate({ id: channel.id });
    }
  };

  const handleDelete = (channel: any) => {
    if (confirm(`هل أنت متأكد من أرشفة "${channel.name}"؟ لن تُحذف بياناتها، ويمكن إعادة تفعيلها لاحقًا.`)) {
      deleteMutation.mutate({ id: channel.id });
    }
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="h-8 bg-muted rounded animate-pulse w-48" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-40 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">قنوات البيع / المواقع</h1>
          <p className="text-muted-foreground text-sm mt-1">
            إدارة المواقع وقنوات البيع المرتبطة بأنشطتك
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showArchived ? "default" : "outline"}
            size="sm"
            onClick={() => setShowArchived((s) => !s)}
            className="gap-1"
          >
            {showArchived ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            {showArchived ? "إخفاء المؤرشف" : "إظهار المؤرشف"}
          </Button>
          <Button onClick={handleOpenCreate} className="gap-2">
            <Plus className="h-4 w-4" />
            إضافة قناة بيع
          </Button>
        </div>
      </div>

      {/* Channels Grid */}
      {visibleChannels.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Globe className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">
              {channels && channels.length > 0 ? "كل القنوات مؤرشفة" : "لا توجد قنوات بيع"}
            </h3>
            <p className="text-muted-foreground mb-4">
              {channels && channels.length > 0
                ? 'اضغط "إظهار المؤرشف" لعرضها وإعادة تفعيلها'
                : "أضف أول قناة بيع لربط مواقعك ومنصاتك بالسيستم"}
            </p>
            <Button onClick={handleOpenCreate} variant="outline" className="gap-2">
              <Plus className="h-4 w-4" />
              إضافة قناة بيع
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {visibleChannels.map((channel: any) => (
            <Card key={channel.id} className={!channel.isActive ? "opacity-60" : ""}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg">{channel.name}</CardTitle>
                    {!channel.isActive && (
                      <Badge variant="secondary" className="text-xs">مؤرشف</Badge>
                    )}
                  </div>
                  <Badge className={PLATFORM_COLORS[channel.platform] || PLATFORM_COLORS.other}>
                    {PLATFORM_LABELS[channel.platform] || channel.platform}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {channel.domain && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span className="truncate">{channel.domain}</span>
                  </div>
                )}
                <div className="text-xs text-muted-foreground">
                  النشاط: {businesses?.find((b: any) => b.id === channel.businessId)?.name || `#${channel.businessId}`}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {channel.hasApiToken ? (
                    <Badge variant="outline" className="text-xs gap-1 font-mono">
                      <KeyRound className="h-3 w-3" />
                      API ••••{channel.apiTokenLast4}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs text-muted-foreground">بدون API Token</Badge>
                  )}
                  {channel.hasWebhookSecret ? (
                    <Badge variant="outline" className="text-xs gap-1 font-mono">
                      <KeyRound className="h-3 w-3" />
                      Webhook ••••{channel.webhookSecretLast4}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs text-muted-foreground">بدون Webhook Secret</Badge>
                  )}
                </div>
                <div className="pt-2 border-t space-y-1.5">
                  <ConnectionStatus channel={channel} />
                  <SyncStatus channel={channel} />
                </div>

                {channel.platform === "easyorder" && channel.isActive && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      variant="default"
                      size="sm"
                      className="gap-1 h-8"
                      onClick={() => { setSyncRange(defaultSyncRange()); setSyncDialogChannel(channel); }}
                      disabled={syncNowMutation.isPending}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${syncNowMutation.isPending ? "animate-spin" : ""}`} />
                      مزامنة الآن
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1 h-8"
                      onClick={() => {
                        setTestingChannelId(channel.id);
                        testConnectionMutation.mutate({ id: channel.id });
                      }}
                      disabled={testingChannelId === channel.id && testConnectionMutation.isPending}
                      title="فحص بيانات الاعتماد بقراءة فقط — لا يستورد أي أوردر"
                    >
                      {testingChannelId === channel.id && testConnectionMutation.isPending ? (
                        <>
                          <div className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          جاري الاختبار...
                        </>
                      ) : (
                        <>
                          <PlugZap className="h-3.5 w-3.5" />
                          اختبار الاتصال
                        </>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1 h-8"
                      onClick={() => setLogsChannelId(logsChannelId === channel.id ? null : channel.id)}
                    >
                      <History className="h-3.5 w-3.5" />
                      السجل
                    </Button>
                  </div>
                )}

                {logsChannelId === channel.id && (
                  <div className="rounded-lg border bg-muted/30 p-2 space-y-1 max-h-56 overflow-y-auto">
                    {!syncLogs || syncLogs.length === 0 ? (
                      <p className="text-xs text-muted-foreground text-center py-3">لا توجد عمليات مزامنة بعد</p>
                    ) : (
                      syncLogs.map((log: any) => (
                        <div key={log.id} className="text-xs flex items-start gap-2 p-1.5 rounded bg-background">
                          <Badge
                            className={`text-[10px] shrink-0 border-0 ${
                              log.status === "success" ? "bg-green-100 text-green-700"
                              : log.status === "partial" ? "bg-yellow-100 text-yellow-700"
                              : log.status === "error" ? "bg-red-100 text-red-700"
                              : "bg-gray-100 text-gray-600"
                            }`}
                          >
                            {log.status}
                          </Badge>
                          <div className="flex-1 min-w-0">
                            <span className="text-muted-foreground">
                              {log.trigger} · {new Date(log.startedAt).toLocaleString("ar-EG", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                            </span>
                            <div className="text-foreground">
                              جلب {log.fetchedCount} · جديد {log.createdCount} · محدَّث {log.updatedCount}
                              {log.needsReviewCount > 0 && ` · مراجعة ${log.needsReviewCount}`}
                              {log.failedCount > 0 && ` · فشل ${log.failedCount}`}
                            </div>
                            {log.errorMessage && (
                              <p className="text-destructive line-clamp-2">{log.errorMessage}</p>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2 pt-2 border-t">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleOpenEdit(channel)}
                    className="gap-1"
                  >
                    <Edit className="h-3.5 w-3.5" />
                    تعديل
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleToggleActive(channel)}
                    disabled={deleteMutation.isPending || reactivateMutation.isPending}
                    className="gap-1"
                  >
                    {channel.isActive ? (
                      <>
                        <PowerOff className="h-3.5 w-3.5" />
                        تعطيل
                      </>
                    ) : (
                      <>
                        <Power className="h-3.5 w-3.5" />
                        تفعيل
                      </>
                    )}
                  </Button>
                  {channel.isActive && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDelete(channel)}
                      disabled={deleteMutation.isPending}
                      className="gap-1 text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      أرشفة
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Sync Now Dialog */}
      <Dialog open={!!syncDialogChannel} onOpenChange={(o) => { if (!o) setSyncDialogChannel(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-primary" />
              مزامنة الأوردرات — {syncDialogChannel?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              سيتم جلب أوردرات هذه الفترة من EasyOrder. الأوردرات الموجودة بالفعل لن تتكرر —
              تُحدَّث فقط لو تغيّرت من عند المصدر.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>من تاريخ</Label>
                <Input
                  type="date"
                  value={syncRange.from}
                  onChange={(e) => setSyncRange((r) => ({ ...r, from: e.target.value }))}
                  dir="ltr"
                />
              </div>
              <div className="space-y-2">
                <Label>إلى تاريخ</Label>
                <Input
                  type="date"
                  value={syncRange.to}
                  onChange={(e) => setSyncRange((r) => ({ ...r, to: e.target.value }))}
                  dir="ltr"
                />
              </div>
            </div>
            {!syncDialogChannel?.hasApiToken && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3">
                <p className="text-xs text-destructive">
                  لا يوجد API Token مضبوط لهذه القناة — أضفه من زر "تعديل" قبل المزامنة.
                </p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSyncDialogChannel(null)}>إلغاء</Button>
            <Button
              onClick={() => {
                if (!syncDialogChannel) return;
                const from = new Date(syncRange.from);
                const to = new Date(syncRange.to);
                to.setHours(23, 59, 59, 999);
                if (isNaN(from.getTime()) || isNaN(to.getTime())) {
                  toast.error("يرجى اختيار تاريخين صحيحين");
                  return;
                }
                if (from > to) {
                  toast.error("تاريخ البداية يجب أن يكون قبل تاريخ النهاية");
                  return;
                }
                syncNowMutation.mutate({ id: syncDialogChannel.id, from, to });
              }}
              disabled={syncNowMutation.isPending || !syncDialogChannel?.hasApiToken}
              className="gap-1"
            >
              {syncNowMutation.isPending ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  جاري المزامنة...
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4" />
                  ابدأ المزامنة
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingId ? "تعديل قناة البيع" : "إضافة قناة بيع جديدة"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>اسم القناة / الموقع *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="مثال: موقع إيزي أوردر الرئيسي"
              />
            </div>

            <div className="space-y-2">
              <Label>النشاط *</Label>
              <Select
                value={form.businessId?.toString() || ""}
                onValueChange={(v) => setForm({ ...form, businessId: Number(v) })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="اختر النشاط" />
                </SelectTrigger>
                <SelectContent>
                  {businesses?.map((b: any) => (
                    <SelectItem key={b.id} value={b.id.toString()}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>نوع المنصة</Label>
              <Select
                value={form.platform}
                onValueChange={(v) => setForm({ ...form, platform: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(PLATFORM_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>الدومين / الرابط</Label>
              <Input
                value={form.domain}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
                placeholder="https://example.com"
                dir="ltr"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>API Token</Label>
                {editingId && editingSecrets.hasApiToken && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs text-destructive hover:text-destructive gap-1"
                    onClick={() => clearSecretMutation.mutate({ id: editingId, field: "apiToken" })}
                    disabled={clearSecretMutation.isPending}
                  >
                    <X className="h-3 w-3" />
                    حذف الحالي
                  </Button>
                )}
              </div>
              <Input
                value={form.apiToken}
                onChange={(e) => setForm({ ...form, apiToken: e.target.value })}
                placeholder={
                  editingId && editingSecrets.hasApiToken
                    ? "محفوظ — اتركه فارغًا للإبقاء عليه"
                    : "اختياري - لربط API"
                }
                dir="ltr"
                type="password"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Webhook Secret</Label>
                {editingId && editingSecrets.hasWebhookSecret && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-xs text-destructive hover:text-destructive gap-1"
                    onClick={() => clearSecretMutation.mutate({ id: editingId, field: "webhookSecret" })}
                    disabled={clearSecretMutation.isPending}
                  >
                    <X className="h-3 w-3" />
                    حذف الحالي
                  </Button>
                )}
              </div>
              <Input
                value={form.webhookSecret}
                onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
                placeholder={
                  editingId && editingSecrets.hasWebhookSecret
                    ? "محفوظ — اتركه فارغًا للإبقاء عليه"
                    : "اختياري - 8 أحرف على الأقل"
                }
                dir="ltr"
                type="password"
              />
              <p className="text-xs text-muted-foreground">
                لأسباب أمنية لا يُرجع النظام الأسرار المحفوظة أبدًا — يظهر آخر 4 أحرف فقط للتعريف.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              إلغاء
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {createMutation.isPending || updateMutation.isPending
                ? "جاري الحفظ..."
                : editingId
                ? "تحديث"
                : "إضافة"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
