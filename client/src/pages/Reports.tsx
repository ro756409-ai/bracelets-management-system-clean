import { useState, useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from "recharts";
import { TrendingUp, Users, XCircle, Calendar } from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";

type DateRange = "today" | "week" | "month";

function getDateRange(range: DateRange): { dateFrom?: Date; dateTo?: Date } {
  const now = new Date();
  if (range === "today") {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    const end = new Date(now); end.setHours(23, 59, 59, 999);
    return { dateFrom: start, dateTo: end };
  }
  if (range === "week") {
    const start = new Date(now); start.setDate(now.getDate() - 7); start.setHours(0, 0, 0, 0);
    return { dateFrom: start };
  }
  if (range === "month") {
    const start = new Date(now); start.setDate(now.getDate() - 30); start.setHours(0, 0, 0, 0);
    return { dateFrom: start };
  }
  return {};
}

const CANCEL_REASON_LABELS: Record<string, string> = {
  price: "السعر",
  not_serious: "غير جاد",
  wrong_number: "رقم خاطئ",
  duplicate: "مكرر",
};

const CANCEL_COLORS = ["#ef4444", "#f97316", "#eab308", "#8b5cf6"];

export default function Reports() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const { currentBusinessIds } = useBusinessContext();
  const [dateRange, setDateRange] = useState<DateRange>("month");

  const dateParams = useMemo(() => ({
    ...getDateRange(dateRange),
    businessIds: currentBusinessIds,
  }), [dateRange, currentBusinessIds]);

  const { data: perfData, isLoading: perfLoading } = trpc.reports.employeePerformance.useQuery(dateParams, {
    enabled: isAdmin,
  });
  const { data: cancelData } = trpc.reports.cancellationReasons.useQuery(dateParams, {
    enabled: isAdmin,
  });
  const { data: chartData } = trpc.reports.dailyChart.useQuery({ days: dateRange === 'today' ? 1 : dateRange === 'week' ? 7 : 30, businessIds: currentBusinessIds }, {
    enabled: isAdmin,
  });

  const dateRangeLabels: Record<DateRange, string> = {
    today: "اليوم",
    week: "آخر 7 أيام",
    month: "آخر 30 يوم",
  };

  const cancelPieData = cancelData?.map((c, i) => ({
    name: CANCEL_REASON_LABELS[c.reason ?? ''] ?? c.reason ?? 'غير محدد',
    value: Number(c.count),
    color: CANCEL_COLORS[i % CANCEL_COLORS.length],
  })) ?? [];

  const totalCancelled = cancelPieData.reduce((sum, c) => sum + c.value, 0);

  const barData = chartData?.map(d => ({
    date: d.date,
    total: Number(d.total),
    confirmed: Number(d.confirmed),
    cancelled: Number(d.cancelled),
  })) ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">التقارير والأداء</h1>
          <p className="text-muted-foreground text-sm mt-1">تحليل أداء الفريق وأسباب الإلغاء</p>
        </div>
      </div>

      {/* Date Range Filter */}
      <div className="flex gap-2">
        {(["today", "week", "month"] as DateRange[]).map(r => (
          <Button
            key={r}
            variant={dateRange === r ? "default" : "outline"}
            size="sm"
            onClick={() => setDateRange(r)}
          >
            {dateRangeLabels[r]}
          </Button>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Daily Orders Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" />
              أوردرات {dateRangeLabels[dateRange]}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {barData.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={barData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip
                    contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px' }}
                  />
                  <Bar dataKey="total" name="الإجمالي" fill="var(--chart-4)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="confirmed" name="مؤكد" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="cancelled" name="ملغي" fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">
                لا توجد بيانات كافية
              </div>
            )}
          </CardContent>
        </Card>

        {/* Cancellation Reasons Pie */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <XCircle className="h-4 w-4 text-destructive" />
              أسباب الإلغاء ({totalCancelled} إلغاء)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {cancelPieData.length > 0 ? (
              <>
                <ResponsiveContainer width="100%" height={180}>
                  <PieChart>
                    <Pie
                      data={cancelPieData}
                      cx="50%"
                      cy="50%"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={3}
                      dataKey="value"
                    >
                      {cancelPieData.map((entry, index) => (
                        <Cell key={index} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '8px' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  {cancelPieData.map((c, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <div className="w-3 h-3 rounded-full shrink-0" style={{ background: c.color }} />
                      <span className="text-xs text-foreground">{c.name}</span>
                      <span className="text-xs font-bold text-foreground mr-auto">{c.value}</span>
                      <span className="text-xs text-muted-foreground">
                        ({totalCancelled > 0 ? Math.round((c.value / totalCancelled) * 100) : 0}%)
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">
                لا توجد إلغاءات في هذه الفترة
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Employee Performance Table */}
      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-primary" />
              أداء الموظفين
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {perfLoading ? (
              <div className="p-8 text-center text-muted-foreground">جاري التحميل...</div>
            ) : !perfData || perfData.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground">
                لا توجد بيانات أداء في هذه الفترة
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/50">
                      <th className="p-3 text-right font-semibold text-muted-foreground">الموظف</th>
                      <th className="p-3 text-center font-semibold text-muted-foreground">الإجمالي</th>
                      <th className="p-3 text-center font-semibold text-muted-foreground">مؤكد</th>
                      <th className="p-3 text-center font-semibold text-muted-foreground">ملغي</th>
                      <th className="p-3 text-center font-semibold text-muted-foreground">مؤجل</th>
                      <th className="p-3 text-center font-semibold text-muted-foreground">نسبة التأكيد</th>
                      <th className="p-3 text-center font-semibold text-muted-foreground">نسبة الإلغاء</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perfData
                      .sort((a, b) => b.confirmRate - a.confirmRate)
                      .map((emp, i) => (
                        <tr key={i} className="border-b hover:bg-muted/30 transition-colors">
                          <td className="p-3">
                            <div className="flex items-center gap-2">
                              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                                <span className="text-xs font-bold text-primary">
                                  {emp.employeeName.charAt(0)}
                                </span>
                              </div>
                              <span className="font-medium text-foreground">{emp.employeeName}</span>
                            </div>
                          </td>
                          <td className="p-3 text-center font-bold text-foreground">{emp.total}</td>
                          <td className="p-3 text-center">
                            <span className="text-green-700 font-semibold">{emp.confirmed}</span>
                          </td>
                          <td className="p-3 text-center">
                            <span className="text-red-700 font-semibold">{emp.cancelled}</span>
                          </td>
                          <td className="p-3 text-center">
                            <span className="text-yellow-700 font-semibold">{emp.postponed}</span>
                          </td>
                          <td className="p-3 text-center">
                            <div className="flex items-center justify-center gap-2">
                              <div className="w-16 bg-muted rounded-full h-1.5">
                                <div
                                  className="h-1.5 rounded-full bg-green-500"
                                  style={{ width: `${emp.confirmRate}%` }}
                                />
                              </div>
                              <span className={`text-xs font-bold ${emp.confirmRate >= 70 ? 'text-green-700' : emp.confirmRate >= 50 ? 'text-yellow-700' : 'text-red-700'}`}>
                                {emp.confirmRate}%
                              </span>
                            </div>
                          </td>
                          <td className="p-3 text-center">
                            <Badge
                              className={`text-xs border-0 ${emp.cancelRate <= 20 ? 'bg-green-100 text-green-700' : emp.cancelRate <= 40 ? 'bg-yellow-100 text-yellow-700' : 'bg-red-100 text-red-700'}`}
                            >
                              {emp.cancelRate}%
                            </Badge>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Performance Legend */}
      {isAdmin && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-semibold text-foreground mb-3">مؤشرات الأداء</p>
            <div className="grid grid-cols-3 gap-3">
              <div className="bg-green-50 rounded-lg p-3 text-center">
                <p className="text-lg font-bold text-green-700">70%+</p>
                <p className="text-xs text-green-600">أداء ممتاز</p>
              </div>
              <div className="bg-yellow-50 rounded-lg p-3 text-center">
                <p className="text-lg font-bold text-yellow-700">50-70%</p>
                <p className="text-xs text-yellow-600">أداء متوسط</p>
              </div>
              <div className="bg-red-50 rounded-lg p-3 text-center">
                <p className="text-lg font-bold text-red-700">أقل من 50%</p>
                <p className="text-xs text-red-600">يحتاج تحسين</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
