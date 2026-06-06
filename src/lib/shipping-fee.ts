// Pure shipping-fee computation (pre-V6 interim). No env, no DB — unit-testable in
// isolation AND importable from both the server (order-response.ts) and the customer
// order page's client script, so the previewed fee can never drift from the charged fee.
//
// Rule: 滿 10 斤免運、未滿收固定運費。Weight is in `fen` (1 斤 = 100 fen), matching the
// V5.2 stock model (package_fen).
//
// NOTE: V6 replaces this with a per-season `seasons.shipping_config` (free_over_fen + fee).
// This module + constant are the interim until V6 ships to prod; when it does, delete this
// and route shipping through src/lib/shipping.ts instead.

export const FREE_SHIPPING_OVER_FEN = 1000; // 10 斤

// Total order weight in fen = Σ(package_fen × qty). Defensive against non-positive qty.
export function totalFenOf(
  items: Array<{ package_fen: number; qty: number }>,
): number {
  let fen = 0;
  for (const it of items) {
    if (it.qty > 0) fen += it.package_fen * it.qty;
  }
  return fen;
}

// Shipping fee (TWD) for a total weight (fen): free at/above the threshold, else the flat
// fee. Empty order (totalFen <= 0) is always free.
export function shippingFeeFor(totalFen: number, feeTwd: number): number {
  if (totalFen <= 0) return 0;
  return totalFen >= FREE_SHIPPING_OVER_FEN ? 0 : feeTwd;
}
