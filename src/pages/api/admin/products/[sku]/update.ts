import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { makeDb } from "../../../../../db/client";
import { products } from "../../../../../db/schema";

export const POST: APIRoute = async ({ request, params, locals }) => {
  const env = locals.runtime?.env;
  if (!env) return text("no runtime", 500);

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
  const available = Boolean(body.available);
  const display_order = Number.isFinite(body.display_order) ? Number(body.display_order) : 0;

  if (!name || name.length > 50) return text("bad name", 400);
  if (!variant || variant.length > 30) return text("bad variant", 400);
  if (!Number.isInteger(price) || price < 0 || price > 100_000) return text("bad price", 400);

  const db = makeDb(env);
  const existing = await db
    .select({ sku: products.sku })
    .from(products)
    .where(eq(products.sku, sku))
    .limit(1);
  if (existing.length === 0) return text("not found", 404);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        "UPDATE products SET name = ?, variant = ?, price = ?, available = ?, display_order = ? WHERE sku = ?",
      )
      .bind(name, variant, price, available ? 1 : 0, display_order, sku),
    env.DB
      .prepare(
        "INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, 'product_update', ?)",
      )
      .bind(
        now,
        auth.session.email,
        JSON.stringify({ sku, name, variant, price, available, display_order }),
      ),
  ]);

  return json({ ok: true });
};
