// Pure unit test for the new shippingFor() adapter signature.
// shippingFor now takes resolved items (with package_fen) + a parsed ShippingConfig,
// delegating math to src/lib/shipping.ts. No env required.
import { describe, expect, it } from "bun:test";
import { shippingFor } from "../src/lib/order-response";
import type { ShippingConfig } from "../src/lib/shipping";

const flat: ShippingConfig = { type: "flat", fee_twd: 150 };
const thr: ShippingConfig = { type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 };

describe("shippingFor (V6 adapter)", () => {
  it("flat: charges fee for any non-empty order", () => {
    expect(shippingFor([{ package_fen: 50, qty: 1 }], flat)).toBe(150);
  });

  it("flat: 0 for empty items", () => {
    expect(shippingFor([], flat)).toBe(0);
  });

  it("threshold: aggregates package_fen×qty across mixed package sizes", () => {
    // 1斤×9 + 半斤×2 = 900 + 100 = 1000 fen → exactly 10 斤 → 免運
    expect(
      shippingFor(
        [
          { package_fen: 100, qty: 9 },
          { package_fen: 50, qty: 2 },
        ],
        thr,
      ),
    ).toBe(0);
  });

  it("threshold: below threshold charges fee", () => {
    // 1斤×9 = 900 fen < 1000 → 收 150
    expect(shippingFor([{ package_fen: 100, qty: 9 }], thr)).toBe(150);
  });
});
