/**
 * طباعة تبويبات التشغيل من جوه الداشبورد — بتخفي كروم الشل (السايدبار + الشريط العلوي +
 * رأس الصفحة + تبويبات القسم + التنقّل السفلي) وقت الطباعة بس، فالورقة يطلع عليها الكشف
 * نفسه بعنوان الطباعة بتاع الصفحة (`hidden print:block`).
 *
 * بتتركّب مع الصفحة وبتتشال معاها (مش CSS عام)، فمابتأثرش على طباعة أي صفحة تانية.
 * عناصر الصفحة اللي مالهاش لازمة على الورق بتتعلّم بـ`print:hidden` (Tailwind).
 */
export function WorkspacePrintStyles() {
  return (
    <style>{`
      @media print {
        body { background: white !important; }
        [data-slot="sidebar"],
        [data-slot="sidebar-inset"] header,
        [data-slot="sidebar-inset"] > div:has(> nav[aria-label="تبويبات القسم"]),
        nav[aria-label="التنقّل الأساسي"] { display: none !important; }
        [data-slot="sidebar-inset"] > main { padding: 0 !important; }
        table { font-size: 11px; }
        .rounded-xl { border-radius: 0; }
        .shadow-sm, .shadow-lg { box-shadow: none; }
      }
    `}</style>
  );
}
