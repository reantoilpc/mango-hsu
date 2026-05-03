import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { admin_users, sessions } from "../../../../db/schema";
import { env } from "../../../../lib/env";
import {
  hashPassword,
  verifyPassword,
  createSession,
  buildSessionCookie,
} from "../../../../lib/auth";

// Changes the caller's own password. Verifies current pw, then:
// 1. Updates password_hash + clears must_change_password
// 2. Deletes ALL sessions for this user (every device logs out)
// 3. Creates a fresh session for this device + sets cookie
// Reason for blowing away other sessions: if attacker grabbed the old pw,
// rotating here kicks them off everywhere.
export const POST: APIRoute = async ({ request, locals }) => {


  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);

  let body: { current_password?: string; new_password?: string };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }
  const current = String(body.current_password ?? "");
  const next = String(body.new_password ?? "");
  // 12-char min: NIST SP 800-63B 2024 floor without breach check; aligns with
  // /cso 2026-05-03 finding #8 (weak min length combined with no rate limit
  // produced a real brute-force vector before login throttle was added).
  if (next.length < 12) return text("new password too short (min 12)", 400);
  if (next.length > 200) return text("new password too long", 400);
  if (next === current) return text("new password must differ", 400);

  const db = makeDb(env);
  const userRows = await db
    .select({ password_hash: admin_users.password_hash })
    .from(admin_users)
    .where(eq(admin_users.email, auth.session.email))
    .limit(1);
  const user = userRows[0];
  if (!user) return text("user not found", 404);

  const ok = await verifyPassword(current, user.password_hash);
  if (!ok) {
    const ts = new Date().toISOString();
    await env.DB
      .prepare(
        "INSERT INTO audit_log (ts, user_email, action) VALUES (?, ?, 'password_change_fail')",
      )
      .bind(ts, auth.session.email)
      .run();
    return text("current password wrong", 401);
  }

  const newHash = await hashPassword(next);
  const now = new Date().toISOString();

  await db
    .update(admin_users)
    .set({ password_hash: newHash, must_change_password: false })
    .where(eq(admin_users.email, auth.session.email));

  await db.delete(sessions).where(eq(sessions.user_email, auth.session.email));

  const { token, expiresAt } = await createSession(db, auth.session.email);

  await env.DB
    .prepare(
      "INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, 'password_changed', ?)",
    )
    .bind(now, auth.session.email, JSON.stringify({ rotated: true }))
    .run();

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": buildSessionCookie(token, expiresAt),
    },
  });
};
