// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { observable } from "@trpc/server/observable";
import { blockedWriteControl, clientMutationAllowed, isReadSafeControl, readOnlyLink, setTenantAccessLevel, READ_ONLY_MESSAGE } from "./tenantReadOnly";

const html = (s: string) => { document.body.innerHTML = s; };
const q = (sel: string) => document.querySelector(sel)!;
afterEach(() => { setTenantAccessLevel("full"); document.body.innerHTML = ""; });

describe("🔒 تصنيف عناصر التفاعل في وضع القراءة فقط", () => {
  it("الكتابة ممنوعة افتراضيًا: زر/بند قائمة/مفتاح/اختيار/ملف", () => {
    html(`<button id=b>حفظ</button><div role=menuitem id=m>حذف</div><button role=switch id=s></button><button role=checkbox id=c></button><input type=file id=f>`);
    for (const id of ["b", "m", "s", "c", "f"]) expect(blockedWriteControl(q(`#${id}`)), id).not.toBeNull();
  });
  it("القراءة آمنة: منطقة معلَّمة، نموذج بحث، تبويب، فاتح قائمة/اختيار، طيّ، مفتاح عرض، خيار، إغلاق", () => {
    html(`<div data-readonly-safe><button id=z><span id=zi>تصدير</span></button></div>
      <form role=search><button id=sr type=submit>بحث</button></form>
      <button role=tab id=t>تبويب</button>
      <button aria-haspopup=menu id=mt>⋯</button><button aria-haspopup=listbox id=st>فلتر</button>
      <button aria-expanded=false id=ex>تفاصيل</button><button aria-pressed=true id=ap>اليوم</button>
      <div role=option id=op>القاهرة</div>`);
    for (const id of ["z", "zi", "sr", "t", "mt", "st", "ex", "ap", "op"]) expect(blockedWriteControl(q(`#${id}`)), id).toBeNull();
  });
  it("فتح نافذة إنشاء (aria-haspopup=dialog) ليس قراءة؛ data-readonly-write يتغلّب على أي قاعدة قراءة", () => {
    html(`<button aria-haspopup=dialog aria-expanded=false id=d>إضافة</button><div data-readonly-safe><button data-readonly-write aria-pressed=true id=w>تعطيل</button></div>`);
    expect(blockedWriteControl(q("#d"))).not.toBeNull();
    expect(isReadSafeControl(q("#w"))).toBe(false);
  });
  it("المعطّل أصلًا والروابط والنصوص ليست عناصر كتابة", () => {
    html(`<button disabled id=dis>حفظ</button><a href="/orders" id=a>الأوردرات</a><input id=i>`);
    expect(blockedWriteControl(q("#dis"))).toBeNull();
    expect(blockedWriteControl(q("#a"))).toBeNull();
    expect(blockedWriteControl(q("#i"))).toBeNull();
  });
});

describe("🔒 رابط tRPC — نفس قاعدة السيرفر", () => {
  const run = (type: "query" | "mutation", path: string) => new Promise<string>(resolve => {
    const link = readOnlyLink({} as any);
    link({ op: { type, path, id: 1, input: undefined, context: {}, signal: null } as any, next: () => observable(o => { o.next({ result: { data: "ok" } } as any); o.complete(); }) })
      .subscribe({ next: () => resolve("ok"), error: (e: any) => resolve(e.message) });
  });
  it("full: كل شيء يمر", async () => {
    expect(await run("mutation", "orders.update")).toBe("ok");
  });
  it("read_only: القراءة والخروج وإعدادات الاشتراك فقط", async () => {
    setTenantAccessLevel("read_only");
    expect(await run("query", "orders.list")).toBe("ok");
    expect(await run("mutation", "orders.update")).toBe(READ_ONLY_MESSAGE);
    expect(await run("mutation", "employeePortal.attendanceClock")).toBe(READ_ONLY_MESSAGE);
    expect(await run("mutation", "auth.logout")).toBe("ok");
    expect(await run("mutation", "subscription.update")).toBe("ok");
    expect(clientMutationAllowed("tasks.create")).toBe(false);
  });
  it("blocked: لا كتابة إطلاقًا عدا الخروج", async () => {
    setTenantAccessLevel("blocked");
    expect(await run("mutation", "orders.update")).toBe(READ_ONLY_MESSAGE);
    expect(await run("mutation", "auth.logout")).toBe("ok");
  });
});
