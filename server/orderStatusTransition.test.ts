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

  it("treats delivered and returned as terminal for this generic path", () => {
    expect(isValidOrderStatusTransition("delivered", "new")).toBe(false);
    expect(isValidOrderStatusTransition("delivered", "confirmed")).toBe(false);
    expect(isValidOrderStatusTransition("returned", "new")).toBe(false);
  });

  it("rejects an unknown status as the source", () => {
    expect(isValidOrderStatusTransition("not_a_real_status", "confirmed")).toBe(false);
  });
});
