// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BrandMark } from "./BrandMark";

/**
 * Matjarak 2.0 — المرحلة 1B-4: نسخة الشعار المعكوسة (هيدر المخزن). نفس الشكل والوصف، الألوان فقط من Tokens؛
 * والنسخة العادية كما كانت حرفيًا.
 */
afterEach(() => cleanup());
const mark = () => screen.getByRole("img", { name: "متجرك" });

describe("Ⓜ️ BrandMark", () => {
  it("العادي كما كان: تدرّج البراند، حرف أبيض ونقطة #EDE9FE ثابتان، بلا data-variant ولا style", () => {
    render(<BrandMark className="h-9 w-9" />);
    const el = mark();
    expect(el.className).toBe("h-9 w-9 rounded-full shrink-0 bg-gradient-to-br from-brand-mark to-brand-mark-strong flex items-center justify-center");
    expect(el.hasAttribute("data-variant")).toBe(false);
    const path = el.querySelector("path")!, dot = el.querySelector("circle")!;
    expect([path.getAttribute("stroke"), path.getAttribute("style"), dot.getAttribute("fill"), dot.getAttribute("style")]).toEqual(["#FFFFFF", null, "#EDE9FE", null]);
  });

  it("المعكوس: نفس الهندسة والوصف، الدائرة والحرف والنقطة من --brand-mark-inverse*", () => {
    render(<BrandMark className="h-9 w-9" />);
    const geo = (el: HTMLElement) => [el.querySelector("svg")!.getAttribute("viewBox"), el.querySelector("path")!.getAttribute("d"), el.querySelector("path")!.getAttribute("stroke-width"), ["cx", "cy", "r"].map(a => el.querySelector("circle")!.getAttribute(a))];
    const normal = geo(mark()); cleanup();
    render(<BrandMark className="h-9 w-9" variant="inverse" />);
    const el = mark();
    expect(geo(el)).toEqual(normal);
    expect(el.getAttribute("data-variant")).toBe("inverse");
    expect(el.className).toContain("from-brand-mark-inverse to-brand-mark-inverse-strong");
    expect(el.className).not.toMatch(/from-brand-mark /);
    expect((el.querySelector("path") as SVGElement).style.stroke).toBe("var(--brand-mark-inverse-foreground)");
    expect((el.querySelector("circle") as SVGElement).style.fill).toBe("var(--brand-mark-inverse-node)");
  });
});
