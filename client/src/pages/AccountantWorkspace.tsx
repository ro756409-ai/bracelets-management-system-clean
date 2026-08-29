import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  Receipt, PackagePlus, Wallet, Truck, ClipboardCheck, Factory, LogOut,
} from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { AccSelect } from "./accountant/ui";
import AccExpenses from "./accountant/AccExpenses";
import AccGoodsReceipt from "./accountant/AccGoodsReceipt";
import AccPayroll from "./accountant/AccPayroll";
import AccCollections from "./accountant/AccCollections";
import AccWorkshop from "./accountant/AccWorkshop";
import AccStocktake from "./accountant/AccStocktake";

/**
 * مساحة عمل المحاسب — Theme بسيط خاص بيها (أبيض/رمادي فاتح، RTL)، من غير Dashboard
 * ولا Charts. تنقّل بـ6 أزرار كبيرة، وكل تاب: Form فوق + جدول تحت + تعديل/حذف آمن.
 * كل التابات بتعيد استخدام endpoints النظام الموجودة — مفيش نظام موازي.
 */

type TabKey = "expenses" | "goods" | "payroll" | "collections" | "stocktake" | "workshop";

const TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  { key: "expenses", label: "المصاريف", icon: <Receipt className="h-6 w-6" /> },
  { key: "goods", label: "استلام البضاعة", icon: <PackagePlus className="h-6 w-6" /> },
  { key: "payroll", label: "المرتبات", icon: <Wallet className="h-6 w-6" /> },
  { key: "collections", label: "التحصيلات", icon: <Truck className="h-6 w-6" /> },
  { key: "stocktake", label: "الجرد", icon: <ClipboardCheck className="h-6 w-6" /> },
  { key: "workshop", label: "حساب الورشة", icon: <Factory className="h-6 w-6" /> },
];

export default function AccountantWorkspace() {
  const [, setLocation] = useLocation();
  const { logout } = useAuth();
  const { businesses } = useBusinessContext();
  const [tab, setTab] = useState<TabKey>("expenses");

  // مصدر الأنشطة = activeList المسطّحة (tenant-scoped)، مش قايمة الـgroup: نشاط مالوش
  // group كانت قايمة الـgroup بتبقى فاضية فالشاشة تقفل كل التابات وتقول «مفيش نشاط».
  // activeList بترجع أنشطة الـtenant سواء في group أو لأ.
  const options = useMemo(() => businesses ?? [], [businesses]);
  const [picked, setPicked] = useState<number | null>(null);
  const businessId = picked ?? options[0]?.id ?? null;

  const doLogout = async () => {
    try { await logout(); } finally { setLocation("/employee-login"); }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800" dir="rtl">
      {/* Header صغير */}
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">مساحة المحاسب</h1>
          <div className="mr-auto flex items-center gap-2">
            {options.length > 1 && (
              <AccSelect
                className="w-44 py-2"
                value={businessId != null ? String(businessId) : ""}
                onChange={e => setPicked(Number(e.target.value))}
              >
                {options.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </AccSelect>
            )}
            <button
              onClick={doLogout}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              <LogOut className="h-4 w-4" /> خروج
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-5">
        {/* 6 أزرار كبيرة */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {TABS.map(t => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex flex-col items-center justify-center gap-2 rounded-2xl border p-4 text-sm font-semibold transition ${
                  active
                    ? "border-slate-800 bg-slate-800 text-white shadow"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50"
                }`}
              >
                {t.icon}
                {t.label}
              </button>
            );
          })}
        </div>

        {/* محتوى التاب */}
        {businessId == null ? (
          <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center text-slate-400">
            مفيش نشاط متاح لحسابك.
          </div>
        ) : (
          <>
            {tab === "expenses" && <AccExpenses businessId={businessId} />}
            {tab === "goods" && <AccGoodsReceipt businessId={businessId} />}
            {tab === "payroll" && <AccPayroll businessId={businessId} />}
            {tab === "collections" && <AccCollections businessId={businessId} />}
            {tab === "stocktake" && <AccStocktake businessId={businessId} />}
            {tab === "workshop" && <AccWorkshop businessId={businessId} />}
          </>
        )}
      </main>
    </div>
  );
}
