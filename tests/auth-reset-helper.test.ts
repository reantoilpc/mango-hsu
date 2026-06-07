// Pure-unit tests (no env): reset-token helpers in src/lib/auth.ts.
// sha256Hex must be deterministic + 64 hex chars; generateResetToken must yield
// a 64-hex-char opaque token whose hash differs from the plaintext.
import { describe, expect, it } from "bun:test";
import { sha256Hex, generateResetToken } from "../src/lib/auth";

describe("sha256Hex", () => {
  it("returns 64 lowercase hex chars", async () => {
    const h = await sha256Hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known SHA-256 of 'abc'", async () => {
    // Canonical SHA-256("abc") test vector.
    const h = await sha256Hex("abc");
    expect(h).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is deterministic (same input → same hash)", async () => {
    const a = await sha256Hex("the-same-token");
    const b = await sha256Hex("the-same-token");
    expect(a).toBe(b);
  });

  it("differs for different inputs", async () => {
    const a = await sha256Hex("token-a");
    const b = await sha256Hex("token-b");
    expect(a).not.toBe(b);
  });
});

describe("generateResetToken", () => {
  it("returns a 64-hex-char plaintext token and its sha256 hash", async () => {
    const { token, hash } = await generateResetToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/); // 32 random bytes → 64 hex
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // hash must be sha256Hex(token), NOT the token itself (we store the hash).
    expect(hash).not.toBe(token);
    expect(hash).toBe(await sha256Hex(token));
  });

  it("produces unique tokens across calls", async () => {
    const a = await generateResetToken();
    const b = await generateResetToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });
});
