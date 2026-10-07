import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, authenticatedProcedure } from "./_core/trpc";
import { hasTenantPermission, type Permission } from "./permissions";
import { LEDGER_KINDS, LedgerError, type LedgerActor } from "../shared/ledgerV3Core";
import {
  createLedgerAccount, getLedgerStatus, getLedgerTransaction, grantLedgerAccountBusiness, listLedgerAccounts, listLedgerPeriods,
  listLedgerTransactions, lockLedgerPeriod, postLedgerTransaction, reconcileLedgerV3, renameLedgerAccount, reopenLedgerPeriod,
  reverseLedgerTransaction, revokeLedgerAccountBusiness, setLedgerAccountActive,
} from "./ledgerV3.service";

/**
 * Routers دفتر V3 — قراءات وترحيل خلف صلاحيات `ledger.*` تُفحص على السيرفر.
 *
 * القواعد: tenantId والفاعل من الجلسة فقط؛ كل businessId يمر بنطاق الجلسة (`scopeBusinessId`)؛
 * لا تعديل/حذف لحركة أو قيد؛ لا تعديل مباشر للرصيد؛ pagination إلزامي بحد 100؛ غياب 0040 أو
 * V3 معطّل يظهر كحالة/خطأ واضح ولا يسقط على V2؛ لا Router للتفعيل (داخلي حتى شاشة المالك).
 * لا منطق مالي هنا: كل شيء يمر عبر الخدمة نفسها.
 */
type ScopeCtx = { tenantId: number | null; user?: { role?: string | null } | null; employee?: { id?: number; role?: string | null; businessId?: number | null } | null; realEmployeeId?: number };
type Deps = { scopeBusinessId: (ctx: ScopeCtx, businessId?: number | null) => Promise<number | undefined> };

const NO_PERMISSION = "ليست لديك صلاحية على دفتر الحسابات لهذا الإجراء";

/** صلاحية ledger.* من دور الموظف الحقيقي (لا من الجلسة الصناعية ولا من اسم دور يرسله العميل). */
function ledgerProcedure(permission: Permission) {
  return authenticatedProcedure.use(async ({ ctx, next }) => {
    const employeeRole = ctx.employee?.role ?? null;
    if (employeeRole === "manager") throw new TRPCError({ code: "FORBIDDEN", message: NO_PERMISSION });
    // جلسة مالك بلا صف موظف (نادرة) = super_admin؛ غير ذلك الدور الحقيقي للموظف
    const role = employeeRole ?? (ctx.user?.role === "admin" ? "super_admin" : null);
    if (!(await hasTenantPermission(ctx.tenantId, role, permission))) throw new TRPCError({ code: "FORBIDDEN", message: NO_PERMISSION });
    return next({ ctx });
  });
}

/** الفاعل الموثوق: موظف الجلسة (المالك/الأدمن/المحاسب كلهم صفوف موظفين). */
function actorOf(ctx: any): LedgerActor {
  const id = ctx.employee?.id ?? ctx.realEmployeeId;
  if (!id) throw new TRPCError({ code: "FORBIDDEN", message: "جلستك غير مرتبطة بموظف — لا يمكن تسجيل الفاعل" });
  return { type: "employee", employeeId: Number(id) };
}

