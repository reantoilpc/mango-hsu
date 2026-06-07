import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { admin_users } from "../../../../db/schema";
import { env } from "../../../../lib/env";
import { requireSameOrigin } from "../../../../lib/csrf";
import { generateResetToken } from "../../../../lib/auth";
import { checkResetRequestRate } from "../../../../lib/rate-limit";
import { sendTelegramMessage } from "../../../../lib/telegram";

// V6 §5.6 — forgot-password request endpoint (Telegram channel).
//
// Auth model: NO session required (the user forgot their password). Defenses are:
//   1. requireSameOrigin() — block cross-site POSTs.
//   2. checkResetRequestRate() — 3/hour/email throttle.
//   3. Enumeration consistency — ALWAYS respond 200 {ok:true}, whether or not the email exists
//      or the rate limit tripped. Existence/rate-limit signals go to audit_log only, never to
//      the client (and never as a 429, which would itself leak existence).
//
// Token handling: generateResetToken() returns plaintext (→ Telegram link only) + sha256 hash
// (→ stored in admin_users.reset_token). TTL 30 min. The Telegram push is fire-and-forget and
// is NOT awaited on the response path (awaiting it would make "email exists" measurably slower
// and leak existence via timing).
const RESET_TTL_MS = 30 * 60_000;

async function audit(action: string, email: string, details: Record<string, unknown>): Promise<void> {
  await env.DB
    .prepare("INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, ?, ?)")
    .bind(new Date().toISOString(), email || "<unknown>", action, JSON.stringify(details))
    .run();
}

export const POST: APIRoute = async ({ request }) => {
  if (!requireSameOrigin(request)) return text("csrf", 403);

  let body: { email?: string };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }
  const email = String(body.email ?? "").trim().toLowerCase();

  // Generic success response reused on every branch below (enumeration consistency).
  const ok = () => json({ ok: true });

  if (!email) {
    await audit("password_reset_failed", "<unknown>", { reason: "missing_email" });
    return ok();
  }

  // Rate limit (per-email). Limit hit → still 200, but don't touch DB or Telegram.
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
    // Unknown email: audit (so the owner can notice probing) but respond identically.
    await audit("password_reset_failed", email, { reason: "unknown_email" });
    return ok();
  }

  // Existing email: mint token, store HASH + 30-min expiry, push link to Telegram.
  const { token, hash } = await generateResetToken();
  const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();

  await db
    .update(admin_users)
    .set({ reset_token: hash, reset_token_expires_at: expiresAt })
    .where(eq(admin_users.email, email));

  await audit("password_reset_requested", email, { email });

  // Build absolute reset link from the request origin (same pattern as mark-shipped.ts:84).
  const origin = new URL(request.url).origin;
  const link = `${origin}/admin/reset-password?token=${token}`;
  const msg = [
    "🔐 後台密碼重設",
    `帳號：${email}`,
    `重設連結（30 分鐘內有效，僅本人可用）：`,
    link,
    "若非你本人申請，請忽略本訊息並通知管理員。",
  ].join("\n");

  // Fire-and-forget: do NOT await on the response path (timing-leak guard). Swallow the promise;
  // sendTelegramMessage already catches its own errors and returns false.
  void sendTelegramMessage(env, msg);

  return ok();
};
