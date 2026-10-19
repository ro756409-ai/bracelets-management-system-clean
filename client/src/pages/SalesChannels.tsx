import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { PartnerLogo, type PartnerId } from "@/components/brand/PartnerLogo";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import {
  Plus, Edit, Trash2, Globe, ExternalLink, Power, PowerOff, KeyRound, Eye, EyeOff, X,
  RefreshCw, CheckCircle2, AlertCircle, Clock, PlugZap, History, Store,
} from "lucide-react";
import { SetupJourney } from "@/components/SetupJourney";
import { IntegrationsMarketplace } from "@/components/IntegrationsMarketplace";
import { BostaConnectDialog } from "@/components/BostaConnectDialog";
import { PageHeader, SectionCard, StatusBadge, EmptyState, LoadingSkeleton, OfflineState, type StatusTone } from "@/components/shared";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { createInFlightGuard } from "@/components/orders/confirmGuard";
import { toast } from "sonner";
import { AR_LOCALE } from "@/lib/format";

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

// شعارات رسمية محلية لمنصات لها أصل رسمي في المشروع (المرحلة 6) — زخرفية، الاسم مكتوب بجوارها
const PLATFORM_LOGOS: Record<string, PartnerId | undefined> = { easyorder: "easyorders", whatsapp: "whatsapp", facebook: "facebook" };

// نغمات الهوية بدل الألوان الخام (المرحلة 7H) — المنصة نفسها لا تتغيّر
const PLATFORM_TONES: Record<string, StatusTone> = {
  easyorder: "info", shopify: "success", woocommerce: "purple", whatsapp: "success", facebook: "info", instagram: "orange", manual: "neutral", other: "amber",
};

const TOUCH = "min-h-11 md:min-h-9";

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
  d.toLocaleString(AR_LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * Credential/connection health, from the read-only connection test.
 * Deliberately separate from sync status: a failed import must not look like broken
 * credentials, and working credentials must not imply a successful import.
 * الحالة بنص + أيقونة: متصل / غير متصل (لم يُختبر) / خطأ.
 */
function ConnectionStatus({ channel }: { channel: any }) {
  const status = channel.lastConnectionStatus as "never" | "connected" | "failed" | undefined;
  const testedAt = channel.lastConnectionTestAt ? new Date(channel.lastConnectionTestAt) : null;

  const config =
    status === "connected"
      ? { icon: CheckCircle2, tone: "success" as const, label: "متصل" }
      : status === "failed"
      ? { icon: AlertCircle, tone: "danger" as const, label: "خطأ في الاتصال" }
      : { icon: Clock, tone: "neutral" as const, label: "غير متصل — لم يُختبر بعد" };
  const Icon = config.icon;

  return (
    <div className="space-y-1" data-testid={`channel-connection-${channel.id}`} data-status={status ?? "never"}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={status ?? "never"} label={config.label} tone={config.tone} size="sm" icon={<Icon className="h-3 w-3" aria-hidden="true" />} />
        {channel.externalStoreName && (
          <StatusBadge status="store" label={channel.externalStoreName} tone="neutral" size="sm" icon={<Globe className="h-3 w-3" aria-hidden="true" />} />
        )}
        {testedAt && (
          <span className="text-xs text-muted-foreground">آخر اختبار: {fmtDateTime(testedAt)}</span>
        )}
      </div>
      {status === "failed" && channel.lastConnectionError && (
        <p className="line-clamp-2 text-xs text-destructive" role="alert">{channel.lastConnectionError}</p>
      )}
    </div>
  );
}

/** Order-sync outcome — distinct from credential health above. */
function SyncStatus({ channel }: { channel: any }) {
  const status = channel.lastSyncStatus as "never" | "success" | "error" | undefined;
  const lastSync = channel.lastSyncAt ? new Date(channel.lastSyncAt) : null;

  // EasyOrder's public API has no list-orders endpoint, so pull sync can never succeed for
  // it. Reporting a "failed sync" would blame the channel for a capability that does not
  // exist; state how orders actually arrive instead.
  if (channel.platform === "easyorder") {
    return (
      <p className="text-xs text-muted-foreground">
        الأوردرات تصل تلقائيًا عبر Webhook — لا تحتاج مزامنة يدوية.
      </p>
    );
  }

  if (!lastSync && status === "never") return null;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          status={status ?? "never"}
          label={status === "success" ? "آخر مزامنة ناجحة" : status === "error" ? "فشلت آخر مزامنة" : "لم تتم مزامنة"}
          tone={status === "error" ? "danger" : status === "success" ? "success" : "neutral"}
          size="sm"
          icon={<RefreshCw className="h-3 w-3" aria-hidden="true" />}
        />
        {lastSync && (
          <span className="text-xs text-muted-foreground">
            {fmtDateTime(lastSync)}
            {channel.lastSyncedOrderCount > 0 && ` — ${channel.lastSyncedOrderCount} أوردر`}
          </span>
        )}
      </div>
      {status === "error" && channel.lastSyncError && (
        <p className="line-clamp-2 text-xs text-destructive">{channel.lastSyncError}</p>
      )}
    </div>
  );
}

