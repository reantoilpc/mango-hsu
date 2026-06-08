// Unit tests for the 6-digit OTP reset helpers. Pure — no stage env required.
import { describe, expect, it } from "bun:test";
import { generateOtpCode, hmacResetCode, timingSafeEqualHex } from "../src/lib/auth";

describe("generateOtpCode", () => {
  it("returns a 6-digit numeric string", () => {
    for (let i = 0; i < 2000; i++) {
      expect(generateOtpCode()).toMatch(/^[0-9]{6}$/);
    }
  });

  it("is not constant (covers a wide range)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i++) seen.add(generateOtpCode());
    expect(seen.size).toBeGreaterThan(200);
  });
});

describe("hmacResetCode", () => {
  const secret = "test-secret-please-ignore-0123456789";

  it("is deterministic and returns 64-hex", async () => {
    const a = await hmacResetCode(secret, "a@local", "123456");
    const b = await hmacResetCode(secret, "a@local", "123456");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is bound to the email (same code, different email → different mac)", async () => {
    const a = await hmacResetCode(secret, "a@local", "123456");
    const b = await hmacResetCode(secret, "b@local", "123456");
    expect(a).not.toBe(b);
  });

  it("changes when the code changes", async () => {
    const a = await hmacResetCode(secret, "a@local", "123456");
    const b = await hmacResetCode(secret, "a@local", "654321");
    expect(a).not.toBe(b);
  });

  it("changes when the secret changes", async () => {
    const a = await hmacResetCode(secret, "a@local", "123456");
    const b = await hmacResetCode("a-different-secret-value", "a@local", "123456");
    expect(a).not.toBe(b);
  });

  it("normalizes email case and whitespace", async () => {
    const a = await hmacResetCode(secret, "  A@Local  ", "123456");
    const b = await hmacResetCode(secret, "a@local", "123456");
    expect(a).toBe(b);
  });
});

describe("timingSafeEqualHex", () => {
  it("true for equal strings", () => expect(timingSafeEqualHex("abcd", "abcd")).toBe(true));
  it("false for different same-length strings", () => expect(timingSafeEqualHex("abcd", "abce")).toBe(false));
  it("false for different lengths", () => expect(timingSafeEqualHex("ab", "abcd")).toBe(false));
});
