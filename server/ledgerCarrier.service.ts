import { and, eq, inArray, or, sql } from "drizzle-orm";
import { businesses, orders } from "../drizzle/schema";
import { ledgerAccounts, ledgerTransactions } from "../drizzle/ledgerV3.schema";
import { fromMinorUnits, toMinorUnits } from "../shared/accountingMoney";
import { signed, type SettlementLine } from "../shared/carrierSettlement";
import { LedgerError, type LedgerActor } from "../shared/ledgerV3Core";
import { getLedgerStatus, postLedgerTransaction, rawRows, resolveDb, type LedgerDb } from "./ledgerV3.service";

/**
 * المرحلة 3 — تسوية كشف شركة الشحن في Ledger V3 (بلا جدول جديد):
 *  • كل سطر شحنة = قيد بمفتاح دائم `bosta-settle:<shipment>:cod|fees` ⇒ نفس الشحنة لا تُسوّى مرتين أبدًا (كشف آخر = تعارض
 *    مرفوض، نفس الكشف = replay). سطر التحصيل: دائن ذمة COD بالتحصيل، مدين رسوم الشحن بالرسوم، والصافي إلى «قيد الصرف».
 *    سطر رسوم فقط (مرتجع): مدين الرسوم / دائن «قيد الصرف».
 *  • لا تخمين: شحنة بلا أوردر، أو بأكثر من أوردر، أو بلا قيد تسليم، أو بمبلغ تحصيل ≠ المسجّل عند التسليم = مراجعة بلا قيد.
 *  • التحويل الفعلي (`bosta-payout:<ref>`) خطوة منفصلة بتاريخها، ويُقبل فقط إن ساوى صافي الكشف المسجّل حرفيًا.
 */
export type SettleOutcome = { row: number; shipment: string; status: "posted" | "replay" | "already_settled" | "review"; reason?: string; transactionId?: number };

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
  // الأسطر ذات الصافي الموجب أولًا (حساب «قيد الصرف» يمتلئ قبل خصم رسوم المرتجعات)
  const lines = [...input.lines].sort((a, b) => Number(signed(b.net) > 0n) - Number(signed(a.net) > 0n));
  const out: SettleOutcome[] = [];
  for (const l of lines) {
    const cod = toMinorUnits(l.cod), fees = toMinorUnits(l.fees), net = signed(l.net);
    if (cod - fees !== net) { out.push({ row: l.row, shipment: l.shipment, status: "review", reason: "المعادلة غير متسقة" }); continue; }
    const matches = await d.select({ id: orders.id, businessId: orders.businessId, orderNumber: orders.orderNumber }).from(orders).innerJoin(businesses, eq(businesses.id, orders.businessId))
      .where(and(eq(businesses.tenantId, input.tenantId), or(eq(orders.bostaShipmentId, l.shipment), eq(orders.bostaTrackingNumber, l.shipment))));
    if (matches.length === 0) { out.push({ row: l.row, shipment: l.shipment, status: "review", reason: "لا أوردر مطابق لهذه الشحنة في الشركة" }); continue; }
    if (matches.length > 1) { out.push({ row: l.row, shipment: l.shipment, status: "review", reason: `أكثر من أوردر بنفس الشحنة (${matches.map(m => m.orderNumber).join("، ")}) — لا تسوية مخمّنة` }); continue; }
    const o = matches[0];
    let entries: { accountId: number; side: "debit" | "credit"; amount: string; businessId: number }[];
    let key: string;
    if (cod > 0n) {
      // التحصيل يجب أن يطابق ذمة التسليم المسجّلة لهذا الأوردر (لم تُعكس)
      const [del] = rawRows(await d.execute(sql`SELECT t.id, (SELECT SUM(e.amount) FROM ledger_entries e WHERE e.transactionId = t.id AND e.side = 'debit' AND e.accountId = ${acc.COD_BOSTA}) AS cod
        FROM ledger_transactions t WHERE t.tenantId = ${input.tenantId} AND t.idempotencyKey = ${`order:${o.id}:delivered`}
          AND NOT EXISTS (SELECT 1 FROM ledger_transactions r WHERE r.reversalOfTransactionId = t.id)`));
      if (!del) { out.push({ row: l.row, shipment: l.shipment, status: "review", reason: `لا قيد تسليم قائم للأوردر ${o.orderNumber} — لا تسوية لتحصيل غير مسجّل` }); continue; }
      if (toMinorUnits(String(del.cod ?? "0")) !== cod) { out.push({ row: l.row, shipment: l.shipment, status: "review", reason: `التحصيل في الكشف ${l.cod} ≠ المسجّل عند التسليم ${fromMinorUnits(toMinorUnits(String(del.cod ?? "0")))}` }); continue; }
      key = `bosta-settle:${l.shipment}:cod`;
      entries = [
        { accountId: acc.COD_BOSTA, side: "credit", amount: fromMinorUnits(cod), businessId: o.businessId },
        ...(fees > 0n ? [{ accountId: acc.EXP_CARRIER_FEES, side: "debit" as const, amount: fromMinorUnits(fees), businessId: o.businessId }] : []),
        ...(net > 0n ? [{ accountId: acc.COD_PAYOUT, side: "debit" as const, amount: fromMinorUnits(net), businessId: o.businessId }] : []),
        ...(net < 0n ? [{ accountId: acc.COD_PAYOUT, side: "credit" as const, amount: fromMinorUnits(-net), businessId: o.businessId }] : []),
      ];
    } else {
      if (fees === 0n) { out.push({ row: l.row, shipment: l.shipment, status: "review", reason: "سطر بلا تحصيل ولا رسوم" }); continue; }
      key = `bosta-settle:${l.shipment}:fees`;
      entries = [{ accountId: acc.EXP_CARRIER_FEES, side: "debit", amount: fromMinorUnits(fees), businessId: o.businessId }, { accountId: acc.COD_PAYOUT, side: "credit", amount: fromMinorUnits(fees), businessId: o.businessId }];
    }
    try {
      const r = await postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: o.businessId, kind: "bosta_settlement", idempotencyKey: key, effectiveDate: input.statementDate, currency: "EGP", actor: input.actor,
        entries, description: `تسوية بوسطة ${input.statementRef} — الأوردر ${o.orderNumber}`, sourceType: "bosta_settlement", sourceReference: input.statementRef } as any, d);
      out.push({ row: l.row, shipment: l.shipment, status: r.replay ? "replay" : "posted", transactionId: r.transactionId });
    } catch (e) {
      if (e instanceof LedgerError && e.code === "conflict") {
        const [prev] = await d.select({ ref: ledgerTransactions.sourceReference }).from(ledgerTransactions).where(and(eq(ledgerTransactions.tenantId, input.tenantId), eq(ledgerTransactions.idempotencyKey, key))).limit(1);
        out.push({ row: l.row, shipment: l.shipment, status: "already_settled", reason: `مسوّاة من قبل في الكشف ${prev?.ref ?? "آخر"} — لا تسوية مرتين` });
      } else out.push({ row: l.row, shipment: l.shipment, status: "review", reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { statementRef: input.statementRef, outcomes: out.sort((a, b) => a.row - b.row), ...(await statementStatus({ tenantId: input.tenantId, statementRef: input.statementRef }, d)) };
}

/** صافي الكشف المسجّل في الدفتر (رصيد «قيد الصرف» من قيود هذا الكشف) وهل سُجّل التحويل. */
export async function statementStatus(input: { tenantId: number; statementRef: string }, db?: LedgerDb) {
  const d = await resolveDb(db);
  const [payoutAcc] = await d.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, input.tenantId), eq(ledgerAccounts.code, "COD_PAYOUT"))).limit(1);
  if (!payoutAcc) return { expectedPayout: null as string | null, lines: 0, payoutTransactionId: null as number | null };
  const [agg] = rawRows(await d.execute(sql`SELECT COUNT(DISTINCT t.id) AS n, SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END) AS net
    FROM ledger_transactions t JOIN ledger_entries e ON e.transactionId = t.id AND e.accountId = ${payoutAcc.id}
    WHERE t.tenantId = ${input.tenantId} AND t.sourceType = 'bosta_settlement' AND t.sourceReference = ${input.statementRef} AND t.idempotencyKey LIKE 'bosta-settle:%'`));
  const [payout] = await d.select({ id: ledgerTransactions.id }).from(ledgerTransactions).where(and(eq(ledgerTransactions.tenantId, input.tenantId), eq(ledgerTransactions.idempotencyKey, `bosta-payout:${input.statementRef}`))).limit(1);
  const net = agg?.net == null ? 0n : (String(agg.net).startsWith("-") ? -toMinorUnits(String(agg.net).slice(1)) : toMinorUnits(String(agg.net)));
  return { expectedPayout: fromMinorUnits(net < 0n ? 0n : net), negativeNet: net < 0n ? fromMinorUnits(-net) : null, lines: Number(agg?.n ?? 0), payoutTransactionId: payout?.id ?? null };
}

