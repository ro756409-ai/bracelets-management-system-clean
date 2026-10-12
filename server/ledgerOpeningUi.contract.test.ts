import { describe, it, expect } from "vitest";
import { OPENING_MONEY_ACCOUNTS } from "./ledgerOpening.service";
import { OPENING_ACCOUNTS } from "../client/src/pages/ledger/ledgerUi";

/** عقد: حسابات صفحة الأرصدة الافتتاحية = حسابات السيرفر نفسها (الكود والاسم والمجموعة) — لا انحراف صامت. */
describe("🔗 عقد حسابات الأرصدة الافتتاحية (واجهة ↔ سيرفر)", () => {
  it("نفس الأكواد والأسماء والمجموعات (COD ذمة منفصلة)", () => {
    const key = (a: { code: string; name: string; group: string }) => `${a.code}|${a.name}|${a.group}`;
    expect(OPENING_ACCOUNTS.map(key).sort()).toEqual(OPENING_MONEY_ACCOUNTS.map(key).sort());
    expect(OPENING_ACCOUNTS.filter(a => a.group === "cod_receivable").map(a => a.code)).toEqual(["COD_BOSTA"]);
  });
});
