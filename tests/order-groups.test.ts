import { describe, expect, it } from "bun:test";
import {
  generateGroupCode,
  isValidGroupCode,
  validateDeadline,
  computeGroupShipping,
} from "../src/lib/order-groups";
import type { ShippingConfig } from "../src/lib/shipping";

describe("group code", () => {
  it("generates a 5-digit code in 10000–99999", () => {
    expect(generateGroupCode(() => 0)).toBe("10000");
    expect(generateGroupCode(() => 0.999999)).toBe("99999");
    const c = generateGroupCode();
    expect(c).toMatch(/^[1-9]\d{4}$/);
  });
  it("validates code format", () => {
    expect(isValidGroupCode("10000")).toBe(true);
    expect(isValidGroupCode("99999")).toBe(true);
    expect(isValidGroupCode("01234")).toBe(false); // leading zero
    expect(isValidGroupCode("1234")).toBe(false); // 4 digits
    expect(isValidGroupCode("123456")).toBe(false);
    expect(isValidGroupCode("1a234")).toBe(false);
  });
});

describe("validateDeadline", () => {
  const created = "2026-06-20T00:00:00.000Z";
  it("accepts a future deadline within 14 days", () => {
    expect(validateDeadline("2026-06-27T00:00:00.000Z", created).ok).toBe(true);
    expect(validateDeadline("2026-07-04T00:00:00.000Z", created).ok).toBe(true); // exactly +14d
  });
  it("rejects past / non-future", () => {
    expect(validateDeadline("2026-06-19T00:00:00.000Z", created).ok).toBe(false);
    expect(validateDeadline(created, created).ok).toBe(false);
  });
  it("rejects > 14 days", () => {
    expect(validateDeadline("2026-07-04T00:00:01.000Z", created).ok).toBe(false);
  });
  it("rejects unparseable", () => {
    expect(validateDeadline("not-a-date", created).ok).toBe(false);
  });
});

describe("computeGroupShipping", () => {
  const flat: ShippingConfig = { type: "flat", fee_twd: 150 };
  const threshold: ShippingConfig = { type: "threshold_jin", free_over_fen: 1000, fee_twd: 150 };
  const orders = [
    { items: [{ package_fen: 100, qty: 2 }] }, // 200 fen
    { items: [{ package_fen: 100, qty: 1 }] }, // 100 fen
  ];
  it("flat: one fee regardless of weight", () => {
    expect(computeGroupShipping(orders, flat)).toBe(150);
  });
  it("threshold: under → fee, over → 0", () => {
    expect(computeGroupShipping(orders, threshold)).toBe(150); // 300 < 1000
    const big = [{ items: [{ package_fen: 100, qty: 12 }] }]; // 1200 ≥ 1000
    expect(computeGroupShipping(big, threshold)).toBe(0);
  });
  it("excludes cancelled orders from the combined weight", () => {
    const withCancel = [
      { items: [{ package_fen: 100, qty: 12 }], cancelled: true }, // ignored
      { items: [{ package_fen: 100, qty: 1 }] }, // 100 fen
    ];
    expect(computeGroupShipping(withCancel, threshold)).toBe(150); // only 100 fen counts
  });
  it("empty → 0", () => {
    expect(computeGroupShipping([], flat)).toBe(0);
  });
});
