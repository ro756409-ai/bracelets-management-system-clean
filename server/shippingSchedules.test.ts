import { describe, it, expect } from "vitest";
import {
  getAgentsForGovernorateOnDay,
  getTodaySchedule,
  groupOrdersByAgent,
  DAY_NAMES_AR,
  SHIPPING_SCHEDULES,
} from "./shippingSchedules";

describe("Shipping Schedules", () => {
  describe("DAY_NAMES_AR", () => {
    it("should have all 7 days in Arabic", () => {
      expect(DAY_NAMES_AR[0]).toBe("الأحد");
      expect(DAY_NAMES_AR[1]).toBe("الاثنين");
      expect(DAY_NAMES_AR[2]).toBe("الثلاثاء");
      expect(DAY_NAMES_AR[3]).toBe("الأربعاء");
      expect(DAY_NAMES_AR[4]).toBe("الخميس");
      expect(DAY_NAMES_AR[5]).toBe("الجمعة");
      expect(DAY_NAMES_AR[6]).toBe("السبت");
    });
  });

  describe("SHIPPING_SCHEDULES", () => {
    it("should have الشبح and العالمية agents", () => {
      expect(SHIPPING_SCHEDULES.length).toBe(2);
      expect(SHIPPING_SCHEDULES[0].name).toBe("الشبح");
      expect(SHIPPING_SCHEDULES[1].name).toBe("العالمية");
    });

    it("الشبح should have no Friday schedule", () => {
      const ghost = SHIPPING_SCHEDULES.find(a => a.id === "ghost")!;
      expect(ghost.schedule[5]).toBeUndefined(); // Friday
    });

    it("العالمية should have Friday schedule", () => {
      const alamia = SHIPPING_SCHEDULES.find(a => a.id === "alamia")!;
      expect(ghost_or_alamia_has_friday(alamia)).toBe(true);
    });
  });

  describe("getAgentsForGovernorateOnDay", () => {
    it("Cairo area should always return المتخصص", () => {
      for (let day = 0; day <= 6; day++) {
        const agents = getAgentsForGovernorateOnDay("القاهرة", day);
        expect(agents).toEqual(["المتخصص"]);
      }
    });

    it("الجيزة should return المتخصص", () => {
      const agents = getAgentsForGovernorateOnDay("الجيزة", 1);
      expect(agents).toEqual(["المتخصص"]);
    });

    it("الإسكندرية on Saturday (6) should be served by both agents", () => {
      const agents = getAgentsForGovernorateOnDay("الإسكندرية", 6);
      expect(agents).toContain("الشبح");
      expect(agents).toContain("العالمية");
    });

    it("الإسكندرية on Sunday (0) should be served by both agents", () => {
      const agents = getAgentsForGovernorateOnDay("الإسكندرية", 0);
      expect(agents).toContain("الشبح");
      expect(agents).toContain("العالمية");
    });

    it("Upper Egypt (المنيا) on Sunday should be served by الشبح", () => {
      const agents = getAgentsForGovernorateOnDay("المنيا", 0); // Sunday
      expect(agents).toContain("الشبح");
    });

    it("Upper Egypt (أسيوط) on Wednesday should be served by both", () => {
      const agents = getAgentsForGovernorateOnDay("أسيوط", 3); // Wednesday
      expect(agents).toContain("الشبح");
      expect(agents).toContain("العالمية");
    });

    it("Upper Egypt (سوهاج) on Saturday should be served by العالمية only", () => {
      const agents = getAgentsForGovernorateOnDay("سوهاج", 6); // Saturday
      expect(agents).toContain("العالمية");
      expect(agents).not.toContain("الشبح");
    });

    it("Upper Egypt on Tuesday should return empty (no agent)", () => {
      const agents = getAgentsForGovernorateOnDay("أسوان", 2); // Tuesday
      expect(agents).toEqual([]);
    });

    it("الفيوم on Saturday should be served by العالمية (upper egypt Sat)", () => {
      const agents = getAgentsForGovernorateOnDay("الفيوم", 6);
      // الفيوم is upper egypt, العالمية serves upper egypt on Saturday
      expect(agents).toContain("العالمية");
    });

    it("كفر الشيخ on Tuesday should be served by العالمية", () => {
      const agents = getAgentsForGovernorateOnDay("كفر الشيخ", 2);
      expect(agents).toContain("العالمية");
    });

    it("دمياط on Monday should be served by الشبح", () => {
      const agents = getAgentsForGovernorateOnDay("دمياط", 1);
      expect(agents).toContain("الشبح");
    });
  });

  describe("getTodaySchedule", () => {
    it("should always include المتخصص with Cairo govs", () => {
      for (let day = 0; day <= 6; day++) {
        const schedule = getTodaySchedule(day);
        expect(schedule["المتخصص"]).toBeDefined();
        expect(schedule["المتخصص"]).toContain("القاهرة");
        expect(schedule["المتخصص"]).toContain("الجيزة");
      }
    });

    it("Saturday should have both الشبح and العالمية", () => {
      const schedule = getTodaySchedule(6);
      expect(schedule["الشبح"]).toBeDefined();
      expect(schedule["العالمية"]).toBeDefined();
    });

    it("Friday should not have الشبح", () => {
      const schedule = getTodaySchedule(5);
      expect(schedule["الشبح"]).toBeUndefined();
    });

    it("Wednesday should include upper egypt for both agents", () => {
      const schedule = getTodaySchedule(3);
      expect(schedule["الشبح"]).toContain("المنيا");
      expect(schedule["العالمية"]).toContain("المنيا");
    });
  });

  describe("groupOrdersByAgent", () => {
    const mockOrders = [
      { id: 1, governorate: "القاهرة", totalAmount: "250" },
      { id: 2, governorate: "الجيزة", totalAmount: "300" },
      { id: 3, governorate: "الإسكندرية", totalAmount: "200" },
      { id: 4, governorate: "المنيا", totalAmount: "350" },
      { id: 5, governorate: "الشرقية", totalAmount: "180" },
    ];

    it("should group Cairo orders under المتخصص", () => {
      const groups = groupOrdersByAgent(mockOrders, 0); // Sunday
      expect(groups["المتخصص"]).toBeDefined();
      expect(groups["المتخصص"].length).toBe(2); // Cairo + Giza
    });

    it("should group الإسكندرية under الشبح on Sunday", () => {
      const groups = groupOrdersByAgent(mockOrders, 0);
      // الشبح is first in the agents list, so الإسكندرية goes to الشبح
      expect(groups["الشبح"]).toBeDefined();
      const alexOrder = groups["الشبح"].find((o: any) => o.governorate === "الإسكندرية");
      expect(alexOrder).toBeDefined();
    });

    it("should group upper egypt under الشبح on Sunday", () => {
      const groups = groupOrdersByAgent(mockOrders, 0);
      const minyaOrder = groups["الشبح"]?.find((o: any) => o.governorate === "المنيا");
      expect(minyaOrder).toBeDefined();
    });

    it("should put upper egypt in غير محدد on Tuesday (no agent)", () => {
      const groups = groupOrdersByAgent(mockOrders, 2); // Tuesday
      // المنيا has no agent on Tuesday
      const unmatched = groups["غير محدد"];
      expect(unmatched).toBeDefined();
      expect(unmatched.find((o: any) => o.governorate === "المنيا")).toBeDefined();
    });

    it("should handle empty orders array", () => {
      const groups = groupOrdersByAgent([], 0);
      expect(Object.keys(groups).length).toBe(0);
    });

    it("should handle unknown governorate", () => {
      const orders = [{ id: 99, governorate: "محافظة غير موجودة", totalAmount: "100" }];
      const groups = groupOrdersByAgent(orders, 0);
      expect(groups["غير محدد"]).toBeDefined();
      expect(groups["غير محدد"].length).toBe(1);
    });
  });
});

// Helper
function ghost_or_alamia_has_friday(agent: typeof SHIPPING_SCHEDULES[0]) {
  return agent.schedule[5] !== undefined && agent.schedule[5].length > 0;
}
