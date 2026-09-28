import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Package, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";

/**
 * المخزون حسب المنتج — **Mobile-first**، بلا أي تغيير في قاعدة البيانات.
 *
 * كل منتج له تركيبات = Card/Accordion، وتحته الأنواع: جدول مرتب على الديسكتوب، وCard لكل
 * نوع على الموبايل (بلا جدول خارج الشاشة). الأعمدة: النوع، SKU، المتاح، الحد الأدنى، سعر
 * البيع، الحالة، الإجراءات. بحث + فلاتر (الكل/متوفر/منخفض/نفد).
 *
 * البيانات جاية من `variants.all` (بنطاق الجلسة على السيرفر) — الموظف يرى المصرّح له فقط.
 * زر التعديل يظهر فقط لو `canEdit` (المالك/الأدمن أو الصلاحية) — العرض متاح للجميع.
 */

export interface VariantRow {
  id: number;
  productId: number;
  productName?: string | null;
  name: string | null;
  sku: string | null;
  price: string | number | null;
  currentStock: number;
  minStockLevel?: number | null;
  isActive?: boolean;
}

export type StockFilter = "all" | "available" | "low" | "out";

export function variantStatus(v: Pick<VariantRow, "currentStock" | "minStockLevel" | "isActive">): "archived" | "out" | "low" | "available" {
  if (v.isActive === false) return "archived";
  if ((v.currentStock ?? 0) <= 0) return "out";
  if ((v.currentStock ?? 0) <= (v.minStockLevel ?? 0)) return "low";
  return "available";
}

const STATUS_LABEL: Record<ReturnType<typeof variantStatus>, string> = {
  available: "متوفر", low: "منخفض", out: "نفد", archived: "مؤرشف",
};
const STATUS_TONE: Record<ReturnType<typeof variantStatus>, string> = {
  available: "bg-[var(--success)]/10 text-[var(--success)]",
  low: "bg-[var(--warning)]/15 text-[var(--warning)]",
  out: "bg-destructive/10 text-destructive",
  archived: "bg-muted text-muted-foreground",
};

/** فلترة الأنواع (نقية — للاختبار). */
export function filterVariants(rows: VariantRow[], search: string, filter: StockFilter): VariantRow[] {
  const q = search.trim().toLowerCase();
  return rows.filter(v => {
    if (v.isActive === false) return false;
    if (q && !(`${v.name ?? ""} ${v.sku ?? ""} ${v.productName ?? ""}`.toLowerCase().includes(q))) return false;
    if (filter === "all") return true;
    return variantStatus(v) === filter;
  });
}

const TOUCH = "h-11 min-h-[44px]";

