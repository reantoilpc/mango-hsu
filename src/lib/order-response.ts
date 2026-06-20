import type { AppEnv } from "../db/client";
import type { Order, OrderItem, Product } from "../db/schema";
import { buildLiffBindUrl } from "./line";
import { computeShipping, totalFenOf, type ShippingConfig } from "./shipping";

export interface OrderSuccess {
  ok: true;
  order_id: string;
  subtotal: number;
  shipping: number;
  total: number;
  expected_memo: string;
  bank_account_display: string;
  eta_days_after_payment: number;
  status_url: string;
  liff_bind_url: string | null;
  phone_last4: string;
}

export type OrderErrorCode =
  | "LOCKED"
  | "INVALID_TOKEN"
  | "SOLD_OUT"
  | "SEASON_CLOSED"
  | "INVALID_INPUT"
  | "INTERNAL"
  // V5.2: customer cart points at a SKU not in the active season (could be archived,
  // could be a typo). Same response from the HTTP perspective whether the SKU once
  // existed or never did — don't leak season state.
  | "unknown_product"
  // V7 併單: supplied group_code is malformed, or no open group matches it (closed,
  // cancelled, past deadline, or never existed).
  | "GROUP_INVALID";

export interface OrderError {
  ok: false;
  error_code: OrderErrorCode;
  // V5.2: SOLD_OUT now reports group_id (the pool that ran dry) instead of sku.
  // Group can have multiple SKUs (1斤 + 半斤 of same flavour); naming the group is
  // truthful — the customer can pick a different flavour.
  sold_out_group_id?: number;
  // V5.2 unknown_product: the offending sku (for client UI to highlight which row to remove)
  sku?: string;
  message?: string;
}

export type OrderResponse = OrderSuccess | OrderError;

// Relative URL so the customer's status link works regardless of which env
// (stage / prod / future custom domain) the order was placed on. Same-origin.
// V6 (spec §5.5): shipping is computed from total order weight (Σ package_fen×qty)
// against the active season's shipping_config (flat | threshold_jin). Callers resolve
// items via resolveItemsForStock() FIRST (which yields package_fen per item) and parse
// the season's shipping_config via parseShippingConfig() — this stays a pure adapter so
// it's unit-testable and never re-queries the DB.
export function shippingFor(
  items: Array<{ package_fen: number; qty: number }>,
  config: ShippingConfig,
): number {
  return computeShipping(totalFenOf(items), config);
}

export function expectedMemoFor(orderId: string, name: string): string {
  return `${orderId}-${name}`;
}

export function statusUrlFor(orderId: string, phoneLast4: string): string {
  return `/status?id=${encodeURIComponent(orderId)}&p=${phoneLast4}`;
}

export async function assembleOrderSuccess(
  order: Order,
  _items: OrderItem[],
  env: AppEnv,
): Promise<OrderSuccess> {
  const phoneLast4 = order.phone.slice(-4);
  let liffBindUrl: string | null = null;
  if (env.LINE_LIFF_ID && env.LIFF_BIND_HMAC_SECRET) {
    try {
      const parts = await buildLiffBindUrl(order.order_id, phoneLast4, env);
      liffBindUrl = parts.url;
    } catch {
      liffBindUrl = null;
    }
  }
  return {
    ok: true,
    order_id: order.order_id,
    subtotal: order.subtotal,
    shipping: order.shipping,
    total: order.total,
    expected_memo: order.expected_memo,
    bank_account_display: env.BANK_ACCOUNT_DISPLAY,
    eta_days_after_payment: parseInt(env.ETA_DAYS_AFTER_PAYMENT, 10) || 5,
    status_url: statusUrlFor(order.order_id, phoneLast4),
    liff_bind_url: liffBindUrl,
    phone_last4: phoneLast4,
  };
}
