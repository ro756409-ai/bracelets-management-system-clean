import { useState } from "react";
import {
  LayoutDashboard, Receipt, PackagePlus, Wallet, Banknote, ClipboardCheck,
  TrendingUp, TrendingDown, Truck, Factory, Clock, Wrench,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/money";
import { ExpensesSection } from "./Expenses";
import GoodsReceipt from "./GoodsReceipt";
import SalaryProfiles from "./SalaryProfiles";
import DailyCollections from "./DailyCollections";

/**
 * مساحة عمل المحاسب — بسيطة وواضحة، منفصلة عن لوحة الموظف العادية وعن لوحة المالك.
 *
 * كل تاب بيعيد استخدام نفس صفحات/خدمات النظام (مصاريف/استلام/مرتبات/تحصيلات) — مفيش
 * نظام موازي ولا تكرار بيانات. الأرقام في الرئيسية بتيجي من `accountantSummary` اللي
 * بيجمّع من دوال أرصدة موجودة (قراءة فقط). الجرد لسه «قيد التجهيز» (P2-C).
 */

type TabKey = "home" | "expenses" | "goods" | "payroll" | "collections" | "stocktake";

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "home", label: "الرئيسية", icon: <LayoutDashboard className="h-4 w-4" /> },
  { key: "expenses", label: "إضافة مصروف", icon: <Receipt className="h-4 w-4" /> },
  { key: "goods", label: "استلام البضاعة", icon: <PackagePlus className="h-4 w-4" /> },
  { key: "payroll", label: "المرتبات", icon: <Wallet className="h-4 w-4" /> },
  { key: "collections", label: "التحصيلات", icon: <Truck className="h-4 w-4" /> },
  { key: "stocktake", label: "الجرد", icon: <ClipboardCheck className="h-4 w-4" /> },
];

