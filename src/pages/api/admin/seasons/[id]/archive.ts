import type { APIRoute } from "astro";
import { and, eq, isNull, sql } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { makeDb } from "../../../../../db/client";
import { seasons, orders } from "../../../../../db/schema";
import { env } from "../../../../../lib/env";

// V6 §5.1: archive a season (active|draft → archived).
//
// Safety gate: refuse to archive while the season still has UNSHIPPED, NON-CANCELLED
// orders (shipped = 0 AND cancelled_at IS NULL) — archiving would orphan work the shop
// still owes the customer. Caller can override with { force: true } once they've
// confirmed (the UI surfaces the count + a confirm dialog).
//
// audit: season_archive (details record the unshipped_count seen + whether forced).
export const PATCH: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return text("bad id", 400);

  let body: { force?: boolean } = {};
  try {
    const raw = await request.text();
    if (raw.trim()) body = JSON.parse(raw);
  } catch {
    return text("bad json", 400);
  }
  const force = body.force === true;

  const db = makeDb(env);

  const rows = await db
    .select({ id: seasons.id, code: seasons.code, status: seasons.status })
    .from(seasons)
    .where(eq(seasons.id, id))
    .limit(1);
  const target = rows[0];
  if (!target) return text("not_found", 404);

  if (target.status === "archived") {
    return json({ ok: true, already_archived: true, id, code: target.code });
  }

  // Count unshipped, non-cancelled orders tied to this season.
  const countRows = await db
    .select({ n: sql<number>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.season_id, id),
        eq(orders.shipped, false),
        isNull(orders.cancelled_at),
      ),
    );
  const unshippedCount = countRows[0]?.n ?? 0;

  if (unshippedCount > 0 && !force) {
    return json(
      {
        ok: false,
        error_code: "UNSHIPPED_ORDERS",
        unshipped_count: unshippedCount,
        message: "此季仍有未出貨訂單；確認後可加 force 強制封存",
      },
      409,
    );
  }

  const now = new Date().toISOString();

  const result = await env.DB.batch([
    env.DB
      .prepare(
        "UPDATE seasons SET status = 'archived', ended_at = ? WHERE id = ? AND status != 'archived'",
      )
      .bind(now, id),
    env.DB
      .prepare(
        "INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'season_archive', ?, ?)",
      )
      .bind(
        now,
        auth.session.email,
        id,
        JSON.stringify({
          archived_id: id,
          code: target.code,
          from_status: target.status,
          unshipped_count: unshippedCount,
          forced: force,
        }),
      ),
  ]);

  const archived = result[0]?.meta?.changes ?? 0;
  if (archived === 0) {
    // Raced — someone archived it between our SELECT and batch.
    return json({ ok: true, already_archived: true, id, code: target.code });
  }

  return json({ ok: true, id, code: target.code, unshipped_count: unshippedCount, forced: force });
};
