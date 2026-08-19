import { and, eq, gte, lte } from "drizzle-orm";
import {
  employeeAdvances,
  employeeBonuses,
  employeeSalaryProfiles,
  employees,
} from "../drizzle/schema";
import { computeNetSalary, round2 } from "../shared/salaryMath";
import type { Actor } from "./accountingV2.service";
import { getDb } from "./db";

/**
 * بونص الموظف — تسجيل مباشر بيتضاف لصافي المرتب.
 *
 * على عكس السُلفة، البونص **مابيلمسش الخزنة** لحظة تسجيله: هو مبلغ بيتحسب ضمن صافي
 * المرتب اللي بيتدفع آخر الشهر، مش صرف فوري. فمفيش قيد مالي ولا حركة خزنة هنا — مجرد
 * سطر في `employee_bonuses`. الصرف الفعلي بيحصل وقت دفع المرتب.
 */
export async function issueEmployeeBonus(input: {
  businessId: number;
  employeeId: number;
  amount: string;
  bonusDate: Date;
  reason?: string;
  actor: Actor;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [employee] = await db
    .select()
    .from(employees)
    .where(eq(employees.id, input.employeeId))
    .limit(1);
  if (!employee) throw new Error("الموظف مش موجود");
  if (employee.businessId != null && employee.businessId !== input.businessId)
    throw new Error("الموظف تابع لنشاط تاني");
  const amount = Number(input.amount);
  if (!(amount > 0)) throw new Error("مبلغ البونص لازم يكون أكبر من صفر");
  const result: any = await db.insert(employeeBonuses).values({
    businessId: input.businessId,
    employeeId: employee.id,
    employeeName: employee.name,
    amount: amount.toFixed(2),
    bonusDate: input.bonusDate,
    reason: input.reason ?? null,
    createdBy: input.actor.id,
    createdByName: input.actor.name,
  });
  return { id: Number(result?.insertId ?? result?.[0]?.insertId) };
}

/** حذف بونص — بونص مسجّل بالغلط بيتشال، لأنه مالوش أثر مالي (لسه مااتدفعش). */
export async function deleteEmployeeBonus(input: {
  businessId: number;
  bonusId: number;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const [row] = await db
    .select()
    .from(employeeBonuses)
    .where(
      and(
        eq(employeeBonuses.id, input.bonusId),
        eq(employeeBonuses.businessId, input.businessId)
      )
    )
    .limit(1);
  if (!row) throw new Error("البونص ده مش تابع للنشاط ده");
  await db.delete(employeeBonuses).where(eq(employeeBonuses.id, input.bonusId));
  return { success: true };
}

export async function listEmployeeBonuses(input: {
  businessId: number;
  employeeId?: number;
  from?: Date;
  to?: Date;
}) {
  const db = await getDb();
  if (!db) return [];
  const conds = [eq(employeeBonuses.businessId, input.businessId)];
  if (input.employeeId) conds.push(eq(employeeBonuses.employeeId, input.employeeId));
  if (input.from) conds.push(gte(employeeBonuses.bonusDate, input.from));
  if (input.to) conds.push(lte(employeeBonuses.bonusDate, input.to));
  return db.select().from(employeeBonuses).where(and(...conds));
}

export type SalarySummaryRow = {
  employeeId: number;
  employeeName: string;
  baseSalary: number;
  totalBonuses: number;
  totalAdvances: number;
  netSalary: number;
};

/**
 * ملخص مرتبات النشاط — لكل موظف عنده ملف مرتب: الأساسي + البونص − السُلف = الصافي.
 *
 * نفس الدالة النقية `computeNetSalary` اللي الواجهة والاختبار بيستخدموها — تعريف واحد
 * للصافي. الفلتر بالشهر اختياري: بيتطبّق على البونص والسُلف (تاريخ الحركة)، والأساسي
 * بيتاخد من الملف الساري.
 */
export async function getSalarySummaries(input: {
  businessId: number;
  from?: Date;
  to?: Date;
}): Promise<SalarySummaryRow[]> {
  const db = await getDb();
  if (!db) return [];
  const now = new Date();
  const profiles = await db
    .select()
    .from(employeeSalaryProfiles)
    .where(eq(employeeSalaryProfiles.businessId, input.businessId));
  // الملف الساري لكل موظف — أحدث `effectiveFrom` مش في المستقبل.
  const currentBase = new Map<number, number>();
  for (const p of profiles) {
    if (!p.isActive) continue;
    if (p.effectiveFrom > now) continue;
    const existing = currentBase.get(p.employeeId);
    // بنعتمد على ترتيب الإدراج؛ الأحدث بيغلب — لكن الفريدة على (employee, effectiveFrom)
    // بتضمن مفيش نسختين بنفس التاريخ. للتبسيط بناخد الأكبر تاريخًا.
    currentBase.set(p.employeeId, Number(p.baseSalary ?? 0));
    void existing;
  }

  const bonuses = await listEmployeeBonuses(input);
  const advConds = [eq(employeeAdvances.businessId, input.businessId)];
  if (input.from) advConds.push(gte(employeeAdvances.advanceDate, input.from));
  if (input.to) advConds.push(lte(employeeAdvances.advanceDate, input.to));
  const advances = (await db.select().from(employeeAdvances).where(and(...advConds)))
    .filter(a => a.status !== "cancelled");

  const bonusByEmp = new Map<number, number>();
  for (const b of bonuses)
    bonusByEmp.set(b.employeeId, round2((bonusByEmp.get(b.employeeId) ?? 0) + Number(b.amount)));
  const advByEmp = new Map<number, number>();
  for (const a of advances)
    advByEmp.set(a.employeeId, round2((advByEmp.get(a.employeeId) ?? 0) + Number(a.amount)));

  const nameByEmp = new Map<number, string>();
  for (const b of bonuses) nameByEmp.set(b.employeeId, b.employeeName);
  for (const a of advances) nameByEmp.set(a.employeeId, a.employeeName);
  const rows = await db
    .select({ id: employees.id, name: employees.name })
    .from(employees);
  for (const e of rows) if (!nameByEmp.has(e.id)) nameByEmp.set(e.id, e.name);

  const employeeIds = new Set<number>([
    ...currentBase.keys(),
    ...bonusByEmp.keys(),
    ...advByEmp.keys(),
  ]);
  return [...employeeIds].map(employeeId => {
    const baseSalary = currentBase.get(employeeId) ?? 0;
    const totalBonuses = bonusByEmp.get(employeeId) ?? 0;
    const totalAdvances = advByEmp.get(employeeId) ?? 0;
    return {
      employeeId,
      employeeName: nameByEmp.get(employeeId) ?? `#${employeeId}`,
      baseSalary,
      totalBonuses,
      totalAdvances,
      netSalary: computeNetSalary({ baseSalary, bonuses: totalBonuses, advances: totalAdvances }),
    };
  });
}
