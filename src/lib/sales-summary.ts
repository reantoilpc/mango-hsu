// V6 §5.7+ — admin-home sales summary (銷售概況).
// Split like admin-dashboard.ts: pure, unit-testable shaping here; the DB
// aggregation (querySalesSummary) is added alongside but kept thin.
// 1 斤 = 100 fen. All money is integer TWD. package_fen is immutable, so
// Σ(qty × package_fen) reconstructs historical weight exactly.

import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "../db/schema";
import { fenToJinLabel } from "./admin-dashboard";

// Raw row from the per-flavour aggregation query (one per product_group).
export interface PerFlavourRow {
  id: number;
  name: string;
  qty: number; // Σ order_items.qty
  fen: number; // Σ(qty × package_fen)
  amount: number; // Σ(qty × unit_price) — item revenue, excludes shipping
}

// Raw single row from the order-totals aggregation query.
export interface OrderTotalsRow {
  orders_n: number;
  subtotal: number; // Σ orders.subtotal (== Σ per-flavour amount)
  shipping: number; // Σ orders.shipping
  total: number; // Σ orders.total (== subtotal + shipping)
  paid_total: number; // Σ total where paid = 1
  unpaid_total: number; // Σ total where paid = 0
}

export interface SalesFlavour {
  name: string;
  jin: string; // e.g. "81.00"
  qty: number;
  amount: number;
}

export interface SalesSummary {
  flavours: SalesFlavour[];
  totals: { jin: string; qty: number; subtotal: number; shipping: number; total: number };
  collection: { paid: number; unpaid: number; paidPct: number }; // paidPct: int 0..100
  ordersN: number;
  hasSales: boolean;
}

// TWD with thousands separators. Workers-safe: regex grouping, no Intl/ICU.
// formatTwd(38480) === "$38,480"; formatTwd(0) === "$0".
export function formatTwd(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = Math.abs(Math.round(n)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}`;
}

export function shapeSalesSummary(
  perFlavour: PerFlavourRow[],
  totals: OrderTotalsRow,
): SalesSummary {
  const flavours: SalesFlavour[] = perFlavour.map((r) => ({
    name: r.name,
    jin: fenToJinLabel(r.fen),
    qty: r.qty,
    amount: r.amount,
  }));
  const totalFen = perFlavour.reduce((sum, r) => sum + r.fen, 0);
  const totalQty = perFlavour.reduce((sum, r) => sum + r.qty, 0);
  const grand = totals.total;
  return {
    flavours,
    totals: {
      jin: fenToJinLabel(totalFen),
      qty: totalQty,
      subtotal: totals.subtotal,
      shipping: totals.shipping,
      total: grand,
    },
    collection: {
      paid: totals.paid_total,
      unpaid: totals.unpaid_total,
      paidPct: grand === 0 ? 0 : Math.round((totals.paid_total / grand) * 100),
    },
    ordersN: totals.orders_n,
    hasSales: totals.orders_n > 0,
  };
}

export interface SalesQueryResult {
  perFlavour: PerFlavourRow[];
  totals: OrderTotalsRow;
}

// Two aggregation queries, both scoped to the active season and non-cancelled
// orders. CAST(...AS INTEGER) + COALESCE(...,0) keep D1 from returning REAL or
// NULL on empty aggregates. ORDER BY pg.display_order is functionally dependent
// on the GROUP BY pg.id (SQLite permits this).
export async function querySalesSummary(
  db: DrizzleD1Database<typeof schema>,
  seasonId: number,
): Promise<SalesQueryResult> {
  const perFlavour = await db.all<PerFlavourRow>(sql`
    SELECT pg.id AS id, pg.name AS name,
           CAST(COALESCE(SUM(oi.qty), 0) AS INTEGER) AS qty,
           CAST(COALESCE(SUM(oi.qty * p.package_fen), 0) AS INTEGER) AS fen,
           CAST(COALESCE(SUM(oi.qty * oi.unit_price), 0) AS INTEGER) AS amount
    FROM order_items oi
    JOIN products p ON p.id = oi.product_id
    JOIN product_groups pg ON pg.id = p.group_id
    JOIN orders o ON o.order_id = oi.order_id
    WHERE o.season_id = ${seasonId} AND o.cancelled_at IS NULL
    GROUP BY pg.id, pg.name
    ORDER BY pg.display_order, pg.slug
  `);

  const totalsRows = await db.all<OrderTotalsRow>(sql`
    SELECT COUNT(*) AS orders_n,
           CAST(COALESCE(SUM(subtotal), 0) AS INTEGER) AS subtotal,
           CAST(COALESCE(SUM(shipping), 0) AS INTEGER) AS shipping,
           CAST(COALESCE(SUM(total), 0) AS INTEGER) AS total,
           CAST(COALESCE(SUM(CASE WHEN paid = 1 THEN total ELSE 0 END), 0) AS INTEGER) AS paid_total,
           CAST(COALESCE(SUM(CASE WHEN paid = 0 THEN total ELSE 0 END), 0) AS INTEGER) AS unpaid_total
    FROM orders
    WHERE season_id = ${seasonId} AND cancelled_at IS NULL
  `);

  const totals: OrderTotalsRow = totalsRows[0] ?? {
    orders_n: 0, subtotal: 0, shipping: 0, total: 0, paid_total: 0, unpaid_total: 0,
  };
  return { perFlavour, totals };
}
