import { useMemo, useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useBrandOptions } from "@/hooks/useBrandOptions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EvidenceUpload } from "@/components/EvidenceUpload";
import { DEFAULT_TREASURY_LABEL } from "@/components/accounting/PaymentSource";
import { formatMoney } from "@/lib/money";
import { Banknote, Receipt, Wallet } from "lucide-react";

/**
 * تحصيل اليوم ومصروف اليوم — الشاشة اللي التاجر بيفتحها آخر النهار.
 *
 * الشاشتين التانيتين (المصروفات الكاملة، والتسويات بملف) لسه مكانهم — دي مش بديل ليهم،
 * دي الطريق القصير للحالة اللي بتحصل كل يوم.
 *
 * الحسابات كلها بتحصل هنا للعرض بس؛ اللي بيتبعت للسيرفر هو الإجمالي والرسوم، وهو اللي
 * بيطرح ويكتب. لو الاتنين حسبوا، كان ممكن يختلفوا.
 */

const today = () => new Date().toISOString().slice(0, 10);

export default function DailyCollections() {
  const { brands, selected, setSelected, selectedId, needsChoice, isEmpty } =
    useBrandOptions();

  return (
    <div dir="rtl" className="space-y-4 p-4 md:p-6">
      <div>
        <h1 className="text-xl font-bold">تحصيل اليوم</h1>
        <p className="text-sm text-muted-foreground">
          سجّل اللي دخل من شركة الشحن واللي خرج من الخزنة — في دقيقة.
        </p>
      </div>

      {brands.length > 1 && (
        <div className="max-w-xs">
          <Label>النشاط</Label>
          <Select value={selected} onValueChange={setSelected}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="اختار النشاط" />
            </SelectTrigger>
            <SelectContent>
              {brands.map(brand => (
                <SelectItem key={brand.id} value={String(brand.id)}>
                  {brand.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {isEmpty && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            مفيش أنشطة متاحة لحسابك.
          </CardContent>
        </Card>
      )}

      {needsChoice && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            اختار النشاط الأول عشان تبدأ.
          </CardContent>
        </Card>
      )}

      {selectedId != null && (
        <div className="grid gap-4 lg:grid-cols-2">
          <CollectionCard businessId={selectedId} />
          <ExpenseCard businessId={selectedId} />
          <OrderCollectionCard businessId={selectedId} />
          <ManualCashCard businessId={selectedId} />
        </div>
      )}

      {selectedId != null && <RecentSettlements businessId={selectedId} />}
    </div>
  );
}

// ───────────────────────── التحصيل ─────────────────────────

function CollectionCard({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const config = trpc.accountingV2.shippingConfiguration.useQuery({ businessId });
  const carriers = (config.data?.providers ?? []).filter(
    (provider: any) => provider.isActive
  );

  const [carrierId, setCarrierId] = useState("");
  const [date, setDate] = useState(today);
  const [reference, setReference] = useState("");
  const [ordersCount, setOrdersCount] = useState("");
  const [gross, setGross] = useState("");
  const [charges, setCharges] = useState("0");
  const [notes, setNotes] = useState("");

  const net = useMemo(() => {
    const g = Number(gross);
    const c = Number(charges);
    if (!Number.isFinite(g) || !Number.isFinite(c)) return null;
    return g - c;
  }, [gross, charges]);

  const record = trpc.accountingV2.dailySettlementRecord.useMutation({
    onSuccess: async result => {
      toast.success(`اتسجّل — دخل الخزنة ${formatMoney(Number(result.netTransferred))}`);
      setReference("");
      setOrdersCount("");
      setGross("");
      setCharges("0");
      setNotes("");
      await Promise.all([
        utils.accountingV2.dailySettlementList.invalidate(),
        utils.accounting.controlCenter.invalidate(),
        utils.accounting.dashboard.invalidate(),
      ]);
    },
    onError: error => toast.error(error.message),
  });

  const onlyOne = carriers.length === 1;
  const effectiveCarrier = onlyOne ? String(carriers[0].id) : carrierId;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Banknote className="h-5 w-5 text-emerald-700" />
          دخل من شركة الشحن
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {carriers.length === 0 ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            مفيش شركة شحن متسجّلة. ضيفها من إعدادات الشحن الأول.
          </p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {!onlyOne && (
                <div>
                  <Label>شركة الشحن *</Label>
                  <Select value={carrierId} onValueChange={setCarrierId}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="اختار الشركة" />
                    </SelectTrigger>
                    <SelectContent>
                      {carriers.map((carrier: any) => (
                        <SelectItem key={carrier.id} value={String(carrier.id)}>
                          {carrier.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div>
                <Label>التاريخ *</Label>
                <Input
                  className="mt-1"
                  type="date"
                  value={date}
                  onChange={event => setDate(event.target.value)}
                />
              </div>
              <div>
                <Label>عدد الأوردرات *</Label>
                <Input
                  className="mt-1"
                  dir="ltr"
                  inputMode="numeric"
                  value={ordersCount}
                  onChange={event => setOrdersCount(event.target.value)}
                />
              </div>
              <div>
                <Label>رقم التحويل</Label>
                <Input
                  className="mt-1"
                  dir="ltr"
                  placeholder="اختياري"
                  value={reference}
                  onChange={event => setReference(event.target.value)}
                />
              </div>
              <div>
                <Label>إجمالي التحصيل *</Label>
                <Input
                  className="mt-1"
                  dir="ltr"
                  inputMode="decimal"
                  value={gross}
                  onChange={event => setGross(event.target.value)}
                />
              </div>
              <div>
                <Label>رسوم الشحن</Label>
                <Input
                  className="mt-1"
                  dir="ltr"
                  inputMode="decimal"
                  value={charges}
                  onChange={event => setCharges(event.target.value)}
                />
              </div>
            </div>

            <div className="rounded-md border bg-emerald-50 p-3 text-sm dark:bg-emerald-950/30">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">الصافي اللي هيدخل الخزنة</span>
                <span className="text-lg font-bold text-emerald-700 dark:text-emerald-400">
                  {net == null || net < 0 ? "—" : formatMoney(net)}
                </span>
              </div>
              {net != null && net < 0 && (
                <p className="mt-1 text-xs text-destructive">
                  الرسوم أكبر من إجمالي التحصيل — راجع الأرقام.
                </p>
              )}
            </div>

            <div>
              <Label>ملاحظات</Label>
              <Textarea
                className="mt-1"
                rows={2}
                value={notes}
                onChange={event => setNotes(event.target.value)}
              />
            </div>

            <Button
              className="w-full"
              disabled={record.isPending}
              onClick={() => {
                if (!effectiveCarrier) return toast.error("اختار شركة الشحن");
                const count = Number(ordersCount);
                if (!Number.isInteger(count) || count < 1)
                  return toast.error("عدد الأوردرات لازم يكون واحد على الأقل");
                if (!(Number(gross) > 0))
                  return toast.error("إجمالي التحصيل لازم يكون أكبر من صفر");
                if (net == null || net < 0)
                  return toast.error("الرسوم أكبر من إجمالي التحصيل");
                record.mutate({
                  businessId,
                  businessShippingProviderId: Number(effectiveCarrier),
                  statementDate: new Date(`${date}T12:00:00`),
                  reference: reference.trim() || undefined,
                  ordersCount: count,
                  grossCollected: gross,
                  totalCharges: charges || "0",
                  notes: notes.trim() || undefined,
                });
              }}
            >
              {record.isPending ? "جاري التسجيل..." : "سجّل التحصيل"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              بيدخل «{DEFAULT_TREASURY_LABEL}» بالصافي — حركة واحدة. الرسوم مابتنزلش حركة
              تانية لأنها مادخلتش الدُرج أصلاً.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────────────────── المصروف ─────────────────────────

function ExpenseCard({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const categories = trpc.accounting.expenseCategories.useQuery({
    businessIds: [businessId],
  });

  const [date, setDate] = useState(today);
  const [categoryId, setCategoryId] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [attachmentUrl, setAttachmentUrl] = useState("");

  const record = trpc.accountingV2.expenseRecordSimple.useMutation({
    onSuccess: async result => {
      toast.success(
        result.paid ? "اتسجّل واتخصم من الخزنة" : "اتسجّل كمصروف مستحق — لسه مادفعش"
      );
      setAmount("");
      setDescription("");
      setAttachmentUrl("");
      await Promise.all([
        utils.accounting.controlCenter.invalidate(),
        utils.accounting.dashboard.invalidate(),
      ]);
    },
    onError: error => toast.error(error.message),
  });

  const submit = (payNow: boolean) => {
    if (!(Number(amount) > 0)) return toast.error("المبلغ لازم يكون أكبر من صفر");
    if (!description.trim()) return toast.error("اكتب المصروف بيخص إيه");
    record.mutate({
      businessId,
      categoryId: categoryId ? Number(categoryId) : undefined,
      amount,
      expenseDate: date,
      description: description.trim(),
      attachmentUrl: attachmentUrl.trim() || undefined,
      payNow,
    });
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Receipt className="h-5 w-5 text-rose-700" />
          خرج من الخزنة
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>التاريخ *</Label>
            <Input
              className="mt-1"
              type="date"
              value={date}
              onChange={event => setDate(event.target.value)}
            />
          </div>
          <div>
            <Label>المبلغ *</Label>
            <Input
              className="mt-1"
              dir="ltr"
              inputMode="decimal"
              value={amount}
              onChange={event => setAmount(event.target.value)}
            />
          </div>
        </div>

        <div>
          <Label>التصنيف</Label>
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="اختياري" />
            </SelectTrigger>
            <SelectContent>
              {(categories.data ?? [])
                .filter((category: any) => category.isActive)
                .map((category: any) => (
                  <SelectItem key={category.id} value={String(category.id)}>
                    {category.name}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>المصروف بيخص إيه *</Label>
          <Textarea
            className="mt-1"
            rows={2}
            placeholder="بنزين، تغليف، صيانة…"
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </div>

        <EvidenceUpload
          label="صورة الفاتورة (اختياري)"
          value={attachmentUrl}
          onChange={setAttachmentUrl}
        />

        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            disabled={record.isPending}
            onClick={() => submit(false)}
          >
            سجّل بس (مستحق)
          </Button>
          <Button disabled={record.isPending} onClick={() => submit(true)}>
            <Wallet className="ml-1 h-4 w-4" />
            سجّل وادفع
          </Button>
        </div>
        <p className="text-center text-xs text-muted-foreground">
          «سجّل وادفع» بيخصم من «{DEFAULT_TREASURY_LABEL}» مرة واحدة. «سجّل بس» بيسيبه
          مستحق تدفعه بعدين.
        </p>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── تحصيل أوردر بعينه ─────────────────────────

/**
 * الزبون دفع لك على طول — مش عن طريق شركة الشحن.
 *
 * انتقلت من «مركز التسجيل اليومي». مختلفة عن تسوية اليوم فوق: دي أوردر واحد بعينه،
 * فبتحدّث حالة تحصيله كمان مش بس بتحرّك الخزنة.
 */
function OrderCollectionCard({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const [orderId, setOrderId] = useState("");
  const [amount, setAmount] = useState("");

  const pending = trpc.accounting.collectionList.useQuery({
    businessIds: [businessId],
    collectionStatus: "pending",
    search: search.trim() || undefined,
    page: 1,
    limit: 20,
  });
  const rows: any[] = (pending.data as any)?.orders ?? [];
  const picked = rows.find(row => String(row.id) === orderId);

  const record = trpc.accounting.collectionRecord.useMutation({
    onSuccess: async () => {
      toast.success("اتسجّل التحصيل");
      setOrderId("");
      setAmount("");
      await Promise.all([
        utils.accounting.collectionList.invalidate(),
        utils.accounting.controlCenter.invalidate(),
        utils.accounting.dashboard.invalidate(),
      ]);
    },
    onError: error => toast.error(error.message),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Banknote className="h-5 w-5 text-sky-700" />
          الزبون دفع لك على طول
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>دوّر على الأوردر</Label>
          <Input
            className="mt-1"
            placeholder="رقم الأوردر أو اسم الزبون أو التليفون"
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
        </div>

        {rows.length === 0 ? (
          <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            {search.trim()
              ? "مفيش أوردر مطابق لسه محتاج تحصيل."
              : "مفيش أوردرات مستنية تحصيل."}
          </p>
        ) : (
          <div>
            <Label>الأوردر *</Label>
            <Select
              value={orderId}
              onValueChange={value => {
                setOrderId(value);
                const row = rows.find(item => String(item.id) === value);
                // المبلغ المتوقع مقترح مش مفروض — التحصيل الجزئي بيحصل.
                if (row) setAmount(String(row.totalAmount ?? ""));
              }}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder="اختار الأوردر" />
              </SelectTrigger>
              <SelectContent>
                {rows.map(row => (
                  <SelectItem key={row.id} value={String(row.id)}>
                    {row.orderNumber} — {row.customerName} ·{" "}
                    {formatMoney(Number(row.totalAmount ?? 0))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div>
          <Label>المبلغ اللي اتحصّل *</Label>
          <Input
            className="mt-1"
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={event => setAmount(event.target.value)}
          />
          {picked && (
            <p className="mt-1 text-xs text-muted-foreground">
              المتوقع {formatMoney(Number(picked.totalAmount ?? 0))} — لو حصّلت أقل
              اكتب اللي اتحصّل فعلًا والأوردر هيفضل جزئي.
            </p>
          )}
        </div>

        <Button
          className="w-full"
          disabled={record.isPending}
          onClick={() => {
            if (!orderId) return toast.error("اختار الأوردر");
            const value = Number(amount);
            if (!Number.isFinite(value) || value < 0)
              return toast.error("اكتب مبلغ صحيح");
            record.mutate({
              orderId: Number(orderId),
              collectedAmount: value,
              collectedAt: new Date(),
            });
          }}
        >
          {record.isPending ? "جاري التسجيل..." : "سجّل تحصيل الأوردر"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── إيداع وسحب ─────────────────────────

/**
 * فلوس داخلة أو خارجة من غير أوردر ومن غير مصروف.
 *
 * انتقلت من «مركز التسجيل اليومي»، وهي المسار **الوحيد** في النظام لده: «حطيت ٥٠٠٠
 * من جيبي» أو «سحبت ٢٠٠٠ لنفسي». من غيرها رصيد الخزنة بيبعد عن الدُرج الحقيقي ومفيش
 * طريقة توفّقهم.
 */
function ManualCashCard({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const [kind, setKind] = useState<"deposit" | "withdrawal">("deposit");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");

  const record = trpc.accounting.treasuryCreate.useMutation({
    onSuccess: async () => {
      toast.success(kind === "deposit" ? "اتسجّل الإيداع" : "اتسجّل السحب");
      setAmount("");
      setDescription("");
      await Promise.all([
        utils.accounting.controlCenter.invalidate(),
        utils.accounting.treasuryHistory.invalidate(),
        utils.accounting.dashboard.invalidate(),
      ]);
    },
    onError: error => toast.error(error.message),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet className="h-5 w-5 text-violet-700" />
          إيداع أو سحب
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            variant={kind === "deposit" ? "default" : "outline"}
            onClick={() => setKind("deposit")}
          >
            حطيت فلوس
          </Button>
          <Button
            type="button"
            variant={kind === "withdrawal" ? "default" : "outline"}
            onClick={() => setKind("withdrawal")}
          >
            سحبت فلوس
          </Button>
        </div>

        <div>
          <Label>المبلغ *</Label>
          <Input
            className="mt-1"
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={event => setAmount(event.target.value)}
          />
        </div>

        <div>
          <Label>السبب *</Label>
          <Input
            className="mt-1"
            placeholder={
              kind === "deposit" ? "رأس مال من جيبي" : "سحب شخصي"
            }
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </div>

        <Button
          className="w-full"
          disabled={record.isPending}
          onClick={() => {
            const value = Number(amount);
            if (!(value > 0)) return toast.error("المبلغ لازم يكون أكبر من صفر");
            if (!description.trim()) return toast.error("اكتب السبب");
            record.mutate({
              businessId,
              type: kind,
              amount: value,
              description: description.trim(),
              transactionDate: new Date(),
            });
          }}
        >
          {record.isPending
            ? "جاري التسجيل..."
            : kind === "deposit"
              ? "سجّل الإيداع"
              : "سجّل السحب"}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          دي مش مصروف ولا تحصيل — فلوس بتتحرك من الخزنة أو ليها من غير أوردر. مابتأثرش
          على صافي الربح.
        </p>
      </CardContent>
    </Card>
  );
}

// ───────────────────────── آخر التحصيلات ─────────────────────────

function RecentSettlements({ businessId }: { businessId: number }) {
  const list = trpc.accountingV2.dailySettlementList.useQuery({
    businessId,
    limit: 30,
  });
  const rows = list.data ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">آخر التحصيلات</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            لسه مافيش تحصيلات متسجّلة.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-right text-xs text-muted-foreground">
                  <th className="p-2 font-medium">التاريخ</th>
                  <th className="p-2 font-medium">الشركة</th>
                  <th className="p-2 font-medium">أوردرات</th>
                  <th className="p-2 font-medium">الإجمالي</th>
                  <th className="p-2 font-medium">الرسوم</th>
                  <th className="p-2 font-medium">الصافي</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="p-2 whitespace-nowrap">
                      {new Date(row.statementDate).toLocaleDateString("ar-EG")}
                    </td>
                    <td className="p-2">{row.carrierName ?? "—"}</td>
                    <td className="p-2">{row.ordersCount ?? "—"}</td>
                    <td className="p-2">{formatMoney(Number(row.grossCollected))}</td>
                    <td className="p-2 text-muted-foreground">
                      {formatMoney(Number(row.totalCharges))}
                    </td>
                    <td className="p-2 font-semibold text-emerald-700 dark:text-emerald-400">
                      {formatMoney(Number(row.netTransferred))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
