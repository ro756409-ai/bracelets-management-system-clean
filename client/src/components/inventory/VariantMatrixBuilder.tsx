import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { X, Plus } from "lucide-react";

/**
 * بانِي مصفوفة التركيبات (المرحلة B): يدخّل المستخدم قائمة ألوان وقائمة مقاسات، ويُولّد
 * تلقائيًا كل تركيبات Color × Size في جدول قابل للتحرير (SKU/سعر/تكلفة/مخزون افتتاحي/حد أدنى)،
 * مع إمكانية استبعاد أي تركيبة. مكوّن متحكَّم فيه: القيمة والتغيير من الأب، والأب هو اللي
 * يستدعي createWithVariants. منع تكرار اللون×المقاس + تفرّد الـSKU يتفحصهم السيرفر برضه.
 */

export interface VariantRowDraft {
  color: string;
  size: string;
  sku: string;
  price: string;
  costPrice: string;
  currentStock: string;
  minStockLevel: string;
  enabled: boolean;
}

export interface VariantMatrixValue {
  colors: string[];
  sizes: string[];
  /** key = `${color}||${size}` */
  rows: Record<string, VariantRowDraft>;
}

export function emptyVariantMatrix(): VariantMatrixValue {
  return { colors: [], sizes: [], rows: {} };
}

export function comboKey(color: string, size: string): string {
  return `${color.trim()}||${size.trim()}`;
}

/** يبني/يحدّث صفوف التركيبات من الألوان×المقاسات مع الحفاظ على تعديلات الصفوف الباقية. */
export function rebuildRows(
  colors: string[],
  sizes: string[],
  prev: Record<string, VariantRowDraft>,
  skuBase: string
): Record<string, VariantRowDraft> {
  const next: Record<string, VariantRowDraft> = {};
  const cols = colors.length ? colors : [""];
  const szs = sizes.length ? sizes : [""];
  for (const color of cols) {
    for (const size of szs) {
      if (!color.trim() && !size.trim()) continue; // لازم بُعد واحد على الأقل
      const key = comboKey(color, size);
      if (prev[key]) {
        next[key] = prev[key];
      } else {
        const suffix = [color, size]
          .map(s => s.trim())
          .filter(Boolean)
          .join("-");
        next[key] = {
          color: color.trim(),
          size: size.trim(),
          sku: skuBase.trim() ? `${skuBase.trim()}-${suffix}` : "",
          price: "",
          costPrice: "",
          currentStock: "0",
          minStockLevel: "5",
          enabled: true,
        };
      }
    }
  }
  return next;
}

/** التركيبات المفعّلة فقط — الشكل اللي بيتبعت لـcreateWithVariants (بعد التحقق في الأب). */
export function enabledVariants(value: VariantMatrixValue): VariantRowDraft[] {
  return Object.values(value.rows).filter(r => r.enabled);
}

function ChipInput({
  label,
  placeholder,
  items,
  onChange,
}: {
  label: string;
  placeholder: string;
  items: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  function add() {
    const parts = draft
      .split(/[,،\n]/)
      .map(s => s.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const merged = [...items];
    for (const p of parts) if (!merged.includes(p)) merged.push(p);
    onChange(merged);
    setDraft("");
  }
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-1 flex gap-2">
        <Input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={placeholder}
        />
        <Button type="button" variant="outline" onClick={add}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {items.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {items.map(it => (
            <Badge key={it} variant="secondary" className="gap-1">
              {it}
              <button
                type="button"
                onClick={() => onChange(items.filter(x => x !== it))}
                aria-label={`إزالة ${it}`}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export function VariantMatrixBuilder({
  value,
  onChange,
  skuBase,
}: {
  value: VariantMatrixValue;
  onChange: (next: VariantMatrixValue) => void;
  skuBase: string;
}) {
  function setColors(colors: string[]) {
    onChange({ ...value, colors, rows: rebuildRows(colors, value.sizes, value.rows, skuBase) });
  }
  function setSizes(sizes: string[]) {
    onChange({ ...value, sizes, rows: rebuildRows(value.colors, sizes, value.rows, skuBase) });
  }
  function patchRow(key: string, patch: Partial<VariantRowDraft>) {
    onChange({ ...value, rows: { ...value.rows, [key]: { ...value.rows[key], ...patch } } });
  }

  const keys = Object.keys(value.rows);
  const enabledCount = keys.filter(k => value.rows[k].enabled).length;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ChipInput
          label="الألوان"
          placeholder="أسود، أبيض، أحمر ثم Enter"
          items={value.colors}
          onChange={setColors}
        />
        <ChipInput
          label="المقاسات"
          placeholder="S، M، L أو من 5 لـ6 سنين"
          items={value.sizes}
          onChange={setSizes}
        />
      </div>

      {keys.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          أضف لونًا أو مقاسًا واحدًا على الأقل لتوليد التركيبات تلقائيًا.
        </p>
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <table className="w-full text-sm" data-testid="variant-matrix-table">
            <thead>
              <tr className="border-b bg-muted/50 text-right">
                <th className="p-2 font-medium">فعّال</th>
                <th className="p-2 font-medium">اللون</th>
                <th className="p-2 font-medium">المقاس</th>
                <th className="p-2 font-medium">SKU</th>
                <th className="p-2 font-medium">سعر البيع</th>
                <th className="p-2 font-medium">التكلفة</th>
                <th className="p-2 font-medium">مخزون افتتاحي</th>
                <th className="p-2 font-medium">حد أدنى</th>
              </tr>
            </thead>
            <tbody>
              {keys.map(key => {
                const r = value.rows[key];
                return (
                  <tr key={key} className="border-b last:border-0">
                    <td className="p-2 text-center">
                      <Checkbox
                        checked={r.enabled}
                        onCheckedChange={c => patchRow(key, { enabled: Boolean(c) })}
                        aria-label="تفعيل التركيبة"
                      />
                    </td>
                    <td className="p-2">{r.color || "—"}</td>
                    <td className="p-2">{r.size || "—"}</td>
                    <td className="p-2">
                      <Input
                        value={r.sku}
                        onChange={e => patchRow(key, { sku: e.target.value })}
                        className="h-8 font-mono min-w-[120px]"
                        disabled={!r.enabled}
                        placeholder="SKU"
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        type="number"
                        min="0"
                        value={r.price}
                        onChange={e => patchRow(key, { price: e.target.value })}
                        className="h-8 w-24"
                        disabled={!r.enabled}
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        type="number"
                        min="0"
                        value={r.costPrice}
                        onChange={e => patchRow(key, { costPrice: e.target.value })}
                        className="h-8 w-24"
                        disabled={!r.enabled}
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        type="number"
                        min="0"
                        value={r.currentStock}
                        onChange={e => patchRow(key, { currentStock: e.target.value })}
                        className="h-8 w-20"
                        disabled={!r.enabled}
                      />
                    </td>
                    <td className="p-2">
                      <Input
                        type="number"
                        min="0"
                        value={r.minStockLevel}
                        onChange={e => patchRow(key, { minStockLevel: e.target.value })}
                        className="h-8 w-20"
                        disabled={!r.enabled}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {keys.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {enabledCount} تركيبة مفعّلة من {keys.length}. لكل تركيبة SKU فريد داخل النشاط.
        </p>
      )}
    </div>
  );
}
