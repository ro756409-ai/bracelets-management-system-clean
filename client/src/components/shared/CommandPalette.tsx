import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
  CommandSeparator, CommandShortcut,
} from "@/components/ui/command";
import { useAuth } from "@/_core/hooks/useAuth";
import { usePermissions } from "@/hooks/usePermission";
import { PRIMARY_DESTINATIONS, TOOLS_LINKS, canSeeNav, type NavGate, type NavLink } from "@/config/navigation";

/**
 * ⌘K / Ctrl+K palette — the fastest path between any two screens in the product.
 *
 * الوجهات تُشتق من `config/navigation` (المصدر الواحد للشل) ومفلترة بالصلاحيات الفعلية — فلا تكشف
 * اللوحة مسارًا لا يحق للجلسة فتحه. القاعدة (نفس بوابات الشل، مع اعتبار نوع الجلسة):
 *   • بند بـ`permission` → يظهر لو الصلاحية في myPermissions.
 *   • بند `adminOnly` → للمالك/الأدمن الصناعي فقط.
 *   • بند مفتوح → يتطلب جلسة لوحة التحكم (user موجود)؛ موظف البوابة (user=null) يرى ما تمنحه
 *     صلاحياته فقط (مثل دفتر V3 للمحاسب).
 * الإخفاء هنا ليس أمانًا — كل route محروس على مستواه. تُفتح بالاختصار أو بحدث `COMMAND_PALETTE_OPEN_EVENT`
 * من زر البحث في الشريط العلوي.
 */
export const COMMAND_PALETTE_OPEN_EVENT = "matjarak:command-palette:open";

export type PaletteItem = { label: string; href: string; icon: NavLink["icon"]; keywords: string[]; group: string; gate: NavGate };

/** كلمات بحث إضافية (عربي/إنجليزي/أخطاء شائعة) لكل مسار — تُلحق باسم الوجهة من config/navigation. */
const KEYWORDS: Record<string, string[]> = {
  "/orders": ["orders", "اوردرات", "طلبات"], "/dashboard": ["dashboard", "لوحه", "احصائيات"], "/workspace": ["workspace", "مساحه", "شغل"],
  "/bosta-orders": ["bosta", "بوسطة", "شحن", "شحنات"], "/returns": ["returns", "مرتجع"], "/duplicates": ["duplicates", "مكرر", "تكرار"],
  "/printed-orders": ["printed", "مطبوع", "طباعة"], "/scan-orders": ["scan", "qr", "مسح", "باركود"], "/preparation": ["preparation", "تجهيز", "تحضير"],
  "/today-shipments": ["shipments", "شحنات", "اليوم"], "/shipping-schedule": ["schedule", "جدول", "مواعيد"], "/inventory": ["inventory", "مخزون", "منتجات", "products", "اصناف"],
  "/goods-receipt": ["goods", "استلام", "بضاعة"], "/stocktake": ["stocktake", "جرد"], "/workshop-returns": ["workshop", "ورشة"],
  "/employees": ["employees", "موظفين", "فريق"], "/reports": ["reports", "تقارير"], "/businesses": ["businesses", "انشطة", "براند"],
  "/permissions": ["permissions", "صلاحيات", "ادوار"], "/sales-channels": ["channels", "قنوات", "بيع", "تكامل"], "/webhook-settings": ["easy", "webhook", "ربط"],
  "/ledger": ["ledger", "حسابات", "دفتر", "خزنة", "مصروف", "ايراد"], "/ledger/transactions": ["transactions", "حركات", "سجل"], "/ledger/report": ["report", "تقرير", "يومي", "مصروفات"], "/ledger/statements": ["income", "قائمة الدخل", "أرباح", "ربح"], "/ledger/carrier": ["bosta", "بوسطة", "تسوية", "شحن"], "/ledger/accounts": ["accounts", "حسابات", "أرصدة", "ارصدة"], "/ledger/periods": ["periods", "إقفال", "اقفال", "مراجعة", "شهر"], "/ledger/opening": ["opening", "افتتاحي", "جرد"],
  "/print-logs": ["print", "طباعة", "سجل"], "/scan-logs": ["scan", "مسح", "سجل"], "/activity-log": ["activity", "سجل", "انشطة", "log"], "/merge-logs": ["merge", "دمج"],
};

/** كل الوجهات (قبل الفلترة) من config/navigation — الوجهات الأساسية وأبناؤها ثم أدوات «المزيد». */
export function allPaletteItems(): PaletteItem[] {
  const out: PaletteItem[] = [];
  const seen = new Set<string>();
  for (const dest of PRIMARY_DESTINATIONS) {
    for (const link of dest.children ?? [{ label: dest.label, path: dest.path, icon: dest.icon } as NavLink]) {
      if (seen.has(link.path)) continue;
      seen.add(link.path);
      out.push({ label: link.label, href: link.path, icon: link.icon, keywords: KEYWORDS[link.path] ?? [], group: dest.label, gate: { permission: link.permission ?? dest.permission, adminOnly: link.adminOnly ?? dest.adminOnly } });
    }
  }
  for (const link of TOOLS_LINKS) {
    if (seen.has(link.path)) continue;
    seen.add(link.path);
    out.push({ label: link.label, href: link.path, icon: link.icon, keywords: KEYWORDS[link.path] ?? [], group: "المزيد", gate: { permission: link.permission, adminOnly: link.adminOnly } });
  }
  return out;
}

/** الوجهات المرئية لجلسة بعينها. */
export function paletteItemsFor(session: { hasUser: boolean; isAdmin: boolean; permissions: string[] }): PaletteItem[] {
  return allPaletteItems().filter(item => {
    if (item.gate.permission) return session.permissions.includes(item.gate.permission);
    if (item.gate.adminOnly) return session.isAdmin;
    return session.hasUser;
  });
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const { permissions } = usePermissions();
  const items = useMemo(() => paletteItemsFor({ hasUser: Boolean(user), isAdmin: user?.role === "admin", permissions }), [user, permissions]);
  const groups = useMemo(() => Array.from(new Set(items.map(i => i.group))), [items]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ⌘K on macOS, Ctrl+K elsewhere — the convention users already have from Linear,
      // Notion, Slack and GitHub, so it needs no discovery.
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen(v => !v);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen);
    return () => { document.removeEventListener("keydown", onKey); window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, onOpen); };
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
        {groups.map((group, gi) => (
          <div key={group}>
            {gi > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {items.filter(i => i.group === group).map(item => (
                <CommandItem
                  key={item.href}
                  value={`${item.label} ${item.keywords.join(" ")}`}
                  onSelect={() => go(item.href)}
                  className="min-h-11 gap-2"
                  data-testid={`palette-item-${item.href}`}
                >
                  <item.icon className="h-4 w-4 text-muted-foreground" />
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
