import { describe, it, expect, vi } from "vitest";
import { TRPCClientError } from "@trpc/client";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import {
  shouldRedirectToLogin,
  isExemptFromLoginRedirect,
  handleUnauthorizedRedirect,
} from "./authRedirect";

/**
 * Regression (BUG P3.3): صفحة /signup كانت بتتطرد لـ/login بعد ثوانٍ بسبب معالج 401 عام.
 * الضمان: /signup و/login معفيّان من التحويل حتى مع خطأ UNAUTHORIZED متأخّر.
 */
const unauthed = () => new TRPCClientError(UNAUTHED_ERR_MSG);

describe("🔑 shouldRedirectToLogin", () => {
  it("🔑 /signup و/login معفيّان (مايتطردوش) حتى مع UNAUTHORIZED", () => {
    expect(shouldRedirectToLogin(unauthed(), "/signup")).toBe(false);
    expect(shouldRedirectToLogin(unauthed(), "/login")).toBe(false);
  });
  it("🔑 مسارات الموظفين محفوظة (معفيّة)", () => {
    expect(shouldRedirectToLogin(unauthed(), "/employee-dashboard")).toBe(false);
    expect(shouldRedirectToLogin(unauthed(), "/accountant")).toBe(false);
  });
  it("🔑 المسارات المحمية تتحوّل عند UNAUTHORIZED", () => {
    expect(shouldRedirectToLogin(unauthed(), "/dashboard")).toBe(true);
    expect(shouldRedirectToLogin(unauthed(), "/orders")).toBe(true);
  });
  it("🔑 خطأ غير UNAUTHORIZED أو غير tRPC → لا تحويل", () => {
    expect(shouldRedirectToLogin(new TRPCClientError("other"), "/dashboard")).toBe(false);
    expect(shouldRedirectToLogin(new Error("boom"), "/dashboard")).toBe(false);
    expect(shouldRedirectToLogin(null, "/dashboard")).toBe(false);
  });
  it("🔑 isExemptFromLoginRedirect", () => {
    expect(isExemptFromLoginRedirect("/signup")).toBe(true);
    expect(isExemptFromLoginRedirect("/login")).toBe(true);
    expect(isExemptFromLoginRedirect("/dashboard")).toBe(false);
  });
});

describe("🔑 handleUnauthorizedRedirect: لا يُنفّذ تحويل على /signup", () => {
  it("🔑 /signup → redirect مش بيتنادى", () => {
    const redirect = vi.fn();
    handleUnauthorizedRedirect(unauthed(), { pathname: "/signup", redirect });
    expect(redirect).not.toHaveBeenCalled();
  });
  it("🔑 /dashboard → redirect بيتنادى بـ/login", () => {
    const redirect = vi.fn();
    handleUnauthorizedRedirect(unauthed(), { pathname: "/dashboard", redirect });
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
