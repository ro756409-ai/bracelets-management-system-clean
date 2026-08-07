import { useMemo, useState } from "react";
import {
  Megaphone, TrendingUp, MessageSquare, ShoppingCart, Trophy, AlertCircle, RefreshCw, Save,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { useBrandOptions } from "@/hooks/useBrandOptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { PageHeader, SectionCard } from "@/components/shared";
import { toast } from "sonner";
import {
  costPerOrder, costPerMessage, conversionRate, roas,
  rankCampaigns, summariseCampaigns, type CampaignKind, type CampaignRow,
} from "@shared/adMetrics";

/**
 * الإعلانات.
 *
 * كل يوم المعلن بيسجّل اللي صرفه إمبارح على كل حملة. الصرف بيتسجّل عن طريق
 * `accountingV2.adSpendCreate` الموجود — بيعمل **مصروف واحد** ومربوط بيه صف في
 * `ad_spend_entries` بقيد فريد على `expenseId`، فمستحيل نفس الصرف يتسجّل مرتين.
 *
 * المقاييس (أوردرات، رسايل، إيراد) بتتخزّن في `manualMetricsJson` — عمود JSON حر موجود
 * من الأصل. مفيش عمود جديد ولا جدول ولا مسار مصروفات تاني.
 *
 * والحساب كله في `shared/adMetrics`: القسمة على صفر بترجّع null والواجهة بتعرضها «—»،
 * لأن حملة صرفت وجابت صفر أوردر **مالهاش** تكلفة أوردر، وتكلفتها مش صفر.
 */

const money = (n: number | null | undefined) =>
  n == null ? "—" : Number(n).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const dec = (n: number | null | undefined, digits = 2) =>
  n == null ? "—" : Number(n).toLocaleString("ar-EG", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function cairoToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
const monthStart = () => `${cairoToday().slice(0, 7)}-01`;

export default function Advertising() {
  const { currentBusinessIds } = useBusinessContext();
  const {
    brands, selected: businessId, setSelected: setBusinessId,
    selectedId: bid, isEmpty: noBrands,
  } = useBrandOptions();

  // ── النموذج ──
  const [pageName, setPageName] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [kind, setKind] = useState<CampaignKind>("sales");
  const [spendDate, setSpendDate] = useState(cairoToday);
  const [amount, setAmount] = useState("");
  const [orders, setOrders] = useState("");
  const [messages, setMessages] = useState("");
  const [revenue, setRevenue] = useState("");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  // ── الفترة المعروضة ──
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(cairoToday);

  const scope = currentBusinessIds?.length ? { businessIds: currentBusinessIds } : {};
  const campaigns = trpc.accounting.adCampaigns.useQuery(
    {
      ...scope,
      dateFrom: new Date(`${from}T00:00:00`),
      dateTo: new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000),
    },
    { retry: false }
  );

  const create = trpc.accountingV2.adSpendCreate.useMutation({
    onSuccess: () => {
      toast.success("اتسجّل — المصروف مستحق لحد ما يتدفع");
      setCampaignName(""); setAmount(""); setOrders(""); setMessages("");
      setRevenue(""); setNotes(""); setErrors({});
      campaigns.refetch();
    },
    onError: e => toast.error(e.message),
  });

  const rows = campaigns.data ?? [];
  const [editing, setEditing] = useState<any | null>(null);

  const asCampaignRows: CampaignRow[] = useMemo(
    () => rows.map(r => ({
      campaignName: r.campaignName,
      kind: r.kind as CampaignKind,
      spend: r.spend,
      orders: r.orders,
      messages: r.messages,
      revenue: r.revenue,
    })),
    [rows]
  );

  const totals = useMemo(() => summariseCampaigns(asCampaignRows), [asCampaignRows]);
  const ranked = useMemo(() => rankCampaigns(asCampaignRows), [asCampaignRows]);

  const todaySpend = useMemo(() => {
    const today = cairoToday();
    return rows
      .filter(r => new Date(r.spendDate).toISOString().slice(0, 10) === today)
      .reduce((s, r) => s + r.spend, 0);
  }, [rows]);

  // ── معاينة حيّة للنموذج ──
  const preview = useMemo(() => ({
    perOrder: costPerOrder(amount, orders),
    perMessage: costPerMessage(amount, messages),
    conversion: conversionRate(orders, messages),
    roas: roas(revenue || null, amount),
  }), [amount, orders, messages, revenue]);

  const validate = () => {
    const next: Record<string, string> = {};
    if (!bid) next.businessId = noBrands ? "مفيش أنشطة متاحة" : "اختار النشاط";
    if (!pageName.trim()) next.page = "اسم الصفحة مطلوب";
    if (!campaignName.trim()) next.campaign = "اسم الحملة مطلوب";
    if (!spendDate) next.date = "التاريخ مطلوب";
    if (!amount.trim() || !(Number(amount) > 0)) next.amount = "المصروف لازم يكون أكبر من صفر";
    if (kind === "sales" && orders !== "" && Number(orders) < 0) next.orders = "العدد ماينفعش بالسالب";
    if (kind === "messages" && messages !== "" && Number(messages) < 0) next.messages = "العدد ماينفعش بالسالب";
    if (kind === "messages" && Number(orders) > Number(messages || 0))
      next.orders = "الأوردرات الناتجة ماتزيدش عن عدد الرسايل";
    if (revenue !== "" && Number(revenue) < 0) next.revenue = "الإيراد ماينفعش بالسالب";
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const save = () => {
    if (!validate()) { toast.error("فيه حقول ناقصة — بُصّ على الرسايل الحمرا"); return; }
    // المقاييس بتروح في manualMetrics — الحقل الحر اللي العقد بيقبله أصلاً.
    const metrics: Record<string, number> = {};
    if (kind === "sales") { if (orders !== "") metrics.orders = Number(orders); }
    else {
      if (messages !== "") metrics.messages = Number(messages);
      if (orders !== "") metrics.orders = Number(orders);
    }
    if (revenue !== "") metrics.revenue = Number(revenue);

    create.mutate({
      businessId: bid!,
      amount: Number(amount).toFixed(4),
      description: `إعلانات — ${campaignName.trim()}`,
      serviceFrom: spendDate,
      serviceTo: spendDate,
      platformId: "facebook",
      platformName: "فيسبوك",
      // الصفحة هي الحساب الإعلاني من وجهة نظر التاجر.
      accountId: pageName.trim(),
      accountName: pageName.trim(),
      // مفيش ربط بـAPI فيسبوك، فالمعرّف بيتبني من الاسم والتاريخ عشان يفضل ثابت.
      campaignId: `${campaignName.trim()}::${spendDate}`,
      campaignName: campaignName.trim(),
      manualMetrics: Object.keys(metrics).length ? metrics : undefined,
      notes: notes.trim() || undefined,
    });
  };

  const showError = (k: string) =>
    errors[k] ? <p className="mt-1 text-xs text-destructive">{errors[k]}</p> : null;

  const cards = [
    { label: "صرف النهاردة", value: money(todaySpend), icon: Megaphone, tone: "var(--purple)" },
    { label: "صرف الفترة", value: money(totals.spend), icon: TrendingUp, tone: "var(--info)" },
    { label: "أوردرات", value: String(totals.orders), icon: ShoppingCart, tone: "var(--success)" },
    { label: "رسايل", value: String(totals.messages), icon: MessageSquare, tone: "var(--warning)" },
    { label: "متوسط تكلفة الأوردر", value: money(totals.avgCostPerOrder), icon: ShoppingCart, tone: "var(--success)" },
    { label: "متوسط تكلفة الرسالة", value: money(totals.avgCostPerMessage), icon: MessageSquare, tone: "var(--warning)" },
    { label: "العائد على الإنفاق", value: totals.roas == null ? "—" : `${dec(totals.roas)}×`, icon: TrendingUp, tone: "var(--purple)" },
  ];

  return (
    <div className="space-y-4" dir="rtl">
      <PageHeader
        title="الإعلانات"
        description="سجّل صرف كل حملة ونتيجتها. الأرقام بتتحسب لوحدها، والصرف بيتسجّل كمصروف واحد."
      />

      {/* ── تسجيل حملة ── */}
      <SectionCard>
        {noBrands && (
          <p className="mb-3 flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <span>مفيش أنشطة متاحة لحسابك.</span>
          </p>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {brands.length > 1 && (
            <div>
              <Label>النشاط <span className="text-destructive">*</span></Label>
              <Select value={businessId} onValueChange={setBusinessId}>
                <SelectTrigger className="mt-1"><SelectValue placeholder="اختار النشاط" /></SelectTrigger>
                <SelectContent>
                  {brands.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
              {showError("businessId")}
            </div>
          )}
          <div>
            <Label>الصفحة <span className="text-destructive">*</span></Label>
            <Input className="mt-1" value={pageName} placeholder="اسم صفحة فيسبوك"
              onChange={e => setPageName(e.target.value)} />
            {showError("page")}
          </div>
          <div>
            <Label>اسم الحملة <span className="text-destructive">*</span></Label>
            <Input className="mt-1" value={campaignName} placeholder="حملة أغسطس"
              onChange={e => setCampaignName(e.target.value)} />
            {showError("campaign")}
          </div>
          <div>
            <Label>نوع الحملة <span className="text-destructive">*</span></Label>
            <Select value={kind} onValueChange={v => setKind(v as CampaignKind)}>
              <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sales">مبيعات</SelectItem>
                <SelectItem value="messages">رسايل</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>التاريخ <span className="text-destructive">*</span></Label>
            <Input className="mt-1" type="date" value={spendDate} max={cairoToday()}
              onChange={e => setSpendDate(e.target.value)} />
            {showError("date")}
          </div>
          <div>
            <Label>المصروف <span className="text-destructive">*</span></Label>
            <Input className="mt-1" type="number" min="0" step="0.01" dir="ltr" placeholder="0.00"
              value={amount} onChange={e => setAmount(e.target.value)} />
            {showError("amount")}
          </div>

          {kind === "sales" ? (
            <>
              <div>
                <Label>عدد الأوردرات</Label>
                <Input className="mt-1" type="number" min="0" dir="ltr" placeholder="0"
                  value={orders} onChange={e => setOrders(e.target.value)} />
                {showError("orders")}
              </div>
              <div>
                <Label>الإيراد</Label>
                <Input className="mt-1" type="number" min="0" step="0.01" dir="ltr" placeholder="اختياري"
                  value={revenue} onChange={e => setRevenue(e.target.value)} />
                {showError("revenue")}
              </div>
            </>
          ) : (
            <>
              <div>
                <Label>عدد الرسايل</Label>
                <Input className="mt-1" type="number" min="0" dir="ltr" placeholder="0"
                  value={messages} onChange={e => setMessages(e.target.value)} />
                {showError("messages")}
              </div>
              <div>
                <Label>أوردرات ناتجة من الرسايل</Label>
                <Input className="mt-1" type="number" min="0" dir="ltr" placeholder="0"
                  value={orders} onChange={e => setOrders(e.target.value)} />
                {showError("orders")}
              </div>
            </>
          )}

          <div className="sm:col-span-2 lg:col-span-4">
            <Label>ملاحظات</Label>
            <Textarea className="mt-1" rows={2} value={notes} placeholder="اختياري..."
              onChange={e => setNotes(e.target.value)} />
          </div>
        </div>

        {/* المعاينة الحيّة — نفس دوال الحساب اللي بتشتغل على الجدول تحت */}
        <div className="mt-3 flex flex-wrap gap-4 rounded-lg border bg-muted/30 p-3 text-xs">
          {kind === "sales" ? (
            <>
              <span>تكلفة الأوردر <strong className="tabular-nums">{money(preview.perOrder)}</strong></span>
              <span>العائد <strong className="tabular-nums">{preview.roas == null ? "—" : `${dec(preview.roas)}×`}</strong></span>
            </>
          ) : (
            <>
              <span>تكلفة الرسالة <strong className="tabular-nums">{money(preview.perMessage)}</strong></span>
              <span>نسبة التحويل <strong className="tabular-nums">{preview.conversion == null ? "—" : `${dec(preview.conversion, 1)}%`}</strong></span>
              <span>تكلفة الأوردر <strong className="tabular-nums">{money(preview.perOrder)}</strong></span>
            </>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button className="gap-1.5" onClick={save} disabled={create.isPending}>
            <Save className="h-4 w-4" />
            {create.isPending ? "جاري التسجيل..." : "تسجيل الحملة"}
          </Button>
        </div>

        <p className="mt-3 flex items-start gap-1.5 rounded-md bg-warning/10 p-2 text-xs text-muted-foreground">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <span>
            الصرف بيتسجّل <strong className="text-foreground">مصروف مستحق</strong> — الفلوس
            مابتخرجش من الخزنة دلوقتي. الخصم بيحصل لما المصروف يتدفع، وده محتاج حساب مالي
            متسجّل. لسه مفيش حسابات مالية في النظام، فالصرف بيفضل مستحق.
          </span>
        </p>
      </SectionCard>

      {/* ── اللوحة ── */}
      <SectionCard>
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <Label className="text-xs">من</Label>
            <Input type="date" className="mt-1 h-10" value={from} max={to}
              onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <Label className="text-xs">إلى</Label>
            <Input type="date" className="mt-1 h-10" value={to} min={from} max={cairoToday()}
              onChange={e => setTo(e.target.value)} />
          </div>
          <Button variant="outline" className="ms-auto h-10 gap-1.5"
            onClick={() => campaigns.refetch()} disabled={campaigns.isFetching}>
            <RefreshCw className={`h-4 w-4 ${campaigns.isFetching ? "animate-spin" : ""}`} /> تحديث
          </Button>
        </div>

        {campaigns.isError && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <p className="font-bold text-destructive">مش قادر أجيب الحملات</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{campaigns.error?.message}</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          {cards.map(c => {
            const Icon = c.icon;
            return (
              <div key={c.label} className="rounded-lg border bg-card p-3">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: c.tone }} />
                  <span className="truncate">{c.label}</span>
                </div>
                <p className="mt-1.5 text-base font-black tabular-nums">
                  {campaigns.isLoading
                    ? <span className="inline-block h-5 w-16 animate-pulse rounded bg-muted" />
                    : c.value}
                </p>
              </div>
            );
          })}
        </div>

        {/* أحسن وأسوأ — المقارنة جوّه نفس النوع، لأن الوحدة مختلفة */}
        {(ranked.best || ranked.worst) && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {ranked.best && (
              <div className="rounded-lg border p-3" style={{ borderColor: "var(--success)" }}>
                <p className="flex items-center gap-1.5 text-xs font-bold" style={{ color: "var(--success)" }}>
                  <Trophy className="h-3.5 w-3.5" /> أحسن حملة
                </p>
                <p className="mt-1 truncate text-sm font-semibold">{ranked.best.row.campaignName}</p>
                <p className="text-xs text-muted-foreground">
                  {ranked.best.row.kind === "messages" ? "تكلفة الرسالة" : "تكلفة الأوردر"}{" "}
                  <strong className="tabular-nums text-foreground">{money(ranked.best.unitCost)}</strong> ج.م
                </p>
              </div>
            )}
            {ranked.worst && ranked.worst.row.campaignName !== ranked.best?.row.campaignName && (
              <div className="rounded-lg border p-3" style={{ borderColor: "var(--destructive)" }}>
                <p className="flex items-center gap-1.5 text-xs font-bold" style={{ color: "var(--destructive)" }}>
                  <AlertCircle className="h-3.5 w-3.5" /> أغلى حملة
                </p>
                <p className="mt-1 truncate text-sm font-semibold">{ranked.worst.row.campaignName}</p>
                <p className="text-xs text-muted-foreground">
                  {ranked.worst.row.kind === "messages" ? "تكلفة الرسالة" : "تكلفة الأوردر"}{" "}
                  <strong className="tabular-nums text-foreground">{money(ranked.worst.unitCost)}</strong> ج.م
                </p>
              </div>
            )}
          </div>
        )}

        {ranked.withoutResults.length > 0 && (
          <p className="mt-3 flex items-start gap-1.5 rounded-md bg-destructive/10 p-2 text-xs">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <span>
              <strong>{ranked.withoutResults.length}</strong> حملة صرفت ومجابتش نتيجة:{" "}
              {ranked.withoutResults.map(r => r.campaignName).join("، ")}
            </span>
          </p>
        )}
      </SectionCard>

      {/* ── الجدول ── */}
      <SectionCard>
        <h3 className="mb-3 text-sm font-bold">الحملات</h3>
        {campaigns.isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map(i => <div key={i} className="h-11 animate-pulse rounded bg-muted" />)}
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">مفيش حملات في الفترة دي.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b text-right text-xs text-muted-foreground">
                  <th className="p-2">التاريخ</th>
                  <th className="p-2">الصفحة</th>
                  <th className="p-2">الحملة</th>
                  <th className="p-2">النوع</th>
                  <th className="p-2">المصروف</th>
                  <th className="p-2">أوردرات</th>
                  <th className="p-2">رسايل</th>
                  <th className="p-2">تكلفة الوحدة</th>
                  <th className="p-2">العائد</th>
                  <th className="p-2">الحالة</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r: any) => {
                  const unit = r.kind === "messages"
                    ? costPerMessage(r.spend, r.messages)
                    : costPerOrder(r.spend, r.orders);
                  return (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="p-2 whitespace-nowrap tabular-nums">
                        {new Date(r.spendDate).toLocaleDateString("ar-EG")}
                      </td>
                      <td className="p-2">{r.accountName}</td>
                      <td className="p-2">{r.campaignName}</td>
                      <td className="p-2 whitespace-nowrap text-xs">
                        {r.kind === "messages" ? "رسايل" : "مبيعات"}
                      </td>
                      <td className="p-2 tabular-nums font-semibold">{money(r.spend)}</td>
                      <td className="p-2 tabular-nums">{r.orders || "—"}</td>
                      <td className="p-2 tabular-nums">{r.messages || "—"}</td>
                      <td className="p-2 tabular-nums">{money(unit)}</td>
                      <td className="p-2 tabular-nums">
                        {r.revenue == null ? "—" : `${dec(roas(r.revenue, r.spend))}×`}
                      </td>
                      <td className="p-2 whitespace-nowrap text-xs"
                        style={{ color: r.paidAmount > 0 ? "var(--success)" : "var(--warning)" }}>
                        {r.paidAmount > 0 ? "مدفوع" : "مستحق"}
                      </td>
                      <td className="p-2 text-left">
                        {/*
                          التعديل للمسودة بس. أول ما الصرف يتعتمد بيبقى ليه استحقاق
                          يومي، وأول ما يتدفع بيبقى ليه حركة خزنة — وتعديل المبلغ بعد
                          أي واحدة فيهم بيخلي الدفتر يكدب. السيرفر بيرفضها برضه؛ ده
                          مجرد إننا مانوريش زرار مايشتغلش.
                        */}
                        {r.expenseStatus === "draft" ? (
                          <button
                            type="button"
                            className="text-xs text-primary hover:underline"
                            onClick={() => setEditing(r)}
                          >
                            تعديل
                          </button>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      {editing && (
        <EditCampaignDialog
          row={editing}
          businessId={bid!}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await campaigns.refetch();
          }}
        />
      )}
    </div>
  );
}

/**
 * تعديل حملة لسه مسودة.
 *
 * المقاييس بتتبعت كاملة مش الحقل اللي اتغيّر بس: `manualMetricsJson` عمود واحد، فلو
 * بعتنا الأوردرات لوحدها كانت الرسايل والإيراد هيتمسحوا معاها.
 */
function EditCampaignDialog({
  row, businessId, onClose, onSaved,
}: {
  row: any;
  businessId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [campaignName, setCampaignName] = useState(row.campaignName ?? "");
  const [amount, setAmount] = useState(String(row.spend ?? ""));
  const [orders, setOrders] = useState(String(row.orders || ""));
  const [messages, setMessages] = useState(String(row.messages || ""));
  const [revenue, setRevenue] = useState(
    row.revenue == null ? "" : String(row.revenue)
  );

  const save = trpc.accountingV2.adSpendUpdate.useMutation({
    onSuccess: () => { toast.success("اتعدّلت الحملة"); onSaved(); },
    onError: error => toast.error(error.message),
  });

  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}>
      <div dir="rtl" className="w-full max-w-md rounded-lg bg-card p-4 shadow-lg"
        onClick={event => event.stopPropagation()}>
        <h3 className="mb-3 font-bold">تعديل الحملة</h3>
        <div className="space-y-3">
          <div>
            <Label>اسم الحملة</Label>
            <Input className="mt-1" value={campaignName}
              onChange={e => setCampaignName(e.target.value)} />
          </div>
          <div>
            <Label>المصروف</Label>
            <Input className="mt-1" dir="ltr" inputMode="decimal" value={amount}
              onChange={e => setAmount(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>عدد الأوردرات</Label>
              <Input className="mt-1" dir="ltr" inputMode="numeric" value={orders}
                onChange={e => setOrders(e.target.value)} />
            </div>
            <div>
              <Label>عدد الرسايل</Label>
              <Input className="mt-1" dir="ltr" inputMode="numeric" value={messages}
                onChange={e => setMessages(e.target.value)} />
            </div>
          </div>
          <div>
            <Label>الإيراد</Label>
            <Input className="mt-1" dir="ltr" inputMode="decimal" placeholder="اختياري"
              value={revenue} onChange={e => setRevenue(e.target.value)} />
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <Button className="flex-1" disabled={save.isPending}
            onClick={() => {
              const spend = Number(amount);
              if (!(spend > 0)) return toast.error("المصروف لازم يكون أكبر من صفر");
              const o = num(orders) ?? 0;
              const m = num(messages) ?? 0;
              if (m > 0 && o > m)
                return toast.error("الأوردرات الناتجة ماتزيدش عن عدد الرسايل");
              const metrics: Record<string, number> = {};
              if (o > 0) metrics.orders = o;
              if (m > 0) metrics.messages = m;
              const rev = num(revenue);
              if (rev != null) metrics.revenue = rev;
              save.mutate({
                businessId,
                adSpendId: row.id,
                amount: String(spend),
                campaignName: campaignName.trim() || undefined,
                manualMetrics: metrics,
              });
            }}>
            {save.isPending ? "جاري الحفظ..." : "حفظ"}
          </Button>
          <Button variant="outline" onClick={onClose}>إلغاء</Button>
        </div>
      </div>
    </div>
  );
}
