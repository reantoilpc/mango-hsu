// Pure unit tests for src/lib/shipping.ts — no env / no D1 / no network.
// Covers spec §5.5 shipping-config math: flat / threshold_jin / 0 件 / 剛好門檻 / 邊界.
import { describe, expect, it } from "bun:test";
import {
  parseShippingConfig,
  computeShipping,
  totalFenOf,
  describeShipping,
  DEFAULT_SHIPPING_CONFIG,
  type ShippingConfig,
} from "../src/lib/shipping";

describe("parseShippingConfig", () => {
  it("parses a valid flat config", () => {
    const c = parseShippingConfig('{"type":"flat","fee_twd":150}');
    expect(c).toEqual({ type: "flat", fee_twd: 150 });
  });

  it("parses a valid threshold_jin config", () => {
    const c = parseShippingConfig('{"type":"threshold_jin","free_over_fen":1000,"fee_twd":150}');
    expect(c).toEqual({ type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 });
  });

  it("falls back to DEFAULT for null", () => {
    expect(parseShippingConfig(null)).toEqual(DEFAULT_SHIPPING_CONFIG);
  });

  it("falls back to DEFAULT for empty string", () => {
    expect(parseShippingConfig("")).toEqual(DEFAULT_SHIPPING_CONFIG);
  });

  it("falls back to DEFAULT for malformed JSON", () => {
    expect(parseShippingConfig("{not json")).toEqual(DEFAULT_SHIPPING_CONFIG);
  });

  it("falls back to DEFAULT for unknown type", () => {
    expect(parseShippingConfig('{"type":"tiered","fee_twd":150}')).toEqual(
      DEFAULT_SHIPPING_CONFIG,
    );
  });

  it("falls back to DEFAULT when flat is missing fee_twd", () => {
    expect(parseShippingConfig('{"type":"flat"}')).toEqual(DEFAULT_SHIPPING_CONFIG);
  });

  it("falls back to DEFAULT when threshold_jin is missing free_over_fen", () => {
    expect(parseShippingConfig('{"type":"threshold_jin","fee_twd":150}')).toEqual(
      DEFAULT_SHIPPING_CONFIG,
    );
  });

  it("falls back to DEFAULT when fee_twd is negative", () => {
    expect(parseShippingConfig('{"type":"flat","fee_twd":-5}')).toEqual(
      DEFAULT_SHIPPING_CONFIG,
    );
  });

  it("falls back to DEFAULT when free_over_fen is not a positive integer", () => {
    expect(
      parseShippingConfig('{"type":"threshold_jin","free_over_fen":0,"fee_twd":150}'),
    ).toEqual(DEFAULT_SHIPPING_CONFIG);
    expect(
      parseShippingConfig('{"type":"threshold_jin","free_over_fen":12.5,"fee_twd":150}'),
    ).toEqual(DEFAULT_SHIPPING_CONFIG);
  });

  it("coerces fee_twd=0 (free shipping) as a valid flat config", () => {
    expect(parseShippingConfig('{"type":"flat","fee_twd":0}')).toEqual({
      type: "flat",
      fee_twd: 0,
    });
  });
});

describe("totalFenOf", () => {
  it("sums package_fen × qty across items", () => {
    expect(
      totalFenOf([
        { package_fen: 100, qty: 3 }, // 3 斤
        { package_fen: 50, qty: 2 }, // 1 斤
      ]),
    ).toBe(400);
  });

  it("returns 0 for empty items", () => {
    expect(totalFenOf([])).toBe(0);
  });

  it("ignores non-positive qty defensively", () => {
    expect(totalFenOf([{ package_fen: 100, qty: 0 }])).toBe(0);
  });
});

describe("computeShipping — flat", () => {
  const flat: ShippingConfig = { type: "flat", fee_twd: 150 };

  it("charges fee_twd when totalFen > 0", () => {
    expect(computeShipping(100, flat)).toBe(150);
  });

  it("charges 0 when totalFen === 0", () => {
    expect(computeShipping(0, flat)).toBe(0);
  });

  it("flat with fee_twd=0 always 0", () => {
    expect(computeShipping(500, { type: "flat", fee_twd: 0 })).toBe(0);
  });
});

describe("computeShipping — threshold_jin", () => {
  const thr: ShippingConfig = {
    type: "threshold_jin",
    free_over_fen: 1000, // 滿 10 斤免運
    fee_twd: 150,
  };

  it("charges fee_twd below threshold", () => {
    expect(computeShipping(500, thr)).toBe(150); // 5 斤
  });

  it("免運 exactly at threshold (>= 邊界)", () => {
    expect(computeShipping(1000, thr)).toBe(0); // 剛好 10 斤
  });

  it("免運 above threshold", () => {
    expect(computeShipping(1500, thr)).toBe(0); // 15 斤
  });

  it("1 fen below threshold still charges", () => {
    expect(computeShipping(999, thr)).toBe(150);
  });

  it("0 件 (totalFen=0) charges 0 even under threshold", () => {
    expect(computeShipping(0, thr)).toBe(0);
  });
});

describe("describeShipping", () => {
  it("flat fee", () => {
    expect(describeShipping({ type: "flat", fee_twd: 150 })).toBe("每筆訂單運費 $150 元。");
  });
  it("flat free", () => {
    expect(describeShipping({ type: "flat", fee_twd: 0 })).toBe("全館免運。");
  });
  it("threshold whole 斤", () => {
    expect(
      describeShipping({ type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 }),
    ).toBe("滿 10 斤免運，未滿每筆訂單運費 $150 元。");
  });
  it("threshold fractional 斤", () => {
    expect(
      describeShipping({ type: "threshold_jin", free_over_fen: 50, fee_twd: 150 }),
    ).toBe("滿 0.50 斤免運，未滿每筆訂單運費 $150 元。");
  });
});
