import { test, expect } from "bun:test";
import { shippingFor } from "../src/lib/order-response";
import type { AppEnv } from "../src/db/client";

// shippingFor now computes by weight (斤), reading the flat fee from env.SHIPPING_FEE_TWD
// and applying the 10-斤 free-shipping threshold via src/lib/shipping-fee.ts.
const env = { SHIPPING_FEE_TWD: "80" } as unknown as AppEnv;

test("shippingFor: under 10 斤 charges the env fee", () => {
  expect(shippingFor([{ sku: "DRY-JH-1", qty: 1, package_fen: 100 }], env)).toBe(80);
});

test("shippingFor: at/over 10 斤 is free", () => {
  // 10 × 1斤 = 1000 fen
  expect(shippingFor([{ sku: "DRY-JH-1", qty: 10, package_fen: 100 }], env)).toBe(0);
  // 20 × 半斤 = 1000 fen (mixed sizes still summed by weight)
  expect(shippingFor([{ sku: "DRY-JH-05", qty: 20, package_fen: 50 }], env)).toBe(0);
});

test("shippingFor: empty order is free", () => {
  expect(shippingFor([], env)).toBe(0);
});
