import { useMemo, useState } from "react";
import {
  Search, ExternalLink, PlugZap, CheckCircle2,
  Store, Truck, Bike, BarChart3,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * سوق التكاملات (Marketplace) — **تخطيط Frontend فقط**. مفيش أي تكامل وهمي في الـBackend:
 *   • "متاح للربط"  → بيفتح إضافة قناة بمنصة محددة (المدعوم فعليًا: EasyOrder + قناة يدوية).
 *   • "قريبًا"       → عرض بس، من غير زر ربط.
 *   • "اشتراك مطلوب" → عرض بس، لتكاملات مدفوعة مستقبلًا.
 * الألوان من هوية متجرك (tokens)، مش منقولة من أي مرجع خارجي.
 */

type IntegrationStatus = "available" | "coming_soon" | "subscription";
type CategoryKey = "stores" | "shipping" | "delivery" | "analytics";

interface CatalogItem {
  id: string;
  name: string;
  category: CategoryKey;
  description: string;
  status: IntegrationStatus;
  /** المنصة اللي تتفتح في نموذج الإضافة عند "ربط" (للمتاح فقط). */
  connectPlatform?: string;
  website?: string;
}

const CATEGORIES: { key: CategoryKey | "all"; label: string }[] = [
  { key: "all", label: "الكل" },
  { key: "stores", label: "منصات المتاجر" },
  { key: "shipping", label: "شركات الشحن" },
  { key: "delivery", label: "التوصيل والمناديب" },
  { key: "analytics", label: "الربحية والتحليلات" },
];

const CATEGORY_ICON: Record<CategoryKey, typeof Store> = {
  stores: Store,
  shipping: Truck,
  delivery: Bike,
  analytics: BarChart3,
};

const CATEGORY_LABEL: Record<CategoryKey, string> = {
  stores: "منصات المتاجر",
  shipping: "شركات الشحن",
  delivery: "التوصيل والمناديب",
  analytics: "الربحية والتحليلات",
};

// كتالوج ثابت — الحالة بتعكس الدعم الفعلي في الـBackend (EasyOrder بس هو الـwebhook الحقيقي).
const CATALOG: CatalogItem[] = [
  { id: "easyorder", name: "EasyOrder", category: "stores", status: "available", connectPlatform: "easyorder",
    description: "استقبل أوردرات متجرك أوتوماتيك عبر Webhook فور إنشائها.", website: "https://easy-orders.net" },
  { id: "manual", name: "قناة يدوية / أخرى", category: "stores", status: "available", connectPlatform: "manual",
    description: "سجّل قناة بيع تدخّل أوردراتها يدويًا (متجر بسيط أو مصدر آخر)." },
  { id: "shopify", name: "Shopify", category: "stores", status: "coming_soon",
    description: "ربط متجر شوبيفاي واستقبال أوردراته تلقائيًا.", website: "https://www.shopify.com" },
  { id: "woocommerce", name: "WooCommerce", category: "stores", status: "coming_soon",
    description: "ربط متجر ووردبريس/ووكومرس واستقبال أوردراته." },
  { id: "bosta", name: "Bosta", category: "shipping", status: "coming_soon",
    description: "إنشاء شحنات ومتابعة حالتها مع بوسطة لكل نشاط بحسابه.", website: "https://bosta.co" },
  { id: "shipping_other", name: "شركات شحن أخرى", category: "shipping", status: "coming_soon",
    description: "تكاملات شحن إضافية قيد التحضير." },
  { id: "reps", name: "مناديب التوصيل", category: "delivery", status: "coming_soon",
    description: "إدارة مناديب التوصيل المحليين وتوزيع الأوردرات عليهم." },
  { id: "analytics_pro", name: "لوحة الربحية", category: "analytics", status: "subscription",
    description: "تحليلات ربحية متقدمة لكل نشاط ومنتج وحملة إعلانية." },
];

const STATUS_BADGE: Record<IntegrationStatus, { label: string; cls: string }> = {
  available: { label: "متاح للربط", cls: "border-[var(--success)]/30 bg-[var(--success)]/10 text-[var(--success)]" },
  coming_soon: { label: "قريبًا", cls: "border-border bg-muted text-muted-foreground" },
  subscription: { label: "اشتراك مطلوب", cls: "border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[var(--warning)]" },
};

export function IntegrationsMarketplace({
  connectedPlatforms,
  onConnect,
}: {
  connectedPlatforms: Set<string>;
  onConnect: (platform: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryKey | "all">("all");

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CATALOG.filter(item => {
      if (category !== "all" && item.category !== category) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        CATEGORY_LABEL[item.category].includes(q)
      );
    });
  }, [query, category]);

  return (
    <div className="space-y-4">
      {/* بحث + تصنيفات */}
      <div className="flex flex-col gap-3">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="ابحث عن منصة أو خدمة"
            className="pr-9"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.map(c => (
            <button
              key={c.key}
              type="button"
              onClick={() => setCategory(c.key)}
              className={`rounded-[var(--radius-brand-pill,9999px)] border px-3 py-1.5 text-sm font-medium transition-colors ${
                category === c.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-muted-foreground hover:bg-muted"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* شبكة التكاملات */}
      {items.length === 0 ? (
        <div className="rounded-[var(--radius-brand-card,0.75rem)] border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          مفيش تكاملات مطابقة لبحثك.
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map(item => {
            const Icon = CATEGORY_ICON[item.category];
            const badge = STATUS_BADGE[item.status];
            const isConnected = item.connectPlatform ? connectedPlatforms.has(item.connectPlatform) : false;
            return (
              <div
                key={item.id}
                className="flex flex-col rounded-[var(--radius-brand-card,0.75rem)] border border-border bg-card p-4 transition-shadow hover:shadow-sm"
              >
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-brand-card,0.75rem)] bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-semibold leading-tight text-foreground">{item.name}</p>
                      <p className="text-xs text-muted-foreground">{CATEGORY_LABEL[item.category]}</p>
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${badge.cls}`}>
                    {isConnected ? "مربوط" : badge.label}
                  </span>
                </div>

                <p className="mb-4 flex-1 text-sm text-muted-foreground">{item.description}</p>

                <div className="flex items-center gap-2">
                  {item.status === "available" ? (
                    isConnected ? (
                      <Button variant="outline" size="sm" className="gap-1.5" onClick={() => item.connectPlatform && onConnect(item.connectPlatform)}>
                        <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
                        إضافة قناة أخرى
                      </Button>
                    ) : (
                      <Button size="sm" className="gap-1.5" onClick={() => item.connectPlatform && onConnect(item.connectPlatform)}>
                        <PlugZap className="h-4 w-4" />
                        ربط الحساب
                      </Button>
                    )
                  ) : (
                    <Button variant="outline" size="sm" disabled className="gap-1.5">
                      {STATUS_BADGE[item.status].label}
                    </Button>
                  )}
                  {item.website && (
                    <a
                      href={item.website}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      الموقع
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
