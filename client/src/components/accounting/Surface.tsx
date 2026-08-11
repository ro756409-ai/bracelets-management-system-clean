import type { ReactNode } from "react";

/**
 * لغة بصرية واحدة للحسابات.
 *
 * **اللون معنى مش زينة.** الحسابات فيها سبع شاشات، ولو كل واحدة اختارت ألوانها،
 * التاجر بيتعلّم سبع لغات — والأخطر إنه بيبطّل يصدّق اللون: كارت أحمر عشان الشكل
 * بيخلّي الأحمر الحقيقي (فلوس خارجة) مايبقاش ليه وزن.
 *
 * فاللون هنا **مشتق من المعنى** مش متبعت كـprop حر:
 *
 *   in       أخضر    فلوس داخلة · مكتمل
 *   out      أحمر    فلوس خارجة · عليك · خطر
 *   due      كهرماني مستحق · معلّق · محتاج إجراء
 *   neutral  رمادي   معلومة
 *
 * مفيش قيمة خامسة. لو حاجة مش واحدة من الأربعة، يبقى هي معلومة — `neutral`.
 */
export type Tone = "in" | "out" | "due" | "neutral";

const TONE_TEXT: Record<Tone, string> = {
  in: "var(--success)",
  out: "var(--destructive)",
  due: "var(--warning)",
  neutral: "var(--foreground)",
};

/** لون القيمة حسب معناها. */
export function toneColor(tone: Tone): string {
  return TONE_TEXT[tone];
}

/**
 * اتجاه الفلوس ← لون.
 *
 * الدالة دي عن قصد مش بتاخد «لون» — بتاخد **إشارة المبلغ**. اللي بيكتب الشاشة
 * مايقدرش يختار أحمر لرقم داخل.
 */
export function moneyTone(signedAmount: number): Tone {
  if (signedAmount > 0) return "in";
  if (signedAmount < 0) return "out";
  return "neutral";
}

/**
 * كارت رقم — نفس المقاس ونفس الوزن في السبع شاشات.
 *
 * الرقم أكبر حاجة في الكارت لأن ده اللي التاجر جاي عشانه؛ العنوان صغير فوقه،
 * والتفسير أصغر تحته ولو موجود.
 */
export function Kpi({
  label,
  value,
  tone = "neutral",
  hint,
  badge,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  hint?: string;
  badge?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        {badge && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {badge}
          </span>
        )}
      </div>
      <p
        className="text-2xl font-bold tabular-nums leading-tight"
        style={{ color: toneColor(tone) }}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** صف كروت الأرقام — نفس الشبكة في كل شاشة. */
export function KpiRow({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
  );
}

/**
 * رأس الشاشة — عنوان وإجراء أساسي واحد.
 *
 * `action` واحد مش مصفوفة عن قصد: الشاشة اللي فيها تلات أزرار أساسية مالهاش إجراء
 * أساسي. الباقي بيروح جوه المحتوى كأزرار أهدى.
 */
export function ScreenHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold">{title}</h1>
        {subtitle && (
          <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}

/**
 * لوح محتوى — حد واحد بدل كارت جوه كارت.
 *
 * الشاشات كانت بتلف كل حاجة في `Card`، فبيطلع حد جوه حد جوه حد. اللوح ده بيرسم حد
 * واحد بس، والجداول جواه مالهاش حدود خاصة بيها.
 */
export function Panel({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card">
      {(title || action) && (
        <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
          {title && <h2 className="text-sm font-bold">{title}</h2>}
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * غلاف الجدول — بيمنع الصفحة كلها تتمدّد أفقيًا على الموبايل.
 *
 * من غيره، جدول عريض بيدفع الـbody نفسه فبتفضل تسحب الشاشة يمين وشمال عشان توصل
 * لأي حاجة. التمرير لازم يبقى **جوه** الجدول.
 */
export function TableScroll({ children }: { children: ReactNode }) {
  return <div className="w-full overflow-x-auto">{children}</div>;
}

/** صف جدول مدمج — نفس الارتفاع ونفس الحشو في كل شاشة. */
export const TABLE_CLASS = "w-full text-sm [&_td]:p-2 [&_th]:p-2";
export const TABLE_HEAD_CLASS =
  "border-b text-right text-xs font-medium text-muted-foreground";
