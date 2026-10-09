import { useLocation } from "wouter";
import { useTenantAccess } from "@/contexts/TenantAccessContext";
import { ChevronDown, Plus, ShoppingCart, BookOpen, PackagePlus, ClipboardCheck, RotateCcw, Users, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PRIMARY_DESTINATIONS, canSeeNav, type NavGate } from "@/config/navigation";

/**
 * زر «إنشاء» المقسوم (Theme Spec §3) — روابط لصفحات **موجودة** يبدأ فيها الإنشاء فعلًا، لا إجراءات
 * وهمية. كل بند يحمل بوابة الوجهة نفسها من `config/navigation` (مصدر واحد)، فلا يظهر للمستخدم
 * إلا ما يحق له فتحه؛ الحارس الحقيقي يبقى على الـroute والـendpoint.
 *
 * البند الرئيسي «أوردر جديد» ينقل إلى صفحة الطلبات (زر «أوردر جديد» فيها هو ما يفتح النموذج؛ فتحه
 * تلقائيًا يحتاج تعديل Orders.tsx — مرحلة الطلبات). الوصف تحت كل بند يقول أين يذهب.
 */
export type CreateMenuItem = { key: string; label: string; description: string; path: string; icon: typeof Plus; gate: NavGate };

/** بوابة مسار معيّن كما هي في config/navigation (وجهة أو ابن). غير الموجود = مفتوح (لا يُستخدم هنا). */
export function gateForPath(path: string): NavGate {
  for (const dest of PRIMARY_DESTINATIONS) {
    for (const child of dest.children ?? []) if (child.path === path) return { permission: child.permission ?? dest.permission, adminOnly: child.adminOnly ?? dest.adminOnly };
    if (dest.path === path) return { permission: dest.permission, adminOnly: dest.adminOnly };
  }
  return {};
}

const ALL_ITEMS: CreateMenuItem[] = [
  { key: "order", label: "أوردر جديد", description: "صفحة الطلبات", path: "/orders", icon: ShoppingCart, gate: gateForPath("/orders") },
  // الترحيل يتطلب ledger.post لا ledger.view — البوابة هنا أدق من بوابة الوجهة
  { key: "ledger", label: "حركة في الدفتر", description: "الحسابات اليومية", path: "/ledger", icon: BookOpen, gate: { permission: "ledger.post" } },
  { key: "goods", label: "إذن استلام بضاعة", description: "المخزون", path: "/goods-receipt", icon: PackagePlus, gate: gateForPath("/goods-receipt") },
  { key: "stocktake", label: "جرد", description: "المخزون", path: "/stocktake", icon: ClipboardCheck, gate: gateForPath("/stocktake") },
  { key: "workshop", label: "مرتجعات الورشة", description: "المخزون", path: "/workshop-returns", icon: RotateCcw, gate: gateForPath("/workshop-returns") },
  { key: "employee", label: "إضافة موظف", description: "الفريق", path: "/employees", icon: Users, gate: gateForPath("/employees") },
  { key: "business", label: "نشاط جديد", description: "إدارة الأنشطة", path: "/businesses", icon: Building2, gate: gateForPath("/businesses") },
];

export type ShellSession = { hasUser: boolean; isAdmin: boolean; permissions: string[] };

/**
 * البنود المرئية لجلسة — نفس قاعدة الشل (canSeeNav) مع اعتبار نوع الجلسة: البند المفتوح (بلا بوابة)
 * يتطلب جلسة لوحة تحكم (user موجود)؛ موظف البوابة يرى ما تمنحه صلاحياته فقط.
 */
export function createMenuItems(session: ShellSession): CreateMenuItem[] {
  return ALL_ITEMS.filter(i => {
    if (i.gate.permission) return session.permissions.includes(i.gate.permission);
    if (i.gate.adminOnly) return session.isAdmin;
    return session.hasUser && canSeeNav(i.gate, session.isAdmin, session.permissions);
  });
}

export function CreateMenu({ isAdmin, permissions, hasUser = true, compact = false }: { isAdmin: boolean; permissions: string[]; hasUser?: boolean; compact?: boolean }) {
  const [, setLocation] = useLocation();
  const { readOnly } = useTenantAccess();
  const items = createMenuItems({ hasUser, isAdmin, permissions });
  // وضع القراءة فقط للشركة: لا مدخل إنشاء إطلاقًا (مخفي، لا معطّل) — السيرفر يرفض الكتابة أيضًا.
  if (items.length === 0 || readOnly) return null;
  const [primary, ...rest] = items;

  if (compact) {
    // الموبايل: أيقونة واحدة تفتح القائمة كاملة (لا زر مقسوم ضيق)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" size="icon" className="h-11 w-11 shrink-0" aria-label="إنشاء" data-testid="create-menu-compact">
            <Plus className="h-5 w-5" />
          </Button>
        </DropdownMenuTrigger>
        <CreateMenuContent items={items} go={setLocation} />
      </DropdownMenu>
    );
  }

  return (
    <div className="flex items-stretch" data-testid="create-menu">
      <Button type="button" onClick={() => setLocation(primary.path)} className="h-10 rounded-e-none px-3" data-testid="create-primary">
        <Plus className="h-4 w-4" />
        <span>{primary.label}</span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" className="h-10 w-9 rounded-s-none border-s border-primary-foreground/20 px-0" aria-label="خيارات الإنشاء" data-testid="create-more">
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <CreateMenuContent items={rest.length ? rest : items} go={setLocation} />
      </DropdownMenu>
    </div>
  );
}

function CreateMenuContent({ items, go }: { items: CreateMenuItem[]; go: (path: string) => void }) {
  return (
    <DropdownMenuContent align="start" className="w-64">
      <DropdownMenuLabel className="text-xs text-muted-foreground">إنشاء</DropdownMenuLabel>
      <DropdownMenuSeparator />
      {items.map(item => (
        <DropdownMenuItem key={item.key} onClick={() => go(item.path)} className="min-h-11 cursor-pointer gap-3" data-testid={`create-item-${item.key}`}>
          <item.icon className="h-4 w-4 text-muted-foreground" />
          <span className="flex min-w-0 flex-col">
            <span className="text-sm">{item.label}</span>
            <span className="text-xs text-muted-foreground">{item.description}</span>
          </span>
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  );
}
