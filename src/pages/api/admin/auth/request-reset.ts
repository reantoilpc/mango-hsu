import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { admin_users } from "../../../../db/schema";
import { env } from "../../../../lib/env";
import { requireSameOrigin } from "../../../../lib/csrf";
import { generateOtpCode, hmacResetCode } from "../../../../lib/auth";
import { checkResetRequestRate } from "../../../../lib/rate-limit";
import { sendTelegramMessage } from "../../../../lib/telegram";

// 6-digit OTP forgot-password request endpoint (Telegram channel). Replaces the V6 link flow.
//
// Auth model: NO session (the user forgot their password). Defenses:
//   1. requireSameOrigin() — block cross-site POSTs.
//   2. checkResetRequestRate() — 3/hour/email throttle.
//   3. Enumeration consistency — ALWAYS respond 200 {ok:true} whether the email exists or the
//      rate limit tripped. Signals go to audit_log only, never to the client.
//
// Code handling: generateOtpCode() makes a 6-digit code; we store hmacResetCode(secret,email,code)
// (never the plaintext), set a 10-min TTL, and reset reset_attempts to 0. The Telegram push is
// fire-and-forget and is NOT awaited on the response path (awaiting it would make "email exists"
// measurably slower and leak existence via timing).
const RESET_TTL_MS = 10 * 60_000;

async function audit(action: string, email: string, details: Record<string, unknown>): Promise<void> {
  await env.DB
    .prepare("INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, ?, ?)")
    .bind(new Date().toISOString(), email || "<unknown>", action, JSON.stringify(details))
    .run();
}

export const POST: APIRoute = async ({ request, locals }) => {
  if (!requireSameOrigin(request)) return text("csrf", 403);

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();

  const ok = () => json({ ok: true });

  if (!email) {
    await audit("password_reset_failed", "<unknown>", { reason: "missing_email" });
    return ok();
  }

  // Fail-safe: a missing RESET_OTP_SECRET makes hmacResetCode() throw on an empty HMAC key, which
  // would 500 the endpoint AND still burn a rate-limit slot per attempt (the throttle increments
  // before the throw) — silently breaking forgot-password with no code sent. Detect the misconfig,
  // audit it, and return the same enumeration-consistent 200 (no 500, no rate-limit burn, no send).
  if (!env.RESET_OTP_SECRET) {
    await audit("password_reset_misconfigured", email, { reason: "RESET_OTP_SECRET_unset" });
    return ok();
  }

  if (!(await checkResetRequestRate(env, email))) {
    await audit("password_reset_failed", email, { reason: "rate_limited" });
    return ok();
  }

  const db = makeDb(env);
  const rows = await db
    .select({ email: admin_users.email })
    .from(admin_users)
    .where(eq(admin_users.email, email))
    .limit(1);
  const user = rows[0];

  if (!user) {
    await audit("password_reset_failed", email, { reason: "unknown_email" });
    return ok();
  }

  const code = generateOtpCode();
  const hash = await hmacResetCode(env.RESET_OTP_SECRET, email, code);
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();

  await db
    .update(admin_users)
    .set({ reset_token: hash, reset_token_expires_at: expiresAt, reset_attempts: 0 })
    .where(eq(admin_users.email, email));

  await audit("password_reset_requested", email, { email });

  const msg = [
    "🔐 後台密碼重設",
    `帳號:${email}`,
    `驗證碼:${code}`,
    "10 分鐘內有效,最多輸入 5 次。",
    "若非你本人申請,請忽略本訊息並通知管理員。",
  ].join("\n");

  // Non-blocking but kept alive via waitUntil: a bare `void` fetch is cancelled when the worker
  // returns its response, so the code never actually sends (this is why no code arrived). waitUntil
  // completes the send WITHOUT awaiting it on the response path (no timing leak). Same pattern as
  // the order-notification path in orders.ts.
  locals.cfContext?.waitUntil(sendTelegramMessage(env, msg));

  return ok();
};
