import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const mockGetEmployeeByUsernameOrEmail = vi.fn();

vi.mock("./db", () => ({
  getEmployeeByUsernameOrEmail: (...args: any[]) => mockGetEmployeeByUsernameOrEmail(...args),
}));

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-local-auth";

const { verifyOwnerLogin } = await import("./localAuth");

const activeManager = {
  id: 1,
  name: "Owner",
  username: "owner",
  email: "owner@example.com",
  role: "manager" as const,
  isActive: true,
  passwordHash: await bcrypt.hash("correct-password", 10),
};

describe("verifyOwnerLogin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("succeeds with the correct username and password", async () => {
    mockGetEmployeeByUsernameOrEmail.mockResolvedValue(activeManager);

    const result = await verifyOwnerLogin("owner", "correct-password");

    expect(result.status).toBe(200);
    if (result.status === 200) {
      expect(result.body.success).toBe(true);
      expect(result.body.user).toEqual({
        id: 1,
        name: "Owner",
        username: "owner",
        email: "owner@example.com",
        role: "manager",
      });
      expect(typeof result.token).toBe("string");
      expect(result.token.length).toBeGreaterThan(0);
    }
  });

  it("succeeds when logging in with the email instead of username", async () => {
    mockGetEmployeeByUsernameOrEmail.mockResolvedValue(activeManager);

    const result = await verifyOwnerLogin("owner@example.com", "correct-password");

    expect(result.status).toBe(200);
    expect(mockGetEmployeeByUsernameOrEmail).toHaveBeenCalledWith("owner@example.com");
  });

  it("rejects a wrong password", async () => {
    mockGetEmployeeByUsernameOrEmail.mockResolvedValue(activeManager);

    const result = await verifyOwnerLogin("owner", "wrong-password");

    expect(result.status).toBe(401);
    expect(result.body.success).toBe(false);
  });

  it("rejects an unknown username/email", async () => {
    mockGetEmployeeByUsernameOrEmail.mockResolvedValue(undefined);

    const result = await verifyOwnerLogin("nobody", "whatever");

    expect(result.status).toBe(401);
    expect(result.body.success).toBe(false);
  });

  it("rejects an inactive account even with the correct password", async () => {
    mockGetEmployeeByUsernameOrEmail.mockResolvedValue({ ...activeManager, isActive: false });

    const result = await verifyOwnerLogin("owner", "correct-password");

    expect(result.status).toBe(403);
    expect(result.body.success).toBe(false);
  });

  it("rejects a non-manager employee (agent/warehouse/etc.) even with the correct password", async () => {
    mockGetEmployeeByUsernameOrEmail.mockResolvedValue({ ...activeManager, role: "agent" });

    const result = await verifyOwnerLogin("owner", "correct-password");

    expect(result.status).toBe(403);
    expect(result.body.success).toBe(false);
  });

  it("rejects when the account has no password set yet", async () => {
    mockGetEmployeeByUsernameOrEmail.mockResolvedValue({ ...activeManager, passwordHash: null });

    const result = await verifyOwnerLogin("owner", "anything");

    expect(result.status).toBe(401);
  });

  it("rejects missing username or password with a 400", async () => {
    const result = await verifyOwnerLogin("", "");
    expect(result.status).toBe(400);
    expect(mockGetEmployeeByUsernameOrEmail).not.toHaveBeenCalled();
  });

  it("never includes passwordHash in the response body, on success or failure", async () => {
    mockGetEmployeeByUsernameOrEmail.mockResolvedValue(activeManager);

    const success = await verifyOwnerLogin("owner", "correct-password");
    expect(JSON.stringify(success.body)).not.toContain("passwordHash");
    expect(JSON.stringify(success.body)).not.toContain(activeManager.passwordHash);

    const failure = await verifyOwnerLogin("owner", "wrong-password");
    expect(JSON.stringify(failure.body)).not.toContain("passwordHash");
  });
});
