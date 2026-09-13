import { Truck } from "lucide-react";
import { SHIPPING_DAY_NAMES, type ShippingRouteView } from "@/lib/shippingOperations";

/**
 * لوحة مسارات شركات الشحن — قسم لكل يوم (اليوم الحالي متعلّم) وكارت لكل شركة بمحافظاتها.
 *
 * مكوّن عرض واحد لصفحة بوابة الموظفين (ShippingSchedule) وتبويب «جدول الشحن» في Operations
 * workspace. اتنقل من ShippingSchedule كما هو.
 */
export function ShippingRoutesBoard({ routes, today }: { routes: ShippingRouteView[]; today: string }) {
  if (routes.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed p-10 text-center text-muted-foreground">
        <Truck className="mx-auto mb-3 h-8 w-8" />
        مفيش مسارات شحن متضبطة للنشاط الحالي.
      </div>
    );
  }

  return (
    <>
      {SHIPPING_DAY_NAMES.map((day, dayOfWeek) => {
        const rows = routes.filter(route => route.dayOfWeek === dayOfWeek).sort((a, b) => b.priority - a.priority);
        if (!rows.length) return null;
        return (
          <section key={day} className={`overflow-hidden rounded-2xl border ${day === today ? "border-emerald-500" : ""}`}>
            <h2 className="bg-muted px-4 py-3 font-bold">{day}{day === today ? " · اليوم" : ""}</h2>
            <div className="grid gap-3 p-4 md:grid-cols-2">
              {rows.map((route, index) => (
                <article key={`${route.providerName}-${index}`} className="rounded-xl border p-4">
                  <div className="flex justify-between">
                    <strong>{route.providerName}</strong>
                    <span className="text-xs text-muted-foreground">Priority {route.priority}</span>
                  </div>
                  <p className="mt-2 text-sm">{route.governorates.join(" · ")}</p>
                  {route.notes && <p className="mt-2 text-xs text-muted-foreground">{route.notes}</p>}
                </article>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
