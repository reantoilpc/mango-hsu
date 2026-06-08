// 6-digit OTP forgot-password — stage integration.
//
// request-reset: enumeration-consistent response, 3/hr/email rate limit, HMAC persisted, 10-min TTL.
// reset-password: per-IP throttle, attempt cap, HMAC verify, single-use, session wipe.
//
// NOTE: request-reset pushes Telegram for existing emails. On stage the TELEGRAM_* secrets point at
// a throwaway chat (or are unset). The push is fire-and-forget, so the HTTP response + DB writes are
// deterministic regardless of delivery; these tests assert ONLY response + DB state + audit.
//
// Reset-submit cases inject a known code's HMAC via setResetToken, so they require
// TEST_RESET_OTP_SECRET === stage RESET_OTP_SECRET (skipIfNoResetSecret()).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  clearResetRateLimit,
  getResetTokenRow,
  getAdminPasswordHash,
  countSessions,
  seedSessionFor,
  setResetToken,
  seedAdminUser,
  resetCodeHmac,
  skipIfNoIntegration,
  skipIfNoResetSecret,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const SKIP_SECRET = skipIfNoResetSecret();
const ADMIN_EMAIL = "test-reset-admin@local";
const UNKNOWN_EMAIL = "test-reset-nobody@local";
const GOOD_CODE = "246802";
const WRONG_CODE = "000000";

beforeEach(async () => {
  if (SKIP) return;
  cleanupTestAdmin();
  cleanupTestData();
  clearResetRateLimit();
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestAdmin();
  cleanupTestData();
  clearResetRateLimit();
});

async function requestReset(email: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/auth/request-reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: STAGE_URL, ...extraHeaders },
    body: JSON.stringify({ email }),
  });
}

async function submitReset(email: string, code: string, newPassword: string): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: STAGE_URL },
    body: JSON.stringify({ email, code, new_password: newPassword }),
  });
}

