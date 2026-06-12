// Pure unit tests for order input validation — no stage env needed.
// Focus: phone validation now accepts TW mobile AND landline (added 2026-06-12).
import { describe, expect, it } from "bun:test";
import { validateCustomerOrder, validateAdminOrder } from "../src/lib/order-validate";

function order(phone: string) {
  return {
    name: "test-customer",
    phone,
    address: "台北市測試路 1 號",
    items: [{ sku: "TEST-1", qty: 1 }],
    pdpa_accepted: true,
  };
}

describe("order phone validation", () => {
  const accept = [
    "0912345678", // mobile
    "06-6902222", // landline with hyphen (Tainan)
    "0227117275", // landline, no hyphen (Taipei)
    "02-23456789", // landline with hyphen (Taipei)
    "066902222", // landline, no separators
    "02 2345 6789", // spaces tolerated
  ];
  for (const p of accept) {
    it(`accepts ${p}`, () => {
      expect(validateCustomerOrder(order(p))).toBeNull();
      // validateAdminOrder shares validateCommon, so it must agree.
      expect(validateAdminOrder(order(p))).toBeNull();
    });
  }

  const reject = [
    "12345678", // no leading 0
    "0912", // too short
    "091234567890", // too long (12 digits)
    "0912-345-6789012", // too long after stripping separators
    "abc", // letters
    "", // empty
  ];
  for (const p of reject) {
    it(`rejects ${JSON.stringify(p)}`, () => {
      const r = validateCustomerOrder(order(p));
      expect(r).not.toBeNull();
      expect(r?.error_code).toBe("INVALID_INPUT");
      expect(r?.message).toContain("電話");
    });
  }
});
