import { useRef, useState } from "react";
import { FileCheck2, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function EvidenceUpload({
  value,
  onChange,
  label = "مستند الإثبات",
}: {
  value: string;
  onChange: (url: string) => void;
  label?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      const response = await fetch("/api/evidence/upload", {
        method: "POST",
        body,
        credentials: "include",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Upload failed");
      onChange(result.url);
      toast.success("تم رفع مستند الإثبات");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تعذر رفع الملف");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };
  return (
    <div className="space-y-1">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex min-h-10 items-center gap-2 rounded-md border bg-background p-1.5">
        <input
          ref={inputRef}
          className="hidden"
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          onChange={event =>
            event.target.files?.[0] && upload(event.target.files[0])
          }
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          <UploadCloud className="ml-2 h-4 w-4" />
          {uploading ? "جاري الرفع..." : "اختيار ملف"}
        </Button>
        {value ? (
          <a
            className="flex min-w-0 items-center gap-1 text-xs text-emerald-700"
            href={value}
            target="_blank"
            rel="noreferrer"
          >
            <FileCheck2 className="h-4 w-4 shrink-0" />
            <span className="truncate">تم إرفاق المستند</span>
          </a>
        ) : (
          <span className="text-xs text-muted-foreground">
            PDF أو صورة، بحد أقصى 10MB
          </span>
        )}
      </div>
    </div>
  );
}
