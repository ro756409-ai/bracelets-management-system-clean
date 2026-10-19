import { Button } from "@/components/ui/button";
import { BrandLogo } from "@/components/BrandLogo";
import { getLoginUrl } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { useEffect } from "react";
import { Package, Users, Warehouse, BarChart3 } from "lucide-react";
import { activeBrand } from "@/lib/brandFlag";
import Landing from "./Landing";

const FEATURES = [
  { icon: Package, label: "إدارة الأوردرات" },
  { icon: Users, label: "فريق التأكيدات" },
  { icon: Warehouse, label: "إدارة المخزون" },
  { icon: BarChart3, label: "تقارير الأداء" },
];

/**
 * الصفحة الرئيسية العامة — المستخدم المسجّل يُحوَّل للوحة التحكم (كما كان). المرحلة 7H (عرض فقط):
 * أيقونات lucide بدل الإيموجي، tokens الهوية، `<main>` واحد، وزر 44px.
 */
export default function Home() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!loading && user) {
      setLocation("/dashboard");
    }
  }, [user, loading, setLocation]);

  if (loading) return null;
  // الهوية v2: الصفحة الرئيسية التسويقية الكاملة (عربي/إنجليزي). v1 تفضل زي ما هي بالظبط.
  if (activeBrand() === "v2") return <Landing />;

  return (
    <main dir="rtl" className="flex min-h-screen items-center justify-center bg-background p-4" data-testid="home-page">
      <div className="w-full max-w-md">
        {/* Logo & Title */}
        <div className="mb-10 text-center">
          <div className="mb-6 inline-flex justify-center rounded-[var(--radius-brand-xl,1.5rem)] shadow-[var(--shadow-card)]">
            <BrandLogo variant="icon" size="xl" className="rounded-[var(--radius-brand-xl,1.5rem)]" />
          </div>
          <h1 className="mb-2 text-3xl font-bold text-foreground">
            متجرك
          </h1>
          <p className="text-lg text-muted-foreground">
            كل أعمالك في مكان واحد
          </p>
        </div>

        {/* Features */}
        <ul className="mb-8 grid grid-cols-2 gap-3">
          {FEATURES.map((f) => (
            <li
              key={f.label}
              className="flex items-center gap-3 rounded-[var(--radius-brand-md)] border border-border bg-card p-4 shadow-[var(--shadow-card)]"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-brand-md)] bg-accent text-accent-foreground" aria-hidden="true"><f.icon className="h-5 w-5" /></span>
              <span className="text-sm font-medium text-foreground">{f.label}</span>
            </li>
          ))}
        </ul>

        {/* Login Button */}
        <Button data-readonly-safe
          onClick={() => { window.location.href = getLoginUrl(); }}
          size="lg"
          className="h-12 w-full text-base font-semibold"
          data-testid="home-login"
        >
          تسجيل الدخول للمنصة
        </Button>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          منصة لإدارة الطلبات والمخزون والشحن والتحصيل لتجار الأونلاين
        </p>
      </div>
    </main>
  );
}
