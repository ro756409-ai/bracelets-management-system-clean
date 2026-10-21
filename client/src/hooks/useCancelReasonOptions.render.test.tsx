// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";

/** BUG-28 — الخطاف نفسه داخل React: قائمة النشاط الفارغة لا تُنتج قائمة إلغاء فارغة. */
const state: { options: { value: string; label: string }[] } = { options: [] };
vi.mock("./useOperationalOptions", () => ({ useOperationalOptions: () => ({ options: state.options, values: state.options.map(o => o.value) }) }));
const { useCancelReasonOptions } = await import("./useCancelReasonOptions");

afterEach(() => cleanup());

describe("useCancelReasonOptions", () => {
  it("بلا أسباب مضبوطة: 8 أسباب افتراضية و isConfigured = false", () => {
    state.options = [];
    const { result } = renderHook(() => useCancelReasonOptions());
    expect(result.current.options).toHaveLength(8);
    expect(result.current.isConfigured).toBe(false);
  });
  it("بأسباب النشاط: تُستخدم كما هي و isConfigured = true", () => {
    state.options = [{ value: "price", label: "السعر" }];
    const { result } = renderHook(() => useCancelReasonOptions());
    expect(result.current.options).toEqual([{ value: "price", label: "السعر" }]);
    expect(result.current.isConfigured).toBe(true);
  });
});
