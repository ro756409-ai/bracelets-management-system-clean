import React, { createContext, useContext } from "react";
import { useDisplayPrefs } from "./DisplayPrefsContext";

type Theme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  toggleTheme?: () => void;
  switchable: boolean;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

interface ThemeProviderProps {
  children: React.ReactNode;
  /** لم يعد يؤثر: الوضع يأتي من تخصيص العرض لكل مستخدم (المرحلة 5). يبقى للتوافق مع الاستدعاءات القائمة. */
  defaultTheme?: Theme;
  switchable?: boolean;
}

/**
 * واجهة الوضع (فاتح/داكن) كما كانت لمستهلكيها (sonner, …) — لكن المصدر الآن `DisplayPrefsProvider`:
 * هو من يقرأ تفضيل المستخدم («فاتح/داكن/حسب الجهاز») ويكتب `.dark` على الجذر ويتابع النظام أثناء الجلسة.
 * `toggleTheme` يحفظ الاختيار الصريح للمستخدم الحالي (لا مفتاح `theme` العام القديم).
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  const { resolvedTheme, update } = useDisplayPrefs();
  const toggleTheme = () => update({ theme: resolvedTheme === "dark" ? "light" : "dark" });
  return (
    <ThemeContext.Provider value={{ theme: resolvedTheme, toggleTheme, switchable: true }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
