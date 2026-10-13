import { and, eq, inArray, or, sql } from "drizzle-orm";
import { businesses, orders } from "../drizzle/schema";
import { ledgerAccounts, ledgerTransactions } from "../drizzle/ledgerV3.schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { signed, type SettlementLine } from "../shared/carrierSettlement";
import { LedgerError, type LedgerActor } from "../shared/ledgerV3Core";
import { getLedgerStatus, postLedgerTransaction, rawRows, resolveDb, type LedgerDb } from "./ledgerV3.service";
import { autoResolveCarrierReviews, getCarrierSettingValues, linkedOrderForShipment, recordCarrierReview } from "./ledgerCarrierOps.service";
import { expectedCarrierFees, nextPayoutDate, sameToPiaster } from "../shared/ledgerSettings";
import { businessDateKey } from "../shared/businessTime";

/**
 * المرحلة 3 — تسوية كشف شركة الشحن في Ledger V3 (بلا جدول جديد):
 *  • كل سطر شحنة = قيد بمفتاح دائم `bosta-settle:<shipment>:cod|fees` ⇒ نفس الشحنة لا تُسوّى مرتين أبدًا (كشف آخر = تعارض
 *    مرفوض، نفس الكشف = replay). سطر التحصيل: دائن ذمة COD بالتحصيل، مدين رسوم الشحن بالرسوم، والصافي إلى «قيد الصرف».
 *    سطر رسوم فقط (مرتجع): مدين الرسوم / دائن «قيد الصرف».
 *  • لا تخمين: شحنة بلا أوردر، أو بأكثر من أوردر، أو بلا قيد تسليم، أو بمبلغ تحصيل ≠ المسجّل عند التسليم = مراجعة بلا قيد.
 *  • أوردر ارتد قبل التسوية (عُكس تسليمه) والكشف يثبت التحصيل ⇒ السطر يُسوّى مقابل «مبالغ مستحقة للعملاء» (التزام رد).
 *  • التحويل الفعلي (`bosta-payout:<ref>`) خطوة منفصلة بتاريخها، ويُقبل فقط إن ساوى صافي الكشف المسجّل حرفيًا.
 *  • بعد 0047: الشحنة تُطابق أولًا بربط أوردر↔شحنة الموحّد؛ كل مراجعة تدخل طابورًا دائمًا (`settle:<ref>:<shipment>`،
 *    `payout:<ref>`) ويُغلق تلقائيًا عند نجاح التسوية لاحقًا؛ ورسوم الكشف تُقارن بالإعدادات المُدخلة — الفرق تنبيه في الطابور
 *    والقيد بالرسوم الفعلية للكشف (الكشف هو الحقيقة)، وبلا إعداد لا مقارنة. موعد التحويل المتوقع من أيام الصرف المُدخلة.
 */
export type SettleOutcome = { row: number; shipment: string; status: "posted" | "replay" | "already_settled" | "review"; reason?: string; transactionId?: number; feeNote?: string };

const likeEscape = (v: string) => v.replace(/[\\%_]/g, m => `\\${m}`);

const REF_RE = /^[A-Za-z0-9_\-./]{3,60}$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

async function ids(d: LedgerDb, tenantId: number, codes: string[]) {
  const rows = await d.select({ id: ledgerAccounts.id, code: ledgerAccounts.code, isActive: ledgerAccounts.isActive }).from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, tenantId), inArray(ledgerAccounts.code, codes)));
  const out: Record<string, number> = {};
  for (const r of rows) if (r.isActive === 1) out[r.code] = r.id;
  const missing = codes.filter(c => out[c] == null);
  if (missing.length) throw new LedgerError("account", `حسابات ناقصة: ${missing.join("، ")} — جهّز الحسابات القياسية`);
  return out;
}

