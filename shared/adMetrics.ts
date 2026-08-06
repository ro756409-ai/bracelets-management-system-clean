/**
 * حسابات الإعلانات.
 *
 * منفصلة عن الشاشة عشان الاختبار يقيس نفس المعادلة اللي المعلن شايفها. كلها قسمة، وكل
 * قسمة هنا محميّة: صفر أوردرات معناه «مفيش تكلفة أوردر» مش Infinity، لأن الرقم ده بيتعرض
 * جنب أرقام حقيقية والمعلن بياخد قرار عليه.
 */

export type CampaignKind = "sales" | "messages";

const num = (v: string | number | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * القسمة الآمنة: المقام صفر بيرجّع null مش Infinity ولا NaN.
 *
 * null معناها «مالهاش قيمة لسه» والواجهة بتعرضها «—». صفر كان هيبقى كذب: حملة صرفت
 * ٥٠٠ جنيه وجابت صفر أوردر تكلفة أوردرها مش صفر، هي **مالهاش** تكلفة أوردر.
 */
export function perUnit(total: string | number, units: string | number): number | null {
  const u = num(units);
  if (u <= 0) return null;
  return num(total) / u;
}

/** تكلفة الأوردر = المصروف ÷ عدد الأوردرات. */
export function costPerOrder(spend: string | number, orders: string | number): number | null {
  return perUnit(spend, orders);
}

/** تكلفة الرسالة = المصروف ÷ عدد الرسايل. */
export function costPerMessage(spend: string | number, messages: string | number): number | null {
  return perUnit(spend, messages);
}

/** نسبة تحويل الرسايل لأوردرات، كنسبة مئوية. */
export function conversionRate(
  orders: string | number,
  messages: string | number
): number | null {
  const m = num(messages);
  if (m <= 0) return null;
  return (num(orders) / m) * 100;
}

/** العائد على الإنفاق الإعلاني = الإيراد ÷ المصروف. بيرجّع null لو مفيش إيراد متسجّل. */
export function roas(revenue: string | number | null | undefined, spend: string | number): number | null {
  if (revenue == null || revenue === "") return null;
  const s = num(spend);
  if (s <= 0) return null;
  return num(revenue) / s;
}

export type CampaignRow = {
  campaignName: string;
  kind: CampaignKind;
  spend: number;
  orders: number;
  messages: number;
  revenue: number | null;
};

/**
 * أحسن وأسوأ حملة.
 *
 * المقارنة على **تكلفة الأوردر** لحملات المبيعات و**تكلفة الرسالة** لحملات الرسايل —
 * مقارنة حملة مبيعات بحملة رسايل مالهاش معنى، الوحدة مختلفة.
 *
 * الحملات اللي مالهاش وحدة (صرفت وجابت صفر) بتتشال من المقارنة بدل ما تتحسب أسوأ حملة
 * بلا نهاية. بس بترجع في `withoutResults` عشان تبان للمعلن — دي أهم من أسوأ حملة.
 */
export function rankCampaigns(rows: CampaignRow[]) {
  const scored = rows
    .map(r => ({
      row: r,
      unitCost: r.kind === "messages"
        ? costPerMessage(r.spend, r.messages)
        : costPerOrder(r.spend, r.orders),
    }))
    .filter((s): s is { row: CampaignRow; unitCost: number } => s.unitCost != null);

  const withoutResults = rows.filter(r =>
    (r.kind === "messages" ? num(r.messages) : num(r.orders)) <= 0 && num(r.spend) > 0
  );

  if (scored.length === 0) return { best: null, worst: null, withoutResults };

  // الأرخص أحسن، والأغلى أسوأ.
  const sorted = [...scored].sort((a, b) => a.unitCost - b.unitCost);
  return {
    best: sorted[0],
    worst: sorted[sorted.length - 1],
    withoutResults,
  };
}

/** تجميع صفوف الحملات — الإجماليات اللي فوق اللوحة. */
export function summariseCampaigns(rows: CampaignRow[]) {
  const spend = rows.reduce((s, r) => s + num(r.spend), 0);
  const orders = rows.reduce((s, r) => s + num(r.orders), 0);
  const messages = rows.reduce((s, r) => s + num(r.messages), 0);
  const revenue = rows.reduce((s, r) => s + num(r.revenue), 0);
  const hasRevenue = rows.some(r => r.revenue != null);
  return {
    spend,
    orders,
    messages,
    avgCostPerOrder: costPerOrder(spend, orders),
    avgCostPerMessage: costPerMessage(spend, messages),
    roas: hasRevenue ? roas(revenue, spend) : null,
  };
}