export function ProductVariantGroups({
  variants,
  canEdit,
  onAdjust,
}: {
  variants: VariantRow[];
  canEdit: boolean;
  onAdjust?: (variant: VariantRow) => void;
}) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StockFilter>("all");
  const [open, setOpen] = useState<Record<number, boolean>>({});

  const groups = useMemo(() => {
    const filtered = filterVariants(variants, search, filter);
    const byProduct = new Map<number, { productId: number; productName: string; rows: VariantRow[]; total: number; attention: number }>();
    for (const v of filtered) {
      const g = byProduct.get(v.productId) ?? { productId: v.productId, productName: v.productName || `منتج #${v.productId}`, rows: [], total: 0, attention: 0 };
      g.rows.push(v); g.total += v.currentStock ?? 0;
      const st = variantStatus(v); if (st === "low" || st === "out") g.attention++;
      byProduct.set(v.productId, g);
    }
    return Array.from(byProduct.values()).map(g => ({ ...g, rows: [...g.rows].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "ar")) }))
      .sort((a, b) => a.productName.localeCompare(b.productName, "ar"));
  }, [variants, search, filter]);

  const isOpen = (pid: number, idx: number) => open[pid] ?? idx === 0;
  const chips: { key: StockFilter; label: string }[] = [
    { key: "all", label: "الكل" }, { key: "available", label: "متوفر" }, { key: "low", label: "منخفض" }, { key: "out", label: "نفد" },
  ];

  return (
    <section className="space-y-3 min-w-0" data-testid="variant-groups">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="بحث بالنوع أو SKU أو المنتج…" className={`${TOUCH} sm:max-w-xs`} data-testid="vg-search" />
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="فلتر المخزون">
          {chips.map(c => (
            <button
              key={c.key} type="button" role="tab" aria-selected={filter === c.key}
              onClick={() => setFilter(c.key)}
              className={`${TOUCH} rounded-full border px-4 text-sm ${filter === c.key ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground"}`}
              data-testid={`vg-filter-${c.key}`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {groups.length === 0 && (
        <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground" data-testid="vg-empty">لا توجد أنواع مطابقة</div>
      )}

      {groups.map((g, gi) => (
        <div key={g.productId} className="rounded-lg border bg-card min-w-0" data-testid={`vg-product-${g.productId}`}>
          <button
            type="button"
            onClick={() => setOpen(o => ({ ...o, [g.productId]: !isOpen(g.productId, gi) }))}
            className={`flex w-full items-center gap-2 px-3 py-3 text-right ${TOUCH} h-auto`}
            aria-expanded={isOpen(g.productId, gi)}
            data-testid={`vg-toggle-${g.productId}`}
          >
            <Package className="h-5 w-5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate font-bold">{g.productName}</span>
            <Badge variant="outline" className="shrink-0 text-xs">{g.rows.length} نوع</Badge>
            <Badge variant="secondary" className="shrink-0 text-xs tabular-nums">{g.total.toLocaleString("ar-EG")} قطعة</Badge>
            {g.attention > 0 && <Badge variant="destructive" className="shrink-0 text-xs">{g.attention} يحتاج انتباه</Badge>}
            {isOpen(g.productId, gi) ? <ChevronUp className="h-4 w-4 shrink-0" /> : <ChevronDown className="h-4 w-4 shrink-0" />}
          </button>

          {isOpen(g.productId, gi) && (
            <div className="border-t">
              {/* Desktop: جدول مرتب */}
              <table className="hidden w-full text-sm sm:table" data-testid={`vg-table-${g.productId}`}>
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-right font-medium">النوع</th>
                    <th className="px-3 py-2 text-right font-medium">SKU</th>
                    <th className="px-3 py-2 text-center font-medium">المتاح</th>
                    <th className="px-3 py-2 text-center font-medium">الحد الأدنى</th>
                    <th className="px-3 py-2 text-center font-medium">سعر البيع</th>
                    <th className="px-3 py-2 text-center font-medium">الحالة</th>
                    {canEdit && <th className="px-3 py-2 text-center font-medium">الإجراءات</th>}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {g.rows.map(v => {
                    const st = variantStatus(v);
                    return (
                      <tr key={v.id} data-testid={`vg-row-${v.id}`} data-status={st}>
                        <td className="px-3 py-2 font-medium">{v.name ?? "—"}</td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground" dir="ltr">{v.sku ?? "—"}</td>
                        <td className="px-3 py-2 text-center tabular-nums font-semibold" data-testid={`vg-stock-${v.id}`}>{v.currentStock}</td>
                        <td className="px-3 py-2 text-center tabular-nums text-muted-foreground">{v.minStockLevel ?? 0}</td>
                        <td className="px-3 py-2 text-center tabular-nums">{v.price != null ? Number(v.price).toFixed(2) : "—"}</td>
                        <td className="px-3 py-2 text-center"><span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[st]}`}>{STATUS_LABEL[st]}</span></td>
                        {canEdit && (
                          <td className="px-3 py-2 text-center">
                            <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={() => onAdjust?.(v)} data-testid={`vg-edit-${v.id}`}>
                              <Pencil className="h-4 w-4 ml-1" /> تعديل المخزون
                            </Button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Mobile: Card لكل نوع */}
              <div className="space-y-2 p-2 sm:hidden" data-testid={`vg-cards-${g.productId}`}>
                {g.rows.map(v => {
                  const st = variantStatus(v);
                  return (
                    <div key={v.id} className="rounded-lg border p-3 min-w-0" data-testid={`vg-card-${v.id}`} data-status={st}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-semibold">{v.name ?? "—"}</div>
                          {v.sku && <div className="truncate font-mono text-xs text-muted-foreground" dir="ltr">{v.sku}</div>}
                        </div>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${STATUS_TONE[st]}`}>{STATUS_LABEL[st]}</span>
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 text-center text-xs">
                        <div className="rounded-md bg-muted/40 p-2"><div className="text-muted-foreground">المتاح</div><div className="text-base font-bold tabular-nums">{v.currentStock}</div></div>
                        <div className="rounded-md bg-muted/40 p-2"><div className="text-muted-foreground">الحد الأدنى</div><div className="text-base font-bold tabular-nums">{v.minStockLevel ?? 0}</div></div>
                        <div className="rounded-md bg-muted/40 p-2"><div className="text-muted-foreground">سعر البيع</div><div className="text-base font-bold tabular-nums">{v.price != null ? Number(v.price).toFixed(0) : "—"}</div></div>
                      </div>
                      {canEdit && (
                        <Button type="button" variant="outline" className={`mt-2 w-full ${TOUCH}`} onClick={() => onAdjust?.(v)} data-testid={`vg-edit-m-${v.id}`}>
                          <Pencil className="h-4 w-4 ml-1" /> تعديل المخزون
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
