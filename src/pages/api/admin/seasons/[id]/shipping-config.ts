import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { seasons } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import { parseShippingConfig, type ShippingConfig } from "../../../../../lib/shipping";
import { env } from "../../../../../lib/env";

// P4 §5.5: authoritative write point for a season's shipping policy.
// Body: { shipping_config: { type:"flat", fee_twd } | { type:"threshold_jin", free_over_fen, fee_twd } }
// Validates STRICTLY (not via parse fail-safe): an invalid shape is a 400, never silently
// coerced to the default — the admin must see their bad input rejected.
// audit: shipping_config_change with before/after JSON.

interface Body {
  shipping_config?: unknown;
}

// Strict validator (mirrors parseShippingConfig's rules but RETURNS null on failure
// instead of falling back, so the endpoint can 400).
function validateConfig(v: unknown): ShippingConfig | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const feeOk =
    typeof o.fee_twd === "number" && Number.isInteger(o.fee_twd) && o.fee_twd >= 0;
  if (o.type === "flat") {
    return feeOk ? { type: "flat", fee_twd: o.fee_twd as number } : null;
  }
  if (o.type === "threshold_jin") {
    const overOk =
      typeof o.free_over_fen === "number" &&
      Number.isInteger(o.free_over_fen) &&
      o.free_over_fen > 0;
    return feeOk && overOk
      ? {
          type: "threshold_jin",
          free_over_fen: o.free_over_fen as number,
          fee_twd: o.fee_twd as number,
        }
      : null;
  }
  return null;
}

export const PATCH: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) return text("bad id", 400);

  let body: Body;
  try {
    body = (await request.json()) as Body;
  } catch {
    return text("bad json", 400);
  }

  const config = validateConfig(body.shipping_config);
  if (!config) return text("invalid shipping_config", 400);

  const db = makeDb(env);

  // Read current season + its config (for the 404 check + audit before-value).
  const rows = await db
    .select({ id: seasons.id, shipping_config: seasons.shipping_config })
    .from(seasons)
    .where(eq(seasons.id, id))
    .limit(1);
  const season = rows[0];
  if (!season) return text("not_found", 404);

  const beforeConfig = parseShippingConfig(season.shipping_config ?? null);
  const afterJson = JSON.stringify(config);
  const now = new Date().toISOString();

  // Single atomic batch: UPDATE shipping_config + INSERT audit (shipping_config_change).
  await env.DB.batch([
    env.DB.prepare(`UPDATE seasons SET shipping_config = ? WHERE id = ?`).bind(
      afterJson,
      id,
    ),
    env.DB.prepare(
      `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      now,
      auth.session.email,
      "shipping_config_change",
      null,
      id,
      JSON.stringify({ before: beforeConfig, after: config }),
    ),
  ]);

  return json({ ok: true, shipping_config: config });
};
