import { useEffect, useState } from "react";
import { Banknote, PackageCheck, RefreshCw, Truck } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EvidenceUpload } from "@/components/EvidenceUpload";

type SettlementLine = {
  externalReference: string;
  grossCollected: string;
  actualCharges: string;
  netAmount: string;
  notes: string;
};
const emptySettlementLine = (): SettlementLine => ({
  externalReference: "",
  grossCollected: "",
  actualCharges: "",
  netAmount: "",
  notes: "",
});

export function ShippingFinanceSection() {
  const { businesses } = useBusinessContext();
  const [businessId, setBusinessId] = useState<number>();
  useEffect(() => {
    if (!businessId && businesses[0]) setBusinessId(businesses[0].id);
  }, [businessId, businesses]);
  return (
    <div className="space-y-4">
      <Card className="border-cyan-900/10 bg-gradient-to-l from-cyan-950 to-slate-950 text-white">
        <CardContent className="flex flex-col gap-3 p-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-bold tracking-[0.2em] text-cyan-300">
              SHIPPING FINANCE
            </p>
            <h2 className="mt-1 text-2xl font-black">
              الشحن والتسويات والمدفوعات
            </h2>
            <p className="text-sm text-slate-300">
              Provider-neutral events، Settlement Statement وفروق الرسوم.
            </p>
          </div>
          <label className="w-full space-y-1 text-sm md:w-72">
            <span>النشاط</span>
            <select
              className="h-10 w-full rounded-md border border-white/15 bg-white/10 px-3"
              value={businessId ?? ""}
              onChange={event => setBusinessId(Number(event.target.value))}
            >
              {businesses.map(row => (
                <option className="text-slate-950" key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </label>
        </CardContent>
      </Card>
      {businessId && (
        <>
          <ShipmentOperations businessId={businessId} />
          <SettlementOperations businessId={businessId} />
          <OrderPayments businessId={businessId} />
        </>
      )}
    </div>
  );
}

function ShipmentOperations({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const shipping = trpc.accountingV2.shippingConfiguration.useQuery({
    businessId,
  });
  const finance = trpc.accountingV2.shippingFinanceData.useQuery({
    businessId,
  });
  const governorates = trpc.accountingV2.configurationList.useQuery({
    businessId,
    namespace: "governorate",
    activeOnly: true,
  });
  const shippingTypes = trpc.accountingV2.configurationList.useQuery({
    businessId,
    namespace: "shipping_type",
    activeOnly: true,
  });
  const paymentTypes = trpc.accountingV2.configurationList.useQuery({
    businessId,
    namespace: "payment_type",
    activeOnly: true,
  });
  const billingEvents = trpc.accountingV2.configurationList.useQuery({
    businessId,
    namespace: "shipping_billing_event",
    activeOnly: true,
  });
  const [shipment, setShipment] = useState({
    orderId: "",
    providerId: "",
    governorate: "",
    shippingType: "",
    paymentType: "",
    externalShipmentId: "",
    trackingNumber: "",
  });
  const [event, setEvent] = useState({
    shipmentId: "",
    providerStatusCode: "",
    normalizedEvent: "",
    collectedAmount: "",
    evidenceUrl: "",
    reason: "",
  });
  const [returnedItems, setReturnedItems] = useState([
    { orderItemId: "", quantity: "1" },
  ]);
  const refresh = () => utils.accountingV2.shippingFinanceData.invalidate();
  const create = trpc.accountingV2.shipmentCreate.useMutation({
    onSuccess: async () => {
      toast.success("تم إنشاء الشحنة وحفظ Expected Charge Snapshots");
      await refresh();
    },
    onError: error => toast.error(error.message),
  });
  const record = trpc.accountingV2.shipmentManualEvent.useMutation({
    onSuccess: async () => {
      toast.success("تم تسجيل الحدث الرسمي وتطبيق أثره");
      await refresh();
    },
    onError: error => toast.error(error.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="h-5 w-5 text-cyan-700" />
          الشحن والأحداث الرسمية
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Field label="Order ID">
            <Input
              type="number"
              dir="ltr"
              value={shipment.orderId}
              onChange={e =>
                setShipment({ ...shipment, orderId: e.target.value })
              }
            />
          </Field>
          <SelectField
            label="شركة الشحن"
            value={shipment.providerId}
            onChange={value => setShipment({ ...shipment, providerId: value })}
            options={
              shipping.data?.providers.map(row => [
                String(row.id),
                row.displayName,
              ]) ?? []
            }
          />
          <SelectField
            label="المحافظة"
            value={shipment.governorate}
            onChange={value => setShipment({ ...shipment, governorate: value })}
            options={options(governorates.data)}
          />
          <SelectField
            label="نوع الشحن"
            value={shipment.shippingType}
            onChange={value =>
              setShipment({ ...shipment, shippingType: value })
            }
            options={options(shippingTypes.data)}
          />
          <SelectField
            label="نوع الدفع"
            value={shipment.paymentType}
            onChange={value => setShipment({ ...shipment, paymentType: value })}
            options={options(paymentTypes.data)}
          />
          <Field label="External Shipment ID">
            <Input
              dir="ltr"
              value={shipment.externalShipmentId}
              onChange={e =>
                setShipment({ ...shipment, externalShipmentId: e.target.value })
              }
            />
          </Field>
          <Field label="Tracking Number">
            <Input
              dir="ltr"
              value={shipment.trackingNumber}
              onChange={e =>
                setShipment({ ...shipment, trackingNumber: e.target.value })
              }
            />
          </Field>
          <Button
            className="self-end"
            disabled={create.isPending}
            onClick={() => {
              if (
                !shipment.orderId ||
                !shipment.providerId ||
                !shipment.governorate ||
                !shipment.shippingType ||
                !shipment.paymentType
              )
                return toast.error("بيانات الشحنة الأساسية مطلوبة");
              create.mutate({
                businessId,
                orderId: Number(shipment.orderId),
                businessShippingProviderId: Number(shipment.providerId),
                governorate: shipment.governorate,
                shippingType: shipment.shippingType,
                paymentType: shipment.paymentType,
                externalShipmentId: shipment.externalShipmentId || undefined,
                trackingNumber: shipment.trackingNumber || undefined,
                occurredAt: new Date(),
              });
            }}
          >
            إنشاء الشحنة
          </Button>
        </div>
        <div className="border-t pt-4">
          <h3 className="mb-3 font-bold">Manual Official Event مع Audit</h3>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <SelectField
              label="الشحنة"
              value={event.shipmentId}
              onChange={value => setEvent({ ...event, shipmentId: value })}
              options={
                finance.data?.shipments.map(row => [
                  String(row.id),
                  `#${row.id} · Order ${row.orderId} · ${row.currentStatus}`,
                ]) ?? []
              }
            />
            <Field label="Provider Status Code">
              <Input
                dir="ltr"
                value={event.providerStatusCode}
                onChange={e =>
                  setEvent({ ...event, providerStatusCode: e.target.value })
                }
              />
            </Field>
            <SelectField
              label="Normalized Event"
              value={event.normalizedEvent}
              onChange={value => setEvent({ ...event, normalizedEvent: value })}
              options={options(billingEvents.data)}
            />
            <Field label="Collected Amount">
              <Input
                dir="ltr"
                inputMode="decimal"
                value={event.collectedAmount}
                onChange={e =>
                  setEvent({ ...event, collectedAmount: e.target.value })
                }
              />
            </Field>
            <EvidenceUpload
              value={event.evidenceUrl}
              onChange={evidenceUrl => setEvent({ ...event, evidenceUrl })}
            />
            <Field label="السبب">
              <Input
                value={event.reason}
                onChange={e => setEvent({ ...event, reason: e.target.value })}
              />
            </Field>
            {["returned", "partial_return"].includes(event.normalizedEvent) && (
              <div className="space-y-2 md:col-span-2 xl:col-span-4">
                <Label>بنود المرتجع</Label>
                {returnedItems.map((item, index) => (
                  <div
                    key={index}
                    className="grid gap-2 md:grid-cols-[1fr_1fr_auto]"
                  >
                    <Input
                      type="number"
                      placeholder="Order Item ID"
                      value={item.orderItemId}
                      onChange={e =>
                        setReturnedItems(rows =>
                          rows.map((row, i) =>
                            i === index
                              ? { ...row, orderItemId: e.target.value }
                              : row
                          )
                        )
                      }
                    />
                    <Input
                      type="number"
                      min="1"
                      placeholder="الكمية"
                      value={item.quantity}
                      onChange={e =>
                        setReturnedItems(rows =>
                          rows.map((row, i) =>
                            i === index
                              ? { ...row, quantity: e.target.value }
                              : row
                          )
                        )
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={returnedItems.length === 1}
                      onClick={() =>
                        setReturnedItems(rows =>
                          rows.filter((_, i) => i !== index)
                        )
                      }
                    >
                      حذف
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setReturnedItems(rows => [
                      ...rows,
                      { orderItemId: "", quantity: "1" },
                    ])
                  }
                >
                  إضافة بند
                </Button>
              </div>
            )}
            <Button
              className="md:col-span-2 xl:col-span-4 xl:justify-self-end"
              disabled={record.isPending}
              onClick={() => {
                const isReturn = ["returned", "partial_return"].includes(
                  event.normalizedEvent
                );
                const returnPayload = isReturn
                  ? returnedItems.map(item => ({
                      orderItemId: Number(item.orderItemId),
                      quantity: Number(item.quantity),
                    }))
                  : undefined;
                if (
                  !event.shipmentId ||
                  !event.providerStatusCode ||
                  !event.normalizedEvent ||
                  !event.evidenceUrl ||
                  event.reason.trim().length < 5 ||
                  (isReturn &&
                    returnPayload!.some(
                      item => !item.orderItemId || item.quantity <= 0
                    ))
                )
                  return toast.error(
                    "بيانات الحدث والسبب والدليل وبنود المرتجع مطلوبة"
                  );
                record.mutate({
                  businessId,
                  shipmentId: Number(event.shipmentId),
                  providerStatusCode: event.providerStatusCode,
                  normalizedEvent: event.normalizedEvent,
                  occurredAt: new Date(),
                  evidenceUrl: event.evidenceUrl,
                  collectedAmount: event.collectedAmount || undefined,
                  returnedItems: returnPayload,
                  reason: event.reason,
                });
              }}
            >
              تسجيل الحدث الرسمي
            </Button>
          </div>
        </div>
        <div className="grid gap-2 lg:grid-cols-2">
          {finance.data?.shipments.map(row => (
            <div key={row.id} className="rounded-lg border p-3 text-sm">
              <div className="flex justify-between">
                <strong>
                  Shipment #{row.id} · Order #{row.orderId}
                </strong>
                <span>{row.currentStatus}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Expected charges:{" "}
                {finance.data.chargeSnapshots
                  .filter(charge => charge.shipmentId === row.id)
                  .reduce(
                    (sum, charge) => sum + Number(charge.expectedAmount),
                    0
                  )
                  .toFixed(4)}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SettlementOperations({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const shipping = trpc.accountingV2.shippingConfiguration.useQuery({
    businessId,
  });
  const finance = trpc.accountingV2.shippingFinanceData.useQuery({
    businessId,
  });
  const accounts = trpc.accountingV2.financialAccounts.useQuery({ businessId });
  const [header, setHeader] = useState({
    providerId: "",
    reference: "",
    statementDate: new Date().toISOString().slice(0, 10),
    evidenceUrl: "",
    targetAccountId: "",
  });
  const [lines, setLines] = useState<SettlementLine[]>([emptySettlementLine()]);
  const refresh = () => utils.accountingV2.shippingFinanceData.invalidate();
  const importMutation = trpc.accountingV2.carrierSettlementImport.useMutation({
    onSuccess: async () => {
      toast.success("تم استيراد الكشف ومطابقة السطور");
      await refresh();
    },
    onError: error => toast.error(error.message),
  });
  const approve = trpc.accountingV2.carrierSettlementApprove.useMutation({
    onSuccess: async () => {
      toast.success("تم اعتماد التسوية وترحيل الصافي والفروق");
      await refresh();
    },
    onError: error => toast.error(error.message),
  });
  const updateLine = (index: number, next: Partial<SettlementLine>) =>
    setLines(current =>
      current.map((line, i) => (i === index ? { ...line, ...next } : line))
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RefreshCw className="h-5 w-5 text-amber-700" />
          Carrier Settlement Statement
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <SelectField
            label="الشركة"
            value={header.providerId}
            onChange={value => setHeader({ ...header, providerId: value })}
            options={
              shipping.data?.providers.map(row => [
                String(row.id),
                row.displayName,
              ]) ?? []
            }
          />
          <Field label="Statement Reference">
            <Input
              value={header.reference}
              onChange={e =>
                setHeader({ ...header, reference: e.target.value })
              }
            />
          </Field>
          <Field label="Statement Date">
            <Input
              type="date"
              value={header.statementDate}
              onChange={e =>
                setHeader({ ...header, statementDate: e.target.value })
              }
            />
          </Field>
          <EvidenceUpload
            label="كشف التسوية"
            value={header.evidenceUrl}
            onChange={evidenceUrl => setHeader({ ...header, evidenceUrl })}
          />
        </div>
        {lines.map((line, index) => (
          <div
            key={index}
            className="grid gap-2 rounded-xl border p-3 md:grid-cols-2 xl:grid-cols-5"
          >
            <Field label="Tracking / External Ref">
              <Input
                dir="ltr"
                value={line.externalReference}
                onChange={e =>
                  updateLine(index, { externalReference: e.target.value })
                }
              />
            </Field>
            <Field label="Gross Collected">
              <Input
                dir="ltr"
                value={line.grossCollected}
                onChange={e =>
                  updateLine(index, { grossCollected: e.target.value })
                }
              />
            </Field>
            <Field label="Actual Charges">
              <Input
                dir="ltr"
                value={line.actualCharges}
                onChange={e =>
                  updateLine(index, { actualCharges: e.target.value })
                }
              />
            </Field>
            <Field label="Net Amount">
              <Input
                dir="ltr"
                value={line.netAmount}
                onChange={e => updateLine(index, { netAmount: e.target.value })}
              />
            </Field>
            <Field label="ملاحظات">
              <Input
                value={line.notes}
                onChange={e => updateLine(index, { notes: e.target.value })}
              />
            </Field>
          </div>
        ))}
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() =>
              setLines(current => [...current, emptySettlementLine()])
            }
          >
            إضافة سطر
          </Button>
          <Button
            onClick={() => {
              if (
                !header.providerId ||
                !header.reference ||
                !header.evidenceUrl ||
                lines.some(
                  line =>
                    !line.externalReference ||
                    !line.grossCollected ||
                    !line.actualCharges ||
                    !line.netAmount
                )
              )
                return toast.error("بيانات الكشف وكل السطور مطلوبة");
              importMutation.mutate({
                businessId,
                businessShippingProviderId: Number(header.providerId),
                reference: header.reference,
                statementDate: new Date(`${header.statementDate}T12:00:00`),
                evidenceUrl: header.evidenceUrl,
                lines: lines.map(line => ({
                  ...line,
                  notes: line.notes || undefined,
                })),
              });
            }}
          >
            استيراد الكشف
          </Button>
        </div>
        <div className="border-t pt-4">
          <SelectField
            label="الحساب المستلم للصافي"
            value={header.targetAccountId}
            onChange={value => setHeader({ ...header, targetAccountId: value })}
            options={
              accounts.data?.map(row => [String(row.id), row.name]) ?? []
            }
          />
          <div className="mt-3 grid gap-2 lg:grid-cols-2">
            {finance.data?.settlements.map(row => (
              <div
                key={row.id}
                className="flex items-center justify-between rounded-lg border p-3 text-sm"
              >
                <span>
                  <strong>Settlement #{row.id}</strong> · {row.reference}
                  <small className="mr-2 text-muted-foreground">
                    {row.status} · Net {row.netTransferred}
                  </small>
                </span>
                {row.status === "matched" && (
                  <Button
                    size="sm"
                    disabled={!header.targetAccountId}
                    onClick={() =>
                      approve.mutate({
                        businessId,
                        settlementId: row.id,
                        targetAccountId: Number(header.targetAccountId),
                      })
                    }
                  >
                    اعتماد
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function OrderPayments({ businessId }: { businessId: number }) {
  const accounts = trpc.accountingV2.financialAccounts.useQuery({ businessId });
  const [form, setForm] = useState({
    mode: "confirm" as "confirm" | "refund",
    orderId: "",
    accountId: "",
    amount: "",
    reference: "",
    evidenceUrl: "",
    reason: "",
  });
  const confirm = trpc.accountingV2.orderPaymentConfirm.useMutation({
    onSuccess: () => toast.success("تم إثبات Payment Confirmed"),
    onError: error => toast.error(error.message),
  });
  const refund = trpc.accountingV2.orderPaymentRefund.useMutation({
    onSuccess: () => toast.success("تم تسجيل Refund مرتبط بالأوردر"),
    onError: error => toast.error(error.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Banknote className="h-5 w-5 text-emerald-700" />
          Non-COD Payment / Refund
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <SelectField
          label="العملية"
          value={form.mode}
          onChange={value =>
            setForm({ ...form, mode: value as typeof form.mode })
          }
          options={[
            ["confirm", "Payment Confirmed"],
            ["refund", "Refund"],
          ]}
        />
        <Field label="Order ID">
          <Input
            type="number"
            dir="ltr"
            value={form.orderId}
            onChange={e => setForm({ ...form, orderId: e.target.value })}
          />
        </Field>
        <SelectField
          label={form.mode === "confirm" ? "الحساب المستلم" : "الحساب المصدر"}
          value={form.accountId}
          onChange={value => setForm({ ...form, accountId: value })}
          options={accounts.data?.map(row => [String(row.id), row.name]) ?? []}
        />
        <Field label="المبلغ">
          <Input
            dir="ltr"
            inputMode="decimal"
            value={form.amount}
            onChange={e => setForm({ ...form, amount: e.target.value })}
          />
        </Field>
        <Field label="المرجع">
          <Input
            value={form.reference}
            onChange={e => setForm({ ...form, reference: e.target.value })}
          />
        </Field>
        <EvidenceUpload
          value={form.evidenceUrl}
          onChange={evidenceUrl => setForm({ ...form, evidenceUrl })}
        />
        {form.mode === "refund" && (
          <Field label="سبب الاسترداد">
            <Input
              value={form.reason}
              onChange={e => setForm({ ...form, reason: e.target.value })}
            />
          </Field>
        )}
        <Button
          className="self-end"
          onClick={() => {
            if (
              !form.orderId ||
              !form.accountId ||
              !form.amount ||
              !form.reference ||
              !form.evidenceUrl
            )
              return toast.error("كل بيانات العملية والدليل مطلوبة");
            if (form.mode === "confirm")
              confirm.mutate({
                businessId,
                orderId: Number(form.orderId),
                targetAccountId: Number(form.accountId),
                amount: form.amount,
                paymentReference: form.reference,
                confirmedAt: new Date(),
                evidenceUrl: form.evidenceUrl,
              });
            else if (form.reason.trim().length >= 5)
              refund.mutate({
                businessId,
                orderId: Number(form.orderId),
                sourceAccountId: Number(form.accountId),
                amount: form.amount,
                refundReference: form.reference,
                refundedAt: new Date(),
                reason: form.reason,
                evidenceUrl: form.evidenceUrl,
              });
            else toast.error("سبب الاسترداد مطلوب");
          }}
        >
          {form.mode === "confirm" ? "تأكيد الدفع" : "تسجيل الاسترداد"}
        </Button>
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  className = "",
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1 ${className}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <Field label={label}>
      <select
        className="h-10 w-full rounded-md border bg-background px-3 text-sm"
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        <option value="">اختار</option>
        {options.map(([key, name]) => (
          <option key={key} value={key}>
            {name}
          </option>
        ))}
      </select>
    </Field>
  );
}
function options(
  rows: Array<{ configKey: string; displayName: string }> | undefined
): Array<[string, string]> {
  return rows?.map(row => [row.configKey, row.displayName]) ?? [];
}
