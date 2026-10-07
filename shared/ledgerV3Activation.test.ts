import { describe, it, expect } from "vitest";
import { confirmationPhrase, isValidIsoDate, parseOpeningFile } from "./ledgerV3Activation";

const MONEY = ["OFFICE_CASH", "BANK_MAIN", "COD_BOSTA", "VF_CASH", "INSTAPAY"] as const;
const base = { goLiveDate: "2026-11-01", openingBalances: { OFFICE_CASH: "1000.50", BANK_MAIN: "2500" } };

describe("📄 ملف الأرصدة الافتتاحية — تحليل صارم بلا تخمين", () => {
  it("ملف صالح: نصوص عشرية، المجموع بمقياس 4 خانات، الافتراضات صريحة (EGP، بلا أنشطة/ربط/اعتماد)", () => {
    const r = parseOpeningFile(base, MONEY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.total).toBe("3500.5000");
    expect(r.file).toMatchObject({ goLiveDate: "2026-11-01", currency: "EGP", openingBalances: { OFFICE_CASH: "1000.50", BANK_MAIN: "2500" }, openingEquity: null, businessIds: null, safeGrants: null, reconciliation: null });
  });
  it("أرقام JSON (float/int) مرفوضة — لا تقريب ثنائي؛ النص فقط", () => {
    const r = parseOpeningFile({ ...base, openingBalances: { OFFICE_CASH: 1000.5, BANK_MAIN: "1" } }, MONEY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join(" ")).toMatch(/OFFICE_CASH.*نصًا عشريًا.*float/);
  });
  it("حساب مجهول أو كود غير نقدي = رفض؛ سالب/أكثر من 4 كسور = رفض", () => {
    expect(parseOpeningFile({ ...base, openingBalances: { PETTY: "5" } }, MONEY)).toMatchObject({ ok: false, errors: [expect.stringContaining("حساب مجهول في openingBalances: PETTY")] });
    expect(parseOpeningFile({ ...base, openingBalances: { REVENUE: "5" } }, MONEY)).toMatchObject({ ok: false });
    expect(parseOpeningFile({ ...base, openingBalances: { OFFICE_CASH: "-5" } }, MONEY)).toMatchObject({ ok: false, errors: [expect.stringContaining("مبلغ غير صالح")] });
    expect(parseOpeningFile({ ...base, openingBalances: { OFFICE_CASH: "1.12345" } }, MONEY)).toMatchObject({ ok: false });
  });
  it("openingEquity إن ذُكر يجب أن يساوي مجموع النقديات — غير متوازن = رفض", () => {
    expect(parseOpeningFile({ ...base, openingEquity: "3500.5" }, MONEY)).toMatchObject({ ok: true });
    expect(parseOpeningFile({ ...base, openingEquity: "3500" }, MONEY)).toMatchObject({ ok: false, errors: [expect.stringContaining("غير متوازن")] });
    expect(parseOpeningFile({ ...base, openingEquity: 3500.5 }, MONEY)).toMatchObject({ ok: false });
  });
  it("مفاتيح مجهولة، تاريخ غير صالح، عملة غير صالحة، أنشطة/ربط/اعتماد بشكل خاطئ = رفض بأسباب واضحة", () => {
    const r = parseOpeningFile({ ...base, goLiveDate: "2026-02-30", currency: "egp", businesIds: [1], businessIds: [], safeGrants: { OFFICE_CASH: ["x"], FOO: [1] }, reconciliation: { reportGeneratedAt: "", approvedByEmployeeId: "1", approvedAt: "x", extra: 1 } }, MONEY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join("\n");
    for (const s of ["مفتاح غير معروف: businesIds", "goLiveDate", "currency", "businessIds", "safeGrants.OFFICE_CASH", "حساب مجهول في safeGrants: FOO", "reportGeneratedAt", "approvedByEmployeeId", "reconciliation: مفتاح غير معروف extra"]) expect(all).toContain(s);
  });
  it("اعتماد كامل + أنشطة + ربط يُقرأ كما هو مع إزالة التكرار", () => {
    const r = parseOpeningFile({ ...base, businessIds: [2, 1, 2], safeGrants: { OFFICE_CASH: [1, 1] }, reconciliation: { reportGeneratedAt: "2026-10-31T20:00:00Z", approvedByEmployeeId: 7, approvedAt: "2026-10-31T21:00:00Z", acknowledgedDifferences: true } }, MONEY);
    expect(r).toMatchObject({ ok: true, file: { businessIds: [2, 1], safeGrants: { OFFICE_CASH: [1] }, reconciliation: { approvedByEmployeeId: 7, acknowledgedDifferences: true } } });
  });
  it("عبارة التأكيد تتضمن tenantId وتاريخ Go-Live حرفيًا؛ التاريخ يُفحص فعليًا", () => {
    expect(confirmationPhrase(3, "2026-11-01")).toBe("ACTIVATE LEDGER V3 TENANT 3 GO-LIVE 2026-11-01");
    expect(isValidIsoDate("2026-11-31")).toBe(false);
    expect(isValidIsoDate("2026-11-30")).toBe(true);
    expect(isValidIsoDate(20261130)).toBe(false);
  });
});
