import { useEffect, useMemo, useState } from "react";
import { ClipboardCheck, PackageCheck, Send, Truck } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";
import { useBusinessContext } from "@/contexts/BusinessContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EvidenceUpload } from "@/components/EvidenceUpload";

type ReceiptLine = {
  productId: string;
  variantId: string;
  quantity: string;
  unitCost: string;
};
type OpeningInTransitLine = {
  orderItemId: number;
  productName: string;
  quantity: number;
  unitCostSnapshot: string;
};
const emptyLine = (): ReceiptLine => ({
  productId: "",
  variantId: "",
  quantity: "1",
  unitCost: "",
});

export function InventoryAccountingSection() {
  const { businesses } = useBusinessContext();
  const [businessId, setBusinessId] = useState<number>();
  useEffect(() => {
    if (!businessId && businesses[0]) setBusinessId(businesses[0].id);
  }, [businessId, businesses]);
  return (
    <div className="space-y-4" dir="rtl">
      <Card className="border-orange-900/10 bg-gradient-to-l from-orange-950 to-slate-950 text-white">
        <CardContent className="flex flex-col gap-3 p-5 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-bold tracking-[0.2em] text-orange-300">
              INVENTORY COST CONTROL
            </p>
            <h2 className="mt-1 text-2xl font-black">المخزون المحاسبي</h2>
            <p className="text-sm text-slate-300">
              Moving Average، حجز، Stock Out وفحص المرتجعات.
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
          <OrderInventoryActions businessId={businessId} />
          <PurchaseReceipts businessId={businessId} />
          <ReturnInspections businessId={businessId} />
          <InventoryBalances businessId={businessId} />
        </>
      )}
    </div>
  );
}

