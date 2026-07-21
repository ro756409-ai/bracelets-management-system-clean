import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Truck, Package, Phone, MapPin, ChevronDown, ChevronUp,
  ArrowRight, Calendar, RefreshCw, Printer, LogOut, Search,
  Box, Hash, User, DollarSign, FileText,
} from "lucide-react";

const LOGO_URL = "https://d2xsxph8kpxj0f.cloudfront.net/310519663375135838/HcrR8sAS4ry64VmnqEHaLw/farahat-logo_f7ceef8f.png";

const AGENT_COLORS: Record<string, { bg: string; border: string; text: string; badge: string; headerBg: string }> = {
  "الشبح": {
    bg: "bg-blue-50",
    border: "border-blue-200",
    text: "text-blue-800",
    badge: "bg-blue-600",
    headerBg: "bg-gradient-to-r from-blue-700 to-blue-900",
  },
  "العالمية": {
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    text: "text-emerald-800",
    badge: "bg-emerald-600",
    headerBg: "bg-gradient-to-r from-emerald-700 to-emerald-900",
  },
  "المتخصص": {
    bg: "bg-amber-50",
    border: "border-amber-200",
    text: "text-amber-800",
    badge: "bg-amber-600",
    headerBg: "bg-gradient-to-r from-amber-700 to-amber-900",
  },
  "غير محدد": {
    bg: "bg-gray-50",
    border: "border-gray-200",
    text: "text-gray-800",
    badge: "bg-gray-600",
    headerBg: "bg-gradient-to-r from-gray-600 to-gray-800",
  },
};

function getAgentColor(name: string) {
  return AGENT_COLORS[name] || AGENT_COLORS["غير محدد"];
}

/** Classify product as سادة or حفر */
function classifyProduct(fullName: string): string {
  if (!fullName) return "حفر";
  if (/سادة|ساده|plain/i.test(fullName.trim())) return "سادة";
  return "حفر";
}

type ShipmentOrder = {
  id: number;
  orderNumber: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  governorate: string;
  productName: string;
  quantity: number;
  totalAmount: string;
  notes?: string | null;
  confirmedAt?: Date | null;
};

type AgentGroup = {
  agentName: string;
  governorates: string[];
  orders: ShipmentOrder[];
  orderCount: number;
  totalAmount: number;
};

