import { describe, it, expect } from "vitest";
import { isValidOrderStatusTransition } from "./db";

describe("isValidOrderStatusTransition", () => {
  it("allows a no-op (same status to itself)", () => {
    expect(isValidOrderStatusTransition("new", "new")).toBe(true);
    expect(isValidOrderStatusTransition("delivered", "delivered")).toBe(true);
  });

  it("allows the real workflow transitions", () => {
    expect(isValidOrderStatusTransition("new", "confirmed")).toBe(true);
    expect(isValidOrderStatusTransition("new", "postponed")).toBe(true);
    expect(isValidOrderStatusTransition("new", "cancelled")).toBe(true);
    expect(isValidOrderStatusTransition("new", "no_answer")).toBe(true);
    expect(isValidOrderStatusTransition("postponed", "new")).toBe(true);
    expect(isValidOrderStatusTransition("no_answer", "new")).toBe(true);
    expect(isValidOrderStatusTransition("confirmed", "preparing")).toBe(true);
    expect(isValidOrderStatusTransition("printed", "shipped")).toBe(true);
    expect(isValidOrderStatusTransition("preparing", "shipped")).toBe(true);
    expect(isValidOrderStatusTransition("shipped", "delivered")).toBe(true);
    expect(isValidOrderStatusTransition("cancelled", "new")).toBe(true);
  });

  it("rejects jumping straight from new to delivered", () => {
    expect(isValidOrderStatusTransition("new", "delivered")).toBe(false);
  });

  it("rejects jumping straight from new to shipped", () => {
    expect(isValidOrderStatusTransition("new", "shipped")).toBe(false);
  });

  it("delivered/returned are not fully terminal — an explicit customer return path is allowed", () => {
    // Widened 2026-07-28: a delivered order the customer returns, or a returned order that
    // gets reprocessed, are real ops corrections — but a delivered order still can't silently
    // become "new" or "confirmed" again (that would erase the fact it was ever delivered).
    expect(isValidOrderStatusTransition("delivered", "returned")).toBe(true);
    expect(isValidOrderStatusTransition("returned", "new")).toBe(true);
    expect(isValidOrderStatusTransition("delivered", "new")).toBe(false);
    expect(isValidOrderStatusTransition("delivered", "confirmed")).toBe(false);
  });

  it("allows the widened corrective transitions (2026-07-28 ops review)", () => {
    expect(isValidOrderStatusTransition("confirmed", "postponed")).toBe(true);
    expect(isValidOrderStatusTransition("confirmed", "no_answer")).toBe(true);
    expect(isValidOrderStatusTransition("preparing", "confirmed")).toBe(true);
    expect(isValidOrderStatusTransition("shipped", "cancelled")).toBe(true);
    expect(isValidOrderStatusTransition("shipped", "returned")).toBe(true);
    expect(isValidOrderStatusTransition("cancelled", "confirmed")).toBe(true);
  });

  it("still rejects an unknown status as the source", () => {
    expect(isValidOrderStatusTransition("not_a_real_status", "confirmed")).toBe(false);
  });
});
