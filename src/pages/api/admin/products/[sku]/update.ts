import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { makeDb } from "../../../../../db/client";
import { products, seasons } from "../../../../../db/schema";
import { env } from "../../../../../lib/env";

// V5.2: update an existing product within the active season. Lookup is
// (active_season_id, sku) → numeric id. Field updates: name, variant, price,
// available, display_order. Stock + group + package_fen are not editable here
// (stock via intake; group + package_fen would require a more careful migration-style
// flow because they affect order_items and pool weight).
export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const sku = params.sku;
  if (!sku || !/^[A-Z0-9_-]+$/.test(sku)) return text("bad sku", 400);

  let body: {
    name?: string;
    variant?: string;
    price?: number;
    available?: boolean;
    display_order?: number;
  };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }

  const name = (body.name ?? "").trim();
  const variant = (body.variant ?? "").trim();
  const price = Number(body.price);
  // FIX #16: `available` is resolved against the existing row below, AFTER it is
  // loaded — so an omitted field keeps the current value instead of
  // un-publishing the SKU (Boolean(undefined) === false).
  const display_order = Number.isFinite(body.display_order) ? Number(body.display_order) : 0;

  if (!name || name.length > 50) return text("bad name", 400);
  if (!variant || variant.length > 30) return text("bad variant", 400);
  if (!Number.isInteger(price) || price < 0 || price > 100_000) return text("bad price", 400);
  // FIX #15: validate display_order is a non-negative integer (matches batch.ts).
  if (!Number.isInteger(display_order) || display_order < 0)
    return text("bad display_order", 400);

  const db = makeDb(env);

  // Resolve active season
  const seasonRow = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  if (seasonRow.length === 0) {
    return json({ ok: false, error_code: "NO_ACTIVE_SEASON" }, 409);
  }
  const seasonId = seasonRow[0]!.id;

  // Look up product within active season
  const existing = await db
    .select()
    .from(products)
    .where(and(eq(products.season_id, seasonId), eq(products.sku, sku)))
    .limit(1);
  if (existing.length === 0) return text("not found in active season", 404);
  const productId = existing[0]!.id;
  // FIX #16: omitted `available` keeps the current value (no silent un-publish).
  const available =
    body.available === undefined ? existing[0]!.available : Boolean(body.available);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        "UPDATE products SET name = ?, variant = ?, price = ?, available = ?, display_order = ? WHERE id = ?",
      )
      .bind(name, variant, price, available ? 1 : 0, display_order, productId),
    env.DB
      .prepare(
        "INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'product_update', ?, ?)",
      )
      .bind(
        now,
        auth.session.email,
        seasonId,
        JSON.stringify({ sku, product_id: productId, name, variant, price, available, display_order }),
      ),
  ]);

  return json({ ok: true });
};