export default function AccountantWorkspace() {
  const [tab, setTab] = useState<TabKey>("home");

  return (
    <div className="min-h-screen bg-muted/20" dir="rtl">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
          <h1 className="ml-auto text-lg font-bold">مساحة المحاسب</h1>
        </div>
        <nav className="mx-auto flex max-w-6xl flex-wrap gap-1 overflow-x-auto px-2 pb-2">
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${
                tab === t.key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-4">
        {tab === "home" && <AccountantHome onGo={setTab} />}
        {tab === "expenses" && <ExpensesSection />}
        {tab === "goods" && <GoodsReceipt />}
        {tab === "payroll" && <SalaryProfiles />}
        {tab === "collections" && <DailyCollections />}
        {tab === "stocktake" && <StocktakePlaceholder />}
      </main>
    </div>
  );
}

// ───────────────────────── الرئيسية ─────────────────────────

const PAYROLL_STATUS_LABEL: Record<string, string> = {
  draft: "مسودة", approved: "معتمدة", paid: "مدفوعة", cancelled: "ملغية",
};

function AccountantHome({ onGo }: { onGo: (t: TabKey) => void }) {
  const { currentBusinessIds } = useBusinessContext();
  const summary = trpc.accountingV2.accountantSummary.useQuery(
    { businessIds: currentBusinessIds },
    { enabled: (currentBusinessIds?.length ?? 0) > 0, retry: false }
  );

  const s = summary.data;
  const money = (n: number | undefined) => formatMoney(Number(n ?? 0));

  const cards: {
    label: string; value: string; icon: React.ReactNode; tone?: string; hint?: string;
  }[] = s
    ? [
        { label: "رصيد خزنة المكتب", value: money(s.cashBalance), icon: <Wallet className="h-5 w-5" /> },
        { label: "رصيد البنك", value: money(s.bankBalance), icon: <Banknote className="h-5 w-5" /> },
        { label: "مصروفات اليوم", value: money(s.todayExpenses), icon: <TrendingDown className="h-5 w-5" />, tone: "var(--destructive)" },
        { label: "تحصيلات اليوم", value: money(s.todayCollections), icon: <TrendingUp className="h-5 w-5" />, tone: "var(--success)" },
        { label: "مستحق من شركات الشحن", value: money(s.pendingCollection), icon: <Truck className="h-5 w-5" />, tone: "var(--warning)" },
        { label: "بضاعة مستلمة اليوم", value: money(s.goodsReceivedToday), icon: <PackagePlus className="h-5 w-5" /> },
        { label: "المتبقي للموردين", value: money(s.owedToSuppliers), icon: <Factory className="h-5 w-5" />, tone: "var(--warning)", hint: `${s.supplierCount} مورد` },
        { label: "لك عند الموردين", value: money(s.owedBySuppliers), icon: <Factory className="h-5 w-5" /> },
        { label: "مرتبات الشهر المستحقة", value: money(s.payroll.due), icon: <Wallet className="h-5 w-5" />, hint: s.payroll.status ? PAYROLL_STATUS_LABEL[s.payroll.status] : "لسه متجهزتش" },
        { label: "المرتبات المدفوعة", value: money(s.payroll.paid), icon: <TrendingUp className="h-5 w-5" />, tone: "var(--success)" },
        { label: "المرتبات المتبقية", value: money(s.payroll.remaining), icon: <TrendingDown className="h-5 w-5" />, tone: "var(--warning)" },
      ]
    : [];

  const shortcuts: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: "expenses", label: "إضافة مصروف", icon: <Receipt className="h-6 w-6" /> },
    { key: "goods", label: "استلام بضاعة", icon: <PackagePlus className="h-6 w-6" /> },
    { key: "payroll", label: "المرتبات", icon: <Wallet className="h-6 w-6" /> },
    { key: "collections", label: "التحصيلات", icon: <Truck className="h-6 w-6" /> },
    { key: "stocktake", label: "الجرد", icon: <ClipboardCheck className="h-6 w-6" /> },
  ];

  return (
    <div className="space-y-5">
      {/* كروت الأرقام */}
      {summary.isLoading ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      ) : summary.isError ? (
        <Card>
          <CardContent className="p-4 text-sm text-destructive">
            تعذّر تحميل الملخص: {summary.error?.message}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {cards.map(c => (
            <Card key={c.label} className="overflow-hidden">
              <CardContent className="p-4">
                <div className="mb-1 flex items-center justify-between text-muted-foreground">
                  <span className="text-xs">{c.label}</span>
                  {c.icon}
                </div>
                <p className="text-xl font-bold tabular-nums" style={c.tone ? { color: c.tone } : undefined}>
                  {c.value}
                </p>
                {c.hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{c.hint}</p>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* اختصارات كبيرة */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {shortcuts.map(sc => (
          <Button
            key={sc.key}
            variant="outline"
            className="flex h-24 flex-col items-center justify-center gap-2 text-sm font-semibold"
            onClick={() => onGo(sc.key)}
          >
            {sc.icon}
            {sc.label}
          </Button>
        ))}
      </div>

      {/* آخر العمليات */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clock className="h-5 w-5" />
            آخر الحركات
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!s || s.recentTransactions.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">مفيش حركات لسه.</p>
          ) : (
            <ul className="divide-y">
              {s.recentTransactions.slice(0, 8).map((t: any) => (
                <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                  <span className="truncate">{t.description || t.type || "حركة"}</span>
                  <span className="flex items-center gap-2 whitespace-nowrap">
                    <span
                      className="font-semibold tabular-nums"
                      style={{ color: t.direction === "in" ? "var(--success)" : "var(--destructive)" }}
                    >
                      {t.direction === "in" ? "+" : "−"} {formatMoney(Number(t.amount ?? 0))}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t.transactionDate ? new Date(t.transactionDate).toLocaleDateString("ar-EG") : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ───────────────────────── الجرد (placeholder) ─────────────────────────

function StocktakePlaceholder() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 p-10 text-center">
        <Wrench className="h-10 w-10 text-muted-foreground" />
        <h3 className="text-lg font-bold">الجرد — قيد التجهيز</h3>
        <p className="max-w-md text-sm text-muted-foreground">
          قسم الجرد هيتفعّل قريبًا: هتقدر تبدأ جردة، تدخل العدد الفعلي، وتشوف الفرق
          والقيمة — وكل جردة هتتحفظ كسجل مستقل. اعتماد الفروق على المخزون هيكون بخطوة
          تأكيد واضحة عشان مايتغيّرش رصيد بالغلط.
        </p>
      </CardContent>
    </Card>
  );
}
