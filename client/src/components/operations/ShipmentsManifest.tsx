import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Truck, Package, MapPin, ChevronDown, ChevronUp } from "lucide-react";
import type { AgentGroup, ShipmentOrder } from "@/lib/shippingOperations";
import { AR_LOCALE } from "@/lib/format";

/**
 * كشف شحنات اليوم — كارت لكل شركة شحن (محافظاتها + جدول أوردراتها + إجمالي) + الإجمالي الكلي.
 *
 * مكوّن عرض واحد لجمهورين: صفحة بوابة الموظفين (TodayShipments) وتبويب «شحنات اليوم» في
 * Operations workspace. الصفحة المستضيفة مسؤولة عن البيانات والتحميل والحالة الفاضية.
 *
 * المرحلة 7D: ألوان الوكلاء من tokens الرسوم (--chart-1..4) بدل لوحات Tailwind الخام — تعمل في
 * الوضعين الفاتح/الداكن ومع الألوان الأربعة؛ الجدول يبقى جدول كشف (طباعة) داخل حاوية تتمرر أفقيًا.
 */

const AGENT_TOKEN: Record<string, string> = {
  "الشبح": "--chart-2",
  "العالمية": "--chart-3",
  "المتخصص": "--chart-4",
  "غير محدد": "--chart-5",
};
const FALLBACK_TOKENS = ["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"];

