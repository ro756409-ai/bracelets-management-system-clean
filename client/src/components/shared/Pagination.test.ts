import { describe, expect, it } from "vitest";
import { buildPageList } from "./Pagination";

describe("buildPageList", () => {
  it("returns an empty list when there are no pages", () => {
    expect(buildPageList(1, 0)).toEqual([]);
  });

  it("lists every page when the total is small — no ellipsis needed", () => {
    expect(buildPageList(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("shows a single page with no ellipsis", () => {
    expect(buildPageList(1, 1)).toEqual([1]);
  });

  it("adds an ellipsis after page 1 when the current page is far from the start", () => {
    // page 7 of 20 → 1 … 6 7 8 … 20
    expect(buildPageList(7, 20)).toEqual([1, null, 6, 7, 8, null, 20]);
  });

  it("has no leading ellipsis when the current page is near the start", () => {
    expect(buildPageList(2, 20)).toEqual([1, 2, 3, null, 20]);
  });

  it("has no trailing ellipsis when the current page is near the end", () => {
    expect(buildPageList(19, 20)).toEqual([1, null, 18, 19, 20]);
  });

  it("always includes the first and last page", () => {
    const pages = buildPageList(10, 30).filter((p): p is number => p !== null);
    expect(pages[0]).toBe(1);
    expect(pages[pages.length - 1]).toBe(30);
  });
});