async function precheck(d: LedgerDb, tenantId: number, ref: string, date: string) {
  if (!REF_RE.test(ref)) throw new LedgerError("conflict", "مرجع الكشف: 3–60 حرفًا لاتينيًا/أرقام/-_./");
  if (!DATE_RE.test(date)) throw new LedgerError("date", date);
  const s = await getLedgerStatus(tenantId, d);
  if (!s.enabled) throw new LedgerError("disabled");
  if (!s.goLiveDate || date < s.goLiveDate) throw new LedgerError("beforeGoLive", date);
}

export async function settleCarrierStatement(input: { tenantId: number; statementRef: string; statementDate: string; lines: SettlementLine[]; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await precheck(d, input.tenantId, input.statementRef, input.statementDate);
  const acc = await ids(d, input.tenantId, ["COD_BOSTA", "COD_PAYOUT", "EXP_CARRIER_FEES"]);
  const settings = await getCarrierSettingValues(d, input.tenantId);
  // الأسطر ذات الصافي الموجب أولًا (حساب «قيد الصرف» يمتلئ قبل خصم رسوم المرتجعات)
  const lines = [...input.lines].sort((a, b) => Number(signed(b.net) > 0n) - Number(signed(a.net) > 0n));
  const out: SettleOutcome[] = [];
  for (const l of lines) {
    const { outcome: o, order } = await settleOne(d, input, acc, l);
    out.push(o);
    const base = { tenantId: input.tenantId, businessId: order?.businessId ?? null, source: "settlement" as const, orderId: order?.id ?? null, shipmentId: l.shipment };
    if (o.status === "review") await recordCarrierReview(d, { ...base, referenceKey: `settle:${input.statementRef}:${l.shipment}`, reason: o.reason ?? "مراجعة" });
    if (o.status === "posted" || o.status === "replay") {
      await autoResolveCarrierReviews(d, input.tenantId, `settle:%:${likeEscape(l.shipment)}`, input.actor, `سُوّيت في الكشف ${input.statementRef}`);
      // الرسوم الفعلية مقابل الإعداد المُدخل — تنبيه فقط، والقيد بالفعلي
      const expected = expectedCarrierFees(settings, l.cod, toMinorUnits(l.cod) === 0n);
      if (expected != null && !sameToPiaster(expected, l.fees)) {
        o.feeNote = `رسوم الكشف ${l.fees} ≠ المتوقعة من الإعداد ${expected}`;
        await recordCarrierReview(d, { ...base, referenceKey: `settle-fees:${input.statementRef}:${l.shipment}`, reason: o.feeNote });
      }
    }
  }
  return { statementRef: input.statementRef, outcomes: out.sort((a, b) => a.row - b.row), ...(await statementStatus({ tenantId: input.tenantId, statementRef: input.statementRef }, d)) };
}

type OrderRef = { id: number; businessId: number; orderNumber: string };

/** سطر واحد → نتيجته والأوردر المطابق (إن وُجد واحد بالضبط). */
async function settleOne(d: LedgerDb, input: { tenantId: number; statementRef: string; statementDate: string; actor: LedgerActor }, acc: Record<string, number>, l: SettlementLine): Promise<{ outcome: SettleOutcome; order: OrderRef | null }> {
  const res = (status: SettleOutcome["status"], extra: Partial<SettleOutcome> = {}, order: OrderRef | null = null) => ({ outcome: { row: l.row, shipment: l.shipment, status, ...extra }, order });
  const cod = toMinorUnits(l.cod), fees = toMinorUnits(l.fees), net = signed(l.net);
  if (cod - fees !== net) return res("review", { reason: "المعادلة غير متسقة" });
  // الربط الموحّد أولًا (بعد 0047)، ثم البحث برقم الشحنة/التتبع
  const linked = await linkedOrderForShipment(d, input.tenantId, l.shipment);
  const sel = d.select({ id: orders.id, businessId: orders.businessId, orderNumber: orders.orderNumber }).from(orders).innerJoin(businesses, eq(businesses.id, orders.businessId));
  const matches: OrderRef[] = linked
    ? await sel.where(and(eq(businesses.tenantId, input.tenantId), eq(orders.id, linked.orderId)))
    : await sel.where(and(eq(businesses.tenantId, input.tenantId), or(eq(orders.bostaShipmentId, l.shipment), eq(orders.bostaTrackingNumber, l.shipment))));
  if (matches.length === 0) return res("review", { reason: "لا أوردر مطابق لهذه الشحنة في الشركة" });
  if (matches.length > 1) return res("review", { reason: `أكثر من أوردر بنفس الشحنة (${matches.map(m => m.orderNumber).join("، ")}) — لا تسوية مخمّنة` });
  const o = matches[0];
  const review = (reason: string) => res("review", { reason }, o);
  let entries: { accountId: number; side: "debit" | "credit"; amount: string; businessId: number }[];
  let key: string;
  if (cod > 0n) {
    // التحصيل يجب أن يطابق ذمة التسليم المسجّلة لهذا الأوردر (لم تُعكس)
    const [del] = rawRows(await d.execute(sql`SELECT t.id, (SELECT SUM(e.amount) FROM ledger_entries e WHERE e.transactionId = t.id AND e.side = 'debit' AND e.accountId = ${acc.COD_BOSTA}) AS cod,
        (SELECT r.idempotencyKey FROM ledger_transactions r WHERE r.reversalOfTransactionId = t.id) AS reversedBy
      FROM ledger_transactions t WHERE t.tenantId = ${input.tenantId} AND t.idempotencyKey = ${`order:${o.id}:delivered`}`));
    if (!del) return review(`لا قيد تسليم للأوردر ${o.orderNumber} — لا تسوية لتحصيل غير مسجّل`);
    // مرتجع قبل التسوية (عُكس التسليم بمرتجعنا) لكن الكشف يثبت أن التحصيل تم ⇒ المبلغ التزام رد للعميل لا ذمة
    const returnedBeforeSettlement = del.reversedBy === `order:${o.id}:returned`;
    if (del.reversedBy && !returnedBeforeSettlement) return review(`قيد تسليم الأوردر ${o.orderNumber} معكوس بحركة أخرى — راجع يدويًا`);
    if (toMinorUnits(String(del.cod ?? "0")) !== cod) return review(`التحصيل في الكشف ${l.cod} ≠ المسجّل عند التسليم ${fromMinorUnits(toMinorUnits(String(del.cod ?? "0")))}`);
    let refundAcc: number | null = null;
    if (returnedBeforeSettlement) {
      try { refundAcc = (await ids(d, input.tenantId, ["REFUND_PAYABLE"])).REFUND_PAYABLE; }
      catch (e) { return review(e instanceof Error ? e.message : String(e)); }
    }
    key = `bosta-settle:${l.shipment}:cod`;
    entries = [
      { accountId: refundAcc ?? acc.COD_BOSTA, side: "credit", amount: fromMinorUnits(cod), businessId: o.businessId },
      ...(fees > 0n ? [{ accountId: acc.EXP_CARRIER_FEES, side: "debit" as const, amount: fromMinorUnits(fees), businessId: o.businessId }] : []),
      ...(net > 0n ? [{ accountId: acc.COD_PAYOUT, side: "debit" as const, amount: fromMinorUnits(net), businessId: o.businessId }] : []),
      ...(net < 0n ? [{ accountId: acc.COD_PAYOUT, side: "credit" as const, amount: fromMinorUnits(-net), businessId: o.businessId }] : []),
    ];
  } else {
    if (fees === 0n) return review("سطر بلا تحصيل ولا رسوم");
    key = `bosta-settle:${l.shipment}:fees`;
    entries = [{ accountId: acc.EXP_CARRIER_FEES, side: "debit", amount: fromMinorUnits(fees), businessId: o.businessId }, { accountId: acc.COD_PAYOUT, side: "credit", amount: fromMinorUnits(fees), businessId: o.businessId }];
  }
  try {
    const r = await postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: o.businessId, kind: "bosta_settlement", idempotencyKey: key, effectiveDate: input.statementDate, currency: "EGP", actor: input.actor,
      entries, description: `تسوية بوسطة ${input.statementRef} — الأوردر ${o.orderNumber}`, sourceType: "bosta_settlement", sourceReference: input.statementRef } as any, d);
    return res(r.replay ? "replay" : "posted", { transactionId: r.transactionId }, o);
  } catch (e) {
    if (e instanceof LedgerError && e.code === "conflict") {
      const [prev] = await d.select({ ref: ledgerTransactions.sourceReference }).from(ledgerTransactions).where(and(eq(ledgerTransactions.tenantId, input.tenantId), eq(ledgerTransactions.idempotencyKey, key))).limit(1);
      return res("already_settled", { reason: `مسوّاة من قبل في الكشف ${prev?.ref ?? "آخر"} — لا تسوية مرتين` }, o);
    }
    return review(e instanceof Error ? e.message : String(e));
  }
}