/** التحويل الفعلي لحساب استلام (بنك/خزنة/محفظة) — يُقبل فقط بمبلغ = صافي الكشف المسجّل، مرة واحدة. */
export async function recordCarrierPayout(input: { tenantId: number; statementRef: string; receivedOn: string; amount: string; accountCode: string; actor: LedgerActor }, db?: LedgerDb) {
  const d = await resolveDb(db);
  await precheck(d, input.tenantId, input.statementRef, input.receivedOn);
  const st = await statementStatus({ tenantId: input.tenantId, statementRef: input.statementRef }, d);
  if (st.lines === 0) throw new LedgerError("transaction", `لا قيود تسوية للكشف ${input.statementRef}`);
  const amount = toMinorUnits(input.amount);
  if (amount <= 0n || st.expectedPayout == null || amount !== toMinorUnits(st.expectedPayout)) throw new LedgerError("conflict", `المبلغ ${input.amount} ≠ صافي الكشف المسجّل ${st.expectedPayout} — لا تحويل مخمّن`);
  const [cash] = await d.select({ id: ledgerAccounts.id, kind: ledgerAccounts.kind, isActive: ledgerAccounts.isActive }).from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, input.tenantId), eq(ledgerAccounts.code, input.accountCode))).limit(1);
  if (!cash || cash.isActive !== 1 || !["cash", "bank", "wallet"].includes(cash.kind)) throw new LedgerError("account", "حساب الاستلام يجب أن يكون خزنة أو بنكًا أو محفظة فعّالة");
  const acc = await ids(d, input.tenantId, ["COD_PAYOUT"]);
  return postLedgerTransaction({ tenantId: input.tenantId, sourceBusinessId: null, kind: "bosta_settlement", idempotencyKey: `bosta-payout:${input.statementRef}`, effectiveDate: input.receivedOn, currency: "EGP", actor: input.actor,
    entries: [{ accountId: cash.id, side: "debit", amount: fromMinorUnits(amount), businessId: null }, { accountId: acc.COD_PAYOUT, side: "credit", amount: fromMinorUnits(amount), businessId: null }],
    description: `تحويل بوسطة للكشف ${input.statementRef}`, sourceType: "bosta_payout", sourceReference: input.statementRef } as any, d);
}
