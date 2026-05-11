import type { APIRoute } from "astro";
import { eq, desc } from "drizzle-orm";
import { makeDb } from "../../../../../db/client";
import { orders, order_items, products, audit_log } from "../../../../../db/schema";
import { authorizeAdmin, json, text } from "../../../../../lib/admin-api";
import {
  tryDecrementStock,
  restoreStock,
  stockRestoreStmts,
} from "../../../../../lib/stock";
import { shippingFor } from "../../../../../lib/order-response";
import { itemsHash } from "../../../../../lib/items-hash";
import { env } from "../../../../../lib/env";

// V5 sticky-save endpoint: single打點 for editable fields on the order detail
// page (items + address + notes). Status events (paid/shipped/cancel) stay
// on their own endpoints — they're events, not edits.
//
// Pattern (per /autoplan eng review): gate-first via separate SELECT (cancel.ts
// pattern), NOT mid-batch (mark-paid.ts had the 0-row-UPDATE bug). All
// post-Phase-A writes go in one batch, with application-level compensation if
// Phase B fails.
//
// expected_state = boolean snapshot {paid, shipped, cancelled_at}. Schema
// unchanged (V5 premise 6). Items race is documented last-write-wins
// limitation (Accepted Limitations § 1).
//
// Idempotency: client-supplied uuid in Idempotency-Key header (or body field).
// Server checks latest audit_log row for this order; if recent (≤60s) with
// matching key, return cached success without re-applying.
//
// Server-side field diff: client cannot lie about "what changed". Server
// compares incoming address/notes against DB row; only audits real diffs.

interface ItemInput {
  sku: string;
  qty: number;
}

interface SaveRequest {
  items?: ItemInput[];
  address?: string;
  notes?: string;
  expected_state: {
    paid: boolean;
    shipped: boolean;
    cancelled_at: string | null;
    // Optional canonical hash of the items at the time the client loaded the
    // page (computed via lib/items-hash#itemsHash). When present, server gates
    // any edit on it matching the current order_items — closes the two-tab
    // concurrent-items-edit race that paid/shipped/cancelled alone cannot
    // detect. Optional for legacy compatibility; clients SHOULD always send.
    items_hash?: string;
  };
  idempotency_key?: string;
}

const IDEMPOTENCY_WINDOW_MS = 60_000;