/** صافي الكشف المسجّل في الدفتر (رصيد «قيد الصرف» من قيود هذا الكشف) وهل سُجّل التحويل. */
export async function statementStatus(input: { tenantId: number; statementRef: string }, db?: LedgerDb) {
  const d = await resolveDb(db);
  const [payoutAcc] = await d.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, input.tenantId), eq(ledgerAccounts.code, "COD_PAYOUT"))).limit(1);
  if (!payoutAcc) return { expectedPayout: null as string | null, lines: 0, payoutTransactionId: null as number | null, statementDate: null as string | null, expectedPayoutOn: null as string | null };
  const [agg] = rawRows(await d.execute(sql`SELECT COUNT(DISTINCT t.id) AS n, SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END) AS net, DATE_FORMAT(MIN(t.effectiveDate), '%Y-%m-%d') AS sd
    FROM ledger_transactions t JOIN ledger_entries e ON e.transactionId = t.id AND e.accountId = ${payoutAcc.id}
    WHERE t.tenantId = ${input.tenantId} AND t.sourceType = 'bosta_settlement' AND t.sourceReference = ${input.statementRef} AND t.idempotencyKey LIKE 'bosta-settle:%'`));
  const [payout] = await d.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(and(eq(ledgerTransactions.tenantId, input.tenantId), eq(ledgerTransactions.idempotencyKey, `bosta-payout:${input.statementRef}`))).limit(1);
  const net = agg?.net == null ? 0n : (String(agg.net).startsWith("-") ? -toMinorUnits(String(agg.net).slice(1)) : toMinorUnits(String(agg.net)));
  const statementDate: string | null = agg?.sd ?? null;
  const mask = (await getCarrierSettingValues(d, input.tenantId))["carrier.bosta.payout_weekdays"];
  return { expectedPayout: fromMinorUnits(net < 0n ? 0n : net), negativeNet: net < 0n ? fromMinorUnits(-net) : null, lines: Number(agg?.n ?? 0), payoutTransactionId: payout?.id ?? null,
    statementDate, expectedPayoutOn: statementDate ? nextPayoutDate(statementDate, mask == null ? null : Number(mask)) : null };
}

