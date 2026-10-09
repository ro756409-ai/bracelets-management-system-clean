import type { MouseEvent } from "react";
import type { VariantProps } from "class-variance-authority";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildWhatsAppUrl } from "@/lib/whatsapp";
import { PartnerLogo } from "@/components/brand/PartnerLogo";

/** الشعار الرسمي (Glyph الأخضر من Brand Resource Center) — ملف محلي عبر PartnerLogo، زخرفي لأن
 *  الزر يحمل الاسم/العنوان «واتساب»؛ ولو غاب الملف يظهر البديل النصي بدل أيقونة مكسورة. */

export type WhatsAppButtonProps = {
  /** Raw phone value as stored on the order — normalized internally. */
  phone: string | null | undefined;
  /** Optional pre-filled message text for the chat. */
  message?: string;
  /** Hides the text label, showing only the glyph — for dense action columns. */
  iconOnly?: boolean;
  label?: string;
  className?: string;
} & Pick<VariantProps<typeof buttonVariants>, "variant" | "size">;

/**
 * "Message this customer on WhatsApp" — reuses the existing phone normalizer (via
 * lib/whatsapp.ts) so it agrees with every other place in the app that reads a phone
 * number. Disabled (not hidden) when the stored number isn't a valid Egyptian mobile,
 * so the reason ("لا يوجد رقم واتساب صالح") is visible rather than the action just
 * disappearing. Opens wa.me in a new tab; never navigates the current page away.
 */
export function WhatsAppButton({
  phone,
  message,
  iconOnly = false,
  label = "واتساب",
  variant = "ghost",
  size,
  className,
}: WhatsAppButtonProps) {
  const url = buildWhatsAppUrl(phone, message);

  const handleClick = (e: MouseEvent) => {
    // Row/card headers this button sits inside often toggle expand/select on click —
    // opening WhatsApp should never also trigger that.
    e.stopPropagation();
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <Button data-readonly-safe
      type="button"
      variant={variant}
      size={size ?? (iconOnly ? "icon-sm" : "sm")}
      disabled={!url}
      onClick={handleClick}
      title={url ? "تواصل عبر واتساب" : "لا يوجد رقم واتساب صالح"}
      className={cn(
        !iconOnly && "gap-1.5",
        url && "text-[var(--success)] hover:bg-[var(--success)]/10 hover:text-[var(--success)]",
        className
      )}
    >
      <PartnerLogo partner="whatsapp" size="xs" decorative eager className="!h-4" />
      {!iconOnly && label}
    </Button>
  );
}