export const POST: APIRoute = async ({ request, params }) => {
  const auth = await authorizeAdmin(request, env, "admin");
  if (!auth.ok) return text(auth.reason, auth.status);

  const id = params.id;
  if (!id || !/^M-\d{8}-\d{3}$/.test(id)) return text("bad id", 400);

  let body: SaveRequest;
  try {
    body = (await request.json()) as SaveRequest;
  } catch {
    return text("bad json", 400);
  }

  if (
    !body.expected_state ||
    typeof body.expected_state.paid !== "boolean" ||
    typeof body.expected_state.shipped !== "boolean" ||
    (body.expected_state.cancelled_at !== null &&
      typeof body.expected_state.cancelled_at !== "string")
  ) {
    return text("expected_state required", 400);
  }

  const idempotencyKey =
    body.idempotency_key ?? request.headers.get("Idempotency-Key") ?? null;

  const db = makeDb(env);

  // Step 1: Idempotency replay check — scan the last N audit rows (not just the
  // latest) so an interleaved status event (mark_paid / mark_shipped / cancel)
  // between a save and its retry doesn't make the retry miss the cache and
  // re-execute the mutation. 10 rows covers any realistic interleave depth
  // within the 60s window.
  if (idempotencyKey) {
    const recent = await db
      .select()
      .from(audit_log)
      .where(eq(audit_log.order_id, id))
      .orderBy(desc(audit_log.ts))
      .limit(10);
    for (const row of recent) {
      if (!row.details) continue;
      try {
        const parsed = JSON.parse(row.details) as { idempotency_key?: string };
        if (parsed.idempotency_key !== idempotencyKey) continue;
        const rowTs = Date.parse(row.ts);
        if (Number.isFinite(rowTs) && Date.now() - rowTs < IDEMPOTENCY_WINDOW_MS) {
          // Replay: caller's previous request already applied. Return current
          // order state without re-running the mutation.
          return json(await loadOrderJson(db, id));
        }
      } catch {
        /* malformed details JSON — keep scanning */
      }
    }
  }

  // Step 2: Read current order + items + validate expected_state.
  const orderRows = await db
    .select()
    .from(orders)
    .where(eq(orders.order_id, id))
    .limit(1);
  const order = orderRows[0];
  if (!order) return text("not_found", 404);

  const currentItems = await db
    .select()
    .from(order_items)
    .where(eq(order_items.order_id, id));
  const currentItemsHash = itemsHash(currentItems);

  const stateStale =
    order.paid !== body.expected_state.paid ||
    order.shipped !== body.expected_state.shipped ||
    order.cancelled_at !== body.expected_state.cancelled_at;
  // items_hash is optional — only gate when client sent one. Legacy clients
  // that don't compute the hash fall through to last-write-wins behavior
  // (documented limitation pre-V5.1).
  const itemsStale =
    typeof body.expected_state.items_hash === "string" &&
    body.expected_state.items_hash !== currentItemsHash;

  if (stateStale || itemsStale) {
    return json(
      {
        ok: false,
        error_code: "STALE_STATE",
        stale_reason: itemsStale && !stateStale ? "items" : stateStale && itemsStale ? "both" : "status",
        current_state: {
          paid: order.paid,
          shipped: order.shipped,
          cancelled_at: order.cancelled_at,
          items_hash: currentItemsHash,
        },
        current_order: await loadOrderJson(db, id),
      },
      409,
    );
  }

  const isReadOnly =
    order.paid || order.shipped || order.cancelled_at !== null;
  const wantsItemsEdit = Array.isArray(body.items);

  if (isReadOnly && wantsItemsEdit) {
    return json(
      {
        ok: false,
        error_code: "EDIT_FORBIDDEN",
        reason: "items locked when paid/shipped/cancelled",
      },
      409,
    );
  }
  // Cancelled orders cannot edit address/notes either.
  if (
    order.cancelled_at !== null &&
    (body.address !== undefined || body.notes !== undefined)
  ) {
    return json(
      {
        ok: false,
        error_code: "EDIT_FORBIDDEN",
        reason: "cancelled order is immutable",
      },
      409,
    );
  }

  // Step 3: Validate inputs (when present).
  if (wantsItemsEdit) {
    if (body.items!.length === 0) return text("at least one item required", 400);
    for (const it of body.items!) {
      if (
        !it ||
        typeof it.sku !== "string" ||
        !Number.isInteger(it.qty) ||
        it.qty < 1 ||
        it.qty > 99
      ) {
        return text("invalid item shape", 400);
      }
    }
  }

  let newAddress: string | null = null;
  if (body.address !== undefined) {
    const a = body.address.trim();
    if (a.length < 5 || a.length > 200) return text("bad address", 400);
    newAddress = a;
  }
  let newNotes: string | null = null;
  let notesProvided = false;
  if (body.notes !== undefined) {
    const n = body.notes.trim();
    if (n.length > 500) return text("notes too long", 400);
    newNotes = n.length === 0 ? null : n;
    notesProvided = true;
  }

  // Step 4: Server-side field diff (don't trust client claims).
  const auditedChanges: Record<string, unknown> = {};

  if (newAddress !== null && newAddress !== order.address) {
    auditedChanges.address = { before_len: order.address.length, after_len: newAddress.length };
  }
  if (notesProvided && newNotes !== order.notes) {
    auditedChanges.notes = {
      before_len: (order.notes ?? "").length,
      after_len: (newNotes ?? "").length,
    };
  }

  // Step 5: If items, compute diff (mirrors items.ts).
  let decrements: ItemInput[] = [];
  let restores: ItemInput[] = [];
  const updates: ItemInput[] = [];
  const inserts: ItemInput[] = [];
  const deletes: string[] = [];
  let newSubtotal = order.subtotal;
  let newShipping = order.shipping;
  let newTotal = order.total;
  let existing: typeof order_items.$inferSelect[] = [];

  if (wantsItemsEdit) {
    existing = await db
      .select()
      .from(order_items)
      .where(eq(order_items.order_id, id));
    const productRows = await db.select().from(products);
    const prodMap = new Map(productRows.map((p) => [p.sku, p]));

    for (const it of body.items!) {
      const p = prodMap.get(it.sku);
      if (!p) return text(`unknown sku ${it.sku}`, 400);
      if (!p.available) {
        return json(
          { ok: false, error_code: "SOLD_OUT", sold_out_sku: it.sku },
          409,
        );
      }
    }

    const existingMap = new Map(existing.map((e) => [e.sku, e]));
    const newMap = new Map(body.items!.map((i) => [i.sku, i]));

    for (const ni of body.items!) {
      const ex = existingMap.get(ni.sku);
      if (!ex) {
        decrements.push({ sku: ni.sku, qty: ni.qty });
        inserts.push(ni);
      } else if (ex.qty !== ni.qty) {
        const delta = ni.qty - ex.qty;
        if (delta > 0) decrements.push({ sku: ni.sku, qty: delta });
        else restores.push({ sku: ni.sku, qty: -delta });
        updates.push(ni);
      }
    }
    for (const ex of existing) {
      if (!newMap.has(ex.sku)) {
        restores.push({ sku: ex.sku, qty: ex.qty });
        deletes.push(ex.sku);
      }
    }

    const itemsChanged =
      decrements.length > 0 || restores.length > 0 || deletes.length > 0;
    if (itemsChanged) {
      newSubtotal = body.items!.reduce((s, it) => {
        const ex = existingMap.get(it.sku);
        const unit = ex ? ex.unit_price : prodMap.get(it.sku)!.price;
        return s + unit * it.qty;
      }, 0);
      newShipping = shippingFor(body.items!, env);
      newTotal = newSubtotal + newShipping;
      auditedChanges.items = {
        before: existing.map((e) => ({ sku: e.sku, qty: e.qty })),
        after: body.items,
        decrements,
        restores,
      };
    }
  }

  // Nothing actually changed — short-circuit, return current state.
  if (Object.keys(auditedChanges).length === 0) {
    return json(await loadOrderJson(db, id));
  }

  // Step 6: Phase A — claim stock for decrements (atomic CAS).
  if (decrements.length > 0) {
    const reserve = await tryDecrementStock(env, decrements);
    if (!reserve.ok) {
      return json(
        { ok: false, error_code: "SOLD_OUT", sold_out_sku: reserve.sold_out_sku },
        409,
      );
    }
  }

  // Step 7: Phase B — single atomic batch (restore + items + address/notes + audit).
  const now = new Date().toISOString();
  try {
    type Stmt = ReturnType<typeof env.DB.prepare>;
    const batch: Stmt[] = [];

    if (restores.length > 0) {
      batch.push(...stockRestoreStmts(env, restores));
    }
    if (deletes.length > 0) {
      const placeholders = deletes.map(() => "?").join(",");
      batch.push(
        env.DB.prepare(
          `DELETE FROM order_items WHERE order_id = ? AND sku IN (${placeholders})`,
        ).bind(id, ...deletes),
      );
    }
    for (const u of updates) {
      batch.push(
        env.DB.prepare(
          `UPDATE order_items SET qty = ? WHERE order_id = ? AND sku = ?`,
        ).bind(u.qty, id, u.sku),
      );
    }
    if (inserts.length > 0) {
      const productRows = await db.select().from(products);
      const prodMap = new Map(productRows.map((p) => [p.sku, p]));
      for (const ins of inserts) {
        batch.push(
          env.DB.prepare(
            `INSERT INTO order_items (order_id, sku, qty, unit_price) VALUES (?, ?, ?, ?)`,
          ).bind(id, ins.sku, ins.qty, prodMap.get(ins.sku)!.price),
        );
      }
    }
    if (auditedChanges.items) {
      batch.push(
        env.DB.prepare(
          `UPDATE orders SET subtotal = ?, shipping = ?, total = ? WHERE order_id = ?`,
        ).bind(newSubtotal, newShipping, newTotal, id),
      );
    }
    if (newAddress !== null && newAddress !== order.address) {
      batch.push(
        env.DB.prepare(`UPDATE orders SET address = ? WHERE order_id = ?`).bind(
          newAddress,
          id,
        ),
      );
    }
    if (notesProvided && newNotes !== order.notes) {
      batch.push(
        env.DB.prepare(`UPDATE orders SET notes = ? WHERE order_id = ?`).bind(
          newNotes,
          id,
        ),
      );
    }
    batch.push(
      env.DB.prepare(
        `INSERT INTO audit_log (ts, user_email, action, order_id, details) VALUES (?, ?, ?, ?, ?)`,
      ).bind(
        now,
        auth.session.email,
        "order_save",
        id,
        JSON.stringify({
          ...auditedChanges,
          ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
        }),
      ),
    );

    await env.DB.batch(batch);
    return json(await loadOrderJson(db, id));
  } catch {
    if (decrements.length > 0) {
      await restoreStock(env, decrements);
    }
    return json({ ok: false, error_code: "INTERNAL" }, 500);
  }
};

interface OrderJson {
  ok: true;
  order: typeof orders.$inferSelect;
  items: Array<typeof order_items.$inferSelect>;
  // Latest audit rows so the client can append the new row to 變更歷史
  // without doing a full page reload.
  audit_log: Array<typeof audit_log.$inferSelect>;
}

async function loadOrderJson(
  db: ReturnType<typeof makeDb>,
  id: string,
): Promise<OrderJson> {
  const o = await db
    .select()
    .from(orders)
    .where(eq(orders.order_id, id))
    .limit(1);
  const its = await db
    .select()
    .from(order_items)
    .where(eq(order_items.order_id, id));
  const al = await db
    .select()
    .from(audit_log)
    .where(eq(audit_log.order_id, id))
    .orderBy(desc(audit_log.ts))
    .limit(50);
  return { ok: true, order: o[0]!, items: its, audit_log: al };
}