/** LedgerError → رمز tRPC واضح برسالة عربية. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LedgerError) {
      const code = err.code === "conflict" || err.code === "reversedAlready" || err.code === "alreadyEnabled" ? "CONFLICT"
        : err.code === "disabled" || err.code === "unavailable" ? "PRECONDITION_FAILED"
        : err.code === "transaction" || err.code === "account" || err.code === "periodNotFound" ? "NOT_FOUND"
        : err.code === "grant" || err.code === "business" || err.code === "actorEmployee" || err.code === "reopenRole" ? "FORBIDDEN"
        : "BAD_REQUEST";
      throw new TRPCError({ code, message: err.message });
    }
    throw err;
  }
}

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "التاريخ بصيغة YYYY-MM-DD");
const periodStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "الفترة بصيغة YYYY-MM");
const amountStr = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/, "المبلغ رقم عشري موجب حتى 4 خانات");
const idemKey = z.string().trim().min(8).max(191);

export function createLedgerRouter(deps: Deps) {
  const scopedBusiness = async (ctx: ScopeCtx, businessId: number | null | undefined) => {
    if (businessId == null) return null;
    const scoped = await deps.scopeBusinessId(ctx, businessId);
    if (scoped == null) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك الوصول لبيانات هذا النشاط" });
    return scoped;
  };
  const tenantOf = (ctx: any): number => {
    if (ctx.tenantId == null) throw new TRPCError({ code: "UNAUTHORIZED", message: "جلسة بلا شركة" });
    return ctx.tenantId;
  };

  return router({
    status: ledgerProcedure("ledger.view").query(async ({ ctx }) => getLedgerStatus(tenantOf(ctx))),

    accounts: router({
      list: ledgerProcedure("ledger.view").query(async ({ ctx }) => guard(() => listLedgerAccounts(tenantOf(ctx)))),
    }),

    transactions: router({
      list: ledgerProcedure("ledger.view")
        .input(z.object({
          page: z.number().int().min(1).default(1),
          limit: z.number().int().min(1).max(100).default(25),
          from: dateStr.optional(), to: dateStr.optional(),
          businessId: z.number().int().positive().optional(),
          accountId: z.number().int().positive().optional(),
          kind: z.enum(LEDGER_KINDS).optional(),
        }).optional())
        .query(async ({ ctx, input: raw }) => {
          const input = { page: 1, limit: 25, ...(raw ?? {}) };
          const businessId = await scopedBusiness(ctx, input.businessId);
          return guard(() => listLedgerTransactions(tenantOf(ctx), { ...input, businessId }));
        }),
    }),

    transaction: router({
      get: ledgerProcedure("ledger.view")
        .input(z.object({ transactionId: z.number().int().positive() }))
        .query(async ({ ctx, input }) => guard(() => getLedgerTransaction(tenantOf(ctx), input.transactionId))),
    }),

    reconciliation: ledgerProcedure("ledger.view").query(async ({ ctx }) => guard(() => reconcileLedgerV3(tenantOf(ctx)))),

    post: ledgerProcedure("ledger.post")
      .input(z.object({
        sourceBusinessId: z.number().int().positive().nullable().optional(),
        kind: z.enum(LEDGER_KINDS.filter(k => k !== "reversal" && k !== "opening_balance") as [string, ...string[]]),
        idempotencyKey: idemKey,
        effectiveDate: dateStr,
        currency: z.string().length(3).default("EGP"),
        description: z.string().trim().min(1).max(500),
        sourceType: z.string().trim().max(50).optional(),
        sourceReference: z.string().trim().max(160).optional(),
        entries: z.array(z.object({
          accountId: z.number().int().positive(),
          side: z.enum(["debit", "credit"]),
          amount: amountStr,
          businessId: z.number().int().positive().nullable().optional(),
        })).min(2).max(50),
      }))
      .mutation(async ({ ctx, input }) => {
        const sourceBusinessId = await scopedBusiness(ctx, input.sourceBusinessId ?? null);
        const entries = [] as { accountId: number; side: "debit" | "credit"; amount: string; businessId?: number | null }[];
        for (const e of input.entries) {
          const businessId = e.businessId === undefined ? undefined : await scopedBusiness(ctx, e.businessId);
          entries.push({ accountId: e.accountId, side: e.side, amount: e.amount, businessId });
        }
        return guard(() => postLedgerTransaction({
          tenantId: tenantOf(ctx), sourceBusinessId, kind: input.kind as any, idempotencyKey: input.idempotencyKey, effectiveDate: input.effectiveDate,
          currency: input.currency.toUpperCase(), actor: actorOf(ctx), entries, description: input.description, sourceType: input.sourceType ?? null, sourceReference: input.sourceReference ?? null,
        }));
      }),

    reverse: ledgerProcedure("ledger.reverse")
      .input(z.object({ transactionId: z.number().int().positive(), idempotencyKey: idemKey, effectiveDate: dateStr, reason: z.string().trim().min(3).max(500) }))
      .mutation(async ({ ctx, input }) => guard(() => reverseLedgerTransaction({ tenantId: tenantOf(ctx), ...input, actor: actorOf(ctx) }))),

    periods: router({
      list: ledgerProcedure("ledger.view").query(async ({ ctx }) => guard(() => listLedgerPeriods(tenantOf(ctx)))),
    }),
    period: router({
      lock: ledgerProcedure("ledger.period.lock")
        .input(z.object({ period: periodStr, reason: z.string().trim().max(500).optional() }))
        .mutation(async ({ ctx, input }) => guard(() => lockLedgerPeriod({ tenantId: tenantOf(ctx), period: input.period, reason: input.reason, actor: actorOf(ctx) }))),
      reopen: ledgerProcedure("ledger.period.reopen")
        .input(z.object({ period: periodStr, reason: z.string().trim().min(3).max(500) }))
        .mutation(async ({ ctx, input }) => guard(() => reopenLedgerPeriod({ tenantId: tenantOf(ctx), period: input.period, reason: input.reason, actor: actorOf(ctx) }))),
    }),

    account: router({
      create: ledgerProcedure("ledger.manage_accounts")
        .input(z.object({
          code: z.string().regex(/^[A-Z][A-Z0-9_]{1,49}$/, "الكود: حروف لاتينية كبيرة وأرقام و_"),
          name: z.string().trim().min(1).max(120),
          kind: z.enum(["cash", "bank", "wallet", "carrier_receivable", "employee_receivable", "supplier_payable", "customer_advance", "owner_current", "revenue", "expense", "cogs", "inventory", "equity", "suspense"]),
          normalSide: z.enum(["debit", "credit"]),
          allowNegative: z.boolean().optional(),
        }))
        .mutation(async ({ ctx, input }) => guard(() => createLedgerAccount({ tenantId: tenantOf(ctx), ...input, actor: actorOf(ctx) }))),
      updateName: ledgerProcedure("ledger.manage_accounts")
        .input(z.object({ accountId: z.number().int().positive(), name: z.string().trim().min(1).max(120) }))
        .mutation(async ({ ctx, input }) => { await guard(() => renameLedgerAccount({ tenantId: tenantOf(ctx), ...input, actor: actorOf(ctx) })); return { ok: true }; }),
      setActive: ledgerProcedure("ledger.manage_accounts")
        .input(z.object({ accountId: z.number().int().positive(), isActive: z.boolean() }))
        .mutation(async ({ ctx, input }) => { await guard(() => setLedgerAccountActive({ tenantId: tenantOf(ctx), ...input, actor: actorOf(ctx) })); return { ok: true }; }),
      grantBusiness: ledgerProcedure("ledger.manage_accounts")
        .input(z.object({ accountId: z.number().int().positive(), businessId: z.number().int().positive() }))
        .mutation(async ({ ctx, input }) => {
          const businessId = (await scopedBusiness(ctx, input.businessId))!;
          await guard(() => grantLedgerAccountBusiness({ tenantId: tenantOf(ctx), accountId: input.accountId, businessId, actor: actorOf(ctx) }));
          return { ok: true };
        }),
      revokeBusiness: ledgerProcedure("ledger.manage_accounts")
        .input(z.object({ accountId: z.number().int().positive(), businessId: z.number().int().positive() }))
        .mutation(async ({ ctx, input }) => {
          const businessId = (await scopedBusiness(ctx, input.businessId))!;
          await guard(() => revokeLedgerAccountBusiness({ tenantId: tenantOf(ctx), accountId: input.accountId, businessId, actor: actorOf(ctx) }));
          return { ok: true };
        }),
    }),
  });
}
