import { describe, it, expect, afterAll } from "vitest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { getDb, createSignupRequest, getSignupRequestById } from "./db";
import { signupRequests } from "../drizzle/schema";

/**
 * Phase 3.3 — إثبات أن الطلب **بيتحفظ فعلًا** بحالة pending على DB حقيقي (matjarak_test).
 * regression لـbug الإنتاج (كان بيرجّع نجاحًا وهميًا بدون حفظ). بيتخطّى بدون TEST_DATABASE_URL.
 */
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("🔑 signup persistence — DB فعلي", () => {
  const ids: number[] = [];
  afterAll(async () => {
    const db = await getDb();
    if (db && ids.length) await db.delete(signupRequests).where(inArray(signupRequests.id, ids));
  });

  it("🔑 createSignupRequest بيحفظ صف pending فعليًا", async () => {
    const tag = Date.now();
    const id = await createSignupRequest({
      ownerName: "مالك اختبار", businessName: "نشاط اختبار", phone: "01000000000",
      email: `persist-${tag}@test.local`, username: `persist_${tag}`,
      passwordHash: await bcrypt.hash("persist-pass-1234", 10),
    });
    ids.push(id);
    expect(id).toBeGreaterThan(0);
    const row = await getSignupRequestById(id);
    expect(row?.status).toBe("pending");
    expect(row?.email).toBe(`persist-${tag}@test.local`);
  });
});
