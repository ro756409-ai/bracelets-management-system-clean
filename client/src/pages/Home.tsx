import { Button } from "@/components/ui/button";
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
    <div className="min-h-screen bg-gradient-to-br from-amber-50 via-orange-50 to-yellow-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        {/* Logo & Title */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-3xl bg-gradient-to-br from-amber-600 to-orange-700 shadow-xl mb-6">
            <span className="text-4xl">⚜️</span>
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            نظام إدارة الأساور
          </h1>
          <p className="text-gray-600 text-lg">
            الأساور النحاسية الطبية
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
              className="bg-white/80 backdrop-blur rounded-xl p-4 flex items-center gap-3 shadow-sm border border-amber-100"
            >
              <span className="text-2xl">{f.icon}</span>
              <span className="text-sm font-medium text-gray-700">{f.label}</span>
            </div>
          ))}
        </div>

        {/* Login Button */}
        <Button
          onClick={() => { window.location.href = getLoginUrl(); }}
          size="lg"
          className="w-full h-12 text-base font-semibold shadow-lg"
        >
          تسجيل الدخول للنظام
        </Button>

        <p className="text-center text-xs text-gray-500 mt-4">
          نظام متكامل لإدارة 300-1000 أوردر يومياً
        </p>
      </div>
    </div>
  );
}
