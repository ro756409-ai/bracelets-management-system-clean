import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useCancelReasonOptions } from "@/hooks/useCancelReasonOptions";

/**
 * نوافذ إجراءات الأوردر لصفحة التفاصيل (المرحلة 7B) — **نفس قواعد صفحة الأوردرات**:
 *   • الإلغاء: السبب إلزامي (من إعدادات النشاط `cancellation_reason`) + ملاحظات اختيارية.
 *   • التأجيل: تاريخ المتابعة إلزامي (≥ اليوم) + ملاحظات.
 *   • «لم يرد»: عدد محاولات الاتصال اختياري (1–20).
 * عرض فقط: الصفحة تمرّر `pending` وتستقبل القيم وتستدعي الـmutation؛ الأزرار تتعطّل أثناء الطلب.
 */
export function CancelOrderDialog({ open, onOpenChange, pending, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; pending: boolean; onConfirm: (v: { cancelReason: string; notes?: string }) => void }) {
  const cancelReasonOptions = useCancelReasonOptions().options;
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  return (
    <Dialog open={open} onOpenChange={o => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="max-w-md" data-testid="cancel-order-dialog">
        <DialogHeader>
          <DialogTitle>إلغاء الأوردر</DialogTitle>
          <DialogDescription>السبب إلزامي — يُسجَّل على الأوردر ويظهر في التقارير.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="cancel-reason">سبب الإلغاء <span className="text-destructive">*</span></Label>
            <Select value={reason} onValueChange={setReason} disabled={pending}>
              <SelectTrigger id="cancel-reason" className="mt-1 min-h-11 md:min-h-9" data-testid="cancel-reason"><SelectValue placeholder="اختر السبب" /></SelectTrigger>
              <SelectContent>{cancelReasonOptions.map(r => <SelectItem key={r.value} value={r.value} className="min-h-11 md:min-h-9">{r.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="cancel-notes">ملاحظات إضافية</Label>
            <Textarea id="cancel-notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="أي تفاصيل إضافية..." className="mt-1" rows={3} disabled={pending} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="min-h-11 md:min-h-9" onClick={() => onOpenChange(false)} disabled={pending}>رجوع</Button>
          <Button type="button" variant="destructive" className="min-h-11 md:min-h-9" disabled={!reason || pending} onClick={() => onConfirm({ cancelReason: reason, notes: notes || undefined })} data-testid="cancel-confirm">
            {pending ? "جارٍ الإلغاء…" : "تأكيد الإلغاء"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PostponeOrderDialog({ open, onOpenChange, pending, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; pending: boolean; onConfirm: (v: { postponedTo: Date; notes?: string }) => void }) {
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const min = new Date().toISOString().split("T")[0];
  return (
    <Dialog open={open} onOpenChange={o => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="max-w-md" data-testid="postpone-order-dialog">
        <DialogHeader>
          <DialogTitle>تأجيل الأوردر</DialogTitle>
          <DialogDescription>حدّد تاريخ المتابعة — إلزامي.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label htmlFor="postpone-date">تاريخ المتابعة <span className="text-destructive">*</span></Label>
            <Input id="postpone-date" type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-1 min-h-11 md:min-h-9" min={min} disabled={pending} data-testid="postpone-date" />
          </div>
          <div>
            <Label htmlFor="postpone-notes">ملاحظات</Label>
            <Textarea id="postpone-notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="سبب التأجيل..." className="mt-1" rows={3} disabled={pending} />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="min-h-11 md:min-h-9" onClick={() => onOpenChange(false)} disabled={pending}>رجوع</Button>
          <Button type="button" className="min-h-11 md:min-h-9" disabled={!date || pending} onClick={() => onConfirm({ postponedTo: new Date(date), notes: notes || undefined })} data-testid="postpone-confirm">
            {pending ? "جارٍ التأجيل…" : "تأكيد التأجيل"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NoAnswerDialog({ open, onOpenChange, pending, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; pending: boolean; onConfirm: (v: { callAttempts?: number }) => void }) {
  const [attempts, setAttempts] = useState("");
  return (
    <Dialog open={open} onOpenChange={o => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="max-w-sm" data-testid="no-answer-dialog">
        <DialogHeader>
          <DialogTitle>تسجيل «لم يرد»</DialogTitle>
          <DialogDescription>محاولات الاتصال فقط — لا تُحسب محاولات توصيل.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Label htmlFor="no-answer-attempts">كم مرة اتصلت بالعميل؟</Label>
          <div className="grid grid-cols-4 gap-2" role="group" aria-label="عدد محاولات الاتصال">
            {[1, 2, 3, 4].map(n => (
              <Button key={n} type="button" variant={attempts === String(n) ? "default" : "outline"} className="min-h-11" onClick={() => setAttempts(String(n))} disabled={pending} aria-pressed={attempts === String(n)}>{n}</Button>
            ))}
          </div>
          <Input id="no-answer-attempts" type="number" min={1} max={20} placeholder="أو رقم مختلف..." value={attempts} onChange={e => setAttempts(e.target.value)} className="min-h-11 md:min-h-9" disabled={pending} data-testid="no-answer-attempts" />
        </div>
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" className="min-h-11 md:min-h-9" onClick={() => onOpenChange(false)} disabled={pending}>رجوع</Button>
          <Button type="button" className="min-h-11 md:min-h-9" disabled={pending} onClick={() => onConfirm({ callAttempts: attempts ? Number(attempts) : undefined })} data-testid="no-answer-confirm">
            {pending ? "جارٍ التسجيل…" : "تأكيد «لم يرد»"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
