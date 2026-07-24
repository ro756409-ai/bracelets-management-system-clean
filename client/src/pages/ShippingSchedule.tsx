import { useState } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/BrandMark";
import { ArrowRight, Printer } from "lucide-react";

const SCHEDULE_IMAGE_URL = "https://d2xsxph8kpxj0f.cloudfront.net/310519663375135838/HcrR8sAS4ry64VmnqEHaLw/shipping-schedule_19917bee.jpeg";

// بيانات جدول توزيع المحافظات (مطابقة للصورة)
const SCHEDULE_DATA = [
  {
    day: "السبت",
    governorates: "الاسكندرية - المنوفية - الشرقية - بني سويف - الاسماعيلية - السويس - بور سعيد - غربية - دقهلية - كفر الشيخ",
    extra: "فيوم - بحيره",
  },
  {
    day: "الاحد",
    governorates: "الاسكندرية - المنوفية - الشرقية - بني سويف - الاسماعيلية - السويس - بور سعيد - غربية - دقهلية - كفر الشيخ",
    extra: "بحيره",
  },
  {
    day: "الاثنين",
    governorates: "الاسكندرية - المنوفية - الشرقية - بني سويف - الاسماعيلية - السويس - بور سعيد - غربية - دقهلية - كفر الشيخ",
    extra: "فيوم - دمياط",
  },
  {
    day: "الثلاثاء",
    governorates: "الاسكندرية - المنوفية - الشرقية - بني سويف - الاسماعيلية - السويس - بور سعيد - غربية - دقهلية - كفر الشيخ",
    extra: "بحيره",
  },
  {
    day: "الاربعاء",
    governorates: "الاسكندرية - المنوفية - الشرقية - بني سويف - الاسماعيلية - السويس - بور سعيد - غربية - دقهلية - كفر الشيخ",
    extra: "بحيره الساحل ومطروح",
  },
  {
    day: "الخميس",
    governorates: "الاسكندرية - المنوفية - الشرقية - بني سويف - الاسماعيلية - السويس - بور سعيد - غربية - دقهلية - كفر الشيخ",
    extra: "فيوم - دمياط",
  },
];

const NOTES = [
  { text: "يتم استلام محافظات الصعيد يومي الاحد والاربعاء ويتم تسليم الشحنات خلال 48 الي 72 ساعة", color: "bg-red-50 border-red-200 text-red-800" },
  { text: "حساب الصعيد يوم الاحد ويوم الخميس & حساب مطروح والساحل يوم الاربعاء من كل اسبوع", color: "bg-yellow-50 border-yellow-200 text-yellow-800" },
  { text: "الحساب متاح يومياً ماعدا الجمعة من الساعة 12 ظهراً الي الساعة 5 مساءً", color: "bg-blue-50 border-blue-200 text-blue-800" },
  { text: "يتم استلام المحافظات قبل ميعاد التسليم يوم بناءً على توزيع المحافظات في الجدول", color: "bg-blue-50 border-blue-200 text-blue-800" },
  { text: "مواعيد استلام الشحنات يومياً من الساعة 5 مساءً الي الساعة 10 مساءً", color: "bg-green-50 border-green-200 text-green-800" },
];

// تحديد اليوم الحالي
function getTodayArabicDay(): string {
  const days = ["الاحد", "الاثنين", "الثلاثاء", "الاربعاء", "الخميس", "الجمعة", "السبت"];
  const now = new Date(Date.now() + 2 * 60 * 60 * 1000); // Cairo offset
  return days[now.getUTCDay()];
}

