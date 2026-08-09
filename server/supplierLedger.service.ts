import { createHash } from "crypto";
import { and, desc, eq, inArray, like } from "drizzle-orm";
import {
  businessConfigurationValues,
  businessEvents,
  purchaseReceipts,
} from "../drizzle/schema";
import {
  buildStatement,
  summariseStatement,
  summariseSuppliers,
  type SupplierMovement,
  type SupplierMovementType,
} from "../shared/supplierLedger";
import {
  createBusinessEventInTransaction,
  type Actor,
} from "./accountingV2.service";
import { addTreasuryTransactionInTransaction, getDb } from "./db";

/**
 * كشف حساب المصنع — **مشتق، مش مخزّن**.
 *
 * مفيش جدول أرصدة ولا عمود رصيد. الكشف بيتبني كل مرة من نفس الأحداث اللي المخزون
 * والخزنة بيتحركوا بيها:
 *
 *   استلام بضاعة   ←  `inventory.purchase_received`   (موجود من قبل الميزة دي)
 *   إلغاء استلام   ←  `inventory.purchase_reversed`   (موجود من قبل الميزة دي)
 *   دفعة / مرتجع / تشطيب / افتتاحي / تسوية  ←  أحداث `supplier.*` جديدة
 *
 * يعني مستحيل رصيد المصنع يختلف عن الواقع، لأنه **هو** الواقع مقروء بطريقة تانية. ولو
 * كان فيه جدول أرصدة، أي حدث بينجح وتحديث الرصيد بيفشل كان بيسيب رقمين مختلفين للأبد.
 *
 * والمصنع نفسه صف في `business_configuration_values` — نفس الجدول اللي فيه المحافظات
 * ومنصات الإعلانات. **فمفيش migration ولا جدول جديد.**
 */

export const SUPPLIER_NAMESPACE = "supplier";
export const SUPPLIER_NAME_MAP_NAMESPACE = "supplier_name_map";

/** أحداث الحساب الجاري وترجمتها لنوع حركة. */
const SUPPLIER_EVENTS: Record<string, SupplierMovementType> = {
  "supplier.payment": "payment",
  "supplier.return_credit": "return_credit",
  "supplier.rework_fee": "rework_fee",
  "supplier.opening_balance": "opening_balance",
  "supplier.adjustment": "adjustment",
};

