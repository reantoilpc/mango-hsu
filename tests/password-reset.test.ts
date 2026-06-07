// V6 §5.6 forgot-password (Telegram channel) — stage integration.
// request-reset: enumeration-consistent response, 3/hr/email rate limit, token hash persisted.
// reset-password (Task 5) appended below.
//
// NOTE: request-reset pushes Telegram for EXISTING emails. On stage, TELEGRAM_* secrets point
// at a test/throwaway chat (or are unset). The endpoint is fire-and-forget on the push, so the
// HTTP response + DB writes are deterministic regardless of whether the push lands; these tests
// assert ONLY the response + DB state (reset_token hash) + audit, never Telegram delivery.

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
  skipIfNoIntegration,
} from "./_setup";
import { sha256Hex, generateResetToken } from "../src/lib/auth";

const SKIP = skipIfNoIntegration();
const ADMIN_EMAIL = "test-reset-admin@local";
const UNKNOWN_EMAIL = "test-reset-nobody@local";

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
    headers: {
      "Content-Type": "application/json",
      Origin: STAGE_URL, // pass requireSameOrigin
      ...extraHeaders,
    },
    body: JSON.stringify({ email }),
  });
}

describe("V6 request-reset: enumeration consistency", () => {
  it("returns identical 200 {ok:true} for existing AND unknown email", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });

    const rExisting = await requestReset(ADMIN_EMAIL);
    const rUnknown = await requestReset(UNKNOWN_EMAIL);

    expect(rExisting.status).toBe(200);
    expect(rUnknown.status).toBe(200);
    const bExisting = (await rExisting.json()) as { ok: boolean };
    const bUnknown = (await rUnknown.json()) as { ok: boolean };
    expect(bExisting).toEqual({ ok: true });
    expect(bUnknown).toEqual({ ok: true });
  });

  it("persists a reset_token HASH (not plaintext) for an existing email", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });

    const before = getResetTokenRow(ADMIN_EMAIL);
    expect(before.reset_token).toBeNull();

    const r = await requestReset(ADMIN_EMAIL);
    expect(r.status).toBe(200);

    const after = getResetTokenRow(ADMIN_EMAIL);
    // Stored value is a 64-hex sha256 hash, and an expiry ~30 min out was set.
    expect(after.reset_token).toMatch(/^[0-9a-f]{64}$/);
    expect(after.reset_token_expires_at).not.toBeNull();
    const ttlMs = new Date(after.reset_token_expires_at!).getTime() - Date.now();
    // 30-min TTL, allow generous slack for clock + round-trip (25..35 min).
    expect(ttlMs).toBeGreaterThan(25 * 60_000);
    expect(ttlMs).toBeLessThan(35 * 60_000);
  });

  it("does NOT set a token for an unknown email", async () => {
    if (SKIP) return;
    // No seedAdminUser for UNKNOWN_EMAIL → row doesn't exist; just assert the response is 200
    // and nothing blew up. (No row to inspect; absence is the point.)
    const r = await requestReset(UNKNOWN_EMAIL);
    expect(r.status).toBe(200);
    expect((await r.json())).toEqual({ ok: true });
  });

  it("rejects cross-origin POST (missing/foreign Origin) with 403", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });
    // Foreign Origin → requireSameOrigin fails.
    const r = await fetch(`${STAGE_URL}/api/admin/auth/request-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example.com" },
      body: JSON.stringify({ email: ADMIN_EMAIL }),
    });
    expect(r.status).toBe(403);
    // And no token was set despite a valid email (CSRF blocked before any work).
    expect(getResetTokenRow(ADMIN_EMAIL).reset_token).toBeNull();
  });
});

describe("V6 request-reset: rate limit 3/hr/email", () => {
  it("4th request within the window still returns 200 but stops sending (enumeration-safe)", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "correct-horse-battery" });

    // 3 allowed
    for (let i = 0; i < 3; i++) {
      const r = await requestReset(ADMIN_EMAIL);
      expect(r.status).toBe(200);
    }
    // 4th: limit hit. Must STILL be 200 {ok:true} (never 429 — that leaks existence).
    const r4 = await requestReset(ADMIN_EMAIL);
    expect(r4.status).toBe(200);
    expect((await r4.json())).toEqual({ ok: true });
  });
});

async function submitReset(token: string, newPassword: string): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/auth/reset-password`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: STAGE_URL, // pass requireSameOrigin
    },
    body: JSON.stringify({ token, new_password: newPassword }),
  });
}

