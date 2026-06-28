// V8 後台 LINE 綁定名單 (admin LINE-binding roster).
// Split like sales-summary.ts: pure, unit-testable shaping here; the DB read
// (queryLineBindings) is kept thin alongside.
//
// Data source is the existing schema — NO migration. orders.line_user_id holds
// the bound LINE account id (one per bound order). The binding TIMESTAMP lives
// in audit_log (action='line_bind_success'), so we LEFT JOIN it on for bound_at.
//
// Why LEFT JOIN from orders (not INNER JOIN from audit_log): today bind.ts is the
// SOLE writer of line_user_id and writes both the column and the line_bind_success
// row atomically, so the two are equivalent. But orders is the authoritative source
// of "is this bound". If any future path ever sets line_user_id WITHOUT a
// line_bind_success row (e.g. an admin manual-bind, or a displayName backfill),
// an INNER JOIN from audit_log would silently UNDER-COUNT people. Driving from
// orders + COALESCE(bound_at, created_at) never drops a bound customer.

import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../db/schema";

// Raw row from queryLineBindings — one per bound order (0/1 line_bind_success each).
export interface LineBindingRow {
  order_id: string;
  line_user_id: string;
  name: string;
  phone: string;
  bound_at: string | null; // audit_log.ts of line_bind_success; NULL if no audit row
  created_at: string; // fallback for bound_at
  shipped_at: string | null;
  line_push_sent_at: string | null;
  cancelled_at: string | null;
}

export interface BoundOrder {
  orderId: string;
  boundAt: string; // bound_at ?? created_at (always set)
  shipped: boolean;
  pushSent: boolean;
  cancelled: boolean;
}

export interface BoundPerson {
  lineUserId: string;
  name: string; // from the person's most-recently-bound order
  phone: string;
  firstBoundAt: string; // earliest boundAt among their orders
  latestBoundAt: string; // most recent boundAt (drives roster ordering)
  orders: BoundOrder[]; // sorted boundAt desc
}

export interface LineBindingsSummary {
  people: BoundPerson[]; // sorted by most-recent binding desc
  totalPeople: number; // = people.length (= COUNT(DISTINCT line_user_id))
  totalOrders: number; // non-cancelled bound orders
  pushedOrders: number; // non-cancelled bound orders that received the shipment push
  hasBindings: boolean;
}

// ISO-8601 + Z timestamps sort correctly lexicographically.
function isoDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

export function shapeLineBindings(rows: LineBindingRow[]): LineBindingsSummary {
  // Group by line_user_id, deduping by order_id (defensive: a LEFT JOIN could
  // duplicate an order if it ever had >1 line_bind_success row; keep max boundAt).
  const byPerson = new Map<string, Map<string, BoundOrder>>();
  for (const r of rows) {
    const boundAt = r.bound_at ?? r.created_at;
    const order: BoundOrder = {
      orderId: r.order_id,
      boundAt,
      shipped: r.shipped_at !== null,
      pushSent: r.line_push_sent_at !== null,
      cancelled: r.cancelled_at !== null,
    };
    let orders = byPerson.get(r.line_user_id);
    if (!orders) {
      orders = new Map<string, BoundOrder>();
      byPerson.set(r.line_user_id, orders);
    }
    const existing = orders.get(r.order_id);
    if (!existing || order.boundAt > existing.boundAt) {
      // Preserve name/phone source: we re-resolve those per-person below, so
      // storing the order alone is enough here.
      orders.set(r.order_id, order);
    }
  }

  // Map line_user_id -> the row that is its most-recently-bound order, for name/phone.
  const latestRowByPerson = new Map<string, LineBindingRow>();
  for (const r of rows) {
    const boundAt = r.bound_at ?? r.created_at;
    const cur = latestRowByPerson.get(r.line_user_id);
    const curBoundAt = cur ? (cur.bound_at ?? cur.created_at) : "";
    if (!cur || boundAt > curBoundAt) latestRowByPerson.set(r.line_user_id, r);
  }

  const people: BoundPerson[] = [];
  for (const [lineUserId, orderMap] of byPerson) {
    const orders = [...orderMap.values()].sort((a, b) => isoDesc(a.boundAt, b.boundAt));
    const latest = latestRowByPerson.get(lineUserId)!;
    const boundTimes = orders.map((o) => o.boundAt);
    people.push({
      lineUserId,
      name: latest.name,
      phone: latest.phone,
      firstBoundAt: boundTimes.reduce((min, t) => (t < min ? t : min), boundTimes[0]),
      latestBoundAt: boundTimes.reduce((max, t) => (t > max ? t : max), boundTimes[0]),
      orders,
    });
  }

  people.sort((a, b) => isoDesc(a.latestBoundAt, b.latestBoundAt));

  let totalOrders = 0;
  let pushedOrders = 0;
  for (const p of people) {
    for (const o of p.orders) {
      if (o.cancelled) continue; // cancelled orders excluded from order-level stats
      totalOrders += 1;
      if (o.pushSent) pushedOrders += 1;
    }
  }

  return {
    people,
    totalPeople: people.length, // includes people whose only orders are cancelled
    totalOrders,
    pushedOrders,
    hasBindings: people.length > 0,
  };
}

// Thin DB read. Drives FROM orders so no bound customer is ever dropped; the
// audit_log LEFT JOIN only supplies the binding timestamp.
export async function queryLineBindings(
  db: DrizzleD1Database<typeof schema>,
): Promise<LineBindingRow[]> {
  return db.all<LineBindingRow>(sql`
    SELECT o.order_id          AS order_id,
           o.line_user_id      AS line_user_id,
           o.name              AS name,
           o.phone             AS phone,
           o.created_at        AS created_at,
           o.shipped_at        AS shipped_at,
           o.line_push_sent_at AS line_push_sent_at,
           o.cancelled_at      AS cancelled_at,
           a.ts                AS bound_at
    FROM orders o
    LEFT JOIN audit_log a
      ON a.order_id = o.order_id AND a.action = 'line_bind_success'
    WHERE o.line_user_id IS NOT NULL
    ORDER BY COALESCE(a.ts, o.created_at) DESC
  `);
}
