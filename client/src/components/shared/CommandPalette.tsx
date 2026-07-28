import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  BarChart3, Boxes, ClipboardList, Copy, FileSpreadsheet, LayoutDashboard, Package,
  Printer, QrCode, RotateCcw, ScanLine, Settings, ShoppingCart, Truck, Users,
} from "lucide-react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
  CommandSeparator, CommandShortcut,
} from "@/components/ui/command";

/**
 * ⌘K / Ctrl+K palette — the fastest path between any two screens in the product.
 *
 * An ERP operator's day is not one page; it is orders → preparation → shipping → back to
 * orders, dozens of times. Sidebar navigation costs a scan and two clicks each hop. This costs
 * a keystroke and a word, and it works the same everywhere, so the muscle memory transfers.
 *
 * Destinations are declared here rather than derived from the router: the palette should list
 * what a human would go looking for, in business language, not every route that happens to
 * exist. `keywords` carry Arabic and English spellings plus common misspellings so "orders",
 * "اوردر" and "طلبات" all land on the same row.
 */

type PaletteItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
  keywords: string[];
  group: string;
};

const ITEMS: PaletteItem[] = [
  // ---- العمل اليومي ----
  { group: "العمل اليومي", label: "الأوردرات", href: "/orders", icon: <ShoppingCart className="h-4 w-4" />, keywords: ["orders", "اوردرات", "طلبات", "الطلبات"] },
  { group: "العمل اليومي", label: "لوحة التحكم", href: "/dashboard", icon: <LayoutDashboard className="h-4 w-4" />, keywords: ["dashboard", "لوحه", "الرئيسية", "احصائيات"] },
  { group: "العمل اليومي", label: "مساحة العمل", href: "/workspace", icon: <ClipboardList className="h-4 w-4" />, keywords: ["workspace", "مساحه", "شغل"] },
  { group: "العمل اليومي", label: "إدخال فيسبوك", href: "/facebook-entry", icon: <FileSpreadsheet className="h-4 w-4" />, keywords: ["facebook", "فيسبوك", "ادخال", "لصق"] },

  // ---- التجهيز والشحن ----
  { group: "التجهيز والشحن", label: "التجهيز", href: "/preparation", icon: <Package className="h-4 w-4" />, keywords: ["preparation", "تجهيز", "تحضير"] },
  { group: "التجهيز والشحن", label: "طلبات بوسطة", href: "/bosta-orders", icon: <Truck className="h-4 w-4" />, keywords: ["bosta", "بوسطة", "شحن", "شحنات"] },
  { group: "التجهيز والشحن", label: "شحنات اليوم", href: "/today-shipments", icon: <Truck className="h-4 w-4" />, keywords: ["shipments", "شحنات", "اليوم"] },
  { group: "التجهيز والشحن", label: "جدول الشحن", href: "/shipping-schedule", icon: <Truck className="h-4 w-4" />, keywords: ["schedule", "جدول", "مواعيد"] },
  { group: "التجهيز والشحن", label: "مسح QR", href: "/scan-orders", icon: <QrCode className="h-4 w-4" />, keywords: ["scan", "qr", "مسح", "باركود"] },
  { group: "التجهيز والشحن", label: "المطبوعات", href: "/printed-orders", icon: <Printer className="h-4 w-4" />, keywords: ["printed", "مطبوع", "طباعة"] },

  // ---- المخزون والمنتجات ----
  { group: "المخزون", label: "المخزون", href: "/inventory", icon: <Boxes className="h-4 w-4" />, keywords: ["inventory", "مخزون", "منتجات", "products", "اصناف"] },
  { group: "المخزون", label: "المرتجعات", href: "/returns", icon: <RotateCcw className="h-4 w-4" />, keywords: ["returns", "مرتجع", "مرتجعات"] },
  { group: "المخزون", label: "المكررات", href: "/duplicates", icon: <Copy className="h-4 w-4" />, keywords: ["duplicates", "مكرر", "تكرار"] },

  // ---- الإدارة ----
  { group: "الإدارة", label: "الموظفون", href: "/employees", icon: <Users className="h-4 w-4" />, keywords: ["employees", "موظفين", "موظفون", "فريق"] },
  { group: "الإدارة", label: "التقارير", href: "/reports", icon: <BarChart3 className="h-4 w-4" />, keywords: ["reports", "تقارير", "تقرير"] },
  { group: "الإدارة", label: "قنوات البيع", href: "/sales-channels", icon: <Settings className="h-4 w-4" />, keywords: ["channels", "قنوات", "بيع", "تكامل"] },
  { group: "الإدارة", label: "سجل الأنشطة", href: "/activity-log", icon: <ScanLine className="h-4 w-4" />, keywords: ["activity", "سجل", "انشطة", "log"] },
];

const GROUPS = Array.from(new Set(ITEMS.map((i) => i.group)));

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K on macOS, Ctrl+K elsewhere — the convention users already have from Linear,
      // Notion, Slack and GitHub, so it needs no discovery.
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    navigate(href);
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="لوحة الأوامر"
      description="ابحث عن صفحة أو إجراء"
      className="rounded-[var(--radius-brand-lg)]"
    >
      <CommandInput placeholder="اذهب إلى… (اكتب اسم الصفحة)" />
      <CommandList>
        <CommandEmpty>لا توجد نتائج مطابقة.</CommandEmpty>
        {GROUPS.map((group, gi) => (
          <div key={group}>
            {gi > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {ITEMS.filter((i) => i.group === group).map((item) => (
                <CommandItem
                  key={item.href}
                  value={`${item.label} ${item.keywords.join(" ")}`}
                  onSelect={() => go(item.href)}
                  className="gap-2"
                >
                  <span className="text-muted-foreground">{item.icon}</span>
                  <span>{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </div>
        ))}
      </CommandList>
      <div className="flex items-center justify-between border-t border-border px-3 py-2">
        <span className="type-caption">للتنقل ↑↓ · للفتح ↵</span>
        <CommandShortcut>⌘K</CommandShortcut>
      </div>
    </CommandDialog>
  );
}
