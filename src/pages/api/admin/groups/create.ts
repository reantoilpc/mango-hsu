import type { APIRoute } from "astro";
import { eq } from "drizzle-orm";
import { makeDb } from "../../../../db/client";
import { orders, order_items, order_groups, seasons } from "../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../lib/admin-api";
import { validateAdminOrder } from "../../../../lib/order-validate";
import { generateGroupCode, validateDeadline } from "../../../../lib/order-groups";
import {
  resolveItemsForStock,
  tryDecrementGroupStock,
  restoreGroupStock,
  getGroupStockFen,
  stockAuditStmts,
} from "../../../../lib/stock";
import { nextOrderId } from "../../../../lib/order-id";
import { expectedMemoFor } from "../../../../lib/order-response";
import { isUniqueOnOrderId } from "../../../../lib/order-errors";
import { env } from "../../../../lib/env";

interface CreateGroupBody {
  idempotency_key: string;
  host_name: string;
  host_phone: string;
  host_address: string;
  deadline: string; // UTC ISO+Z (client converts the picked Taipei date to end-of-day UTC)
  items: Array<{ sku: string; qty: number }>;
  notes?: string;
}

export const POST: APIRoute = async ({ request }) => {
  const auth = await authorizeAdmin(request, env);
  if (!auth.ok) return text(auth.reason, auth.status);
  if (auth.session.role !== "admin") return text("admin only", 403);

  let body: CreateGroupBody;
  try {
    body = (await request.json()) as CreateGroupBody;
  } catch {
    return text("bad json", 400);
  }
  if (!body.idempotency_key || typeof body.idempotency_key !== "string") {
    return json({ ok: false, error_code: "INVALID_INPUT" }, 400);
  }

  // Reuse the admin-order validator for host name/phone/address/items.
  const invalid = validateAdminOrder({
    name: body.host_name,
    phone: body.host_phone,
    address: body.host_address,
    items: body.items,
  });
  if (invalid) return json(invalid, 400);

  const createdAt = new Date().toISOString();
  const dl = validateDeadline(body.deadline, createdAt);
  if (!dl.ok) return json({ ok: false, error_code: "BAD_DEADLINE", reason: dl.reason }, 400);

  const db = makeDb(env);

  // Idempotency replay: the host order's idempotency_key uniquely identifies this group.
  const prior = await db
    .select()
    .from(orders)
    .where(eq(orders.idempotency_key, body.idempotency_key))
    .limit(1);
  if (prior.length > 0 && prior[0]!.order_group_id) {
    const g = await db
      .select()
      .from(order_groups)
      .where(eq(order_groups.id, prior[0]!.order_group_id))
      .limit(1);
    return json({ ok: true, group_id: prior[0]!.order_group_id, code: g[0]?.code ?? "", host_order_id: prior[0]!.order_id });
  }

  // Resolve items against the active season.
  const resolved = await resolveItemsForStock(env, body.items);
  if (!resolved.ok) {
    return json({ ok: false, error_code: resolved.error_code, sku: resolved.sku }, 400);
  }
  const seasonRow = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .limit(1);
  const seasonId = seasonRow[0]?.id ?? null;
  if (!seasonId) return json({ ok: false, error_code: "SEASON_CLOSED" }, 400);

  let subtotal = 0;
  for (const r of resolved.resolved) subtotal += r.price * r.qty;
  // Host shipping is provisional (0) until the group closes; finalised in close.ts.
  const shipping = 0;
  const total = subtotal + shipping;

  // Reserve stock once for the host's items.
  const beforeFenMap = await getGroupStockFen(env, resolved.group_decrements.map((d) => d.group_id));
  const reserve = await tryDecrementGroupStock(env, resolved.group_decrements);
  if (!reserve.ok) return json({ ok: false, error_code: "SOLD_OUT", sold_out_group_id: reserve.sold_out_group_id }, 409);

  // Insert the group row with a non-colliding open code (partial-unique retry, max 5).
  let groupId: number | null = null;
  let code = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateGroupCode();
    try {
      const res = await env.DB.prepare(
        `INSERT INTO order_groups (season_id, code, host_name, host_address, deadline, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
      )
        .bind(seasonId, code, body.host_name, body.host_address, body.deadline, auth.session.email, createdAt)
        .run();
      groupId = res.meta.last_row_id as number;
      break;
    } catch (err) {
      if (/UNIQUE/i.test(String(err)) && attempt < 4) continue; // code collision, retry
      await restoreGroupStock(env, resolved.group_decrements);
      return json({ ok: false, error_code: "INTERNAL" }, 500);
    }
  }
  if (groupId === null) {
    await restoreGroupStock(env, resolved.group_decrements);
    return json({ ok: false, error_code: "INTERNAL" }, 500);
  }

  // Insert the host order (group_role='host') with order_id retry. Compensate on hard failure.
  for (let attempt = 0; attempt < 3; attempt++) {
    const orderId = await nextOrderId(db);
    const expectedMemo = expectedMemoFor(orderId, body.host_name);
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO orders (order_id, season_id, created_at, name, phone, address, notes, subtotal, shipping, total, expected_memo, pdpa_accepted, paid, shipped, idempotency_key, order_group_id, group_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, 'host')`,
        ).bind(
          orderId, seasonId, createdAt, body.host_name, body.host_phone, body.host_address,
          body.notes || null, subtotal, shipping, total, expectedMemo, body.idempotency_key, groupId,
        ),
        ...resolved.resolved.map((r) =>
          env.DB.prepare(
            `INSERT INTO order_items (order_id, product_id, sku, qty, unit_price) VALUES (?, ?, ?, ?, ?)`,
          ).bind(orderId, r.product_id, r.sku, r.qty, r.price),
        ),
        ...stockAuditStmts(
          env,
          resolved.group_decrements.map((d) => {
            const before = beforeFenMap.get(d.group_id) ?? 0;
            return { group_id: d.group_id, delta_fen: -d.fen, before_fen: before, after_fen: before - d.fen, reason: "order_decrement" as const, source_id: orderId, season_id: seasonId ?? undefined, ts: createdAt };
          }),
        ),
        env.DB.prepare(
          `INSERT INTO audit_log (ts, user_email, action, order_id, season_id, details) VALUES (?, ?, 'group_created', ?, ?, ?)`,
        ).bind(createdAt, auth.session.email, orderId, seasonId, JSON.stringify({ group_id: groupId, code, deadline: body.deadline })),
      ]);
      return json({ ok: true, group_id: groupId, code, host_order_id: orderId });
    } catch (err) {
      if (isUniqueOnOrderId(err) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      // Hard failure: restore stock + delete the orphan group row.
      await restoreGroupStock(env, resolved.group_decrements);
      await env.DB.prepare(`DELETE FROM order_groups WHERE id = ?`).bind(groupId).run();
      return json({ ok: false, error_code: "INTERNAL" }, 500);
    }
  }
  await restoreGroupStock(env, resolved.group_decrements);
  await env.DB.prepare(`DELETE FROM order_groups WHERE id = ?`).bind(groupId).run();
  return json({ ok: false, error_code: "LOCKED" }, 409);
};
