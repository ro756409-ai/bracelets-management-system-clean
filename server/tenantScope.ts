import { eq, inArray } from "drizzle-orm";
import {
  categories,
  employeeSalaryProfiles,
  employees,
  expenseCategories,
  orders,
  payrollItems,
  payrollPeriods,
  printLogs,
  productVariants,
  products,
  salesChannels,
  tasks,
  warehouses,
} from "../drizzle/schema";
import { getDb } from "./db";

/**
 * «السجل ده تابع لنطاقي؟» — سجل واحد لكل الكيانات.
 *
 * الثغرة اللي الملف ده بيقفلها كانت **نمط**، مش حادثة: عشرات الإجراءات بتاخد `id` من
 * العميل وبتقرا أو بتكتب على طول. `adminProcedure` بتقول «إنت أدمن»، مابتقولش «أدمن
 * على إيه» — فأدمن شركة أ كان يقدر يمسح موظف شركة ب، أو يغيّر باسورده، أو يمسح بيانات
 * ربط التكاملات بتاعتها، لو عرف الرقم بس.
 *
 * **ليه سجل مركزي مش فحص في كل إجراء؟** لأن الفحص اليدوي هو اللي فشل ٦٣ مرة. الإجراء
 * الجديد اللي هيتكتب بكرة هينسى برضه. السجل ده بيخلي الفحص سطر واحد يتقرا في المراجعة
 * (`assertOwned(ctx.tenantId, "salesChannel", input.id)`)، وبيخلي إضافة كيان جديد تمر
 * من مكان واحد.
 *
 * **الكيان اللي مالوش عمود نطاق مايدخلش هنا.** لو مش قادر تثبت إن السجل تابع لمين،
 * الحل مش تخمين — الحل إن العمود يتضاف. الفرق بين الاتنين إن الأول بيرفض بصوت عالي
 * والتاني بيسمح بصمت.
 */

/** الكيانات اللي بيتوصلهم بمعرّف من العميل، وإزاي بنعرف نطاق كل واحد. */
const ENTITIES = {
  employee: { table: employees, label: "الموظف" },
  order: { table: orders, label: "الأوردر" },
  salesChannel: { table: salesChannels, label: "قناة البيع" },
  payrollPeriod: { table: payrollPeriods, label: "دورة المرتبات" },
  payrollItem: { table: payrollItems, label: "سطر المرتب" },
  expenseCategory: { table: expenseCategories, label: "تصنيف المصروف" },
  printLog: { table: printLogs, label: "سجل الطباعة" },
  product: { table: products, label: "المنتج" },
  warehouse: { table: warehouses, label: "المخزن" },
  category: { table: categories, label: "التصنيف" },
  task: { table: tasks, label: "المهمة" },
  salaryProfile: { table: employeeSalaryProfiles, label: "ملف الراتب" },
} as const;

export type ScopedEntity = keyof typeof ENTITIES;

/** يترمى لما السجل مش تابع لنطاق الجلسة — نفس رسالة `scopeBusinessId`. */
export class OutOfScopeError extends Error {
  readonly code = "FORBIDDEN" as const;
  constructor(message = "لا يمكنك الوصول لبيانات هذا الفرع/النشاط") {
    super(message);
  }
}

export class RecordNotFoundError extends Error {
  readonly code = "NOT_FOUND" as const;
}

/**
 * نطاق السجل — `businessId` بتاعه، أو `null` لو السجل نفسه مش موجود.
 *
 * الـ`variant` حالة خاصة: مالوش `businessId`، نطاقه بيتورّث من منتجه. ده مش استثناء
 * من القاعدة — ده تطبيقها على سلسلة الملكية الحقيقية.
 */
async function businessIdOf(
  entity: ScopedEntity | "variant",
  id: number
): Promise<number | null | undefined> {
  const db = await getDb();
  if (!db) return undefined; // مش قادر أتحقق — القرار للمتصل
  if (entity === "variant") {
    const [row] = await db
      .select({ productId: productVariants.productId })
      .from(productVariants)
      .where(eq(productVariants.id, id))
      .limit(1);
    if (!row) return null;
    return businessIdOf("product", row.productId);
  }
  const { table } = ENTITIES[entity];
  const [row] = await db
    .select({ businessId: (table as any).businessId })
    .from(table as any)
    .where(eq((table as any).id, id))
    .limit(1);
  if (!row) return null;
  return (row as { businessId: number | null }).businessId;
}

/**
 * بيرمي لو السجل مش تابع لنطاق الجلسة.
 *
 * `allowedBusinessIds` بتتبعت من المتصل (`getBusinessIdsForTenant`) عشان الفحص يفضل
 * على **نفس** مصدر الحقيقة اللي `scopeBusinessId` بتستخدمه — مفيش قاعدة عزل تانية.
 * `null` معناها الداتابيز مش متاحة، ونفس سلوك `scopeBusinessId`: مانمنعش لسبب غلط.
 */
export async function assertOwned(
  allowedBusinessIds: number[] | null,
  entity: ScopedEntity | "variant",
  id: number
): Promise<void> {
  const businessId = await businessIdOf(entity, id);
  if (businessId === undefined) return; // مش قادر أتحقق
  const label =
    entity === "variant" ? "النوع" : ENTITIES[entity as ScopedEntity].label;
  if (businessId === null) throw new RecordNotFoundError(`${label} غير موجود`);
  if (allowedBusinessIds == null) return;
  // السجل اللي مالوش نشاط مايتلمسش من جلسة نطاقها محدد.
  if (!allowedBusinessIds.includes(businessId)) throw new OutOfScopeError();
}

/** نفس الفحص لمجموعة معرّفات — بيرمي على أول واحد برّه النطاق. */
export async function assertAllOwned(
  allowedBusinessIds: number[] | null,
  entity: ScopedEntity,
  ids: number[]
): Promise<void> {
  if (ids.length === 0 || allowedBusinessIds == null) return;
  const db = await getDb();
  if (!db) return;
  const { table, label } = ENTITIES[entity];
  const rows = await db
    .select({ id: (table as any).id, businessId: (table as any).businessId })
    .from(table as any)
    .where(inArray((table as any).id, ids));
  if (rows.length !== ids.length)
    throw new RecordNotFoundError(`${label} غير موجود`);
  for (const row of rows as { businessId: number | null }[]) {
    if (row.businessId == null || !allowedBusinessIds.includes(row.businessId))
      throw new OutOfScopeError();
  }
}

/** أسماء الكيانات — للاختبارات اللي بتتأكد إن السجل مغطّي. */
export const SCOPED_ENTITY_NAMES = Object.keys(ENTITIES) as ScopedEntity[];
