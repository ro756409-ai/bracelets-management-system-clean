import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { ledgerAccounts } from "../drizzle/ledgerV3.schema";
import { SYSTEM_POSTED_CODES } from "../shared/ledgerDailyAccounts";
import { TRPCError } from "@trpc/server";
import { router, authenticatedProcedure } from "./_core/trpc";
import { openingDraftInput, validateOpeningDraft } from "./ledgerOpening.service";
import { dailyAccountsStatus, dailyLedgerReport, ensureDailyAccounts } from "./ledgerDaily.service";
import { InventoryLedgerError, listInventoryOpeningCandidates, postInventoryOpeningFromStocktake, postPackagingOpening } from "./ledgerInventory.service";
import { closeChecklist, incomeStatement, positionSummary, profitByBusiness, profitByProduct } from "./ledgerReports.service";
import { listCarrierStatements, recordCarrierPayout, settleCarrierStatement, statementStatus } from "./ledgerCarrier.service";
import { clearLedgerSetting, listCarrierReviews, listLedgerSettings, resolveCarrierReview, setLedgerSetting } from "./ledgerCarrierOps.service";
import { listRefundLiabilities, payCustomerRefund, retainRefundRemainder } from "./ledgerOrders.service";
import { parseSettlementCsv } from "../shared/carrierSettlement";
import { hasTenantPermission, isOwnerRole, isRoleRestrictedDenied, LEDGER_OWNER_ONLY_PERMISSIONS, type Permission } from "./permissions";
import { LEDGER_KINDS, LedgerError, type LedgerActor } from "../shared/ledgerV3Core";
import {
  createLedgerAccount, getLedgerStatus, getLedgerTransactionScoped, listLedgerAccountsScoped, reviewLedgerPeriod, grantLedgerAccountBusiness, listLedgerAccounts, listLedgerBusinesses, listLedgerPeriods,
  listLedgerTransactions, lockLedgerPeriod, postLedgerTransaction, reconcileLedgerV3, renameLedgerAccount, reopenLedgerPeriod,
  resolveDb, reverseLedgerTransaction, revokeLedgerAccountBusiness, setLedgerAccountActive,
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
type Deps = {
  scopeBusinessId: (ctx: ScopeCtx, businessId?: number | null) => Promise<number | undefined>;
  /** أنشطة الجلسة المسموح بها (null = تعذّر التحديد → لا شيء). */
  sessionBusinessIds: (ctx: ScopeCtx) => Promise<number[] | null>;
  /** هل للجلسة نطاق الشركة كله في القراءة (المالك/الأدمن/مدير الحسابات)؟ غير ذلك = أنشطة الجلسة فقط. */
  fullLedgerScope: (ctx: ScopeCtx) => Promise<boolean> | boolean;
  /** reports.view_profit (نفس قاعدة canViewProfit في routers) — الربح null لمن لا يملكها. */
  canViewProfit?: (ctx: ScopeCtx) => Promise<boolean> | boolean;
};

const NO_PERMISSION = "ليست لديك صلاحية على دفتر الحسابات لهذا الإجراء";

/**
 * صلاحية ledger.* = الصلاحية الفعلية المحسوبة من الدور الحقيقي للموظف + تجاوزات tenant_role_permissions
 * (لا من الجلسة الصناعية ولا من اسم دور يرسله العميل). لا رفض بالاسم لأي دور: المدير والمحاسب يأخذان
 * ما يمنحه المالك — عدا ما هو للمالك وحده (reopen/activate) فيبقى لـsuper_admin حتى مع وجود override.
 */
function ledgerProcedure(permission: Permission) {
  return authenticatedProcedure.use(async ({ ctx, next }) => {
    // جلسة مالك بلا صف موظف (نادرة) = super_admin؛ غير ذلك الدور الحقيقي للموظف
    const role = ctx.employee?.role ?? (ctx.user?.role === "admin" ? "super_admin" : null);
    if (LEDGER_OWNER_ONLY_PERMISSIONS.includes(permission) && !isOwnerRole(role))
      throw new TRPCError({ code: "FORBIDDEN", message: "هذا الإجراء للمالك فقط" });
    if (isRoleRestrictedDenied(role, permission))
      throw new TRPCError({ code: "FORBIDDEN", message: "عكس الحركات للمالك ومدير الحسابات فقط" });
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

async function rejectSystemPostedAccounts(tenantId: number, accountIds: number[]) {
  const d = await resolveDb();
  const rows = await d.select({ code: ledgerAccounts.code }).from(ledgerAccounts).where(and(eq(ledgerAccounts.tenantId, tenantId), inArray(ledgerAccounts.id, accountIds)));
  const blocked = rows.map(r => r.code).filter(c => SYSTEM_POSTED_CODES.has(c));
  if (blocked.length) throw new LedgerError("kindShape", `حساب يُرحَّل آليًا ولا يُدخل يدويًا: ${blocked.join("، ")}`);
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
        : err.code === "grant" || err.code === "outOfScope" || err.code === "business" || err.code === "actorEmployee" || err.code === "reopenRole" ? "FORBIDDEN"
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
  /** نطاق القراءة: null = الشركة كلها، وإلا أنشطة الجلسة (تعذّر التحديد = لا شيء). */
  const readScope = async (ctx: ScopeCtx): Promise<number[] | null> => ((await deps.fullLedgerScope(ctx)) ? null : (await deps.sessionBusinessIds(ctx)) ?? []);
  const requireCompanyScope = async (ctx: ScopeCtx) => {
    if ((await readScope(ctx)) !== null) throw new TRPCError({ code: "FORBIDDEN", message: "هذه العملية على مستوى الشركة — للمالك ومدير الحسابات" });
  };
  const requireProfit = async (ctx: ScopeCtx) => {
    if (!(await deps.canViewProfit?.(ctx))) throw new TRPCError({ code: "FORBIDDEN", message: "التقارير المالية للأرباح لمن يملك صلاحية «عرض الأرباح» فقط" });
  };
  const scopedBusiness = async (ctx: ScopeCtx, businessId: number | null | undefined) => {
    if (businessId == null) return null;
    const scoped = await deps.scopeBusinessId(ctx, businessId);
    if (scoped == null) throw new TRPCError({ code: "FORBIDDEN", message: "لا يمكنك الوصول لبيانات هذا النشاط" });
    return scoped;
  };
  /** نتيجة الترحيل/العكس: «الرصيد بعد الحركة» رصيد شركة كامل — يُحجب عن النطاق المحدود (نفس قاعدة accounts.list). */
  const maskBalances = async <T extends { entries: { balanceAfter: string }[] }>(ctx: ScopeCtx, r: T) =>
    (await readScope(ctx)) === null ? r : { ...r, entries: r.entries.map(e => ({ ...e, balanceAfter: null })) };
  const tenantOf = (ctx: any): number => {
    if (ctx.tenantId == null) throw new TRPCError({ code: "UNAUTHORIZED", message: "جلسة بلا شركة" });
    return ctx.tenantId;
  };

  return router({
    status: ledgerProcedure("ledger.view").query(async ({ ctx }) => getLedgerStatus(tenantOf(ctx))),

    accounts: router({
      list: ledgerProcedure("ledger.view").query(async ({ ctx }) => { const scope = await readScope(ctx); return guard(() => listLedgerAccountsScoped(tenantOf(ctx), scope)); }),
    }),

    // أنشطة الجلسة لواجهة الدفتر (المحاسب جلسة موظف بلا BusinessContext) — نطاق الجلسة على السيرفر، fail-closed.
    businesses: router({
      list: ledgerProcedure("ledger.view").query(async ({ ctx }) => listLedgerBusinesses(tenantOf(ctx), await deps.sessionBusinessIds(ctx))),
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
          const scope = await readScope(ctx);
          return guard(() => listLedgerTransactions(tenantOf(ctx), { ...input, businessId, scope }));
        }),
    }),

    transaction: router({
      get: ledgerProcedure("ledger.view")
        .input(z.object({ transactionId: z.number().int().positive() }))
        .query(async ({ ctx, input }) => { const scope = await readScope(ctx); return guard(() => getLedgerTransactionScoped(tenantOf(ctx), input.transactionId, scope)); }),
    }),

    // المطابقة تفحص أرصدة الشركة كلها — لنطاق الشركة فقط (المالك/الأدمن/مدير الحسابات)، لا لنطاق نشاط واحد.
    reconciliation: ledgerProcedure("ledger.view").query(async ({ ctx }) => {
      if ((await readScope(ctx)) !== null) throw new TRPCError({ code: "FORBIDDEN", message: "مطابقة الأرصدة على مستوى الشركة للمالك ومدير الحسابات" });
      return guard(() => reconcileLedgerV3(tenantOf(ctx)));
    }),

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
        const scope = await deps.sessionBusinessIds(ctx);
        // حسابات تُرحَّل آليًا فقط (رسوم الشحن من الكشف، خسائر المرتجع من الفحص، فروق الجرد، إيراد الشحن، التغليف…) — الإدخال
        // اليدوي عليها يكرر القيمة، فيُرفض قبل أي كتابة
        await guard(() => rejectSystemPostedAccounts(tenantOf(ctx), input.entries.map(e => e.accountId)));
        return maskBalances(ctx, await guard(() => postLedgerTransaction({
          tenantId: tenantOf(ctx), sourceBusinessId, kind: input.kind as any, idempotencyKey: input.idempotencyKey, effectiveDate: input.effectiveDate,
          currency: input.currency.toUpperCase(), actor: actorOf(ctx), entries, description: input.description, sourceType: input.sourceType ?? null, sourceReference: input.sourceReference ?? null,
          // نطاق الجلسة من السيرفر: يمنع الترحيل/التحويل على خزنة خارج النطاق حتى بقيد businessId=null
          scope,
        })));
      }),

    reverse: ledgerProcedure("ledger.reverse")
      .input(z.object({ transactionId: z.number().int().positive(), idempotencyKey: idemKey, effectiveDate: dateStr, reason: z.string().trim().min(3).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const scope = await deps.sessionBusinessIds(ctx);
        return maskBalances(ctx, await guard(() => reverseLedgerTransaction({ tenantId: tenantOf(ctx), ...input, actor: actorOf(ctx), scope })));
      }),

    periods: router({
      list: ledgerProcedure("ledger.view").query(async ({ ctx }) => guard(() => listLedgerPeriods(tenantOf(ctx)))),
    }),
    period: router({
      // الاعتماد = مراجعة الشهر ثم إقفاله بملاحظة مراجعة إلزامية مسجّلة (الحركات نفسها تُرحّل فورًا).
      lock: ledgerProcedure("ledger.period.lock")
        .input(z.object({ period: periodStr, reason: z.string().trim().min(3, "ملاحظة المراجعة إلزامية (3 أحرف على الأقل)").max(500) }))
        .mutation(async ({ ctx, input }) => guard(() => lockLedgerPeriod({ tenantId: tenantOf(ctx), period: input.period, reason: input.reason, actor: actorOf(ctx) }))),
      // مراجعة شهر (قراءة فقط) داخل نطاق القراءة: حركة كل حساب ونشاط، العكوس، وسجل الإقفال/الفتح بالأسماء.
      review: ledgerProcedure("ledger.view")
        .input(z.object({ period: periodStr }))
        .query(async ({ ctx, input }) => { const scope = await readScope(ctx); return guard(() => reviewLedgerPeriod(tenantOf(ctx), input.period, scope)); }),
      // قائمة فحص الإقفال (قراءة فقط، مستوى الشركة) — للمالك ومدير الحسابات
      checklist: ledgerProcedure("ledger.view").input(z.object({ period: periodStr })).query(async ({ ctx, input }) => {
        if ((await readScope(ctx)) !== null) throw new TRPCError({ code: "FORBIDDEN", message: "قائمة فحص الإقفال على مستوى الشركة للمالك ومدير الحسابات" });
        return guard(() => closeChecklist({ tenantId: tenantOf(ctx), period: input.period }));
      }),
      reopen: ledgerProcedure("ledger.period.reopen")
        .input(z.object({ period: periodStr, reason: z.string().trim().min(3).max(500) }))
        .mutation(async ({ ctx, input }) => guard(() => reopenLedgerPeriod({ tenantId: tenantOf(ctx), period: input.period, reason: input.reason, actor: actorOf(ctx) }))),
    }),

    // المرحلة 2: تجهيز الحسابات القياسية (تصنيفات المصروفات + المخزون/التكلفة) — idempotent؛ ربطها بأنشطة الجلسة.
    setup: router({
      dailyAccountsStatus: ledgerProcedure("ledger.view").query(async ({ ctx }) => guard(() => dailyAccountsStatus(tenantOf(ctx)))),
      ensureDailyAccounts: ledgerProcedure("ledger.manage_accounts").mutation(async ({ ctx }) => {
        const businessIds = (await deps.sessionBusinessIds(ctx)) ?? [];
        return guard(() => ensureDailyAccounts({ tenantId: tenantOf(ctx), businessIds, actor: actorOf(ctx) }));
      }),
    }),

    // المرحلة 2: التقرير اليومي داخل نطاق القراءة؛ الربح لمن يملك reports.view_profit فقط (null صريح لغيره).
    reports: router({
      // المرحلة 7: قائمة الدخل والربح حسب النشاط/المنتج — أرباح بالكامل: reports.view_profit إلزامية (رفض لا أصفار).
      incomeStatement: ledgerProcedure("ledger.view")
        .input(z.object({ from: dateStr, to: dateStr, businessId: z.number().int().positive().optional() }))
        .query(async ({ ctx, input }) => {
          await requireProfit(ctx);
          const businessId = await scopedBusiness(ctx, input.businessId);
          const scope = await readScope(ctx);
          return guard(() => incomeStatement({ tenantId: tenantOf(ctx), from: input.from, to: input.to, scope, businessId }));
        }),
      profitByBusiness: ledgerProcedure("ledger.view").input(z.object({ from: dateStr, to: dateStr }))
        .query(async ({ ctx, input }) => { await requireProfit(ctx); const scope = await readScope(ctx); return guard(() => profitByBusiness({ tenantId: tenantOf(ctx), ...input, scope })); }),
      profitByProduct: ledgerProcedure("ledger.view").input(z.object({ from: dateStr, to: dateStr }))
        .query(async ({ ctx, input }) => { await requireProfit(ctx); const scope = await readScope(ctx); return guard(() => profitByProduct({ tenantId: tenantOf(ctx), ...input, scope })); }),
      // ما لنا وما علينا الآن — نطاق القراءة والأرصدة المحجوبة كما هي
      position: ledgerProcedure("ledger.view").query(async ({ ctx }) => { const scope = await readScope(ctx); return guard(() => positionSummary({ tenantId: tenantOf(ctx), scope })); }),
      daily: ledgerProcedure("ledger.view")
        .input(z.object({ date: dateStr, businessId: z.number().int().positive().optional(), page: z.number().int().min(1).default(1) }))
        .query(async ({ ctx, input }) => {
          const businessId = await scopedBusiness(ctx, input.businessId);
          const scope = await readScope(ctx);
          const canViewProfit = Boolean(await deps.canViewProfit?.(ctx));
          return guard(() => dailyLedgerReport({ tenantId: tenantOf(ctx), date: input.date, scope, businessId, canViewProfit, page: input.page }));
        }),
    }),

    // المرحلة 3: تسوية كشف شركة الشحن والتحويل الفعلي — أموال الشركة: نطاق الشركة فقط (المالك/مدير الحسابات) + ledger.post.
    carrier: router({
      settle: ledgerProcedure("ledger.post")
        .input(z.object({ statementRef: z.string().trim().min(3).max(60), statementDate: dateStr, csv: z.string().min(1).max(500_000) }))
        .mutation(async ({ ctx, input }) => {
          await requireCompanyScope(ctx);
          const parsed = parseSettlementCsv(input.csv);
          if (parsed.lines.length === 0) return { statementRef: input.statementRef, parseErrors: parsed.errors, outcomes: [], expectedPayout: null, lines: 0, payoutTransactionId: null };
          const r = await guard(() => settleCarrierStatement({ tenantId: tenantOf(ctx), statementRef: input.statementRef, statementDate: input.statementDate, lines: parsed.lines, actor: actorOf(ctx) }));
          return { ...r, parseErrors: parsed.errors };
        }),
      status: ledgerProcedure("ledger.view").input(z.object({ statementRef: z.string().trim().min(3).max(60) }))
        .query(async ({ ctx, input }) => { await requireCompanyScope(ctx); return guard(() => statementStatus({ tenantId: tenantOf(ctx), statementRef: input.statementRef })); }),
      payout: ledgerProcedure("ledger.post")
        .input(z.object({ statementRef: z.string().trim().min(3).max(60), receivedOn: dateStr, amount: amountStr, accountCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,49}$/) }))
        .mutation(async ({ ctx, input }) => { await requireCompanyScope(ctx); return guard(() => recordCarrierPayout({ tenantId: tenantOf(ctx), ...input, actor: actorOf(ctx) })); }),
      // بعد 0047: الكشوف ومواعيد تحويلها، وطابور المراجعة الدائم (حل/استبعاد بسبب وفاعل)
      statements: ledgerProcedure("ledger.view").query(async ({ ctx }) => { await requireCompanyScope(ctx); return guard(() => listCarrierStatements(tenantOf(ctx))); }),
      reviews: router({
        list: ledgerProcedure("ledger.view").input(z.object({ status: z.enum(["open", "closed"]).default("open") }).optional())
          .query(async ({ ctx, input }) => { await requireCompanyScope(ctx); return guard(() => listCarrierReviews(tenantOf(ctx), input?.status ?? "open")); }),
        resolve: ledgerProcedure("ledger.post")
          .input(z.object({ id: z.number().int().positive(), status: z.enum(["resolved", "dismissed"]), note: z.string().trim().min(3).max(500) }))
          .mutation(async ({ ctx, input }) => { await requireCompanyScope(ctx); return guard(() => resolveCarrierReview({ tenantId: tenantOf(ctx), ...input, actor: actorOf(ctx) })); }),
      }),
    }),

    // بعد 0047: إعدادات مُدخلة (أيام الصرف، الرسوم، الضريبة، تكلفة التغليف) — لا قيمة افتراضية مخمّنة؛ الإدخال لمن يدير الحسابات.
    settings: router({
      list: ledgerProcedure("ledger.view").query(async ({ ctx }) => { await requireCompanyScope(ctx); return guard(() => listLedgerSettings(tenantOf(ctx))); }),
      set: ledgerProcedure("ledger.manage_accounts")
        .input(z.object({ key: z.string().min(3).max(60), scopeBusinessId: z.number().int().min(0).default(0), value: z.union([z.string().trim().min(1).max(20), z.number().int()]) }))
        .mutation(async ({ ctx, input }) => { await requireCompanyScope(ctx); return guard(() => setLedgerSetting({ tenantId: tenantOf(ctx), ...input, actor: actorOf(ctx) })); }),
      clear: ledgerProcedure("ledger.manage_accounts")
        .input(z.object({ key: z.string().min(3).max(60), scopeBusinessId: z.number().int().min(0).default(0) }))
        .mutation(async ({ ctx, input }) => { await requireCompanyScope(ctx); await guard(() => clearLedgerSetting({ tenantId: tenantOf(ctx), ...input })); return { ok: true }; }),
    }),

    // المرتجع بعد التحصيل: التزام الرد للعميل — رد مرة واحدة أو احتجاز الباقي بسبب معلن (نطاق الشركة + ledger.post)
    refunds: router({
      list: ledgerProcedure("ledger.view").query(async ({ ctx }) => { await requireCompanyScope(ctx); return guard(() => listRefundLiabilities(tenantOf(ctx))); }),
      pay: ledgerProcedure("ledger.post")
        .input(z.object({ orderId: z.number().int().positive(), accountCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,49}$/), amount: amountStr, date: dateStr }))
        .mutation(async ({ ctx, input }) => { await requireCompanyScope(ctx); return guard(() => payCustomerRefund({ tenantId: tenantOf(ctx), ...input, actor: actorOf(ctx) })); }),
      retain: ledgerProcedure("ledger.post")
        .input(z.object({ orderId: z.number().int().positive(), amount: amountStr, reason: z.string().trim().min(3).max(300), date: dateStr }))
        .mutation(async ({ ctx, input }) => { await requireCompanyScope(ctx); return guard(() => retainRefundRemainder({ tenantId: tenantOf(ctx), ...input, actor: actorOf(ctx) })); }),
    }),

    // المرحلة 4: قيمة المخزون الافتتاحية من جرد فعلي معتمد يوم Go-live (المالك فقط) — مرة واحدة لكل مخزن.
    inventory: router({
      openingCandidates: ledgerProcedure("ledger.activate").query(async ({ ctx }) => listInventoryOpeningCandidates(tenantOf(ctx))),
      openingFromStocktake: ledgerProcedure("ledger.activate")
        .input(z.object({ stocktakeId: z.number().int().positive() }))
        .mutation(async ({ ctx, input }) => {
          try { return await guard(() => postInventoryOpeningFromStocktake({ tenantId: tenantOf(ctx), stocktakeId: input.stocktakeId, actor: actorOf(ctx) })); }
          catch (e) { if (e instanceof InventoryLedgerError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message }); throw e; }
        }),
      // رصيد مخزون التغليف الافتتاحي من عدّ يوم Go-live — المالك فقط، مرة لكل نشاط
      packagingOpening: ledgerProcedure("ledger.activate")
        .input(z.object({ businessId: z.number().int().positive(), amount: amountStr, countedOn: dateStr }))
        .mutation(async ({ ctx, input }) => {
          try { return await guard(() => postPackagingOpening({ tenantId: tenantOf(ctx), ...input, actor: actorOf(ctx) })); }
          catch (e) { if (e instanceof InventoryLedgerError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message }); throw e; }
        }),
    }),

    // تجهيز الأرصدة الافتتاحية (المالك فقط عبر ledger.activate) — تحقق قراءة فقط داخل معاملة READ ONLY يعيد ملف
    // JSON مطابقًا لسكربت التفعيل؛ لا يكتب أي صف ولا يفعّل الدفتر ولا يقرأ أرقامًا من V1/V2.
    opening: router({
      validate: ledgerProcedure("ledger.activate")
        .input(openingDraftInput)
        .mutation(async ({ ctx, input }) => validateOpeningDraft({ tenantId: tenantOf(ctx), ownerEmployeeId: actorOf(ctx).employeeId!, draft: input })),
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
