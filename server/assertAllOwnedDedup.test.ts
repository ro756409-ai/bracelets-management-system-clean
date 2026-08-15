import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Regression: `assertAllOwned` كان بيرمي "غير موجود" غلط لما المنادي يبعت نفس الـid
 * أكتر من مرة (أصناف facebook-entry اللي بتتفرّع من منتج أب واحد). دلوقتي بيميّز الـids
 * قبل المقارنة. الاختبارات دي بتقفل السلوك الصح.
 */

// mock db: select().from().where() بترجّع الصفوف اللي بنحدّدها.
let mockRows: any[] = [];
vi.mock("./db", () => ({
  getDb: vi.fn(async () => ({
    select: () => ({ from: () => ({ where: async () => mockRows }) }),
  })),
}));

import {
  assertAllOwned,
  OutOfScopeError,
  RecordNotFoundError,
} from "./tenantScope";

describe("🔑 assertAllOwned — تمييز الـids المكررة", () => {
  beforeEach(() => {
    mockRows = [];
  });

  it("🔑 ids=[5,5,5] ومنتج واحد موجود ومملوك → PASS بدون throw", async () => {
    mockRows = [{ id: 5, businessId: 1 }];
    await expect(
      assertAllOwned([1], "product", [5, 5, 5])
    ).resolves.toBeUndefined();
  });

  it("🔑 id ناقص فعليًا → يفضل يرمي RecordNotFoundError", async () => {
    mockRows = [{ id: 5, businessId: 1 }]; // 6 مش موجود
    await expect(assertAllOwned([1], "product", [5, 6])).rejects.toBeInstanceOf(
      RecordNotFoundError
    );
  });

  it("🔑 caller عادي بـids مميزة موجودة → السلوك زي ما هو (PASS)", async () => {
    mockRows = [
      { id: 5, businessId: 1 },
      { id: 6, businessId: 1 },
    ];
    await expect(
      assertAllOwned([1], "product", [5, 6])
    ).resolves.toBeUndefined();
  });

  it("🔑 مملوك لنشاط تاني → لسه بيرمي OutOfScopeError (العزل محفوظ)", async () => {
    mockRows = [{ id: 5, businessId: 2 }];
    await expect(assertAllOwned([1], "product", [5, 5])).rejects.toBeInstanceOf(
      OutOfScopeError
    );
  });

  it("مصفوفة فاضية → مفيش فحص ولا throw", async () => {
    await expect(assertAllOwned([1], "product", [])).resolves.toBeUndefined();
  });
});
