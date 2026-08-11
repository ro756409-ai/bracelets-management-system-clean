import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_TREASURY_LABEL } from "@/components/accounting/PaymentSource";
import { Banknote, Wallet } from "lucide-react";

/**
 * دفعة للورشة — درج صغير، مش فورم ثابت في الصفحة.
 *
 * الفورم اللي فاضل مفتوح طول الوقت بياخد نص الشاشة عشان حاجة بتحصل مرة أو مرتين في
 * الأسبوع، وبيدفع الجدول — اللي التاجر جاي عشانه — تحت الطيّة.
 *
 * **المصنع معروف من الصفحة.** الدرج مابيسألش عليه تاني؛ السؤال ده كان بيخلي حد يختار
 * مصنع غلط وهو واقف على كشف مصنع تاني.
 *
 * ومفيش مسار دفع جديد هنا: `suppliers.payment` هي نفسها اللي بتسجّل الحدث وبتخرج
 * الفلوس من الخزنة **مرة واحدة**، ومابتلمسش المصروفات ولا تكلفة البضاعة — التكلفة
 * اتسجّلت خلاص وقت الاستلام.
 */
export function SupplierPaymentDrawer({
  businessId,
  supplierKey,
  supplierName,
  open,
  onClose,
  onSaved,
}: {
  businessId: number;
  supplierKey: string;
  supplierName: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  const payment = trpc.suppliers.payment.useMutation({
    onSuccess: async () => {
      toast.success(`اتسجّلت الدفعة — ${supplierName}`);
      setAmount("");
      setReference("");
      setNotes("");
      onClose();
      await onSaved();
    },
    onError: error => toast.error(error.message),
  });

  if (!open) return null;

  const submit = () => {
    const value = Number(amount);
    if (!(value > 0)) return toast.error("المبلغ لازم يكون أكبر من صفر");
    payment.mutate({
      businessId,
      supplierKey,
      amount: value,
      paidAt: new Date(`${date}T12:00:00`),
      reference: reference.trim() || undefined,
      notes: notes.trim() || undefined,
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
        <h3 className="mb-1 flex items-center gap-2 font-bold">
          <Banknote className="h-5 w-5 text-[var(--success)]" />
          دفعة للورشة
        </h3>
        <p className="mb-4 text-xs text-muted-foreground">{supplierName}</p>

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

          {/*
            سطر معلومة مش قايمة اختيار.

            `suppliers.payment` على السيرفر بيخرج من الخزنة على طول ومابياخدش حساب
            محدد. قايمة اختيار هنا كانت هتخلي التاجر يختار خزنة والفلوس تخرج من
            غيرها — واختيار مالوش أثر أسوأ من مفيش اختيار.
          */}
          <div className="space-y-1">
            <Label>الفلوس هتخرج من</Label>
            <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <Wallet className="h-4 w-4 shrink-0 text-[var(--success)]" />
              <span>{DEFAULT_TREASURY_LABEL}</span>
            </div>
          </div>

          <div>
            <Label>رقم المرجع</Label>
            <Input
              className="mt-1"
              placeholder="اختياري — رقم التحويل أو الإيصال"
              value={reference}
              onChange={e => setReference(e.target.value)}
            />
          </div>

          <div>
            <Label>ملاحظة</Label>
            <Input
              className="mt-1"
              placeholder="اختياري"
              value={notes}
              onChange={e => setNotes(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <Button variant="outline" onClick={onClose}>
            إلغاء
          </Button>
          <Button disabled={payment.isPending} onClick={submit}>
            {payment.isPending ? "..." : "تسجيل الدفعة"}
          </Button>
        </div>
        <p className="mt-2 text-center text-xs text-muted-foreground">
          بتنقّص حساب الورشة وبتخرج من الخزنة — مرة واحدة. ومش مصروف تشغيلي.
        </p>
      </div>
    </div>
  );
}
