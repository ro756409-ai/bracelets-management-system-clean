import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import manifest from "../../../public/brand/icons-3d.json";

/**
 * أيقونات الأقسام الكبيرة (المرحلة 6) — Slots لحزمة الأيقونات ثلاثية الأبعاد (سيراميك محايد بلمسة نحاسية،
 * نفس الزاوية والإضاءة، خلفية شفافة، بلا نصوص). **لم تُنتَج بعد**: إنتاج 3D بالجودة المطلوبة غير ممكن داخل
 * أدوات التنفيذ، فالـmanifest يحمل الثمانية بحالة `placeholder` وهذا المكوّن يرسم البديل الحالي (أيقونة
 * lucide على بلاطة accent) حتى تصل الملفات. لا SVG «مزيف» يُوصف بأنه 3D.
 * الأيقونة زخرفية دائمًا (`aria-hidden`) مع اسم مكتوب بجوارها؛ أيقونات الوظائف الصغيرة تبقى lucide.
 */
export type SectionIconId = "orders" | "inventory" | "accounts" | "shipping" | "employees" | "reports" | "integrations" | "settings";
export type SectionIconSize = "md" | "lg" | "xl";

export type SectionIconAsset = { id: SectionIconId; nameAr: string; status: "placeholder" | "ready"; file?: string; fileDark?: string; width?: number; height?: number };
export const SECTION_ICONS = (manifest as { icons: SectionIconAsset[] }).icons;
const BY_ID = Object.fromEntries(SECTION_ICONS.map(i => [i.id, i])) as Record<SectionIconId, SectionIconAsset | undefined>;
export const SECTION_ICON_PX: Record<SectionIconSize, number> = { md: 40, lg: 56, xl: 80 };
export const SECTION_ICON_BASE_PATH = "/brand/icons-3d/";

export function SectionIcon({ section, fallback: Fallback, size = "md", className }: { section: SectionIconId; fallback: LucideIcon; size?: SectionIconSize; className?: string }) {
  const asset = BY_ID[section];
  const px = SECTION_ICON_PX[size];
  if (asset?.status === "ready" && asset.file) {
    return (
      <span className={cn("inline-flex shrink-0 items-center justify-center", className)} style={{ width: px, height: px }} aria-hidden="true" data-testid={`section-icon-${section}`} data-status="ready">
        <img src={SECTION_ICON_BASE_PATH + asset.file} width={px} height={px} alt="" loading="lazy" decoding="async" draggable={false} className={cn("object-contain", asset.fileDark && "dark:hidden")} />
        {asset.fileDark && <img src={SECTION_ICON_BASE_PATH + asset.fileDark} width={px} height={px} alt="" loading="lazy" decoding="async" draggable={false} className="hidden object-contain dark:inline-block" />}
      </span>
    );
  }
  // البديل الحالي: بلاطة accent + أيقونة lucide — نفس الأبعاد الثابتة للـslot
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-[var(--radius-brand-lg)] bg-accent text-accent-foreground ring-1 ring-primary/15", className)}
      style={{ width: px, height: px }}
      aria-hidden="true"
      data-testid={`section-icon-${section}`}
      data-status="placeholder"
    >
      <Fallback style={{ width: px * 0.5, height: px * 0.5 }} />
    </span>
  );
}
