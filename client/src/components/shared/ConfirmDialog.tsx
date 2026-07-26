import { useState, type ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Say exactly what will happen, including how many records are affected. */
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `destructive` for anything that deletes or cannot be undone. */
  tone?: "default" | "destructive";
  /**
   * Requires the user to type this exact text before confirming. Reserve it for the
   * genuinely irreversible — asking for it routinely trains people to type past it.
   */
  requireTypedConfirmation?: string;
  onConfirm: () => void | Promise<void>;
  /** Controlled pending state; the dialog also guards against double-submit itself. */
  pending?: boolean;
};

/**
 * The one confirmation dialog. Destructive actions were scattered across pages, some with
 * a bespoke dialog, some with `window.confirm`, and several with no confirmation at all.
 *
 * Submit is disabled while the action runs, so a slow request cannot be fired twice by an
 * impatient double-click.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "تأكيد",
  cancelLabel = "إلغاء",
  tone = "default",
  requireTypedConfirmation,
  onConfirm,
  pending = false,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);

  const isPending = pending || busy;
  const typedOk = !requireTypedConfirmation || typed.trim() === requireTypedConfirmation;

  const handleConfirm = async () => {
    if (isPending || !typedOk) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Never let a click-outside cancel an action that is already running.
        if (isPending) return;
        if (!next) setTyped("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-[480px]" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {tone === "destructive" && (
              <AlertTriangle className="h-5 w-5 shrink-0 text-destructive" />
            )}
            {title}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground">{description}</div>
          </DialogDescription>
        </DialogHeader>

        {requireTypedConfirmation && (
          <div className="space-y-1.5">
            <Label className="text-sm">
              اكتب «{requireTypedConfirmation}» للتأكيد
            </Label>
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              className="h-10"
            />
          </div>
        )}

        <DialogFooter className="flex-row gap-2 sm:gap-2">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "destructive" ? "destructive" : "default"}
            className="flex-1 gap-1"
            onClick={handleConfirm}
            disabled={isPending || !typedOk}
          >
            {isPending && <RefreshCw className="h-4 w-4 animate-spin" />}
            {isPending ? "جاري التنفيذ…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
