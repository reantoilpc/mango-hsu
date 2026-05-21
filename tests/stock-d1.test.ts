// V5.2 D1 integration tests against stage worker. Requires:
//   MANGO_STAGE_URL  — e.g. https://mango-hsu-stage.rhsu.workers.dev
//   TEST_TOKEN       — stage's ORDER_TOKEN (NEVER prod's)
//   wrangler login completed (or CLOUDFLARE_API_TOKEN env var set)
//
// V5.2 changes:
//   - Stock now lives on product_groups.stock_fen (fen units, 100 fen = 1斤)
//   - Tests assert against group stock_fen rather than per-SKU stock count
//   - SOLD_OUT errors carry sold_out_group_id (not sold_out_sku)
//
// Each test seeds its own season + group + SKU, and cleans up after.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  TEST_TOKEN,
  cleanupTestData,
  cleanupTestAdmin,
  getGroupStockFen,
  seedActiveSeasonScenario,
  skipIfNoIntegration,
  stageFetch,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SEASON_CODE = "test-stock-d1-season";
const TEST_GROUP_SLUG = "test-stock-d1-group";
const TEST_SKU = "TEST-MANGO-D1";
const PACKAGE_FEN = 100; // 1 斤 per package

let testGroupId = 0;

beforeEach(() => {
  if (SKIP) return;
  cleanupTestData();
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
});

function seedScenario(initialFen: number) {
  const r = seedActiveSeasonScenario({
    season_code: TEST_SEASON_CODE,
    group_slug: TEST_GROUP_SLUG,
    initial_stock_fen: initialFen,
    skus: [{ sku: TEST_SKU, package_fen: PACKAGE_FEN }],
  });
  testGroupId = r.group_id;
}

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

describe("V5.2 stock atomic decrement (group fen pool)", () => {
  it("single order decrements group stock_fen by qty × package_fen", async () => {
    if (SKIP) return;
    seedScenario(10 * PACKAGE_FEN); // 10 packages worth

    const res = await postCustomerOrder({ qty: 3 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const remaining = getGroupStockFen(testGroupId);
    expect(remaining).toBe(7 * PACKAGE_FEN);
  });

  it("two concurrent orders for the last unit: 1 success, 1 SOLD_OUT with group_id", async () => {
    if (SKIP) return;
    seedScenario(1 * PACKAGE_FEN);

    const [r1, r2] = await Promise.all([
      postCustomerOrder({ qty: 1 }),
      postCustomerOrder({ qty: 1 }),
    ]);
    const b1 = (await r1.json()) as {
      ok: boolean;
      error_code?: string;
      sold_out_group_id?: number;
    };
    const b2 = (await r2.json()) as {
      ok: boolean;
      error_code?: string;
      sold_out_group_id?: number;
    };

    const okCount = [b1, b2].filter((b) => b.ok).length;
    const soldOuts = [b1, b2].filter((b) => !b.ok && b.error_code === "SOLD_OUT");
    expect(okCount).toBe(1);
    expect(soldOuts.length).toBe(1);
    // SOLD_OUT should carry the group_id of the offending pool
    expect(soldOuts[0]!.sold_out_group_id).toBe(testGroupId);

    expect(getGroupStockFen(testGroupId)).toBe(0);
  });

  it("group stock_fen=0 rejects new order with SOLD_OUT", async () => {
    if (SKIP) return;
    seedScenario(0);

    const res = await postCustomerOrder({ qty: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      error_code?: string;
      sold_out_group_id?: number;
    };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("SOLD_OUT");
    expect(body.sold_out_group_id).toBe(testGroupId);

    expect(getGroupStockFen(testGroupId)).toBe(0);
  });

  it("idempotency replay returns existing order, no double decrement", async () => {
    if (SKIP) return;
    seedScenario(10 * PACKAGE_FEN);

    const idem = `test-idem-${crypto.randomUUID()}`;
    const r1 = await postCustomerOrder({ qty: 2, idempotencyKey: idem });
    expect(r1.status).toBe(200);
    expect(getGroupStockFen(testGroupId)).toBe(8 * PACKAGE_FEN);

    // Second request with same idem replays
    const r2 = await postCustomerOrder({ qty: 2, idempotencyKey: idem });
    const b2 = (await r2.json()) as { ok: boolean; order_id?: string };
    expect(b2.ok).toBe(true);

    // Stock unchanged from first request — no double decrement.
    expect(getGroupStockFen(testGroupId)).toBe(8 * PACKAGE_FEN);
  });

  it("after cancel, stock is restored", async () => {
    if (SKIP) return;
    // This test relies on cancel flow — needs admin session.
    // Marked TODO until cancel test infra (admin session) is wired up separately;
    // covered in tests/group-stock.test.ts integration scenarios.
    return;
  });
});
