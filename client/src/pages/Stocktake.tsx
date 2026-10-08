import { ClipboardCheck } from "lucide-react";
import { PageHeader, ScopeBar, EmptyState } from "@/components/shared";
import { SectionIcon } from "@/components/brand";
import { useBrandOptions } from "@/hooks/useBrandOptions";
import StocktakeBoard from "@/components/inventory/StocktakeBoard";

/**
 * صفحة الجرد المستقلة للمالك/المدير/موظف المخزن — تحت DashboardLayout (أو EmployeeShell لجلسة موظف).
 *
 * المرحلة 7C: العرض عبر `StocktakeBoard` (Copper Signature) على **نفس الـendpoints ونفس التدفق** الذي
 * يستخدمه مكوّن المحاسب `AccStocktake` داخل مساحته (لم يُمس) — مفيش نظام جرد موازٍ. مصدر النشاط هنا
 * `useBrandOptions` (نطاق الجلسة، P0-scoped). زر الاعتماد جوّه المكوّن بيظهر لصاحب
 * `inventory_costing.approve` فقط.
 */
export default function Stocktake() {
  const { brands, selected, setSelected, selectedId, isEmpty } = useBrandOptions();

  return (
    <div className="space-y-5" dir="rtl" data-testid="stocktake-page">
      <PageHeader
        title="الجرد"
        description="جرد أرصدة المخزن: الكمية المسجلة، العدد الفعلي، الفرق لكل سطر، ثم اعتماد صريح يحرّك المخزون."
        icon={<SectionIcon section="inventory" fallback={ClipboardCheck} size="md" />}
      >
        {brands.length > 1 && (
          <ScopeBar
            options={brands.map(b => ({ id: b.id, label: b.name }))}
            value={selected ? Number(selected) : null}
            onChange={id => setSelected(id == null ? "" : String(id))}
            allLabel="اختر النشاط"
          />
        )}
      </PageHeader>

      {isEmpty ? (
        <EmptyState title="مفيش نشاط متاح لحسابك" description="الجرد يتم لنشاط محدد — تأكد من ربط حسابك بنشاط." />
      ) : selectedId != null ? (
        <StocktakeBoard businessId={selectedId} />
      ) : (
        <EmptyState title="اختار النشاط الأول" description="اختر النشاط من الأعلى لعرض جلسات الجرد وبدء جردة جديدة." />
      )}
    </div>
  );
}
