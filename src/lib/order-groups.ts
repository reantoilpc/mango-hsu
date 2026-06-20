// V7 併單 / order-groups pure logic. No env / DB — unit-testable.
// 1 斤 = 100 fen; money is integer TWD. Mirrors the split in admin-dashboard.ts /
// sales-summary.ts: pure helpers here, DB glue in the endpoints.
import { computeShipping, totalFenOf, type ShippingConfig } from "./shipping";

export type GroupStatus = "open" | "closed" | "shipped" | "cancelled";

// Deadline cap: a group can run at most this many days from creation.
export const MAX_GROUP_DAYS = 14;

// 5-digit code in 10000–99999 (always 5 chars, no leading-zero ambiguity).
// rand is injectable for deterministic tests; defaults to Math.random.
export function generateGroupCode(rand: () => number = Math.random): string {
  return String(10000 + Math.floor(rand() * 90000));
}

export function isValidGroupCode(s: string): boolean {
  return /^[1-9]\d{4}$/.test(s);
}

export function validateDeadline(
  deadlineIso: string,
  createdIso: string,
): { ok: true } | { ok: false; reason: string } {
  const d = Date.parse(deadlineIso);
  const c = Date.parse(createdIso);
  if (Number.isNaN(d) || Number.isNaN(c)) return { ok: false, reason: "bad deadline" };
  if (d <= c) return { ok: false, reason: "deadline must be in the future" };
  const maxMs = MAX_GROUP_DAYS * 24 * 3600 * 1000;
  if (d - c > maxMs) return { ok: false, reason: `deadline exceeds ${MAX_GROUP_DAYS} days` };
  return { ok: true };
}

export interface GroupOrderWeights {
  items: Array<{ package_fen: number; qty: number }>;
  cancelled?: boolean;
}

// The single fee the host bears: shipping computed over the COMBINED weight of all
// non-cancelled group orders, using the season's shipping config.
export function computeGroupShipping(
  orders: GroupOrderWeights[],
  config: ShippingConfig,
): number {
  let fen = 0;
  for (const o of orders) {
    if (o.cancelled) continue;
    fen += totalFenOf(o.items);
  }
  return computeShipping(fen, config);
}
