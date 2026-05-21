// V5.2 items-hash dual-format unit tests.
//
// Pure unit — no D1, no stage worker. Tests the server-side compareItemsHash logic that
// makes deploys backward-compatible: client may send a sku-based hash (cached old JS) or
// a product_id-based hash (post-PR2 client); server tries both and accepts either.

import { describe, expect, it } from "bun:test";
import {
  itemsHash,
  itemsHashByProductId,
  compareItemsHash,
} from "../src/lib/items-hash";

describe("V5 itemsHash (sku-based, client-side)", () => {
  it("hashes single item", () => {
    expect(itemsHash([{ sku: "DRY-JH-1", qty: 2 }])).toBe("DRY-JH-1:2");
  });

  it("sorts by sku for stability", () => {
    const a = itemsHash([
      { sku: "DRY-AW-1", qty: 1 },
      { sku: "DRY-JH-1", qty: 2 },
    ]);
    const b = itemsHash([
      { sku: "DRY-JH-1", qty: 2 },
      { sku: "DRY-AW-1", qty: 1 },
    ]);
    expect(a).toBe(b);
    expect(a).toBe("DRY-AW-1:1|DRY-JH-1:2");
  });

  it("empty array hashes to empty string", () => {
    expect(itemsHash([])).toBe("");
  });
});

describe("V5.2 itemsHashByProductId (server-side new format)", () => {
  it("hashes single item by numeric product_id", () => {
    expect(itemsHashByProductId([{ product_id: 42, qty: 2 }])).toBe("42:2");
  });

  it("sorts by string-form product_id for stability", () => {
    // Note: sort is lexicographic since `${product_id}` is a string. This is OK
    // because hash is opaque — both client and server use the same sort.
    const a = itemsHashByProductId([
      { product_id: 100, qty: 1 },
      { product_id: 2, qty: 3 },
    ]);
    const b = itemsHashByProductId([
      { product_id: 2, qty: 3 },
      { product_id: 100, qty: 1 },
    ]);
    expect(a).toBe(b);
  });
});

describe("V5.2 compareItemsHash (server-side dual-format)", () => {
  it("matches when client sends sku-based hash (legacy JS bundle)", () => {
    const current = [
      { sku: "DRY-JH-1", product_id: 42, qty: 2 },
      { sku: "DRY-AW-1", product_id: 99, qty: 1 },
    ];
    const clientSkuHash = itemsHash([
      { sku: "DRY-JH-1", qty: 2 },
      { sku: "DRY-AW-1", qty: 1 },
    ]);
    expect(compareItemsHash(current, clientSkuHash)).toBe(true);
  });

  it("matches when client sends product_id-based hash (new JS bundle)", () => {
    const current = [
      { sku: "DRY-JH-1", product_id: 42, qty: 2 },
      { sku: "DRY-AW-1", product_id: 99, qty: 1 },
    ];
    const clientPidHash = itemsHashByProductId([
      { product_id: 42, qty: 2 },
      { product_id: 99, qty: 1 },
    ]);
    expect(compareItemsHash(current, clientPidHash)).toBe(true);
  });

  it("rejects truly stale hash (different qty)", () => {
    const current = [{ sku: "DRY-JH-1", product_id: 42, qty: 2 }];
    const stale = itemsHash([{ sku: "DRY-JH-1", qty: 5 }]);
    expect(compareItemsHash(current, stale)).toBe(false);
  });

  it("rejects truly stale hash (different sku)", () => {
    const current = [{ sku: "DRY-JH-1", product_id: 42, qty: 2 }];
    const stale = itemsHash([{ sku: "DRY-AW-1", qty: 2 }]);
    expect(compareItemsHash(current, stale)).toBe(false);
  });

  it("cross-season corner case: same sku, different product_id", () => {
    // Admin editing 2026's order. Current has product_id=42 (2026 product).
    // Client sent sku-hash from when they loaded the page.
    // Across 2027 there's another product_id=99 with same sku (e.g. DRY-JH-1).
    // The sku-hash MIGHT false-match if the same sku exists across seasons.
    // This is documented as acceptable — admins don't normally edit archived seasons.
    const current = [{ sku: "DRY-JH-1", product_id: 42, qty: 2 }];
    const clientSkuHash = `DRY-JH-1:2`;
    expect(compareItemsHash(current, clientSkuHash)).toBe(true);
    // A product_id-based hash for a hypothetical 2027 product (id=99) would NOT match.
    const wrongPidHash = `99:2`;
    expect(compareItemsHash(current, wrongPidHash)).toBe(false);
  });

  it("empty current matches empty hash", () => {
    expect(compareItemsHash([], "")).toBe(true);
  });
});
