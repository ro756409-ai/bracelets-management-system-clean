import { useEffect, useMemo, useState } from "react";
import {
  Building2,
  Landmark,
  Plus,
  Save,
  Settings2,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { LoadingSkeleton, SectionHeader } from "@/components/shared";
import { EvidenceUpload } from "@/components/EvidenceUpload";

/**
 * القوايم اللي التاجر بيلمسها فعلًا — دي اللي بتغذّي شاشات بيفتحها كل يوم.
 *
 * المحافظات وأنواع الشحن والدفع ومصادر الأوردر بتظهر في **فورم الأوردر**، وأنواع
 * المصروفات في «تحصيل اليوم»، ومنصات الإعلانات في شاشة الإعلانات. لو اتشالوا، القوايم
 * دي بترجع فاضية والفورم يقف.
 */
const CONFIG_NAMESPACES = [
  ["governorate", "المحافظات"],
  ["shipping_type", "أنواع الشحن"],
  ["payment_type", "أنواع الدفع"],
  ["expense_type", "أنواع المصروفات"],
  ["order_source", "مصادر الأوردر"],
  ["ad_platform", "منصات الإعلانات"],
] as const;

/**
 * قوايم بتخص شاشات المحاسب المخفية (التقفيلات، الشحن والتسويات، المخزون التفصيلي).
 *
 * موجودة ومحفوظة — بتظهر جوه «إعدادات متقدمة» بس، عشان اللي بيفتح الصفحة مايبصّش على
 * ستاشر تاب تلتاشر منهم مالوش لازمة عنده.
 */
const ADVANCED_CONFIG_NAMESPACES = [
  ["shipping_charge_type", "أنواع رسوم الشحن"],
  ["shipping_billing_event", "أحداث استحقاق الشحن"],
  ["financial_account_type", "أنواع الحسابات المالية"],
  ["closing_adjustment_type", "أنواع تسويات التقفيل"],
  ["inventory_receipt_type", "أنواع استلام المخزون"],
  ["inventory_in_reason", "أسباب إدخال المخزون"],
  ["inventory_out_reason", "أسباب إخراج المخزون"],
  ["order_status", "حالات الأوردر"],
  ["return_reason", "أسباب المرتجع"],
  ["cancellation_reason", "أسباب الإلغاء"],
] as const;

type ChargeDraft = {
  chargeType: string;
  calculationType: "fixed" | "percentage";
  value: string;
  percentageBase?: "collected_amount" | "custom_fixed_base";
  customFixedBase?: string;
  billingEvent: string;
  tolerance: string;
};

const emptyCharge = (): ChargeDraft => ({
  chargeType: "",
  calculationType: "fixed",
  value: "",
  billingEvent: "",
  tolerance: "0",
});

export function AccountingSettingsSection() {
  const { businesses } = useBusinessContext();
  const [businessId, setBusinessId] = useState<number>();
  useEffect(() => {
    if (!businessId && businesses[0]) setBusinessId(businesses[0].id);
  }, [businessId, businesses]);

  return (
    <div className="space-y-5">
      <SectionHeader description="كل القيم التشغيلية مستقلة لكل Business وقابلة للتعديل من غير Deploy" />
      <Card className="overflow-hidden border-sky-900/10 bg-gradient-to-l from-sky-950 via-slate-900 to-slate-950 text-white">
        <CardContent className="flex flex-col gap-3 p-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.2em] text-sky-300">
              Accounting Control Center
            </p>
            <h2 className="mt-1 text-2xl font-black">
              إعدادات الحسابات والتشغيل
            </h2>
            <p className="mt-1 text-sm text-slate-300">
              العملة، الحسابات، الشحن، الرسوم والصلاحيات من مكان واحد.
            </p>
          </div>
          <label className="w-full space-y-1 text-sm md:w-72">
            <span className="text-sky-100">النشاط</span>
            <select
              className="h-10 w-full rounded-md border border-white/15 bg-white/10 px-3"
              value={businessId ?? ""}
              onChange={event => setBusinessId(Number(event.target.value))}
            >
              {businesses.map(business => (
                <option
                  className="text-slate-950"
                  key={business.id}
                  value={business.id}
                >
                  {business.name}
                </option>
              ))}
            </select>
          </label>
        </CardContent>
      </Card>

      {businessId ? (
        <>
          <BusinessSettings businessId={businessId} />
          <ConfigurationSettings businessId={businessId} />
          <FinancialAccountSettings businessId={businessId} />
          <ShippingSettings businessId={businessId} />

          {/*
            مقفولة افتراضيًا مش محذوفة. مراكز التكلفة وجدول مسارات الشحن وشاشة
            الصلاحيات كلهم شغّالين ومحتاجينهم مين عنده محاسب — بس التاجر اللي بيفتح
            الصفحة عشان يضيف شركة شحن مالوش دعوة بيهم، وكانوا بيخلوا الصفحة تبان
            أعقد مما هي.
          */}
          <details className="rounded-lg border bg-card">
            <summary className="cursor-pointer select-none px-4 py-3 text-sm font-medium">
              إعدادات متقدمة
            </summary>
            <div className="space-y-4 border-t p-4">
              <ConfigurationSettings
                businessId={businessId}
                namespaces={ADVANCED_CONFIG_NAMESPACES}
                title="قوايم متقدمة"
              />
              {/*
                «جدول مسارات شركات الشحن» اتشال زي نسخة السعر: هو بيقول أنهي شركة
                بتشحن لأنهي محافظة في أنهي يوم — بيانات لجدولة أوتوماتيك مش مستخدمة.
                الشاشة والخدمة مكانهم.
              */}
              <CostCenterSettings businessId={businessId} />
              <PermissionSettings />
            </div>
          </details>
        </>
      ) : (
        <LoadingSkeleton />
      )}
    </div>
  );
}

function ShippingRouteSettings({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const providers = trpc.accountingV2.shippingConfiguration.useQuery({
    businessId,
  });
  const governorates = trpc.accountingV2.configurationList.useQuery({
    businessId,
    namespace: "governorate",
    activeOnly: true,
  });
  const routes = trpc.accountingV2.configurationList.useQuery({
    businessId,
    namespace: "shipping_schedule_route",
    activeOnly: false,
  });
  const [form, setForm] = useState({
    providerId: "",
    dayOfWeek: "",
    governorate: "",
    priority: "0",
    notes: "",
  });
  const save = trpc.accountingV2.configurationSave.useMutation({
    onSuccess: async () => {
      toast.success("تم حفظ مسار جدول الشحن");
      await utils.accountingV2.configurationList.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const provider = providers.data?.providers.find(
    row => row.id === Number(form.providerId)
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">جدول مسارات شركات الشحن</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          كل صف يربط شركة شحن بمحافظة ويوم وأولوية، بدون أي أسماء أو مواعيد
          ثابتة في الكود.
        </p>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <SelectField
            label="الشركة"
            value={form.providerId}
            onChange={providerId => setForm({ ...form, providerId })}
            options={
              providers.data?.providers.map(row => [
                String(row.id),
                row.displayName,
              ]) ?? []
            }
          />
          <SelectField
            label="اليوم"
            value={form.dayOfWeek}
            onChange={dayOfWeek => setForm({ ...form, dayOfWeek })}
            options={[
              ["0", "الأحد"],
              ["1", "الاثنين"],
              ["2", "الثلاثاء"],
              ["3", "الأربعاء"],
              ["4", "الخميس"],
              ["5", "الجمعة"],
              ["6", "السبت"],
            ]}
          />
          <SelectField
            label="المحافظة"
            value={form.governorate}
            onChange={governorate => setForm({ ...form, governorate })}
            options={configurationOptions(governorates.data)}
          />
          <Field label="الأولوية">
            <Input
              type="number"
              value={form.priority}
              onChange={event =>
                setForm({ ...form, priority: event.target.value })
              }
            />
          </Field>
          <Field label="ملاحظات">
            <Input
              value={form.notes}
              onChange={event =>
                setForm({ ...form, notes: event.target.value })
              }
            />
          </Field>
          <Button
            className="self-end"
            disabled={save.isPending}
            onClick={() => {
              if (!provider || form.dayOfWeek === "" || !form.governorate)
                return toast.error("الشركة واليوم والمحافظة مطلوبين");
              save.mutate({
                businessId,
                namespace: "shipping_schedule_route",
                configKey: `${provider.id}_${form.dayOfWeek}_${form.governorate}`,
                displayName: `${provider.displayName} · ${form.governorate}`,
                value: {
                  providerName: provider.displayName,
                  dayOfWeek: Number(form.dayOfWeek),
                  governorates: [form.governorate],
                  priority: Number(form.priority) || 0,
                  notes: form.notes || undefined,
                },
                sortOrder: -(Number(form.priority) || 0),
                isActive: true,
              });
            }}
          >
            <Save className="ml-2 h-4 w-4" />
            حفظ المسار
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {routes.data?.map(row => (
            <span
              key={row.id}
              className="rounded-full border px-3 py-1.5 text-sm"
            >
              {row.displayName} · {row.isActive ? "نشط" : "متوقف"}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CostCenterSettings({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const rows = trpc.accountingV2.costCenters.useQuery({ businessId });
  const [form, setForm] = useState({ code: "", name: "", isActive: true });
  const save = trpc.accountingV2.costCenterSave.useMutation({
    onSuccess: async () => {
      toast.success("تم حفظ مركز التكلفة");
      setForm({ code: "", name: "", isActive: true });
      await utils.accountingV2.costCenters.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">مراكز التكلفة</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 md:grid-cols-[1fr_2fr_auto_auto] md:items-end">
          <Field label="الكود">
            <Input
              dir="ltr"
              value={form.code}
              onChange={event => setForm({ ...form, code: event.target.value })}
            />
          </Field>
          <Field label="الاسم">
            <Input
              value={form.name}
              onChange={event => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <label className="flex h-10 items-center gap-2 text-sm">
            <Switch
              checked={form.isActive}
              onCheckedChange={isActive => setForm({ ...form, isActive })}
            />
            نشط
          </label>
          <Button
            disabled={save.isPending}
            onClick={() => {
              if (!form.code.trim() || !form.name.trim())
                return toast.error("الكود والاسم مطلوبين");
              save.mutate({
                businessId,
                code: form.code.trim(),
                name: form.name.trim(),
                isActive: form.isActive,
              });
            }}
          >
            <Save className="ml-2 h-4 w-4" />
            حفظ
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {rows.data?.map(row => (
            <button
              key={row.id}
              className="rounded-full border px-3 py-1.5 text-sm"
              onClick={() =>
                setForm({
                  code: row.code,
                  name: row.name,
                  isActive: row.isActive,
                })
              }
            >
              {row.name} · {row.code}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function BusinessSettings({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const settings = trpc.accountingV2.businessSettings.useQuery({ businessId });
  const warehouses = trpc.businesses.warehouses.useQuery({ businessId });
  const [form, setForm] = useState({
    baseCurrency: "EGP",
    timezone: "Africa/Cairo",
    accountingGoLiveAt: "",
    defaultWarehouseId: "",
  });
  useEffect(() => {
    if (!settings.data) return;
    setForm({
      baseCurrency: settings.data.baseCurrency,
      timezone: settings.data.timezone,
      accountingGoLiveAt: settings.data.accountingGoLiveAt
        ? new Date(settings.data.accountingGoLiveAt).toISOString().slice(0, 10)
        : "",
      defaultWarehouseId: settings.data.defaultWarehouseId
        ? String(settings.data.defaultWarehouseId)
        : "",
    });
  }, [settings.data]);
  const save = trpc.accountingV2.updateBusinessSettings.useMutation({
    onSuccess: async () => {
      toast.success("تم حفظ إعدادات الـ Business");
      await utils.accountingV2.businessSettings.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-5 w-5 text-sky-700" />
          نقطة التشغيل المحاسبية
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Base Currency">
          <Input
            maxLength={3}
            dir="ltr"
            value={form.baseCurrency}
            onChange={event =>
              setForm({
                ...form,
                baseCurrency: event.target.value.toUpperCase(),
              })
            }
          />
        </Field>
        <Field label="IANA Timezone">
          <Input
            dir="ltr"
            value={form.timezone}
            onChange={event =>
              setForm({ ...form, timezone: event.target.value })
            }
          />
        </Field>
        <Field label="Go-Live Date">
          <Input
            type="date"
            value={form.accountingGoLiveAt}
            onChange={event =>
              setForm({ ...form, accountingGoLiveAt: event.target.value })
            }
          />
        </Field>
        <Field label="المخزن الافتراضي">
          <select
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={form.defaultWarehouseId}
            onChange={event =>
              setForm({ ...form, defaultWarehouseId: event.target.value })
            }
          >
            <option value="">اختار المخزن</option>
            {warehouses.data?.map(warehouse => (
              <option key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
              </option>
            ))}
          </select>
        </Field>
        <Button
          className="md:col-span-2 xl:col-span-4 xl:justify-self-end"
          disabled={save.isPending}
          onClick={() => {
            if (!form.accountingGoLiveAt || !form.defaultWarehouseId)
              return toast.error("تاريخ التشغيل والمخزن الافتراضي مطلوبين");
            save.mutate({
              businessId,
              baseCurrency: form.baseCurrency,
              timezone: form.timezone,
              accountingGoLiveAt: new Date(
                `${form.accountingGoLiveAt}T00:00:00`
              ),
              defaultWarehouseId: Number(form.defaultWarehouseId),
            });
          }}
        >
          <Save className="ml-2 h-4 w-4" />
          حفظ الإعدادات الأساسية
        </Button>
      </CardContent>
    </Card>
  );
}

type NamespaceList = readonly (readonly [string, string])[];

/**
 * نفس المكوّن بيتنادى مرتين: مرة بالقوايم اليومية فوق، ومرة بالمتقدمة جوه «إعدادات
 * متقدمة». كده مفيش قايمة بقت مش قابلة للإدارة — بس اللي مش بتتلمس كل يوم مقفولة.
 */
function ConfigurationSettings({
  businessId,
  namespaces = CONFIG_NAMESPACES,
  title = "القيم التشغيلية القابلة للتهيئة",
}: {
  businessId: number;
  namespaces?: NamespaceList;
  title?: string;
}) {
  const [namespace, setNamespace] = useState<string>(namespaces[0][0]);
  const [draft, setDraft] = useState({
    configKey: "",
    displayName: "",
    sortOrder: "0",
    isActive: true,
  });
  const utils = trpc.useUtils();
  const values = trpc.accountingV2.configurationList.useQuery({
    businessId,
    namespace,
    activeOnly: false,
  });
  const save = trpc.accountingV2.configurationSave.useMutation({
    onSuccess: async () => {
      toast.success("تم حفظ القيمة التشغيلية");
      setDraft({
        configKey: "",
        displayName: "",
        sortOrder: "0",
        isActive: true,
      });
      await utils.accountingV2.configurationList.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const selectRow = (row: any) =>
    setDraft({
      configKey: row.configKey,
      displayName: row.displayName,
      sortOrder: String(row.sortOrder),
      isActive: row.isActive,
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Settings2 className="h-5 w-5 text-amber-600" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {namespaces.map(([key, label]) => (
            <Button
              key={key}
              variant={namespace === key ? "default" : "outline"}
              size="sm"
              className="whitespace-nowrap"
              onClick={() => {
                setNamespace(key);
                setDraft({
                  configKey: "",
                  displayName: "",
                  sortOrder: "0",
                  isActive: true,
                });
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_100px_auto_auto] md:items-end">
          <Field label="الكود الثابت">
            <Input
              dir="ltr"
              placeholder="مثال: cairo"
              value={draft.configKey}
              onChange={event =>
                setDraft({
                  ...draft,
                  configKey: event.target.value
                    .trim()
                    .toLowerCase()
                    .replace(/\s+/g, "_"),
                })
              }
            />
          </Field>
          <Field label="الاسم الظاهر">
            <Input
              value={draft.displayName}
              onChange={event =>
                setDraft({ ...draft, displayName: event.target.value })
              }
            />
          </Field>
          <Field label="الترتيب">
            <Input
              type="number"
              dir="ltr"
              value={draft.sortOrder}
              onChange={event =>
                setDraft({ ...draft, sortOrder: event.target.value })
              }
            />
          </Field>
          <label className="flex h-10 items-center gap-2 text-sm">
            <Switch
              checked={draft.isActive}
              onCheckedChange={isActive => setDraft({ ...draft, isActive })}
            />
            نشط
          </label>
          <Button
            disabled={save.isPending}
            onClick={() => {
              if (!draft.configKey || !draft.displayName.trim())
                return toast.error("الكود والاسم مطلوبين");
              save.mutate({
                businessId,
                namespace,
                configKey: draft.configKey,
                displayName: draft.displayName.trim(),
                sortOrder: Number(draft.sortOrder) || 0,
                isActive: draft.isActive,
              });
            }}
          >
            <Save className="ml-2 h-4 w-4" />
            حفظ
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {values.data?.map(row => (
            <button
              key={row.id}
              onClick={() => selectRow(row)}
              className="flex items-center justify-between rounded-lg border p-3 text-right text-sm hover:bg-muted/50"
            >
              <span>
                <strong>{row.displayName}</strong>
                <span className="mr-2 font-mono text-xs text-muted-foreground">
                  {row.configKey}
                </span>
              </span>
              <span
                className={
                  row.isActive ? "text-emerald-700" : "text-muted-foreground"
                }
              >
                {row.isActive ? "نشط" : "متوقف"}
              </span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function FinancialAccountSettings({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const settings = trpc.accountingV2.businessSettings.useQuery({ businessId });
  const accounts = trpc.accountingV2.financialAccounts.useQuery({ businessId });
  const accountTypes = trpc.accountingV2.configurationList.useQuery({
    businessId,
    namespace: "financial_account_type",
    activeOnly: true,
  });
  const [form, setForm] = useState({
    code: "",
    name: "",
    accountType: "",
    openingBalance: "0",
    openingBalanceAt: "",
    openingEvidenceUrl: "",
    isCashEquivalent: true,
    allowNegativeBalance: false,
  });
  const create = trpc.accountingV2.financialAccountCreate.useMutation({
    onSuccess: async () => {
      toast.success("تم إنشاء الحساب المالي");
      setForm({
        code: "",
        name: "",
        accountType: "",
        openingBalance: "0",
        openingBalanceAt: "",
        openingEvidenceUrl: "",
        isCashEquivalent: true,
        allowNegativeBalance: false,
      });
      await utils.accountingV2.financialAccounts.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Landmark className="h-5 w-5 text-emerald-700" />
          الحسابات المالية
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="الكود">
            <Input
              dir="ltr"
              value={form.code}
              onChange={event => setForm({ ...form, code: event.target.value })}
            />
          </Field>
          <Field label="اسم الحساب">
            <Input
              value={form.name}
              onChange={event => setForm({ ...form, name: event.target.value })}
            />
          </Field>
          <Field label="نوع الحساب">
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={form.accountType}
              onChange={event =>
                setForm({ ...form, accountType: event.target.value })
              }
            >
              <option value="">اختار من الإعدادات</option>
              {accountTypes.data?.map(row => (
                <option key={row.id} value={row.configKey}>
                  {row.displayName}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={`الرصيد الافتتاحي (${settings.data?.baseCurrency ?? ""})`}
          >
            <Input
              dir="ltr"
              inputMode="decimal"
              value={form.openingBalance}
              onChange={event =>
                setForm({ ...form, openingBalance: event.target.value })
              }
            />
          </Field>
          <Field label="تاريخ الرصيد الافتتاحي">
            <Input
              type="date"
              value={form.openingBalanceAt}
              onChange={event =>
                setForm({ ...form, openingBalanceAt: event.target.value })
              }
            />
          </Field>
          <EvidenceUpload
            label="دليل الرصيد الافتتاحي"
            value={form.openingEvidenceUrl}
            onChange={openingEvidenceUrl =>
              setForm({ ...form, openingEvidenceUrl })
            }
          />
          <label className="flex h-10 items-center gap-2 self-end text-sm">
            <Switch
              checked={form.isCashEquivalent}
              onCheckedChange={isCashEquivalent =>
                setForm({ ...form, isCashEquivalent })
              }
            />
            Cash Equivalent
          </label>
          <label className="flex h-10 items-center gap-2 self-end text-sm">
            <Switch
              checked={form.allowNegativeBalance}
              onCheckedChange={allowNegativeBalance =>
                setForm({ ...form, allowNegativeBalance })
              }
            />
            يسمح برصيد سالب
          </label>
          <Button
            className="md:col-span-2 xl:col-span-4 xl:justify-self-end"
            disabled={create.isPending}
            onClick={() => {
              if (!form.code.trim() || !form.name.trim() || !form.accountType)
                return toast.error("بيانات الحساب الأساسية مطلوبة");
              create.mutate({
                businessId,
                code: form.code.trim(),
                name: form.name.trim(),
                accountType: form.accountType,
                currencyCode: settings.data?.baseCurrency ?? "EGP",
                isCashEquivalent: form.isCashEquivalent,
                allowNegativeBalance: form.allowNegativeBalance,
                openingBalance: form.openingBalance || "0",
                openingBalanceAt: form.openingBalanceAt
                  ? new Date(`${form.openingBalanceAt}T00:00:00`)
                  : undefined,
                openingEvidenceUrl: form.openingEvidenceUrl || undefined,
              });
            }}
          >
            <Plus className="ml-2 h-4 w-4" />
            إنشاء حساب
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {accounts.data?.map(account => (
            <div key={account.id} className="rounded-xl border p-4">
              <div className="flex items-start justify-between">
                <div>
                  <strong>{account.name}</strong>
                  <p className="font-mono text-xs text-muted-foreground">
                    {account.code} · {account.accountType}
                  </p>
                </div>
                <span className="text-xs text-muted-foreground">
                  {account.currencyCode}
                </span>
              </div>
              <p className="mt-3 text-xl font-black" dir="ltr">
                {account.currentBalance}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ShippingSettings({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const configuration = trpc.accountingV2.shippingConfiguration.useQuery({
    businessId,
  });
  const accounts = trpc.accountingV2.financialAccounts.useQuery({ businessId });
  const configQueries = {
    governorate: trpc.accountingV2.configurationList.useQuery({
      businessId,
      namespace: "governorate",
      activeOnly: true,
    }),
    shippingType: trpc.accountingV2.configurationList.useQuery({
      businessId,
      namespace: "shipping_type",
      activeOnly: true,
    }),
    paymentType: trpc.accountingV2.configurationList.useQuery({
      businessId,
      namespace: "payment_type",
      activeOnly: true,
    }),
    chargeType: trpc.accountingV2.configurationList.useQuery({
      businessId,
      namespace: "shipping_charge_type",
      activeOnly: true,
    }),
    billingEvent: trpc.accountingV2.configurationList.useQuery({
      businessId,
      namespace: "shipping_billing_event",
      activeOnly: true,
    }),
  };
  const [provider, setProvider] = useState({
    providerCode: "",
    providerName: "",
    displayName: "",
    codSettlementAccountId: "",
  });
  const [rate, setRate] = useState({
    businessShippingProviderId: "",
    governorate: "",
    shippingType: "",
    paymentType: "",
    priority: "0",
    effectiveFrom: "",
  });
  const [charges, setCharges] = useState<ChargeDraft[]>([emptyCharge()]);
  const activeProviders = (configuration.data?.providers ?? []).filter(
    row => row.isActive
  );
  const providerSave = trpc.accountingV2.shippingProviderSave.useMutation({
    onSuccess: async () => {
      toast.success("اتضافت شركة الشحن");
      setProvider({ ...provider, displayName: "" });
      await utils.accountingV2.shippingConfiguration.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const providerRemove = trpc.accountingV2.shippingProviderDeactivate.useMutation({
    onSuccess: async () => {
      toast.success("اتشالت من القايمة");
      await utils.accountingV2.shippingConfiguration.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const rateSave = trpc.accountingV2.shippingRateVersionCreate.useMutation({
    onSuccess: async () => {
      toast.success("تم إنشاء نسخة سعر شحن جديدة");
      setCharges([emptyCharge()]);
      await utils.accountingV2.shippingConfiguration.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const updateCharge = (index: number, next: Partial<ChargeDraft>) =>
    setCharges(current =>
      current.map((charge, chargeIndex) =>
        chargeIndex === index ? { ...charge, ...next } : charge
      )
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="h-5 w-5 text-orange-600" />
          شركات الشحن والأسعار
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/*
          إضافة شركة الشحن — حقل واحد.
          كان أربع حقول (كود، اسم رسمي، اسم ظاهر، حساب COD) وربط حالات إجباري. التاجر
          مش عارف الفرق بين الاسم الرسمي والظاهر، فكان بيكتب نفس الكلمة تلات مرات —
          وأول ما يغيّر حرف في الكود بيتعمل صف جديد بدل ما يعدّل القديم. فبقى اسم واحد
          هو الكود والاسم الرسمي والظاهر، والقيد الفريد بيخلي نفس الاسم يعدّل مايكررش.
        */}
        <div className="space-y-3">
          {activeProviders.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium">شركات الشحن عندك</p>
              {activeProviders.map(row => (
                <div
                  key={row.id}
                  className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm"
                >
                  <span className="flex items-center gap-2">
                    <Truck className="h-4 w-4 shrink-0 text-orange-600" />
                    {row.displayName}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive"
                    disabled={providerRemove.isPending}
                    onClick={() => {
                      if (
                        !confirm(
                          `تشيل «${row.displayName}»؟ التحصيلات القديمة بتاعتها هتفضل زي ما هي.`
                        )
                      )
                        return;
                      providerRemove.mutate({
                        businessId,
                        businessShippingProviderId: row.id,
                      });
                    }}
                  >
                    شيل
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Field label="اسم شركة الشحن">
                <Input
                  placeholder="بوسطة"
                  value={provider.displayName}
                  onChange={event =>
                    setProvider({ ...provider, displayName: event.target.value })
                  }
                />
              </Field>
            </div>
            <Button
              disabled={providerSave.isPending}
              onClick={() => {
                const name = provider.displayName.trim();
                if (!name) return toast.error("اكتب اسم شركة الشحن");
                providerSave.mutate({
                  businessId,
                  providerCode: name,
                  providerName: name,
                  displayName: name,
                  statusMapping: {},
                });
              }}
            >
              <Save className="ml-2 h-4 w-4" />
              إضافة
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            الاسم ده اللي هتختاره من «تحصيل اليوم». لو ضفت نفس الاسم تاني، بيتعدّل
            مابيتكررش.
          </p>
        </div>

        {/*
          «نسخة سعر جديدة» اتشالت من هنا.

          هي كانت بتسجّل تكلفة الشحن **المتوقعة** لكل محافظة/نوع شحن/نوع دفع، عشان
          تتقارن بعدين بالرسوم الفعلية اللي شركة الشحن خصمتها. التاجر بيسجّل الرسوم
          الفعلية في «تحصيل اليوم» على طول — فالمتوقع مالوش مقارنة يعملها، وكان بياخد
          نص الصفحة عشان ملهوش استخدام.

          الجداول (`shipping_rate_versions` و`shipping_rate_charges`) والخدمات
          والـendpoints كلهم مكانهم. اللي اتشال هو الفورم من الشاشة دي.
        */}

      </CardContent>
    </Card>
  );
}

function PermissionSettings() {
  const utils = trpc.useUtils();
  const configuration = trpc.accountingV2.permissionConfiguration.useQuery();
  const [role, setRole] = useState("");
  const save = trpc.accountingV2.rolePermissionSave.useMutation({
    onSuccess: async () => {
      toast.success("تم حفظ Override الصلاحية");
      await utils.accountingV2.permissionConfiguration.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  useEffect(() => {
    if (!role && configuration.data?.roles[0])
      setRole(configuration.data.roles[0].role);
  }, [configuration.data, role]);
  const effective = useMemo(() => {
    const defaults = new Set(
      configuration.data?.roles.find(row => row.role === role)
        ?.defaultPermissions ?? []
    );
    for (const override of configuration.data?.overrides.filter(
      row => row.role === role
    ) ?? [])
      override.isAllowed
        ? defaults.add(override.permission as any)
        : defaults.delete(override.permission as any);
    return defaults;
  }, [configuration.data, role]);
  if (configuration.error?.data?.code === "FORBIDDEN") return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="h-5 w-5 text-rose-700" />
          صلاحيات الأدوار
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <select
          className="h-10 w-full max-w-xs rounded-md border bg-background px-3 text-sm"
          value={role}
          onChange={event => setRole(event.target.value)}
        >
          {configuration.data?.roles.map(row => (
            <option key={row.role} value={row.role}>
              {row.role}
            </option>
          ))}
        </select>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {configuration.data?.permissions.map(permission => (
            <label
              key={permission}
              className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm"
            >
              <span className="font-mono text-xs">{permission}</span>
              <Switch
                checked={effective.has(permission)}
                disabled={save.isPending}
                onCheckedChange={isAllowed =>
                  save.mutate({ role: role as any, permission, isAllowed })
                }
              />
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1 ${className}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <Field label={label}>
      <select
        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        value={value}
        onChange={event => onChange(event.target.value)}
      >
        <option value="">اختار</option>
        {options.map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
    </Field>
  );
}

function configurationOptions(
  rows: Array<{ configKey: string; displayName: string }> | undefined
): Array<[string, string]> {
  return rows?.map(row => [row.configKey, row.displayName]) ?? [];
}