describe("OTP request-reset: enumeration consistency + persistence", () => {
  it("returns identical 200 {ok:true} for existing AND unknown email", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });
    const rExisting = await requestReset(ADMIN_EMAIL);
    const rUnknown = await requestReset(UNKNOWN_EMAIL);
    expect(rExisting.status).toBe(200);
    expect(rUnknown.status).toBe(200);
    expect(await rExisting.json()).toEqual({ ok: true });
    expect(await rUnknown.json()).toEqual({ ok: true });
  });

  it("persists an HMAC (64-hex, not plaintext), a ~10-min expiry, and resets attempts to 0", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });
    // Pre-dirty the attempt counter to prove request-reset resets it.
    setResetToken(ADMIN_EMAIL, "deadbeef".repeat(8), new Date(Date.now() + 60_000).toISOString(), 3);

    const r = await requestReset(ADMIN_EMAIL);
    expect(r.status).toBe(200);

    const after = getResetTokenRow(ADMIN_EMAIL);
    expect(after.reset_token).toMatch(/^[0-9a-f]{64}$/);
    expect(after.reset_attempts).toBe(0);
    expect(after.reset_token_expires_at).not.toBeNull();
    const ttlMs = new Date(after.reset_token_expires_at!).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(5 * 60_000);
    expect(ttlMs).toBeLessThan(15 * 60_000);
  });

  it("rejects cross-origin POST with 403 and sets no code", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });
    const r = await fetch(`${STAGE_URL}/api/admin/auth/request-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
      body: JSON.stringify({ email: ADMIN_EMAIL }),
    });
    expect(r.status).toBe(403);
    expect(getResetTokenRow(ADMIN_EMAIL).reset_token).toBeNull();
  });

  it("4th request within the window still returns 200 (never 429 — enumeration-safe)", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });
    for (let i = 0; i < 3; i++) expect((await requestReset(ADMIN_EMAIL)).status).toBe(200);
    const r4 = await requestReset(ADMIN_EMAIL);
    expect(r4.status).toBe(200);
    expect(await r4.json()).toEqual({ ok: true });
  });
});

describe("OTP reset-password: validation", () => {
  it("rejects when there is no active code (400)", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const r = await submitReset(ADMIN_EMAIL, GOOD_CODE, "brand-new-password-9");
    expect(r.status).toBe(400);
  });

  it("rejects an EXPIRED code and leaves the password unchanged", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hashBefore = getAdminPasswordHash(ADMIN_EMAIL);
    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() - 60_000).toISOString(), 0);

    const r = await submitReset(ADMIN_EMAIL, GOOD_CODE, "brand-new-password-9");
    expect(r.status).toBe(400);
    expect(getAdminPasswordHash(ADMIN_EMAIL)).toBe(hashBefore);
  });

  it("rejects a too-short new password (correct code, 400) WITHOUT consuming the code", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() + 8 * 60_000).toISOString(), 0);

    const r = await submitReset(ADMIN_EMAIL, GOOD_CODE, "short");
    expect(r.status).toBe(400);
    expect(getResetTokenRow(ADMIN_EMAIL).reset_token).toBe(hmac);
  });

  it("invalidates the code after 5 wrong attempts (correct code then fails)", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() + 8 * 60_000).toISOString(), 0);

    for (let i = 0; i < 5; i++) {
      expect((await submitReset(ADMIN_EMAIL, WRONG_CODE, "a-fresh-strong-password")).status).toBe(400);
    }
    // Code now cleared; even the correct code fails.
    expect(getResetTokenRow(ADMIN_EMAIL).reset_token).toBeNull();
    expect((await submitReset(ADMIN_EMAIL, GOOD_CODE, "a-fresh-strong-password")).status).toBe(400);
  });
});

describe("OTP reset-password: successful reset", () => {
  it("changes password, clears code+attempts, wipes sessions", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hashBefore = getAdminPasswordHash(ADMIN_EMAIL);
    seedSessionFor(ADMIN_EMAIL);
    seedSessionFor(ADMIN_EMAIL);
    expect(countSessions(ADMIN_EMAIL)).toBe(2);

    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() + 8 * 60_000).toISOString(), 0);

    const r = await submitReset(ADMIN_EMAIL, GOOD_CODE, "a-fresh-strong-password");
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });

    expect(getAdminPasswordHash(ADMIN_EMAIL)).not.toBe(hashBefore);
    const row = getResetTokenRow(ADMIN_EMAIL);
    expect(row.reset_token).toBeNull();
    expect(row.reset_token_expires_at).toBeNull();
    expect(row.reset_attempts).toBe(0);
    expect(countSessions(ADMIN_EMAIL)).toBe(0);
  });

  it("a consumed code cannot be reused (second submit fails 400)", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() + 8 * 60_000).toISOString(), 0);

    expect((await submitReset(ADMIN_EMAIL, GOOD_CODE, "first-new-password-12")).status).toBe(200);
    expect((await submitReset(ADMIN_EMAIL, GOOD_CODE, "second-new-password-12")).status).toBe(400);
  });

  it("the new password works at /admin/login (end-to-end)", async () => {
    if (SKIP_SECRET) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hmac = await resetCodeHmac(ADMIN_EMAIL, GOOD_CODE);
    setResetToken(ADMIN_EMAIL, hmac, new Date(Date.now() + 8 * 60_000).toISOString(), 0);

    const newPw = "login-after-reset-pw";
    expect((await submitReset(ADMIN_EMAIL, GOOD_CODE, newPw)).status).toBe(200);

    const form = new URLSearchParams();
    form.set("email", ADMIN_EMAIL);
    form.set("password", newPw);
    const login = await fetch(`${STAGE_URL}/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: STAGE_URL },
      body: form.toString(),
      redirect: "manual",
    });
    expect(login.status).toBe(302);
    expect(login.headers.get("set-cookie") ?? "").toContain("mh_session=");
  });
});
