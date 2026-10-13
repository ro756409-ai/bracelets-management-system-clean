type Exec = { query<T = any>(sql: string, params?: unknown[]): Promise<T[]> };

/**
 * فحص قراءة فقط قبل Migration 0053 المقترحة (قيد فريد `orders_business_external_unique` على `orders(businessId, externalOrderId)`).
 * لا يكتب شيئًا (المنفّذ يرفض غير SELECT ويعمل بجلسة READ ONLY).
 *
 *  • التجميع `GROUP BY businessId, externalOrderId` يستخدم ترتيب العمود نفسه — أي المجموعات التي **سيرفضها القيد فعلًا**
 *    (utf8mb4_0900_ai_ci: لا يفرّق حالة الأحرف ولا التشكيل، و NO PAD: المسافة في آخر القيمة فرق).
 *  • NULL لا يتعارض في قيد فريد (أوردرات بلا معرّف خارجي غير متأثرة). القيمة الفارغة/المسافات **قيمة** تتعارض لو تكررت.
 *  • جاهز = العمود موجود + لا مجموعات مكررة (ومنها الفارغة) + لا فهرس بنفس الاسم بتعريف مختلف.
 */
export const PROPOSED_INDEX = "orders_business_external_unique";

export async function checkExternalOrderIds(exec: Exec, opts: { sampleLimit?: number } = {}) {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.sampleLimit ?? 20)));
  const [col] = await exec.query<{ type: string; collation: string | null; nullable: string }>(
    "SELECT COLUMN_TYPE AS type, COLLATION_NAME AS collation, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' AND COLUMN_NAME = 'externalOrderId'");
  if (!col) return { ready: false, reason: "العمود orders.externalOrderId غير موجود", column: null } as const;

  const idx = await exec.query<{ name: string; nonUnique: number; seq: number; col: string }>(
    "SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders' ORDER BY INDEX_NAME, SEQ_IN_INDEX");
  const indexes = new Map<string, { unique: boolean; columns: string[] }>();
  for (const r of idx) {
    const name = String(r.name);
    if (!indexes.has(name)) indexes.set(name, { unique: Number(r.nonUnique) === 0, columns: [] });
    indexes.get(name)!.columns.push(String(r.col));
  }
  const proposed = indexes.get(PROPOSED_INDEX) ?? null;
  const proposedState = !proposed ? "absent"
    : proposed.unique && proposed.columns.join(",") === "businessId,externalOrderId" ? "present" : "conflicting";
  const relatedIndexes = [...indexes.entries()].filter(([, v]) => v.columns.includes("externalOrderId") || v.columns[0] === "businessId")
    .map(([name, v]) => ({ name, unique: v.unique, columns: v.columns }));

  const [t] = await exec.query<any>(`SELECT COUNT(*) AS orders,
      SUM(externalOrderId IS NULL) AS nullKeys,
      SUM(externalOrderId IS NOT NULL AND TRIM(externalOrderId) = '') AS blankKeys,
      SUM(externalOrderId IS NOT NULL AND externalOrderId <> TRIM(externalOrderId) AND TRIM(externalOrderId) <> '') AS paddedKeys,
      COUNT(DISTINCT businessId, externalOrderId) AS distinctKeys
    FROM orders`);
  const [g] = await exec.query<any>(`SELECT COUNT(*) AS groupCount, COALESCE(SUM(n), 0) AS rowsInGroups, COALESCE(SUM(blank), 0) AS blankGroups
    FROM (SELECT COUNT(*) AS n, MAX(TRIM(externalOrderId) = '') AS blank FROM orders WHERE externalOrderId IS NOT NULL
          GROUP BY businessId, externalOrderId HAVING COUNT(*) > 1) d`);
  const [v] = await exec.query<any>(`SELECT COUNT(*) AS groupCount FROM (SELECT 1 FROM orders WHERE externalOrderId IS NOT NULL
      GROUP BY businessId, externalOrderId HAVING COUNT(DISTINCT CAST(externalOrderId AS BINARY)) > 1) d`);
  const [x] = await exec.query<any>(`SELECT COUNT(*) AS keyCount FROM (SELECT 1 FROM orders WHERE externalOrderId IS NOT NULL AND TRIM(externalOrderId) <> ''
      GROUP BY externalOrderId HAVING COUNT(DISTINCT businessId) > 1) d`);
  const samples = (await exec.query<any>(`SELECT businessId, MIN(externalOrderId) AS sampleKey, COUNT(*) AS n,
        GROUP_CONCAT(id ORDER BY id SEPARATOR ',') AS orderIds, GROUP_CONCAT(orderNumber ORDER BY id SEPARATOR ',') AS orderNumbers,
        GROUP_CONCAT(status ORDER BY id SEPARATOR ',') AS statuses, GROUP_CONCAT(source ORDER BY id SEPARATOR ',') AS sources,
        MIN(createdAt) AS firstAt, MAX(createdAt) AS lastAt
      FROM orders WHERE externalOrderId IS NOT NULL GROUP BY businessId, externalOrderId HAVING COUNT(*) > 1
      ORDER BY n DESC, businessId LIMIT ${limit}`))
    .map((r: any) => ({ businessId: Number(r.businessId), key: String(r.sampleKey), count: Number(r.n), orderIds: String(r.orderIds).split(",").map(Number),
      orderNumbers: String(r.orderNumbers).split(","), statuses: String(r.statuses).split(","), sources: String(r.sources).split(","), firstAt: r.firstAt, lastAt: r.lastAt }));

  const duplicateGroups = Number(g?.groupCount ?? 0);
  const ready = duplicateGroups === 0 && proposedState !== "conflicting";
  return {
    ready,
    reason: ready ? null : proposedState === "conflicting" ? `فهرس باسم ${PROPOSED_INDEX} موجود بتعريف مختلف` : `${duplicateGroups} مجموعة مكررة داخل النشاط`,
    column: { type: String(col.type), collation: col.collation ? String(col.collation) : null, nullable: String(col.nullable) === "YES" },
    proposedIndex: proposedState,
    relatedIndexes,
    totals: { orders: Number(t?.orders ?? 0), nullKeys: Number(t?.nullKeys ?? 0), blankKeys: Number(t?.blankKeys ?? 0), paddedKeys: Number(t?.paddedKeys ?? 0), distinctKeys: Number(t?.distinctKeys ?? 0) },
    duplicates: { groups: duplicateGroups, rowsInGroups: Number(g?.rowsInGroups ?? 0), blankGroups: Number(g?.blankGroups ?? 0), caseOrAccentVariantGroups: Number(v?.groupCount ?? 0), samples },
    crossBusinessKeys: Number(x?.keyCount ?? 0),
  } as const;
}
