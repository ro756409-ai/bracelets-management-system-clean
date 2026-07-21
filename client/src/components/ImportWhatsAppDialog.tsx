import { useState, useRef, useCallback } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Upload, FileSpreadsheet, CheckCircle, XCircle, AlertTriangle,
  ChevronDown, ChevronUp, X, MessageCircle
} from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";

type PreviewRow = {
  rowIndex: number;
  externalId: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  governorate: string;
  productName: string;
  quantity: number;
  totalAmount: string;
  source: string;
  notes?: string;
};

type ImportResult = {
  imported: number;
  skipped: number;
  errors: string[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
};

export default function ImportWhatsAppDialog({ open, onClose, onSuccess }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewRow[] | null>(null);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [step, setStep] = useState<"upload" | "preview" | "done">("upload");

  const reset = () => {
    setFile(null);
    setPreviewData(null);
    setPreviewErrors([]);
    setShowErrors(false);
    setResult(null);
    setStep("upload");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const handleFile = async (f: File) => {
    setFile(f);
    setLoading(true);
    setPreviewData(null);
    setPreviewErrors([]);
    try {
      const formData = new FormData();
      formData.append("file", f);
      const res = await fetch("/api/import/whatsapp/preview", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطأ في قراءة الملف");
      setPreviewData(data.preview);
      setPreviewErrors(data.errors || []);
      setStep("preview");
    } catch (err: any) {
      toast.error(err.message || "خطأ في قراءة الملف");
    } finally {
      setLoading(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, []);

  const { currentBusinessIds } = useBusinessContext();

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (currentBusinessIds && currentBusinessIds.length === 1) {
        formData.append("businessId", String(currentBusinessIds[0]));
      }
      const res = await fetch("/api/import/whatsapp/execute", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطأ في الاستيراد");
      setResult(data);
      setStep("done");
      if (data.imported > 0) {
        onSuccess();
      }
    } catch (err: any) {
      toast.error(err.message || "خطأ في الاستيراد");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5 text-green-500" />
            استيراد أوردرات من جروب واتساب
          </DialogTitle>
        </DialogHeader>

        {/* Step: Upload */}
        {step === "upload" && (
          <div className="space-y-4">
            {/* Format Info */}
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-sm">
              <p className="font-semibold text-green-800 mb-2">صيغة ملف الواتساب المدعومة</p>
              <p className="text-green-700 text-xs mb-2">
                كل أوردر عبارة عن بلوك نصي في خلية واحدة يحتوي على:
              </p>
              <div className="bg-green-100 rounded-lg p-3 text-xs text-green-800 font-mono leading-relaxed" dir="rtl">
                بيدج: Nova &nbsp;&nbsp;&nbsp; التاريخ: 21/4<br />
                الاسم : اسم العميل<br />
                العنوان : المحافظة / العنوان<br />
                رقم الفون(1): 01XXXXXXXXX<br />
                نوع المنتج : اسم المنتج &nbsp; عدد القطع: N<br />
                السعر: XXX &nbsp; الشحن: XX &nbsp; الاجمالي: XXX
              </div>
              <p className="text-green-600 text-xs mt-2">
                ✓ سيتم تعليم هذه الأوردرات تلقائياً كـ <strong>أوردرات فيسبوك</strong> (source = whatsapp)
              </p>
            </div>

            {/* Drop Zone */}
            <div
              className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all ${
                isDragging
                  ? "border-green-500 bg-green-50"
                  : "border-border hover:border-green-400 hover:bg-muted/30"
              }`}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
              />
              {loading ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-10 h-10 border-4 border-green-500 border-t-transparent rounded-full animate-spin" />
                  <p className="text-muted-foreground text-sm">جاري قراءة الملف...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Upload className="h-10 w-10 text-muted-foreground" />
                  <div>
                    <p className="font-semibold text-foreground">اسحب ملف الواتساب هنا أو اضغط للاختيار</p>
                    <p className="text-sm text-muted-foreground mt-1">يدعم ملفات .xlsx و .xls</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Step: Preview */}
        {step === "preview" && previewData && (
          <div className="space-y-4">
            {/* Summary */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2 flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span className="text-sm font-semibold text-green-700">
                  {previewData.length} أوردر واتساب جاهز للاستيراد
                </span>
              </div>
              <Badge className="bg-green-100 text-green-800 border-0">
                <MessageCircle className="h-3 w-3 ml-1" />
                أوردرات فيسبوك
              </Badge>
              {previewErrors.length > 0 && (
                <div
                  className="bg-yellow-50 border border-yellow-200 rounded-lg px-4 py-2 flex items-center gap-2 cursor-pointer"
                  onClick={() => setShowErrors(!showErrors)}
                >
                  <AlertTriangle className="h-4 w-4 text-yellow-600" />
                  <span className="text-sm font-semibold text-yellow-700">
                    {previewErrors.length} صف به مشكلة
                  </span>
                  {showErrors ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                </div>
              )}
              <Button variant="ghost" size="sm" onClick={reset} className="mr-auto">
                <X className="h-4 w-4 ml-1" />
                تغيير الملف
              </Button>
            </div>

            {/* Errors List */}
            {showErrors && previewErrors.length > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 max-h-32 overflow-y-auto">
                {previewErrors.map((e, i) => (
                  <p key={i} className="text-xs text-yellow-800">{e}</p>
                ))}
              </div>
            )}

            {/* Preview Table */}
            <div className="border rounded-xl overflow-hidden">
              <div className="overflow-x-auto max-h-72">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                    <tr>
                      <th className="p-2 text-right font-semibold text-muted-foreground">#</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">الاسم</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">الهاتف</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">المحافظة</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">المنتج</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">الكمية</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">الإجمالي</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">البيدج</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.map((row, i) => (
                      <tr key={i} className="border-t hover:bg-muted/30">
                        <td className="p-2 text-muted-foreground">{row.rowIndex}</td>
                        <td className="p-2 font-medium text-foreground">{row.customerName}</td>
                        <td className="p-2 text-muted-foreground" dir="ltr">{row.customerPhone}</td>
                        <td className="p-2">
                          <Badge className="bg-blue-50 text-blue-700 border-0 text-xs">
                            {row.governorate}
                          </Badge>
                        </td>
                        <td className="p-2 text-foreground max-w-32 truncate" title={row.productName}>
                          {row.productName}
                        </td>
                        <td className="p-2 text-center text-foreground">{row.quantity}</td>
                        <td className="p-2 font-semibold text-foreground">
                          {Number(row.totalAmount).toLocaleString('ar-EG')} ج.م
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">
                          {row.notes?.replace("بيدج: ", "") || "-"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* Step: Done */}
        {step === "done" && result && (
          <div className="space-y-4 py-4">
            <div className="text-center">
              {result.imported > 0 ? (
                <CheckCircle className="h-16 w-16 text-green-500 mx-auto mb-4" />
              ) : (
                <XCircle className="h-16 w-16 text-destructive mx-auto mb-4" />
              )}
              <h3 className="text-xl font-bold text-foreground mb-2">
                {result.imported > 0 ? "تم الاستيراد بنجاح!" : "لم يتم استيراد أي أوردر"}
              </h3>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-green-50 border border-green-200 rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-green-700">{result.imported}</p>
                <p className="text-sm text-green-600 mt-1">أوردر تم استيراده</p>
                <Badge className="mt-2 bg-green-100 text-green-800 border-0 text-xs">
                  <MessageCircle className="h-3 w-3 ml-1" />
                  أوردرات فيسبوك
                </Badge>
              </div>
              <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-yellow-700">{result.skipped}</p>
                <p className="text-sm text-yellow-600 mt-1">أوردر تم تخطيه</p>
              </div>
            </div>
            {result.errors.length > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 max-h-40 overflow-y-auto">
                <p className="text-xs font-semibold text-yellow-800 mb-2">تفاصيل المشاكل:</p>
                {result.errors.map((e, i) => (
                  <p key={i} className="text-xs text-yellow-700">{e}</p>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === "upload" && (
            <Button variant="outline" onClick={handleClose}>إلغاء</Button>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={handleClose} disabled={loading}>إلغاء</Button>
              <Button
                onClick={handleImport}
                disabled={loading || !previewData || previewData.length === 0}
                className="bg-green-600 hover:bg-green-700 text-white"
              >
                {loading ? (
                  <div className="flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    جاري الاستيراد...
                  </div>
                ) : (
                  <>
                    <MessageCircle className="h-4 w-4 ml-2" />
                    استيراد {previewData?.length} أوردر واتساب
                  </>
                )}
              </Button>
            </>
          )}
          {step === "done" && (
            <Button onClick={handleClose} className="bg-green-600 hover:bg-green-700 text-white">
              إغلاق
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
