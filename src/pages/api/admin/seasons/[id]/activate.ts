import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { makeDb } from "../../../../../db/client";
import { seasons } from "../../../../../db/schema";
import { env } from "../../../../../lib/env";

// V6 §5.1: atomically make a season the single active one.
//
// CRITICAL — partial unique index `seasons_active_singleton` (drizzle/0003:29)
// forbids two rows with status='active'. We therefore run, in ONE D1 batch:
//   1. UPDATE seasons SET status='archived' WHERE status='active' AND id != target
//   2. UPDATE seasons SET status='active'   WHERE id = target AND status != 'active'
//   3. INSERT audit_log season_activate
// Statement 1 demotes the previous active FIRST, so statement 2 never collides.
// D1 batch is all-or-nothing → no window with two actives, no torn state.
//
// Idempotent: activating an already-active season returns ok+already_active
// without touching anything (stmt 2's `status != 'active'` guard makes it a no-op,
// and we short-circuit before writing audit).
export const PATCH: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return text("bad id", 400);

  const db = makeDb(env);

  // Gate-first: read the target so we can 404 / detect already-active before writing.
  const rows = await db
    .select({ id: seasons.id, code: seasons.code, status: seasons.status })
    .from(seasons)
    .where(eq(seasons.id, id))
    .limit(1);
  const target = rows[0];
  if (!target) return text("not_found", 404);

  if (target.status === "active") {
    return json({ ok: true, already_active: true, id, code: target.code });
  }

  const now = new Date().toISOString();

  // Atomic switch in one batch. Order matters: demote the old active BEFORE
  // promoting the target, so the partial unique index never sees two actives.
  const result = await env.DB.batch([
    env.DB
      .prepare(
        "UPDATE seasons SET status = 'archived', ended_at = ? WHERE status = 'active' AND id != ?",
      )
      .bind(now, id),
    env.DB
      .prepare(
        "UPDATE seasons SET status = 'active' WHERE id = ? AND status != 'active'",
      )
      .bind(id),
    env.DB
      .prepare(
        "INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'season_activate', ?, ?)",
      )
      .bind(
        now,
        auth.session.email,
        id,
        JSON.stringify({ activated_id: id, code: target.code, from_status: target.status }),
      ),
  ]);

  const promoted = result[1]?.meta?.changes ?? 0;
  if (promoted === 0) {
    // The target wasn't promoted — most likely a concurrent request already
    // activated it between our SELECT and batch. Treat as success/idempotent.
    return json({ ok: true, already_active: true, id, code: target.code });
  }

  const demoted = result[0]?.meta?.changes ?? 0;
  return json({ ok: true, id, code: target.code, demoted_previous: demoted });
};
