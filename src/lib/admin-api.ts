import { eq } from "drizzle-orm";
import { makeDb, type AppEnv } from "../db/client";
import { sessions, admin_users } from "../db/schema";
import { SESSION_COOKIE } from "./auth";
import { requireSameOrigin } from "./csrf";

export type SessionInfo = { email: string; role: "admin" | "operator" };

export async function authorizeAdmin(
  request: Request,
  env: AppEnv,
  requireRole?: "admin" | "operator",
): Promise<{ ok: true; session: SessionInfo } | { ok: false; status: number; reason: string }> {
  if (request.method !== "GET" && !requireSameOrigin(request)) {
    return { ok: false, status: 403, reason: "csrf" };
  }
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  if (!match) return { ok: false, status: 401, reason: "no_session" };
  const token = match[1]!;

  const db = makeDb(env);
  const rows = await db
    .select({
      email: admin_users.email,
      role: admin_users.role,
      expires_at: sessions.expires_at,
    })
    .from(sessions)
    .innerJoin(admin_users, eq(admin_users.email, sessions.user_email))
    .where(eq(sessions.token, token))
    .limit(1);
  const row = rows[0];
  if (!row) return { ok: false, status: 401, reason: "invalid_session" };
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 401, reason: "expired" };
  }
  if (requireRole === "admin" && row.role !== "admin") {
    return { ok: false, status: 403, reason: "role" };
  }
  return { ok: true, session: { email: row.email, role: row.role } };
}

export const json = (
  body: Record<string, unknown> | { ok: boolean; [k: string]: unknown },
  status = 200,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain" } });
