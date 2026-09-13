import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Truck, Package, MapPin, ChevronDown, ChevronUp } from "lucide-react";
import type { AgentGroup, ShipmentOrder } from "@/lib/shippingOperations";

/**
 * كشف شحنات اليوم — كارت لكل شركة شحن (محافظاتها + جدول أوردراتها + إجمالي) + الإجمالي الكلي.
 *
 * مكوّن عرض واحد لجمهورين: صفحة بوابة الموظفين (TodayShipments) وتبويب «شحنات اليوم» في
 * Operations workspace. اتنقل من TodayShipments كما هو — نفس الشكل ونفس سلوك الطباعة.
 * الصفحة المستضيفة مسؤولة عن البيانات والتحميل والحالة الفاضية.
 */

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
    bg: "bg-muted/50",
    border: "border-border",
    text: "text-foreground",
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

export function ShipmentsManifest({ agents, totalOrders }: { agents: AgentGroup[]; totalOrders: number }) {
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});

  const toggleAgent = (name: string) => {
    setExpandedAgents(prev => ({ ...prev, [name]: !prev[name] }));
  };

  return (
    <div className="space-y-6">
      {agents.map((agent: AgentGroup) => {
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
                          className={`border-b border-stone-100 ${idx % 2 === 0 ? "bg-card" : colors.bg} hover:bg-stone-50 transition-colors`}
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
            <span className="font-bold text-lg">{totalOrders}</span>
          </div>
          <div>
            <span className="text-stone-400 ml-1">المبلغ:</span>
            <span className="font-bold text-lg text-amber-400">
              {agents.reduce((sum: number, a: AgentGroup) => sum + a.totalAmount, 0).toLocaleString()} ج.م
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
