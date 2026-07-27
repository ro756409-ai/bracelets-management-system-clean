import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createBostaShipment, isBostaEnabled } from "./bosta.service";
import { syncOrdersByDateRange, testChannelConnection } from "./easyorder.service";
import { parseFacebookOrder } from "../shared/facebookOrderParser";
import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getDb, cairoParseDateRange, cairoTodayRange, cairoStartOfDay, cairoEndOfDay } from "./db";
import { markOrderAsReturned, getReturnsList, getReturnsStats, createPrintLog, getPrintLogs, getPrintLogById, addActivityLog, getActivityLogs, getAllSalesChannels, getActiveSalesChannels, getSalesChannelById, createSalesChannel, updateSalesChannel, deleteSalesChannel, reactivateSalesChannel, clearSalesChannelSecret, isWebhookSecretTaken, isSalesChannelNameTaken, getVariantsByProduct, getVariantById, createVariant, updateVariant, deleteVariant, updateVariantStock, addVariantInventoryMovement, getAllVariantsWithProduct, replaceOrderItems, getOrderItems, getOrderItemsForOrders } from "./db";
import { employees } from "../drizzle/schema";
import { eq, and, gte, lte, desc, sql, inArray } from "drizzle-orm";
import { orders as ordersTable } from "../drizzle/schema";
import { normalizeEgyptianPhone } from "../shared/phone";
import { isAdminTierRole, EMPLOYEE_ROLE_VALUES } from "./permissions";

const EMP_JWT_SECRET = process.env.JWT_SECRET;
const EMP_COOKIE = "employee_token";

async function getEmployeeFromCookie(req: any) {
  const token = req?.cookies?.[EMP_COOKIE];
  if (!token || !EMP_JWT_SECRET) return null;
  try {
    const payload = jwt.verify(token, EMP_JWT_SECRET) as any;
    const db = await getDb();
    if (!db) return null;
    const [emp] = await db.select().from(employees).where(eq(employees.id, payload.employeeId)).limit(1);
    return emp?.isActive ? emp : null;
  } catch { return null; }
}

const employeePortalProcedure = publicProcedure.use(async ({ ctx, next }) => {
  const emp = await getEmployeeFromCookie(ctx.req);
  if (!emp) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'يرجى تسجيل الدخول أولاً' });
  return next({ ctx: { ...ctx, employee: emp } });
});

// Manager employee procedure - requires manager role
const managerPortalProcedure = employeePortalProcedure.use(async ({ ctx, next }) => {
  const emp = (ctx as any).employee;
  if (emp.role !== 'manager') throw new TRPCError({ code: 'FORBIDDEN', message: 'هذا الإجراء متاح للمديرين فقط' });
  return next({ ctx });
});
import {
  groupOrdersByAgent, getAgentsForGovernorateOnDay,
  getTodaySchedule, DAY_NAMES_AR, SHIPPING_SCHEDULES,
} from "./shippingSchedules";
import {
  getAllEmployees, getActiveEmployees, getEmployeeById,
  createEmployee, updateEmployee, deleteEmployee,
  searchEmployees, countActiveAdminTierEmployees,
  getAllProducts, getProductById, createProduct, updateProduct,
  isSkuTaken, isVariantNameTaken,
  getSyncLogs, getOrdersNeedingReview, getMatchCatalog,
  getLowStockProducts, addInventoryMovement, getInventoryMovements,
  getOrders, getOrderStatusCounts, getOrderById, getOrdersByIds, createOrder, updateOrder,
  getBostaOrders, getBostaOrdersSummary,
  assignOrderToEmployee, bulkAssignOrders,
  confirmOrder, postponeOrder, cancelOrder,
  editOrderWithInventory,
  deleteOrder, deleteOrders,
  generateOrderNumber,
  getDashboardStats, getEmployeePerformance, getCancellationReasons, getDailyOrdersChart,
  seedInitialData,
  getEmployeeInventory, reclaimEmployeeOrders,
  getAllBusinesses, getActiveBusinesses, getBusinessById, createBusiness, updateBusiness,
  getCategoriesByBusiness, createCategory, updateCategory,
  getWarehousesByBusiness, createWarehouse, updateWarehouse,
  getBusinessGroupsWithBusinesses, getBusinessIdsByGroupId, getActiveBusinessGroups,
  editOrderFull, getOrderEditLogs,
  scanOrderBySerial, getScanLogs,
} from "./db";

// Helper: admin check
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') throw new TRPCError({ code: 'FORBIDDEN', message: 'غير مصرح لك بهذا الإجراء' });
  return next({ ctx });
});

// Owner-only procedure: only the real owner (not manager employees)
const ownerProcedure = adminProcedure.use(({ ctx, next }) => {
  if ((ctx as any).employeeManager) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'هذا الإجراء متاح للمالك فقط' });
  }
  return next({ ctx });
});