/**
 * الكشوف المسوّاة في الدفتر: الصافي، هل وصل التحويل، وموعده المتوقع من أيام الصرف المُدخلة — «متأخر» فقط إن وُجد إعداد ومضى
 * الموعد بلا تحويل (بلا إعداد لا حكم بالتأخير).
 */
export async function listCarrierStatements(tenantId: number, db?: LedgerDb) {
  const d = await resolveDb(db);
  const [payoutAcc] = await d.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, tenantId), eq(ledgerAccounts.code, "COD_PAYOUT"))).limit(1);
  if (!payoutAcc) return [];
  const rows = rawRows(await d.execute(sql`SELECT t.sourceReference AS ref, COUNT(DISTINCT t.id) AS n, DATE_FORMAT(MIN(t.effectiveDate), '%Y-%m-%d') AS sd,
      SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END) AS net,
      (SELECT p.id FROM ledger_transactions p WHERE p.tenantId = ${tenantId} AND p.idempotencyKey = CONCAT('bosta-payout:', t.sourceReference)) AS payoutId
    FROM ledger_transactions t JOIN ledger_entries e ON e.transactionId = t.id AND e.accountId = ${payoutAcc.id}
    WHERE t.tenantId = ${tenantId} AND t.sourceType = 'bosta_settlement' AND t.idempotencyKey LIKE 'bosta-settle:%'
    GROUP BY t.sourceReference ORDER BY sd DESC, ref DESC LIMIT 100`));
  const mask = (await getCarrierSettingValues(d, tenantId))["carrier.bosta.payout_weekdays"];
  const today = businessDateKey(new Date(), "Africa/Cairo");
  return rows.map((r: any) => {
    const net = String(r.net ?? "0").startsWith("-") ? -toMinorUnits(String(r.net).slice(1)) : toMinorUnits(String(r.net ?? "0"));
    const expectedPayoutOn = nextPayoutDate(r.sd, mask == null ? null : Number(mask));
    const paid = r.payoutId != null;
    return { statementRef: String(r.ref), statementDate: String(r.sd), lines: Number(r.n), net: fromMinorUnits(net < 0n ? 0n : net), negativeNet: net < 0n ? fromMinorUnits(-net) : null,
      payoutTransactionId: paid ? Number(r.payoutId) : null, expectedPayoutOn, overdue: !paid && net > 0n && expectedPayoutOn != null && today > expectedPayoutOn };
  });
}