function OrderInventoryActions({ businessId }: { businessId: number }) {
  const warehouses = trpc.businesses.warehouses.useQuery({ businessId });
  const shipping = trpc.accountingV2.shippingConfiguration.useQuery({
    businessId,
  });
  const [orderId, setOrderId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [opening, setOpening] = useState({
    providerId: "",
    currentStatus: "",
    externalShipmentId: "",
    trackingNumber: "",
    dispatchedAt: new Date().toISOString().slice(0, 10),
  });
  const [openingLines, setOpeningLines] = useState<OpeningInTransitLine[]>([]);
  const openingOrder = trpc.orders.get.useQuery(
    { id: Number(orderId) },
    { enabled: Number(orderId) > 0 }
  );
  useEffect(() => {
    const order = openingOrder.data;
    if (!order || order.businessId !== businessId) {
      setOpeningLines([]);
      return;
    }
    setOpeningLines(
      order.items.map(item => ({
        orderItemId: item.id,
        productName: item.productName,
        quantity: item.quantity,
        unitCostSnapshot: item.unitCostSnapshot ?? "",
      }))
    );
  }, [businessId, openingOrder.data]);
  const reserve = trpc.accountingV2.inventoryReserve.useMutation({
    onSuccess: () => toast.success("تم حجز الكميات من غير خصم المخزون"),
    onError: error => toast.error(error.message),
  });
  const dispatch = trpc.accountingV2.inventoryDispatch.useMutation({
    onSuccess: () => toast.success("تم Stock Out وتثبيت Unit Cost Snapshot"),
    onError: error => toast.error(error.message),
  });
  const openingInTransit = trpc.accountingV2.openingInTransitRecord.useMutation(
    {
      onSuccess: () =>
        toast.success("تم تسجيل Opening In-Transit بالـ Cost Snapshots"),
      onError: error => toast.error(error.message),
    }
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="h-5 w-5 text-orange-700" />
          حجز وتسليم الأوردر لشركة الشحن
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto_auto] md:items-end">
          <Field label="Order ID">
            <Input
              dir="ltr"
              type="number"
              value={orderId}
              onChange={event => setOrderId(event.target.value)}
            />
          </Field>
          <Field label="المخزن">
            <select
              className="h-10 w-full rounded-md border bg-background px-3"
              value={warehouseId}
              onChange={event => setWarehouseId(event.target.value)}
            >
              <option value="">اختار</option>
              {warehouses.data?.map(row => (
                <option key={row.id} value={row.id}>
                  {row.name}
                </option>
              ))}
            </select>
          </Field>
          <Button
            variant="outline"
            disabled={reserve.isPending}
            onClick={() =>
              orderId &&
              warehouseId &&
              reserve.mutate({
                businessId,
                orderId: Number(orderId),
                warehouseId: Number(warehouseId),
              })
            }
          >
            حجز المخزون
          </Button>
          <Button
            disabled={dispatch.isPending}
            onClick={() =>
              orderId &&
              dispatch.mutate({
                businessId,
                orderId: Number(orderId),
                occurredAt: new Date(),
              })
            }
          >
            Stock Out / Dispatch
          </Button>
        </div>
        <div className="border-t pt-4">
          <h3 className="mb-3 font-bold">Opening In-Transit</h3>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <SelectField
              label="شركة الشحن"
              value={opening.providerId}
              onChange={providerId => setOpening({ ...opening, providerId })}
              options={
                shipping.data?.providers.map(row => [
                  String(row.id),
                  row.displayName,
                ]) ?? []
              }
            />
            <Field label="الحالة الحالية">
              <Input
                value={opening.currentStatus}
                onChange={event =>
                  setOpening({ ...opening, currentStatus: event.target.value })
                }
              />
            </Field>
            <Field label="External Shipment ID">
              <Input
                dir="ltr"
                value={opening.externalShipmentId}
                onChange={event =>
                  setOpening({
                    ...opening,
                    externalShipmentId: event.target.value,
                  })
                }
              />
            </Field>
            <Field label="Tracking Number">
              <Input
                dir="ltr"
                value={opening.trackingNumber}
                onChange={event =>
                  setOpening({ ...opening, trackingNumber: event.target.value })
                }
              />
            </Field>
            <Field label="تاريخ الخروج">
              <Input
                type="date"
                value={opening.dispatchedAt}
                onChange={event =>
                  setOpening({ ...opening, dispatchedAt: event.target.value })
                }
              />
            </Field>
            <div className="space-y-2 md:col-span-2 xl:col-span-4">
              <Label>بنود الشحنة وتكلفة الخروج الافتتاحية</Label>
              {openingOrder.isLoading ? (
                <p className="rounded-md border p-3 text-sm text-muted-foreground">
                  جاري تحميل بنود الأوردر...
                </p>
              ) : openingLines.length === 0 ? (
                <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                  اكتب Order ID صحيح تابع للنشاط عشان تظهر البنود هنا.
                </p>
              ) : (
                <div className="space-y-2">
                  {openingLines.map((line, index) => (
                    <div
                      className="grid gap-2 rounded-md border p-3 md:grid-cols-[1fr_120px_180px] md:items-end"
                      key={line.orderItemId}
                    >
                      <div>
                        <p className="text-sm font-semibold">
                          {line.productName}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Order Item #{line.orderItemId}
                        </p>
                      </div>
                      <Field label="الكمية">
                        <Input value={line.quantity} disabled />
                      </Field>
                      <Field label="تكلفة الوحدة وقت الخروج">
                        <Input
                          dir="ltr"
                          inputMode="decimal"
                          value={line.unitCostSnapshot}
                          onChange={event =>
                            setOpeningLines(current =>
                              current.map((row, rowIndex) =>
                                rowIndex === index
                                  ? {
                                      ...row,
                                      unitCostSnapshot: event.target.value,
                                    }
                                  : row
                              )
                            )
                          }
                        />
                      </Field>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <Button
              className="md:col-span-2 xl:col-span-4 xl:justify-self-end"
              disabled={openingInTransit.isPending}
              onClick={() => {
                if (
                  !orderId ||
                  !opening.providerId ||
                  !opening.currentStatus ||
                  openingLines.length === 0 ||
                  openingLines.some(
                    line => !/^\d+(\.\d{1,4})?$/.test(line.unitCostSnapshot)
                  )
                )
                  return toast.error(
                    "بيانات Opening In-Transit وتكلفة كل بند مطلوبة"
                  );
                openingInTransit.mutate({
                  businessId,
                  orderId: Number(orderId),
                  businessShippingProviderId: Number(opening.providerId),
                  externalShipmentId: opening.externalShipmentId || undefined,
                  trackingNumber: opening.trackingNumber || undefined,
                  currentStatus: opening.currentStatus,
                  dispatchedAt: new Date(`${opening.dispatchedAt}T12:00:00`),
                  items: openingLines.map(
                    ({ orderItemId, quantity, unitCostSnapshot }) => ({
                      orderItemId,
                      quantity,
                      unitCostSnapshot,
                    })
                  ),
                });
              }}
            >
              تسجيل Opening In-Transit
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PurchaseReceipts({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const control = trpc.accountingV2.inventoryControlData.useQuery({
    businessId,
  });
  const warehouses = trpc.businesses.warehouses.useQuery({ businessId });
  const products = trpc.products.list.useQuery({
    businessIds: [businessId],
    includeInactive: false,
  });
  const variants = trpc.variants.all.useQuery({
    businessIds: [businessId],
    includeInactive: false,
  });
  const receiptTypes = trpc.accountingV2.configurationList.useQuery({
    businessId,
    namespace: "inventory_receipt_type",
    activeOnly: true,
  });
  const [header, setHeader] = useState({
    warehouseId: "",
    receiptType: "",
    supplierName: "",
    reference: "",
    receiptDate: new Date().toISOString().slice(0, 10),
    evidenceUrl: "",
    reason: "",
  });
  const [lines, setLines] = useState<ReceiptLine[]>([emptyLine()]);
  const refresh = () => utils.accountingV2.inventoryControlData.invalidate();
  const create = trpc.accountingV2.purchaseReceiptCreate.useMutation({
    onSuccess: async () => {
      toast.success("تم إنشاء مسودة الاستلام");
      setLines([emptyLine()]);
      await refresh();
    },
    onError: error => toast.error(error.message),
  });
  const submit = trpc.accountingV2.purchaseReceiptSubmit.useMutation({
    onSuccess: async () => {
      toast.success("تم الإرسال للاعتماد");
      await refresh();
    },
    onError: error => toast.error(error.message),
  });
  const approve = trpc.accountingV2.purchaseReceiptApprove.useMutation({
    onSuccess: async () => {
      toast.success("تم الاعتماد وتحديث Moving Average");
      await refresh();
    },
    onError: error => toast.error(error.message),
  });
  const updateLine = (index: number, next: Partial<ReceiptLine>) =>
    setLines(current =>
      current.map((line, i) => (i === index ? { ...line, ...next } : line))
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PackageCheck className="h-5 w-5 text-emerald-700" />
          Purchase Receipt / Opening Inventory
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <SelectField
            label="المخزن"
            value={header.warehouseId}
            onChange={value => setHeader({ ...header, warehouseId: value })}
            options={
              warehouses.data?.map(row => [String(row.id), row.name]) ?? []
            }
          />
          <SelectField
            label="نوع الاستلام"
            value={header.receiptType}
            onChange={value => setHeader({ ...header, receiptType: value })}
            options={
              receiptTypes.data?.map(row => [row.configKey, row.displayName]) ??
              []
            }
          />
          <Field label="المورد / المصدر">
            <Input
              value={header.supplierName}
              onChange={event =>
                setHeader({ ...header, supplierName: event.target.value })
              }
            />
          </Field>
          <Field label="التاريخ">
            <Input
              type="date"
              value={header.receiptDate}
              onChange={event =>
                setHeader({ ...header, receiptDate: event.target.value })
              }
            />
          </Field>
          <Field label="المرجع">
            <Input
              value={header.reference}
              onChange={event =>
                setHeader({ ...header, reference: event.target.value })
              }
            />
          </Field>
          <EvidenceUpload
            value={header.evidenceUrl}
            onChange={evidenceUrl => setHeader({ ...header, evidenceUrl })}
          />
          <Field label="سبب الاستثناء" className="md:col-span-2">
            <Textarea
              value={header.reason}
              onChange={event =>
                setHeader({ ...header, reason: event.target.value })
              }
            />
          </Field>
        </div>
        <div className="space-y-2">
          {lines.map((line, index) => {
            const productVariants =
              variants.data?.filter(
                (variant: any) => variant.productId === Number(line.productId)
              ) ?? [];
            return (
              <div
                key={index}
                className="grid gap-2 rounded-xl border p-3 md:grid-cols-4"
              >
                <SelectField
                  label="المنتج"
                  value={line.productId}
                  onChange={value =>
                    updateLine(index, { productId: value, variantId: "" })
                  }
                  options={
                    products.data?.map((row: any) => [
                      String(row.id),
                      row.name,
                    ]) ?? []
                  }
                />
                <SelectField
                  label="Variant اختياري"
                  value={line.variantId}
                  onChange={value => updateLine(index, { variantId: value })}
                  options={productVariants.map((row: any) => [
                    String(row.id),
                    row.name || row.sku || `#${row.id}`,
                  ])}
                />
                <Field label="الكمية">
                  <Input
                    type="number"
                    dir="ltr"
                    value={line.quantity}
                    onChange={event =>
                      updateLine(index, { quantity: event.target.value })
                    }
                  />
                </Field>
                <Field label="Unit Cost">
                  <Input
                    inputMode="decimal"
                    dir="ltr"
                    value={line.unitCost}
                    onChange={event =>
                      updateLine(index, { unitCost: event.target.value })
                    }
                  />
                </Field>
              </div>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => setLines(current => [...current, emptyLine()])}
          >
            إضافة بند
          </Button>
          <Button
            onClick={() => {
              if (
                !header.warehouseId ||
                !header.receiptType ||
                !header.supplierName.trim() ||
                !header.evidenceUrl.trim() ||
                lines.some(
                  line =>
                    !line.productId || !line.quantity || line.unitCost === ""
                )
              )
                return toast.error(
                  "الهيدر وكل بنود الاستلام والتكلفة والدليل مطلوبة"
                );
              create.mutate({
                businessId,
                warehouseId: Number(header.warehouseId),
                receiptType: header.receiptType,
                supplierName: header.supplierName.trim(),
                reference: header.reference || undefined,
                receiptDate: new Date(`${header.receiptDate}T12:00:00`),
                evidenceUrl: header.evidenceUrl.trim(),
                reason: header.reason || undefined,
                items: lines.map(line => ({
                  productId: Number(line.productId),
                  variantId: line.variantId
                    ? Number(line.variantId)
                    : undefined,
                  quantity: Number(line.quantity),
                  unitCost: line.unitCost,
                })),
              });
            }}
          >
            إنشاء المسودة
          </Button>
        </div>
        <div className="grid gap-2 lg:grid-cols-2">
          {control.data?.receipts.map(row => (
            <div
              key={row.id}
              className="flex items-center justify-between rounded-lg border p-3 text-sm"
            >
              <span>
                <strong>Receipt #{row.id}</strong> · {row.receiptType}
                <small className="mr-2 text-muted-foreground">
                  {row.status} · {row.totalAmount}
                </small>
              </span>
              <span className="flex gap-1">
                {row.status === "draft" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      submit.mutate({ businessId, receiptId: row.id })
                    }
                  >
                    <Send className="ml-1 h-3.5 w-3.5" />
                    إرسال
                  </Button>
                )}
                {row.status === "pending_approval" && (
                  <Button
                    size="sm"
                    onClick={() =>
                      approve.mutate({ businessId, receiptId: row.id })
                    }
                  >
                    <ClipboardCheck className="ml-1 h-3.5 w-3.5" />
                    اعتماد
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ReturnInspections({ businessId }: { businessId: number }) {
  const utils = trpc.useUtils();
  const control = trpc.accountingV2.inventoryControlData.useQuery({
    businessId,
  });
  const warehouses = trpc.businesses.warehouses.useQuery({ businessId });
  const [warehouseId, setWarehouseId] = useState("");
  const submit = trpc.accountingV2.returnInspectionSubmit.useMutation({
    onSuccess: async () => {
      toast.success("تم إرسال نتيجة الفحص للاعتماد");
      await utils.accountingV2.inventoryControlData.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const approve = trpc.accountingV2.returnInspectionApprove.useMutation({
    onSuccess: async () => {
      toast.success("تم اعتماد الفحص ومعالجة المخزون/الخسارة");
      await utils.accountingV2.inventoryControlData.invalidate();
    },
    onError: error => toast.error(error.message),
  });
  const pending =
    control.data?.inspections.filter(row => row.status !== "approved") ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Returned Pending Inspection</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <SelectField
          label="مخزن إعادة الصالح"
          value={warehouseId}
          onChange={setWarehouseId}
          options={
            warehouses.data?.map(row => [String(row.id), row.name]) ?? []
          }
        />
        {!pending.length ? (
          <p className="text-sm text-muted-foreground">
            لا توجد مرتجعات معلقة للفحص.
          </p>
        ) : (
          pending.map(inspection => (
            <InspectionRow
              key={inspection.id}
              inspection={inspection}
              items={
                control.data?.returnOrderItems.filter(
                  item =>
                    item.orderId === inspection.orderId &&
                    item.returnedQuantity > 0
                ) ?? []
              }
              warehouseId={warehouseId}
              onSubmit={items =>
                submit.mutate({
                  businessId,
                  inspectionId: inspection.id,
                  receivedAt: new Date(),
                  items,
                })
              }
              onApprove={() =>
                approve.mutate({
                  businessId,
                  inspectionId: inspection.id,
                  warehouseId: Number(warehouseId),
                  occurredAt: new Date(),
                })
              }
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function InspectionRow({
  inspection,
  items,
  warehouseId,
  onSubmit,
  onApprove,
}: {
  inspection: any;
  items: any[];
  warehouseId: string;
  onSubmit: (
    items: Array<{
      orderItemId: number;
      quantity: number;
      disposition: "restock" | "scrap" | "missing";
      reason?: string;
    }>
  ) => void;
  onApprove: () => void;
}) {
  const [decisions, setDecisions] = useState<
    Record<
      number,
      {
        quantity: string;
        disposition: "restock" | "scrap" | "missing";
        reason: string;
      }
    >
  >({});
  const decision = (item: any) =>
    decisions[item.id] ?? {
      quantity: String(item.returnedQuantity),
      disposition: "restock" as const,
      reason: "",
    };
  return (
    <div className="rounded-xl border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <strong>Inspection #{inspection.id}</strong> · Order #
          {inspection.orderId} · {inspection.status}
        </span>
        {inspection.status === "pending_approval" && (
          <Button size="sm" disabled={!warehouseId} onClick={onApprove}>
            اعتماد الفحص
          </Button>
        )}
      </div>
      {inspection.status === "pending" && (
        <div className="mt-3 space-y-2">
          {items.map(item => {
            const current = decision(item);
            return (
              <div
                key={item.id}
                className="grid gap-2 rounded-lg bg-muted/30 p-2 md:grid-cols-[1fr_100px_150px_2fr]"
              >
                <span className="self-center text-sm">
                  Order Item #{item.id}
                </span>
                <Input
                  type="number"
                  dir="ltr"
                  value={current.quantity}
                  onChange={event =>
                    setDecisions({
                      ...decisions,
                      [item.id]: { ...current, quantity: event.target.value },
                    })
                  }
                />
                <select
                  className="h-10 rounded-md border bg-background px-2 text-sm"
                  value={current.disposition}
                  onChange={event =>
                    setDecisions({
                      ...decisions,
                      [item.id]: {
                        ...current,
                        disposition: event.target
                          .value as typeof current.disposition,
                      },
                    })
                  }
                >
                  <option value="restock">صالح للبيع</option>
                  <option value="scrap">Scrap / تالف</option>
                  <option value="missing">مفقود</option>
                </select>
                <Input
                  placeholder="سبب التلف أو الفقد"
                  value={current.reason}
                  onChange={event =>
                    setDecisions({
                      ...decisions,
                      [item.id]: { ...current, reason: event.target.value },
                    })
                  }
                />
              </div>
            );
          })}
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                const payload = items.map(item => ({
                  orderItemId: item.id,
                  quantity: Number(decision(item).quantity),
                  disposition: decision(item).disposition,
                  reason: decision(item).reason || undefined,
                }));
                if (
                  payload.some(
                    row =>
                      row.quantity <= 0 ||
                      (row.disposition !== "restock" && !row.reason)
                  )
                )
                  return toast.error("الكمية وسبب التلف/الفقد مطلوبين");
                onSubmit(payload);
              }}
            >
              إرسال نتيجة الفحص
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function InventoryBalances({ businessId }: { businessId: number }) {
  const control = trpc.accountingV2.inventoryControlData.useQuery({
    businessId,
  });
  const totalValue = useMemo(
    () =>
      control.data?.balances.reduce(
        (sum, row) => sum + Number(row.inventoryValue),
        0
      ) ?? 0,
    [control.data]
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">أرصدة Moving Average</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-3 text-sm text-muted-foreground">
          إجمالي قيمة المخزون:{" "}
          <strong dir="ltr">{totalValue.toFixed(4)}</strong>
        </p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {control.data?.balances.map(row => (
            <div key={row.id} className="rounded-lg border p-3 text-sm">
              <strong className="font-mono text-xs">{row.inventoryKey}</strong>
              <div className="mt-2 flex justify-between">
                <span>On hand: {row.onHandQuantity}</span>
                <span>Reserved: {row.reservedQuantity}</span>
              </div>
              <div className="mt-1 flex justify-between text-muted-foreground">
                <span>MA: {row.movingAverageCost}</span>
                <span>Value: {row.inventoryValue}</span>
              </div>
            </div>
          ))}
        </div>
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
        onChange={event => onChange(event.target.value)}
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
