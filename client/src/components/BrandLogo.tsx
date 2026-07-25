import { BrandMark } from "./BrandMark";

/**
 * Reusable Matjarak brand logo. Composes BrandMark (the icon) with optional
 * Arabic/English wordmarks. Renders the placeholder mark until final SVG/PNG
 * assets are placed per client/src/assets/brand/README.md — nothing else
 * needs to change when those files arrive, since every screen already
 * renders through this component (or BrandMark directly for icon-only spots).
 */

export type BrandLogoVariant = "icon" | "horizontal" | "vertical";
export type BrandLogoSize = "sm" | "md" | "lg" | "xl";
export type BrandLogoMode = "light" | "dark";

const ICON_SIZE_CLASSES: Record<BrandLogoSize, string> = {
  sm: "h-6 w-6",
  md: "h-8 w-8",
  lg: "h-10 w-10",
  xl: "h-16 w-16",
};

const ARABIC_TEXT_SIZE: Record<BrandLogoSize, string> = {
  sm: "text-sm",
  md: "text-base",
  lg: "text-lg",
  xl: "text-2xl",
};

const ENGLISH_TEXT_SIZE: Record<BrandLogoSize, string> = {
  sm: "text-[10px]",
  md: "text-xs",
  lg: "text-sm",
  xl: "text-base",
};

export interface BrandLogoProps {
  /** icon = mark only. horizontal = mark beside text. vertical = mark above text. */
  variant?: BrandLogoVariant;
  size?: BrandLogoSize;
  showArabicName?: boolean;
  showEnglishName?: boolean;
  /** Which surface this sits on — affects wordmark color (light text on dark surfaces). */
  mode?: BrandLogoMode;
  className?: string;
}

export function BrandLogo({
  variant = "horizontal",
  size = "md",
  showArabicName = true,
  showEnglishName = false,
  mode = "light",
  className = "",
}: BrandLogoProps) {
  const textColor = mode === "dark" ? "text-white" : "text-foreground";
  const subTextColor = mode === "dark" ? "text-white/60" : "text-muted-foreground";

  const wordmark =
    (showArabicName || showEnglishName) && variant !== "icon" ? (
      <div className={variant === "vertical" ? "text-center" : ""}>
        {showArabicName && (
          <p className={`font-bold leading-tight ${ARABIC_TEXT_SIZE[size]} ${textColor}`}>
            متجرك
          </p>
        )}
        {showEnglishName && (
          <p className={`font-medium tracking-wide ${ENGLISH_TEXT_SIZE[size]} ${subTextColor}`} dir="ltr">
            MATJARAK
          </p>
        )}
      </div>
    ) : null;

  if (variant === "icon" || !wordmark) {
    return <BrandMark className={`${ICON_SIZE_CLASSES[size]} ${className}`} />;
  }

  return (
    <div
      className={`flex items-center gap-2.5 ${variant === "vertical" ? "flex-col" : ""} ${className}`}
    >
      <BrandMark className={ICON_SIZE_CLASSES[size]} />
      {wordmark}
    </div>
  );
}
