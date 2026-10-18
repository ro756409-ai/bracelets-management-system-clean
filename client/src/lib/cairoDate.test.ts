import { describe, it, expect } from "vitest";
import fs from "fs";
import { cairoDateKey, previousDateKey, cairoMiddayInstant } from "./cairoDate";

/**
 * يوم القاهرة الفعلي في التوقيتين: الصيفي (UTC+3، من آخر جمعة في أبريل لآخر خميس في أكتوبر) والشتوي (UTC+2).
 * الحساب القديم (+2 ساعة ثابتة) كان بيطلع اليوم اللي قبله بين 00:00 و01:00 بتوقيت القاهرة في الصيفي.
 */
describe("cairoDate — صيفي وشتوي", () => {
  it("cairoDateKey: نص الليل بتوقيت القاهرة في الصيفي والشتوي", () => {
    // صيفي: 21:30Z = 00:30 القاهرة (UTC+3) يوم 2 يوليو — الحساب القديم (+2) كان بيقول 23:30 يوم 1
    expect(cairoDateKey(new Date("2026-07-01T21:30:00Z"))).toBe("2026-07-02");
    expect(new Date(new Date("2026-07-01T21:30:00Z").getTime() + 2 * 3600_000).toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(cairoDateKey(new Date("2026-07-01T20:59:59Z"))).toBe("2026-07-01");
    // شتوي: UTC+2
    expect(cairoDateKey(new Date("2026-12-01T22:00:00Z"))).toBe("2026-12-02");
    expect(cairoDateKey(new Date("2026-12-01T21:59:59Z"))).toBe("2026-12-01");
  });

  it("أمس (previousDateKey ∘ cairoDateKey): صح حوالين نص الليل، وعبر الشهر والسنة", () => {
    expect(previousDateKey(cairoDateKey(new Date("2026-07-01T21:30:00Z")))).toBe("2026-07-01");
    expect(previousDateKey(cairoDateKey(new Date("2026-12-01T22:30:00Z")))).toBe("2026-12-01");
    expect(previousDateKey("2026-03-01")).toBe("2026-02-28");
    expect(previousDateKey("2027-01-01")).toBe("2026-12-31");
  });

  it("cairoMiddayInstant: 12:00 بتوقيت القاهرة الفعلي = 09:00Z صيفًا و10:00Z شتاءً، وجوه نفس اليوم في أيام التحويل", () => {
    expect(cairoMiddayInstant("2026-07-15").toISOString()).toBe("2026-07-15T09:00:00.000Z");
    expect(cairoMiddayInstant("2026-12-15").toISOString()).toBe("2026-12-15T10:00:00.000Z");
    // أيام التحويل 2026: بداية الصيفي 24 أبريل، ونهايته 29 أكتوبر — واليوم اللي قبل وبعد كل واحد
    for (const k of ["2026-04-23", "2026-04-24", "2026-04-25", "2026-10-28", "2026-10-29", "2026-10-30"]) {
      expect(cairoDateKey(cairoMiddayInstant(k)), k).toBe(k);
    }
  });

  it("حارس: مفيش +2 ثابتة في الصفحات التلاتة — بتستخدم cairoDate", () => {
    for (const f of ["client/src/pages/AgentWorkspace.tsx", "client/src/pages/EmployeeDashboard.tsx", "client/src/pages/DailyLedger.tsx"]) {
      const src = fs.readFileSync(f, "utf-8");
      expect(src, f).not.toMatch(/2 ?\* ?60 ?\* ?60 ?\* ?1000|\+02:00/);
      expect(src, f).toContain('from "@/lib/cairoDate"');
    }
  });
});
