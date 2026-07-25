import { Button } from "@/components/ui/button";
import { BrandLogo } from "@/components/BrandLogo";
import { getLoginUrl } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { useLocation } from "wouter";
import { useEffect } from "react";

export default function Home() {
  const { user, loading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!loading && user) {
      setLocation("/dashboard");
    }
  }, [user, loading, setLocation]);

  if (loading) return null;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        {/* Logo & Title */}
        <div className="text-center mb-10">
          <div className="inline-flex justify-center mb-6 shadow-xl rounded-3xl">
            <BrandLogo variant="icon" size="xl" className="rounded-3xl" />
          </div>
          <h1 className="text-3xl font-bold text-foreground mb-2">
            متجرك
          </h1>
          <p className="text-muted-foreground text-lg">
            كل أعمالك في مكان واحد
          </p>
        </div>

        {/* Features */}
        <div className="grid grid-cols-2 gap-3 mb-8">
          {[
            { icon: "📦", label: "إدارة الأوردرات" },
            { icon: "👥", label: "فريق التأكيدات" },
            { icon: "🏪", label: "إدارة المخزون" },
            { icon: "📊", label: "تقارير الأداء" },
          ].map((f) => (
            <div
              key={f.label}
              className="bg-card/80 backdrop-blur rounded-xl p-4 flex items-center gap-3 shadow-sm border border-border"
            >
              <span className="text-2xl">{f.icon}</span>
              <span className="text-sm font-medium text-foreground">{f.label}</span>
            </div>
          ))}
        </div>

        {/* Login Button */}
        <Button
          onClick={() => { window.location.href = getLoginUrl(); }}
          size="lg"
          className="w-full h-12 text-base font-semibold shadow-lg"
        >
          تسجيل الدخول للمنصة
        </Button>

        <p className="text-center text-xs text-muted-foreground mt-4">
          منصة لإدارة الطلبات والمخزون والشحن والتحصيل لتجار الأونلاين
        </p>
      </div>
    </div>
  );
}
