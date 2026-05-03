import type { AppEnv } from "../db/client";
import type { Order, OrderItem, Product } from "../db/schema";
import { buildLiffBindUrl } from "./line";

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
  | "INTERNAL";

export interface OrderError {
  ok: false;
  error_code: OrderErrorCode;
  sold_out_sku?: string;
  message?: string;
}

export type OrderResponse = OrderSuccess | OrderError;

// Relative URL so the customer's status link works regardless of which env
// (stage / prod / future custom domain) the order was placed on. Same-origin.
export function shippingFor(items: Array<{ qty: number }>, env: AppEnv): number {
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const minFree = parseInt(env.FREE_SHIPPING_MIN_PACKAGES, 10) || 10;
  const fee = parseInt(env.SHIPPING_FEE_TWD, 10) || 80;
  return totalQty >= minFree ? 0 : fee;
}

export function expectedMemoFor(orderId: string, name: string): string {
  return `${orderId}-${name}`;
}

export function statusUrlFor(orderId: string): string {
  return `/status?id=${encodeURIComponent(orderId)}`;
}

export async function assembleOrderSuccess(
  order: Order,
  _items: OrderItem[],
  env: AppEnv,
): Promise<OrderSuccess> {
  let liffBindUrl: string | null = null;
  if (env.LINE_LIFF_ID && env.LIFF_BIND_HMAC_SECRET) {
    try {
      const parts = await buildLiffBindUrl(order.order_id, env);
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
    status_url: statusUrlFor(order.order_id),
    liff_bind_url: liffBindUrl,
    phone_last4: order.phone.slice(-4),
  };
}
