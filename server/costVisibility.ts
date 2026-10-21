/**
 * BUG-01 — حقول تكلفة المخزون لا تخرج من الـAPI إلا لمن يملك `inventory_costing.view`.
 *
 * دي المفاتيح اللي بتحمل تكلفة الوحدة خارج شاشات التكلفة نفسها: تكلفة التركيبة (`costPrice`)
 * ولقطات التكلفة على بنود الأوردر. الحذف «عميق» على مصفوفات وكائنات عادية بس (أوردر ⟵ بنود،
 * كتالوج ⟵ تركيبات) — التواريخ وأي كائنات غير عادية بتعدّي زي ما هي.
 */
export const COST_FIELD_KEYS = [
  "costPrice",
  "unitCostSnapshot",
  "projectedUnitCostSnapshot",
  "costCapturedAt",
] as const;

const COST_KEYS = new Set<string>(COST_FIELD_KEYS);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** نسخة من القيمة بلا أي مفتاح تكلفة في أي مستوى (مصفوفات/كائنات عادية فقط). */
export function omitCostFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map(v => omitCostFields(v)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (COST_KEYS.has(k)) continue;
    out[k] = omitCostFields(v);
  }
  return out as T;
}

/** هل في المدخلات قيمة تكلفة فعلية (مش undefined) — للمنع على مسارات الكتابة. */
export function carriesCostValue(input: unknown): boolean {
  if (Array.isArray(input)) return input.some(carriesCostValue);
  if (!isPlainObject(input)) return false;
  for (const [k, v] of Object.entries(input)) {
    if (COST_KEYS.has(k) && v !== undefined && v !== null) return true;
    if (carriesCostValue(v)) return true;
  }
  return false;
}
