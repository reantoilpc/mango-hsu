import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { admin_users, sessions } from "../../../../db/schema";
import { env } from "../../../../lib/env";
import { requireSameOrigin } from "../../../../lib/csrf";
import { hashPassword, sha256Hex } from "../../../../lib/auth";
import { sendTelegramMessage } from "../../../../lib/telegram";

// V6 §5.6 — forgot-password completion endpoint.
//
// Auth model: NO session required. Defenses = requireSameOrigin + possession of a valid,
// unexpired reset token (looked up by its sha256 hash). On success:
//   1. password_hash = pbkdf2(new password); must_change_password = false
//   2. reset_token + reset_token_expires_at cleared (link becomes single-use)
//   3. ALL sessions for the user deleted (kicks off any attacker holding the old password)
//   4. audit password_reset_success
// We do NOT mint a new session here (unlike change-password): the user wasn't logged in, so
// we send them to /admin/login to sign in with the new password (the client redirects).
//
// Password policy mirrors change-password.ts: 12-char min (NIST SP 800-63B floor), 200 max.

async function audit(action: string, email: string, details: Record<string, unknown>): Promise<void> {
  await env.DB
    .prepare("INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, ?, ?)")
    .bind(new Date().toISOString(), email || "<unknown>", action, JSON.stringify(details))
    .run();
}

export const POST: APIRoute = async ({ request }) => {
  if (!requireSameOrigin(request)) return text("csrf", 403);

  let body: { token?: string; new_password?: string };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }
  const token = String(body.token ?? "");
  const next = String(body.new_password ?? "");

  if (!token) {
    await audit("password_reset_failed", "<unknown>", { reason: "invalid_token" });
    return text("invalid or expired token", 400);
  }

  const db = makeDb(env);
  const tokenHash = await sha256Hex(token);

  // Look up the admin by the token HASH. (Plaintext token never stored.)
  const rows = await db
    .select({
      email: admin_users.email,
      reset_token_expires_at: admin_users.reset_token_expires_at,
    })
    .from(admin_users)
    .where(eq(admin_users.reset_token, tokenHash))
    .limit(1);
  const user = rows[0];

  if (!user) {
    await audit("password_reset_failed", "<unknown>", { reason: "invalid_token" });
    return text("invalid or expired token", 400);
  }

  // Expiry check.
  const exp = user.reset_token_expires_at;
  if (!exp || new Date(exp).getTime() < Date.now()) {
    await audit("password_reset_failed", user.email, { reason: "expired_token" });
    return text("invalid or expired token", 400);
  }

  // Password policy (mirror change-password.ts:34-38). Token is NOT consumed on a policy
  // failure so the user can retry the same link with a compliant password.
  if (next.length < 12) {
    await audit("password_reset_failed", user.email, { reason: "weak_password" });
    return text("new password too short (min 12)", 400);
  }
  if (next.length > 200) {
    await audit("password_reset_failed", user.email, { reason: "weak_password" });
    return text("new password too long", 400);
  }

  const newHash = await hashPassword(next);

  // Atomic-ish completion: update creds + clear token, then wipe sessions, then audit.
  // The UPDATE is guarded by `reset_token = tokenHash` so a concurrent second submit of the
  // same token (race) changes 0 rows on the loser (token already cleared) — see reuse test.
  const upd = await env.DB
    .prepare(
      "UPDATE admin_users SET password_hash = ?, must_change_password = 0, reset_token = NULL, reset_token_expires_at = NULL WHERE email = ? AND reset_token = ?",
    )
    .bind(newHash, user.email, tokenHash)
    .run();

  // FIX #11: verify a row actually changed before declaring success. In a concurrent
  // two-tab reset (same link, two different new passwords) the loser's token-guarded
  // UPDATE matches 0 rows; without this check it still returned ok:true and logged a
  // false "rotated" audit, so the user saw "success" yet couldn't log in with that password.
  if ((upd.meta?.changes ?? 0) === 0) {
    await audit("password_reset_failed", user.email, { reason: "token_consumed_race" });
    return text("invalid or expired token", 400);
  }

  await db.delete(sessions).where(eq(sessions.user_email, user.email));

  await audit("password_reset_success", user.email, { email: user.email, rotated: true });

  // FIX #12: the reset link goes to the SHARED store Telegram and the token alone
  // completes the reset, so an insider with chat access could silently take over an
  // admin account. Push a distinct alert so a takeover is visible to the owner.
  // Fire-and-forget (sendTelegramMessage swallows its own errors).
  void sendTelegramMessage(
    env,
    [
      "⚠️ 後台密碼已被重設",
      `帳號：${user.email}`,
      "若不是你本人操作，請立即聯絡管理員並重新申請重設。",
    ].join("\n"),
  );

  return json({ ok: true });
};