// Helper: resolve the real employee ID for audit fields
// For manager employees using the admin dashboard, ctx.realEmployeeId has the actual employee ID
// For regular admin/owner, we look up the employee linked to their user ID
async function resolveActingEmployeeId(ctx: any): Promise<number | undefined> {
  if (ctx.realEmployeeId) return ctx.realEmployeeId;
  const emps = await getAllEmployees();
  const emp = emps.find((e: any) => e.userId === ctx.user?.id);
  return emp?.id;
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      // Also clear employee token if present (for manager employees using admin dashboard)
      ctx.res.clearCookie('employee_token', { path: '/', maxAge: -1 });
      return { success: true } as const;
    }),
  }),

  // ==================== SEED ====================
  seed: router({
    init: protectedProcedure.mutation(async () => {
      await seedInitialData();
      return { success: true };
    }),
  }),

  // ==================== EMPLOYEES ====================
  employees: router({
    list: protectedProcedure.input(z.object({
      businessId: z.number().optional(),
      search: z.string().optional(),
      role: z.enum(EMPLOYEE_ROLE_VALUES).optional(),
      isActive: z.boolean().optional(),
    }).optional()).query(async ({ input }) => {
      return searchEmployees(input ?? {});
    }),
    activeList: protectedProcedure.input(z.object({
      businessId: z.number().optional(),
    }).optional()).query(async ({ input }) => {
      return getActiveEmployees(input?.businessId);
    }),
    get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
      return getEmployeeById(input.id);
    }),
    create: adminProcedure.input(z.object({
      name: z.string().min(2),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      role: z.enum(EMPLOYEE_ROLE_VALUES).default('agent'),
      businessId: z.number().optional(),
    })).mutation(async ({ input }) => {
      await createEmployee(input);
      return { success: true };
    }),
    update: adminProcedure.input(z.object({
      id: z.number(),
      name: z.string().min(2).optional(),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      role: z.enum(EMPLOYEE_ROLE_VALUES).optional(),
      isActive: z.boolean().optional(),
      businessId: z.number().optional(),
    })).mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const target = await getEmployeeById(id);
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'الموظف غير موجود' });

      const revokesAdminAccess =
        data.isActive === false || (data.role !== undefined && !isAdminTierRole(data.role));

      if (revokesAdminAccess && isAdminTierRole(target.role) && target.isActive) {
        const actingEmployeeId = await resolveActingEmployeeId(ctx);
        if (actingEmployeeId === id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'لا يمكنك إلغاء صلاحيتك الإدارية عن حسابك الخاص' });
        }
        const remaining = await countActiveAdminTierEmployees(id);
        if (remaining === 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'لا يمكن ذلك — يجب أن يبقى مسؤول إداري واحد نشط على الأقل' });
        }
      }

      await updateEmployee(id, data);
      return { success: true };
    }),
    delete: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
      const target = await getEmployeeById(input.id);
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'الموظف غير موجود' });

      if (isAdminTierRole(target.role) && target.isActive) {
        const actingEmployeeId = await resolveActingEmployeeId(ctx);
        if (actingEmployeeId === input.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'لا يمكنك حذف حسابك الخاص' });
        }
        const remaining = await countActiveAdminTierEmployees(input.id);
        if (remaining === 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'لا يمكن حذف آخر مسؤول إداري نشط' });
        }
      }

      await deleteEmployee(input.id);
      return { success: true };
    }),
    setCredentials: adminProcedure.input(z.object({
      id: z.number(),
      username: z.string().min(3).max(50),
      password: z.string().min(6),
    })).mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      // Check username uniqueness
      const existing = await db.select().from(employees)
        .where(eq(employees.username, input.username)).limit(1);
      if (existing.length > 0 && existing[0].id !== input.id) {
        throw new TRPCError({ code: 'CONFLICT', message: 'اسم المستخدم مستخدم بالفعل' });
      }
      const passwordHash = await bcrypt.hash(input.password, 10);
      await db.update(employees)
        .set({ username: input.username, passwordHash })
        .where(eq(employees.id, input.id));
      return { success: true };
    }),
    changePassword: adminProcedure.input(z.object({
      id: z.number(),
      newPassword: z.string().min(6),
    })).mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const passwordHash = await bcrypt.hash(input.newPassword, 10);
      await db.update(employees)
        .set({ passwordHash })
        .where(eq(employees.id, input.id));
      return { success: true };
    }),

    // جرد الموظف: عدد الأوردرات الموزعة عليه حسب الحالة
    inventory: adminProcedure.input(z.object({
      employeeId: z.number(),
    })).query(async ({ input }) => {
      return getEmployeeInventory(input.employeeId);
    }),

    // جرد كل الموظفين دفعة واحدة
    allInventory: adminProcedure.query(async () => {
      const emps = await getActiveEmployees();
      const results = await Promise.all(
        emps.filter(e => e.role === 'agent').map(async (emp) => {
          const inv = await getEmployeeInventory(emp.id);
          return {
            employeeId: emp.id,
            employeeName: emp.name,
            ...inv,
          };
        })
      );
      return results;
    }),

    // استرداد أوردرات موظف (إرجاعها بدون توزيع)
    reclaimOrders: adminProcedure.input(z.object({
      employeeId: z.number(),
      statuses: z.array(z.string()).optional(),
    })).mutation(async ({ input }) => {
      const result = await reclaimEmployeeOrders(input.employeeId, input.statuses);
      return result;
    }),
  }),

  // ==================== PRODUCTS ====================
  products: router({
    list: protectedProcedure.input(z.object({
      businessId: z.number().optional(),
      businessIds: z.array(z.number()).optional(),
      includeInactive: z.boolean().optional(),
    }).optional()).query(async ({ input }) => {
      return getAllProducts(input?.businessId, input?.businessIds, { includeInactive: input?.includeInactive });
    }),
    get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
      return getProductById(input.id);
    }),
    create: adminProcedure.input(z.object({
      name: z.string().min(2),
      description: z.string().optional(),
      // sku/price are optional: a parent product with variants (e.g. "أسورة نحاس") carries
      // neither — those live on its variants. Standalone products without variants still set both.
      sku: z.string().min(2).optional(),
      price: z.string().optional(),
      currentStock: z.number().default(0),
      minStockLevel: z.number().default(15),
      businessId: z.number().optional(),
      categoryId: z.number().optional(),
    })).mutation(async ({ input }) => {
      if (input.sku && await isSkuTaken(input.sku)) {
        throw new TRPCError({ code: 'CONFLICT', message: `رمز المنتج (SKU) "${input.sku}" مستخدم بالفعل` });
      }
      await createProduct(input);
      return { success: true };
    }),
    update: adminProcedure.input(z.object({
      id: z.number(),
      name: z.string().optional(),
      description: z.string().optional(),
      sku: z.string().min(2).optional(),
      price: z.string().optional(),
      currentStock: z.number().optional(),
      minStockLevel: z.number().optional(),
      isActive: z.boolean().optional(),
    })).mutation(async ({ input }) => {
      const { id, ...data } = input;
      if (data.sku && await isSkuTaken(data.sku, { excludeProductId: id })) {
        throw new TRPCError({ code: 'CONFLICT', message: `رمز المنتج (SKU) "${data.sku}" مستخدم بالفعل` });
      }
      await updateProduct(id, data);
      return { success: true };
    }),
    lowStock: protectedProcedure.input(z.object({
      businessId: z.number().optional(),
      businessIds: z.array(z.number()).optional(),
    }).optional()).query(async ({ input }) => {
      return getLowStockProducts(input?.businessId, input?.businessIds);
    }),
    addMovement: adminProcedure.input(z.object({
      productId: z.number(),
      type: z.enum(['in', 'out']),
      quantity: z.number().min(1),
      reason: z.string().optional(),
      notes: z.string().optional(),
      orderId: z.number().optional(),
    })).mutation(async ({ ctx, input }) => {
      const actingEmpId = await resolveActingEmployeeId(ctx);
      await addInventoryMovement({
        ...input,
        performedBy: actingEmpId,
      });
      return { success: true };
    }),
    movements: protectedProcedure.input(z.object({
      productId: z.number().optional(),
      variantId: z.number().optional(),
      limit: z.number().default(50),
      businessId: z.number().optional(),
      businessIds: z.array(z.number()).optional(),
    })).query(async ({ input }) => {
      return getInventoryMovements(input.productId, input.limit, input.businessId, input.businessIds, input.variantId);
    }),
  }),

  // ==================== ORDERS ====================
  orders: router({
    list: protectedProcedure.input(z.object({
      status: z.string().optional(),
      statuses: z.array(z.string()).optional(), // فلتر بحالات متعددة
      source: z.string().optional(),
      governorate: z.string().optional(),
      governorates: z.array(z.string()).optional(),
      assignedEmployeeId: z.number().optional(),
      unassignedOnly: z.boolean().optional(),
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
      printedDateFrom: z.date().optional(),
      printedDateTo: z.date().optional(),
      adName: z.string().optional(),
      search: z.string().optional(),
      page: z.number().default(1),
      limit: z.number().default(50),
      businessId: z.number().optional(),
      businessIds: z.array(z.number()).optional(),
      websiteId: z.number().optional(),
    })).query(async ({ ctx, input }) => {
      // Agents can only see their own orders
      if (ctx.user.role !== 'admin') {
        const emps = await getAllEmployees();
        const emp = emps.find(e => e.userId === ctx.user.id);
        if (emp) {
          return getOrders({ ...input, assignedEmployeeId: emp.id });
        }
      }
      return getOrders(input);
    }),

    get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
      const order = await getOrderById(input.id);
      if (!order) return order;
      const items = await getOrderItems(input.id);
      return { ...order, items };
    }),

    /** Header stat cards on the Orders page — same business-group scope as `orders.list`. */
    statusCounts: protectedProcedure.input(z.object({
      businessIds: z.array(z.number()).optional(),
    })).query(async ({ input }) => {
      return getOrderStatusCounts(input.businessIds);
    }),

    /** Orders that ever touched Bosta (shipment created, or send attempt failed), grouped
     *  by shipping-pipeline stage. Uses only existing bosta* columns — no schema change. */
    bostaOrders: protectedProcedure.input(z.object({
      category: z.enum(['sent_today', 'awaiting_update', 'in_transit', 'delivered', 'returned', 'send_failed']).optional(),
      governorate: z.string().optional(),
      search: z.string().optional(),
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
      websiteId: z.number().optional(),
      page: z.number().default(1),
      limit: z.number().default(50),
      businessIds: z.array(z.number()).optional(),
    })).query(async ({ input }) => {
      return getBostaOrders(input);
    }),

    bostaOrdersSummary: protectedProcedure.input(z.object({
      businessIds: z.array(z.number()).optional(),
    }).optional()).query(async ({ input }) => {
      return getBostaOrdersSummary(input?.businessIds);
    }),

    // جلب أسماء البيدج المميزة (لفلتر البيدج)
    distinctAdNames: protectedProcedure.query(async () => {
      const db = await getDb();
      if (!db) return [];
      const rows = await db.selectDistinct({ adName: ordersTable.adName }).from(ordersTable)
        .where(and(sql`${ordersTable.adName} IS NOT NULL`, sql`${ordersTable.adName} != ''`));
      return rows.map(r => r.adName).filter(Boolean) as string[];
    }),

    getByIds: protectedProcedure.input(z.object({
      ids: z.array(z.number()),
    })).query(async ({ input }) => {
      return getOrdersByIds(input.ids);
    }),

    create: protectedProcedure.input(z.object({
      customerName: z.string().min(2),
      customerPhone: z.string().min(10),
      customerAddress: z.string().min(5),
      governorate: z.string().min(2),
      productId: z.number(),
      productName: z.string(),
      quantity: z.number().min(1).default(1),
      totalAmount: z.string(),
      source: z.enum(['easyorder', 'easyorder_ataba', 'easyorder_farhat', 'shopify', 'whatsapp', 'manual', 'facebook']).default('manual'),
      notes: z.string().optional(),
      businessId: z.number().optional(),
    })).mutation(async ({ ctx, input }) => {
      const orderNumber = await generateOrderNumber();
      const actingEmpId = await resolveActingEmployeeId(ctx);
      await createOrder({
        ...input,
        orderNumber,
        lastUpdatedBy: actingEmpId,
      });
      return { success: true, orderNumber };
    }),

    update: protectedProcedure.input(z.object({
      id: z.number(),
      customerName: z.string().optional(),
      customerPhone: z.string().optional(),
      customerAddress: z.string().optional(),
      governorate: z.string().optional(),
      notes: z.string().optional(),
      status: z.enum(['new', 'confirmed', 'postponed', 'cancelled', 'preparing', 'shipped', 'delivered', 'no_answer']).optional(),
    })).mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const actingEmpId = await resolveActingEmployeeId(ctx);
      await updateOrder(id, { ...data, lastUpdatedBy: actingEmpId });
      return { success: true };
    }),

    assign: adminProcedure.input(z.object({
      orderId: z.number(),
      employeeId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const actingEmpId = await resolveActingEmployeeId(ctx);
      await assignOrderToEmployee(input.orderId, input.employeeId, actingEmpId ?? 0);
      return { success: true };
    }),

    bulkAssign: adminProcedure.input(z.object({
      orderIds: z.array(z.number()),
      employeeId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const actingEmpId = await resolveActingEmployeeId(ctx);
      await bulkAssignOrders(input.orderIds, input.employeeId, actingEmpId ?? 0);
      await addActivityLog({
        action: 'assign_orders',
        entityType: 'order',
        description: `توزيع ${input.orderIds.length} أوردر على موظف #${input.employeeId}`,
        metadata: { orderIds: input.orderIds, employeeId: input.employeeId },
        performedBy: ctx.user.id,
        performedByName: ctx.user.name ?? 'مدير',
        performedByRole: ctx.user.role ?? 'admin',
      });
      return { success: true };
    }),

    confirm: protectedProcedure.input(z.object({
      orderId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const actingEmpId = await resolveActingEmployeeId(ctx);
      await confirmOrder(input.orderId, actingEmpId ?? 0);
      await addActivityLog({
        action: 'confirm_order',
        entityType: 'order',
        entityId: input.orderId,
        description: `تأكيد أوردر #${input.orderId}`,
        performedBy: ctx.user.id,
        performedByName: ctx.user.name ?? 'مدير',
        performedByRole: ctx.user.role ?? 'admin',
      });
      // ❌ الإرسال التلقائي لـ Bosta معطل - الإرسال يدوي فقط من صفحة الأوردرات
      return { success: true };
    }),

    /** Orders whose external items could not be matched to a product/variant. */
    needingReview: adminProcedure.input(z.object({
      limit: z.number().min(1).max(500).default(100),
    }).optional()).query(async ({ input }) => {
      return getOrdersNeedingReview(input?.limit ?? 100);
    }),
    /** Resolves a review-flagged order by assigning the correct product/variant. */
    resolveReview: adminProcedure.input(z.object({
      orderId: z.number(),
      productId: z.number(),
      variantId: z.number().nullable().optional(),
      productName: z.string().min(1).optional(),
    })).mutation(async ({ ctx, input }) => {
      const order = await getOrderById(input.orderId);
      if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'الأوردر غير موجود' });
      await updateOrder(input.orderId, {
        productId: input.productId,
        variantId: input.variantId ?? null,
        ...(input.productName ? { productName: input.productName } : {}),
        needsReview: false,
        reviewReason: null,
      } as any);
      await addActivityLog({
        action: 'resolve_order_review',
        entityType: 'order',
        entityId: input.orderId,
        description: `تعيين منتج يدويًا لأوردر #${order.orderNumber}`,
        performedBy: ctx.user.id,
        performedByName: ctx.user.name ?? 'مدير',
        performedByRole: ctx.user.role ?? 'admin',
      });
      return { success: true };
    }),

    // إرسال يدوي / إعادة محاولة إرسال لـ Bosta
    sendToBosta: adminProcedure.input(z.object({
      orderId: z.number(),
      allowToOpenPackage: z.boolean().optional().default(true),
    })).mutation(async ({ input }) => {
      if (!isBostaEnabled()) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Bosta غير مفعل' });
      const result = await createBostaShipment(input.orderId, { allowToOpenPackage: input.allowToOpenPackage });
      return result;
    }),

    bulkSendToBosta: adminProcedure.input(z.object({
      orderIds: z.array(z.number()),
      allowToOpenPackage: z.boolean().optional().default(true),
    })).mutation(async ({ input }) => {
      if (!isBostaEnabled()) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Bosta غير مفعل' });
      const results = await Promise.allSettled(
        input.orderIds.map(id => createBostaShipment(id, { allowToOpenPackage: input.allowToOpenPackage }))
      );
      let success = 0, failed = 0;
      const errors: { orderId: number; error: string }[] = [];
      results.forEach((r, i) => {
        if (r.status === 'fulfilled' && r.value.success) {
          success++;
        } else {
          failed++;
          const err = r.status === 'fulfilled' ? r.value.error : String((r as PromiseRejectedResult).reason);
          errors.push({ orderId: input.orderIds[i], error: err ?? 'خطأ غير معروف' });
        }
      });
      return { success, failed, errors };
    }),

    postpone: protectedProcedure.input(z.object({
      orderId: z.number(),
      postponedTo: z.date(),
      notes: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      const actingEmpId = await resolveActingEmployeeId(ctx);
      await postponeOrder(input.orderId, input.postponedTo, input.notes, actingEmpId ?? 0);
      return { success: true };
    }),

    cancel: protectedProcedure.input(z.object({
      orderId: z.number(),
      cancelReason: z.enum(['price', 'not_serious', 'wrong_number', 'duplicate']),
      notes: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      const actingEmpId = await resolveActingEmployeeId(ctx);
      await cancelOrder(input.orderId, input.cancelReason, input.notes, actingEmpId ?? 0);
      await addActivityLog({
        action: 'cancel_order',
        entityType: 'order',
        entityId: input.orderId,
        description: `إلغاء أوردر #${input.orderId} - السبب: ${input.cancelReason}`,
        metadata: { cancelReason: input.cancelReason, notes: input.notes },
        performedBy: ctx.user.id,
        performedByName: ctx.user.name ?? 'مدير',
        performedByRole: ctx.user.role ?? 'admin',
      });
      return { success: true };
    }),

    markNoAnswer: protectedProcedure.input(z.object({
      orderId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const actingEmpId = await resolveActingEmployeeId(ctx);
      await updateOrder(input.orderId, { status: 'no_answer', lastUpdatedBy: actingEmpId });
      return { success: true };
    }),

    // تعديل بيانات الأوردر بالكامل مع سجل التعديلات (للمدير)
    editOrder: protectedProcedure.input(z.object({
      orderId: z.number(),
      customerName: z.string().optional(),
      customerPhone: z.string().optional(),
      customerPhone2: z.string().optional(),
      customerAddress: z.string().optional(),
      governorate: z.string().optional(),
      city: z.string().optional(),
      productId: z.number().optional(),
      productName: z.string().optional(),
      quantity: z.number().min(1).optional(),
      totalAmount: z.number().optional(),
      shippingFees: z.number().optional(),
      paymentMethod: z.string().optional(),
      notes: z.string().optional(),
      employeeNotes: z.string().optional(),
      variantId: z.number().nullable().optional(),
      color: z.string().nullable().optional(),
      size: z.string().nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      const actingEmpId = await resolveActingEmployeeId(ctx);
      const { orderId, ...updates } = input;
      const result = await editOrderFull(orderId, updates, {
        id: actingEmpId ?? 0,
        name: ctx.user.name || 'Admin',
        role: 'admin',
      });
      return { success: true, order: result };
    }),

    // جلب سجل تعديلات أوردر
    getEditHistory: protectedProcedure.input(z.object({
      orderId: z.number(),
    })).query(async ({ input }) => {
      return getOrderEditLogs(input.orderId);
    }),

    delete: ownerProcedure.input(z.object({
      orderId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      await deleteOrder(input.orderId);
      await addActivityLog({
        action: 'delete_order',
        entityType: 'order',
        entityId: input.orderId,
        description: `حذف أوردر #${input.orderId}`,
        performedBy: ctx.user.id,
        performedByName: ctx.user.name ?? 'مدير',
        performedByRole: ctx.user.role ?? 'admin',
      });
      return { success: true };
    }),

    bulkDelete: ownerProcedure.input(z.object({
      orderIds: z.array(z.number()),
    })).mutation(async ({ ctx, input }) => {
      await deleteOrders(input.orderIds);
      await addActivityLog({
        action: 'bulk_delete_orders',
        entityType: 'order',
        description: `حذف ${input.orderIds.length} أوردر`,
        metadata: { orderIds: input.orderIds },
        performedBy: ctx.user.id,
        performedByName: ctx.user.name ?? 'مدير',
        performedByRole: ctx.user.role ?? 'admin',
      });
      return { success: true };
    }),

    // تكرار أوردر: نسخ بيانات أوردر موجود وإنشاء أوردر جديد بنفس البيانات
    duplicate: adminProcedure.input(z.object({
      orderId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const originalOrder = await getOrderById(input.orderId);
      if (!originalOrder) throw new TRPCError({ code: 'NOT_FOUND', message: 'الأوردر غير موجود' });
      const newOrderNumber = await generateOrderNumber();
      const actingEmpId = await resolveActingEmployeeId(ctx);
      await createOrder({
        orderNumber: newOrderNumber,
        customerName: originalOrder.customerName,
        customerPhone: originalOrder.customerPhone,
        customerAddress: originalOrder.customerAddress,
        governorate: originalOrder.governorate,
        productId: originalOrder.productId,
        productName: originalOrder.productName,
        quantity: originalOrder.quantity ?? 1,
        totalAmount: originalOrder.totalAmount,
        source: originalOrder.source,
        notes: originalOrder.notes ? `تكرار من أوردر #${originalOrder.orderNumber} — ${originalOrder.notes}` : `تكرار من أوردر #${originalOrder.orderNumber}`,
        pageName: originalOrder.pageName,
        adName: originalOrder.adName,
        lastUpdatedBy: actingEmpId,
      });
      await addActivityLog({
        action: 'duplicate_order',
        entityType: 'order',
        entityId: input.orderId,
        description: `تكرار أوردر #${originalOrder.orderNumber} → أوردر جديد #${newOrderNumber}`,
        metadata: { originalOrderId: input.orderId, originalOrderNumber: originalOrder.orderNumber, newOrderNumber },
        performedBy: ctx.user.id,
        performedByName: ctx.user.name ?? 'مدير',
        performedByRole: ctx.user.role ?? 'admin',
      });
      return { success: true, newOrderNumber };
    }),

    convertNoAnswerToNew: adminProcedure.mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' });
      const [result] = await db.execute(sql`UPDATE orders SET status = 'new' WHERE status = 'no_answer'`);
      const count = (result as any).affectedRows || 0;
      if (count > 0) {
        await addActivityLog({
          action: 'convert_no_answer',
          entityType: 'order',
          entityId: 0,
          description: `تحويل ${count} أوردر من "لم يرد" إلى "جديد"`,
          metadata: { count },
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? 'مدير',
          performedByRole: ctx.user.role ?? 'admin',
        });
      }
      return { success: true, count };
    }),

    convertPostponedToNew: adminProcedure.mutation(async ({ ctx }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' });
      const [result] = await db.execute(sql`UPDATE orders SET status = 'new', postponedTo = NULL WHERE status = 'postponed'`);
      const count = (result as any).affectedRows || 0;
      if (count > 0) {
        await addActivityLog({
          action: 'convert_postponed',
          entityType: 'order',
          entityId: 0,
          description: `تحويل ${count} أوردر من "مؤجل" إلى "جديد"`,
          metadata: { count },
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? 'مدير',
          performedByRole: ctx.user.role ?? 'admin',
        });
      }
      return { success: true, count };
    }),

    unassignEmployeeOrders: adminProcedure.input(z.object({
      employeeId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'DB error' });
      const [result] = await db.execute(sql`UPDATE orders SET assignedEmployeeId = NULL, assignedAt = NULL WHERE assignedEmployeeId = ${input.employeeId}`);
      const count = (result as any).affectedRows || 0;
      if (count > 0) {
        const emps = await getAllEmployees();
        const emp = emps.find(e => e.id === input.employeeId);
        await addActivityLog({
          action: 'unassign_employee_orders',
          entityType: 'order',
          entityId: input.employeeId,
          description: `سحب ${count} أوردر من الموظف ${emp?.name || input.employeeId}`,
          metadata: { employeeId: input.employeeId, count },
          performedBy: ctx.user.id,
          performedByName: ctx.user.name ?? 'مدير',
          performedByRole: ctx.user.role ?? 'admin',
        });
      }
      return { success: true, count };
    }),

    myOrders: protectedProcedure.input(z.object({
      status: z.string().optional(),
      page: z.number().default(1),
      limit: z.number().default(200),
      // تاريخ التوزيع - افتراضياً اليوم بتوقيت القاهرة
      assignedDate: z.string().optional(), // YYYY-MM-DD, defaults to today Cairo time
    })).query(async ({ ctx, input }) => {
      const emps = await getAllEmployees();
      const emp = emps.find(e => e.userId === ctx.user.id);
      if (!emp) return { orders: [], total: 0 };

      // حساب بداية ونهاية يوم التوزيع بتوقيت القاهرة (UTC+2)
      const { from: assignedDateFrom, to: assignedDateTo } = input.assignedDate
        ? cairoParseDateRange(input.assignedDate)
        : cairoTodayRange();

      return getOrders({
        ...input,
        assignedEmployeeId: emp.id,
        assignedDateFrom,
        assignedDateTo,
      });
    }),

    // ==================== QR SCAN PROCEDURES ====================
    scan: protectedProcedure.input(z.object({
      serialNumber: z.string(),
      deviceInfo: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      const emps = await getAllEmployees();
      const emp = emps.find((e: any) => e.userId === ctx.user.id);
      const scannedBy = emp?.id ?? ctx.user.id;
      const scannedByName = emp?.name ?? ctx.user.name ?? 'موظف';
      const result = await scanOrderBySerial(input.serialNumber, scannedBy, scannedByName, input.deviceInfo);
      return result;
    }),

    scanLogs: adminProcedure.input(z.object({
      orderId: z.number().optional(),
      scannedBy: z.number().optional(),
      limit: z.number().default(100),
    })).query(async ({ input }) => {
      return getScanLogs(input);
    }),

    todayConfirmed: protectedProcedure.input(z.object({
      confirmedByEmployeeId: z.number().optional(), // فلتر بالموظف
      date: z.string().optional(), // YYYY-MM-DD, defaults to today Cairo time
      businessId: z.number().optional(),
      businessIds: z.array(z.number()).optional(),
    })).query(async ({ input }) => {
      const db = await getDb();
      if (!db) return { orders: [], total: 0 };
      const { from, to } = input.date ? cairoParseDateRange(input.date) : cairoTodayRange();
      const conditions = [
        eq(ordersTable.status, 'confirmed'),
        gte(ordersTable.confirmedAt, from),
        lte(ordersTable.confirmedAt, to),
      ] as any[];
      if (input.confirmedByEmployeeId) {
        conditions.push(eq(ordersTable.assignedEmployeeId, input.confirmedByEmployeeId));
      }
      if (input.businessIds && input.businessIds.length > 0) {
        conditions.push(inArray(ordersTable.businessId, input.businessIds));
      } else if (input.businessId) {
        conditions.push(eq(ordersTable.businessId, input.businessId));
      }
      const rows = await db.select().from(ordersTable)
        .where(and(...conditions))
        .orderBy(desc(ordersTable.confirmedAt));
      return { orders: rows, total: rows.length };
    }),
  }),

  // ==================== EMPLOYEE PORTAL ====================
  employeePortal: router({
    me: employeePortalProcedure.query(async ({ ctx }) => {
      const emp = (ctx as any).employee;
      return {
        id: emp.id,
        name: emp.name,
        role: emp.role,
        username: emp.username,
        businessId: emp.businessId ?? null,
      };
    }),

    myOrders: employeePortalProcedure.input(z.object({
      status: z.string().optional(),
      page: z.number().default(1),
      limit: z.number().default(200),
      assignedDate: z.string().optional(), // YYYY-MM-DD, defaults to today Cairo time
      dateFrom: z.date().optional(), // فلتر تاريخ مخصص - بداية
      dateTo: z.date().optional(),   // فلتر تاريخ مخصص - نهاية
      websiteId: z.number().optional(),
      businessIds: z.array(z.number()).optional(), // فلتر حسب المجموعة (نحاس / مفروشات)
    })).query(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      // الموظف يشوف كل الأوردرات الموزعة عليه بغض النظر عن الـ business
      // لكن لو اختار مجموعة معينة نفلتر بيها
      const filterBusinessIds = input.businessIds && input.businessIds.length > 0 ? input.businessIds : undefined;
      // إذا كان فيه فلتر تاريخ مخصص، نستخدمه مباشرة
      if (input.dateFrom || input.dateTo) {
        return getOrders({
          ...input,
          assignedEmployeeId: emp.id,
          assignedDateFrom: input.dateFrom,
          assignedDateTo: input.dateTo,
          businessIds: filterBusinessIds,
        });
      }
      // وإلا نفلتر بتاريخ التوزيع اليوم بتوقيت القاهرة
      const { from: assignedDateFrom, to: assignedDateTo } = input.assignedDate
        ? cairoParseDateRange(input.assignedDate)
        : cairoTodayRange();
      return getOrders({ ...input, assignedEmployeeId: emp.id, assignedDateFrom, assignedDateTo, businessIds: filterBusinessIds });
    }),

    confirm: employeePortalProcedure.input(z.object({
      orderId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      // Ownership check: agents can only confirm their own assigned orders
      if (emp.role !== 'manager') {
        const order = await getOrderById(input.orderId);
        if (!order || order.assignedEmployeeId !== emp.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'هذا الأوردر غير مخصص لك' });
        }
      }
      await confirmOrder(input.orderId, emp.id);
      await addActivityLog({
        action: 'confirm_order',
        entityType: 'order',
        entityId: input.orderId,
        description: `تأكيد أوردر #${input.orderId} بواسطة موظف`,
        performedBy: emp.id,
        performedByName: emp.name,
        performedByRole: 'employee',
      });
      return { success: true };
    }),

    postpone: employeePortalProcedure.input(z.object({
      orderId: z.number(),
      postponedTo: z.date(),
      notes: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      // Ownership check: agents can only postpone their own assigned orders
      if (emp.role !== 'manager') {
        const order = await getOrderById(input.orderId);
        if (!order || order.assignedEmployeeId !== emp.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'هذا الأوردر غير مخصص لك' });
        }
      }
      await postponeOrder(input.orderId, input.postponedTo, input.notes, emp.id);
      await addActivityLog({
        action: 'postpone_order',
        entityType: 'order',
        entityId: input.orderId,
        description: `تأجيل أوردر #${input.orderId}`,
        metadata: { notes: input.notes },
        performedBy: emp.id,
        performedByName: emp.name,
        performedByRole: 'employee',
      });
      return { success: true };
    }),

    cancel: employeePortalProcedure.input(z.object({
      orderId: z.number(),
      cancelReason: z.enum(['price', 'not_serious', 'wrong_number', 'duplicate']),
      notes: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      // Ownership check: agents can only cancel their own assigned orders
      if (emp.role !== 'manager') {
        const order = await getOrderById(input.orderId);
        if (!order || order.assignedEmployeeId !== emp.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'هذا الأوردر غير مخصص لك' });
        }
      }
      await cancelOrder(input.orderId, input.cancelReason, input.notes, emp.id);
      await addActivityLog({
        action: 'cancel_order',
        entityType: 'order',
        entityId: input.orderId,
        description: `إلغاء أوردر #${input.orderId} - السبب: ${input.cancelReason}`,
        metadata: { cancelReason: input.cancelReason, notes: input.notes },
        performedBy: emp.id,
        performedByName: emp.name,
        performedByRole: 'employee',
      });
      return { success: true };
    }),

    markNoAnswer: employeePortalProcedure.input(z.object({
      orderId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      if (emp.role !== 'manager') {
        const order = await getOrderById(input.orderId);
        if (!order || order.assignedEmployeeId !== emp.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'هذا الأوردر غير مخصص لك' });
        }
      }
      await updateOrder(input.orderId, { status: 'no_answer', lastUpdatedBy: emp.id });
      return { success: true };
    }),

    // إضافة/تعديل ملاحظات الموظف على الأوردر
    updateNotes: employeePortalProcedure.input(z.object({
      orderId: z.number(),
      notes: z.string(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      // Ownership check: agents can only update notes on their own assigned orders
      if (emp.role !== 'manager') {
        const order = await getOrderById(input.orderId);
        if (!order || order.assignedEmployeeId !== emp.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'هذا الأوردر غير مخصص لك' });
        }
      }
      await updateOrder(input.orderId, { notes: input.notes, lastUpdatedBy: emp.id });
      return { success: true };
    }),

    // تعديل بيانات العميل (المحافظة والعنوان) — للموظف على أوردراته فقط
    updateCustomerInfo: employeePortalProcedure.input(z.object({
      orderId: z.number(),
      governorate: z.string().optional(),
      customerAddress: z.string().optional(),
      customerName: z.string().optional(),
      customerPhone: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      // Ownership check
      if (emp.role !== 'manager') {
        const order = await getOrderById(input.orderId);
        if (!order || order.assignedEmployeeId !== emp.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'هذا الأوردر غير مخصص لك' });
        }
      }
      const updates: any = { lastUpdatedBy: emp.id };
      if (input.governorate) updates.governorate = input.governorate;
      if (input.customerAddress) updates.customerAddress = input.customerAddress;
      if (input.customerName) updates.customerName = input.customerName;
      if (input.customerPhone) updates.customerPhone = input.customerPhone;
      await updateOrder(input.orderId, updates);
      return { success: true };
    }),

    // عرض المخزون المتبقي للموظفين (قراءة فقط)
    stockLevels: employeePortalProcedure.input(z.object({
      businessIds: z.array(z.number()).optional(),
    }).optional()).query(async ({ input }) => {
      return getAllProducts(undefined, input?.businessIds);
    }),

    // عرض variants المنتجات للموظف (مع الأسعار والمخزون)
    stockVariants: employeePortalProcedure.input(z.object({
      businessIds: z.array(z.number()).optional(),
    }).optional()).query(async ({ input }) => {
      return getAllVariantsWithProduct(undefined, input?.businessIds);
    }),

    stats: employeePortalProcedure.input(z.object({
      businessIds: z.array(z.number()).optional(),
    }).optional()).query(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      const filterBusinessIds = input?.businessIds && input.businessIds.length > 0 ? input.businessIds : undefined;
      // تفلتر بتاريخ التوزيع اليوم بتوقيت القاهرة
      const cairoOffset = 2 * 60 * 60 * 1000;
      const cairoNow = new Date(Date.now() + cairoOffset);
      const assignedDateFrom = new Date(Date.UTC(
        cairoNow.getUTCFullYear(), cairoNow.getUTCMonth(), cairoNow.getUTCDate(),
        0, 0, 0, 0
      ) - cairoOffset);
      const assignedDateTo = new Date(assignedDateFrom.getTime() + 24 * 60 * 60 * 1000 - 1);
      const result = await getOrders({ assignedEmployeeId: emp.id, assignedDateFrom, assignedDateTo, limit: 1000, businessIds: filterBusinessIds });
      const all = result.orders;
      return {
        total: all.length,
        new: all.filter(o => o.status === 'new').length,
        confirmed: all.filter(o => o.status === 'confirmed').length,
        postponed: all.filter(o => o.status === 'postponed').length,
        cancelled: all.filter(o => o.status === 'cancelled').length,
        delivered: all.filter(o => o.status === 'delivered').length,
        no_answer: all.filter(o => o.status === 'no_answer').length,
      };
    }),

    // تعديل بيانات الأوردر بالكامل (للموظف العادي - بدون OAuth)
    editOrder: employeePortalProcedure.input(z.object({
      orderId: z.number(),
      customerName: z.string().optional(),
      customerPhone: z.string().optional(),
      customerPhone2: z.string().optional(),
      customerAddress: z.string().optional(),
      governorate: z.string().optional(),
      city: z.string().optional(),
      productId: z.number().optional(),
      productName: z.string().optional(),
      quantity: z.number().min(1).optional(),
      totalAmount: z.number().optional(),
      shippingFees: z.number().optional(),
      paymentMethod: z.string().optional(),
      notes: z.string().optional(),
      employeeNotes: z.string().optional(),
      variantId: z.number().nullable().optional(),
      color: z.string().nullable().optional(),
      size: z.string().nullable().optional(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      const { orderId, ...updates } = input;
      // الموظف يعدل أوردراته فقط (إلا لو مدير)
      if (emp.role !== 'manager') {
        const order = await getOrderById(orderId);
        if (!order || order.assignedEmployeeId !== emp.id) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'لا يمكنك تعديل أوردر غير مسند إليك' });
        }
      }
      const result = await editOrderFull(orderId, updates, { id: emp.id, name: emp.name, role: emp.role });
      return { success: true, order: result };
    }),

    // جلب سجل تعديلات أوردر
    getOrderEditHistory: employeePortalProcedure.input(z.object({
      orderId: z.number(),
    })).query(async ({ input }) => {
      return getOrderEditLogs(input.orderId);
    }),

    // ==================== SHIPMENTS TODAY ====================
    todayShipments: employeePortalProcedure.input(z.object({
      date: z.string().optional(), // YYYY-MM-DD format, defaults to today
    })).query(async ({ input }) => {
      // Determine target date
      const targetDate = input.date ? new Date(input.date + 'T00:00:00') : new Date();
      const dayOfWeek = targetDate.getDay(); // 0=Sun, 6=Sat

      // Get start/end of that day for filtering
      const dayStart = new Date(targetDate);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(targetDate);
      dayEnd.setHours(23, 59, 59, 999);

      // Fetch confirmed orders (no date filter — we want all confirmed orders ready for shipping)
      const result = await getOrders({ status: 'confirmed', limit: 10000 });
      const allConfirmed = result.orders;

      // Group by shipping agent based on governorate + day schedule
      const grouped = groupOrdersByAgent(allConfirmed, dayOfWeek);

      // Get today's schedule
      const schedule = getTodaySchedule(dayOfWeek);

      // Build response with agent info
      const agents = Object.entries(grouped).map(([agentName, agentOrders]) => {
        const totalAmount = agentOrders.reduce((sum, o) => sum + Number(o.totalAmount || 0), 0);
        return {
          agentName,
          governorates: schedule[agentName] || [],
          orders: agentOrders.map(o => ({
            id: o.id,
            orderNumber: o.orderNumber,
            customerName: o.customerName,
            customerPhone: o.customerPhone,
            customerAddress: o.customerAddress,
            governorate: o.governorate,
            productName: o.productName,
            quantity: o.quantity,
            totalAmount: o.totalAmount,
            notes: o.notes,
            confirmedAt: o.confirmedAt,
          })),
          orderCount: agentOrders.length,
          totalAmount,
        };
      });

      // Also include agents from schedule that have 0 orders
      for (const agentName of Object.keys(schedule)) {
        if (!grouped[agentName]) {
          agents.push({
            agentName,
            governorates: schedule[agentName],
            orders: [],
            orderCount: 0,
            totalAmount: 0,
          });
        }
      }

      return {
        date: targetDate.toISOString().split('T')[0],
        dayName: DAY_NAMES_AR[dayOfWeek] || '',
        dayOfWeek,
        agents,
        totalOrders: allConfirmed.length,
      };
    }),

    // مسح QR للموظف - تجهيز الأوردر
    scan: employeePortalProcedure.input(z.object({
      serialNumber: z.string(),
      deviceInfo: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      const scannedBy = emp?.id ?? 0;
      const scannedByName = emp?.name ?? 'موظف';
      const result = await scanOrderBySerial(input.serialNumber, scannedBy, scannedByName, input.deviceInfo);
      return result;
    }),

    // ==================== MANAGER PORTAL APIs ====================
    // Dashboard stats for manager
    dashboardStats: managerPortalProcedure.input(z.object({
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
      businessIds: z.array(z.number()).optional(),
    })).query(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      return getDashboardStats(input.dateFrom, input.dateTo, emp.businessId ?? undefined, input.businessIds);
    }),

    // All orders for manager (not just assigned)
    allOrders: managerPortalProcedure.input(z.object({
      status: z.string().optional(),
      source: z.string().optional(),
      governorate: z.string().optional(),
      assignedEmployeeId: z.number().optional(),
      websiteId: z.number().optional(),
      businessId: z.number().optional(),
      businessIds: z.array(z.number()).optional(),
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
      search: z.string().optional(),
      page: z.number().default(1),
      limit: z.number().default(50),
    })).query(async ({ ctx, input }) => {
      // If employee has a businessId, filter by it
      const emp = (ctx as any).employee;
      const effectiveBusinessIds = input.businessIds ?? (input.businessId ? [input.businessId] : (emp.businessId ? [emp.businessId] : undefined));
      return getOrders({ ...input, businessId: undefined, businessIds: effectiveBusinessIds });
    }),

    // Assign order to employee
    assignOrder: managerPortalProcedure.input(z.object({
      orderId: z.number(),
      employeeId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      await assignOrderToEmployee(input.orderId, input.employeeId, emp.id);
      return { success: true };
    }),

    // Bulk assign orders
    bulkAssignOrders: managerPortalProcedure.input(z.object({
      orderIds: z.array(z.number()),
      employeeId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      await bulkAssignOrders(input.orderIds, input.employeeId, emp.id);
      return { success: true };
    }),

    // Create order
    createOrder: managerPortalProcedure.input(z.object({
      customerName: z.string().min(2),
      customerPhone: z.string().min(10),
      customerAddress: z.string().min(5),
      governorate: z.string().min(2),
      productId: z.number(),
      productName: z.string(),
      quantity: z.number().min(1).default(1),
      totalAmount: z.string(),
      source: z.enum(['easyorder', 'easyorder_ataba', 'easyorder_farhat', 'shopify', 'whatsapp', 'manual', 'facebook']).default('manual'),
      notes: z.string().optional(),
      websiteId: z.number().optional(),
      businessId: z.number().optional(),
      variantId: z.number().optional(),
      // بنود متعددة (أنواع حفر مختلفة) — اختياري، لو موجود يتجاوز productId/quantity المفرد
      selectedProducts: z.array(z.object({
        productId: z.number().int().min(1),
        productName: z.string().min(1),
        quantity: z.number().int().min(1).optional(),
      })).optional(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      const orderNumber = await generateOrderNumber();
      const effectiveBusinessId = input.businessId ?? emp.businessId ?? undefined;
      // تجهيز البنود؛ لو مفيش selectedProducts نستخدم المنتج المفرد
      const items = (input.selectedProducts && input.selectedProducts.length > 0)
        ? input.selectedProducts.map(p => ({ ...p, quantity: p.quantity ?? 1 }))
        : [{ productId: input.productId, productName: input.productName, quantity: input.quantity }];
      const totalQty = items.reduce((sum, p) => sum + p.quantity, 0) || input.quantity || 1;
      const productNames = items
        .map(p => p.quantity > 1 ? `${p.productName} ×${p.quantity}` : p.productName)
        .join(' + ');
      const firstProductId = items[0].productId;
      const newOrderId = await createOrder({
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        customerAddress: input.customerAddress,
        governorate: input.governorate,
        productId: firstProductId,
        productName: productNames,
        quantity: totalQty,
        totalAmount: input.totalAmount,
        source: input.source,
        notes: input.notes,
        orderNumber,
        lastUpdatedBy: emp.id,
        businessId: effectiveBusinessId,
        websiteId: input.websiteId ?? null,
        variantId: input.variantId ?? null,
      });
      // تخزين البنود لو فيه أكتر من بند أو دائماً للتوحيد
      if (newOrderId) {
        await replaceOrderItems(newOrderId, items.map(p => ({
          productId: p.productId,
          productName: p.productName,
          quantity: p.quantity,
          variantId: p.productId === firstProductId ? (input.variantId ?? undefined) : undefined,
        })));
      }
      return { success: true, orderNumber };
    }),

    // Products list
    productsList: employeePortalProcedure.query(async ({ ctx }) => {
      const emp = (ctx as any).employee;
      if (emp.role !== 'manager' && emp.role !== 'warehouse') throw new TRPCError({ code: 'FORBIDDEN', message: 'غير مصرح' });
      return getAllProducts(emp.businessId ?? undefined);
    }),
    // Low stock products
    lowStockProducts: employeePortalProcedure.query(async ({ ctx }) => {
      const emp = (ctx as any).employee;
      if (emp.role !== 'manager' && emp.role !== 'warehouse') throw new TRPCError({ code: 'FORBIDDEN', message: 'غير مصرح' });
      return getLowStockProducts(emp.businessId ?? undefined);
    }),
    // Add inventory movement
    addInventoryMovement: employeePortalProcedure.input(z.object({
      productId: z.number(),
      type: z.enum(['in', 'out']),
      quantity: z.number().min(1),
      reason: z.string().optional(),
      orderId: z.number().optional(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      if (emp.role !== 'manager' && emp.role !== 'warehouse') throw new TRPCError({ code: 'FORBIDDEN', message: 'غير مصرح' });
      await addInventoryMovement({
        ...input,
        performedBy: emp.id,
      });
      return { success: true };
    }),
    // Inventory movements
    inventoryMovements: employeePortalProcedure.input(z.object({
      productId: z.number().optional(),
      limit: z.number().default(50),
    })).query(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      if (emp.role !== 'manager' && emp.role !== 'warehouse') throw new TRPCError({ code: 'FORBIDDEN', message: 'غير مصرح' });
      return getInventoryMovements(input.productId, input.limit, emp.businessId ?? undefined);
    }),

    // Employee performance report
    employeePerformance: managerPortalProcedure.input(z.object({
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
    })).query(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      const bId = emp.businessId ?? undefined;
      const [perf, emps] = await Promise.all([
        getEmployeePerformance(input.dateFrom, input.dateTo, bId),
        getAllEmployees(bId),
      ]);
      return perf.map(p => {
        const emp = emps.find(e => e.id === p.employeeId);
        return {
          ...p,
          employeeName: emp?.name ?? 'غير معروف',
          total: Number(p.total),
          confirmed: Number(p.confirmed),
          cancelled: Number(p.cancelled),
          postponed: Number(p.postponed),
          delivered: Number(p.delivered),
          confirmRate: p.total > 0 ? Math.round((Number(p.confirmed) / Number(p.total)) * 100) : 0,
          cancelRate: p.total > 0 ? Math.round((Number(p.cancelled) / Number(p.total)) * 100) : 0,
        };
      });
    }),

    // Cancellation reasons
    cancellationReasons: managerPortalProcedure.input(z.object({
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
    })).query(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      return getCancellationReasons(input.dateFrom, input.dateTo, emp.businessId ?? undefined);
    }),

    // Daily chart
    dailyChart: managerPortalProcedure.input(z.object({
      days: z.number().default(30),
    })).query(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      return getDailyOrdersChart(input.days, emp.businessId ?? undefined);
    }),

    // Employees list
    employeesList: managerPortalProcedure.query(async ({ ctx }) => {
      const emp = (ctx as any).employee;
      return getAllEmployees(emp.businessId ?? undefined);
    }),

    // Active employees list
    activeEmployeesList: managerPortalProcedure.query(async ({ ctx }) => {
      const emp = (ctx as any).employee;
      return getActiveEmployees(emp.businessId ?? undefined);
    }),

    // Create employee
    createEmployee: managerPortalProcedure.input(z.object({
      name: z.string().min(2),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      role: z.enum(['agent', 'warehouse', 'manager', 'facebook_entry', 'scanner']).default('agent'),
    })).mutation(async ({ input }) => {
      await createEmployee(input);
      return { success: true };
    }),

    // Update employee
    updateEmployee: managerPortalProcedure.input(z.object({
      id: z.number(),
      name: z.string().min(2).optional(),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      role: z.enum(['agent', 'warehouse', 'manager', 'facebook_entry', 'scanner']).optional(),
      isActive: z.boolean().optional(),
    })).mutation(async ({ input }) => {
      const { id, ...data } = input;
      await updateEmployee(id, data);
      return { success: true };
    }),

    // Delete employee
    deleteEmployee: managerPortalProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
      await deleteEmployee(input.id);
      return { success: true };
    }),

    // Set employee credentials
    setEmployeeCredentials: managerPortalProcedure.input(z.object({
      id: z.number(),
      username: z.string().min(3).max(50),
      password: z.string().min(6),
    })).mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const existing = await db.select().from(employees)
        .where(eq(employees.username, input.username)).limit(1);
      if (existing.length > 0 && existing[0].id !== input.id) {
        throw new TRPCError({ code: 'CONFLICT', message: 'اسم المستخدم مستخدم بالفعل' });
      }
      const passwordHash = await bcrypt.hash(input.password, 10);
      await db.update(employees)
        .set({ username: input.username, passwordHash })
        .where(eq(employees.id, input.id));
      return { success: true };
    }),

    // Change employee password
    changeEmployeePassword: managerPortalProcedure.input(z.object({
      id: z.number(),
      newPassword: z.string().min(6),
    })).mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const passwordHash = await bcrypt.hash(input.newPassword, 10);
      await db.update(employees)
        .set({ passwordHash })
        .where(eq(employees.id, input.id));
      return { success: true };
    }),

    // ==================== BROADCAST MESSAGES ====================
    // إرسال رسالة لجميع الموظفين (من لوحة المدير - employee session)
    sendBroadcast: managerPortalProcedure.input(z.object({
      message: z.string().min(1).max(500),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { broadcastMessages } = await import('../drizzle/schema');
      await db.update(broadcastMessages).set({ isActive: false });
      await db.insert(broadcastMessages).values({
        message: input.message,
        sentBy: emp.id,
        sentByName: emp.name,
        isActive: true,
      });
      return { success: true };
    }),

    // حذف الرسالة النشطة (من لوحة المدير - employee session)
    clearBroadcast: managerPortalProcedure.mutation(async () => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { broadcastMessages } = await import('../drizzle/schema');
      await db.update(broadcastMessages).set({ isActive: false });
      return { success: true };
    }),

    // جلب الرسالة النشطة (للموظفين - employee session)
    activeBroadcast: employeePortalProcedure.query(async () => {
      const db = await getDb();
      if (!db) return null;
      const { broadcastMessages } = await import('../drizzle/schema');
      const [msg] = await db.select().from(broadcastMessages)
        .where(eq(broadcastMessages.isActive, true))
        .orderBy(desc(broadcastMessages.createdAt))
        .limit(1);
      return msg ?? null;
    }),

    // ==================== الأوردرات المكررة ====================
    // تعليم أوردر كمكرر (من الموظف)
    markDuplicate: employeePortalProcedure.input(z.object({
      orderId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { orders } = await import('../drizzle/schema');
      await db.update(orders)
        .set({
          isDuplicate: true,
          duplicateMarkedAt: new Date(),
          duplicateMarkedBy: emp.id,
        })
        .where(eq(orders.id, input.orderId));
      return { success: true };
    }),

    // إلغاء تعليم التكرار (من الموظف)
    unmarkDuplicate: employeePortalProcedure.input(z.object({
      orderId: z.number(),
    })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { orders } = await import('../drizzle/schema');
      await db.update(orders)
        .set({ isDuplicate: false, duplicateMarkedAt: null, duplicateMarkedBy: null })
        .where(eq(orders.id, input.orderId));
      return { success: true };
    }),
  }),

  // ==================== الأوردرات المكررة (لوحة المدير) ====================
  duplicates: router({
    // جلب كل الأوردرات المعلمة كمكررة
    list: adminProcedure.query(async () => {
      const db = await getDb();
      if (!db) return [];
      const { orders } = await import('../drizzle/schema');
      return db.select().from(orders)
        .where(eq(orders.isDuplicate, true))
        .orderBy(desc(orders.duplicateMarkedAt));
    }),

    // حذف أوردر مكرر (من لوحة المدير)
    delete: ownerProcedure.input(z.object({
      orderId: z.number(),
    })).mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { orders } = await import('../drizzle/schema');
      await db.delete(orders).where(eq(orders.id, input.orderId));
      return { success: true };
    }),

    // إلغاء تعليم التكرار (إعادة للأوردرات العادية)
    restore: adminProcedure.input(z.object({
      orderId: z.number(),
    })).mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { orders } = await import('../drizzle/schema');
      await db.update(orders)
        .set({ isDuplicate: false, duplicateMarkedAt: null, duplicateMarkedBy: null })
        .where(eq(orders.id, input.orderId));
      return { success: true };
    }),

    // حذف جميع المكررات
    deleteAll: ownerProcedure.mutation(async () => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { orders } = await import('../drizzle/schema');
      const result = await db.delete(orders).where(eq(orders.isDuplicate, true));
      return { deleted: (result as any).affectedRows ?? 0 };
    }),
  }),

  // ==================== FACEBOOK ENTRY (موظف إدخال فيسبوك) ====================
  facebookEntry: router({
    // إضافة أوردر فيسبوك يدوياً
    addOrder: employeePortalProcedure.input(z.object({
      customerName: z.string().min(1),
      customerPhone: z.string().min(5),
      governorate: z.string().min(1),
      customerAddress: z.string().min(1),
      /** City / area within the governorate, when the message mentioned one. */
      city: z.string().optional(),
      selectedProducts: z.array(z.object({
        // Optional: an item the parser could not match is still recorded (with its raw
        // text) and the order is flagged for review, rather than being dropped or
        // silently attached to an arbitrary product.
        productId: z.number().int().min(1).optional(),
        productName: z.string().min(1),
        quantity: z.number().int().min(1).optional(),
        /** Engraving type / variant for this specific item. */
        variantId: z.number().int().optional(),
        unitPrice: z.number().min(0).optional(),
      })).min(1),
      quantity: z.number().int().min(1).optional(),
      totalAmount: z.number().min(0),
      shippingCost: z.number().min(0).optional(),
      adName: z.string().optional(),
      pageName: z.string().optional(),
      notes: z.string().optional(),
      /** Original pasted message, kept verbatim for audit when the parser was used. */
      rawText: z.string().optional(),
      // حقول كفر مرتبة ووتر بروف
      variantId: z.number().int().optional(),
      size: z.string().optional(),
      color: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { orders } = await import('../drizzle/schema');
      // توليد رقم أوردر فريد
      const timestamp = Date.now();
      const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
      const orderNumber = `FB-${timestamp}-${random}`;
      // عدد القطع لكل بند (افتراضي 1 لو غير محدد)
      const itemsWithQty = input.selectedProducts.map(p => ({ ...p, quantity: p.quantity ?? 1 }));
      // العدد الإجمالي = مجموع كميات البنود
      const totalQty = itemsWithQty.reduce((sum, p) => sum + p.quantity, 0) || input.quantity || 1;
      // وصف يجمع كل البنود مع أعدادها (مثال: "آية الكرسي ×4 + التحصين ×4")
      const productNames = itemsWithQty
        .map(p => p.quantity > 1 ? `${p.productName} ×${p.quantity}` : p.productName)
        .join(' + ');

      // Any item without a resolved product means the order needs a human to finish
      // mapping it. It is still created — never dropped — but flagged, and the header
      // productId points at the first RESOLVED item (or null when none resolved) rather
      // than at an arbitrary product.
      const unresolved = itemsWithQty.filter(p => !p.productId);
      const needsReview = unresolved.length > 0;
      const firstResolved = itemsWithQty.find(p => p.productId);
      const headerProductId = firstResolved?.productId ?? null;
      const headerVariantId = firstResolved?.variantId ?? input.variantId ?? null;

      const normalizedCustomerPhone = normalizeEgyptianPhone(input.customerPhone) || input.customerPhone;
      const [res] = await db.insert(orders).values({
        orderNumber,
        customerName: input.customerName,
        customerPhone: normalizedCustomerPhone,
        governorate: input.governorate,
        customerAddress: input.customerAddress,
        city: input.city ?? null,
        productId: headerProductId,
        productName: productNames,
        quantity: totalQty,
        totalAmount: input.totalAmount.toString(),
        shippingFees: input.shippingCost != null ? input.shippingCost.toString() : undefined,
        source: 'facebook',
        adName: input.adName ?? null,
        pageName: input.pageName ?? null,
        notes: input.notes ?? null,
        status: 'new',
        lastUpdatedBy: ctx.employee.id,
        variantId: headerVariantId,
        size: input.size ?? null,
        color: input.color ?? null,
        needsReview,
        reviewReason: needsReview
          ? `أصناف غير مطابقة تحتاج تعيين منتج يدويًا: ${unresolved.map(u => u.productName).join(' | ')}`
          : null,
        // Verbatim pasted message for audit, when the paste parser was used.
        externalRawPayload: input.rawText ?? null,
      }).$returningId();
      // تخزين البنود المتعددة
      const newOrderId = (res as any)?.id;
      if (newOrderId) {
        await replaceOrderItems(newOrderId, itemsWithQty.map(p => ({
          productId: p.productId,
          productName: p.productName,
          quantity: p.quantity,
          unitPrice: p.unitPrice,
          // Each item carries its OWN variant now (previously only the first product could
          // have one, which made multi-engraving orders impossible to represent).
          variantId: p.variantId,
          size: p.productId === headerProductId ? (input.size ?? undefined) : undefined,
          color: p.productId === headerProductId ? (input.color ?? undefined) : undefined,
        })));
      }
      return { success: true, orderNumber, needsReview };
    }),

    // جلب أوردرات الموظف الحالي (فيسبوك)
    myOrders: employeePortalProcedure.input(z.object({
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
    })).query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) return [];
      const { orders } = await import('../drizzle/schema');
      const { and, gte, lte } = await import('drizzle-orm');
      const conditions: any[] = [
        eq(orders.source, 'facebook'),
        eq(orders.lastUpdatedBy, ctx.employee.id),
      ];
      // Filter by employee's businessId
      if (ctx.employee.businessId) {
        conditions.push(eq(orders.businessId, ctx.employee.businessId));
      }
      if (input.dateFrom) {
        conditions.push(gte(orders.createdAt, new Date(input.dateFrom)));
      }
      if (input.dateTo) {
        const end = new Date(input.dateTo);
        end.setHours(23, 59, 59, 999);
        conditions.push(lte(orders.createdAt, end));
      }
      const rows = await db.select().from(orders)
        .where(and(...conditions))
        .orderBy(desc(orders.createdAt))
        .limit(200);
      // إرفاق بنود كل أوردر
      const itemsMap = await getOrderItemsForOrders(rows.map(o => o.id));
      return rows.map(o => ({ ...o, items: itemsMap.get(o.id) ?? [] }));
    }),

    // حذف أوردر (الموظف يحذف أوردر دخله هو فقط)
    deleteOrder: employeePortalProcedure.input(z.object({
      orderId: z.number().int().min(1),
    })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { orders } = await import('../drizzle/schema');
      // التأكد إن الأوردر ده هو اللي دخله الموظف
      const [order] = await db.select().from(orders)
        .where(and(
          eq(orders.id, input.orderId),
          eq(orders.lastUpdatedBy, ctx.employee.id),
          eq(orders.source, 'facebook'),
        ))
        .limit(1);
      if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'الأوردر غير موجود أو ليس من إدخالك' });
      await db.delete(orders).where(eq(orders.id, input.orderId));
      return { success: true };
    }),

    // تعديل أوردر (الموظف يعدل أوردر دخله هو فقط)
    updateOrder: employeePortalProcedure.input(z.object({
      orderId: z.number().int().min(1),
      customerName: z.string().min(1),
      customerPhone: z.string().min(5),
      governorate: z.string().min(1),
      customerAddress: z.string().min(1),
      selectedProducts: z.array(z.object({
        productId: z.number().int().min(1),
        productName: z.string().min(1),
        quantity: z.number().int().min(1).optional(),
      })).min(1),
      quantity: z.number().int().min(1).optional(),
      totalAmount: z.number().min(0),
      adName: z.string().optional(),
      pageName: z.string().optional(),
      notes: z.string().optional(),
      // حقول كفر مرتبة ووتر بروف
      variantId: z.number().int().optional(),
      size: z.string().optional(),
      color: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { orders } = await import('../drizzle/schema');
      // التأكد إن الأوردر ده هو اللي دخله الموظف
      const [order] = await db.select().from(orders)
        .where(and(
          eq(orders.id, input.orderId),
          eq(orders.lastUpdatedBy, ctx.employee.id),
          eq(orders.source, 'facebook'),
        ))
        .limit(1);
      if (!order) throw new TRPCError({ code: 'NOT_FOUND', message: 'الأوردر غير موجود أو ليس من إدخالك' });
      const itemsWithQty = input.selectedProducts.map(p => ({ ...p, quantity: p.quantity ?? 1 }));
      const totalQty = itemsWithQty.reduce((sum, p) => sum + p.quantity, 0) || input.quantity || 1;
      const productNames = itemsWithQty
        .map(p => p.quantity > 1 ? `${p.productName} ×${p.quantity}` : p.productName)
        .join(' + ');
      const firstProductId = itemsWithQty[0].productId;
      await db.update(orders).set({
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        governorate: input.governorate,
        customerAddress: input.customerAddress,
        productId: firstProductId,
        productName: productNames,
        quantity: totalQty,
        totalAmount: input.totalAmount.toString(),
        adName: input.adName ?? null,
        pageName: input.pageName ?? null,
        notes: input.notes ?? null,
        variantId: input.variantId ?? null,
        size: input.size ?? null,
        color: input.color ?? null,
      }).where(eq(orders.id, input.orderId));
      // تحديث البنود المتعددة
      await replaceOrderItems(input.orderId, itemsWithQty.map(p => ({
        productId: p.productId,
        productName: p.productName,
        quantity: p.quantity,
        variantId: p.productId === firstProductId ? (input.variantId ?? undefined) : undefined,
        size: p.productId === firstProductId ? (input.size ?? undefined) : undefined,
        color: p.productId === firstProductId ? (input.color ?? undefined) : undefined,
      })));
      return { success: true };
    }),

    // جلب قائمة المنتجات
    products: employeePortalProcedure.query(async () => {
      const db = await getDb();
      if (!db) return [];
      const { products } = await import('../drizzle/schema');
      return db.select().from(products).where(eq(products.isActive, true)).orderBy(products.name);
    }),

    /**
     * Active catalog (products + their variants) for the paste parser and the item picker.
     * Since the parent/variant refactor, `products` alone is only the parent + standalones —
     * the engraving types live in product_variants, so both are needed to select an item.
     */
    catalog: employeePortalProcedure.query(async () => {
      return getMatchCatalog();
    }),

    /**
     * Parses a pasted customer message into a REVIEW DRAFT using the live catalog.
     * Read-only: creates nothing and never submits. The employee reviews and confirms.
     */
    parseOrder: employeePortalProcedure.input(z.object({
      text: z.string().min(1),
    })).query(async ({ input }) => {
      const catalog = await getMatchCatalog();
      return parseFacebookOrder(input.text, catalog);
    }),

    // جلب variants منتج معين (للكفر ووتر بروف)
    productVariants: employeePortalProcedure.input(z.object({
      productId: z.number().int().min(1),
    })).query(async ({ input }) => {
      const db = await getDb();
      if (!db) return [];
      const { productVariants } = await import('../drizzle/schema');
      return db.select().from(productVariants)
        .where(eq(productVariants.productId, input.productId))
        .orderBy(productVariants.size, productVariants.color);
    }),

    // جلب سجل المسحات للموظف الحالي
    scanLogs: employeePortalProcedure.input(z.object({
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
      result: z.enum(['success', 'failed', 'duplicate', 'cancelled']).optional(),
      limit: z.number().default(500),
    })).query(async ({ ctx, input }) => {
      const emp = (ctx as any).employee;
      const db = await getDb();
      if (!db) return { logs: [], stats: { total: 0, success: 0, failed: 0, duplicate: 0, cancelled: 0 } };
      
      const { scanLogs: scanLogsTable, orders } = await import('../drizzle/schema');
      
      // Build where conditions
      const conditions: any[] = [eq(scanLogsTable.scannedBy, emp.id)];
      
      if (input.dateFrom) {
        conditions.push(gte(scanLogsTable.createdAt, input.dateFrom));
      }
      if (input.dateTo) {
        const endOfDay = new Date(input.dateTo);
        endOfDay.setHours(23, 59, 59, 999);
        conditions.push(lte(scanLogsTable.createdAt, endOfDay));
      }
      if (input.result) {
        conditions.push(eq(scanLogsTable.result, input.result));
      }
      
      // Fetch logs with order details
      const logs = await db
        .select({
          id: scanLogsTable.id,
          orderId: scanLogsTable.orderId,
          serialNumber: scanLogsTable.serialNumber,
          scannedBy: scanLogsTable.scannedBy,
          scannedByName: scanLogsTable.scannedByName,
          result: scanLogsTable.result,
          deviceInfo: scanLogsTable.deviceInfo,
          createdAt: scanLogsTable.createdAt,
          orderNumber: orders.orderNumber,
          customerName: orders.customerName,
          customerPhone: orders.customerPhone,
          governorate: orders.governorate,
        })
        .from(scanLogsTable)
        .leftJoin(orders, eq(scanLogsTable.orderId, orders.id))
        .where(and(...conditions))
        .orderBy(desc(scanLogsTable.createdAt))
        .limit(input.limit);
      
      // Calculate stats
      const allLogs = await db
        .select({ result: scanLogsTable.result })
        .from(scanLogsTable)
        .where(and(...conditions));
      
      const stats = {
        total: allLogs.length,
        success: allLogs.filter((l: any) => l.result === 'success').length,
        failed: allLogs.filter((l: any) => l.result === 'failed').length,
        duplicate: allLogs.filter((l: any) => l.result === 'duplicate').length,
        cancelled: allLogs.filter((l: any) => l.result === 'cancelled').length,
      };
      
      return {
        logs: logs.map((log: any) => ({
          id: log.id,
          orderId: log.orderId,
          serialNumber: log.serialNumber,
          scannedBy: log.scannedBy,
          scannedByName: log.scannedByName,
          result: log.result,
          deviceInfo: log.deviceInfo,
          createdAt: log.createdAt,
          order: log.orderNumber ? {
            orderNumber: log.orderNumber,
            customerName: log.customerName,
            customerPhone: log.customerPhone,
            governorate: log.governorate,
          } : null,
        })),
        stats,
      };
    }),

  }),

  // ==================== WEBHOOK ====================
  webhook: router({
    log: adminProcedure.query(async () => {
      const { getWebhookLog } = await import('./easyorderWebhook');
      const log = await getWebhookLog();
      return { log };
    }),
    stats: adminProcedure.query(async () => {
      const { getWebhookLog } = await import('./easyorderWebhook');
      const log = await getWebhookLog(1000);
      const total = log.length;
      const success = log.filter((e: any) => e.status === 'success').length;
      const duplicate = log.filter((e: any) => e.status === 'duplicate').length;
      const error = log.filter((e: any) => e.status === 'error').length;
      const statusUpdate = log.filter((e: any) => e.status === 'status_update').length;
      return { total, success, duplicate, error, statusUpdate };
    }),
  }),

  // ==================== REPORTS ====================
  reports: router({
    dashboard: adminProcedure.input(z.object({
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
      businessId: z.number().optional(),
      businessIds: z.array(z.number()).optional(),
    })).query(async ({ input }) => {
      return getDashboardStats(input.dateFrom, input.dateTo, input.businessId, input.businessIds);
    }),

    employeePerformance: adminProcedure.input(z.object({
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
      businessId: z.number().optional(),
      businessIds: z.array(z.number()).optional(),
    })).query(async ({ input }) => {
      const [perf, emps] = await Promise.all([
        getEmployeePerformance(input.dateFrom, input.dateTo, input.businessId, input.businessIds),
        getAllEmployees(input.businessId),
      ]);
      return perf.map(p => {
        const emp = emps.find(e => e.id === p.employeeId);
        return {
          ...p,
          employeeName: emp?.name ?? 'غير معروف',
          total: Number(p.total),
          confirmed: Number(p.confirmed),
          cancelled: Number(p.cancelled),
          postponed: Number(p.postponed),
          delivered: Number(p.delivered),
          confirmRate: p.total > 0 ? Math.round((Number(p.confirmed) / Number(p.total)) * 100) : 0,
          cancelRate: p.total > 0 ? Math.round((Number(p.cancelled) / Number(p.total)) * 100) : 0,
        };
      });
    }),

    cancellationReasons: adminProcedure.input(z.object({
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
      businessId: z.number().optional(),
      businessIds: z.array(z.number()).optional(),
    })).query(async ({ input }) => {
      return getCancellationReasons(input.dateFrom, input.dateTo, input.businessId, input.businessIds);
    }),

    dailyChart: adminProcedure.input(z.object({
      days: z.number().default(30),
      businessId: z.number().optional(),
      businessIds: z.array(z.number()).optional(),
    })).query(async ({ input }) => {
      return getDailyOrdersChart(input.days, input.businessId, input.businessIds);
    }),

    // تقرير الدمج التلقائي للأوردرات المكررة
    mergeLogs: adminProcedure.input(z.object({
      dateFrom: z.date().optional(),
      dateTo: z.date().optional(),
      limit: z.number().default(100),
    })).query(async ({ input }) => {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.default.createConnection(process.env.DATABASE_URL!);
      try {
        let query = 'SELECT * FROM merge_logs';
        const params: any[] = [];
        const conditions: string[] = [];
        if (input.dateFrom) { conditions.push('createdAt >= ?'); params.push(input.dateFrom); }
        if (input.dateTo) { conditions.push('createdAt <= ?'); params.push(input.dateTo); }
        if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
        const safeLimit = Math.min(Math.max(1, Math.floor(Number(input.limit))), 1000);
        query += ` ORDER BY createdAt DESC LIMIT ${safeLimit}`;
        const [rows] = await conn.execute(query, params);
        return { logs: rows as any[] };
      } finally {
        await conn.end();
      }
    }),

    // عدد الدمج في آخر 24 ساعة (للتنبيه)
    mergeAlert: adminProcedure.query(async () => {
      const mysql = await import('mysql2/promise');
      const conn = await mysql.default.createConnection(process.env.DATABASE_URL!);
      try {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const [rows] = await conn.execute(
          'SELECT COUNT(*) as count, SUM(mergedQty) as totalMergedQty FROM merge_logs WHERE createdAt >= ?',
          [since]
        ) as any;
        const count = Number(rows[0].count);
        const totalMergedQty = Number(rows[0].totalMergedQty || 0);
        return { count, totalMergedQty, hasAlert: count > 0 };
      } finally {
        await conn.end();
      }
    }),
  }),

  // ==================== BROADCAST (Admin OAuth) ====================
  broadcast: router({
    // جلب الرسالة النشطة (للأدمن عبر Manus OAuth)
    getActive: protectedProcedure.query(async () => {
      const db = await getDb();
      if (!db) return null;
      const { broadcastMessages } = await import('../drizzle/schema');
      const [msg] = await db.select().from(broadcastMessages)
        .where(eq(broadcastMessages.isActive, true))
        .orderBy(desc(broadcastMessages.createdAt))
        .limit(1);
      return msg ?? null;
    }),

    // إرسال رسالة (للأدمن عبر Manus OAuth)
    send: adminProcedure.input(z.object({
      message: z.string().min(1).max(500),
    })).mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { broadcastMessages } = await import('../drizzle/schema');
      await db.update(broadcastMessages).set({ isActive: false });
      await db.insert(broadcastMessages).values({
        message: input.message,
        sentBy: ctx.user.id,
        sentByName: ctx.user.name ?? 'مدير',
        isActive: true,
      });
      return { success: true };
    }),

    // حذف الرسالة (للأدمن عبر Manus OAuth)
    clear: adminProcedure.mutation(async () => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
      const { broadcastMessages } = await import('../drizzle/schema');
      await db.update(broadcastMessages).set({ isActive: false });
      return { success: true };
    }),
  }),

  // ==================== RETURNS ====================
  returns: router({
    // تسجيل مرتجع جديد
    markAsReturned: protectedProcedure
      .input(z.object({
        orderId: z.number(),
        returnReason: z.enum(['customer_refused', 'wrong_product', 'damaged', 'wrong_address', 'customer_not_available', 'other']),
        notes: z.string().optional(),
        restoreStock: z.boolean().default(true),
      }))
      .mutation(async ({ input, ctx }) => {
        const userId = ctx.user?.id ?? 0;
        return markOrderAsReturned(
          input.orderId,
          input.returnReason,
          input.notes,
          userId,
          input.restoreStock
        );
      }),

    // قائمة المرتجعات
    list: protectedProcedure
      .input(z.object({
        page: z.number().default(1),
        limit: z.number().default(50),
        governorate: z.string().optional(),
        returnReason: z.string().optional(),
        dateFrom: z.date().optional(),
        dateTo: z.date().optional(),
        businessId: z.number().optional(),
      }))
      .query(async ({ input }) => {
        return getReturnsList(input);
      }),

    // إحصائيات المرتجعات
    stats: protectedProcedure
      .input(z.object({
        dateFrom: z.date().optional(),
        dateTo: z.date().optional(),
        businessId: z.number().optional(),
      }))
      .query(async ({ input }) => {
        return getReturnsStats(input.dateFrom, input.dateTo, input.businessId);
      }),
  }),

  // نظام توزيع المهام
  tasks: router({
    // إنشاء مهمة جديدة (مدير فقط)
    create: protectedProcedure
      .input(z.object({
        title: z.string().min(2),
        description: z.string().optional(),
        assignedTo: z.number().optional(), // null = لجميع الموظفين
      }))
      .mutation(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) throw new Error('قاعدة البيانات غير متاحة');
        const { tasks } = await import('../drizzle/schema');

        // جلب اسم الموظف المحدد
        let assignedToName: string | null = null;
        if (input.assignedTo) {
          const emp = await db.select().from(employees).where(eq(employees.id, input.assignedTo)).limit(1);
          assignedToName = emp[0]?.name ?? null;
        }

        // جلب اسم المدير المنشئ
        const creatorEmp = await db.select().from(employees).where(eq(employees.id, ctx.user?.id ?? 0)).limit(1);
        const createdByName = creatorEmp[0]?.name ?? ctx.user?.name ?? 'المدير';

        await db.insert(tasks).values({
          title: input.title,
          description: input.description ?? null,
          assignedTo: input.assignedTo ?? null,
          assignedToName,
          createdBy: ctx.user?.id ?? 0,
          createdByName,
        });
        return { success: true };
      }),

    // قائمة المهام (المدير يرى الكل، الموظف يرى مهامه فقط)
    list: protectedProcedure
      .input(z.object({
        employeeId: z.number().optional(),
        status: z.string().optional(),
      }))
      .query(async ({ input, ctx }) => {
        const db = await getDb();
        if (!db) return [];
        const { tasks } = await import('../drizzle/schema');

        const conditions: any[] = [];
        if (input.status && input.status !== 'all') {
          conditions.push(eq(tasks.status, input.status as any));
        }
        if (input.employeeId) {
          // الموظف يرى مهامه + المهام العامة
          conditions.push(
            sql`(${tasks.assignedTo} = ${input.employeeId} OR ${tasks.assignedTo} IS NULL)`
          );
        }

        const where = conditions.length > 0 ? and(...conditions) : undefined;
        const rows = await db.select().from(tasks).where(where).orderBy(desc(tasks.createdAt)).limit(100);
        return rows;
      }),

    // تحديث حالة المهمة
    updateStatus: protectedProcedure
      .input(z.object({
        taskId: z.number(),
        status: z.enum(['new', 'in_progress', 'done']),
      }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new Error('قاعدة البيانات غير متاحة');
        const { tasks } = await import('../drizzle/schema');
        await db.update(tasks).set({ status: input.status }).where(eq(tasks.id, input.taskId));
        return { success: true };
      }),

    // حذف مهمة (مدير فقط)
    delete: protectedProcedure
      .input(z.object({ taskId: z.number() }))
      .mutation(async ({ input }) => {
        const db = await getDb();
        if (!db) throw new Error('قاعدة البيانات غير متاحة');
        const { tasks } = await import('../drizzle/schema');
        await db.delete(tasks).where(eq(tasks.id, input.taskId));
        return { success: true };
      }),
  }),

  // ==================== سجل الطباعات ====================
  printLogs: router({
    create: protectedProcedure.input(z.object({
      type: z.enum(["shipping_sheet", "labels"]),
      orderIds: z.array(z.number()).min(1),
      notes: z.string().optional(),
    })).mutation(async ({ ctx, input }) => {
      const result = await createPrintLog({
        type: input.type,
        orderIds: input.orderIds,
        printedBy: ctx.user.id,
        printedByName: ctx.user.name ?? 'مدير',
        notes: input.notes,
      });
      return result;
    }),

    list: protectedProcedure.input(z.object({
      limit: z.number().min(1).max(100).optional(),
      businessId: z.number().optional(),
    }).optional()).query(async ({ input }) => {
      const logs = await getPrintLogs(input?.limit ?? 50, input?.businessId);
      return logs;
    }),

    getById: protectedProcedure.input(z.object({
      id: z.number(),
    })).query(async ({ input }) => {
      const log = await getPrintLogById(input.id);
      if (!log) throw new TRPCError({ code: 'NOT_FOUND', message: 'السجل غير موجود' });
      return log;
    }),
  }),

  // ==================== سجل الأنشطة (Activity Log) ====================
  activityLog: router({
    list: adminProcedure.input(z.object({
      page: z.number().min(1).optional(),
      limit: z.number().min(1).max(100).optional(),
      action: z.string().optional(),
      entityType: z.string().optional(),
      entityId: z.number().optional(),
      performedBy: z.number().optional(),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      businessId: z.number().optional(),
    }).optional()).query(async ({ input }) => {
      return getActivityLogs({
        page: input?.page ?? 1,
        limit: input?.limit ?? 50,
        action: input?.action,
        entityType: input?.entityType,
        entityId: input?.entityId,
        performedBy: input?.performedBy,
        dateFrom: input?.dateFrom ? new Date(input.dateFrom) : undefined,
        dateTo: input?.dateTo ? new Date(input.dateTo) : undefined,
        businessId: input?.businessId,
      });
    }),
  }),

  // ==================== الأنشطة (Businesses) ====================
  businesses: router({
    list: protectedProcedure.query(async () => {
      return getAllBusinesses();
    }),
    activeList: protectedProcedure.query(async () => {
      return getActiveBusinesses();
    }),
    // Business Groups
    groups: protectedProcedure.query(async () => {
      return getActiveBusinessGroups();
    }),
    groupsWithBusinesses: protectedProcedure.query(async () => {
      return getBusinessGroupsWithBusinesses();
    }),
    businessIdsByGroup: protectedProcedure.input(z.object({
      groupId: z.number(),
    })).query(async ({ input }) => {
      return getBusinessIdsByGroupId(input.groupId);
    }),
    get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
      return getBusinessById(input.id);
    }),
    create: adminProcedure.input(z.object({
      name: z.string().min(2),
      slug: z.string().min(2),
    })).mutation(async ({ input }) => {
      await createBusiness(input);
      return { success: true };
    }),
    update: adminProcedure.input(z.object({
      id: z.number(),
      name: z.string().optional(),
      slug: z.string().optional(),
      isActive: z.boolean().optional(),
    })).mutation(async ({ input }) => {
      const { id, ...data } = input;
      await updateBusiness(id, data);
      return { success: true };
    }),
    // التصنيفات
    categories: protectedProcedure.input(z.object({
      businessId: z.number(),
    })).query(async ({ input }) => {
      return getCategoriesByBusiness(input.businessId);
    }),
    createCategory: adminProcedure.input(z.object({
      businessId: z.number(),
      name: z.string().min(2),
    })).mutation(async ({ input }) => {
      await createCategory(input);
      return { success: true };
    }),
    updateCategory: adminProcedure.input(z.object({
      id: z.number(),
      name: z.string().optional(),
      isActive: z.boolean().optional(),
    })).mutation(async ({ input }) => {
      const { id, ...data } = input;
      await updateCategory(id, data);
      return { success: true };
    }),
    // المخازن
    warehouses: protectedProcedure.input(z.object({
      businessId: z.number(),
    })).query(async ({ input }) => {
      return getWarehousesByBusiness(input.businessId);
    }),
    createWarehouse: adminProcedure.input(z.object({
      businessId: z.number(),
      name: z.string().min(2),
    })).mutation(async ({ input }) => {
      await createWarehouse(input);
      return { success: true };
    }),
    updateWarehouse: adminProcedure.input(z.object({
      id: z.number(),
      name: z.string().optional(),
      isActive: z.boolean().optional(),
    })).mutation(async ({ input }) => {
      const { id, ...data } = input;
      await updateWarehouse(id, data);
      return { success: true };
    }),
  }),

  // ==================== SALES CHANNELS ====================
  // NOTE: every procedure here is adminProcedure — sales channels hold integration
  // credentials, so even read access is admin-only. The queries themselves never return
  // raw apiToken/webhookSecret (see getAllSalesChannels/getSalesChannelById in db.ts);
  // clients get hasApiToken/apiTokenLast4-style fields instead.
  salesChannels: router({
    list: adminProcedure.input(z.object({
      businessId: z.number().optional(),
      includeInactive: z.boolean().optional(),
    }).optional()).query(async ({ input }) => {
      return getAllSalesChannels(input?.businessId, { includeInactive: input?.includeInactive ?? true });
    }),
    activeList: adminProcedure.input(z.object({
      businessId: z.number().optional(),
    }).optional()).query(async ({ input }) => {
      return getActiveSalesChannels(input?.businessId);
    }),
    get: adminProcedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
      return getSalesChannelById(input.id);
    }),
    create: adminProcedure.input(z.object({
      businessId: z.number(),
      name: z.string().trim().min(2, 'اسم القناة مطلوب (حرفين على الأقل)'),
      domain: z.string().trim().url('صيغة الدومين غير صحيحة').optional().or(z.literal('')),
      platform: z.enum(['easyorder', 'shopify', 'woocommerce', 'whatsapp', 'facebook', 'instagram', 'manual', 'other']).default('other'),
      apiToken: z.string().trim().min(1).optional(),
      webhookSecret: z.string().trim().min(8, 'سر الـ webhook يجب أن يكون 8 أحرف على الأقل').optional(),
      webhookUrl: z.string().trim().url('صيغة رابط الـ webhook غير صحيحة').optional().or(z.literal('')),
    })).mutation(async ({ input }) => {
      if (await isSalesChannelNameTaken(input.businessId, input.name)) {
        throw new TRPCError({ code: 'CONFLICT', message: `يوجد بالفعل قناة نشطة بنفس الاسم "${input.name}" لهذا العمل` });
      }
      if (input.webhookSecret && await isWebhookSecretTaken(input.webhookSecret)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'سر الـ webhook مستخدم بالفعل في قناة أخرى — يجب أن يكون فريدًا لتوجيه الـ webhooks بشكل صحيح' });
      }
      const result = await createSalesChannel({
        ...input,
        domain: input.domain || undefined,
        webhookUrl: input.webhookUrl || undefined,
      });
      return { success: true, id: result.id };
    }),
    update: adminProcedure.input(z.object({
      id: z.number(),
      name: z.string().trim().min(2).optional(),
      domain: z.string().trim().url('صيغة الدومين غير صحيحة').optional().or(z.literal('')),
      platform: z.enum(['easyorder', 'shopify', 'woocommerce', 'whatsapp', 'facebook', 'instagram', 'manual', 'other']).optional(),
      // Omit or send "" to keep the stored secret unchanged — the API never returns it,
      // so a form can't round-trip it. Use clearSecret to remove one.
      apiToken: z.string().trim().optional(),
      webhookSecret: z.string().trim().optional(),
      webhookUrl: z.string().trim().url('صيغة رابط الـ webhook غير صحيحة').optional().or(z.literal('')),
      isActive: z.boolean().optional(),
    })).mutation(async ({ input }) => {
      const { id, ...data } = input;
      const current = await getSalesChannelById(id);
      if (!current) throw new TRPCError({ code: 'NOT_FOUND', message: 'القناة غير موجودة' });

      if (data.name && await isSalesChannelNameTaken(current.businessId, data.name, id)) {
        throw new TRPCError({ code: 'CONFLICT', message: `يوجد بالفعل قناة نشطة بنفس الاسم "${data.name}" لهذا العمل` });
      }
      if (data.webhookSecret) {
        if (data.webhookSecret.length < 8) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'سر الـ webhook يجب أن يكون 8 أحرف على الأقل' });
        }
        if (await isWebhookSecretTaken(data.webhookSecret, id)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'سر الـ webhook مستخدم بالفعل في قناة أخرى' });
        }
      }
      await updateSalesChannel(id, data);
      return { success: true };
    }),
    /** Removes a stored credential (update() alone can never clear one, by design). */
    clearSecret: adminProcedure.input(z.object({
      id: z.number(),
      field: z.enum(['apiToken', 'webhookSecret']),
    })).mutation(async ({ input }) => {
      await clearSalesChannelSecret(input.id, input.field);
      return { success: true };
    }),
    delete: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
      await deleteSalesChannel(input.id);
      return { success: true };
    }),
    reactivate: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
      await reactivateSalesChannel(input.id);
      return { success: true };
    }),
    /** Verifies the channel's stored API credentials without importing anything. */
    testConnection: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
      return testChannelConnection(input.id);
    }),
    /** Manual "Sync Now" — pulls orders for a date range and upserts them idempotently. */
    syncNow: adminProcedure.input(z.object({
      id: z.number(),
      from: z.date(),
      to: z.date(),
    })).mutation(async ({ ctx, input }) => {
      if (input.from > input.to) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'تاريخ البداية يجب أن يكون قبل تاريخ النهاية' });
      }
      const actingEmpId = await resolveActingEmployeeId(ctx);
      return syncOrdersByDateRange({
        channelId: input.id,
        from: input.from,
        to: input.to,
        performedBy: actingEmpId,
      });
    }),
    /** Re-runs a previous sync range; recorded with trigger = "retry". */
    retrySync: adminProcedure.input(z.object({
      id: z.number(),
      from: z.date(),
      to: z.date(),
    })).mutation(async ({ ctx, input }) => {
      const actingEmpId = await resolveActingEmployeeId(ctx);
      return syncOrdersByDateRange({
        channelId: input.id,
        from: input.from,
        to: input.to,
        performedBy: actingEmpId,
        trigger: "retry",
      });
    }),
    syncLogs: adminProcedure.input(z.object({
      channelId: z.number().optional(),
      limit: z.number().min(1).max(200).default(50),
    }).optional()).query(async ({ input }) => {
      return getSyncLogs({ channelId: input?.channelId, limit: input?.limit ?? 50 });
    }),
  }),

  // ==================== PRODUCT VARIANTS ====================
  variants: router({
    byProduct: protectedProcedure.input(z.object({
      productId: z.number(),
      includeInactive: z.boolean().optional(),
    })).query(async ({ input }) => {
      return getVariantsByProduct(input.productId, { includeInactive: input.includeInactive });
    }),
    all: protectedProcedure.input(z.object({
      businessId: z.number().optional(),
      businessIds: z.array(z.number()).optional(),
      includeInactive: z.boolean().optional(),
    }).optional()).query(async ({ input }) => {
      return getAllVariantsWithProduct(input?.businessId, input?.businessIds, { includeInactive: input?.includeInactive });
    }),
    get: protectedProcedure.input(z.object({ id: z.number() })).query(async ({ input }) => {
      return getVariantById(input.id);
    }),
    create: adminProcedure.input(z.object({
      productId: z.number(),
      name: z.string().min(1, "اسم النوع مطلوب"),
      color: z.string().optional(),
      size: z.string().optional(),
      sku: z.string().min(1, "رمز المنتج (SKU) مطلوب"),
      price: z.number().min(0).optional(),
      costPrice: z.number().min(0).optional(),
      currentStock: z.number().min(0).default(0),
      minStockLevel: z.number().min(0).default(5),
      isActive: z.boolean().optional(),
    })).mutation(async ({ input }) => {
      const { price, costPrice, ...rest } = input;
      if (await isVariantNameTaken(rest.productId, rest.name)) {
        throw new TRPCError({ code: 'CONFLICT', message: `يوجد بالفعل نوع بنفس الاسم "${rest.name}" لهذا المنتج` });
      }
      if (await isSkuTaken(rest.sku)) {
        throw new TRPCError({ code: 'CONFLICT', message: `رمز المنتج (SKU) "${rest.sku}" مستخدم بالفعل` });
      }
      await createVariant({
        ...rest,
        ...(price !== undefined ? { price: String(price) } : {}),
        ...(costPrice !== undefined ? { costPrice: String(costPrice) } : {}),
      });
      return { success: true };
    }),
    update: adminProcedure.input(z.object({
      id: z.number(),
      name: z.string().min(1).optional(),
      color: z.string().optional(),
      size: z.string().optional(),
      sku: z.string().min(1).optional(),
      price: z.number().min(0).optional(),
      costPrice: z.number().min(0).optional(),
      minStockLevel: z.number().min(0).optional(),
      isActive: z.boolean().optional(),
    })).mutation(async ({ input }) => {
      const { id, price, costPrice, ...rest } = input;
      if (rest.name?.trim()) {
        const current = await getVariantById(id);
        const productId = current?.productId;
        if (productId && await isVariantNameTaken(productId, rest.name, id)) {
          throw new TRPCError({ code: 'CONFLICT', message: `يوجد بالفعل نوع بنفس الاسم "${rest.name}" لهذا المنتج` });
        }
      }
      if (rest.sku && await isSkuTaken(rest.sku, { excludeVariantId: id })) {
        throw new TRPCError({ code: 'CONFLICT', message: `رمز المنتج (SKU) "${rest.sku}" مستخدم بالفعل` });
      }
      await updateVariant(id, {
        ...rest,
        ...(price !== undefined ? { price: String(price) } : {}),
        ...(costPrice !== undefined ? { costPrice: String(costPrice) } : {}),
      });
      return { success: true };
    }),
    updateStock: adminProcedure.input(z.object({
      variantId: z.number(),
      delta: z.number(),
    })).mutation(async ({ input }) => {
      await updateVariantStock(input.variantId, input.delta);
      return { success: true };
    }),
    addMovement: adminProcedure.input(z.object({
      variantId: z.number(),
      type: z.enum(['in', 'out']),
      quantity: z.number().min(1),
      reason: z.string().optional(),
      notes: z.string().optional(),
      orderId: z.number().optional(),
    })).mutation(async ({ ctx, input }) => {
      const actingEmpId = await resolveActingEmployeeId(ctx);
      await addVariantInventoryMovement({ ...input, performedBy: actingEmpId });
      return { success: true };
    }),
    delete: adminProcedure.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
      await deleteVariant(input.id);
      return { success: true };
    }),
  }),
});

export type AppRouter = typeof appRouter;
