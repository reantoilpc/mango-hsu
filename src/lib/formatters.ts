import type { OrderItem, Product } from "../db/schema";

export function itemsToReadable(
  items: Array<OrderItem & { product?: Product }>,
): string {
  if (items.length === 0) return "(無品項)";
  return items
    .map((i) => {
      const label = i.product ? `${i.product.name}${i.product.variant}` : i.sku;
      return `${label} ×${i.qty}`;
    })
    .join("、");
}

// Aggregate SKU totals across multiple orders for picking mode.
// Input: orders with items hydrated.
// Output: array of { sku, name, variant, totalQty } sorted by display_order.
export function aggregateSkuTotals(
  orders: Array<{ items: Array<OrderItem & { product?: Product }> }>,
): Array<{ sku: string; label: string; totalQty: number; displayOrder: number }> {
  const map = new Map<
    string,
    { sku: string; label: string; totalQty: number; displayOrder: number }
  >();
  for (const o of orders) {
    for (const i of o.items) {
      const label = i.product ? `${i.product.name}${i.product.variant}` : i.sku;
      const existing = map.get(i.sku);
      if (existing) {
        existing.totalQty += i.qty;
      } else {
        map.set(i.sku, {
          sku: i.sku,
          label,
          totalQty: i.qty,
          displayOrder: i.product?.display_order ?? 9999,
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.displayOrder - b.displayOrder);
}

// Convert UTC ISO to display-friendly Taipei +08:00 string.
export function formatTaipei(utcIso: string): string {
  const d = new Date(utcIso);
  const taipei = new Date(d.getTime() + 8 * 3600_000);
  const yyyy = taipei.getUTCFullYear();
  const mm = String(taipei.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(taipei.getUTCDate()).padStart(2, "0");
  const HH = String(taipei.getUTCHours()).padStart(2, "0");
  const MM = String(taipei.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}`;
}
