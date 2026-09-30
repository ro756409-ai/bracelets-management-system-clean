import { useState, useRef, useCallback, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Upload, FileSpreadsheet, CheckCircle, XCircle, AlertTriangle,
  ChevronDown, ChevronUp, X, Store
} from "lucide-react";
import { useBusinessContext } from "@/contexts/BusinessContext";

type RowStatus = "new" | "review" | "existing" | "rejected";
type PreviewRow = {
  rowIndex: number;
  idRaw: string;
  orderKey: string;
  customerName: string;
  phone: string;
  phoneValid: boolean;
  address: string;
  governorate: string;
  resolvedCity: string;
  productName: string;
  totalQuantity: number;
  totalAmount: number;
  multiProduct: boolean;
  status: RowStatus;
  reviewReasons: string[];
  rejectReasons: string[];
  items: { index: number; productName: string; quantity: number; match?: unknown }[];
};
type Summary = { new: number; review: number; existing: number; rejected: number };
type RowReport = { row: number; orderId: string; status: "imported" | "imported_review" | "already_existing" | "failed_matching" | "rejected"; reason?: string };

type ImportResult = {
  imported: number;
  imported_review?: number;
  already_existing?: number;
  failed_matching?: number;
  skipped?: number;
  errors: string[];
  reports?: RowReport[];
  summary?: Summary;
  error?: string;
};

const STATUS_LABEL: Record<RowStatus, string> = { new: "جديد", review: "يحتاج مراجعة", existing: "موجود مسبقًا", rejected: "مرفوض" };
const STATUS_CLASS: Record<RowStatus, string> = {
  new: "bg-green-50 text-green-700", review: "bg-yellow-50 text-yellow-800", existing: "bg-slate-100 text-slate-700", rejected: "bg-red-50 text-red-700",
};

