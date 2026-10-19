import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * حسم شحنة بوسطة غير مؤكدة — مراجعة بشرية موثّقة (السيرفر هو اللي بيفرض كل القواعد: الحالة، والنطاق، ومنع تكرار
 * رقم الشحنة، ومالك **غير مقدّم الطلب** للاعتماد، وتوثيق تحقق منظّم من لوحة بوسطة). مافيش هنا أي زر بيفتح إعادة الإرسال مباشرة.
 */
export function BostaResolutionPanel({ orderId, orderNumber, bostaStatus, onDone }: { orderId: number; orderNumber?: string; bostaStatus: string | null; onDone: () => void }) {
  const [shipmentId, setShipmentId] = useState("");
  const [tracking, setTracking] = useState("");
  const [evidence, setEvidence] = useState("");
  // B2: توثيق التحقق للاعتماد
  const [searchedAt, setSearchedAt] = useState("");
  const [searchQuery, setSearchQuery] = useState(orderNumber ?? "");
  const [noResults, setNoResults] = useState(false);
  const [screenshotUrl, setScreenshotUrl] = useState("");
  const done = (msg: string) => { toast.success(msg); setShipmentId(""); setTracking(""); setEvidence(""); onDone(); };
  const fail = (e: { message: string }) => toast.error(e.message);
  const link = trpc.orders.bostaLinkShipment.useMutation({ onSuccess: () => done("اتربطت الشحنة بالأوردر"), onError: fail });
  const request = trpc.orders.bostaRequestReset.useMutation({ onSuccess: () => done("اتسجّل طلب إعادة الإرسال — بانتظار اعتماد المالك"), onError: fail });
  const approve = trpc.orders.bostaApproveReset.useMutation({ onSuccess: () => done("اتعتمدت إعادة الإرسال"), onError: fail });
  const busy = link.isPending || request.isPending || approve.isPending;
  const evidenceOk = evidence.trim().length >= 10;
  const verificationOk = Boolean(searchedAt) && searchQuery.trim().length > 0 && noResults && /^https:\/\/\S{3,}$/.test(screenshotUrl.trim());
  const resetRequested = bostaStatus === "reset_requested";

  return (
    <section className="mt-4 space-y-3 rounded-[var(--radius-brand-md)] border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-3" data-testid="bosta-resolution" aria-labelledby="bosta-resolution-title">
      <h3 id="bosta-resolution-title" className="flex items-center gap-1.5 text-sm font-semibold">
        <AlertTriangle className="h-4 w-4 text-[var(--warning)]" aria-hidden="true" />
        {resetRequested ? "طلب إعادة إرسال بانتظار اعتماد مالك غير مقدّم الطلب" : "حالة الشحنة غير مؤكدة — راجع لوحة بوسطة قبل أي إجراء"}
      </h3>
      {!resetRequested && <div>
        <Label htmlFor="bosta-evidence">الدليل (مطلوب)</Label>
        <Textarea id="bosta-evidence" value={evidence} onChange={e => setEvidence(e.target.value)} rows={2}
          placeholder="مثال: بحثت في لوحة بوسطة بتاريخ … عن رقم المرجع … والنتيجة …" />
      </div>}
      {resetRequested && (
        <fieldset className="grid gap-2 md:grid-cols-2" data-testid="bosta-reset-verification">
          <legend className="mb-1 text-xs text-muted-foreground">توثيق التحقق من لوحة بوسطة (إلزامي — مقدّم الطلب مايقدرش يعتمد)</legend>
          <div>
            <Label htmlFor="bosta-searched-at">وقت البحث في لوحة بوسطة</Label>
            <Input id="bosta-searched-at" type="datetime-local" value={searchedAt} onChange={e => setSearchedAt(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="bosta-search-query">اتبحث بإيه (لازم يحتوي رقم الأوردر)</Label>
            <Input id="bosta-search-query" dir="ltr" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <Label htmlFor="bosta-screenshot">رابط صورة نتيجة البحث (https)</Label>
            <Input id="bosta-screenshot" dir="ltr" type="url" placeholder="https://" value={screenshotUrl} onChange={e => setScreenshotUrl(e.target.value)} />
          </div>
          <label className="flex min-h-11 items-center gap-2 text-sm md:col-span-2">
            <input type="checkbox" checked={noResults} onChange={e => setNoResults(e.target.checked)} />
            البحث مارجّعش أي شحنة للأوردر ده (لو فيه نتيجة: اربط الشحنة بدل إعادة الإرسال)
          </label>
        </fieldset>
      )}
      {!resetRequested && (
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <div>
            <Label htmlFor="bosta-shipment-id">رقم الشحنة من لوحة بوسطة</Label>
            <Input id="bosta-shipment-id" dir="ltr" value={shipmentId} onChange={e => setShipmentId(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="bosta-tracking">رقم التتبع (اختياري)</Label>
            <Input id="bosta-tracking" dir="ltr" value={tracking} onChange={e => setTracking(e.target.value)} />
          </div>
          <Button type="button" disabled={busy || !evidenceOk || shipmentId.trim().length < 4}
            onClick={() => link.mutate({ orderId, shipmentId: shipmentId.trim(), trackingNumber: tracking.trim() || undefined, evidence: evidence.trim() })}>
            ربط الشحنة
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!resetRequested ? (
          <Button type="button" variant="outline" disabled={busy || !evidenceOk} onClick={() => request.mutate({ orderId, evidence: evidence.trim() })}>
            طلب إعادة الإرسال (مفيش شحنة عند بوسطة)
          </Button>
        ) : (
          <Button type="button" disabled={busy || !verificationOk} onClick={() => approve.mutate({ orderId, verification: {
            method: "bosta_dashboard_search", searchedAt: new Date(searchedAt).toISOString(), searchQuery: searchQuery.trim(),
            resultCount: noResults ? 0 : 1, screenshotUrl: screenshotUrl.trim(),
          } })}>
            اعتماد إعادة الإرسال (مالك تاني)
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">الاعتماد لمالك غير مقدّم الطلب فقط، بتوثيق تحقق من لوحة بوسطة — مرور الوقت مابيغيّرش ده. كل خطوة (والرفض) بتتسجّل في سجل الأنشطة.</p>
    </section>
  );
}
