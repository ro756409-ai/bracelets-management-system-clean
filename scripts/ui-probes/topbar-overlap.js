/**
 * قياس آلي لتقاطع العناصر التفاعلية في الشريط العلوي (المرحلة 4 — طلب المالك).
 *
 * يُلصق في console المتصفح (أو يُحقن عبر أداة الفحص) على الصفحة الحقيقية، ثم:
 *   JSON.stringify(window.__topbarOverlap())
 * لكل عرض (360/390/430) × Light/Dark × 100%/125%. لا يكتفي بفحص الخروج من الشاشة: يحسب تقاطع
 * `getBoundingClientRect()` بين **كل زوج** من العناصر التفاعلية المرئية داخل `header.sticky`،
 * ويُرجع الأزواج المتقاطعة (بالمساحة بالبكسل) وأي عنصر خارج حدود الشريط أو أقل من 44px.
 *
 * لا يعدّل الصفحة ولا يعتمد على overflow-x:hidden — التقاطع المرئي هو ما يُقاس.
 */
(function () {
  function rect(el) { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; }
  function label(el) { return (el.getAttribute("aria-label") || el.getAttribute("data-testid") || el.textContent || el.tagName).trim().slice(0, 24); }
  function overlapArea(a, b) {
    const w = Math.min(a.r, b.r) - Math.max(a.l, b.l);
    const h = Math.min(a.b, b.b) - Math.max(a.t, b.t);
    return w > 0.5 && h > 0.5 ? Math.round(w * h) : 0;
  }
  window.__topbarOverlap = function (opts) {
    const o = Object.assign({ tolerancePx: 0, minTarget: 44, selector: "header.sticky" }, opts || {});
    const header = document.querySelector(o.selector);
    if (!header) return { error: "no header" };
    const hr = rect(header);
    const items = Array.from(header.querySelectorAll('button, a[href], input, [role="button"], [role="combobox"], [tabindex]:not([tabindex="-1"])'))
      .filter(el => { const r = rect(el); return r.w > 0 && r.h > 0 && getComputedStyle(el).visibility !== "hidden"; })
      // عنصر داخل عنصر تفاعلي آخر (asChild) يُحسب مرة واحدة
      .filter((el, _, all) => !all.some(p => p !== el && p.contains(el)));
    const rects = items.map(el => ({ el, label: label(el), ...rect(el) }));
    const overlaps = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = overlapArea(rects[i], rects[j]);
      if (a > o.tolerancePx) overlaps.push({ a: rects[i].label, b: rects[j].label, areaPx: a });
    }
    const outside = rects.filter(x => x.l < hr.l - 0.5 || x.r > hr.r + 0.5).map(x => ({ label: x.label, l: Math.round(x.l), r: Math.round(x.r) }));
    const small = rects.filter(x => x.h < o.minTarget - 0.5 || x.w < o.minTarget - 0.5).map(x => ({ label: x.label, w: Math.round(x.w), h: Math.round(x.h) }));
    // حبر النص الفعلي (Range) — لا مربع الكتلة — لأن النص الملفوف/المقتطع قد يرسم خارج حاويته دون أن يكبر مربعها
    const textBoxes = [];
    rects.forEach(x => {
      const walker = document.createTreeWalker(x.el, NodeFilter.SHOW_TEXT);
      let n; while ((n = walker.nextNode())) {
        if (!n.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(n);
        // الحبر المرئي فقط: مستطيل النص يُقصّ بكل سلف يقصّ المحتوى (overflow/clip/sr-only) — ما لا يُرى لا يُحسب تداخلًا
        const clipBy = (cr) => {
          let box = { l: cr.left, t: cr.top, r: cr.right, b: cr.bottom };
          for (let a = n.parentElement; a && a !== document.body; a = a.parentElement) {
            const cs = getComputedStyle(a);
            const clips = /(hidden|clip|scroll|auto)/.test(cs.overflowX + cs.overflowY) || (cs.clip && cs.clip !== "auto") || (cs.clipPath && cs.clipPath !== "none");
            if (clips) { const ar = rect(a); box = { l: Math.max(box.l, ar.l), t: Math.max(box.t, ar.t), r: Math.min(box.r, ar.r), b: Math.min(box.b, ar.b) }; }
          }
          return box.r - box.l > 0.5 && box.b - box.t > 0.5 ? box : null;
        };
        Array.from(range.getClientRects()).forEach(cr => { const v = cr.width > 0 ? clipBy(cr) : null; if (v) textBoxes.push({ owner: x, text: n.textContent.trim().slice(0, 16), ...v }); });
      }
    });
    // نص عنصر يرسم فوق عنصر تفاعلي آخر، أو خارج مربع عنصره نفسه (ink overflow)
    const textOverlaps = [];
    textBoxes.forEach(tb => {
      rects.forEach(other => { if (other !== tb.owner) { const a = overlapArea(tb, other); if (a > o.tolerancePx) textOverlaps.push({ text: tb.text, of: tb.owner.label, over: other.label, areaPx: a }); } });
      if (tb.r > tb.owner.r + 1 || tb.l < tb.owner.l - 1) textOverlaps.push({ text: tb.text, of: tb.owner.label, over: "(outside own box)", areaPx: Math.round((tb.r - tb.l) * (tb.b - tb.t)) });
    });
    const textSpill = textOverlaps;
    return {
      vw: document.documentElement.clientWidth, fontSize: document.documentElement.style.fontSize || "100%", dark: document.documentElement.classList.contains("dark"),
      headerHeight: Math.round(hr.h), items: rects.map(x => `${x.label} [${Math.round(x.l)}–${Math.round(x.r)}] ${Math.round(x.w)}×${Math.round(x.h)}`),
      overlapCount: overlaps.length, overlaps, outsideCount: outside.length, outside, smallCount: small.length, small, textOverlapCount: textSpill.length, textOverlaps: textSpill,
      workspaceTabsRows: document.querySelectorAll("[data-testid=workspace-tabs]").length,
      scrollWidth: document.documentElement.scrollWidth,
    };
  };
})();
