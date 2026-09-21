import { useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Upload, Trash2, RefreshCw } from "lucide-react";
import { BusinessAvatar } from "@/components/BusinessAvatar";

/**
 * رفع/تغيير/حذف لوجو النشاط — للمالك/الأدمن (الإجراء على السيرفر adminProcedure + نطاق).
 * الصورة بتتبعت كملف لـ`/api/branding/upload` (تخزين الملفات الموجود، مش Base64 في القاعدة)،
 * والمرجع الراجع بيتربط بالنشاط عبر `businesses.setLogo`.
 */
export function BusinessLogoField({ businessId, name, logoUrl, onChanged }: {
  businessId: number;
  name: string;
  logoUrl: string | null;
  onChanged?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const utils = trpc.useUtils();
  const setLogo = trpc.businesses.setLogo.useMutation({
    onSuccess: () => {
      utils.businesses.list.invalidate();
      utils.businesses.activeList.invalidate();
      onChanged?.();
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
      const res = await fetch("/api/branding/upload", { method: "POST", body: fd, credentials: "include" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(body?.error ?? "تعذر رفع اللوجو"); return; }
      await setLogo.mutateAsync({ businessId, logoUrl: body.url });
      toast.success("تم تحديث اللوجو");
    } catch {
      toast.error("تعذر رفع اللوجو");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const busy = uploading || setLogo.isPending;
  return (
    <div>
      <Label>لوجو النشاط</Label>
      <div className="mt-2 flex items-center gap-3">
        <BusinessAvatar name={name} logoUrl={logoUrl} className="h-14 w-14" textClassName="text-xl" />
        <div className="flex flex-wrap gap-2">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={e => pick(e.target.files?.[0])} data-testid="logo-file" />
          <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={busy} data-testid="logo-upload">
            {busy ? <RefreshCw className="h-4 w-4 ml-1 animate-spin" /> : <Upload className="h-4 w-4 ml-1" />}
            {logoUrl ? "تغيير اللوجو" : "رفع لوجو"}
          </Button>
          {logoUrl && (
            <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setLogo.mutate({ businessId, logoUrl: null })} disabled={busy} data-testid="logo-delete">
              <Trash2 className="h-4 w-4 ml-1" /> حذف
            </Button>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">PNG / JPEG / WebP حتى 2MB. بدون لوجو يظهر أول حرف من اسم النشاط.</p>
    </div>
  );
}