export type SupplierProfile = {
  key: string;
  name: string;
  phone: string | null;
  notes: string | null;
  /** الافتراضي لمرتجعات المصنع ده — وينفع يتغيّر على الحركة نفسها. */
  returnMode: "credit" | "rework";
  isActive: boolean;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toProfile(row: typeof businessConfigurationValues.$inferSelect): SupplierProfile {
  const extra = parseJson<Record<string, any>>(row.valueJson, {});
  return {
    key: row.configKey,
    name: row.displayName,
    phone: extra.phone ?? null,
    notes: extra.notes ?? null,
    returnMode: extra.returnMode === "rework" ? "rework" : "credit",
    isActive: row.isActive,
  };
}

/**
 * مفتاح ثابت لاسم تاريخي.
 *
 * الهاش مش عشان السرية — عشان الطول. `configKey` عرضه ١٠٠ حرف، واسم المصنع ممكن يعدّيه
 * أو يبقى فيه محارف تكسر المفتاح. الاسم الأصلي بيتحفظ كامل في `displayName`.
 */
function historicalKey(name: string): string {
  return `map-${createHash("sha1").update(name).digest("hex").slice(0, 32)}`;
}

// ───────────────────────── المصانع ─────────────────────────

export async function listSuppliers(businessId: number): Promise<SupplierProfile[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(businessConfigurationValues)
    .where(
      and(
        eq(businessConfigurationValues.businessId, businessId),
        eq(businessConfigurationValues.namespace, SUPPLIER_NAMESPACE)
      )
    );
  return rows.map(toProfile).sort((a, b) => a.name.localeCompare(b.name, "ar"));
}

export async function saveSupplier(input: {
  businessId: number;
  key?: string;
  name: string;
  phone?: string;
  notes?: string;
  returnMode?: "credit" | "rework";
  isActive?: boolean;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const name = input.name.trim();
  if (!name) throw new Error("اسم المصنع مطلوب");
  // المفتاح بيتولّد مرة واحدة وبيفضل ثابت: الأحداث بتشاور عليه، فتغييره بيقطع الكشف.
  const key = input.key ?? historicalKey(name).replace("map-", "sup-");
  const valueJson = JSON.stringify({
    phone: input.phone?.trim() || null,
    notes: input.notes?.trim() || null,
    returnMode: input.returnMode ?? "credit",
  });
  await db
    .insert(businessConfigurationValues)
    .values({
      businessId: input.businessId,
      namespace: SUPPLIER_NAMESPACE,
      configKey: key,
      displayName: name,
      valueJson,
      isActive: input.isActive ?? true,
      createdBy: input.actor.id,
      updatedBy: input.actor.id,
    })
    .onDuplicateKeyUpdate({
      set: {
        displayName: name,
        valueJson,
        isActive: input.isActive ?? true,
        updatedBy: input.actor.id,
      },
    });
  return { key };
}

// ───────────────────────── ربط الأسماء القديمة ─────────────────────────

/**
 * الأسماء اللي في الإذونات القديمة، وكل واحد مربوط بمين.
 *
 * `purchase_receipts.supplierName` نص حر — «مصنع النحاس» و«مصنع نحاس» صفّين مختلفين
 * ومحدش يقدر يقول إن دول نفس المصنع غير المالك. **مفيش أي مطابقة تقريبية هنا**: الدالة
 * بترجّع الأسماء زي ما هي ومعاها الربط الموجود (لو فيه)، والباقي بيفضل `null` لحد ما
 * المالك يقرر.
 */
export async function listHistoricalSupplierNames(businessId: number) {
  const db = await getDb();
  if (!db) return [];
  const receipts = await db
    .select({
      name: purchaseReceipts.supplierName,
      total: purchaseReceipts.totalAmount,
    })
    .from(purchaseReceipts)
    .where(eq(purchaseReceipts.businessId, businessId));

  const byName = new Map<string, { receipts: number; total: number }>();
  for (const row of receipts) {
    const name = (row.name ?? "").trim();
    if (!name) continue;
    const current = byName.get(name) ?? { receipts: 0, total: 0 };
    current.receipts += 1;
    current.total += Number(row.total ?? 0);
    byName.set(name, current);
  }

  const mappings = await db
    .select()
    .from(businessConfigurationValues)
    .where(
      and(
        eq(businessConfigurationValues.businessId, businessId),
        eq(businessConfigurationValues.namespace, SUPPLIER_NAME_MAP_NAMESPACE)
      )
    );
  const mapped = new Map(
    mappings.map(row => [
      row.displayName,
      parseJson<{ supplierKey?: string }>(row.valueJson, {}).supplierKey ?? null,
    ])
  );

  return [...byName.entries()]
    .map(([name, stats]) => ({
      historicalName: name,
      receipts: stats.receipts,
      totalValue: stats.total,
      // `undefined` معناها «لسه ماتسألش عنه»، و`null` معناها «اتسأل ومفيش ربط».
      mappedTo: mapped.has(name) ? mapped.get(name) : null,
      isMapped: mapped.has(name),
    }))
    .sort((a, b) => b.totalValue - a.totalValue);
}

/** ربط اسم تاريخي بمصنع — قرار المالك، بيتخزّن ومابيتخمّنش. */
export async function mapHistoricalSupplierName(input: {
  businessId: number;
  historicalName: string;
  supplierKey: string;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const name = input.historicalName.trim();
  if (!name) throw new Error("الاسم القديم مطلوب");
  const suppliers = await listSuppliers(input.businessId);
  if (!suppliers.some(supplier => supplier.key === input.supplierKey))
    throw new Error("المصنع مش موجود");

  const valueJson = JSON.stringify({ supplierKey: input.supplierKey });
  await db
    .insert(businessConfigurationValues)
    .values({
      businessId: input.businessId,
      namespace: SUPPLIER_NAME_MAP_NAMESPACE,
      configKey: historicalKey(name),
      displayName: name,
      valueJson,
      createdBy: input.actor.id,
      updatedBy: input.actor.id,
    })
    .onDuplicateKeyUpdate({
      set: { valueJson, displayName: name, updatedBy: input.actor.id },
    });
  return { historicalName: name, supplierKey: input.supplierKey };
}

/** خريطة الاسم القديم ← مفتاح المصنع. الأسماء غير المربوطة **مش** في الخريطة. */
async function nameToKeyMap(businessId: number): Promise<Map<string, string>> {
  const db = await getDb();
  if (!db) return new Map();
  const rows = await db
    .select()
    .from(businessConfigurationValues)
    .where(
      and(
        eq(businessConfigurationValues.businessId, businessId),
        eq(businessConfigurationValues.namespace, SUPPLIER_NAME_MAP_NAMESPACE)
      )
    );
  const map = new Map<string, string>();
  for (const row of rows) {
    const key = parseJson<{ supplierKey?: string }>(row.valueJson, {}).supplierKey;
    if (key) map.set(row.displayName, key);
  }
  return map;
}

// ───────────────────────── تسجيل الحركات ─────────────────────────

/** المبلغ كنص بأربع خانات — نفس دقة أعمدة الفلوس في المشروع. */
const money = (value: number) => value.toFixed(4);

async function recordSupplierEvent(input: {
  businessId: number;
  supplierKey: string;
  eventType: keyof typeof SUPPLIER_EVENTS;
  amount: number;
  occurredAt: Date;
  reference?: string;
  notes?: string;
  idempotencySuffix: string;
  actor: Actor;
  /** بيتنفّذ جوه نفس الترانزاكشن بعد الحدث — للخزنة. */
  alsoInTransaction?: (tx: any, eventId: number) => Promise<void>;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.transaction(async tx => {
    const event = await createBusinessEventInTransaction(tx, {
      businessId: input.businessId,
      eventType: input.eventType,
      sourceType: "supplier",
      sourceReference: input.supplierKey,
      idempotencyKey: `supplier:${input.supplierKey}:${input.idempotencySuffix}`,
      occurredAt: input.occurredAt,
      payload: {
        supplierKey: input.supplierKey,
        amount: money(input.amount),
        reference: input.reference ?? null,
        notes: input.notes ?? null,
      },
      actor: input.actor,
    });
    // النداء التاني بنفس المفتاح بيرجع من هنا — من غير حركة خزنة تانية.
    if (event.duplicate)
      throw new Error("الحركة دي متسجّلة خلاص — مش هتتسجّل مرتين");

    await input.alsoInTransaction?.(tx, event.event.id);
    return { eventId: event.event.id };
  });
}

/**
 * دفعة للمصنع.
 *
 * **مش مصروف.** الدفعة تسوية لدَيْن قايم، والتكلفة اتسجّلت خلاص وقت استلام البضاعة —
 * فتسجيلها في `expenses` كان هيحسب نفس الجنيه مرتين: مرة في تكلفة البضاعة ومرة كمصروف
 * تشغيلي. عشان كده المسار ده مابيلمسش `expenses` ولا `expense_payments` خالص.
 *
 * بيعمل حاجتين بس، في ترانزاكشن واحدة: حدث `supplier.payment`، وحركة خزنة خارجة.
 */
export async function recordSupplierPayment(input: {
  businessId: number;
  supplierKey: string;
  amount: number;
  paidAt: Date;
  reference?: string;
  notes?: string;
  actor: Actor;
}) {
  if (!(input.amount > 0)) throw new Error("المبلغ لازم يكون أكبر من صفر");
  const dayKey = input.paidAt.toISOString().slice(0, 10);
  return recordSupplierEvent({
    ...input,
    eventType: "supplier.payment",
    occurredAt: input.paidAt,
    // نفس المصنع ونفس اليوم ونفس المبلغ ونفس المرجع = دوسة مكررة. مرجع مختلف =
    // دفعتين حقيقيتين، ودي مسموحة.
    idempotencySuffix: `payment:${dayKey}:${money(input.amount)}:${input.reference ?? ""}`,
    alsoInTransaction: async tx => {
      const treasury = await addTreasuryTransactionInTransaction(tx, {
        businessId: input.businessId,
        type: "withdrawal",
        direction: "out",
        amount: money(input.amount),
        description: `دفعة لمصنع`,
        notes: input.notes ?? null,
        referenceType: "manual",
        referenceId: null,
        performedBy: input.actor.id,
        performedByName: input.actor.name,
        transactionDate: input.paidAt,
      });
      if (!treasury)
        throw new Error("تعذر تسجيل حركة الخزنة — الدفعة اترجعت");
    },
  });
}

/** مرتجع بيتخصم من حساب المصنع (النوع أ). المخزون بيتحرّك في مساره الموجود. */
export async function recordSupplierReturnCredit(input: {
  businessId: number;
  supplierKey: string;
  amount: number;
  occurredAt: Date;
  reference?: string;
  notes?: string;
  actor: Actor;
}) {
  if (!(input.amount > 0)) throw new Error("القيمة لازم تكون أكبر من صفر");
  return recordSupplierEvent({
    ...input,
    eventType: "supplier.return_credit",
    idempotencySuffix: `return:${input.reference ?? input.occurredAt.toISOString()}:${money(input.amount)}`,
  });
}

/**
 * تكلفة إعادة التشطيب (النوع ب) — **لما تستحق**، مش لما البضاعة تتحرّك.
 *
 * تحويل القطع للمصنع للتشطيب حركة مخزون وبس. الدَّيْن مايتغيّرش عشان قطعة اتنقلت، ومايقلّش
 * عشان رجعت. اللي بيغيّر الدَّيْن هو الرسم نفسه لما التاجر يقرّ إنه مستحق.
 */
export async function recordReworkFee(input: {
  businessId: number;
  supplierKey: string;
  amount: number;
  occurredAt: Date;
  reference?: string;
  notes?: string;
  actor: Actor;
}) {
  if (!(input.amount > 0)) throw new Error("التكلفة لازم تكون أكبر من صفر");
  return recordSupplierEvent({
    ...input,
    eventType: "supplier.rework_fee",
    idempotencySuffix: `rework:${input.reference ?? input.occurredAt.toISOString()}:${money(input.amount)}`,
  });
}

/**
 * رصيد افتتاحي — للمالك بس.
 *
 * حدث زي أي حدث: مابيخلقش بضاعة في المخزون ولا فلوس في الخزنة. الإشارة بتيجي مع المبلغ:
 * موجب = عليك للمصنع، سالب = ليك عنده.
 *
 * **مرة واحدة لكل مصنع.** المفتاح ثابت (`opening`) فالنداء التاني بيترفض. التصحيح
 * بيتعمل بتسوية، مش بإعادة كتابة التاريخ.
 */
export async function recordOpeningBalance(input: {
  businessId: number;
  supplierKey: string;
  /** موجب = عليك للمصنع · سالب = ليك عند المصنع */
  amount: number;
  occurredAt: Date;
  notes?: string;
  actor: Actor;
}) {
  if (input.amount === 0) throw new Error("الرصيد الافتتاحي ماينفعش يكون صفر");
  return recordSupplierEvent({
    ...input,
    eventType: "supplier.opening_balance",
    idempotencySuffix: "opening",
  });
}

/** تسوية يدوية — للمالك بس، والإشارة بتيجي مع المبلغ. */
export async function recordSupplierAdjustment(input: {
  businessId: number;
  supplierKey: string;
  amount: number;
  occurredAt: Date;
  reference?: string;
  notes?: string;
  actor: Actor;
}) {
  if (input.amount === 0) throw new Error("التسوية ماينفعش تكون صفر");
  if (!input.notes?.trim())
    throw new Error("سبب التسوية مطلوب — التسوية من غير سبب مابتتراجعش");
  return recordSupplierEvent({
    ...input,
    eventType: "supplier.adjustment",
    idempotencySuffix: `adjustment:${input.occurredAt.toISOString()}:${money(input.amount)}`,
  });
}

// ───────────────────────── القراءة ─────────────────────────

/**
 * كل حركات مصنع واحد — من الأحداث ومن الإذونات.
 *
 * الاستلام والإلغاء بيتقروا من الأحداث (دي اللي بتقول «ده حصل إمتى»)، والقيمة والاسم
 * من `purchase_receipts` (ده اللي بيقول «بكام ومن مين»). الإذن المسودة مالوش حدث اعتماد،
 * فمستحيل يظهر في الكشف — وده اللي بيضمن إن المسودة مالهاش أثر.
 */
async function collectMovements(
  businessId: number,
  supplierKey: string
): Promise<SupplierMovement[]> {
  const db = await getDb();
  if (!db) return [];

  const [receiptEvents, supplierEventRows, nameMap] = await Promise.all([
    db
      .select()
      .from(businessEvents)
      .where(
        and(
          eq(businessEvents.businessId, businessId),
          inArray(businessEvents.eventType, [
            "inventory.purchase_received",
            "inventory.purchase_reversed",
          ])
        )
      ),
    db
      .select()
      .from(businessEvents)
      .where(
        and(
          eq(businessEvents.businessId, businessId),
          inArray(businessEvents.eventType, Object.keys(SUPPLIER_EVENTS)),
          // تضييق على مستوى قاعدة البيانات، والتأكيد بيتعمل بعد الـparse تحت.
          like(businessEvents.payloadJson, `%"supplierKey":"${supplierKey}"%`)
        )
      ),
    nameToKeyMap(businessId),
  ]);

  const movements: SupplierMovement[] = [];

  // ── الاستلام والإلغاء ──
  const receiptIds = new Set<number>();
  for (const event of receiptEvents) {
    const payload = parseJson<{ receiptId?: number }>(event.payloadJson, {});
    if (payload.receiptId) receiptIds.add(payload.receiptId);
  }
  const receipts = receiptIds.size
    ? await db
        .select()
        .from(purchaseReceipts)
        .where(inArray(purchaseReceipts.id, [...receiptIds]))
    : [];
  const receiptById = new Map(receipts.map(row => [row.id, row]));
  const suppliers = await listSuppliers(businessId);
  const canonicalNames = new Map(suppliers.map(s => [s.name, s.key]));

  for (const event of receiptEvents) {
    const payload = parseJson<{ receiptId?: number }>(event.payloadJson, {});
    const receipt = payload.receiptId ? receiptById.get(payload.receiptId) : undefined;
    if (!receipt) continue;
    const name = (receipt.supplierName ?? "").trim();
    // الربط الصريح الأول، وبعدين تطابق الاسم الكامل — ودي مش مطابقة تقريبية: الإذن
    // الجديد بيتسجّل باسم المصنع نفسه من القايمة، فالتطابق هنا هوية مش تخمين.
    const key = nameMap.get(name) ?? canonicalNames.get(name);
    if (key !== supplierKey) continue;
    movements.push({
      id: event.id,
      type:
        event.eventType === "inventory.purchase_reversed"
          ? "receipt_reversed"
          : "goods_received",
      occurredAt: event.occurredAt,
      amount: Number(receipt.totalAmount ?? 0),
      reference: receipt.reference ?? null,
      description:
        event.eventType === "inventory.purchase_reversed"
          ? `إلغاء إذن ${receipt.reference}`
          : `إذن ${receipt.reference}`,
      createdByName: event.createdByName,
      createdAt: event.createdAt,
    });
  }

  // ── أحداث الحساب الجاري ──
  for (const event of supplierEventRows) {
    const payload = parseJson<{
      supplierKey?: string;
      amount?: string;
      reference?: string | null;
      notes?: string | null;
    }>(event.payloadJson, {});
    if (payload.supplierKey !== supplierKey) continue;
    const type = SUPPLIER_EVENTS[event.eventType];
    if (!type) continue;
    movements.push({
      id: event.id,
      type,
      occurredAt: event.occurredAt,
      amount: Number(payload.amount ?? 0),
      reference: payload.reference ?? null,
      description: payload.notes ?? "",
      createdByName: event.createdByName,
      createdAt: event.createdAt,
    });
  }

  return movements;
}

export async function getSupplierStatement(input: {
  businessId: number;
  supplierKey: string;
  dateFrom?: Date;
  dateTo?: Date;
  movementType?: SupplierMovementType;
  search?: string;
}) {
  const movements = await collectMovements(input.businessId, input.supplierKey);
  // الكشف كامل الأول: الرصيد قبل/بعد لازم يتحسب من أول حركة، وإلا الفلتر بيخلي أول
  // سطر معروض يبدأ من صفر وهو مش صفر.
  const full = buildStatement(movements);
  const totals = summariseStatement(full);

  const search = input.search?.trim().toLowerCase();
  const rows = full.filter(row => {
    if (input.dateFrom && row.occurredAt < input.dateFrom) return false;
    if (input.dateTo && row.occurredAt >= input.dateTo) return false;
    if (input.movementType && row.type !== input.movementType) return false;
    if (search) {
      const haystack = `${row.reference ?? ""} ${row.description}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  const suppliers = await listSuppliers(input.businessId);
  return {
    supplier: suppliers.find(s => s.key === input.supplierKey) ?? null,
    rows,
    totals,
  };
}

/** ملخّص كل المصانع — لشاشة القايمة وللوحة. نفس المحرّك، مفيش رقم تاني متخزّن. */
export async function getSupplierSummaries(businessId: number) {
  const suppliers = await listSuppliers(businessId);
  const summaries = await Promise.all(
    suppliers.map(async supplier => {
      const movements = await collectMovements(businessId, supplier.key);
      const totals = summariseStatement(buildStatement(movements));
      return { ...supplier, ...totals };
    })
  );
  return summaries;
}

export async function getSupplierDashboardTotals(businessIds: number[] | null) {
  if (!businessIds || businessIds.length === 0)
    return { owedToFactories: 0, owedByFactories: 0, net: 0, suppliers: 0 };
  const perBusiness = await Promise.all(
    businessIds.map(id => getSupplierSummaries(id))
  );
  const all = perBusiness.flat();
  return {
    ...summariseSuppliers(all.map(row => row.balance)),
    suppliers: all.length,
  };
}
