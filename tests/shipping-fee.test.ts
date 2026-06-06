import { test, expect, describe } from "bun:test";
import {
  FREE_SHIPPING_OVER_FEN,
  totalFenOf,
  shippingFeeFor,
} from "../src/lib/shipping-fee";

// Rule (pre-V6 interim, prod): 滿 10 斤免運、未滿收固定運費。
// Weight is in `fen` (1 斤 = 100 fen), matching the V5.2 stock model.

describe("totalFenOf — Σ(package_fen × qty)", () => {
  test("sums package_fen × qty across items", () => {
    expect(
      totalFenOf([
        { package_fen: 100, qty: 3 }, // 3 斤
        { package_fen: 50, qty: 2 }, // 1 斤
      ]),
    ).toBe(400);
  });

  test("ignores non-positive qty", () => {
    expect(
      totalFenOf([
        { package_fen: 100, qty: 0 },
        { package_fen: 50, qty: -2 },
      ]),
    ).toBe(0);
  });

  test("empty cart is 0 fen", () => {
    expect(totalFenOf([])).toBe(0);
  });
});

describe("shippingFeeFor — 滿 10 斤免運 / 未滿收固定額", () => {
  const FEE = 80;

  test("empty order pays no shipping", () => {
    expect(shippingFeeFor(0, FEE)).toBe(0);
  });

  test("under 10 斤 pays the fee", () => {
    expect(shippingFeeFor(100, FEE)).toBe(80); // 1 斤
    expect(shippingFeeFor(950, FEE)).toBe(80); // 9.5 斤
    expect(shippingFeeFor(999, FEE)).toBe(80); // just under 10 斤
  });

  test("exactly 10 斤 is free (threshold is inclusive)", () => {
    expect(shippingFeeFor(1000, FEE)).toBe(0);
    expect(shippingFeeFor(FREE_SHIPPING_OVER_FEN, FEE)).toBe(0);
  });

  test("over 10 斤 is free", () => {
    expect(shippingFeeFor(1500, FEE)).toBe(0); // 15 斤
  });

  test("fee amount is configurable (passed in, not hardcoded)", () => {
    expect(shippingFeeFor(100, 150)).toBe(150);
  });
});

test("free-shipping threshold is 10 斤 (1000 fen)", () => {
  expect(FREE_SHIPPING_OVER_FEN).toBe(1000);
});