/** تقرير CSV: رقم الصف، Order ID، الحالة، السبب — للتحميل. */
function buildReportCsv(reports: RowReport[]): string {
  const label: Record<RowReport["status"], string> = { imported: "تم الاستيراد", imported_review: "تم الاستيراد — يحتاج مراجعة", already_existing: "موجود مسبقًا", failed_matching: "فشل المطابقة", rejected: "مرفوض" };
  const esc = (v: string) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = ["\uFEFFرقم الصف,Order ID,الحالة,السبب", ...reports.map(r => [r.row, r.orderId, label[r.status], r.reason ?? ""].map(v => esc(String(v))).join(","))];
  return lines.join("\n");
}

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
  const [summary, setSummary] = useState<Summary | null>(null);
  const [classified, setClassified] = useState(false);
  /** خطأ تنفيذ قابل للتصحيح — بيتعرض داخل النافذة مع بقاء الملف والمعاينة. */
  const [execError, setExecError] = useState<{ message: string; errors: string[]; reports: RowReport[] } | null>(null);
  const [step, setStep] = useState<"upload" | "preview" | "done">("upload");
  // الاستيراد **عملية كتابة** — لازم نشاط واحد صريح، مش «كل الأنشطة». المصدر المعتمد
  // `businesses` (activeList: أنشطة نشطة مقيّدة بالـtenant/الصلاحيات على السيرفر). النطاق
  // العام (currentBusinessIds) بيُستخدم للـpreselect فقط — مش كوجهة كتابة.
  const { currentBusinessIds, businesses } = useBusinessContext();
  const activeBusinesses = businesses;

  // النشاط اللي هتتسجّل تحته الأوردرات — null = لسه لازم يتحدد (زر الاستيراد يفضل معطّل).
  const [selectedBusinessId, setSelectedBusinessId] = useState<number | null>(null);
  // اتلمس بإيد المستخدم؟ عشان تغيير الـswitcher وهو مفتوح مايدوسش على اختيار صريح.
  const userPickedRef = useRef(false);

  useEffect(() => {
    // إعادة الضبط عند الإغلاق — النافذة الجاية تبدأ نظيفة.
    if (!open) { userPickedRef.current = false; return; }
    setSelectedBusinessId(prev => {
      // اختيار صريح صالح → احترمه (بس اتأكد إنه لسه ضمن المتاح، وإلا امسحه).
      if (userPickedRef.current) {
        return prev != null && activeBusinesses.some(b => b.id === prev) ? prev : null;
      }
      // preselect تلقائي: نشاط الـswitcher الواحد، أو النشاط المتاح الوحيد، غير كده إجبار الاختيار.
      if (currentBusinessIds && currentBusinessIds.length === 1) return currentBusinessIds[0];
      if (activeBusinesses.length === 1) return activeBusinesses[0].id;
      return null;
    });
  }, [open, currentBusinessIds, activeBusinesses]);

  const selectedBusinessName =
    activeBusinesses.find(b => b.id === selectedBusinessId)?.name ?? null;

  const reset = () => {
    setFile(null);
    setPreviewData(null);
    setPreviewErrors([]);
    setShowErrors(false);
    setResult(null);
    setSummary(null);
    setClassified(false);
    setExecError(null);
    setStep("upload");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const downloadReport = (reports: RowReport[]) => {
    const blob = new Blob([buildReportCsv(reports)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `import-report-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  /** المعاينة — لو النشاط محدد بتيجي مصنّفة (جديد/موجود/مراجعة/مرفوض) من السيرفر. */
  const runPreview = async (f: File, businessId: number | null) => {
    setLoading(true);
    setExecError(null);
    try {
      const formData = new FormData();
      formData.append("file", f);
      if (businessId != null) formData.append("businessId", String(businessId));
      const res = await fetch("/api/import/preview", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "خطأ في قراءة الملف");
      setPreviewData(data.preview);
      setPreviewErrors(data.errors || []);
      setSummary(data.summary ?? null);
      setClassified(Boolean(data.classified));
      setStep("preview");
    } catch (err: any) {
      toast.error(err.message || "خطأ في قراءة الملف");
    } finally {
      setLoading(false);
    }
  };
  const handleFile = async (f: File) => {
    setFile(f);
    setPreviewData(null);
    setPreviewErrors([]);
    await runPreview(f, selectedBusinessId);
  };
  // تغيير النشاط بعد المعاينة → إعادة التصنيف على كتالوج/أوردرات النشاط الجديد.
  useEffect(() => {
    if (step === "preview" && file && selectedBusinessId != null && !loading) void runPreview(file, selectedBusinessId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBusinessId]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }, []);

  const handleImport = async () => {
    if (!file) return;
    // كتابة بلا نشاط ممنوعة — نفس قاعدة الباك (fail-closed). الزر معطّل أصلًا لكن حارس مزدوج.
    if (selectedBusinessId == null) {
      toast.error("لازم تحدد النشاط اللي هتستورد فيه");
      return;
    }
    setLoading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      // businessId صريح **دائمًا** — مش مشروط بعدد الأنشطة في الـswitcher.
      formData.append("businessId", String(selectedBusinessId));
      const res = await fetch("/api/import/execute", {
        method: "POST",
        body: formData,
      });
      const data: ImportResult = await res.json().catch(() => ({ imported: 0, errors: [], error: `HTTP ${res.status}` }));
      if (!res.ok) {
        // خطأ قابل للتصحيح: السبب الفعلي + تقرير الصفوف داخل النافذة، والملف والمعاينة يفضلوا.
        setExecError({ message: data.error || `فشل الاستيراد (HTTP ${res.status})`, errors: data.errors ?? [], reports: data.reports ?? [] });
        return;
      }
      setResult(data);
      setStep("done");
      if (data.imported > 0) {
        onSuccess();
      }
    } catch (err: any) {
      setExecError({ message: err?.message || "تعذّر الاتصال بالسيرفر", errors: [], reports: [] });
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
            {/* Business Info — الاختيار الفعلي للنشاط بيتم في خطوة المعاينة (Select إلزامي). */}
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-xl">
                🏢
              </div>
              <div>
                <p className="text-sm font-bold text-amber-800">
                  {selectedBusinessName
                    ? <>الأوردرات ستُسجَّل تحت: <Badge variant="outline" className="text-amber-700 border-amber-300">{selectedBusinessName}</Badge></>
                    : "هتحدد النشاط اللي هتستورد فيه بعد رفع الملف"}
                </p>
                <p className="text-xs text-amber-600 mt-0.5">
                  {"الاستيراد بيتسجّل تحت نشاط واحد محدد — مش «كل الأنشطة»."}
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
            {/* اختيار النشاط — إلزامي (عملية كتابة). مفيش خيار «كل الأنشطة» هنا إطلاقًا. */}
            <div className="rounded-lg border-2 border-amber-400 bg-amber-50 px-4 py-3">
              <label className="mb-1.5 flex items-center gap-2 text-sm font-bold text-amber-800">
                <Store className="h-4 w-4" />
                النشاط الذي سيتم استيراد الأوردرات إليه
              </label>
              <Select
                value={selectedBusinessId != null ? String(selectedBusinessId) : ""}
                onValueChange={(v) => { userPickedRef.current = true; setSelectedBusinessId(Number(v)); }}
              >
                <SelectTrigger className="w-full bg-card">
                  <SelectValue placeholder="اختر النشاط أولًا…" />
                </SelectTrigger>
                <SelectContent>
                  {activeBusinesses.map(b => (
                    <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedBusinessId == null && (
                <p className="mt-1.5 text-xs font-medium text-amber-700">
                  لازم تحدد نشاطًا واحدًا — الاستيراد لا يُسجَّل تحت «كل الأنشطة».
                </p>
              )}
            </div>

            {/* Summary: جديد / موجود مسبقًا / يحتاج مراجعة / مرفوض (بعد التصنيف على النشاط) */}
            {execError && (
              <div className="rounded-lg border border-red-300 bg-red-50 p-3 space-y-2" data-testid="import-exec-error">
                <p className="text-sm font-bold text-red-800">{execError.message}</p>
                {execError.errors.length > 0 && (
                  <div className="max-h-32 overflow-y-auto">
                    {execError.errors.slice(0, 30).map((e, i) => <p key={i} className="text-xs text-red-700">{e}</p>)}
                  </div>
                )}
                {execError.reports.length > 0 && (
                  <Button size="sm" variant="outline" onClick={() => downloadReport(execError.reports)}>تحميل تقرير الصفوف</Button>
                )}
              </div>
            )}
            <div className="flex items-center gap-2 flex-wrap" data-testid="import-summary">
              {summary && classified ? (
                <>
                  <span className="rounded-lg bg-green-50 border border-green-200 px-3 py-1.5 text-sm font-semibold text-green-700">جديد: {summary.new}</span>
                  <span className="rounded-lg bg-slate-100 border border-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700">موجود مسبقًا: {summary.existing}</span>
                  <span className="rounded-lg bg-yellow-50 border border-yellow-200 px-3 py-1.5 text-sm font-semibold text-yellow-800">يحتاج مراجعة: {summary.review}</span>
                  <span className="rounded-lg bg-red-50 border border-red-200 px-3 py-1.5 text-sm font-semibold text-red-700">مرفوض: {summary.rejected}</span>
                </>
              ) : (
                <div className="bg-green-50 border border-green-200 rounded-lg px-4 py-2 flex items-center gap-2">
                  <CheckCircle className="h-4 w-4 text-green-600" />
                  <span className="text-sm font-semibold text-green-700">{previewData.length} صف في الملف — اختر النشاط لعرض التصنيف</span>
                </div>
              )}
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
                      <th className="p-2 text-right font-semibold text-muted-foreground">Order ID</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">الحالة</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">الاسم</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">الهاتف</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">المحافظة</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">المنتج</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">الكمية</th>
                      <th className="p-2 text-right font-semibold text-muted-foreground">المبلغ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewData.map((row, i) => {
                      const reasons = [...row.rejectReasons, ...row.reviewReasons];
                      return (
                        <tr key={i} className="border-t hover:bg-muted/30" data-status={row.status}>
                          <td className="p-2 text-muted-foreground">{row.rowIndex}</td>
                          <td className="p-2 font-mono text-xs text-foreground" title={row.orderKey}>{row.idRaw || row.orderKey || '-'}</td>
                          <td className="p-2">
                            <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${STATUS_CLASS[row.status]}`} title={reasons.join("؛ ")}>{STATUS_LABEL[row.status]}</span>
                            {reasons.length > 0 && <div className="mt-0.5 max-w-44 truncate text-[11px] text-muted-foreground" title={reasons.join("؛ ")}>{reasons[0]}</div>}
                          </td>
                          <td className="p-2 font-medium text-foreground">{row.customerName}</td>
                          <td className={`p-2 ${row.phoneValid ? "text-muted-foreground" : "text-red-700 font-semibold"}`} dir="ltr">{row.phone}</td>
                          <td className="p-2">
                            <Badge className={`border-0 text-xs ${row.governorate ? "bg-blue-50 text-blue-700" : "bg-yellow-50 text-yellow-800"}`}>
                              {row.governorate || "غير محددة"}
                            </Badge>
                          </td>
                          <td className="p-2 text-foreground max-w-32 truncate" title={row.items.map(it => `${it.productName} ×${it.quantity}`).join(" + ")}>
                            {row.productName}
                            {row.multiProduct && (
                              <Badge className="mr-1 bg-purple-50 text-purple-700 border-0 text-xs">
                                {row.items.length} أصناف
                              </Badge>
                            )}
                          </td>
                          <td className="p-2 text-center text-foreground">{row.totalQuantity}</td>
                          <td className="p-2 font-semibold text-foreground">
                            {Number(row.totalAmount).toLocaleString('ar-EG')} ج.م
                          </td>
                        </tr>
                      );
                    })}
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
                تم الاستيراد تحت: <Badge variant="outline">{selectedBusinessName ?? "—"}</Badge>
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="import-result">
              <div className="bg-green-50 rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-green-700">{result.imported}</p>
                <p className="text-sm text-green-600 mt-1">تم استيراده</p>
              </div>
              <div className="bg-slate-100 rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-slate-700">{result.already_existing ?? 0}</p>
                <p className="text-sm text-slate-600 mt-1">تم تخطيه (موجود مسبقًا)</p>
              </div>
              <div className="bg-yellow-50 rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-yellow-800">{result.imported_review ?? 0}</p>
                <p className="text-sm text-yellow-700 mt-1">يحتاج مراجعة</p>
              </div>
              <div className="bg-red-50 rounded-xl p-4 text-center">
                <p className="text-3xl font-bold text-red-700">{result.skipped ?? 0}</p>
                <p className="text-sm text-red-600 mt-1">فشل / مرفوض</p>
              </div>
            </div>
            {(result.reports?.length ?? 0) > 0 && (
              <Button variant="outline" className="w-full" onClick={() => downloadReport(result.reports!)} data-testid="download-report">
                تحميل تقرير الصفوف (رقم الصف، Order ID، السبب)
              </Button>
            )}
            {result.errors.length > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 max-h-40 overflow-y-auto">
                <p className="text-xs font-semibold text-yellow-800 mb-1">تفاصيل الصفوف غير المستوردة أو التي تحتاج مراجعة:</p>
                {result.errors.slice(0, 30).map((e, i) => (
                  <p key={i} className="text-xs text-yellow-700">{e}</p>
                ))}
                {result.errors.length > 30 && (
                  <p className="text-xs text-yellow-600 mt-1">... و {result.errors.length - 30} أخرى — كاملة في التقرير</p>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {step === "preview" && (
            <Button
              onClick={handleImport}
              // معطّل حتى يتحدد النشاط — الكتابة تحت «كل الأنشطة» ممنوعة.
              disabled={loading || !previewData?.length || selectedBusinessId == null}
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin ml-2" />
                  جاري الاستيراد...
                </>
              ) : (
                <>
                  <Upload className="h-4 w-4 ml-2" />
                  {selectedBusinessId == null ? "اختر النشاط أولًا" : `استيراد ${summary ? summary.new + summary.review : previewData?.length} أوردر`}
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
