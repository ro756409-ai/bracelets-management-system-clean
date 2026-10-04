import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Upload, RefreshCw, Trash2, Link2 } from "lucide-react";

/**
 * الصورة الافتراضية لشحنات البراند (بوسطة — «السماح بفتح الشحنة»).
 *
 * بوسطة تجلب الصورة من رابط عام، فالخياران: رفع ملف (يُقدَّم علنيًا من موقعنا) أو لصق
 * رابط https عام لصورة. المعاينة تظهر **قبل الحفظ**، والحفظ يؤثر على الشحنات الجديدة فقط.
 * الصورة لكل نشاط — لا تُستخدم لنشاط آخر.
 */
export function BostaPackageImageField({ businessId, current }: { businessId: number; current: { ref: string; publicUrl: string } | null }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null); // مرفوع ولم يُحفظ بعد
  const [linkInput, setLinkInput] = useState("");
  const utils = trpc.useUtils();
  const save = trpc.carrierAccounts.setDefaultPackageImage.useMutation({
    onSuccess: r => {
      toast.success(r.publicUrl ? "تم حفظ الصورة الافتراضية لشحنات البراند" : "تمت إزالة الصورة الافتراضية");
      setPendingUrl(null); setLinkInput("");
      utils.carrierAccounts.status.invalidate({ businessId });
    },
    onError: e => toast.error(e.message),
  });

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error("الصورة أكبر من 2MB"); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/carrier/package-image/upload", { method: "POST", body: fd, credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(body?.error ?? "تعذر رفع الصورة"); return; }
      setPendingUrl(body.url); // معاينة أولًا — الحفظ بزر مستقل
    } catch {
      toast.error("تعذر رفع الصورة");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const previewSrc = pendingUrl ?? (linkInput.trim() || null) ?? current?.publicUrl ?? null;
  const busy = uploading || save.isPending;
  const toSave = pendingUrl ?? (linkInput.trim() || null);

  return (
    <div className="space-y-2 border-t pt-3" data-testid="bosta-package-image">
      <Label className="text-xs">الصورة الافتراضية لشحنات البراند (تُرسل لبوسطة عند تفعيل «السماح بفتح الشحنة»)</Label>
      <div className="flex items-start gap-3">
        <div className="h-20 w-20 shrink-0 overflow-hidden rounded-md border bg-muted flex items-center justify-center text-[10px] text-muted-foreground">
          {previewSrc ? <img src={previewSrc} alt="معاينة صورة الشحنة" className="h-full w-full object-cover" data-testid="bosta-package-image-preview" /> : "لا صورة"}
        </div>
        <div className="flex-1 space-y-2">
          <div className="flex flex-wrap gap-2">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => pick(e.target.files?.[0])} data-testid="bosta-package-image-file" />
            <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="bosta-package-image-upload">
              {uploading ? <RefreshCw className="h-4 w-4 ml-1 animate-spin" /> : <Upload className="h-4 w-4 ml-1" />} رفع صورة
            </Button>
            {current && !toSave && (
              <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => save.mutate({ businessId, imageUrl: null })} disabled={busy}>
                <Trash2 className="h-4 w-4 ml-1" /> إزالة
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Input value={linkInput} onChange={e => { setLinkInput(e.target.value); setPendingUrl(null); }} placeholder="أو رابط https عام لصورة (png/jpg/webp)" dir="ltr" className="h-8 text-xs" data-testid="bosta-package-image-link" />
            <Button type="button" size="sm" onClick={() => toSave && save.mutate({ businessId, imageUrl: toSave })} disabled={!toSave || busy} data-testid="bosta-package-image-save">
              <Link2 className="h-4 w-4 ml-1" /> حفظ
            </Button>
          </div>
          {toSave && <p className="text-xs text-[var(--warning)]">معاينة — لم تُحفظ بعد. التغيير يؤثر على الشحنات الجديدة فقط.</p>}
          {!current && !toSave && (
            <p className="text-xs text-muted-foreground">بلا صورة افتراضية وبلا صور للمنتجات، الإرسال مع «فتح الشحنة» سيُرفض برسالة واضحة.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** معاينة الصور التي ستُرسل مع شحنة أوردر بعينه (المصدر: صورة المنتج أو صورة البراند) قبل الإرسال. */
export function BostaShipmentImagePreview({ orderId, allowToOpenPackage }: { orderId: number; allowToOpenPackage?: boolean }) {
  const q = trpc.orders.bostaShipmentPreview.useQuery({ orderId, allowToOpenPackage }, { enabled: orderId > 0 });
  if (q.isLoading) return <p className="text-xs text-muted-foreground">جارٍ تجهيز معاينة الصور…</p>;
  const d = q.data;
  if (!d) return null;
  if (!d.required) return <p className="text-xs text-muted-foreground" data-testid="bosta-preview-none">لن تُرسل صور (فتح الشحنة غير مفعّل).</p>;
  if (d.error) return <p className="text-xs rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive" data-testid="bosta-preview-error">{d.error}</p>;
  return (
    <div className="space-y-1" data-testid="bosta-preview-images">
      <p className="text-xs text-muted-foreground">الصور التي ستُرسل لبوسطة ({d.images.length} من 10 كحد أقصى):</p>
      {d.omitted > 0 && (
        <p className="text-xs text-[var(--warning)]" data-testid="bosta-preview-omitted">
          حد بوسطة 10 صور — {d.omitted} صورة أخرى لن تُرسل (تُؤخذ أول 10 بترتيب بنود الأوردر).
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {d.images.map(img => (
          <figure key={img.url} className="w-16">
            <img src={img.url} alt="" className="h-16 w-16 rounded-md border object-cover" />
            <figcaption className="mt-0.5 text-center text-[10px] text-muted-foreground">{img.source === "product" ? "صورة المنتج" : "صورة البراند"}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}
