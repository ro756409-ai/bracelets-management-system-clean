import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GitMerge, RefreshCw, Search, Phone, Package, Hash, Calendar, TrendingUp } from "lucide-react";

export default function MergeLogs() {
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);

  const { data, isLoading, refetch } = trpc.reports.mergeLogs.useQuery({
    dateFrom,
    dateTo,
    limit: 200,
  });

  const logs = data?.logs ?? [];

  // Filter by search
  const filtered = logs.filter((log: any) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      log.customerName?.toLowerCase().includes(q) ||
      log.customerPhone?.includes(q) ||
      log.productName?.toLowerCase().includes(q) ||
      log.keptOrderNumber?.includes(q)
    );
  });

  // Stats
  const totalMerges = logs.length;
  const totalQtyMerged = logs.reduce((sum: number, l: any) => sum + Number(l.mergedQty || 0), 0);
  const uniqueCustomers = new Set(logs.map((l: any) => l.customerPhone)).size;
  const todayMerges = logs.filter((l: any) => {
    const d = new Date(l.createdAt);
    const today = new Date();
    return d.toDateString() === today.toDateString();
  }).length;

  const formatDate = (d: any) => {
    if (!d) return "-";
    return new Date(d).toLocaleString("ar-EG", {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  };

  return (
    <div className="p-6 space-y-6" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <GitMerge className="h-6 w-6 text-[var(--warning)]" />
            تقرير الدمج التلقائي
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            سجل كامل بكل أوردر تم دمجه تلقائياً بسبب التكرار
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          تحديث
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-3xl font-bold text-[var(--warning)]">{totalMerges}</div>
            <div className="text-sm text-muted-foreground mt-1">إجمالي عمليات الدمج</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-3xl font-bold text-[var(--info)]">{totalQtyMerged}</div>
            <div className="text-sm text-muted-foreground mt-1">إجمالي الكميات المدمجة</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-3xl font-bold text-[var(--success)]">{uniqueCustomers}</div>
            <div className="text-sm text-muted-foreground mt-1">عملاء فريدون</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="text-3xl font-bold text-[var(--warning)]">{todayMerges}</div>
            <div className="text-sm text-muted-foreground mt-1">دمج اليوم</div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="بحث بالاسم أو الهاتف أو المنتج..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pr-9"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground whitespace-nowrap">من:</label>
              <Input
                type="date"
                className="w-36"
                onChange={e => setDateFrom(e.target.value ? new Date(e.target.value) : undefined)}
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground whitespace-nowrap">إلى:</label>
              <Input
                type="date"
                className="w-36"
                onChange={e => setDateTo(e.target.value ? new Date(e.target.value + "T23:59:59") : undefined)}
              />
            </div>
            {(search || dateFrom || dateTo) && (
              <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setDateFrom(undefined); setDateTo(undefined); }}>
                مسح الفلاتر
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <GitMerge className="h-4 w-4 text-[var(--warning)]" />
            سجل عمليات الدمج
            <Badge variant="secondary" className="mr-2">{filtered.length} عملية</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin ml-2" />
              جاري التحميل...
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-3">
              <GitMerge className="h-12 w-12 opacity-20" />
              <p className="text-lg font-medium">لا توجد عمليات دمج</p>
              <p className="text-sm">لم يتم دمج أي أوردرات مكررة حتى الآن</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">#</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">
                      <span className="flex items-center gap-1"><Hash className="h-3.5 w-3.5" /> رقم الأوردر</span>
                    </th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">
                      <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> العميل</span>
                    </th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">
                      <span className="flex items-center gap-1"><Package className="h-3.5 w-3.5" /> المنتج</span>
                    </th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">
                      <span className="flex items-center gap-1"><TrendingUp className="h-3.5 w-3.5" /> الكمية المضافة</span>
                    </th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">الكمية بعد الدمج</th>
                    <th className="text-right py-3 px-4 font-medium text-muted-foreground">
                      <span className="flex items-center gap-1"><Calendar className="h-3.5 w-3.5" /> التاريخ</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((log: any, i: number) => (
                    <tr key={log.id} className="border-b hover:bg-muted/20 transition-colors">
                      <td className="py-3 px-4 text-muted-foreground">{i + 1}</td>
                      <td className="py-3 px-4">
                        <Badge variant="outline" className="font-mono text-[var(--warning)] border-[var(--warning)]/40 bg-[var(--warning)]/10">
                          #{log.keptOrderNumber}
                        </Badge>
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-medium">{log.customerName}</div>
                        <div className="text-xs text-muted-foreground">{log.customerPhone}</div>
                      </td>
                      <td className="py-3 px-4">
                        <span className="text-sm">{log.productName}</span>
                      </td>
                      <td className="py-3 px-4">
                        <Badge className="bg-[var(--info)]/15 text-[var(--info)] border-[var(--info)]/30">
                          +{log.mergedQty}
                        </Badge>
                      </td>
                      <td className="py-3 px-4">
                        <span className="font-semibold text-[var(--success)]">{log.totalQtyAfter}</span>
                      </td>
                      <td className="py-3 px-4 text-muted-foreground text-xs">
                        {formatDate(log.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
