// Canonical items fingerprint used by /save's expected_state gate.
//
// Client computes from the SSR-baked initial items, sends it alongside
// expected_state on POST. Server recomputes from current order_items and
// compares — mismatch = another writer changed the items between the client's
// page-load and submit, return 409 STALE_STATE.
//
// Hash format: sort by sku, join "sku:qty" pairs with "|". Stable across
// platforms, no crypto needed (the value is not security-sensitive — it's a
// CAS check against accidental double-write, not protection from malicious
// tampering).

export function itemsHash(items: ReadonlyArray<{ sku: string; qty: number }>): string {
  return items
    .map((i) => `${i.sku}:${i.qty}`)
    .sort()
    .join("|");
}
