import { useLocation } from "wouter";
import {
  AlertTriangle, PackageX, ClipboardList, GitMerge, ChevronLeft, CheckCircle2,
} from "lucide-react";

/**
 * «يحتاج انتباهك» — طبقة Dashboard V2 اللي بتساعد المالك ياخد قرار بدل ما يقرا كل رقم.
 *
 * بتشتغل على **بيانات موجودة أصلاً** (اللوحة بتجيبها): طلبات تنتظر تأكيد، مخزون منخفض،
 * مكررات. كل بند بيظهر بس لو ليه قيمة فعلية (>0)، وبيوديك للمكان الصح. مفيش endpoint جديد
 * ولا حساب جديد — تجميع وعرض بس.
 */

export type AttentionInput = {
  needsConfirmation?: number;
  lowStock?: number;
  duplicates?: number;
};

type Item = {
  key: string;
  label: string;
  count: number;
  icon: typeof AlertTriangle;
  to: string;
  tone: "warning" | "danger" | "info";
};

const TONE: Record<Item["tone"], string> = {
  warning: "text-warning",
  danger: "text-destructive",
  info: "text-info",
};

export function NeedsAttention({ needsConfirmation = 0, lowStock = 0, duplicates = 0 }: AttentionInput) {
  const [, setLocation] = useLocation();

  const items: Item[] = ([
    { key: "confirm", label: "طلبات تنتظر التأكيد", count: needsConfirmation, icon: ClipboardList, to: "/orders", tone: "warning" },
    { key: "stock", label: "منتجات مخزونها منخفض", count: lowStock, icon: PackageX, to: "/inventory", tone: "danger" },
    { key: "dupes", label: "طلبات مكررة محتملة", count: duplicates, icon: GitMerge, to: "/duplicates", tone: "info" },
  ] as Item[]).filter(i => i.count > 0);

  return (
    <section
      aria-label="يحتاج انتباهك"
      className="rounded-[var(--radius-brand-lg)] border border-border bg-card p-5"
    >
      <div className="mb-4 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-warning" />
        <h2 className="text-sm font-semibold text-foreground">يحتاج انتباهك</h2>
      </div>

      {items.length === 0 ? (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <CheckCircle2 className="h-4 w-4 text-success" />
          كل حاجة تمام — مفيش حاجة محتاجة تدخّل دلوقتي.
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {items.map(item => (
            <li key={item.key}>
              <button
                onClick={() => setLocation(item.to)}
                className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-brand-md)] border border-border bg-background px-4 py-3 text-right transition-colors hover:bg-muted"
              >
                <span className="flex items-center gap-3">
                  <item.icon className={`h-5 w-5 shrink-0 ${TONE[item.tone]}`} />
                  <span className="min-w-0">
                    <span className="block text-lg font-bold tabular-nums text-foreground">{item.count}</span>
                    <span className="block truncate text-xs text-muted-foreground">{item.label}</span>
                  </span>
                </span>
                <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