/**
 * قنوات البيع والتكاملات — نفس الاستعلامات والـmutations (salesChannels.list/create/update/delete/
 * reactivate/testConnection/clearSecret/syncLogs + businesses.activeList) ونفس التحقق والـpayload.
 * المرحلة 7H (عرض فقط): PageHeader + SetupJourney + السوق كما هي، بطاقات القنوات بشارات الهوية،
 * حالة الاتصال نصًا وأيقونة (متصل/غير متصل/خطأ)، الأسرار لا تُعرض أبدًا بعد الحفظ (آخر 4 أحرف فقط)،
 * أزرار 44px، حوار بحقول معنونة وحارس ضغط مكرر، وحالات Loading/Empty/Offline.
 */
export default function SalesChannels() {
  const { currentBusinessIds } = useBusinessContext();
  const online = useOnlineStatus();
  const guard = useRef(createInFlightGuard<string>()).current;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ChannelForm>(emptyForm);
  const [showArchived, setShowArchived] = useState(false);
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

  // No syncNow mutation: EasyOrder's public API documents no list-orders endpoint, so a
  // pull sync cannot work. The server-side `salesChannels.syncNow` procedure is left in
  // place for the day a private/undocumented list endpoint is granted.
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

  const handleOpenCreate = (platform?: string) => {
    setEditingId(null);
    setForm({
      ...emptyForm,
      platform: platform ?? emptyForm.platform,
      businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : null,
    });
    setEditingSecrets({ hasApiToken: false, hasWebhookSecret: false });
    setDialogOpen(true);
  };

  // ربط منصة من السوق: بيفتح نموذج الإضافة بالمنصة محددة مسبقًا (المدعوم فعليًا فقط).
  const [bostaOpen, setBostaOpen] = useState(false);
  // بوسطة شركة شحن مش قناة بيع — ليها نموذج ربط مستقل (مفتاح + مكان استلام) لكل نشاط.
  const handleConnectPlatform = (platform: string) =>
    platform === "bosta" ? setBostaOpen(true) : handleOpenCreate(platform);

  // المنصات اللي عندها قناة نشطة بالفعل — عشان السوق يعرض "مربوط".
  const connectedPlatforms = new Set<string>(
    (channels ?? []).filter((c: any) => c.isActive).map((c: any) => c.platform)
  );

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
      guard.run("save", updateMutation.isPending, done => updateMutation.mutate({
        id: editingId,
        name: form.name.trim(),
        domain: form.domain.trim() || undefined,
        platform: form.platform as any,
        // Omitted when blank → server keeps the existing secret.
        apiToken: form.apiToken.trim() || undefined,
        webhookSecret: form.webhookSecret.trim() || undefined,
      }, { onSettled: done }));
    } else {
      guard.run("save", createMutation.isPending, done => createMutation.mutate({
        businessId: form.businessId!,
        name: form.name.trim(),
        domain: form.domain.trim() || undefined,
        platform: form.platform as any,
        apiToken: form.apiToken.trim() || undefined,
        webhookSecret: form.webhookSecret.trim() || undefined,
      }, { onSettled: done }));
    }
  };

  const handleToggleActive = (channel: any) => {
    if (channel.isActive) {
      guard.run(`toggle:${channel.id}`, deleteMutation.isPending, done => deleteMutation.mutate({ id: channel.id }, { onSettled: done }));
    } else {
      guard.run(`toggle:${channel.id}`, reactivateMutation.isPending, done => reactivateMutation.mutate({ id: channel.id }, { onSettled: done }));
    }
  };

  const handleDelete = (channel: any) => {
    if (confirm(`هل أنت متأكد من أرشفة "${channel.name}"؟ لن تُحذف بياناتها، ويمكن إعادة تفعيلها لاحقًا.`)) {
      guard.run(`archive:${channel.id}`, deleteMutation.isPending, done => deleteMutation.mutate({ id: channel.id }, { onSettled: done }));
    }
  };

  const handleTest = (channel: any) => {
    guard.run(`test:${channel.id}`, testConnectionMutation.isPending, done => {
      setTestingChannelId(channel.id);
      testConnectionMutation.mutate({ id: channel.id }, { onSettled: done });
    });
  };

  const platformBadge = (platform: string) => (
    <StatusBadge
      status={platform}
      label={PLATFORM_LABELS[platform] || platform}
      tone={PLATFORM_TONES[platform] ?? PLATFORM_TONES.other}
      size="sm"
      icon={PLATFORM_LOGOS[platform] ? <PartnerLogo partner={PLATFORM_LOGOS[platform]!} size="xs" decorative className="!h-3" /> : null}
    />
  );

  return (
    <div className="space-y-6" dir="rtl" data-testid="sales-channels-page">
      <PageHeader
        title="قنوات البيع والتكاملات"
        description="اربط متاجرك ومواقعك بالنشاط الصحيح عشان أوردراتها توصل للسيستم أوتوماتيك. اختر منصة من السوق بالأسفل، أو أضِف قناة يدويًا."
        icon={<Store className="h-5 w-5" aria-hidden="true" />}
        primaryAction={
          <Button onClick={() => handleOpenCreate()} className={`${TOUCH} gap-2`} data-testid="channel-add">
            <Plus className="h-4 w-4" aria-hidden="true" />
            إضافة قناة بيع
          </Button>
        }
        actions={
          <Button
            variant={showArchived ? "default" : "outline"}
            size="sm"
            onClick={() => setShowArchived((s) => !s)}
            className={`${TOUCH} gap-1`}
            aria-pressed={showArchived}
            data-testid="channel-show-archived"
          >
            {showArchived ? <Eye className="h-3.5 w-3.5" aria-hidden="true" /> : <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />}
            {showArchived ? "إخفاء المؤرشف" : "إظهار المؤرشف"}
          </Button>
        }
      />

      <SetupJourney current="channel" />

      {!online && <OfflineState onRetry={() => refetch()} className="py-6" />}

      {/* سوق التكاملات (Frontend فقط) */}
      <SectionCard title="سوق التكاملات" description="اكتشف المنصات والخدمات اللي تقدر تربطها بأنشطتك." testId="integrations-marketplace">
        <IntegrationsMarketplace connectedPlatforms={connectedPlatforms} onConnect={handleConnectPlatform} />
        <BostaConnectDialog open={bostaOpen} onOpenChange={setBostaOpen} />
      </SectionCard>

      {/* قنوات البيع المربوطة */}
      <SectionCard title="قنواتك المربوطة" description="القنوات اللي أضفتها بالفعل وحالتها." testId="channels-list">
        {isLoading ? (
          <LoadingSkeleton variant="cards" rows={3} />
        ) : visibleChannels.length === 0 ? (
          <EmptyState
            icon={<Globe className="h-6 w-6" aria-hidden="true" />}
            title={channels && channels.length > 0 ? "كل القنوات مؤرشفة" : "لا توجد قنوات بيع"}
            description={channels && channels.length > 0
              ? 'اضغط "إظهار المؤرشف" لعرضها وإعادة تفعيلها'
              : "أضف أول قناة بيع لربط مواقعك ومنصاتك بالسيستم"}
            action={<Button onClick={() => handleOpenCreate()} variant="outline" className={`${TOUCH} gap-2`}><Plus className="h-4 w-4" aria-hidden="true" /> إضافة قناة بيع</Button>}
          />
        ) : (
          <ul className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {visibleChannels.map((channel: any) => (
              <li key={channel.id} className={`flex flex-col rounded-[var(--radius-brand-md)] border border-border bg-card p-4 ${!channel.isActive ? "opacity-60" : ""}`} data-testid={`channel-card-${channel.id}`}>
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="truncate text-base font-semibold">{channel.name}</h3>
                    {!channel.isActive && <StatusBadge status="archived" label="مؤرشف" tone="neutral" size="sm" icon={null} />}
                  </div>
                  {platformBadge(channel.platform)}
                </div>
                <div className="space-y-3">
                  {channel.domain && (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="truncate" dir="ltr">{channel.domain}</span>
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">
                    النشاط: {businesses?.find((b: any) => b.id === channel.businessId)?.name || `#${channel.businessId}`}
                  </div>
                  {/* الأسرار: وجودها + آخر 4 أحرف فقط — القيم نفسها لا تصل للمتصفح أبدًا */}
                  <div className="flex flex-wrap gap-1.5">
                    {channel.hasApiToken ? (
                      <StatusBadge status="api_token" label={`API ••••${channel.apiTokenLast4}`} tone="neutral" size="sm" icon={<KeyRound className="h-3 w-3" aria-hidden="true" />} className="font-mono" />
                    ) : (
                      <StatusBadge status="no_api_token" label="بدون API Token" tone="neutral" size="sm" icon={null} />
                    )}
                    {channel.hasWebhookSecret ? (
                      <StatusBadge status="webhook_secret" label={`Webhook ••••${channel.webhookSecretLast4}`} tone="neutral" size="sm" icon={<KeyRound className="h-3 w-3" aria-hidden="true" />} className="font-mono" />
                    ) : (
                      <StatusBadge status="no_webhook_secret" label="بدون Webhook Secret" tone="neutral" size="sm" icon={null} />
                    )}
                  </div>
                  <div className="space-y-1.5 border-t border-border pt-2">
                    <ConnectionStatus channel={channel} />
                    <SyncStatus channel={channel} />
                  </div>

                  {channel.platform === "easyorder" && channel.isActive && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className={`${TOUCH} gap-1`}
                        onClick={() => handleTest(channel)}
                        disabled={testingChannelId === channel.id && testConnectionMutation.isPending}
                        title="فحص بيانات الاعتماد بقراءة فقط — لا يستورد أي أوردر"
                        data-testid={`channel-test-${channel.id}`}
                      >
                        {testingChannelId === channel.id && testConnectionMutation.isPending ? (
                          <>
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                            جاري الاختبار...
                          </>
                        ) : (
                          <>
                            <PlugZap className="h-3.5 w-3.5" aria-hidden="true" />
                            اختبار الاتصال
                          </>
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className={`${TOUCH} gap-1`}
                        onClick={() => setLogsChannelId(logsChannelId === channel.id ? null : channel.id)}
                        aria-expanded={logsChannelId === channel.id}
                        data-testid={`channel-logs-${channel.id}`}
                      >
                        <History className="h-3.5 w-3.5" aria-hidden="true" />
                        السجل
                      </Button>
                    </div>
                  )}

                  {logsChannelId === channel.id && (
                    <div className="max-h-56 space-y-1 overflow-y-auto rounded-[var(--radius-brand-md)] border border-border bg-muted/30 p-2" data-testid={`channel-sync-logs-${channel.id}`}>
                      {!syncLogs || syncLogs.length === 0 ? (
                        <p className="py-3 text-center text-xs text-muted-foreground">لا توجد عمليات مزامنة بعد</p>
                      ) : (
                        syncLogs.map((log: any) => (
                          <div key={log.id} className="flex items-start gap-2 rounded-[var(--radius-brand-sm,0.375rem)] bg-background p-1.5 text-xs">
                            <StatusBadge
                              status={log.status}
                              label={log.status}
                              tone={log.status === "success" ? "success" : log.status === "partial" ? "warning" : log.status === "error" ? "danger" : "neutral"}
                              size="sm"
                              icon={null}
                            />
                            <div className="min-w-0 flex-1">
                              <span className="text-muted-foreground">
                                {log.trigger} · {new Date(log.startedAt).toLocaleString(AR_LOCALE, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                              </span>
                              <div className="text-foreground">
                                جلب {log.fetchedCount} · جديد {log.createdCount} · محدَّث {log.updatedCount}
                                {log.needsReviewCount > 0 && ` · مراجعة ${log.needsReviewCount}`}
                                {log.failedCount > 0 && ` · فشل ${log.failedCount}`}
                              </div>
                              {log.errorMessage && (
                                <p className="line-clamp-2 text-destructive">{log.errorMessage}</p>
                              )}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-1 border-t border-border pt-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleOpenEdit(channel)}
                      className={`${TOUCH} gap-1`}
                      data-testid={`channel-edit-${channel.id}`}
                    >
                      <Edit className="h-3.5 w-3.5" aria-hidden="true" />
                      تعديل
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleActive(channel)}
                      disabled={deleteMutation.isPending || reactivateMutation.isPending}
                      className={`${TOUCH} gap-1`}
                      data-testid={`channel-toggle-${channel.id}`}
                    >
                      {channel.isActive ? (
                        <>
                          <PowerOff className="h-3.5 w-3.5" aria-hidden="true" />
                          تعطيل
                        </>
                      ) : (
                        <>
                          <Power className="h-3.5 w-3.5" aria-hidden="true" />
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
                        className={`${TOUCH} gap-1 text-destructive hover:text-destructive`}
                        data-testid={`channel-archive-${channel.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        أرشفة
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md" dir="rtl" data-testid="channel-dialog">
          <DialogHeader>
            <DialogTitle>
              {editingId ? "تعديل قناة البيع" : "إضافة قناة بيع جديدة"}
            </DialogTitle>
            <DialogDescription>الأسرار تُحفظ على السيرفر ولا تُعرض مرة أخرى — يظهر آخر 4 أحرف فقط للتعريف.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="channel-name">اسم القناة / الموقع *</Label>
              <Input
                id="channel-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="مثال: موقع إيزي أوردر الرئيسي"
                className={TOUCH}
                data-testid="channel-field-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="channel-business">النشاط *</Label>
              <Select
                value={form.businessId?.toString() || ""}
                onValueChange={(v) => setForm({ ...form, businessId: Number(v) })}
              >
                <SelectTrigger id="channel-business" className={TOUCH} data-testid="channel-field-business">
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
              <Label htmlFor="channel-platform">نوع المنصة</Label>
              <Select
                value={form.platform}
                onValueChange={(v) => setForm({ ...form, platform: v })}
              >
                <SelectTrigger id="channel-platform" className={TOUCH} data-testid="channel-field-platform">
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
              <Label htmlFor="channel-domain">الدومين / الرابط</Label>
              <Input
                id="channel-domain"
                value={form.domain}
                onChange={(e) => setForm({ ...form, domain: e.target.value })}
                placeholder="https://example.com"
                dir="ltr"
                className={TOUCH}
                inputMode="url"
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="channel-api-token">API Token</Label>
                {editingId && editingSecrets.hasApiToken && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 gap-1 text-xs text-destructive hover:text-destructive md:min-h-7"
                    onClick={() => clearSecretMutation.mutate({ id: editingId, field: "apiToken" })}
                    disabled={clearSecretMutation.isPending}
                    data-testid="channel-clear-api-token"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                    حذف الحالي
                  </Button>
                )}
              </div>
              <Input
                id="channel-api-token"
                value={form.apiToken}
                onChange={(e) => setForm({ ...form, apiToken: e.target.value })}
                placeholder={
                  editingId && editingSecrets.hasApiToken
                    ? "محفوظ — اتركه فارغًا للإبقاء عليه"
                    : "اختياري - لربط API"
                }
                dir="ltr"
                type="password"
                autoComplete="off"
                className={TOUCH}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="channel-webhook-secret">Webhook Secret</Label>
                {editingId && editingSecrets.hasWebhookSecret && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="min-h-11 gap-1 text-xs text-destructive hover:text-destructive md:min-h-7"
                    onClick={() => clearSecretMutation.mutate({ id: editingId, field: "webhookSecret" })}
                    disabled={clearSecretMutation.isPending}
                    data-testid="channel-clear-webhook-secret"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                    حذف الحالي
                  </Button>
                )}
              </div>
              <Input
                id="channel-webhook-secret"
                value={form.webhookSecret}
                onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
                placeholder={
                  editingId && editingSecrets.hasWebhookSecret
                    ? "محفوظ — اتركه فارغًا للإبقاء عليه"
                    : "اختياري - 8 أحرف على الأقل"
                }
                dir="ltr"
                type="password"
                autoComplete="off"
                className={TOUCH}
              />
              <p className="text-xs text-muted-foreground">
                لأسباب أمنية لا يُرجع النظام الأسرار المحفوظة أبدًا — يظهر آخر 4 أحرف فقط للتعريف.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className={TOUCH} onClick={() => setDialogOpen(false)}>
              إلغاء
            </Button>
            <Button
              className={TOUCH}
              onClick={handleSubmit}
              disabled={createMutation.isPending || updateMutation.isPending}
              data-testid="channel-save"
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
