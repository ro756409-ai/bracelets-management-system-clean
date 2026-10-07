import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";

/**
 * أنشطة الجلسة لواجهة دفتر V3 — المصدر الواحد لصفحات الدفتر (نظير `useBrandOptions` لكن من
 * `ledger.businesses.list`: نطاق السيرفر، يعمل لجلسة الموظف غير الإداري/المحاسب التي لا يملكها
 * BusinessContext). نفس القواعد: نشاط واحد → يُختار تلقائيًا، أكثر → اختيار، **صفر → `isEmpty`
 * صريح** فلا تطلب الشاشة اختيارًا لا وسيلة له.
 */
export function useLedgerBusinesses(initialId?: number) {
  const query = trpc.ledger.businesses.list.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const brands = useMemo(() => query.data ?? [], [query.data]);
  const [selected, setSelected] = useState(initialId != null ? String(initialId) : "");

  // effect لا قيمة ابتدائية كسولة: القائمة تصل من الاستعلام بعد أول render
  useEffect(() => {
    if (brands.length !== 1) return;
    const only = String(brands[0].id);
    setSelected(current => (current ? current : only));
  }, [brands]);

  // نشاط اختفى من القائمة (أُلغي/خرج من النطاق) لا يبقى مختارًا
  useEffect(() => {
    if (!selected || brands.length === 0) return;
    if (!brands.some(b => String(b.id) === selected)) setSelected("");
  }, [brands, selected]);

  return {
    brands,
    selected,
    setSelected,
    selectedId: Number(selected) || undefined,
    needsChoice: brands.length > 1 && !selected,
    isEmpty: !query.isLoading && brands.length === 0,
    isLoading: query.isLoading,
  };
}
