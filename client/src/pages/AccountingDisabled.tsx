import { Link } from "wouter";
import { BookOpen, Wrench } from "lucide-react";
import { usePermissions } from "@/hooks/usePermission";

/**
 * صفحة آمنة تحلّ محل كل شاشات النظام المحاسبي الحالي بعد تجميده (قرار: إعادة بنائه لاحقًا
 * بطريقة مختلفة). مافيهاش أي بيانات تشغيلية أو مالية — مجرّد رسالة واضحة. الحماية الأساسية
 * على السيرفر (عمليات الكتابة المحاسبية متوقّفة من `permissionProcedure`)؛ دي طبقة واجهة فوقها.
 */
export default function AccountingDisabled() {
  const { has } = usePermissions();
  return (
    <div
      dir="rtl"
      className="min-h-screen flex items-center justify-center bg-background p-6"
    >
      <div className="max-w-md w-full text-center space-y-4 rounded-xl border bg-card p-8 shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-muted">
          <Wrench className="h-7 w-7 text-muted-foreground" />
        </div>
        <h1 className="text-xl font-bold text-foreground">
          النظام المحاسبي قيد إعادة التطوير حاليًا
        </h1>
        <p className="text-sm text-muted-foreground leading-relaxed">
          تم إيقاف نظام الحسابات والمصاريف الحالي مؤقتًا لإعادة بنائه بطريقة جديدة.
          بياناتك المالية القديمة محفوظة ولم تُحذف. باقي أقسام النظام (الأوردرات،
          المخزون، الشحن) تعمل بشكل طبيعي.
        </p>
        {has("ledger.view") && (
          <Link
            href="/ledger"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
            data-testid="accounting-disabled-ledger-link"
          >
            <BookOpen className="h-4 w-4" /> دفتر الحسابات الجديد
          </Link>
        )}
        <Link
          href="/"
          className={`inline-block rounded-md px-4 py-2 text-sm font-medium ${has("ledger.view") ? "border bg-card text-foreground" : "bg-primary text-primary-foreground"}`}
        >
          العودة للصفحة الرئيسية
        </Link>
      </div>
    </div>
  );
}
