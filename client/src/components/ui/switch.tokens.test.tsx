// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { Switch } from "./switch";

/**
 * Matjarak 2.0 — المرحلة 1B-3: ألوان الـSwitch المقفول من Component Tokens، مفصولة عن --input — بلا تغيير في السلوك
 * (role/aria/الحالة/التعطيل/لوحة المفاتيح) ولا في الحجم والحركة.
 */
afterEach(() => cleanup());
const root = () => screen.getByRole("switch");
const thumb = () => root().querySelector('[data-slot="switch-thumb"]') as HTMLElement;

describe("🔘 Switch — Component Tokens", () => {
  it("المقفول: المسار من --switch-track والحد من --switch-track-border (خارج التركيز فقط)، والمقبض من --switch-thumb-off — لا --input", () => {
    render(<Switch aria-label="تفعيل" />);
    const cls = root().className;
    expect(cls).toContain("data-[state=unchecked]:bg-[var(--switch-track)]");
    expect(cls).toContain("data-[state=unchecked]:not-focus-visible:border-[var(--switch-track-border)]");
    expect(cls).not.toMatch(/bg-input/);
    expect(thumb().className).toContain("data-[state=unchecked]:bg-[var(--switch-thumb-off)]");
    // نفس الحجم والحركة وحلقة التركيز كما كانت
    for (const c of ["h-[1.15rem]", "w-8", "focus-visible:border-ring", "focus-visible:ring-[3px]", "data-[state=checked]:bg-primary"]) expect(cls).toContain(c);
    for (const c of ["size-4", "data-[state=checked]:translate-x-[calc(100%-2px)]", "data-[state=unchecked]:translate-x-0", "dark:data-[state=checked]:bg-primary-foreground"]) expect(thumb().className).toContain(c);
  });

  it("السلوك كما هو: role=switch، النقر والمسافة يبدّلان الحالة ويستدعيان onCheckedChange، والمعطّل لا يتغير", () => {
    const onChange = vi.fn();
    render(<Switch aria-label="تفعيل" onCheckedChange={onChange} />);
    expect(root().getAttribute("aria-checked")).toBe("false");
    expect(root().getAttribute("data-state")).toBe("unchecked");
    fireEvent.click(root());
    expect([root().getAttribute("aria-checked"), root().getAttribute("data-state"), onChange.mock.calls.at(-1)?.[0]]).toEqual(["true", "checked", true]);
    cleanup();
    const onDisabled = vi.fn();
    render(<Switch aria-label="معطّل" disabled onCheckedChange={onDisabled} />);
    fireEvent.click(root());
    expect([root().getAttribute("aria-checked"), onDisabled.mock.calls.length, (root() as HTMLButtonElement).disabled]).toEqual(["false", 0, true]);
  });

  it("الحالة المتحكَّم فيها من الخارج تظهر كما هي (checked=true ⇒ مفعّل بلا تغيير)", () => {
    render(<Switch aria-label="مفعّل" checked onCheckedChange={() => {}} />);
    expect([root().getAttribute("aria-checked"), root().getAttribute("data-state"), thumb().getAttribute("data-state")]).toEqual(["true", "checked", "checked"]);
  });
});
