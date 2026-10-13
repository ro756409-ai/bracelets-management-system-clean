import { describe, it, expect } from "vitest";
import { operationIdFor, completeOperation, createTabGuard, discardOperation, persistentOperationIdFor, __forgetInMemoryForTests, __pendingOperationScopes } from "./operationId";

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

const fakeStorage = () => {
  const m = new Map<string, string>();
  return { map: m, api: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null, get length() { return m.size; } } as unknown as Storage };
};

describe("persistentOperationIdFor — عمليات الإنشاء (0052)", () => {
  it("يبقى عبر إعادة المحاولة وإعادة تحميل نفس التبويب (sessionStorage)، ويتغيّر بالنجاح أو بإجراء صريح فقط", () => {
    const st = fakeStorage();
    (globalThis as any).sessionStorage = st.api;
    try {
      const a = persistentOperationIdFor("order.create|d1");
      expect(persistentOperationIdFor("order.create|d1")).toBe(a);
      __forgetInMemoryForTests("order.create|d1"); // «إعادة تحميل»: الذاكرة تضيع وتخزين التبويب يبقى
      expect(persistentOperationIdFor("order.create|d1")).toBe(a);
      completeOperation(a);
      expect([...st.map.keys()].filter(k => k.startsWith("matjarak:op:"))).toEqual([]);
      const b = persistentOperationIdFor("order.create|d1");
      expect(b).not.toBe(a);
      discardOperation("order.create|d1");
      expect(persistentOperationIdFor("order.create|d1")).not.toBe(b);
      // معرّف تالف في التخزين لا يُستخدم
      discardOperation("order.create|d2"); st.map.set("matjarak:op:order.create|d2", "bad id!");
      expect(persistentOperationIdFor("order.create|d2")).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
    } finally { delete (globalThis as any).sessionStorage; }
  });
  it("النطاقات مفصولة: نوع العملية/المسودة/النشاط/المستخدم المختلف = معرّف مختلف", () => {
    (globalThis as any).sessionStorage = fakeStorage().api;
    try {
      const ids = ["order.create|t1:b1:e1#a2:m", "order.create|t1:b1:e2#a2:m", "order.create|t1:b1:e1#a3:m", "order.create|t2:b9:e1#a2:m", "workshop.send|t1:b1:e1|b2"].map(persistentOperationIdFor);
      expect(new Set(ids).size).toBe(ids.length);
    } finally { delete (globalThis as any).sessionStorage; }
  });
  it("تبويبان = تخزينان منفصلان ⇒ عمليتان مستقلتان بمعرّفين مختلفين لنفس النطاق", () => {
    const tab1 = fakeStorage(), tab2 = fakeStorage();
    (globalThis as any).sessionStorage = tab1.api;
    const a = persistentOperationIdFor("order.create|same-draft");
    __forgetInMemoryForTests("order.create|same-draft"); // تبويب آخر = ذاكرة أخرى
    (globalThis as any).sessionStorage = tab2.api;
    const b = persistentOperationIdFor("order.create|same-draft");
    delete (globalThis as any).sessionStorage;
    expect(b).not.toBe(a);
  });
  it("معرّف في الذاكرة فقط يُكتب في التخزين أيضًا — لا يضيع بإعادة التحميل", () => {
    (globalThis as any).sessionStorage = fakeStorage().api;
    try {
      const a = operationIdFor("order.create|mem");
      expect(persistentOperationIdFor("order.create|mem")).toBe(a);
      __forgetInMemoryForTests("order.create|mem");
      expect(persistentOperationIdFor("order.create|mem")).toBe(a);
    } finally { delete (globalThis as any).sessionStorage; }
  });
  it("بلا تخزين متاح (يرمي): يعمل من الذاكرة فقط", () => {
    (globalThis as any).sessionStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    try {
      const a = persistentOperationIdFor("ws:1");
      expect(persistentOperationIdFor("ws:1")).toBe(a);
      completeOperation(a);
      expect(persistentOperationIdFor("ws:1")).not.toBe(a);
    } finally { delete (globalThis as any).sessionStorage; }
  });
});

describe("حارس التبويب المكرَّر", () => {
  /** قناة بث مشتركة بين «تبويبات» داخل الاختبار (BroadcastChannel لا يسلّم للمرسل نفسه). */
  const bus = () => {
    const members: any[] = [];
    return () => { const ch: any = { onmessage: null, postMessage: (m: any) => { for (const o of members) if (o !== ch) o.onmessage?.({ data: structuredClone(m) }); } }; members.push(ch); return ch; };
  };
  it("تبويب منسوخ (نفس معرّف التبويب في التخزين) يُكتشف: يأخذ معرّفًا جديدًا ويُسقط المفاتيح المنسوخة؛ الأصلي يحتفظ بها", () => {
    const channel = bus();
    const orig = fakeStorage();
    let origDup = 0;
    const g1 = createTabGuard({ storage: () => orig.api, channel: channel(), onDuplicate: () => { origDup++; } });
    orig.map.set("matjarak:op:order.create|d", "opid_original_123");
    const copy = fakeStorage(); for (const [k, v] of orig.map) copy.map.set(k, v); // «تكرار التبويب» ينسخ sessionStorage
    let dropped = 0;
    const g2 = createTabGuard({ storage: () => copy.api, channel: channel(), onDuplicate: () => { dropped++; copy.map.delete("matjarak:op:order.create|d"); } });
    expect([dropped, origDup]).toEqual([1, 0]);
    expect(g2.tabId).not.toBe(g1.tabId);
    expect(copy.map.get("matjarak:op-tab")).toBe(g2.tabId);
    expect(orig.map.get("matjarak:op:order.create|d")).toBe("opid_original_123");
    expect(copy.map.has("matjarak:op:order.create|d")).toBe(false);
  });
  it("إعادة تحميل نفس التبويب (لا تبويب حيّ آخر بنفس المعرّف) تحتفظ بمعرّف التبويب ومفاتيحه", () => {
    const channel = bus();
    const st = fakeStorage();
    const first = createTabGuard({ storage: () => st.api, channel: null, onDuplicate: () => {} }).tabId; // الصفحة قبل التحميل (قناتها أُغلقت)
    let dup = 0;
    const g = createTabGuard({ storage: () => st.api, channel: channel(), onDuplicate: () => { dup++; } });
    createTabGuard({ storage: () => fakeStorage().api, channel: channel(), onDuplicate: () => {} }); // تبويب جديد آخر لا يؤثر
    expect([g.tabId, dup]).toEqual([first, 0]);
  });
});
