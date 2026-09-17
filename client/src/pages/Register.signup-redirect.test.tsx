// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { TRPCClientError } from "@trpc/client";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import Register from "./Register";
import { handleUnauthorizedRedirect } from "@/_core/authRedirect";

/**
 * Regression (BUG P3.3): mount /signup، اكتب في النموذج، ثم حاكِ خطأ UNAUTHORIZED متأخّر
 * (زي اللي كان بيطرد المستخدم). المطلوب: المسار يفضل /signup (مفيش تحويل) وقيم النموذج ما تتغيّرش.
 */
afterEach(() => cleanup());

describe("🔑 /signup ما بيتطردش بخطأ auth متأخّر", () => {
  it("🔑 بعد UNAUTHORIZED متأخّر: مفيش تحويل + قيم النموذج ثابتة", async () => {
    render(<Register />);

    const owner = screen.getByPlaceholderText("الاسم الكامل") as HTMLInputElement;
    const email = screen.getByPlaceholderText("you@example.com") as HTMLInputElement;
    fireEvent.change(owner, { target: { value: "أحمد" } });
    fireEvent.change(email, { target: { value: "a@b.com" } });
    expect(owner.value).toBe("أحمد");
    expect(email.value).toBe("a@b.com");

    // محاكاة خطأ UNAUTHORIZED متأخّر يمرّ عبر نفس معالج التحويل العام، والمسار /signup.
    const redirect = vi.fn();
    await new Promise(r => setTimeout(r, 20)); // "delayed" resolution
    handleUnauthorizedRedirect(new TRPCClientError(UNAUTHED_ERR_MSG), { pathname: "/signup", redirect });

    // مفيش تحويل، والنموذج لسه شغّال بنفس القيم (المكوّن ما اتفكّش).
    expect(redirect).not.toHaveBeenCalled();
    expect((screen.getByPlaceholderText("الاسم الكامل") as HTMLInputElement).value).toBe("أحمد");
    expect((screen.getByPlaceholderText("you@example.com") as HTMLInputElement).value).toBe("a@b.com");
  });
});
