import { describe, it, expect } from "vitest";
import { computePerformance, performanceCsv, type PerformanceEventRow } from "./employeePerformance";

const T0 = Date.UTC(2026, 9, 5, 10, 0, 0); // 2026-10-05 13:00 القاهرة
const ev = (p: Partial<PerformanceEventRow>): PerformanceEventRow => ({
  orderId: 1, eventType: "confirm", attributedEmployeeId: 7, assigneeEmployeeIdAtEvent: 7, callAttempt: null,
  occurredAtMs: T0, source: "employee_portal", backfillConfidence: null, ...p,
});
const run = (rows: PerformanceEventRow[], minSample = 20) => computePerformance(rows, { timeZone: "Africa/Cairo", minSample });

describe("«نسبة التأكيد من القرارات المسجلة»", () => {
  it("لم يرد ثم تأكيد لنفس الأوردر = مقام 1 وبسط 1 (100%)", () => {
    const [r] = run([ev({ eventType: "no_answer", callAttempt: 2 }), ev({ eventType: "confirm" })]);
    expect(r).toMatchObject({ decisionEligibleOrders: 1, confirmedOrders: 1, confirmationRate: 100, noAnswerOrders: 1, noAnswerAttempts: 2 });
  });
  it("النسبة ≤ 100% دائمًا، والمقام أوردرات مختلفة لا أحداث", () => {
    const rows = [ev({ orderId: 1, eventType: "confirm" }), ev({ orderId: 1, eventType: "confirm" }), ev({ orderId: 2, eventType: "cancel" }), ev({ orderId: 3, eventType: "postpone" }), ev({ orderId: 3, eventType: "postpone" })];
    const [r] = run(rows);
    expect(r.decisionEligibleOrders).toBe(3);
    expect(r.confirmedOrders).toBe(1);
    expect(r.confirmationRate).toBeCloseTo(33.3, 1);
    expect(r.cancelledOrders).toBe(1); expect(r.postponedOrders).toBe(1);
  });
  it("كل حدث لصاحبه: موظف أكّد وآخر ألغى نفس الأوردر", () => {
    const rows = run([ev({ attributedEmployeeId: 1, eventType: "confirm" }), ev({ attributedEmployeeId: 2, eventType: "cancel" })]);
    expect(rows.find(r => r.employeeId === 1)).toMatchObject({ confirmedOrders: 1, cancelledOrders: 0 });
    expect(rows.find(r => r.employeeId === 2)).toMatchObject({ confirmedOrders: 0, cancelledOrders: 1, confirmationRate: 0 });
  });
});

describe("المقاييس المنفصلة والنسبة", () => {
  it("حجم العمل والإسنادات منفصلان عن النسبة؛ الإسناد يُنسب للمُسنَد إليه لا للمنفّذ", () => {
    const rows = run([
      ev({ orderId: 5, eventType: "assign", attributedEmployeeId: 99, assigneeEmployeeIdAtEvent: 7 }),
      ev({ orderId: 6, eventType: "reassign", attributedEmployeeId: 99, assigneeEmployeeIdAtEvent: 7 }),
      ev({ orderId: 7, eventType: "edit", attributedEmployeeId: 7 }),
    ]);
    const me = rows.find(r => r.employeeId === 7)!;
    expect(me).toMatchObject({ assignedOrders: 2, workloadOrders: 1, decisionEligibleOrders: 0, confirmationRate: null });
    expect(rows.find(r => r.employeeId === 99)).toMatchObject({ workloadOrders: 2, assignedOrders: 0 });
  });
  it("أحداث النظام/الويبهوك بلا نسبة لا تُحتسب لأحد", () => {
    expect(run([ev({ attributedEmployeeId: null, source: "webhook_bosta", eventType: "ship_update", assigneeEmployeeIdAtEvent: null })])).toEqual([]);
  });
  it("Backfill الجزئي خارج الحساب الافتراضي، والمؤكد داخله", () => {
    const rows = run([ev({ orderId: 1, source: "backfill", backfillConfidence: "partial" }), ev({ orderId: 2, source: "backfill", backfillConfidence: "confirmed" })]);
    expect(rows[0].confirmedOrders).toBe(1);
    const withPartial = computePerformance([ev({ orderId: 1, source: "backfill", backfillConfidence: "partial" })], { timeZone: "Africa/Cairo", includePartialBackfill: true });
    expect(withPartial[0].confirmedOrders).toBe(1);
  });
  it("أيام النشاط بتوقيت القاهرة (22:30 UTC = يوم القاهرة التالي)", () => {
    const d1 = Date.UTC(2026, 9, 5, 20, 0); // 23:00 القاهرة (التوقيت الصيفي +3) يوم 5
    const d2 = Date.UTC(2026, 9, 5, 22, 30); // 01:30 القاهرة يوم 6
    expect(run([ev({ occurredAtMs: d1 }), ev({ occurredAtMs: d2, orderId: 2 })])[0].activeDays).toBe(2);
  });
});

describe("الترتيب — حد العينة 20", () => {
  it("من قراراته أقل من 20 يظهر بأرقامه بلا ترتيب", () => {
    const many = (emp: number, n: number, confirmEvery: number) => Array.from({ length: n }, (_, i) => ev({ orderId: emp * 1000 + i, attributedEmployeeId: emp, eventType: i % confirmEvery === 0 ? "confirm" : "cancel" }));
    const rows = run([...many(1, 25, 2), ...many(2, 30, 1), ...many(3, 5, 1)]);
    expect(rows.find(r => r.employeeId === 2)).toMatchObject({ rank: 1, rankable: true, confirmationRate: 100 });
    expect(rows.find(r => r.employeeId === 1)).toMatchObject({ rank: 2, rankable: true });
    expect(rows.find(r => r.employeeId === 3)).toMatchObject({ rank: null, rankable: false, confirmationRate: 100 });
  });
});

describe("CSV", () => {
  it("BOM + رأس عربي + «عينة أقل من الحد» بلا ترتيب، والفواصل مُهرَّبة", () => {
    const [r] = run([ev({})]);
    const csv = performanceCsv([{ ...r, employeeName: "سارة, أحمد" }]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toContain("نسبة التأكيد من القرارات المسجلة %");
    expect(csv).toContain('"سارة, أحمد"');
    expect(csv).toContain("عينة أقل من الحد");
  });
});
