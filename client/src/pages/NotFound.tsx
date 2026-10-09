import { Button } from "@/components/ui/button";
import { Compass, Home, ArrowRight } from "lucide-react";
import { useLocation } from "wouter";

/**
 * 404 — بالعربية وعلى tokens الهوية (المرحلة 7H). `<main>` واحد، زر 44px، ورجوع للصفحة الرئيسية
 * (الرئيسية تحوّل المستخدم المسجّل إلى لوحة التحكم تلقائيًا).
 */
export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <main dir="rtl" className="flex min-h-screen w-full items-center justify-center bg-background p-4" data-testid="not-found">
      <div className="w-full max-w-lg rounded-[var(--radius-brand-lg,var(--radius-brand-md))] border border-border bg-card p-8 text-center shadow-[var(--shadow-card)]">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-accent text-accent-foreground" aria-hidden="true">
          <Compass className="h-8 w-8" />
        </div>

        <p className="mb-1 font-mono text-4xl font-bold tabular-nums text-primary" dir="ltr">404</p>
        <h1 className="mb-3 text-xl font-semibold text-foreground">الصفحة غير موجودة</h1>
        <p className="mb-8 text-sm leading-relaxed text-muted-foreground">
          الرابط الذي فتحته غير موجود أو تم نقله. تأكد من العنوان أو ارجع للصفحة الرئيسية.
        </p>

        <div id="not-found-button-group" className="flex flex-col justify-center gap-3 sm:flex-row">
          <Button data-readonly-safe onClick={() => setLocation("/")} className="min-h-11 md:min-h-9" data-testid="not-found-home">
            <Home className="h-4 w-4 ml-2" aria-hidden="true" />
            الصفحة الرئيسية
          </Button>
          <Button variant="outline" onClick={() => window.history.back()} className="min-h-11 md:min-h-9" data-testid="not-found-back">
            <ArrowRight className="h-4 w-4 ml-2" aria-hidden="true" />
            رجوع
          </Button>
        </div>
      </div>
    </main>
  );
}