/** التحويل الفعلي لحساب استلام (بنك/خزنة/محفظة) — يُقبل فقط بمبلغ = صافي الكشف المسجّل، مرة واحدة. */
export async function recordCarrierPayout(input: { tenantId: number; statementRef: string; receivedOn: string; amount: string; accountCode: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await precheck(d, input.tenantId, input.statementRef, input.receivedOn);
  const st = await statementStatus({ tenantId: input.tenantId, statementRef: input.statementRef }, d);
  if (st.lines === 0) throw new LedgerError("transaction", `لا قيود تسوية للكشف ${input.statementRef}`);
  const amount = toMinorUnits(input.amount);
  if (amount <= 0n || st.expectedPayout == null || amount !== toMinorUnits(st.expectedPayout)) {
    const reason = `المبلغ ${input.amount} ≠ صافي الكشف المسجّل ${st.expectedPayout} — لا تحويل مخمّن`;
    await recordCarrierReview(d, { tenantId: input.tenantId, source: "payout", referenceKey: `payout:${input.statementRef}`, reason: `تحويل مرفوض للكشف ${input.statementRef}: ${reason}` });
    throw new LedgerError("conflict", reason);
  }
  const [cash] = await d.select({ id: ledgerAccounts.id, kind: ledgerAccounts.kind, isActive: ledgerAccounts.isActive }).from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, input.tenantId), eq(ledgerAccounts.code, input.accountCode))).limit(1);
  if (!cash || cash.isActive !== 1 || !["cash", "bank", "wallet"].includes(cash.kind)) throw new LedgerError("account", "حساب الاستلام يجب أن يكون خزنة أو بنكًا أو محفظة فعّالة");
  const acc = await ids(d, input.tenantId, ["COD_PAYOUT"]);
  const posted = await postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: null, kind: "bosta_settlement", idempotencyKey: `bosta-payout:${input.statementRef}`, effectiveDate: input.receivedOn, currency: "EGP", actor: input.actor,
    entries: [{ accountId: cash.id, side: "debit", amount: fromMinorUnits(amount), businessId: null }, { accountId: acc.COD_PAYOUT, side: "credit", amount: fromMinorUnits(amount), businessId: null }],
    description: `تحويل بوسطة للكشف ${input.statementRef}`, sourceType: "bosta_payout", sourceReference: input.statementRef } as any, d);
  await autoResolveCarrierReviews(d, input.tenantId, `payout:${likeEscape(input.statementRef)}`, input.actor, `وصل التحويل الصحيح (${fromMinorUnits(amount)})`);
  return posted;
}
