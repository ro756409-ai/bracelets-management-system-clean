import { useEffect, type RefObject } from "react";

/**
 * حماية القيم الرقمية/المالية من التغطية **الجزئية** تحت الأعمدة الثابتة (docs/backlog/responsive-data-table-sticky-occlusion.md،
 * الخيار 4 + 3). مبلغ زي «1,250 ج.م» متغطّي جزئيًا ممكن يتقري «250» — فطول ما الخلية متغطية جزئيًا، القيمة بتختفي **بالكامل**
 * (opacity 0، فاضلة في DOM لقارئ الشاشة) ويظهر مكانها مؤشر صريح، لحد ما المستخدم يمرّر. الظاهرة كليًا أو المخفية كليًا ماتتلمسش.
 * v2 فقط (المستدعي بيقرر)؛ مفيش تغيير في ترتيب الأعمدة ولا إخفاء بيانات ولا الكيبورد.
 */
export type Span = { left: number; right: number };
export type Occlusion = "visible" | "partial" | "hidden";

/** المنطقة الصافية: حدود الحاوية ناقص أي عمود ثابت لازق في طرف منها. */
export function clearZone(container: Span, stickies: Span[]): Span {
  let { left, right } = container;
  const mid = (container.left + container.right) / 2;
  for (const s of stickies) {
    if (s.right - s.left <= 0) continue;
    if ((s.left + s.right) / 2 < mid) left = Math.max(left, s.right);
    else right = Math.min(right, s.left);
  }
  return { left, right };
}

/** حالة خلية بالنسبة للمنطقة الصافية (هامش نصف بكسل لتقريب المتصفح). */
export function occlusionOf(cell: Span, zone: Span, tolerance = 0.5): Occlusion {
  const width = cell.right - cell.left;
  if (width <= 0) return "visible";
  const visible = Math.max(0, Math.min(cell.right, zone.right) - Math.max(cell.left, zone.left));
  if (visible >= width - tolerance) return "visible";
  if (visible <= tolerance) return "hidden";
  return "partial";
}

const span = (r: DOMRect): Span => ({ left: r.left, right: r.right });

/** عمود «مثبّت» بيتحسب ضمن الأعمدة الثابتة بس وهو لازق فعلًا في واحد منها (في موضعه الطبيعي مابيغطّيش حاجة). */
export function stuckSide(pinned: Span, stickies: Span[], tolerance = 1.5): "start-side" | "end-side" | null {
  for (const s of stickies) {
    if (Math.abs(pinned.left - s.right) <= tolerance) return "start-side";
    if (Math.abs(pinned.right - s.left) <= tolerance) return "end-side";
  }
  return null;
}

export function applyOcclusion(container: HTMLElement): number {
  const ths = (kind: string) => [...container.querySelectorAll<HTMLElement>(`thead [data-rdt-sticky="${kind}"]`)];
  const width = (els: HTMLElement[]) => els.reduce((w, el) => w + el.getBoundingClientRect().width, 0);
  container.style.setProperty("--rdt-start-w", `${width(ths("start"))}px`);
  container.style.setProperty("--rdt-end-w", `${width(ths("end"))}px`);
  const edge = [...ths("start"), ...ths("end")].map(el => span(el.getBoundingClientRect()));
  const stickies = [...edge];
  let stuck = "none";
  for (const el of ths("pinned")) {
    const p = span(el.getBoundingClientRect());
    const side = stuckSide(p, edge);
    if (side) { stickies.push(p); stuck = side; }
  }
  container.dataset.rdtPinnedStuck = stuck;
  const zone = clearZone(span(container.getBoundingClientRect()), stickies);
  let partial = 0;
  // الخلايا الثابتة/المثبّتة نفسها ظاهرة دايمًا — الحماية للأعمدة الرقمية العادية اللي بتعدّي تحتها بس.
  container.querySelectorAll<HTMLElement>("td[data-rdt-numeric]:not([data-rdt-sticky])").forEach(td => {
    const content = td.querySelector<HTMLElement>("[data-rdt-value]") ?? td;
    const state = occlusionOf(span(content.getBoundingClientRect()), zone);
    if (state === "partial") { partial++; if (td.dataset.occluded !== "partial") td.dataset.occluded = "partial"; }
    else if (td.dataset.occluded) delete td.dataset.occluded;
  });
  container.dataset.rdtOverflow = String(container.scrollWidth > container.clientWidth + 1);
  return partial;
}

export function useStickyOcclusionGuard(ref: RefObject<HTMLElement | null>, enabled: boolean, deps: unknown[]) {
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let frame = 0;
    const run = () => { frame = 0; applyOcclusion(el); };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(run); };
    run();
    el.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    ro?.observe(el);
    const table = el.querySelector("table");
    if (table) ro?.observe(table);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps]);
}
