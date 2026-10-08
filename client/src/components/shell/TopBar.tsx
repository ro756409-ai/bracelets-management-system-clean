import { AlertTriangle, Bell, CircleHelp, LogOut, Search, SlidersHorizontal } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CreateMenu } from "./CreateMenu";
import { COMMAND_PALETTE_OPEN_EVENT } from "@/components/shared/CommandPalette";

/**
 * عناصر الشريط العلوي (Theme Spec §3) — تُركَّب داخل `<header>` في DashboardLayout.
 *   • «إنشاء» (روابط موجودة مفلترة بالصلاحيات) · البحث يفتح لوحة الأوامر الحالية (⌘K).
 *   • «تخصيص العرض» و«المساعدة» و«الإشعارات» مدخلات **معطّلة صراحةً** (aria-disabled + تلميح «غير
 *     متاح حاليًا»): لا نظام خلفها بعد، فلا تدّعي أنها تعمل (تخصيص العرض = المرحلة 5).
 *   • قائمة المستخدم (الاسم/الدور/خروج) هنا فقط — أُزيلت من تذييل السايدبار فلا تتكرر في DOM.
 * لا ألوان مباشرة: Tokens دلالية فقط.
 */
export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_OPEN_EVENT));
}

function PlaceholderAction({ label, icon: Icon, testId }: { label: string; icon: typeof Bell; testId: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={-1} className="inline-flex">
          <Button type="button" variant="ghost" size="icon" className="h-10 w-10 text-muted-foreground" aria-disabled="true" disabled aria-label={`${label} — غير متاح حاليًا`} data-testid={testId}>
            <Icon className="h-5 w-5" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label} — غير متاح حاليًا</TooltipContent>
    </Tooltip>
  );
}

export function TopBarActions({
  isMobile, isAdmin, permissions, userName, roleLabel, lowStockCount, onGoInventory, onLogout,
}: {
  isMobile: boolean; isAdmin: boolean; permissions: string[]; userName: string; roleLabel: string;
  lowStockCount: number; onGoInventory: () => void; onLogout: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 sm:gap-2" data-testid="topbar-actions">
      {isMobile ? <CreateMenu isAdmin={isAdmin} permissions={permissions} compact /> : null}
      {lowStockCount > 0 && (
        <Button type="button" variant="ghost" size="sm" onClick={onGoInventory} className="h-10 gap-1 text-destructive hover:text-destructive" data-testid="low-stock-indicator">
          <AlertTriangle className="h-4 w-4" />
          <span className="hidden sm:inline">{lowStockCount} منتج ينفد</span>
          <span className="sm:hidden">{lowStockCount}</span>
        </Button>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="h-10 w-10" onClick={openCommandPalette} aria-label="بحث (⌘K)" data-testid="topbar-search">
            <Search className="h-5 w-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>بحث — ⌘K / Ctrl+K</TooltipContent>
      </Tooltip>
      {!isMobile && (
        <>
          <PlaceholderAction label="تخصيص العرض" icon={SlidersHorizontal} testId="topbar-display-prefs" />
          <PlaceholderAction label="المساعدة" icon={CircleHelp} testId="topbar-help" />
          <PlaceholderAction label="الإشعارات" icon={Bell} testId="topbar-notifications" />
        </>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="flex h-10 items-center gap-2 rounded-md px-1.5 hover:bg-muted focus-visible:outline-none" aria-label="قائمة المستخدم" data-testid="user-menu">
            <Avatar className="h-8 w-8 border border-border">
              <AvatarFallback className="bg-accent text-xs font-bold text-accent-foreground">{userName.charAt(0).toUpperCase() || "U"}</AvatarFallback>
            </Avatar>
            {!isMobile && (
              <span className="hidden min-w-0 text-start md:block">
                <span className="block max-w-[10rem] truncate text-sm font-medium text-foreground">{userName || "—"}</span>
                <span className="block text-xs text-muted-foreground">{roleLabel}</span>
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel className="truncate">{userName || "—"} · {roleLabel}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onLogout} className="min-h-11 cursor-pointer text-destructive focus:text-destructive" data-testid="user-logout">
            <LogOut className="h-4 w-4" />
            <span>تسجيل الخروج</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
