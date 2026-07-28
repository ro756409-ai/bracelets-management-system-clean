import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

/**
 * Toasts inherit the brand surface tokens rather than sonner's defaults: the neutral-navy
 * dropdown shadow (the book forbids tinted or generic black elevation), the `md` corner radius
 * used by every other floating surface, and semantic colours that already mean something in
 * this product — so a green toast reads the same as a green badge.
 *
 * Placed bottom-left because the app is RTL: that is the far corner from the reading path and
 * from the sidebar, so a toast never covers the row or field that triggered it.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      dir="rtl"
      position="bottom-left"
      toastOptions={{
        classNames: {
          toast:
            "rounded-[var(--radius-brand-md)] border border-border shadow-[var(--shadow-dropdown)] font-sans",
          title: "type-body",
          description: "type-caption",
        },
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--popover)",
          "--success-text": "var(--success)",
          "--success-border": "color-mix(in oklab, var(--success) 30%, transparent)",
          "--error-bg": "var(--popover)",
          "--error-text": "var(--destructive)",
          "--error-border": "color-mix(in oklab, var(--destructive) 30%, transparent)",
          "--warning-bg": "var(--popover)",
          "--warning-text": "var(--warning)",
          "--warning-border": "color-mix(in oklab, var(--warning) 30%, transparent)",
          "--info-bg": "var(--popover)",
          "--info-text": "var(--info)",
          "--info-border": "color-mix(in oklab, var(--info) 30%, transparent)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
};

export { Toaster };
