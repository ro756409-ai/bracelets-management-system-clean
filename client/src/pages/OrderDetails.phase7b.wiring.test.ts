/**
 * المرحلة 7B — حارس نصّي لصفحة تفاصيل الأوردر: الاستعلامات/الـmutations/الحوارات القديمة كلها باقية،
 * الإضافات محصورة في إجراءات الأوردر المعلنة (تأكيد/إلغاء/تأجيل/لم يرد + سجل التعديلات الحقيقي)،
 * بوابات الصلاحية على كل إجراء، تعطيل أثناء isPending، حارس الضغط المكرر، ولا تنبؤات/أرقام وهمية.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const page = strip(readFileSync(path.join(root, "pages/OrderDetails.tsx"), "utf8"));
const bar = strip(readFileSync(path.join(root, "components/orders/OrderActionBar.tsx"), "utf8"));
const dialogs = strip(readFileSync(path.join(root, "components/orders/OrderActionDialogs.tsx"), "utf8"));
const routers = readFileSync(path.resolve(__dirname, "../../../server/routers.ts"), "utf8");

/** ما كان في الصفحة قبل 7B (commit 4518027) — لا حذف */
const HOOKS_BEFORE = [
  "trpc.orders.get.useQuery", "trpc.carrierAccounts.status.useQuery", "trpc.products.list.useQuery", "trpc.employees.activeList.useQuery",
  "trpc.orders.sendToBosta.useMutation", "trpc.orders.editOrder.useMutation", "trpc.variants.all.useQuery", "trpc.orders.orderItems.useQuery",
  "trpc.orders.editOrderItems.useMutation",
];
/** الإضافات المعلنة في 7B — كلها endpoints موجودة فعلًا على السيرفر (protectedProcedure + requireOwned) */
const HOOKS_ADDED = [
  "trpc.orders.getEditHistory.useQuery", "trpc.orders.confirm.useMutation", "trpc.orders.cancel.useMutation",
  "trpc.orders.postpone.useMutation", "trpc.orders.markNoAnswer.useMutation",
];

