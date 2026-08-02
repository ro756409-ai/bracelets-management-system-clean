import { describe, it, expect } from "vitest";
import { cairoStartOfDay, cairoEndOfDay, cairoTodayRange, cairoParseDateRange } from "./db";

describe("Cairo Timezone Helpers", () => {
  it("cairoStartOfDay respects Cairo daylight saving time", () => {
    // Cairo midnight = UTC 22:00 previous day
    const date = new Date("2025-05-10T10:30:00Z"); // Any time on May 10
    const result = cairoStartOfDay(date);
    // Egypt observes daylight saving time in May: Cairo midnight = 21:00 UTC.
    expect(result.getUTCHours()).toBe(21);
    expect(result.getUTCDate()).toBe(9);
    expect(result.getUTCMonth()).toBe(4); // May = 4
  });

  it("cairoEndOfDay respects Cairo daylight saving time", () => {
    const date = new Date("2025-05-10T10:30:00Z");
    const result = cairoEndOfDay(date);
    // End of May 10 Cairo = May 10 20:59:59.999 UTC while DST is active.
    expect(result.getUTCHours()).toBe(20);
    expect(result.getUTCMinutes()).toBe(59);
    expect(result.getUTCSeconds()).toBe(59);
    expect(result.getUTCDate()).toBe(10);
  });

  it("cairoTodayRange returns from/to for today in Cairo", () => {
    const { from, to } = cairoTodayRange();
    expect(from).toBeInstanceOf(Date);
    expect(to).toBeInstanceOf(Date);
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  });

  it("cairoParseDateRange parses YYYY-MM-DD correctly", () => {
    const { from, to } = cairoParseDateRange("2025-05-10");
    expect(from.toISOString()).toBe("2025-05-09T21:00:00.000Z");
    expect(to.toISOString()).toBe("2025-05-10T20:59:59.999Z");
  });

  it("cairoParseDateRange handles January 1st correctly", () => {
    const { from, to } = cairoParseDateRange("2025-01-01");
    // Jan 1 Cairo start = Dec 31 22:00 UTC
    expect(from.toISOString()).toBe("2024-12-31T22:00:00.000Z");
    expect(to.toISOString()).toBe("2025-01-01T21:59:59.999Z");
  });
});

describe("Sales Channels Router", () => {
  it("getAllSalesChannels is exported from db", async () => {
    const { getAllSalesChannels } = await import("./db");
    expect(typeof getAllSalesChannels).toBe("function");
  });

  it("createSalesChannel is exported from db", async () => {
    const { createSalesChannel } = await import("./db");
    expect(typeof createSalesChannel).toBe("function");
  });

  it("updateSalesChannel is exported from db", async () => {
    const { updateSalesChannel } = await import("./db");
    expect(typeof updateSalesChannel).toBe("function");
  });

  it("deleteSalesChannel is exported from db", async () => {
    const { deleteSalesChannel } = await import("./db");
    expect(typeof deleteSalesChannel).toBe("function");
  });

  it("getActiveSalesChannels is exported from db", async () => {
    const { getActiveSalesChannels } = await import("./db");
    expect(typeof getActiveSalesChannels).toBe("function");
  });
});
