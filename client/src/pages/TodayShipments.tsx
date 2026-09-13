import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Truck, Package, ArrowRight, Calendar, RefreshCw, Printer, LogOut, Search,
} from "lucide-react";
import { BrandMark } from "@/components/BrandMark";
import { ShipmentsManifest } from "@/components/operations/ShipmentsManifest";
import { filterShipmentAgents, totalShipmentOrders } from "@/lib/shippingOperations";

/**
 * شحنات اليوم — نسخة **بوابة الموظفين** (كوكي employee_token، موظف الشحن). جلسة الداشبورد
 * (المالك/المدير) بتشوف نفس الكشف كتبويب داخل Operations workspace
 * (pages/operations/TodayShipmentsWorkspace) — الكشف والفلترة مكوّن/منطق مشترك.
 */
export default function TodayShipments() {
  const [, setLocation] = useLocation();
  const [selectedDate, setSelectedDate] = useState(() => {
    const now = new Date();
    return now.toISOString().split("T")[0];
  });
  const [search, setSearch] = useState("");

  // Check employee session
  const empSession = (() => {
    try { return JSON.parse(localStorage.getItem("employee_session") || "null"); } catch { return null; }
  })();

  useEffect(() => {
    if (!empSession) setLocation("/employee-login");
  }, [empSession]);

  const { data: meData, error: meError } = trpc.employeePortal.me.useQuery(undefined, {
    retry: false,
  });

  useEffect(() => {
    if (meError) {
      localStorage.removeItem("employee_session");
      setLocation("/employee-login");
    }
  }, [meError]);

  const queryDate = useMemo(() => selectedDate, [selectedDate]);

  const { data: shipmentsData, isLoading, refetch, error: shipmentsError } =
    trpc.employeePortal.todayShipments.useQuery(
      { date: queryDate },
      { refetchInterval: 120000, retry: false }
    );

  // Filter orders by search
  const filteredAgents = useMemo(
    () => filterShipmentAgents(shipmentsData?.agents, search),
    [shipmentsData, search]
  );

  const totalFilteredOrders = totalShipmentOrders(filteredAgents);

  const handlePrint = () => {
    window.print();
  };

  const handleLogout = () => {
    localStorage.removeItem("employee_session");
    setLocation("/employee-login");
  };

  const isToday = selectedDate === new Date().toISOString().split("T")[0];

  // todayShipments now requires shipping_ops.view. A confirmation employee who still has
  // the URL bookmarked lands here — say so plainly instead of showing an empty manifest
  // that reads like "there are no shipments today".
  if (shipmentsError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center" dir="rtl">
        <Truck className="h-10 w-10 text-muted-foreground" />
        <div>
          <p className="text-lg font-bold">شحنات اليوم مش من مهامك</p>
          <p className="mt-1 text-sm text-muted-foreground">
            الشاشة دي لموظفي الشحن والإدارة. بيانات شحن أوردراتك موجودة جوه كل أوردر في شاشتك.
          </p>
        </div>
        <Button onClick={() => setLocation("/employee-dashboard")}>الرجوع لشاشتي</Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      {/* Header */}
      <header
        className="text-white shadow-lg print:hidden"
        style={{ background: "linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%)" }}
      >
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-10 w-10" />
            <div>
              <h1 className="text-lg font-bold">شحنات اليوم</h1>
              {meData && <p className="text-white/70 text-xs">{meData.name}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
              className="text-white hover:bg-white/10"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePrint}
              className="text-white hover:bg-white/10"
            >
              <Printer className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/employee-dashboard")}
              className="text-white hover:bg-white/10"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="text-white hover:bg-white/10"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Controls Bar */}
      <div className="max-w-7xl mx-auto px-4 py-3 print:hidden">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          {/* Date Picker */}
          <div className="flex items-center gap-2 bg-card rounded-lg border border-stone-200 px-3 py-2 shadow-sm">
            <Calendar className="h-4 w-4 text-amber-600" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="bg-transparent border-none outline-none text-sm font-medium text-stone-700"
            />
          </div>

          {/* Day Info */}
          <div className="flex items-center gap-2">
            {shipmentsData && (
              <Badge variant="outline" className="text-sm px-3 py-1 bg-card border-amber-300 text-amber-800">
                {shipmentsData.dayName} {isToday && "— اليوم"}
              </Badge>
            )}
            <Badge variant="outline" className="text-sm px-3 py-1 bg-card border-stone-300 text-stone-700">
              <Package className="h-3.5 w-3.5 ml-1" />
              {totalFilteredOrders} أوردر
            </Badge>
          </div>

          {/* Search */}
          <div className="flex-1 sm:max-w-xs">
            <div className="relative">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-stone-400" />
              <Input
                placeholder="بحث بالاسم أو التليفون أو رقم الأوردر..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pr-9 bg-card border-stone-200"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Print Header */}
      <div className="hidden print:block text-center mb-4 px-4">
        <h1 className="text-2xl font-bold">شحنات يوم {shipmentsData?.dayName} — {selectedDate}</h1>
        <p className="text-sm text-muted-foreground">إجمالي الأوردرات: {totalFilteredOrders}</p>
      </div>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 pb-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-10 w-10 border-4 border-primary border-t-transparent" />
          </div>
        ) : filteredAgents.length === 0 ? (
          <div className="text-center py-20 text-stone-500">
            <Truck className="h-16 w-16 mx-auto mb-4 text-stone-300" />
            <p className="text-lg font-medium">لا توجد شحنات لهذا اليوم</p>
            <p className="text-sm mt-1">اختر تاريخ آخر أو تحقق من وجود أوردرات مؤكدة</p>
          </div>
        ) : (
          <ShipmentsManifest agents={filteredAgents} totalOrders={totalFilteredOrders} />
        )}
      </main>

      {/* Print Styles */}
      <style>{`
        @media print {
          body { background: white !important; }
          header, .print\\:hidden { display: none !important; }
          .print\\:block { display: block !important; }
          .print\\:break-inside-avoid { break-inside: avoid; }
          table { font-size: 11px; }
          .rounded-xl { border-radius: 0; }
          .shadow-sm, .shadow-lg { box-shadow: none; }
        }
      `}</style>
    </div>
  );
}
