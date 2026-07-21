import { useState, useRef, useCallback } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Upload, FileSpreadsheet, CheckCircle, XCircle, AlertTriangle,
  ChevronDown, ChevronUp, X
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
  multiProduct: boolean;
  allProducts: string[];
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

export default function ImportExcelDialog({ open, onClose, onSuccess }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewData, setPreviewData] = useState<PreviewRow[] | null>(null);
  const [previewErrors, setPreviewErrors] = useState<string[]>([]);
  const [showErrors, setShowErrors] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [step, setStep] = useState<"upload" | "preview" | "done">("upload");
  const { currentBusinessIds, currentGroup, businesses } = useBusinessContext();

  const businessLabel = currentGroup?.name || "كل الأقسام";

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
      const res = await fetch("/api/import/preview", {
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

  const handleImport = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      if (currentBusinessIds && currentBusinessIds.length === 1) {
        formData.append("businessId", String(currentBusinessIds[0]));
      }
      const res = await fetch("/api/import/execute", {
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
            <FileSpreadsheet className="h-5 w-5 text-green-600" />
            استيراد أوردرات من Excel
          </DialogTitle>
        </DialogHeader>

        {/* Step: Upload */}
        {step === "upload" && (
          <div className="space-y-4">
            {/* Business Info */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-xl">
                🏢
              </div>
              <div>
                <p className="text-sm font-bold text-amber-800">
                  الأوردرات ستُسجَّل تحت: <Badge variant="outline" className="text-amber-700 border-amber-300">{businessLabel}</Badge>
                </p>
                <p className="text-xs text-amber-600 mt-0.5">
                  {"لتغيير القسم، غيّر الفلتر من أعلى الصفحة"}
                </p>
              </div>
            </div>

            {/* Format Info */}
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm">
              <p className="font-semibold text-blue-800 mb-2">الصيغة المدعومة (Easy Order)</p>
              <div className="grid grid-cols-2 gap-1 text-blue-700 text-xs">
                {[
                  ["FullName", "اسم العميل"],
                  ["Phone", "رقم الهاتف"],
                  ["City", "المحافظة"],
                  ["Address", "العنوان"],
                  ["Total Cost", "المبلغ الإجمالي"],
                  ["Product Name", "اسم المنتج"],
                  ["Quantity", "الكمية"],
                  ["Note", "ملاحظات (اختياري)"],
                ].map(([col, label]) => (
                  <div key={col} className="flex items-center gap-1">
                    <code className="bg-blue-100 px-1 rounded text-xs">{col}</code>
                    <span>{label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Drop Zone */}
            <div
              className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-all ${
                isDragging
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-muted/30"
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
                  <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                  <p className="text-muted-foreground text-sm">جاري قراءة الملف...</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <Upload className="h-10 w-10 text-muted-foreground" />
                  <div>
                    <p className="font-semibold text-foreground">اسحب الملف هنا أو اضغط للاختيار</p>
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
            {/* Business Badge */}
            <div className="flex items-center gap-2 rounded-lg px-4 py-2 border-2 border-amber-400 bg-amber-50 text-amber-800">
              <span className="text-lg">🏢</span>
              <div>
                <p className="text-sm font-bold">{businessLabel}</p>
                <p className="text-xs opacity-70">الأوردرات ستُسجَّل تحت هذا النشاط</p>
              </div>
            </div>

            {/* Summary */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2 flex items-center gap-2">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <span className="text-sm font-semibold text-green-700">
                  {previewData.length} أوردر جاهز للاستيراد
                </span>
              </div>
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
                      <th className="p-2 text-right font-semibold text-muted-foreground">رقم الأوردر</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">الاسم</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">الهاتف</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">المحافظة</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">المنتج</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">الكمية</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">المبلغ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.map((row, i) => (
                      <tr key={i} className="border-t hover:bg-muted/30">
                        <td className="p-2 text-muted-foreground">{row.rowIndex}</td>
                        <td className="p-2 font-mono text-xs text-foreground">{row.externalId || '-'}</td>
                        <td className="p-2 font-medium text-foreground">{row.customerName}</td>
                        <td className="p-2 text-muted-foreground" dir="ltr">{row.customerPhone}</td>
                        <td className="p-2">
                          <Badge className="bg-blue-50 text-blue-700 border-0 text-xs">
                            {row.governorate}
                          </Badge>
                        </td>
                        <td className="p-2 text-foreground max-w-32 truncate" title={row.productName}>
                          {row.productName}
                          {row.multiProduct && (
                            <Badge className="mr-1 bg-purple-50 text-purple-700 border-0 text-xs">
                              متعدد
                            </Badge>
                          )}
                        </td>
                        <td className="p-2 text-center text-foreground">{row.quantity}</td>
                        <td className="p-2 font-semibold text-foreground">
                          {Number(row.totalAmount).toLocaleString('ar-EG')} ج.م
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
              <p className="text-sm text-muted-foreground">
                تم الاستيراد تحت: <Badge variant="outline">{businessLabel}</Badge>
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-green-50 rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-green-700">{result.imported}</p>
                <p className="text-sm text-green-600 mt-1">أوردر تم استيراده</p>
              </div>
              <div className="bg-red-50 rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-red-700">{result.skipped}</p>
                <p className="text-sm text-red-600 mt-1">أوردر تم تخطيه</p>
              </div>
            </div>
            {result.errors.length > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 max-h-32 overflow-y-auto">
                <p className="text-xs font-semibold text-yellow-800 mb-1">تفاصيل:</p>
                {result.errors.slice(0, 20).map((e, i) => (
                  <p key={i} className="text-xs text-yellow-700">{e}</p>
                ))}
                {result.errors.length > 20 && (
                  <p className="text-xs text-yellow-600 mt-1">... و {result.errors.length - 20} أخرى</p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === "preview" && (
            <Button onClick={handleImport} disabled={loading || !previewData?.length}>
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin ml-2" />
                  جاري الاستيراد...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 ml-2" />
                  استيراد {previewData?.length} أوردر
                </>
              )}
            </Button>
          )}
          {step === "done" && (
            <Button onClick={handleClose}>إغلاق</Button>
          )}
          {step !== "done" && (
            <Button variant="outline" onClick={handleClose}>إلغاء</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
