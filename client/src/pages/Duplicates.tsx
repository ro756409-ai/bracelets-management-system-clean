import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Trash2, RotateCcw, Phone, MapPin, Package, AlertTriangle, Trash } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export default function Duplicates() {
  const utils = trpc.useUtils();

  const { data: duplicates = [], isLoading } = trpc.duplicates.list.useQuery();

  const deleteMutation = trpc.duplicates.delete.useMutation({
    onSuccess: () => {
      toast.success("✅ تم حذف الأوردر");
      utils.duplicates.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const restoreMutation = trpc.duplicates.restore.useMutation({
    onSuccess: () => {
      toast.success("تم إعادة الأوردر للقائمة العادية");
      utils.duplicates.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteAllMutation = trpc.duplicates.deleteAll.useMutation({
    onSuccess: (data) => {
      toast.success(`✅ تم حذف ${data.deleted} أوردر مكرر`);
      utils.duplicates.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="p-6 max-w-4xl mx-auto" dir="rtl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <AlertTriangle className="h-6 w-6 text-orange-500" />
            الأوردرات المكررة
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            الأوردرات التي علّمها الموظفون كمكررة — راجعها واحذف غير المطلوب
          </p>
        </div>
        {duplicates.length > 0 && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="destructive" size="sm" className="gap-2">
                <Trash className="h-4 w-4" />
                حذف الكل ({duplicates.length})
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent dir="rtl">
              <AlertDialogHeader>
                <AlertDialogTitle>حذف جميع المكررات</AlertDialogTitle>
                <AlertDialogDescription>
                  سيتم حذف {duplicates.length} أوردر نهائياً. هذا الإجراء لا يمكن التراجع عنه.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>إلغاء</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => deleteAllMutation.mutate()}
                  disabled={deleteAllMutation.isPending}
                >
                  {deleteAllMutation.isPending ? "جاري الحذف..." : "حذف الكل"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="text-center py-16 text-muted-foreground">جاري التحميل...</div>
      ) : duplicates.length === 0 ? (
        <div className="text-center py-16">
          <AlertTriangle className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-muted-foreground">لا توجد أوردرات مكررة حالياً</p>
        </div>
      ) : (
        <div className="space-y-3">
          {duplicates.map((order: any) => (
            <div
              key={order.id}
              className="bg-card border border-orange-200 rounded-xl p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  {/* Header row */}
                  <div className="flex items-center gap-2 mb-2 flex-wrap">
                    <Badge variant="outline" className="text-xs font-mono border-orange-300 text-orange-700 bg-orange-50">
                      #{order.orderNumber}
                    </Badge>
                    <Badge className="text-xs bg-orange-100 text-orange-700 border-0">
                      ⚠️ مكرر
                    </Badge>
                    {order.source && (
                      <Badge variant="outline" className="text-xs">
                        {order.source === "easyorder" ? "Easy Order" : order.source === "facebook" ? "فيسبوك" : order.source}
                      </Badge>
                    )}
                  </div>

                  {/* Customer info */}
                  <p className="font-semibold text-foreground">{order.customerName}</p>
                  <div className="flex items-center gap-1 text-sm text-muted-foreground mt-0.5">
                    <Phone className="h-3.5 w-3.5" />
                    <span dir="ltr">{order.customerPhone}</span>
                  </div>
                  <div className="flex items-center gap-1 text-sm text-muted-foreground mt-0.5">
                    <MapPin className="h-3.5 w-3.5" />
                    <span>{order.governorate} — {order.customerAddress}</span>
                  </div>
                  <div className="flex items-center gap-1 text-sm text-muted-foreground mt-0.5">
                    <Package className="h-3.5 w-3.5" />
                    <span>{order.productName} × {order.quantity} — {Number(order.totalAmount)} ج.م</span>
                  </div>

                  {order.notes && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1 mt-2">
                      ملاحظة: {order.notes}
                    </p>
                  )}

                  {order.duplicateMarkedAt && (
                    <p className="text-xs text-muted-foreground mt-2">
                      علّمه موظف في: {new Date(order.duplicateMarkedAt).toLocaleString("ar-EG")}
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2 shrink-0">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-8 text-xs gap-1"
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        حذف
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent dir="rtl">
                      <AlertDialogHeader>
                        <AlertDialogTitle>تأكيد الحذف</AlertDialogTitle>
                        <AlertDialogDescription>
                          سيتم حذف أوردر #{order.orderNumber} نهائياً. هذا الإجراء لا يمكن التراجع عنه.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>إلغاء</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          onClick={() => deleteMutation.mutate({ orderId: order.id })}
                        >
                          حذف
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>

                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs gap-1 border-green-300 text-green-700 hover:bg-green-50"
                    onClick={() => restoreMutation.mutate({ orderId: order.id })}
                    disabled={restoreMutation.isPending}
                    title="إعادة للأوردرات العادية"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    استعادة
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
