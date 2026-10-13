import { and, desc, eq, inArray, like, sql } from "drizzle-orm";
import { businesses, employees } from "../drizzle/schema";
import { ledgerCarrierReviewItems, ledgerSettings, ledgerShipments } from "../drizzle/ledgerPhases.schema";
import { LedgerError, type LedgerActor } from "../shared/ledgerV3Core";
import { LEDGER_SETTINGS, settingDef, validateSettingValue, type SettingValues } from "../shared/ledgerSettings";
import { rawRows, resolveDb, type LedgerDb } from "./ledgerV3.service";

/**
 * المرحلة 3 (بعد 0047) — ربط أوردر↔شحنة موحّد، طابور مراجعة دائم، وإعدادات مُدخلة. كل دالة تتحقق أولًا من وجود جداول 0047:
 * غيابها = سلوك ما قبل 0047 كما هو (لا ربط ولا طابور، والإعدادات «غير متاحة») — لا خطأ ولا سقوط على V1/V2.
 */
export const CARRIER_OPS_TABLES = ["ledger_shipments", "ledger_carrier_review_items", "ledger_settings"] as const;

export async function tablesPresent(d: LedgerDb, names: readonly string[]): Promise<boolean> {
  const rows = rawRows(await d.execute(sql`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${sql.join(names.map(n => sql`${n}`), sql`, `)})`));
  return Number(rows[0]?.n ?? 0) === names.length;
}
export const carrierOpsAvailable = (d: LedgerDb) => tablesPresent(d, CARRIER_OPS_TABLES);

const isDup = (err: unknown) => { for (let e: any = err, i = 0; e && i < 6; e = e.cause, i++) if (e.code === "ER_DUP_ENTRY") return true; return false; };

// ───────────── الإعدادات ─────────────

export async function getCarrierSettingValues(d: LedgerDb, tenantId: number, businessId: number | null = null): Promise<SettingValues> {
  if (!(await carrierOpsAvailable(d))) return {};
  const rows = await d.select().from(ledgerSettings).where(and(eq(ledgerSettings.tenantId, tenantId), inArray(ledgerSettings.scopeBusinessId, businessId ? [0, businessId] : [0])));
  const out: SettingValues = {};
  // قيمة النشاط تتقدم على قيمة الشركة لنفس المفتاح
  for (const r of [...rows].sort((a, b) => a.scopeBusinessId - b.scopeBusinessId)) out[r.settingKey] = r.valueInt ?? (r.valueDecimal == null ? undefined : String(r.valueDecimal));
  return out;
}

export async function listLedgerSettings(tenantId: number, db?: LedgerDb) {
  const d = await resolveDb(db);
  if (!(await carrierOpsAvailable(d))) return { available: false as const, settings: [], businesses: [] };
  const rows = await d.select({ s: ledgerSettings, by: employees.name }).from(ledgerSettings)
    .leftJoin(employees, eq(employees.id, ledgerSettings.updatedByEmployeeId)).where(eq(ledgerSettings.tenantId, tenantId));
  const bizRows = await d.select({ id: businesses.id, name: businesses.name }).from(businesses).where(eq(businesses.tenantId, tenantId));
  return {
    available: true as const,
    businesses: bizRows,
    settings: LEDGER_SETTINGS.map(def => ({
      ...def,
      values: rows.filter(r => r.s.settingKey === def.key).map(r => ({
        scopeBusinessId: r.s.scopeBusinessId, value: r.s.valueInt ?? (r.s.valueDecimal == null ? null : String(r.s.valueDecimal)), updatedBy: r.by ?? null, updatedAt: r.s.updatedAt,
      })),
    })),
  };
}

