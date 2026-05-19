import type { APIRoute } from "astro";
import { and, eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { products, product_groups, seasons } from "../../../../db/schema";
import { env } from "../../../../lib/env";

// V5.2: create a product within the active season + a specified group.
// Required fields: sku + name + variant + price + group_slug + package_fen.
// Optional: available (defaults true), display_order (defaults 0).
//
// Note: stock is NOT set here. Stock lives on product_groups.stock_fen and is set
// via /api/admin/product-groups/:id/intake (PR2).
export const POST: APIRoute = async ({ request }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  let body: {
    sku?: string;
    name?: string;
    variant?: string;
    price?: number;
    available?: boolean;
    display_order?: number;
    group_slug?: string;
    package_fen?: number;
  };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }

  const sku = (body.sku ?? "").trim();
  const name = (body.name ?? "").trim();
  const variant = (body.variant ?? "").trim();
  const price = Number(body.price);
  const available = body.available === undefined ? true : Boolean(body.available);
  const display_order = Number.isFinite(body.display_order) ? Number(body.display_order) : 0;
  const groupSlug = (body.group_slug ?? "").trim();
  const package_fen = Number(body.package_fen);

  if (!sku || !/^[A-Z0-9_-]+$/.test(sku) || sku.length > 30) return text("bad sku", 400);
  if (!name || name.length > 50) return text("bad name", 400);
  if (!variant || variant.length > 30) return text("bad variant", 400);
  if (!Number.isInteger(price) || price < 0 || price > 100_000) return text("bad price", 400);
  if (!groupSlug || !/^[a-z0-9-]+$/.test(groupSlug)) return text("bad group_slug", 400);
  if (!Number.isInteger(package_fen) || package_fen <= 0 || package_fen > 100_000)
    return text("bad package_fen (positive integer up to 100000)", 400);

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

  // Resolve group within active season
  const groupRow = await db
    .select({ id: product_groups.id })
    .from(product_groups)
    .where(and(eq(product_groups.season_id, seasonId), eq(product_groups.slug, groupSlug)))
    .limit(1);
  if (groupRow.length === 0) {
    return json(
      { ok: false, error_code: "GROUP_NOT_FOUND", group_slug: groupSlug },
      404,
    );
  }
  const groupId = groupRow[0]!.id;

  // Check duplicate within season
  const dup = await db
    .select({ sku: products.sku })
    .from(products)
    .where(and(eq(products.season_id, seasonId), eq(products.sku, sku)))
    .limit(1);
  if (dup.length > 0) return text("sku exists in active season", 409);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        "INSERT INTO products (season_id, group_id, sku, name, variant, package_fen, price, available, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(seasonId, groupId, sku, name, variant, package_fen, price, available ? 1 : 0, display_order),
    env.DB
      .prepare(
        "INSERT INTO audit_log (ts, user_email, action, season_id, details) VALUES (?, ?, 'product_create', ?, ?)",
      )
      .bind(
        now,
        auth.session.email,
        seasonId,
        JSON.stringify({
          sku,
          name,
          variant,
          price,
          available,
          display_order,
          group_slug: groupSlug,
          group_id: groupId,
          package_fen,
        }),
      ),
  ]);

  return json({ ok: true, sku });
};
