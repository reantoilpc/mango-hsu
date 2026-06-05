import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { product_groups, seasons } from "../../../../db/schema";
import { env } from "../../../../lib/env";

// V6 P6 (spec §5.2): create a product_group within the active season.
//
// Contract:
//   - slug: required, /^[a-z0-9-]+$/, <= 40 chars, unique within the season.
//   - name: required Chinese/display name, <= 50 chars.
//   - display_order: optional int (default 0).
//   - available: optional boolean (default true).
//   - stock_fen is NEVER set here — new groups start at 0 and only change via
//     POST /api/admin/product-groups/:id/intake. (Audit invariant lives there.)
//
// Auth: authorizeAdmin(..., "admin") — also runs requireSameOrigin for non-GET.
// Audit: action='group_create' (written right after the INSERT; see design note below
//        for why this path is INSERT-then-read-id rather than a batch/RETURNING).
export const POST: APIRoute = async ({ request }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  let body: {
    slug?: string;
    name?: string;
    display_order?: number;
    available?: boolean;
    stock_fen?: number;
  };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }

  // Stock can never be set through this path.
  if (body.stock_fen !== undefined) {
    return json(
      { ok: false, error_code: "STOCK_FORBIDDEN", message: "stock is set via intake only" },
      400,
    );
  }

  const slug = (body.slug ?? "").trim();
  const name = (body.name ?? "").trim();
  const display_order = Number.isFinite(body.display_order) ? Number(body.display_order) : 0;
  const available = body.available === undefined ? true : Boolean(body.available);

  if (!slug || !/^[a-z0-9-]+$/.test(slug) || slug.length > 40) {
    return text("bad slug (lowercase a-z0-9- , up to 40 chars)", 400);
  }
  if (!name || name.length > 50) return text("bad name (1-50 chars)", 400);
  if (!Number.isInteger(display_order) || display_order < 0 || display_order > 100_000) {
    return text("bad display_order", 400);
  }

  const db = makeDb(env);

  // Resolve active season.
  const seasonRow = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  if (seasonRow.length === 0) {
    return json({ ok: false, error_code: "NO_ACTIVE_SEASON" }, 409);
  }
  const seasonId = seasonRow[0]!.id;

  // App-level uniqueness check (the partial unique index on (season_id, slug) is the
  // real guard, but checking first lets us return a clean SLUG_TAKEN instead of a
  // raw constraint error).
  const dup = await db
    .select({ id: product_groups.id })
    .from(product_groups)
    .where(and(eq(product_groups.season_id, seasonId), eq(product_groups.slug, slug)))
    .limit(1);
  if (dup.length > 0) {
    return json(
      { ok: false, error_code: "SLUG_TAKEN", slug, season_id: seasonId },
      409,
    );
  }

  const now = new Date().toISOString();
  // INSERT the group, then resolve its id by (season_id, slug) — the same
  // insert-then-select pattern the test helper seedGroup uses. We deliberately
  // avoid `RETURNING` (no existing precedent in this codebase) to stay on the
  // already-proven `.run()` / `.first<>()` D1 surface used by intake.ts/stock.ts.
  await env.DB.prepare(
    `INSERT INTO product_groups (season_id, slug, name, stock_fen, available, display_order, created_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)`,
  )
    .bind(seasonId, slug, name, available ? 1 : 0, display_order, now)
    .run();

  const created = await env.DB.prepare(
    `SELECT id FROM product_groups WHERE season_id = ? AND slug = ?`,
  )
    .bind(seasonId, slug)
    .first<{ id: number }>();
  if (!created || typeof created.id !== "number") {
    // Should be impossible (we just inserted), but never trust a null read.
    return json({ ok: false, error_code: "CREATE_FAILED" }, 500);
  }
  const groupId = created.id;

  await env.DB.prepare(
    `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      now,
      auth.session.email,
      "group_create",
      null,
      seasonId,
      JSON.stringify({
        group_id: groupId,
        slug,
        name,
        display_order,
        available,
      }),
    )
    .run();

  return json({ ok: true, group_id: groupId, slug });
};