describe("🔌 Queries/Mutations قبل ⊆ بعد، والإضافات معلنة فقط", () => {
  const used = [...page.matchAll(/trpc\.[a-zA-Z.]+\.use(Query|Mutation)/g)].map(m => m[0]);
  it("كل hooks ما قبل 7B باقية بنفس الترتيب النسبي", () => {
    const idx = HOOKS_BEFORE.map(h => used.indexOf(h));
    for (const [i, h] of HOOKS_BEFORE.entries()) expect(idx[i], h).toBeGreaterThanOrEqual(0);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
  it("لا hook غير المعلن (قبل + الإضافات الخمس)؛ ولا تكرار", () => {
    expect(new Set(used).size).toBe(used.length);
    expect([...used].sort()).toEqual([...HOOKS_BEFORE, ...HOOKS_ADDED].sort());
  });
  it("الإضافات موجودة على السيرفر كما هي (لا تغيير backend): protectedProcedure + requireOwned", () => {
    for (const p of ["confirm", "cancel", "postpone", "markNoAnswer", "getEditHistory"]) {
      const i = routers.indexOf(`    ${p}: protectedProcedure`);
      expect(i, p).toBeGreaterThan(0);
      expect(routers.slice(i, i + 700)).toContain('requireOwned(ctx, "order", input.orderId)');
    }
    expect(routers).toContain("    sendToBosta: adminProcedure");
  });
  it("قواعد الإدخال كما في صفحة الأوردرات: سبب الإلغاء إلزامي، تاريخ التأجيل إلزامي، محاولات «لم يرد» اختيارية 1–20", () => {
    expect(dialogs).toContain("disabled={!reason || pending}");
    expect(dialogs).toContain("disabled={!date || pending}");
    expect(dialogs).toContain('useOperationalOptions("cancellation_reason")');
    expect(dialogs).toContain("callAttempts: attempts ? Number(attempts) : undefined");
    expect(dialogs).toContain("min={1} max={20}");
    expect(page).toContain("cancelMutation.mutate({ orderId, cancelReason: v.cancelReason, notes: v.notes, operationId: operationIdFor(`cancel:${orderId}`) }");
    expect(page).toContain("postponeMutation.mutate({ orderId, postponedTo: v.postponedTo, notes: v.notes, operationId: operationIdFor(`postpone:${orderId}`) }");
    expect(page).toContain("noAnswerMutation.mutate({ orderId, callAttempts: v.callAttempts, operationId: operationIdFor(`no_answer:${orderId}`) }");
  });
});

describe("🗂️ الحوارات والمحررات القديمة باقية", () => {
  it("OrderEditDialog بنفس الاستيراد ونفس allowItemsEdit؛ محرر البنود وتعديل الهيدر المضمّن (handleSave) باقيان", () => {
    expect(page).toContain('from "@/components/orders/OrderEditDialog"');
    expect(page).toContain("<OrderEditDialog");
    expect(page).toContain("allowItemsEdit={canEditItems}");
    expect(page).toContain('usePermission("orders.edit_items")');
    expect(page).toContain("editItemsMutation.mutateAsync({");
    expect(page).toContain("const handleSave = () => {");
    expect(page).toContain("editMutation.mutate(updates);");
    expect(page).toContain("setShowItemsEditor(true)");
  });
  it("حوارات الإجراءات الثلاثة مركّبة مرة واحدة، وشريط الإجراءات مرة واحدة", () => {
    for (const d of ["<CancelOrderDialog", "<PostponeOrderDialog", "<NoAnswerDialog", "<OrderActionBar"]) {
      expect((page.match(new RegExp(d, "g")) ?? []).length, d).toBe(1);
    }
  });
  it("تحكمات Bosta كما هي: ديبوزيت + المبلغ + طباعة AWB + معاينة الصورة + بوابة canSend", () => {
    for (const s of ['data-testid="bosta-deposit-toggle"', 'data-testid="bosta-deposit-amount"', "/bosta-awb", "<BostaShipmentImagePreview orderId={order.id} />", "bostaCanSend", "sendToBostaMutation.isPending || !bostaCanSend"]) {
      expect(page, s).toContain(s);
    }
    expect(page).toContain("depositAmount: bostaDeposit ? Math.max(1, Number(bostaDepositAmount) || 0) : undefined");
  });
});

describe("🔐 الصلاحيات والتعطيل وحارس الضغط المكرر", () => {
  it("كل إجراء خلف بوابة: المالك (admin) أو الصلاحية المقابلة لبوابة السيرفر للموظف (confirm/cancel/update)", () => {
    expect(page).toContain('const canConfirm = isAdmin || has("orders.confirm");');
    expect(page).toContain('const canCancel = isAdmin || has("orders.cancel");');
    expect(page).toContain('const canPostpone = isAdmin || has("orders.update");');
    expect(page).toContain('const canNoAnswer = isAdmin || has("orders.update");');
    // بوابات السيرفر للموظف كما هي
    expect(routers).toContain('confirm: requireEmployeeTenantPermission("orders.confirm")');
    expect(routers).toContain('cancel: requireEmployeeTenantPermission("orders.cancel")');
    expect(routers).toContain('postpone: requireEmployeeTenantPermission("orders.update")');
    expect(routers).toContain('markNoAnswer: requireEmployeeTenantPermission("orders.update")');
  });
  it("الحالة القابلة للإجراء = new/postponed فقط (نفس isActionable في الجدول)؛ التأكيد عبر createInFlightGuard", () => {
    expect(page).toContain('import { isActionable, money, paymentLabel, COLLECTION_STATUS } from "@/components/orders/OrdersTable"');
    expect(page).toContain("actionable={isActionable(order as any)}");
    expect(page).toContain("createInFlightGuard<number>()");
    expect(page).toContain("confirmGuard.run(orderId, confirmMutation.isPending, done => confirmMutation.mutate({ orderId, operationId: operationIdFor(`confirm:${orderId}`) }, { onSettled: done }))");
  });
  it("كل أزرار الشريط disabled={pending.any} وما ليس مسموحًا لا يُرسم (شرط && قبل الزر)", () => {
    const buttons = bar.match(/<Button\b(?:=>|[^>])*>/gs) ?? [];
    expect(buttons.length).toBe(5); // تأكيد/إلغاء/تأجيل/لم يرد/المزيد — واتساب عبر WhatsAppButton المشترك
    expect(bar).toContain("<WhatsAppButton phone={phone}");
    for (const b of buttons) { expect(b, b.slice(0, 60)).toContain("disabled={pending.any}"); expect(b, b.slice(0, 60)).toContain("min-h-11"); }
    for (const s of ["showConfirm && (", "showCancel && (", "showPostpone && (", "showNoAnswer && (", "more.length > 0 && ("]) expect(bar, s).toContain(s);
    expect(page).toContain("any: anyPending");
    expect(page).toContain("const anyPending = confirmMutation.isPending || cancelMutation.isPending || postponeMutation.isPending || noAnswerMutation.isPending || sendToBostaMutation.isPending || editMutation.isPending || editItemsMutation.isPending;");
  });
  it("الشريط ثابت أسفل الموبايل فوق MobileBottomNav (56px + safe-area) وعادي على md+", () => {
    // المرحلة 8: الشريط يرتكز على --bottom-nav-h (57px + safe-area) لا على 3.5rem — فلا فجوة 6px عند 90%
    expect(bar).toContain("fixed inset-x-0 bottom-[var(--bottom-nav-h,0px)] z-30");
    expect(bar).not.toContain("3.5rem");
    expect(bar).toContain("md:static");
    expect(page).toContain("pb-[128px] md:pb-0"); // مساحة سفلية بالبكسل (صفّان × 44px + حشو) حتى لا يغطي الشريط آخر قسم عند 90%
  });
});

describe("📋 الأقسام الثمانية ومصادر القيم", () => {
  it("ثمانية أقسام بمعرّفات ثابتة بالترتيب المطلوب", () => {
    const ids = [...page.matchAll(/testId="od-section-([a-z-]+)"/g)].map(m => m[1]);
    expect(ids).toEqual(["identity", "customer", "items", "prices", "shipping", "assignment", "review", "log"]);
  });
  it("الحالة والمصدر من StatusBadge؛ شعار الشريك فقط عند مصدر/ناقل حقيقي (sourceLogo + bostaShipmentId)", () => {
    expect(page).toContain('<StatusBadge status={order.status} kind="order"');
    expect(page).toContain('<StatusBadge status={order.source} kind="source"');
    expect(page).toContain("sourceLogo(order.source)");
    expect(page).toContain('order.bostaShipmentId ? <PartnerLogo partner="bosta"');
    expect((page.match(/partner="bosta"/g) ?? []).length).toBe(1);
  });
  it("لا تنبؤ ولا موعد توصيل مخترع: ReceiptPrediction بـnull، AttemptsCell توصيل null، «غير متاح» حاضر؛ محاولات الاتصال لا تُعرض كتوصيل", () => {
    expect(page).toContain("<ReceiptPrediction probability={null}");
    expect(page).toContain("deliveryAttempts={null}");
    expect(page).toContain("callAttempts={(order as any).noAnswerCallAttempts ?? null}");
    expect(page).toContain("UNAVAILABLE_LABEL");
    expect(page).not.toMatch(/expectedDelivery|deliveryEta|probability=\{\s*\d/);
  });
  it("الأسعار من حقول الأوردر فقط (totalAmount / shippingFees / projectedShippingCostSnapshot / paymentLabel / COLLECTION_STATUS)", () => {
    for (const s of ["money(order.totalAmount)", "order.shippingFees", "projectedShippingCostSnapshot", "paymentLabel(order as any)", "COLLECTION_STATUS["]) expect(page, s).toContain(s);
  });
  it("البنود لكل قطعة من items (variantName / color / size) — نفس التركيب القديم؛ لا دمج", () => {
    expect(page).toContain("it.variantName || [it.color, it.size].filter(Boolean).join(' / ')");
    expect(page).toContain("(order as any).items.map((it: any");
  });
  it("قسم المراجعة من حقول حقيقية فقط: needsReview/reviewReason/isDuplicate + جودة بيانات محسوبة بـisValidEgyptianMobile", () => {
    expect(page).toContain('import { OrderEditDialog, isValidEgyptianMobile, type OrderEditSavePayload } from "@/components/orders/OrderEditDialog"');
    for (const s of ["order.needsReview", "order.reviewReason", "order.isDuplicate", "isValidEgyptianMobile(order.customerPhone"]) expect(page, s).toContain(s);
  });
  it("سجل الإجراءات من orders.getEditHistory (مصدر حقيقي) مع Loading/Error/Empty", () => {
    expect(page).toContain("trpc.orders.getEditHistory.useQuery({ orderId }, { enabled: orderId > 0 })");
    expect(page).toContain("editedByName");
  });
  it("لا businessId ثابت ولا نص «أفندي/أساور»", () => {
    expect(page).not.toMatch(/businessId:\s*\d/);
    expect(page).not.toMatch(/afandy|أفندي|الأساور|أسورة|اساور/);
  });
  it("حالات مشتركة: LoadingSkeleton/ErrorState/EmptyState/OfflineState/PermissionDeniedState", () => {
    for (const c of ["<LoadingSkeleton", "<ErrorState", "<EmptyState", "<OfflineState", "<PermissionDeniedState"]) expect(page, c).toContain(c);
    expect(page).toContain("useOnlineStatus()");
  });
  it("أهداف اللمس: كل Button في الصفحة min-h-11 (أو داخل OrderActionBar)", () => {
    const buttons = page.match(/<Button\b(?:=>|[^>])*>/gs) ?? [];
    expect(buttons.length).toBeGreaterThan(4);
    for (const b of buttons) expect(b, b.slice(0, 80)).toMatch(/min-h-11/);
  });
});
