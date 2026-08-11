import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EvidenceUpload } from "@/components/EvidenceUpload";
import { DEFAULT_TREASURY_LABEL } from "@/components/accounting/PaymentSource";
import { Receipt } from "lucide-react";

/**
 * مصروف جديد — درج سريع.
 *
 * دورة حياة المصروف الكاملة أربع خطوات: مسودة ← إرسال ← اعتماد ← دفع. الأربعة موجودين
 * لسبب، وموجودين لسه تحت — بس التاجر اللي دفع ٢٠٠ جنيه بنزين مش هيمشي في أربع شاشات
 * عشان يسجّلها. وأول ما المسار يتقل كده، المصروف مايتسجّلش أصلاً، وده أسوأ من إنه
 * يتسجّل ببساطة.
 *
 * **مفيش مسار دفع جديد هنا.** الدرج بينادي `expenseRecordSimple` — نفس الدالة اللي
 * بتمشي الأربع خطوات بالترتيب وبتعدّي على جسر الخزنة. `payNow` هو الفرق الوحيد بين
 * «مستحق» و«مدفوع».
 */
export function ExpenseDrawer({
  businessId,
  open,
  onClose,
  onSaved,
}: {
  businessId: number;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const utils = trpc.useUtils();
  const categories = trpc.accounting.expenseCategories.useQuery(undefined, {
    enabled: open,
  });

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [attachment, setAttachment] = useState("");

  const record = trpc.accountingV2.expenseRecordSimple.useMutation({
    onSuccess: async (_result, variables) => {
      toast.success(
        variables.payNow
          ? `اتسجّل واتدفع — الخزنة نقصت ${amount}`
          : "اتسجّل كمستحق — تدفعه بعدين"
      );
      setAmount("");
      setDescription("");
      setAttachment("");
      onClose();
      await Promise.all([
        utils.accounting.controlCenter.invalidate(),
        utils.accounting.treasuryHistory.invalidate(),
        utils.accounting.dashboard.invalidate(),
      ]);
      onSaved?.();
    },
    onError: error => toast.error(error.message),
  });

  if (!open) return null;

  const submit = (payNow: boolean) => {
    const value = Number(amount);
    if (!(value > 0)) return toast.error("المبلغ لازم يكون أكبر من صفر");
    if (!description.trim()) return toast.error("اكتب المصروف بيخص إيه");
    record.mutate({
      businessId,
      amount: String(value),
      expenseDate: date,
      description: description.trim(),
      categoryId: categoryId ? Number(categoryId) : undefined,
      attachmentUrl: attachment.trim() || undefined,
      payNow,
    });
  };

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="my-8 w-full max-w-md rounded-lg border bg-card p-4 shadow-lg"
        onClick={event => event.stopPropagation()}
      >
        <h3 className="mb-4 flex items-center gap-2 font-bold">
          <Receipt className="h-5 w-5 text-rose-600" />
          مصروف جديد
        </h3>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>التاريخ *</Label>
              <Input
                className="mt-1"
                type="date"
                value={date}
                onChange={e => setDate(e.target.value)}
              />
            </div>
            <div>
              <Label>المبلغ *</Label>
              <Input
                className="mt-1"
                dir="ltr"
                inputMode="decimal"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </div>
          </div>

          <div>
            <Label>التصنيف</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="اختياري" />
              </SelectTrigger>
              <SelectContent>
                {(categories.data ?? [])
                  .filter((row: any) => row.isActive)
                  .map((row: any) => (
                    <SelectItem key={row.id} value={String(row.id)}>
                      {row.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>المصروف بيخص إيه *</Label>
            <Textarea
              className="mt-1"
              rows={2}
              placeholder="بنزين، تغليف، صيانة..."
              value={description}
              onChange={e => setDescription(e.target.value)}
            />
          </div>

          <EvidenceUpload
            label="صورة الفاتورة (اختياري)"
            value={attachment}
            onChange={setAttachment}
          />
        </div>

        {/*
          الإجراء الأساسي هو «سجّل وادفع» — ده اللي بيحصل كل يوم. «سجّل بس» أهدى
          لأنها الحالة الأقل.
        */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button
            variant="outline"
            disabled={record.isPending}
            onClick={() => submit(false)}
          >
            سجّل بس (مستحق)
          </Button>
          <Button disabled={record.isPending} onClick={() => submit(true)}>
            {record.isPending ? "..." : "سجّل وادفع"}
          </Button>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          «سجّل وادفع» بيخصم من «{DEFAULT_TREASURY_LABEL}» مرة واحدة.
        </p>
      </div>
    </div>
  );
}

/** زرار «+ مصروف جديد» ومعاه درجه — عشان أي شاشة تستخدمه بسطر واحد. */
export function NewExpenseButton({
  businessId,
  onSaved,
}: {
  businessId: number;
  onSaved?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        + مصروف جديد
      </Button>
      <ExpenseDrawer
        businessId={businessId}
        open={open}
        onClose={() => setOpen(false)}
        onSaved={onSaved}
      />
    </>
  );
}
