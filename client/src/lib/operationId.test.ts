import { describe, it, expect } from "vitest";
import { operationIdFor, completeOperation, __pendingOperationScopes } from "./operationId";

describe("operationId — ثابت طوال دورة العملية", () => {
  it("نفس النطاق = نفس المعرّف (Double-click / Retry بعد خطأ) حتى النجاح", () => {
    const a = operationIdFor("confirm:1");
    expect(operationIdFor("confirm:1")).toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
    expect(operationIdFor("confirm:2")).not.toBe(a);
  });
  it("النجاح يستهلك المعرّف، والعملية التالية تأخذ معرّفًا جديدًا", () => {
    const a = operationIdFor("cancel:9");
    completeOperation(a);
    expect(__pendingOperationScopes()).not.toContain("cancel:9");
    expect(operationIdFor("cancel:9")).not.toBe(a);
  });
  it("قيمة غير نصية لا تؤثر", () => {
    const a = operationIdFor("postpone:3");
    completeOperation(undefined); completeOperation(42);
    expect(operationIdFor("postpone:3")).toBe(a);
  });
});
