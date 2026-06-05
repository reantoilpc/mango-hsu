import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { seasons } from "../../../../db/schema";
import { env } from "../../../../lib/env";

// V6 §5.1: create a new season in `draft` status.
// Required: code (matches /^[A-Za-z0-9_-]{1,20}$/, globally unique).
// Required: name (1-50 chars).
// Optional: starts_at (UTC ISO string, stored as-is).
//
// Does NOT activate. Activation is a separate atomic transition (activate.ts).
// audit: season_create.
export const POST: APIRoute = async ({ request }) => {
  // authorizeAdmin runs requireSameOrigin internally for non-GET (CSRF 2nd line).
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  let body: {
    code?: string;
    name?: string;
    starts_at?: string;
  };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }

  const code = (body.code ?? "").trim();
  const name = (body.name ?? "").trim();
  const startsAt =
    typeof body.starts_at === "string" && body.starts_at.trim().length > 0
      ? body.starts_at.trim()
      : null;

  if (!code || !/^[A-Za-z0-9_-]{1,20}$/.test(code)) {
    return text("bad code (1-20 chars, [A-Za-z0-9_-])", 400);
  }
  if (!name || name.length > 50) return text("bad name (1-50 chars)", 400);
  if (startsAt !== null && (startsAt.length > 40 || Number.isNaN(Date.parse(startsAt)))) {
    return text("bad starts_at (UTC ISO-8601)", 400);
  }

  const db = makeDb(env);

  // Pre-check duplicate code → clean 409 (UNIQUE index would also catch it, but
  // we want a typed error_code, not a raw constraint exception).
  const dup = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.code, code))
    .limit(1);
  if (dup.length > 0) {
    return json({ ok: false, error_code: "CODE_EXISTS", code }, 409);
  }

  const now = new Date().toISOString();

  const result = await env.DB.batch([
    env.DB
      .prepare(
        "INSERT INTO seasons (code, name, status, starts_at, created_at) VALUES (?, ?, 'draft', ?, ?)",
      )
      .bind(code, name, startsAt, now),
    env.DB
      .prepare(
        // season_id is backfilled below via a correlated subquery so the audit
        // row carries the new season's id without a round-trip.
        "INSERT INTO audit_log (ts, user_email, action, season_id, details) " +
          "VALUES (?, ?, 'season_create', (SELECT id FROM seasons WHERE code = ?), ?)",
      )
      .bind(
        now,
        auth.session.email,
        code,
        JSON.stringify({ code, name, starts_at: startsAt }),
      ),
  ]);

  const inserted = result[0]?.meta?.changes ?? 0;
  if (inserted === 0) {
    // Extremely unlikely (we pre-checked dup) — concurrent insert raced us.
    return json({ ok: false, error_code: "CODE_EXISTS", code }, 409);
  }

  // Resolve the new id for the response.
  const row = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.code, code))
    .limit(1);

  return json({ ok: true, id: row[0]?.id ?? null, code, status: "draft" });
};
