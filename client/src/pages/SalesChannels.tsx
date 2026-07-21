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
import { Plus, Edit, Trash2, Globe, ExternalLink, Power, PowerOff } from "lucide-react";
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

export default function SalesChannels() {
  const { currentBusinessIds } = useBusinessContext();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<ChannelForm>(emptyForm);

  const { data: channels, isLoading, refetch } = trpc.salesChannels.list.useQuery({
    businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : undefined,
  });

  const { data: businesses } = trpc.businesses.activeList.useQuery();

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
      toast.success("تم حذف قناة البيع");
      refetch();
    },
    onError: (err) => toast.error(err.message),
  });

  const handleOpenCreate = () => {
    setEditingId(null);
    setForm({ ...emptyForm, businessId: currentBusinessIds && currentBusinessIds.length === 1 ? currentBusinessIds[0] : null });
    setDialogOpen(true);
  };

  const handleOpenEdit = (channel: any) => {
    setEditingId(channel.id);
    setForm({
      name: channel.name,
      domain: channel.domain || "",
      platform: channel.platform,
      apiToken: channel.apiToken || "",
      webhookSecret: channel.webhookSecret || "",
      businessId: channel.businessId,
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

    if (editingId) {
      updateMutation.mutate({
        id: editingId,
        name: form.name,
        domain: form.domain || undefined,
        platform: form.platform as any,
        apiToken: form.apiToken || undefined,
        webhookSecret: form.webhookSecret || undefined,
      });
    } else {
      createMutation.mutate({
        businessId: form.businessId,
        name: form.name,
        domain: form.domain || undefined,
        platform: form.platform as any,
        apiToken: form.apiToken || undefined,
        webhookSecret: form.webhookSecret || undefined,
      });
    }
  };

  const handleToggleActive = (channel: any) => {
    updateMutation.mutate({
      id: channel.id,
      isActive: !channel.isActive,
    });
  };

  const handleDelete = (channel: any) => {
    if (confirm(`هل أنت متأكد من حذف "${channel.name}"؟`)) {
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
        <Button onClick={handleOpenCreate} className="gap-2">
          <Plus className="h-4 w-4" />
          إضافة قناة بيع
        </Button>
      </div>

      {/* Channels Grid */}
      {!channels || channels.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Globe className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">لا توجد قنوات بيع</h3>
            <p className="text-muted-foreground mb-4">
              أضف أول قناة بيع لربط مواقعك ومنصاتك بالسيستم
            </p>
            <Button onClick={handleOpenCreate} variant="outline" className="gap-2">
              <Plus className="h-4 w-4" />
              إضافة قناة بيع
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {channels.map((channel: any) => (
            <Card key={channel.id} className={!channel.isActive ? "opacity-60" : ""}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-lg">{channel.name}</CardTitle>
                    {!channel.isActive && (
                      <Badge variant="secondary" className="text-xs">معطل</Badge>
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
                {channel.apiToken && (
                  <div className="text-xs text-muted-foreground">
                    API Token: ••••••••{channel.apiToken.slice(-4)}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(channel)}
                    className="gap-1 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    حذف
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

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
              <Label>API Token</Label>
              <Input
                value={form.apiToken}
                onChange={(e) => setForm({ ...form, apiToken: e.target.value })}
                placeholder="اختياري - لربط API"
                dir="ltr"
                type="password"
              />
            </div>

            <div className="space-y-2">
              <Label>Webhook Secret</Label>
              <Input
                value={form.webhookSecret}
                onChange={(e) => setForm({ ...form, webhookSecret: e.target.value })}
                placeholder="اختياري - لتأمين Webhooks"
                dir="ltr"
                type="password"
              />
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
