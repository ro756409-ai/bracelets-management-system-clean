import { describe, expect, it } from "vitest";
import {
  DAY_NAMES_AR,
  getAgentsForGovernorateOnDay,
  getTodaySchedule,
  groupOrdersByAgent,
  type ShippingRouteRule,
} from "./shippingSchedules";

const routes: ShippingRouteRule[] = [
  {
    providerName: "Provider A",
    dayOfWeek: 0,
    governorates: ["cairo", "alex"],
    priority: 10,
  },
  {
    providerName: "Provider B",
    dayOfWeek: 0,
    governorates: ["alex", "minya"],
    priority: 5,
  },
  {
    providerName: "Provider B",
    dayOfWeek: 2,
    governorates: ["cairo"],
    priority: 5,
  },
];

describe("configured shipping schedules", () => {
  it("keeps technical weekday labels only", () => {
    expect(Object.keys(DAY_NAMES_AR)).toHaveLength(7);
    expect(DAY_NAMES_AR[0]).toBe("الأحد");
  });

  it("uses configured routes and priority", () => {
    expect(getAgentsForGovernorateOnDay("alex", 0, routes)).toEqual([
      "Provider A",
      "Provider B",
    ]);
  });

  it("returns no provider when configuration has no match", () => {
    expect(getAgentsForGovernorateOnDay("unknown", 0, routes)).toEqual([]);
  });

  it("builds the selected day schedule from configuration", () => {
    expect(getTodaySchedule(0, routes)).toEqual({
      "Provider A": ["cairo", "alex"],
      "Provider B": ["alex", "minya"],
    });
  });

  it("groups using the highest priority provider", () => {
    const grouped = groupOrdersByAgent(
      [
        { id: 1, governorate: "alex" },
        { id: 2, governorate: "minya" },
        { id: 3, governorate: "unknown" },
      ],
      0,
      routes
    );
    expect(grouped["Provider A"].map(row => row.id)).toEqual([1]);
    expect(grouped["Provider B"].map(row => row.id)).toEqual([2]);
    expect(grouped["غير محدد"].map(row => row.id)).toEqual([3]);
  });

  it("does not contain a built-in operational schedule", () => {
    expect(getTodaySchedule(0, [])).toEqual({});
  });
});
