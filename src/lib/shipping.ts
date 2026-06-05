// Pure shipping-fee computation for V6 threshold shipping (spec §5.5).
// No env, no DB — fed a parsed ShippingConfig + a totalFen (Σ package_fen×qty).
//
// Unit convention: free_over_fen and totalFen are in `fen` (1 斤 = 100 fen),
// matching the stock model. fee_twd is integer New Taiwan Dollars.
//
// shipping_config JSON lives on seasons.shipping_config (added in P3). Two shapes:
//   { "type":"flat", "fee_twd":150 }
//   { "type":"threshold_jin", "free_over_fen":1000, "fee_twd":150 }

export type ShippingConfig =
  | { type: "flat"; fee_twd: number }
  | { type: "threshold_jin"; free_over_fen: number; fee_twd: number };

// Equals the DB-level default on seasons.shipping_config (P3). Used as the
// fallback whenever a season's config is null / malformed so customer orders
// never break on a bad config — they degrade to the legacy NT$150 flat fee.
export const DEFAULT_SHIPPING_CONFIG: ShippingConfig = { type: "flat", fee_twd: 150 };

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}
function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

// Parse seasons.shipping_config (string | null) into a validated ShippingConfig.
// ANY validation failure returns DEFAULT_SHIPPING_CONFIG (fail-safe, never throws).
export function parseShippingConfig(raw: string | null | undefined): ShippingConfig {
  if (!raw) return DEFAULT_SHIPPING_CONFIG;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return DEFAULT_SHIPPING_CONFIG;
  }
  if (typeof obj !== "object" || obj === null) return DEFAULT_SHIPPING_CONFIG;
  const o = obj as Record<string, unknown>;
  if (o.type === "flat") {
    if (!isNonNegativeInt(o.fee_twd)) return DEFAULT_SHIPPING_CONFIG;
    return { type: "flat", fee_twd: o.fee_twd };
  }
  if (o.type === "threshold_jin") {
    if (!isPositiveInt(o.free_over_fen)) return DEFAULT_SHIPPING_CONFIG;
    if (!isNonNegativeInt(o.fee_twd)) return DEFAULT_SHIPPING_CONFIG;
    return {
      type: "threshold_jin",
      free_over_fen: o.free_over_fen,
      fee_twd: o.fee_twd,
    };
  }
  return DEFAULT_SHIPPING_CONFIG;
}

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

// Compute shipping fee (TWD) for a given total weight (fen) under a config.
// Empty order (totalFen <= 0) is always 0.
export function computeShipping(totalFen: number, config: ShippingConfig): number {
  if (totalFen <= 0) return 0;
  if (config.type === "flat") return config.fee_twd;
  // threshold_jin
  return totalFen >= config.free_over_fen ? 0 : config.fee_twd;
}
