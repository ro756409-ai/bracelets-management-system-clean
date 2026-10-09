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
import { EmptyState, LoadingSkeleton } from "@/components/shared";
import { ShipmentsManifest } from "@/components/operations/ShipmentsManifest";
import { filterShipmentAgents, totalShipmentOrders } from "@/lib/shippingOperations";

/**
 * شحنات اليوم — نسخة **بوابة الموظفين** (كوكي employee_token، موظف الشحن). جلسة الداشبورد
 * (المالك/المدير) بتشوف نفس الكشف كتبويب داخل Operations workspace
 * (pages/operations/TodayShipmentsWorkspace) — الكشف والفلترة مكوّن/منطق مشترك.
 */
export default function TodayShipments() {
  const [, setLocation] = useLocation();
  // الرجوع من حالة المنع بيحدّث صلاحيات الجلسة — فرابط الشحن يختفي من الشاشة فورًا لو الصلاحية اتسحبت.
  const permissionUtils = trpc.useUtils();
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
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center" dir="rtl">
        <Truck className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <div>
          <p className="text-lg font-bold">شحنات اليوم مش من مهامك</p>
          <p className="mt-1 text-sm text-muted-foreground">
            الشاشة دي لموظفي الشحن والإدارة. بيانات شحن أوردراتك موجودة جوه كل أوردر في شاشتك.
          </p>
        </div>
        <Button data-readonly-safe className="min-h-11" onClick={() => { permissionUtils.employeePortal.myPermissions.invalidate(); setLocation("/employee-dashboard"); }}>الرجوع لشاشتي</Button>
      </main>
    );
  }

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      {/* Header */}
      <header className="border-b border-border bg-card/95 shadow-[var(--shadow-card)] backdrop-blur print:hidden">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className="h-10 w-10" />
            <div>
              <h1 className="text-lg font-bold">شحنات اليوم</h1>
              {meData && <p className="text-xs text-muted-foreground">{meData.name}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button data-readonly-safe
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
              className="min-h-11 min-w-11"
              aria-label="تحديث"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button data-readonly-safe
              variant="ghost"
              size="sm"
              onClick={handlePrint}
              className="min-h-11 min-w-11"
              aria-label="طباعة"
            >
              <Printer className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button data-readonly-safe
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/employee-dashboard")}
              className="min-h-11 min-w-11"
              aria-label="الرجوع لشاشتي"
            >
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button data-readonly-safe
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="min-h-11 min-w-11"
              aria-label="خروج"
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </header>

      {/* Controls Bar */}
      <div className="max-w-7xl mx-auto px-4 py-3 print:hidden">
        <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center">
          {/* Date Picker */}
          <label className="flex min-h-11 items-center gap-2 rounded-[var(--radius-brand-md)] border border-border bg-card px-3 py-2 shadow-[var(--shadow-card)]">
            <Calendar className="h-4 w-4 text-primary-text" aria-hidden="true" />
            <input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="bg-transparent border-none outline-none text-sm font-medium"
              aria-label="تاريخ الشحن"
            />
          </label>

          {/* Day Info */}
          <div className="flex items-center gap-2">
            {shipmentsData && (
              <Badge variant="outline" className="border-primary/40 bg-card px-3 py-1 text-sm text-primary-text">
                {shipmentsData.dayName} {isToday && "— اليوم"}
              </Badge>
            )}
            <Badge variant="outline" className="bg-card px-3 py-1 text-sm">
              <Package className="h-3.5 w-3.5 ml-1" />
              {totalFilteredOrders} أوردر
            </Badge>
          </div>

          {/* Search */}
          <div className="flex-1 sm:max-w-xs">
            <div className="relative">
              <Search className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input
                placeholder="بحث بالاسم أو التليفون أو رقم الأوردر..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="min-h-11 bg-card pr-9"
                aria-label="بحث"
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
          <LoadingSkeleton variant="cards" rows={3} />
        ) : filteredAgents.length === 0 ? (
          <EmptyState icon={<Truck className="h-6 w-6" aria-hidden="true" />} title="لا توجد شحنات لهذا اليوم" description="اختر تاريخ آخر أو تحقق من وجود أوردرات مؤكدة" />
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
