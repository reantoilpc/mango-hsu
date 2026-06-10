import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { admin_users, sessions } from "../../../../db/schema";
import { env } from "../../../../lib/env";
import { requireSameOrigin } from "../../../../lib/csrf";
import { hashPassword, hmacResetCode, timingSafeEqualHex } from "../../../../lib/auth";
import { checkResetVerifyRate } from "../../../../lib/rate-limit";
import { sendTelegramMessage } from "../../../../lib/telegram";

// 6-digit OTP forgot-password completion endpoint. Replaces the V6 link flow.
//
// Auth model: NO session. Defenses = requireSameOrigin + per-IP verify throttle + possession of a
// valid, unexpired, not-attempt-exhausted code (matched by HMAC against the stored value). On
// success: rotate password, clear reset_token/expiry/attempts (single-use), wipe ALL sessions,
// audit, and push a takeover alert. We do NOT mint a session (the user wasn't logged in).
//
// Password policy mirrors change-password.ts: 12-char min, 200 max.

const MAX_ATTEMPTS = 5;
// Generic message reused for unknown email / no code / expired / exhausted / throttle — never
// distinguishes these states to the client (enumeration + brute-force signal safety).
const GENERIC_ERR = "驗證碼錯誤或已過期,請重新發送";

async function audit(action: string, email: string, details: Record<string, unknown>): Promise<void> {
  await env.DB
    .prepare("INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, ?, ?)")
    .bind(new Date().toISOString(), email || "<unknown>", action, JSON.stringify(details))
    .run();
}

export const POST: APIRoute = async ({ request, clientAddress, locals }) => {
  if (!requireSameOrigin(request)) return text("csrf", 403);

  const ip = request.headers.get("cf-connecting-ip") || clientAddress || "unknown";
  if (!(await checkResetVerifyRate(env, ip))) {
    // Same generic 400 as a bad code — never 429 (a distinct status would itself be a signal).
    return text(GENERIC_ERR, 400);
  }

  let body: { email?: string; code?: string; new_password?: string };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  const code = String(body.code ?? "").trim();
  const next = String(body.new_password ?? "");

  // Fail-safe: a missing RESET_OTP_SECRET makes hmacResetCode() throw on an empty key → 500.
  // Return the same generic error instead (audit the misconfig for the owner).
  if (!env.RESET_OTP_SECRET) {
    await audit("password_reset_misconfigured", email, { reason: "RESET_OTP_SECRET_unset" });
    return text(GENERIC_ERR, 400);
  }

  const db = makeDb(env);
  const rows = await db
    .select({
      email: admin_users.email,
      reset_token: admin_users.reset_token,
      reset_token_expires_at: admin_users.reset_token_expires_at,
      reset_attempts: admin_users.reset_attempts,
    })
    .from(admin_users)
    .where(eq(admin_users.email, email))
    .limit(1);
  const user = rows[0];

  // Always compute a candidate HMAC (dummy inputs when the row/code is missing) so the response
  // time doesn't reveal whether the email exists.
  const candidate = await hmacResetCode(env.RESET_OTP_SECRET, email || "<none>", code || "<none>");

  if (!user || !user.reset_token || !user.reset_token_expires_at) {
    await audit("password_reset_failed", email, { reason: "no_active_code" });
    return text(GENERIC_ERR, 400);
  }

  const expired = new Date(user.reset_token_expires_at).getTime() < Date.now();
  if (expired || user.reset_attempts >= MAX_ATTEMPTS) {
    // Invalidate the dead/exhausted code so the row is clean for the next request.
    await env.DB
      .prepare("UPDATE admin_users SET reset_token = NULL, reset_token_expires_at = NULL WHERE email = ?")
      .bind(user.email)
      .run();
    await audit("password_reset_failed", user.email, {
      reason: expired ? "expired" : "attempts_exhausted",
    });
    return text(GENERIC_ERR, 400);
  }

  if (!timingSafeEqualHex(candidate, user.reset_token)) {
    const attempts = user.reset_attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      // Final wrong try: increment AND invalidate the code in one statement.
      await env.DB
        .prepare(
          "UPDATE admin_users SET reset_attempts = reset_attempts + 1, reset_token = NULL, reset_token_expires_at = NULL WHERE email = ?",
        )
        .bind(user.email)
        .run();
    } else {
      await env.DB
        .prepare("UPDATE admin_users SET reset_attempts = reset_attempts + 1 WHERE email = ? AND reset_token IS NOT NULL")
        .bind(user.email)
        .run();
    }
    await audit("password_reset_failed", user.email, { reason: "bad_code", attempts });
    const remaining = Math.max(MAX_ATTEMPTS - attempts, 0);
    return text(`驗證碼錯誤,還剩 ${remaining} 次`, 400);
  }

  // Code correct → password policy. Do NOT consume the code on a policy failure (let the user fix
  // the password and retry the same code).
  if (next.length < 12) {
    await audit("password_reset_failed", user.email, { reason: "weak_password" });
    return text("new password too short (min 12)", 400);
  }
  if (next.length > 200) {
    await audit("password_reset_failed", user.email, { reason: "weak_password" });
    return text("new password too long", 400);
  }

  const newHash = await hashPassword(next);

  // Race-guarded completion: guard on reset_token so a concurrent second submit of the same code
  // changes 0 rows on the loser (token already cleared) — see FIX #11 lineage.
  const done = await env.DB
    .prepare(
      "UPDATE admin_users SET password_hash = ?, must_change_password = 0, reset_token = NULL, reset_token_expires_at = NULL, reset_attempts = 0 WHERE email = ? AND reset_token = ?",
    )
    .bind(newHash, user.email, user.reset_token)
    .run();

  if ((done.meta?.changes ?? 0) === 0) {
    await audit("password_reset_failed", user.email, { reason: "token_consumed_race" });
    return text(GENERIC_ERR, 400);
  }

  await db.delete(sessions).where(eq(sessions.user_email, user.email));
  await audit("password_reset_success", user.email, { email: user.email, rotated: true });

  // Takeover alert — kept alive via waitUntil (a bare `void` fetch is cancelled when the worker
  // returns, so the alert would never send). Non-blocking; sendTelegramMessage swallows its errors.
  locals.cfContext?.waitUntil(
    sendTelegramMessage(
      env,
      ["⚠️ 後台密碼已被重設", `帳號:${user.email}`, "若不是你本人操作,請立即聯絡管理員並重新申請重設。"].join("\n"),
    ),
  );

  return json({ ok: true });
};
