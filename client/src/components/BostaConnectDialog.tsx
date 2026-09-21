import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Truck, CheckCircle, Unplug, RefreshCw } from "lucide-react";

/**
 * ربط حساب Bosta **للنشاط الحالي** — مفتاح + اختبار + مكان استلام من حساب Bosta نفسه.
 *
 * المفتاح بيتبعت مرة واحدة للحفظ (بعد نجاح الاختبار) وعمره ما يرجع: الحالة بترجّع
 * آخر 4 أحرف بس. النشاط من سياق الجلسة، والسيرفر بيعيد فحص النطاق (`scopeBusinessId`).
 */
export function BostaConnectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  // النشاط الفعّال من السياق: نشاط واحد بيتحدد تلقائيًا (فالنموذج بيفتح مباشرة)؛ أكتر من
  // نشاط بلا اختيار → اختيار النشاط هنا أولًا (بيغيّر النشاط الفعّال للتطبيق كله)، ثم النموذج.
  const { currentBusinessId, businesses, setCurrentBusinessId, activeBusiness } = useBusinessContext();
  const businessId = currentBusinessId ?? 0;
  const needsPick = !businessId && businesses.length > 1;
  const utils = trpc.useUtils();
  const status = trpc.carrierAccounts.status.useQuery({ businessId }, { enabled: open && businessId > 0 });

  const [apiKey, setApiKey] = useState("");
  const [locations, setLocations] = useState<{ id: string; name: string }[] | null>(null);
  const [pickupId, setPickupId] = useState("");
  const [allowOpen, setAllowOpen] = useState(true);

  const test = trpc.carrierAccounts.testConnection.useMutation({
    onSuccess: r => { setLocations(r.pickupLocations); toast.success("الاتصال ببوسطة ناجح"); },
    onError: e => { setLocations(null); toast.error(e.message); },
  });
  const connect = trpc.carrierAccounts.connect.useMutation({
    onSuccess: r => {
      toast.success(`تم ربط حساب بوسطة (…${r.apiKeyLast4})`);
      setApiKey(""); setLocations(null); setPickupId("");
      utils.carrierAccounts.status.invalidate({ businessId });
    },
    onError: e => toast.error(e.message),
  });
  const disconnect = trpc.carrierAccounts.disconnect.useMutation({
    onSuccess: () => { toast.success("تم فصل حساب بوسطة"); utils.carrierAccounts.status.invalidate({ businessId }); },
    onError: e => toast.error(e.message),
  });

  const s = status.data;
  const connected = s?.status === "connected";
  const pickup = locations?.find(l => l.id === pickupId) ?? null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" dir="rtl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Truck className="h-5 w-5 text-[var(--info)]" /> ربط حساب Bosta{activeBusiness ? ` — ${activeBusiness.name}` : ""}</DialogTitle>
        </DialogHeader>

        {needsPick ? (
          <div className="space-y-2" data-testid="bosta-pick-business">
            <Label className="text-xs">اختر النشاط الذي تريد ربط حساب بوسطة به</Label>
            <Select value="" onValueChange={v => setCurrentBusinessId(Number(v))}>
              <SelectTrigger data-testid="bosta-business-select"><SelectValue placeholder="اختر النشاط" /></SelectTrigger>
              <SelectContent>
                {businesses.map(b => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">الربط يُحفظ للنشاط المختار فقط — مفتاح نشاط لا يُستخدم لنشاط آخر.</p>
          </div>
        ) : !businessId ? (
          <p className="text-sm text-muted-foreground">لا يوجد نشاط متاح لهذه الجلسة.</p>
        ) : connected ? (
          <div className="space-y-3 text-sm" data-testid="bosta-connected">
            <div className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-[var(--success)]" /> مربوط — المفتاح ينتهي بـ <Badge variant="secondary" dir="ltr">…{s?.apiKeyLast4}</Badge></div>
            <div><span className="text-muted-foreground">مكان الاستلام:</span> {s?.pickupLocationName ?? s?.pickupLocationId ?? "—"}</div>
            <div><span className="text-muted-foreground">فتح الشحنة افتراضيًا:</span> {s?.allowOpenPackageDefault ? "نعم" : "لا"}</div>
            <p className="text-xs text-muted-foreground">لتغيير المفتاح: افصل الحساب ثم اربطه بمفتاح جديد. تاريخ الشحنات يظل محفوظًا.</p>
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => disconnect.mutate({ businessId })} disabled={disconnect.isPending} data-testid="bosta-disconnect">
              <Unplug className="h-4 w-4 ml-1" /> فصل الحساب
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {s?.status === "legacy" && (
              <p className="text-xs rounded-md border border-[var(--warning)] bg-[var(--warning)]/5 p-2 text-[var(--warning)]">{s.reason}</p>
            )}
            <div>
              <Label className="text-xs">API Key من لوحة بوسطة (صلاحية Read/Write)</Label>
              <Input type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); setLocations(null); }} dir="ltr" className="mt-1" autoComplete="off" data-testid="bosta-api-key" />
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => test.mutate({ businessId, apiKey })} disabled={apiKey.trim().length < 8 || test.isPending} data-testid="bosta-test">
              {test.isPending ? <RefreshCw className="h-4 w-4 ml-1 animate-spin" /> : null} اختبار الاتصال
            </Button>
            {locations && (
              <>
                <div>
                  <Label className="text-xs">مكان الاستلام الافتراضي (من حساب بوسطة)</Label>
                  <Select value={pickupId} onValueChange={setPickupId}>
                    <SelectTrigger className="mt-1" data-testid="bosta-pickup"><SelectValue placeholder={locations.length ? "اختر مكان الاستلام" : "لا توجد أماكن استلام في الحساب"} /></SelectTrigger>
                    <SelectContent>
                      {locations.map(l => <SelectItem key={l.id} value={l.id}>{l.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={allowOpen} onChange={e => setAllowOpen(e.target.checked)} /> السماح بفتح الشحنة افتراضيًا (فليكس شيب)
                </label>
              </>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>إغلاق</Button>
          {!connected && businessId > 0 && (
            <Button
              onClick={() => connect.mutate({ businessId, apiKey, pickupLocationId: pickupId || null, pickupLocationName: pickup?.name ?? null, allowOpenPackageDefault: allowOpen })}
              disabled={!locations || connect.isPending}
              data-testid="bosta-save"
            >
              {connect.isPending ? "جاري الحفظ..." : "حفظ الربط"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