export default function TodayShipments() {
  const [, setLocation] = useLocation();
  const [selectedDate, setSelectedDate] = useState(() => {
    const now = new Date();
    return now.toISOString().split("T")[0];
  });
  const [search, setSearch] = useState("");
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});

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

  const { data: shipmentsData, isLoading, refetch } = trpc.employeePortal.todayShipments.useQuery(
    { date: queryDate },
    { refetchInterval: 120000 }
  );

  const toggleAgent = (name: string) => {
    setExpandedAgents(prev => ({ ...prev, [name]: !prev[name] }));
  };

  // Filter orders by search
  const filteredAgents = useMemo(() => {
    if (!shipmentsData?.agents) return [];
    if (!search.trim()) return shipmentsData.agents;

    const s = search.trim().toLowerCase();
    return shipmentsData.agents.map((agent: AgentGroup) => ({
      ...agent,
      orders: agent.orders.filter(
        (o: ShipmentOrder) =>
          o.customerName.toLowerCase().includes(s) ||
          o.customerPhone.includes(s) ||
          o.orderNumber.includes(s) ||
          o.governorate.toLowerCase().includes(s)
      ),
      orderCount: agent.orders.filter(
        (o: ShipmentOrder) =>
          o.customerName.toLowerCase().includes(s) ||
          o.customerPhone.includes(s) ||
          o.orderNumber.includes(s) ||
          o.governorate.toLowerCase().includes(s)
      ).length,
    })).filter((a: AgentGroup) => a.orderCount > 0);
  }, [shipmentsData, search]);

  const totalFilteredOrders = filteredAgents.reduce((sum: number, a: AgentGroup) => sum + a.orderCount, 0);

  const handlePrint = () => {
    window.print();
  };

  const handleLogout = () => {
    localStorage.removeItem("employee_session");
    setLocation("/employee-login");
  };

  const isToday = selectedDate === new Date().toISOString().split("T")[0];

  return (
    <div className="min-h-screen bg-gradient-to-br from-stone-50 to-amber-50/30" dir="rtl">
      {/* Header */}
      <header className="bg-gradient-to-r from-amber-800 via-amber-700 to-amber-600 text-white shadow-lg print:hidden">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src={LOGO_URL} alt="Logo" className="h-10 w-10 rounded-full border-2 border-amber-300" />
            <div>
              <h1 className="text-lg font-bold">شحنات اليوم</h1>
              {meData && <p className="text-amber-200 text-xs">{meData.name}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
              className="text-white hover:bg-amber-600"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handlePrint}
              className="text-white hover:bg-amber-600"
            >
              <Printer className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation("/employee-dashboard")}
              className="text-white hover:bg-amber-600"
            >
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleLogout}
              className="text-white hover:bg-amber-600"
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
          <div className="flex items-center gap-2 bg-white rounded-lg border border-stone-200 px-3 py-2 shadow-sm">
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
              <Badge variant="outline" className="text-sm px-3 py-1 bg-white border-amber-300 text-amber-800">
                {shipmentsData.dayName} {isToday && "— اليوم"}
              </Badge>
            )}
            <Badge variant="outline" className="text-sm px-3 py-1 bg-white border-stone-300 text-stone-700">
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
                className="pr-9 bg-white border-stone-200"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Print Header */}
      <div className="hidden print:block text-center mb-4 px-4">
        <h1 className="text-2xl font-bold">شحنات يوم {shipmentsData?.dayName} — {selectedDate}</h1>
        <p className="text-sm text-gray-600">إجمالي الأوردرات: {totalFilteredOrders}</p>
      </div>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 pb-8">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-10 w-10 border-4 border-amber-600 border-t-transparent" />
          </div>
        ) : filteredAgents.length === 0 ? (
          <div className="text-center py-20 text-stone-500">
            <Truck className="h-16 w-16 mx-auto mb-4 text-stone-300" />
            <p className="text-lg font-medium">لا توجد شحنات لهذا اليوم</p>
            <p className="text-sm mt-1">اختر تاريخ آخر أو تحقق من وجود أوردرات مؤكدة</p>
          </div>
        ) : (
          <div className="space-y-6">
            {filteredAgents.map((agent: AgentGroup) => {
              const colors = getAgentColor(agent.agentName);
              const isExpanded = expandedAgents[agent.agentName] !== false; // default expanded

              return (
                <div
                  key={agent.agentName}
                  className={`rounded-xl border-2 ${colors.border} overflow-hidden shadow-sm print:break-inside-avoid`}
                >
                  {/* Agent Header */}
                  <button
                    onClick={() => toggleAgent(agent.agentName)}
                    className={`w-full ${colors.headerBg} text-white px-4 py-3 flex items-center justify-between print:bg-gray-800`}
                  >
                    <div className="flex items-center gap-3">
                      <Truck className="h-5 w-5" />
                      <span className="text-lg font-bold">{agent.agentName}</span>
                      <Badge className="bg-white/20 text-white border-none text-sm">
                        {agent.orderCount} أوردر
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium opacity-90">
                        إجمالي: {agent.totalAmount.toLocaleString()} ج.م
                      </span>
                      {isExpanded ? (
                        <ChevronUp className="h-5 w-5 print:hidden" />
                      ) : (
                        <ChevronDown className="h-5 w-5 print:hidden" />
                      )}
                    </div>
                  </button>

                  {/* Governorates served today */}
                  {isExpanded && agent.governorates.length > 0 && (
                    <div className={`${colors.bg} px-4 py-2 border-b ${colors.border}`}>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`text-xs font-medium ${colors.text}`}>
                          <MapPin className="h-3 w-3 inline ml-1" />
                          محافظات اليوم:
                        </span>
                        {agent.governorates.map((gov: string) => (
                          <Badge
                            key={gov}
                            variant="outline"
                            className={`text-xs ${colors.border} ${colors.text} bg-white/60`}
                          >
                            {gov}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Orders Table */}
                  {isExpanded && (
                    <div className="overflow-x-auto">
                      {agent.orders.length === 0 ? (
                        <div className={`${colors.bg} px-4 py-8 text-center`}>
                          <p className={`${colors.text} text-sm`}>لا توجد أوردرات لهذا الوكيل اليوم</p>
                        </div>
                      ) : (
                        <table className="w-full text-sm">
                          <thead>
                            <tr className={`${colors.bg} border-b ${colors.border}`}>
                              <th className={`px-3 py-2 text-right font-semibold ${colors.text}`}>#</th>
                              <th className={`px-3 py-2 text-right font-semibold ${colors.text}`}>رقم الأوردر</th>
                              <th className={`px-3 py-2 text-right font-semibold ${colors.text}`}>العميل</th>
                              <th className={`px-3 py-2 text-right font-semibold ${colors.text}`}>التليفون</th>
                              <th className={`px-3 py-2 text-right font-semibold ${colors.text}`}>المحافظة</th>
                              <th className={`px-3 py-2 text-right font-semibold ${colors.text}`}>القطعة</th>
                              <th className={`px-3 py-2 text-right font-semibold ${colors.text}`}>الكمية</th>
                              <th className={`px-3 py-2 text-right font-semibold ${colors.text}`}>الإجمالي</th>
                              <th className={`px-3 py-2 text-right font-semibold ${colors.text} print:hidden`}>ملاحظات</th>
                            </tr>
                          </thead>
                          <tbody>
                            {agent.orders.map((order: ShipmentOrder, idx: number) => (
                              <tr
                                key={order.id}
                                className={`border-b border-stone-100 ${idx % 2 === 0 ? "bg-white" : colors.bg} hover:bg-stone-50 transition-colors`}
                              >
                                <td className="px-3 py-2 text-stone-500 font-mono text-xs">{idx + 1}</td>
                                <td className="px-3 py-2 font-medium text-stone-800">{order.orderNumber}</td>
                                <td className="px-3 py-2 text-stone-700">{order.customerName}</td>
                                <td className="px-3 py-2 text-stone-600 font-mono text-xs" dir="ltr">
                                  <a href={`tel:${order.customerPhone}`} className="hover:text-amber-700">
                                    {order.customerPhone}
                                  </a>
                                </td>
                                <td className="px-3 py-2">
                                  <Badge variant="outline" className="text-xs">
                                    {order.governorate}
                                  </Badge>
                                </td>
                                <td className="px-3 py-2 text-stone-700 text-xs">
                                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${
                                    classifyProduct(order.productName) === "سادة"
                                      ? "bg-stone-100 text-stone-700"
                                      : "bg-amber-100 text-amber-800"
                                  }`}>
                                    {classifyProduct(order.productName)}
                                    <span className="text-[10px] opacity-70">× {order.quantity}</span>
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-center text-stone-700">{order.quantity}</td>
                                <td className="px-3 py-2 font-semibold text-stone-800">
                                  {Number(order.totalAmount).toLocaleString()} ج.م
                                </td>
                                <td className="px-3 py-2 text-stone-500 text-xs max-w-[150px] truncate print:hidden">
                                  {order.notes || "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          {/* Summary Row */}
                          <tfoot>
                            <tr className={`${colors.bg} border-t-2 ${colors.border} font-bold`}>
                              <td colSpan={6} className={`px-3 py-2 text-right ${colors.text}`}>
                                الإجمالي ({agent.orderCount} أوردر)
                              </td>
                              <td className={`px-3 py-2 text-center ${colors.text}`}>
                                {agent.orders.reduce((sum: number, o: ShipmentOrder) => sum + o.quantity, 0)}
                              </td>
                              <td className={`px-3 py-2 ${colors.text}`}>
                                {agent.totalAmount.toLocaleString()} ج.م
                              </td>
                              <td className="print:hidden"></td>
                            </tr>
                          </tfoot>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Grand Total */}
            <div className="bg-gradient-to-r from-stone-800 to-stone-900 text-white rounded-xl px-6 py-4 flex items-center justify-between shadow-lg">
              <div className="flex items-center gap-3">
                <Package className="h-6 w-6 text-amber-400" />
                <span className="text-lg font-bold">الإجمالي الكلي</span>
              </div>
              <div className="flex items-center gap-6 text-sm">
                <div>
                  <span className="text-stone-400 ml-1">عدد الأوردرات:</span>
                  <span className="font-bold text-lg">{totalFilteredOrders}</span>
                </div>
                <div>
                  <span className="text-stone-400 ml-1">المبلغ:</span>
                  <span className="font-bold text-lg text-amber-400">
                    {filteredAgents.reduce((sum: number, a: AgentGroup) => sum + a.totalAmount, 0).toLocaleString()} ج.م
                  </span>
                </div>
              </div>
            </div>
          </div>
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
