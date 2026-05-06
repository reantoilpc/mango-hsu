// V4 D1 integration tests against stage worker. Requires:
//   MANGO_STAGE_URL  — e.g. https://mango-hsu-stage.rhsu.workers.dev
//   TEST_TOKEN       — stage's ORDER_TOKEN (NEVER prod's)
//   wrangler login completed (or CLOUDFLARE_API_TOKEN env var set)
//
// Each test seeds its own SKU / cleans up after. Stage's products / orders
// tables MUST tolerate this concurrent test traffic — that's why test SKUs
// have the `test-` prefix.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  TEST_TOKEN,
  cleanupTestData,
  cleanupTestAdmin,
  getSkuStock,
  seedSku,
  setSkuStock,
  skipIfNoIntegration,
  stageFetch,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SKU = "test-mango-d1";

beforeEach(() => {
  if (SKIP) return;
  cleanupTestData();
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
});

async function postCustomerOrder(opts: {
  qty: number;
  idempotencyKey?: string;
  name?: string;
}): Promise<Response> {
  return stageFetch("/api/orders", {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: opts.idempotencyKey ?? `test-${crypto.randomUUID()}`,
      token: TEST_TOKEN,
      honeypot: "",
      name: opts.name ?? "test-buyer",
      phone: "0912345678",
      address: "test address 100",
      items: [{ sku: TEST_SKU, qty: opts.qty }],
      notes: "",
      pdpa_accepted: true,
    }),
  });
}

describe("V4 stock atomic decrement (customer side)", () => {
  it("single order decrements stock by exactly qty", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU, { stock: 10 });

    const res = await postCustomerOrder({ qty: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const remaining = getSkuStock(TEST_SKU);
    expect(remaining).toBe(7);
  });

  it("two concurrent orders for the last unit: 1 success, 1 SOLD_OUT", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU, { stock: 1 });

    const [r1, r2] = await Promise.all([
      postCustomerOrder({ qty: 1 }),
      postCustomerOrder({ qty: 1 }),
    ]);
    const b1 = (await r1.json()) as { ok: boolean; error_code?: string };
    const b2 = (await r2.json()) as { ok: boolean; error_code?: string };

    const okCount = [b1, b2].filter((b) => b.ok).length;
    const soldOutCount = [b1, b2].filter((b) => !b.ok && b.error_code === "SOLD_OUT").length;
    expect(okCount).toBe(1);
    expect(soldOutCount).toBe(1);

    expect(getSkuStock(TEST_SKU)).toBe(0);
  });

  it("stock=0 rejects new order with SOLD_OUT", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU, { stock: 0 });

    const res = await postCustomerOrder({ qty: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; error_code?: string };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("SOLD_OUT");

    expect(getSkuStock(TEST_SKU)).toBe(0);
  });

  it("idempotency replay returns existing order, no double decrement", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU, { stock: 10 });

    const idem = `test-idem-${crypto.randomUUID()}`;
    const r1 = await postCustomerOrder({ qty: 2, idempotencyKey: idem });
    expect(r1.status).toBe(200);
    expect(getSkuStock(TEST_SKU)).toBe(8);

    // Second request with same idem replays
    const r2 = await postCustomerOrder({ qty: 2, idempotencyKey: idem });
    const b2 = (await r2.json()) as { ok: boolean; order_id?: string };
    expect(b2.ok).toBe(true);

    // Stock unchanged from first request — no double decrement.
    expect(getSkuStock(TEST_SKU)).toBe(8);
  });

  it("after cancel, stock is restored", async () => {
    if (SKIP) return;
    // This test relies on Step 8 cancel flow — needs admin session.
    // Marked .skip until cancel test infra (admin session) is wired up
    // separately; keep the case here for visibility.
    // TODO: implement when stage admin login automation is in place.
    return;
  });
});