/** إدخال/تعديل إعداد (موظف فقط). نطاق النشاط يجب أن يكون نشاطًا في نفس الشركة؛ إعداد الشركة scope = 0. */
export async function setLedgerSetting(input: { tenantId: number; key: string; scopeBusinessId: number; value: string | number; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  if (!(await carrierOpsAvailable(d))) throw new LedgerError("unavailable");
  if (input.actor.type !== "employee") throw new LedgerError("actorEmployee");
  const def = settingDef(input.key);
  if (!def) throw new LedgerError("setting", `إعداد غير معروف: ${input.key}`);
  if (def.scope === "company" && input.scopeBusinessId !== 0) throw new LedgerError("setting", "هذا الإعداد للشركة كلها");
  if (def.scope === "business") {
    const [b] = await d.select({ id: businesses.id }).from(businesses).where(and(eq(businesses.id, input.scopeBusinessId), eq(businesses.tenantId, input.tenantId))).limit(1);
    if (!b) throw new LedgerError("business", `#${input.scopeBusinessId}`);
  }
  const v = validateSettingValue(def, input.value);
  if ("error" in v) throw new LedgerError("setting", v.error);
  await d.insert(ledgerSettings).values({ tenantId: input.tenantId, scopeBusinessId: input.scopeBusinessId, settingKey: def.key, ...v, updatedByEmployeeId: input.actor.employeeId })
    .onDuplicateKeyUpdate({ set: { valueDecimal: v.valueDecimal, valueInt: v.valueInt, updatedByEmployeeId: input.actor.employeeId } });
  return { key: def.key, scopeBusinessId: input.scopeBusinessId, ...v };
}

/** حذف إعداد = يعود «غير مُدخل» (لا صفر). */
export async function clearLedgerSetting(input: { tenantId: number; key: string; scopeBusinessId: number }, db?: LedgerDb) {
  const d = await resolveDb(db);
  if (!(await carrierOpsAvailable(d))) throw new LedgerError("unavailable");
  await d.delete(ledgerSettings).where(and(eq(ledgerSettings.tenantId, input.tenantId), eq(ledgerSettings.scopeBusinessId, input.scopeBusinessId), eq(ledgerSettings.settingKey, input.key)));
}

// ───────────── طابور المراجعة ─────────────

export type ReviewSource = "delivery" | "settlement" | "payout";

/**
 * تسجيل عنصر مراجعة بمفتاح ثابت: نفس المفتاح مرة أخرى = تحديث السبب (لا تكرار). عنصر «محلول» يعود مفتوحًا إن تكررت المشكلة؛
 * «مستبعد» (قرار واعٍ بالتجاهل) يبقى مستبعدًا. لا يرمي — الطابور لا يُسقط العملية الأصلية.
 */
export async function recordCarrierReview(d: LedgerDb, input: { tenantId: number; businessId?: number | null; source: ReviewSource; referenceKey: string; orderId?: number | null; shipmentId?: string | null; reason: string }) {
  try {
    if (!(await carrierOpsAvailable(d))) return;
    const reason = input.reason.trim().slice(0, 500);
    await d.insert(ledgerCarrierReviewItems).values({ tenantId: input.tenantId, businessId: input.businessId ?? null, source: input.source, referenceKey: input.referenceKey.slice(0, 191),
      orderId: input.orderId ?? null, shipmentId: input.shipmentId ?? null, reason })
      .onDuplicateKeyUpdate({ set: {
        reason,
        status: sql`IF(${ledgerCarrierReviewItems.status} = 'dismissed', 'dismissed', 'open')`,
        resolvedByEmployeeId: sql`IF(${ledgerCarrierReviewItems.status} = 'dismissed', ${ledgerCarrierReviewItems.resolvedByEmployeeId}, NULL)`,
        resolvedAt: sql`IF(${ledgerCarrierReviewItems.status} = 'dismissed', ${ledgerCarrierReviewItems.resolvedAt}, NULL)`,
        resolutionNote: sql`IF(${ledgerCarrierReviewItems.status} = 'dismissed', ${ledgerCarrierReviewItems.resolutionNote}, NULL)`,
      } });
  } catch { /* الطابور لا يُسقط العملية */ }
}

/** إغلاق تلقائي لعناصر مفتوحة بنمط مفتاح بعد نجاح العملية لاحقًا — فقط بفاعل موظف (الحل يتطلب فاعلًا مسجلًا). */
export async function autoResolveCarrierReviews(d: LedgerDb, tenantId: number, keyLike: string, actor: LedgerActor, note: string) {
  if (actor.type !== "employee") return;
  try {
    if (!(await carrierOpsAvailable(d))) return;
    await d.update(ledgerCarrierReviewItems).set({ status: "resolved", resolvedByEmployeeId: actor.employeeId, resolvedAt: new Date(), resolutionNote: note.slice(0, 500) })
      .where(and(eq(ledgerCarrierReviewItems.tenantId, tenantId), eq(ledgerCarrierReviewItems.status, "open"), like(ledgerCarrierReviewItems.referenceKey, keyLike)));
  } catch { /* لا يُسقط العملية */ }
}

export async function listCarrierReviews(tenantId: number, status: "open" | "closed", db?: LedgerDb) {
  const d = await resolveDb(db);
  if (!(await carrierOpsAvailable(d))) return { available: false as const, items: [] };
  const rows = await d.select().from(ledgerCarrierReviewItems)
    .where(and(eq(ledgerCarrierReviewItems.tenantId, tenantId), status === "open" ? eq(ledgerCarrierReviewItems.status, "open") : inArray(ledgerCarrierReviewItems.status, ["resolved", "dismissed"])))
    .orderBy(desc(ledgerCarrierReviewItems.createdAt), desc(ledgerCarrierReviewItems.id)).limit(200);
  return { available: true as const, items: rows };
}

/** حل/استبعاد بسبب مكتوب وفاعل موظف — مرة واحدة (العنصر المغلق لا يُغلق مرة أخرى). */
export async function resolveCarrierReview(input: { tenantId: number; id: number; status: "resolved" | "dismissed"; note: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  if (!(await carrierOpsAvailable(d))) throw new LedgerError("unavailable");
  if (input.actor.type !== "employee") throw new LedgerError("actorEmployee");
  if (!input.note || input.note.trim().length < 3) throw new LedgerError("reason");
  const r: any = await d.update(ledgerCarrierReviewItems).set({ status: input.status, resolvedByEmployeeId: input.actor.employeeId, resolvedAt: new Date(), resolutionNote: input.note.trim().slice(0, 500) })
    .where(and(eq(ledgerCarrierReviewItems.id, input.id), eq(ledgerCarrierReviewItems.tenantId, input.tenantId), eq(ledgerCarrierReviewItems.status, "open")));
  const affected = Number((Array.isArray(r) ? r[0] : r)?.affectedRows ?? 0);
  if (affected !== 1) throw new LedgerError("transaction", "عنصر المراجعة غير موجود أو مغلق بالفعل");
}

// ───────────── ربط أوردر↔شحنة ─────────────

/**
 * حجز الربط قبل أي قيد: شحنة واحدة ↔ أوردر واحد لكل شركة شحن (فهرسان فريدان). نفس الزوج = ok؛ الشحنة مربوطة بأوردر آخر أو
 * الأوردر بشحنة أخرى = conflict برسالة واضحة (والمتصل يحوّلها لمراجعة بلا قيد). بلا جداول 0047 = ok (سلوك ما قبل 0047).
 */
export async function claimShipmentLink(d: LedgerDb, input: { tenantId: number; businessId: number; orderId: number; shipmentId: string }): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!(await carrierOpsAvailable(d))) return { ok: true };
  const read = async () => d.select().from(ledgerShipments).where(and(eq(ledgerShipments.tenantId, input.tenantId), eq(ledgerShipments.carrier, "bosta"),
    sql`(${ledgerShipments.shipmentId} = ${input.shipmentId} OR ${ledgerShipments.orderId} = ${input.orderId})`));
  const check = (rows: (typeof ledgerShipments.$inferSelect)[]) => {
    for (const r of rows) {
      if (r.shipmentId === input.shipmentId && r.orderId !== input.orderId) return { ok: false as const, reason: `الشحنة ${input.shipmentId} مربوطة بأوردر آخر (#${r.orderId}) — لا قيد مخمّن` };
      if (r.orderId === input.orderId && r.shipmentId !== input.shipmentId) return { ok: false as const, reason: `الأوردر مربوط بشحنة أخرى (${r.shipmentId}) — لا قيد مخمّن` };
    }
    return null;
  };
  const pre = check(await read());
  if (pre) return pre;
  try {
    await d.insert(ledgerShipments).values({ tenantId: input.tenantId, businessId: input.businessId, orderId: input.orderId, carrier: "bosta", shipmentId: input.shipmentId });
  } catch (err) {
    if (!isDup(err)) throw err;
    const post = check(await read());
    if (post) return post;
  }
  return { ok: true };
}

/** الأوردر المربوط بشحنة (إن وُجد ربط) — للتسوية قبل البحث في الأوردرات. */
export async function linkedOrderForShipment(d: LedgerDb, tenantId: number, shipmentId: string): Promise<{ orderId: number; businessId: number } | null> {
  if (!(await carrierOpsAvailable(d))) return null;
  const [r] = await d.select({ orderId: ledgerShipments.orderId, businessId: ledgerShipments.businessId }).from(ledgerShipments)
    .where(and(eq(ledgerShipments.tenantId, tenantId), eq(ledgerShipments.carrier, "bosta"), eq(ledgerShipments.shipmentId, shipmentId))).limit(1);
  return r ?? null;
}