export default function ShippingSchedule() {
  const [, setLocation] = useLocation();
  const [viewMode, setViewMode] = useState<'table' | 'image'>('table');
  const todayDay = getTodayArabicDay();

  // Check employee auth
  const { data: employee, isLoading } = trpc.employeePortal.me.useQuery(undefined, {
    retry: false,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-amber-50 to-white">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-600" />
      </div>
    );
  }

  if (!employee) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-amber-50 to-white">
        <div className="text-center space-y-4">
          <p className="text-muted-foreground">يرجى تسجيل الدخول أولاً</p>
          <Button onClick={() => setLocation("/employee-login")}>تسجيل الدخول</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background" dir="rtl">
      {/* Header */}
      <header
        className="sticky top-0 z-40 shadow-md print:hidden"
        style={{ background: "linear-gradient(135deg, var(--primary-dark) 0%, var(--primary) 100%)" }}
      >
        <div className="flex items-center justify-between px-4 py-3 max-w-4xl mx-auto">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setLocation("/employee-dashboard")}
              className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors"
            >
              <ArrowRight className="h-4 w-4" />
            </button>
            <BrandMark className="w-8 h-8" />
            <div>
              <p className="text-white font-bold text-sm leading-tight">جدول توزيع المحافظات</p>
              <p className="text-white/70 text-xs">مواعيد الشحن والاستلام</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setViewMode(viewMode === 'table' ? 'image' : 'table')}
              className="px-3 py-1.5 rounded-lg bg-white/10 text-white text-xs hover:bg-white/20 transition-colors"
            >
              {viewMode === 'table' ? 'عرض الصورة' : 'عرض الجدول'}
            </button>
            <button
              onClick={() => window.print()}
              className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center text-white hover:bg-white/20 transition-colors"
              title="طباعة"
            >
              <Printer className="h-4 w-4" />
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {viewMode === 'image' ? (
          /* عرض الصورة الأصلية */
          <div className="bg-white rounded-2xl shadow-lg overflow-hidden border border-amber-100">
            <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white text-center py-3 font-bold text-lg print:bg-blue-600">
              جدول توزيع المحافظات
            </div>
            <img
              src={SCHEDULE_IMAGE_URL}
              alt="جدول توزيع المحافظات"
              className="w-full"
            />
          </div>
        ) : (
          /* عرض الجدول التفاعلي */
          <>
            <div className="bg-white rounded-2xl shadow-lg overflow-hidden border border-amber-100">
              <div className="bg-gradient-to-r from-blue-600 to-blue-700 text-white text-center py-3 font-bold text-lg">
                جدول توزيع المحافظات
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-blue-50 border-b-2 border-blue-200">
                      <th className="py-3 px-4 text-right font-bold text-blue-800 w-24">اليوم</th>
                      <th className="py-3 px-4 text-right font-bold text-blue-800">المحافظات</th>
                      <th className="py-3 px-4 text-right font-bold text-blue-800 w-40">إضافي</th>
                    </tr>
                  </thead>
                  <tbody>
                    {SCHEDULE_DATA.map((row, i) => {
                      const isToday = row.day === todayDay;
                      return (
                        <tr
                          key={i}
                          className={`border-b transition-colors ${
                            isToday
                              ? 'bg-amber-50 border-amber-200 ring-2 ring-amber-400 ring-inset'
                              : i % 2 === 0
                              ? 'bg-white hover:bg-gray-50'
                              : 'bg-gray-50/50 hover:bg-gray-100/50'
                          }`}
                        >
                          <td className={`py-3 px-4 font-bold whitespace-nowrap ${isToday ? 'text-amber-700' : 'text-blue-700'}`}>
                            {row.day}
                            {isToday && (
                              <span className="block text-[10px] font-normal text-amber-600 bg-amber-100 rounded px-1 mt-0.5 text-center">
                                اليوم
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-gray-700 text-xs leading-relaxed">
                            {row.governorates}
                          </td>
                          <td className="py-3 px-4 font-semibold text-blue-700 text-xs">
                            {row.extra}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* ملاحظات مهمة */}
            <div className="space-y-3">
              <h3 className="font-bold text-gray-800 text-base">ملاحظات مهمة</h3>
              {NOTES.map((note, i) => (
                <div
                  key={i}
                  className={`rounded-xl border p-3 text-sm font-medium ${note.color}`}
                >
                  {note.text}
                </div>
              ))}
            </div>
          </>
        )}

        {/* Footer */}
        <div className="text-center text-xs text-muted-foreground pb-4 print:hidden">
          <p>إدارة — متجرك</p>
        </div>
      </div>

      {/* Print styles */}
      <style>{`
        @media print {
          header { display: none !important; }
          .print\\:hidden { display: none !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
    </div>
  );
}
