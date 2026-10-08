/**
 * بديل اختباري لـ`@/components/ui/select` (Radix) — يُرسم كـ<select> أصلي بنفس العقد
 * (value/onValueChange/disabled، وSelectItem → option، وid/data-testid من SelectTrigger)
 * لأن Radix Select لا يُفتح في jsdom. للاختبارات فقط.
 */
import React from "react";

export function Select({ value, onValueChange, children, disabled }: any) {
  const items: Array<{ value: string; label: React.ReactNode }> = [];
  let trigger: any = null;
  const walk = (c: any) => React.Children.forEach(c, (ch: any) => {
    if (!ch || typeof ch !== "object" || !ch.props) return;
    if (ch.type === SelectItem) items.push({ value: ch.props.value, label: ch.props.children });
    else if (ch.type === SelectTrigger) trigger = ch.props;
    else walk(ch.props.children);
  });
  walk(children);
  return (
    <select
      id={trigger?.id}
      data-testid={trigger?.["data-testid"]}
      aria-label={trigger?.["aria-label"] ?? trigger?.id}
      aria-invalid={trigger?.["aria-invalid"]}
      value={value ?? ""}
      disabled={disabled}
      onChange={e => onValueChange?.(e.target.value)}
    >
      <option value="">—</option>
      {items.map(i => <option key={i.value} value={i.value}>{typeof i.label === "string" ? i.label : String(i.value)}</option>)}
    </select>
  );
}
export function SelectTrigger(_p: any) { return null; }
export function SelectValue(_p: any) { return null; }
export function SelectContent({ children }: any) { return <>{children}</>; }
export function SelectItem(_p: any) { return null; }
export function SelectGroup({ children }: any) { return <>{children}</>; }
export function SelectLabel({ children }: any) { return <>{children}</>; }
export function SelectSeparator() { return null; }
