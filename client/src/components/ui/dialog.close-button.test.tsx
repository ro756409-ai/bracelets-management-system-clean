// @vitest-environment jsdom
/**
 * المرحلة 7B (مراجعة) — زر إغلاق الحوار المشترك: هدف لمس ≥44×44px على الهاتف (h-11/w-11 + أرضية بالبكسل)،
 * 36px على md+، تسمية «إغلاق»، قابل للوصول بالـTab وزر أصلي (Enter/Space تفعيل أصلي للمتصفح لا يُمنع)،
 * العنوان يحجز مساحته فلا يتداخل معه في RTL، والضغط عليه يغلق الحوار عبر onOpenChange كما هو.
 * القياس الفعلي بالبكسل على 360/390/430 يتم في المتصفح (jsdom بلا تخطيط).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";

afterEach(() => cleanup());

const src = readFileSync(path.join(__dirname, "dialog.tsx"), "utf8");
const css = readFileSync(path.resolve(__dirname, "../../index.css"), "utf8");

function Harness({ onOpenChange }: { onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent data-testid="dlg">
        <DialogHeader>
          <DialogTitle>إلغاء الأوردر — عنوان طويل جدًا لاختبار التداخل على الشاشات الصغيرة</DialogTitle>
          <DialogDescription>وصف</DialogDescription>
        </DialogHeader>
        <input aria-label="حقل" />
      </DialogContent>
    </Dialog>
  );
}

describe("🧩 زر إغلاق الحوار المشترك", () => {
  it("زر أصلي بتسمية «إغلاق»، ≥44px على الهاتف (h-11 w-11 min-h-11 min-w-11) و36px على md+، والأيقونة 16px", () => {
    render(<Harness onOpenChange={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "إغلاق" });
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
    for (const c of ["h-11", "w-11", "min-h-11", "min-w-11", "md:h-9", "md:w-9", "inline-flex", "items-center", "justify-center"]) expect(btn.className, c).toContain(c);
    expect(btn.className).toContain("[&_svg:not([class*='size-'])]:size-4");
    expect(btn.querySelector("svg")).toBeTruthy();
    // أرضية 44px بالبكسل على الهاتف حتى عند 90% (قاعدة index.css من المرحلة 7A)
    expect(css).toMatch(/\.min-h-11\s*\{\s*min-height:\s*max\(2\.75rem,\s*44px\)/);
    expect(css).toMatch(/\.min-w-11\s*\{\s*min-width:\s*max\(2\.75rem,\s*44px\)/);
  });
  it("العنوان يحجز مساحة الزر (DialogHeader pr-10 / md:pr-8) فلا يتداخل في RTL، والزر في الزاوية داخل الحشو", () => {
    render(<Harness onOpenChange={vi.fn()} />);
    const header = screen.getByText("وصف").parentElement!;
    expect(header.getAttribute("data-slot")).toBe("dialog-header");
    expect(header.className).toContain("pr-10"); expect(header.className).toContain("md:pr-8");
    const btn = screen.getByRole("button", { name: "إغلاق" });
    expect(btn.className).toContain("absolute top-2 right-2"); expect(btn.className).toContain("md:top-3 md:right-3");
    // 24px حشو المحتوى + 40px = 64px > 8+44 = 52px (الهاتف)؛ 24 + 32 = 56 > 12+36 = 48 (md)
    expect(src).toContain("rounded-lg border p-6");
  });
  it("قابل للوصول بالـTab (focusable، ليس tabIndex=-1) وتفعيل Enter/Space أصلي غير ممنوع", () => {
    render(<Harness onOpenChange={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "إغلاق" });
    expect(btn.getAttribute("tabindex")).not.toBe("-1");
    btn.focus();
    expect(document.activeElement).toBe(btn);
    const enter = fireEvent.keyDown(btn, { key: "Enter", code: "Enter" });
    const space = fireEvent.keyDown(btn, { key: " ", code: "Space" });
    expect(enter).toBe(true); expect(space).toBe(true); // لم يُستدعَ preventDefault → المتصفح يفعّل الزر أصليًا
  });
  it("الضغط عليه يغلق الحوار عبر onOpenChange(false) — منطق Radix كما هو", () => {
    const onOpenChange = vi.fn();
    render(<Harness onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "إغلاق" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(src).toContain("<DialogPrimitive.Close"); expect(src).not.toContain("onClick={");
  });
});
