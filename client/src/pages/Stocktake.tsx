import { ClipboardCheck } from "lucide-react";
import { PageHeader } from "@/components/shared";
import { useBrandOptions } from "@/hooks/useBrandOptions";
import AccStocktake from "./accountant/AccStocktake";
import { AccCard, AccField, AccSelect } from "./accountant/ui";

/**
 * صفحة الجرد المستقلة للمالك/المدير — تحت DashboardLayout (مش bare زي /accountant).
 *
 * بتعيد استخدام نفس مكوّن `AccStocktake` اللي المحاسب بيستخدمه جوّه مساحته — مفيش نظام
 * جرد موازي. الفرق الوحيد إن مصدر النشاط هنا `useBrandOptions` (نطاق الجلسة، P0-scoped)
 * بدل الـpicker بتاع مساحة المحاسب. زر الاعتماد جوّه المكوّن بيظهر لصاحب
 * `inventory_costing.approve` فقط.
 */
export default function Stocktake() {
  const { brands, selected, setSelected, selectedId, isEmpty } = useBrandOptions();

  return (
    <div className="space-y-5" dir="rtl">
      <PageHeader
        title="الجرد"
        description="جرد أرصدة المخزن، إدخال العدد الفعلي، واعتماد الفروق لتحريك المخزون وتسجيل العجز/الزيادة في الحسابات."
        icon={<ClipboardCheck className="h-5 w-5" />}
      />

      {isEmpty ? (
        <AccCard>
          <p className="p-4 text-center text-sm text-slate-400">مفيش نشاط متاح لحسابك.</p>
        </AccCard>
      ) : (
        <>
          {brands.length > 1 && (
            <AccCard>
              <AccField label="النشاط" required>
                <AccSelect value={selected} onChange={e => setSelected(e.target.value)}>
                  <option value="">— اختار النشاط —</option>
                  {brands.map(b => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </AccSelect>
              </AccField>
            </AccCard>
          )}

          {selectedId != null ? (
            <AccStocktake businessId={selectedId} />
          ) : (
            <AccCard>
              <p className="p-4 text-center text-sm text-slate-400">اختار النشاط الأول عشان تبدأ الجرد.</p>
            </AccCard>
          )}
        </>
      )}
    </div>
  );
}
