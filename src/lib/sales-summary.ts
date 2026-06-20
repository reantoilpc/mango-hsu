// V6 §5.7+ — admin-home sales summary (銷售概況).
// Split like admin-dashboard.ts: pure, unit-testable shaping here; the DB
// aggregation (querySalesSummary) is added alongside but kept thin.
// 1 斤 = 100 fen. All money is integer TWD. package_fen is immutable, so
// Σ(qty × package_fen) reconstructs historical weight exactly.

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
