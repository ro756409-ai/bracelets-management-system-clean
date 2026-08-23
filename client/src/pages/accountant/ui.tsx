import React from "react";

/**
 * عناصر واجهة خاصة بمساحة المحاسب فقط — Theme أبيض/رمادي فاتح، مساحات واسعة، أزرار
 * كبيرة، RTL. Tailwind محلي بس، من غير أي لمس لـdesign system العام (مفيش CSS vars عامة).
 */

export function accMoney(n: number | string | null | undefined): string {
  return Number(n ?? 0).toLocaleString("ar-EG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function AccCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function AccSectionTitle({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <h2 className={`mb-4 text-base font-bold text-slate-800 ${className}`}>{children}</h2>;
}

export function AccField({
  label, required, children,
}: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-slate-600">
        {label} {required && <span className="text-rose-500">*</span>}
      </span>
      {children}
    </label>
  );
}

const fieldBase =
  "w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-800 " +
  "outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200 " +
  "disabled:bg-slate-100 disabled:text-slate-500";

export const AccInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className = "", ...props }, ref) => (
    <input ref={ref} className={`${fieldBase} ${className}`} {...props} />
  )
);
AccInput.displayName = "AccInput";

export function AccTextarea({ className = "", ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${fieldBase} ${className}`} rows={2} {...props} />;
}

export function AccSelect({ className = "", children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`${fieldBase} ${className}`} {...props}>{children}</select>;
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
};
export function AccButton({ variant = "primary", className = "", children, ...props }: BtnProps) {
  const tones: Record<string, string> = {
    primary: "bg-slate-800 text-white hover:bg-slate-900 disabled:bg-slate-400",
    ghost: "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50",
    danger: "border border-rose-200 bg-white text-rose-600 hover:bg-rose-50 disabled:opacity-50",
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-semibold transition ${tones[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function AccTable({
  head, empty, children,
}: { head: string[]; empty: string; children: React.ReactNode }) {
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-right text-xs font-semibold text-slate-500">
            {head.map(h => <th key={h} className="px-3 py-2.5 whitespace-nowrap">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={head.length} className="px-3 py-10 text-center text-sm text-slate-400">
                {empty}
              </td>
            </tr>
          ) : rows}
        </tbody>
      </table>
    </div>
  );
}

const statusTones: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  rose: "bg-rose-50 text-rose-700",
  slate: "bg-slate-100 text-slate-600",
};
export function AccStatus({ tone = "slate", children }: { tone?: "green" | "amber" | "rose" | "slate"; children: React.ReactNode }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold ${statusTones[tone]}`}>
      {children}
    </span>
  );
}
