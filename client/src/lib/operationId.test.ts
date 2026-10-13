import { describe, it, expect } from "vitest";
import { operationIdFor, completeOperation, discardOperation, persistentOperationIdFor, __forgetInMemoryForTests, __pendingOperationScopes } from "./operationId";

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

describe("persistentOperationIdFor — عمليات الإنشاء (0052)", () => {
  it("يبقى عبر إعادة المحاولة وإعادة التحميل (محفوظ على الجهاز)، ويتغيّر بالنجاح أو بدء عملية جديدة", () => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    try {
      const a = persistentOperationIdFor("fb-order:x");
      expect(persistentOperationIdFor("fb-order:x")).toBe(a);
      // «إعادة تحميل»: الذاكرة تضيع والجهاز يحتفظ — نفس المعرّف
      __forgetInMemoryForTests("fb-order:x");
      expect(persistentOperationIdFor("fb-order:x")).toBe(a);
      completeOperation(a);
      expect([...store.keys()]).toEqual([]);
      const b = persistentOperationIdFor("fb-order:x");
      expect(b).not.toBe(a);
      discardOperation("fb-order:x");
      expect(persistentOperationIdFor("fb-order:x")).not.toBe(b);
      // معرّف تالف على الجهاز لا يُستخدم
      discardOperation("fb-order:y"); store.set("matjarak:op:fb-order:y", "bad id!");
      expect(persistentOperationIdFor("fb-order:y")).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
    } finally { delete (globalThis as any).localStorage; }
  });
  it("معرّف موجود في الذاكرة فقط يُكتب على الجهاز أيضًا — لا يضيع بإعادة التحميل", () => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    try {
      const a = operationIdFor("fb-order:mem");
      expect(persistentOperationIdFor("fb-order:mem")).toBe(a);
      __forgetInMemoryForTests("fb-order:mem");
      expect(persistentOperationIdFor("fb-order:mem")).toBe(a);
    } finally { delete (globalThis as any).localStorage; }
  });
  it("بلا تخزين متاح (يرمي): يعمل من الذاكرة فقط", () => {
    (globalThis as any).localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    try {
      const a = persistentOperationIdFor("ws:1");
      expect(persistentOperationIdFor("ws:1")).toBe(a);
      completeOperation(a);
      expect(persistentOperationIdFor("ws:1")).not.toBe(a);
    } finally { delete (globalThis as any).localStorage; }
  });
});
