import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { makeDb } from "../../../../db/client";
import { product_groups } from "../../../../db/schema";
import { env } from "../../../../lib/env";

// V6 P6 (spec §5.2): edit a product_group's display fields.
//
// Editable: name, available, display_order. ANY of the three may be present;
// at least one must be (NO_FIELDS otherwise).
//
// Hard rule: a body containing `stock_fen` is rejected (STOCK_FORBIDDEN, 400) —
// stock is owned by product_groups.stock_fen and may ONLY change via
// POST /api/admin/product-groups/:id/intake (two-sided CAS + same-batch audit).
// This endpoint never touches stock_fen.
//
// Optional optimistic lock: body.expected {name, available, display_order} is
// compared against the current row before writing (STALE_STATE on mismatch),
// mirroring the gate-first pattern in cancel.ts — SELECT-validate, then a single
// env.DB.batch([UPDATE, INSERT audit]).
//
// Auth: authorizeAdmin(..., "admin") (also runs requireSameOrigin for PATCH).
// Audit: action='group_update', details {group_id, changed[], before, after}.
export const PATCH: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const groupId = Number(params.id);
  if (!Number.isInteger(groupId) || groupId <= 0) return text("bad id", 400);

  let body: {
    name?: string;
    available?: boolean;
    display_order?: number;
    stock_fen?: number;
    expected?: { name: string; available: boolean; display_order: number };
  };
  try {
    body = await request.json();
  } catch {
    return text("bad json", 400);
  }

  // Stock is never editable here.
  if (body.stock_fen !== undefined) {
    return json(
      { ok: false, error_code: "STOCK_FORBIDDEN", message: "stock is set via intake only" },
      400,
    );
  }

  // Collect the editable fields actually present, with validation.
  const updates: { name?: string; available?: boolean; display_order?: number } = {};
  const changed: string[] = [];

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name || name.length > 50) return text("bad name (1-50 chars)", 400);
    updates.name = name;
    changed.push("name");
  }
  if (body.available !== undefined) {
    updates.available = Boolean(body.available);
    changed.push("available");
  }
  if (body.display_order !== undefined) {
    const do_ = Number(body.display_order);
    if (!Number.isInteger(do_) || do_ < 0 || do_ > 100_000) {
      return text("bad display_order", 400);
    }
    updates.display_order = do_;
    changed.push("display_order");
  }

  if (changed.length === 0) {
    return json({ ok: false, error_code: "NO_FIELDS", message: "nothing to update" }, 400);
  }

  const db = makeDb(env);
  const rows = await db
    .select()
    .from(product_groups)
    .where(eq(product_groups.id, groupId))
    .limit(1);
  const group = rows[0];
  if (!group) return text("group not found", 404);

  // Optional optimistic lock (gate-first, like cancel.ts): compare expected vs current.
  if (body.expected) {
    if (
      group.name !== body.expected.name ||
      group.available !== body.expected.available ||
      group.display_order !== body.expected.display_order
    ) {
      return json(
        {
          ok: false,
          error_code: "STALE_STATE",
          current: {
            name: group.name,
            available: group.available,
            display_order: group.display_order,
          },
        },
        409,
      );
    }
  }

  const before = {
    name: group.name,
    available: group.available,
    display_order: group.display_order,
  };
  const after = {
    name: updates.name ?? group.name,
    available: updates.available ?? group.available,
    display_order: updates.display_order ?? group.display_order,
  };
  const now = new Date().toISOString();

  // Single batch: UPDATE the three columns (untouched ones keep current value via
  // the `after` snapshot) + INSERT the audit row. No stock_fen in the UPDATE.
  await env.DB.batch([
    env.DB
      .prepare(
        `UPDATE product_groups
            SET name = ?, available = ?, display_order = ?
          WHERE id = ?`,
      )
      .bind(after.name, after.available ? 1 : 0, after.display_order, groupId),
    env.DB
      .prepare(
        `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        now,
        auth.session.email,
        "group_update",
        null,
        group.season_id,
        JSON.stringify({ group_id: groupId, changed, before, after }),
      ),
  ]);

  return json({ ok: true, group_id: groupId, changed });
};
