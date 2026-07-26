import type { ReactNode } from "react";
import { HelpCircle } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Small "?" affordance for a label or icon whose meaning is not obvious on its own —
 * an abbreviation, an icon-only button, a status whose rule is not self-evident.
 * `TooltipProvider` is already mounted once at the app root (see App.tsx).
 */
export function InfoTooltip({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {children ?? (
          <button
            type="button"
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={text}
          >
            <HelpCircle className="h-3.5 w-3.5" />
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent side="top">{text}</TooltipContent>
    </Tooltip>
  );
}