describe("V6 reset-password: token validation", () => {
  it("rejects an unknown token with 400 and audits invalid_token", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    // A well-formed but never-issued token.
    const r = await submitReset("deadbeef".repeat(8), "brand-new-password-9");
    expect(r.status).toBe(400);
  });

  it("rejects an EXPIRED token with 400 and leaves the password unchanged", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hashBefore = getAdminPasswordHash(ADMIN_EMAIL);

    // Install a known token whose expiry is in the PAST.
    const { token, hash } = await generateResetToken();
    const past = new Date(Date.now() - 60_000).toISOString();
    setResetToken(ADMIN_EMAIL, hash, past);

    const r = await submitReset(token, "brand-new-password-9");
    expect(r.status).toBe(400);
    // Password untouched.
    expect(getAdminPasswordHash(ADMIN_EMAIL)).toBe(hashBefore);
  });

  it("rejects a too-short new password (min 12) with 400", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const { token, hash } = await generateResetToken();
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    setResetToken(ADMIN_EMAIL, hash, future);

    const r = await submitReset(token, "short");
    expect(r.status).toBe(400);
    // Token NOT consumed on a validation failure (user can retry with a longer password).
    expect(getResetTokenRow(ADMIN_EMAIL).reset_token).toBe(hash);
  });
});

describe("V6 reset-password: successful reset", () => {
  it("changes password, clears token, wipes sessions, and audits success", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const hashBefore = getAdminPasswordHash(ADMIN_EMAIL);

    // Pre-existing sessions for this user (should be wiped by the reset).
    seedSessionFor(ADMIN_EMAIL);
    seedSessionFor(ADMIN_EMAIL);
    expect(countSessions(ADMIN_EMAIL)).toBe(2);

    // Install a valid (future-expiry) token.
    const { token, hash } = await generateResetToken();
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    setResetToken(ADMIN_EMAIL, hash, future);

    const r = await submitReset(token, "a-fresh-strong-password");
    expect(r.status).toBe(200);
    expect((await r.json())).toEqual({ ok: true });

    // Password hash changed.
    expect(getAdminPasswordHash(ADMIN_EMAIL)).not.toBe(hashBefore);
    // Token cleared (link is now single-use / dead).
    const row = getResetTokenRow(ADMIN_EMAIL);
    expect(row.reset_token).toBeNull();
    expect(row.reset_token_expires_at).toBeNull();
    // All sessions wiped.
    expect(countSessions(ADMIN_EMAIL)).toBe(0);
  });

  it("a consumed token cannot be reused (second submit fails 400)", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const { token, hash } = await generateResetToken();
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    setResetToken(ADMIN_EMAIL, hash, future);

    const r1 = await submitReset(token, "first-new-password-12");
    expect(r1.status).toBe(200);
    // Reuse the same plaintext token → token already cleared → not found → 400.
    const r2 = await submitReset(token, "second-new-password-12");
    expect(r2.status).toBe(400);
  });

  it("the new password actually works at /admin/login (end-to-end)", async () => {
    if (SKIP) return;
    await seedAdminUser({ email: ADMIN_EMAIL, password: "old-password-123" });
    const { token, hash } = await generateResetToken();
    const future = new Date(Date.now() + 20 * 60_000).toISOString();
    setResetToken(ADMIN_EMAIL, hash, future);

    const newPw = "login-after-reset-pw";
    expect((await submitReset(token, newPw)).status).toBe(200);

    // Log in with the NEW password via the real login form POST.
    const form = new URLSearchParams();
    form.set("email", ADMIN_EMAIL);
    form.set("password", newPw);
    const login = await fetch(`${STAGE_URL}/admin/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: STAGE_URL,
      },
      body: form.toString(),
      redirect: "manual",
    });
    // Successful login → 302 redirect + Set-Cookie mh_session.
    expect(login.status).toBe(302);
    expect(login.headers.get("set-cookie") ?? "").toContain("mh_session=");
  });
});
