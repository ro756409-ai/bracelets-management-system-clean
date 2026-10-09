import { Link } from "wouter";
import { BookOpen, Home, Wrench } from "lucide-react";
import { usePermissions } from "@/hooks/usePermission";

/**
 * صفحة آمنة تحلّ محل كل شاشات النظام المحاسبي الحالي بعد تجميده (قرار: إعادة بنائه لاحقًا
 * بطريقة مختلفة). مافيهاش أي بيانات تشغيلية أو مالية — مجرّد رسالة واضحة. الحماية الأساسية
 * على السيرفر (عمليات الكتابة المحاسبية متوقّفة من `permissionProcedure`)؛ دي طبقة واجهة فوقها.
 * المرحلة 7E: نفس الرسالة والروابط على tokens الهوية، `<main>` واحد، أهداف لمس 44px.
 */
export default function AccountingDisabled() {
  const { has } = usePermissions();
  const hasLedger = has("ledger.view");
  return (
    <main dir="rtl" className="flex min-h-screen items-center justify-center bg-background p-4 sm:p-6" data-testid="accounting-disabled">
      <div className="w-full max-w-md space-y-4 rounded-[var(--radius-brand-lg,var(--radius-brand-md))] border border-border bg-card p-6 text-center shadow-[var(--shadow-card)] sm:p-8">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden="true">
          <Wrench className="h-7 w-7" />
        </div>
        <h1 className="text-xl font-bold text-foreground">النظام المحاسبي قيد إعادة التطوير حاليًا</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          تم إيقاف نظام الحسابات والمصاريف الحالي مؤقتًا لإعادة بنائه بطريقة جديدة.
          بياناتك المالية القديمة محفوظة ولم تُحذف. باقي أقسام النظام (الأوردرات،
          المخزون، الشحن) تعمل بشكل طبيعي.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          {hasLedger && (
            <Link
              href="/ledger"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-brand-md)] bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors duration-[var(--duration-fast)] hover:bg-[var(--primary-dark)]"
              data-testid="accounting-disabled-ledger-link"
            >
              <BookOpen className="h-4 w-4" aria-hidden="true" /> دفتر الحسابات الجديد
            </Link>
          )}
          <Link
            href="/"
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius-brand-md)] px-4 py-2 text-sm font-medium transition-colors duration-[var(--duration-fast)] ${hasLedger ? "border border-border bg-card text-foreground hover:bg-muted" : "bg-primary text-primary-foreground hover:bg-[var(--primary-dark)]"}`}
          >
            <Home className="h-4 w-4" aria-hidden="true" /> العودة للصفحة الرئيسية
          </Link>
        </div>
      </div>
    </main>
  );
}
