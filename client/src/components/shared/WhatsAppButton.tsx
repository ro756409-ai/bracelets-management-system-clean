import type { MouseEvent } from "react";
import type { VariantProps } from "class-variance-authority";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { buildWhatsAppUrl } from "@/lib/whatsapp";

/** The WhatsApp glyph — no brand icon ships with lucide-react, so this is the one place
 *  the path data lives; other WhatsApp-adjacent UI (e.g. the import-source icon) has its
 *  own inline copy predating this component and is out of scope to touch here. */
function WhatsAppGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

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
    <Button
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
      <WhatsAppGlyph className="h-4 w-4 shrink-0" />
      {!iconOnly && label}
    </Button>
  );
}
