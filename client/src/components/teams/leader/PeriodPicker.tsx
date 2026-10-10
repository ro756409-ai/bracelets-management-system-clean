import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TOUCH, dayKey } from "../teamsUi";

/** فترة بتوقيت النشاط: أزرار جاهزة + مخصصة (من/إلى). المخصصة لا تُطبَّق إلا وهي صالحة (من ≤ إلى). */
export type Period = { dateFrom: string; dateTo: string };
export type Preset = { key: string; label: string; daysBack: number };

export function usePeriod(presets: Preset[], initial: string) {
  const [key, setKey] = useState(initial);
  const [custom, setCustom] = useState<Period>({ dateFrom: dayKey(6), dateTo: dayKey(0) });
  const p = presets.find(x => x.key === key);
  const period: Period = p ? { dateFrom: dayKey(p.daysBack), dateTo: dayKey(0) } : custom;
  return { key, setKey, custom, setCustom, period };
}

export function PeriodPicker({ presets, state, testId }: { presets: Preset[]; state: ReturnType<typeof usePeriod>; testId?: string }) {
  const [draft, setDraft] = useState<Period>(state.custom);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(draft.dateFrom) && /^\d{4}-\d{2}-\d{2}$/.test(draft.dateTo) && draft.dateFrom <= draft.dateTo;
  return (
    <div className="space-y-2" data-testid={testId} data-readonly-safe>
      <div className="flex flex-wrap gap-2" role="group" aria-label="الفترة">
        {presets.map(p => (
          <Button key={p.key} variant={state.key === p.key ? "default" : "outline"} className={TOUCH} aria-pressed={state.key === p.key} onClick={() => state.setKey(p.key)}>{p.label}</Button>
        ))}
        <Button variant={state.key === "custom" ? "default" : "outline"} className={TOUCH} aria-pressed={state.key === "custom"} onClick={() => state.setKey("custom")}>مخصصة</Button>
      </div>
      {state.key === "custom" && (
        <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); if (valid) state.setCustom(draft); }}>
          <label className="space-y-1 text-sm"><span className="block text-muted-foreground">من</span>
            <Input type="date" dir="ltr" className="min-h-11 w-40 tabular-nums" value={draft.dateFrom} max={dayKey(0)} onChange={e => setDraft(d => ({ ...d, dateFrom: e.target.value }))} /></label>
          <label className="space-y-1 text-sm"><span className="block text-muted-foreground">إلى</span>
            <Input type="date" dir="ltr" className="min-h-11 w-40 tabular-nums" value={draft.dateTo} max={dayKey(0)} onChange={e => setDraft(d => ({ ...d, dateTo: e.target.value }))} /></label>
          <Button type="submit" variant="outline" className={TOUCH} disabled={!valid}>تطبيق</Button>
          {!valid && <p className="w-full text-xs text-destructive" role="alert">تاريخ البداية يجب ألا يتجاوز النهاية.</p>}
        </form>
      )}
      <p className="text-xs text-muted-foreground">الفترة: من <bdi className="tabular-nums" dir="ltr">{state.period.dateFrom}</bdi> إلى <bdi className="tabular-nums" dir="ltr">{state.period.dateTo}</bdi> (توقيت القاهرة)</p>
    </div>
  );
}
