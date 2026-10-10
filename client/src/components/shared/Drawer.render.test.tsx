// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Drawer } from "./Drawer";

/**
 * زر إغلاق الـDrawer المشترك: داخل صف الرأس (مساحة محجوزة، لا تداخل مع العنوان في RTL)، 44×44 على الهاتف و36×36
 * من md، الأيقونة 16px، aria-label «إغلاق» + نص sr-only عربي، والإغلاق نفسه = onOpenChange(false) كما كان.
 */
afterEach(() => cleanup());
const setup = () => {
  const onOpenChange = vi.fn();
  render(<Drawer open onOpenChange={onOpenChange} title="عنوان طويل جدًا لسجل" description="وصف"><p>المحتوى</p></Drawer>);
  return { onOpenChange };
};

describe("🧩 Drawer — زر الإغلاق", () => {
  it("زر واحد فقط باسم «إغلاق» (لا زر Close الافتراضي المطلق)", () => {
    setup();
    const btns = screen.getAllByRole("button", { name: "إغلاق" });
    expect(btns).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(btns[0].querySelector(".sr-only")?.textContent).toBe("إغلاق");
  });
  it("مقاس اللمس: 44px على الهاتف و36px من md، والأيقونة 16px", () => {
    setup();
    const b = screen.getByTestId("drawer-close");
    expect(b.className).toMatch(/\bsize-11\b/);
    expect(b.className).toMatch(/\bmd:size-9\b/);
    expect(b.className).not.toMatch(/\babsolute\b/);
    expect(b.querySelector("svg")?.getAttribute("class")).toMatch(/size-4/);
  });
  it("في نفس صف العنوان (مساحة محجوزة) وقبل كتلة العنوان", () => {
    setup();
    const b = screen.getByTestId("drawer-close");
    const row = b.parentElement!;
    expect(row.textContent).toContain("عنوان طويل جدًا لسجل");
    expect(row.firstElementChild).toBe(b);
  });
  it("الإغلاق كما كان: onOpenChange(false) مرة واحدة", () => {
    const { onOpenChange } = setup();
    fireEvent.click(screen.getByTestId("drawer-close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onOpenChange).toHaveBeenCalledTimes(1);
  });
});
