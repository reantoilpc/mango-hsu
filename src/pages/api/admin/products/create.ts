import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { products } from "../../../../db/schema";

export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env;
  if (!env) return text("no runtime", 500);

  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  let body: {
    sku?: string;
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

  const sku = (body.sku ?? "").trim();
  const name = (body.name ?? "").trim();
  const variant = (body.variant ?? "").trim();
  const price = Number(body.price);
  const available = Boolean(body.available);
  const display_order = Number.isFinite(body.display_order) ? Number(body.display_order) : 0;

  if (!sku || !/^[A-Z0-9_-]+$/.test(sku) || sku.length > 30) return text("bad sku", 400);
  if (!name || name.length > 50) return text("bad name", 400);
  if (!variant || variant.length > 30) return text("bad variant", 400);
  if (!Number.isInteger(price) || price < 0 || price > 100_000) return text("bad price", 400);

  const db = makeDb(env);
  const dup = await db
    .select({ sku: products.sku })
    .from(products)
    .where(eq(products.sku, sku))
    .limit(1);
  if (dup.length > 0) return text("sku exists", 409);

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        "INSERT INTO products (sku, name, variant, price, available, display_order) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(sku, name, variant, price, available ? 1 : 0, display_order),
    env.DB
      .prepare(
        "INSERT INTO audit_log (ts, user_email, action, details) VALUES (?, ?, 'product_create', ?)",
      )
      .bind(
        now,
        auth.session.email,
        JSON.stringify({ sku, name, variant, price, available, display_order }),
      ),
  ]);

  return json({ ok: true });
};