function agentToken(name: string, index: number) {
  return AGENT_TOKEN[name] ?? FALLBACK_TOKENS[index % FALLBACK_TOKENS.length];
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
    <div className="space-y-5" data-testid="shipments-manifest">
      {agents.map((agent: AgentGroup, agentIndex: number) => {
        const token = agentToken(agent.agentName, agentIndex);
        const isExpanded = expandedAgents[agent.agentName] !== false; // default expanded
        const tint = { background: `color-mix(in srgb, var(${token}) 10%, transparent)` };
        const edge = { borderColor: `var(${token})` };

        return (
          <section
            key={agent.agentName}
            className="overflow-hidden rounded-[var(--radius-brand-md)] border border-border bg-card shadow-[var(--shadow-card)] print:break-inside-avoid"
            style={{ borderInlineStartWidth: 4, ...edge }}
            data-testid={`manifest-agent-${agentIndex}`}
          >
            {/* Agent Header */}
            <button
              type="button"
              onClick={() => toggleAgent(agent.agentName)}
              className="flex min-h-11 w-full items-center justify-between gap-3 px-4 py-3 text-start"
              aria-expanded={isExpanded}
              style={tint}
            >
              <div className="flex min-w-0 items-center gap-3">
                <Truck className="h-5 w-5 shrink-0" style={{ color: `var(${token})` }} aria-hidden="true" />
                <span className="truncate text-lg font-bold">{agent.agentName}</span>
                <Badge variant="secondary" className="shrink-0 text-sm tabular-nums">
                  {agent.orderCount} أوردر
                </Badge>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="text-sm font-medium tabular-nums text-muted-foreground">
                  إجمالي: {agent.totalAmount.toLocaleString(AR_LOCALE)} ج.م
                </span>
                {isExpanded ? (
                  <ChevronUp className="h-5 w-5 print:hidden" aria-hidden="true" />
                ) : (
                  <ChevronDown className="h-5 w-5 print:hidden" aria-hidden="true" />
                )}
              </div>
            </button>

            {/* Governorates served today */}
            {isExpanded && agent.governorates.length > 0 && (
              <div className="border-b border-border px-4 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    <MapPin className="ml-1 inline h-3 w-3" aria-hidden="true" />
                    محافظات اليوم:
                  </span>
                  {agent.governorates.map((gov: string) => (
                    <Badge key={gov} variant="outline" className="text-xs">
                      {gov}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Orders Table — كشف للطباعة؛ يتمرر داخل حاويته ولا يوسّع الصفحة */}
            {isExpanded && (
              <div className="overflow-x-auto">
                {agent.orders.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <p className="text-sm text-muted-foreground">لا توجد أوردرات لهذا الوكيل اليوم</p>
                  </div>
                ) : (
                  <table className="w-full min-w-[40rem] text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/40">
                        <th className="px-3 py-2 text-right font-semibold text-muted-foreground">#</th>
                        <th className="px-3 py-2 text-right font-semibold text-muted-foreground">رقم الأوردر</th>
                        <th className="px-3 py-2 text-right font-semibold text-muted-foreground">العميل</th>
                        <th className="px-3 py-2 text-right font-semibold text-muted-foreground">التليفون</th>
                        <th className="px-3 py-2 text-right font-semibold text-muted-foreground">المحافظة</th>
                        <th className="px-3 py-2 text-right font-semibold text-muted-foreground">القطعة</th>
                        <th className="px-3 py-2 text-right font-semibold text-muted-foreground">الكمية</th>
                        <th className="px-3 py-2 text-right font-semibold text-muted-foreground">الإجمالي</th>
                        <th className="px-3 py-2 text-right font-semibold text-muted-foreground print:hidden">ملاحظات</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agent.orders.map((order: ShipmentOrder, idx: number) => (
                        <tr key={order.id} className="border-b border-border/60 transition-colors hover:bg-muted/30">
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{idx + 1}</td>
                          <td className="px-3 py-2 font-medium">{order.orderNumber}</td>
                          <td className="px-3 py-2">{order.customerName}</td>
                          <td className="px-3 py-2 font-mono text-xs text-muted-foreground" dir="ltr">
                            <a href={`tel:${order.customerPhone}`} className="inline-flex min-h-11 items-center hover:text-primary-text md:min-h-0">
                              {order.customerPhone}
                            </a>
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant="outline" className="text-xs">{order.governorate}</Badge>
                          </td>
                          <td className="px-3 py-2 text-xs">
                            <span className={`inline-flex items-center gap-1 rounded-[var(--radius-brand-pill)] px-2 py-0.5 text-xs font-medium ${
                              classifyProduct(order.productName) === "سادة" ? "bg-muted text-muted-foreground" : "bg-accent text-accent-foreground"
                            }`}>
                              {classifyProduct(order.productName)}
                              <span className="text-[10px] opacity-70">× {order.quantity}</span>
                            </span>
                          </td>
                          <td className="px-3 py-2 text-center tabular-nums">{order.quantity}</td>
                          <td className="px-3 py-2 font-semibold tabular-nums">
                            {Number(order.totalAmount).toLocaleString(AR_LOCALE)} ج.م
                          </td>
                          <td className="max-w-[150px] truncate px-3 py-2 text-xs text-muted-foreground print:hidden">
                            {order.notes || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    {/* Summary Row */}
                    <tfoot>
                      <tr className="border-t-2 border-border font-bold" style={tint}>
                        <td colSpan={6} className="px-3 py-2 text-right">
                          الإجمالي ({agent.orderCount} أوردر)
                        </td>
                        <td className="px-3 py-2 text-center tabular-nums">
                          {agent.orders.reduce((sum: number, o: ShipmentOrder) => sum + o.quantity, 0)}
                        </td>
                        <td className="px-3 py-2 tabular-nums">
                          {agent.totalAmount.toLocaleString(AR_LOCALE)} ج.م
                        </td>
                        <td className="print:hidden"></td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            )}
          </section>
        );
      })}

      {/* Grand Total */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-brand-md)] border border-primary/30 bg-accent px-5 py-4 text-accent-foreground shadow-[var(--shadow-card)]" data-testid="manifest-total">
        <div className="flex items-center gap-3">
          <Package className="h-6 w-6 text-primary-text" aria-hidden="true" />
          <span className="text-lg font-bold">الإجمالي الكلي</span>
        </div>
        <div className="flex flex-wrap items-center gap-6 text-sm">
          <div>
            <span className="ml-1 text-muted-foreground">عدد الأوردرات:</span>
            <span className="text-lg font-bold tabular-nums">{totalOrders.toLocaleString(AR_LOCALE)}</span>
          </div>
          <div>
            <span className="ml-1 text-muted-foreground">المبلغ:</span>
            <span className="text-lg font-bold tabular-nums text-primary-text">
              {agents.reduce((sum: number, a: AgentGroup) => sum + a.totalAmount, 0).toLocaleString(AR_LOCALE)} ج.م
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
