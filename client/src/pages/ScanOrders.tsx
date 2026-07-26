import { useState, useEffect, useRef, useCallback } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { QrCode, CheckCircle2, XCircle, AlertTriangle, Camera, CameraOff, Package, User, MapPin, Phone, Hash } from "lucide-react";

type ScanResult = {
  success: boolean;
  result: "success" | "failed" | "duplicate" | "cancelled";
  message: string;
  order?: any;
};

export default function ScanOrders() {
  const [isScanning, setIsScanning] = useState(false);
  const [manualSerial, setManualSerial] = useState("");
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const scanningRef = useRef(false);

  const scanMutation = trpc.orders.scan.useMutation({
    onSuccess: (data) => {
      setScanResult(data as ScanResult);
      setScanCount((c) => c + 1);
      if (data.success) {
        toast.success("✅ تم تجهيز الأوردر بنجاح!");
      } else if (data.result === "duplicate") {
        toast.warning("⚠️ هذا الأوردر تم تجهيزه من قبل");
      } else if (data.result === "cancelled") {
        toast.error("🚫 هذا الأوردر ملغي أو مرتجع");
      } else {
        toast.error("❌ QR غير صحيح - الأوردر غير موجود");
      }
    },
    onError: (err) => {
      toast.error(`خطأ: ${err.message}`);
    },
  });

  const handleScan = useCallback((serialNumber: string) => {
    if (!serialNumber.trim() || scanMutation.isPending) return;
    const deviceInfo = navigator.userAgent.substring(0, 200);
    scanMutation.mutate({ serialNumber: serialNumber.trim(), deviceInfo });
  }, [scanMutation]);

  const stopCamera = useCallback(() => {
    scanningRef.current = false;
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsScanning(false);
    setCameraError(null);
  }, []);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.setAttribute("playsinline", "true");
        videoRef.current.setAttribute("autoplay", "true");
        await videoRef.current.play();
      }

      setIsScanning(true);
      scanningRef.current = true;

      // Dynamically import jsQR for QR code detection
      const { default: jsQR } = await import("jsqr");

      const scanFrame = () => {
        if (!scanningRef.current || !videoRef.current || !canvasRef.current) return;

        const video = videoRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });

        if (video.readyState === video.HAVE_ENOUGH_DATA && ctx) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: "dontInvert",
          });

          if (code && code.data) {
            stopCamera();
            handleScan(code.data);
            return;
          }
        }

        animFrameRef.current = requestAnimationFrame(scanFrame);
      };

      // Wait a bit for the video to be ready
      setTimeout(() => {
        if (scanningRef.current) {
          scanFrame();
        }
      }, 500);

    } catch (err: any) {
      console.error("Camera error:", err);
      if (err.name === "NotAllowedError") {
        setCameraError("تم رفض إذن الكاميرا. يرجى السماح بالوصول للكاميرا من إعدادات المتصفح.");
      } else if (err.name === "NotFoundError") {
        setCameraError("لم يتم العثور على كاميرا. تأكد من وجود كاميرا متصلة.");
      } else {
        setCameraError("تعذر فتح الكاميرا: " + (err?.message || "خطأ غير معروف"));
      }
      toast.error("تعذر فتح الكاميرا");
    }
  }, [handleScan, stopCamera]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, [stopCamera]);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!manualSerial.trim()) return;
    handleScan(manualSerial);
    setManualSerial("");
  };

  const resultColors = {
    success: "border-[var(--success)]/40 bg-[var(--success)]/10",
    duplicate: "border-[var(--warning)]/40 bg-[var(--warning)]/10",
    cancelled: "border-destructive/40 bg-destructive/10",
    failed: "border-destructive/40 bg-destructive/10",
  };

  const resultIcons = {
    success: <CheckCircle2 className="h-8 w-8 text-[var(--success)]" />,
    duplicate: <AlertTriangle className="h-8 w-8 text-[var(--warning)]" />,
    cancelled: <XCircle className="h-8 w-8 text-destructive" />,
    failed: <XCircle className="h-8 w-8 text-destructive" />,
  };

  return (
    <div className="max-w-lg mx-auto" dir="rtl">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="bg-primary p-2.5 rounded-xl">
          <QrCode className="h-6 w-6 text-primary-foreground" />
        </div>
        <div>
          <h1 className="text-xl font-bold">تجهيز الأوردرات</h1>
          <p className="text-sm text-muted-foreground">امسح QR Code لتجهيز الأوردر</p>
        </div>
        {scanCount > 0 && (
          <Badge className="mr-auto bg-accent text-accent-foreground border-primary/20">
            {scanCount} مسح
          </Badge>
        )}
      </div>

      {/* Camera Scanner */}
      <Card className="mb-4 overflow-hidden">
        <CardHeader className="pb-3 pt-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Camera className="h-4 w-4 text-primary" />
            مسح بالكاميرا
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-4">
          {/* Video element for camera */}
          <div className={`relative w-full rounded-lg overflow-hidden bg-black ${isScanning ? "min-h-[300px]" : "hidden"}`}>
            <video
              ref={videoRef}
              className="w-full h-full object-cover min-h-[300px]"
              playsInline
              autoPlay
              muted
              style={{ transform: "scaleX(1)" }}
            />
            {/* Scan overlay */}
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="w-56 h-56 border-2 border-white/70 rounded-xl relative">
                <div className="absolute top-0 left-0 w-6 h-6 border-t-4 border-l-4 border-primary/70 rounded-tl-lg" />
                <div className="absolute top-0 right-0 w-6 h-6 border-t-4 border-r-4 border-primary/70 rounded-tr-lg" />
                <div className="absolute bottom-0 left-0 w-6 h-6 border-b-4 border-l-4 border-primary/70 rounded-bl-lg" />
                <div className="absolute bottom-0 right-0 w-6 h-6 border-b-4 border-r-4 border-primary/70 rounded-br-lg" />
              </div>
            </div>
            {/* Hidden canvas for QR processing */}
            <canvas ref={canvasRef} className="hidden" />
          </div>

          {!isScanning && !cameraError && (
            <div className="bg-muted rounded-lg h-40 flex items-center justify-center border-2 border-dashed border-border">
              <div className="text-center text-muted-foreground">
                <CameraOff className="h-10 w-10 mx-auto mb-2 opacity-50" />
                <p className="text-sm">الكاميرا متوقفة</p>
              </div>
            </div>
          )}

          {cameraError && (
            <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-4 text-center">
              <XCircle className="h-8 w-8 text-destructive/70 mx-auto mb-2" />
              <p className="text-sm text-destructive">{cameraError}</p>
            </div>
          )}

          <div className="mt-3 flex gap-2">
            {!isScanning ? (
              <Button
                className="flex-1"
                onClick={startCamera}
                disabled={scanMutation.isPending}
              >
                <Camera className="h-4 w-4 ml-2" />
                تشغيل الكاميرا
              </Button>
            ) : (
              <Button
                variant="outline"
                className="flex-1 border-destructive/30 text-destructive hover:bg-destructive/10"
                onClick={stopCamera}
              >
                <CameraOff className="h-4 w-4 ml-2" />
                إيقاف الكاميرا
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Manual Entry */}
      <Card className="mb-4">
        <CardHeader className="pb-3 pt-4">
          <CardTitle className="text-base flex items-center gap-2">
            <Hash className="h-4 w-4 text-[var(--info)]" />
            إدخال يدوي
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-4">
          <form onSubmit={handleManualSubmit} className="flex gap-2">
            <Input
              placeholder="ORD-2026-000001"
              value={manualSerial}
              onChange={(e) => setManualSerial(e.target.value)}
              className="font-mono text-sm flex-1"
              dir="ltr"
            />
            <Button
              type="submit"
              disabled={scanMutation.isPending || !manualSerial.trim()}
            >
              {scanMutation.isPending ? "..." : "تجهيز"}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground mt-2">أدخل الـ Serial Number يدوياً إذا تعذر المسح</p>
        </CardContent>
      </Card>

      {/* Scan Result */}
      {scanResult && (
        <Card className={`mb-4 border-2 ${resultColors[scanResult.result]}`}>
          <CardContent className="pt-4 pb-4">
            <div className="flex items-start gap-3 mb-3">
              {resultIcons[scanResult.result]}
              <div>
                <p className="font-bold">{scanResult.message}</p>
                {scanResult.result === "success" && (
                  <p className="text-xs text-[var(--success)] mt-0.5">تم تسجيل التجهيز بنجاح</p>
                )}
              </div>
            </div>

            {scanResult.order && (
              <div className="bg-card rounded-lg border p-3 space-y-2 mt-2">
                <div className="flex items-center gap-2 text-sm">
                  <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="font-medium">{scanResult.order.customerName}</span>
                  <Badge variant="outline" className="text-xs mr-auto">
                    #{scanResult.order.orderNumber}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span dir="ltr">{scanResult.order.customerPhone}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span>{scanResult.order.governorate} - {scanResult.order.customerAddress?.substring(0, 50)}</span>
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Package className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span>{scanResult.order.productName?.substring(0, 60)}</span>
                </div>
                <div className="flex items-center justify-between pt-1 border-t">
                  <span className="text-xs text-muted-foreground">الإجمالي</span>
                  <span className="font-bold text-[var(--success)]">{Number(scanResult.order.totalAmount).toLocaleString()} ج.م</span>
                </div>
              </div>
            )}

            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              onClick={() => { setScanResult(null); startCamera(); }}
            >
              مسح أوردر جديد
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Instructions */}
      {!scanResult && (
        <Card className="bg-[var(--info)]/10 border-[var(--info)]/20">
          <CardContent className="pt-4 pb-4">
            <p className="text-sm font-medium text-[var(--info)] mb-2">كيفية الاستخدام:</p>
            <ol className="text-sm text-[var(--info)] space-y-1 list-decimal list-inside">
              <li>اضغط "تشغيل الكاميرا"</li>
              <li>وجّه الكاميرا نحو QR Code على الفاتورة</li>
              <li>سيتم تجهيز الأوردر تلقائياً</li>
              <li>تحقق من بيانات الأوردر قبل التعبئة</li>
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
