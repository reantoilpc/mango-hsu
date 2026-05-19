// Canonical items fingerprint used by /save's expected_state gate.
//
// V5 (current client format): client computes hash from the SSR-baked initial items as
// `sku:qty` pairs joined by `|` after sorting. Server recomputes from current order_items
// and compares — mismatch = another writer changed the items between the client's page-load
// and submit, return 409 STALE_STATE.
//
// V5.2 deploy compatibility (server-side dual-format):
// The client `itemsHash` function below stays unchanged — it still emits sku-based hashes.
// On the server, however, `compareItemsHash` tries BOTH the legacy sku-based formula AND
// the new product_id-based formula. This means:
//   - Old client JS (cached browser bundle) sending sku-hash → server matches via sku path
//   - New client JS sending product_id-hash → server matches via product_id path
// Either way, a real stale read still triggers STALE_STATE. The cost is one extra in-memory
// hash compute (~0.1ms).
//
// After PR3 lands and prod runs cleanly for ~2 weeks, the sku-hash branch can be deleted.
//
// Hash format: sort by key, join "key:qty" pairs with "|". Stable across platforms, no
// crypto needed (the value is not security-sensitive — it's a CAS check against accidental
// double-write, not protection from malicious tampering).

export function itemsHash(items: ReadonlyArray<{ sku: string; qty: number }>): string {
  return items
    .map((i) => `${i.sku}:${i.qty}`)
    .sort()
    .join("|");
}

// Server-side variant: compute hash from product_id (numeric) instead of sku.
// New client bundles will eventually emit this format via the same itemsHash function
// when SSR exposes product_id; until then, server uses this for the dual-format compare.
export function itemsHashByProductId(
  items: ReadonlyArray<{ product_id: number; qty: number }>,
): string {
  return items
    .map((i) => `${i.product_id}:${i.qty}`)
    .sort()
    .join("|");
}

// Server-side dual-format comparator. `current` is what the server reads from
// order_items (always has both sku and product_id). `clientHash` is what the client
// sent in expected_state.items_hash. Returns true if either format matches.
//
// Edge case considered: cross-season same SKU different product_id. In normal admin
// usage, an admin only edits orders in the active season, so the cached old-JS
// sku-hash matching is safe. The corner where it could "false-match" requires admin
// to be editing a historical/archived season's order — out of scope for current
// product (admin UI doesn't expose that).
export function compareItemsHash(
  current: ReadonlyArray<{ sku: string; product_id: number; qty: number }>,
  clientHash: string,
): boolean {
  if (itemsHash(current) === clientHash) return true;
  if (itemsHashByProductId(current) === clientHash) return true;
  return false;
}
