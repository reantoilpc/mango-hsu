// V4 admin endpoint idempotency tests against stage worker.
// Tests the cross-channel half: wife relays an aunt order via admin endpoint;
// double-clicks must not consume stock twice.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  getSkuStock,
  seedSku,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SKU = "test-mango-admin";

beforeEach(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
});

async function adminPostOrder(opts: {
  cookie: string;
  idempotencyKey: string;
  qty: number;
}): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: STAGE_URL, // pass requireSameOrigin
      Cookie: opts.cookie,
    },
    body: JSON.stringify({
      idempotency_key: opts.idempotencyKey,
      name: "test-aunt-relay",
      phone: "0912345678",
      address: "test address 200",
      items: [{ sku: TEST_SKU, qty: opts.qty }],
      notes: "test admin order",
    }),
  });
}

describe("V4 admin orders idempotency", () => {
  it("two sequential POSTs with same key replay (no double stock decrement)", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU, { stock: 10 });
    const cookie = createTestAdminSession();

    const idem = `test-${crypto.randomUUID()}`;
    const r1 = await adminPostOrder({ cookie, idempotencyKey: idem, qty: 2 });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { ok: boolean; order_id?: string };
    expect(b1.ok).toBe(true);
    expect(getSkuStock(TEST_SKU)).toBe(8);

    // Same idem key — wife double-click after committed first request
    const r2 = await adminPostOrder({ cookie, idempotencyKey: idem, qty: 2 });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { ok: boolean; order_id?: string; replayed?: boolean };
    expect(b2.ok).toBe(true);
    expect(b2.order_id).toBe(b1.order_id);

    // Stock unchanged from first request — no double decrement.
    expect(getSkuStock(TEST_SKU)).toBe(8);
  });

  it("concurrent POSTs with same key resolve to single order", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU, { stock: 10 });
    const cookie = createTestAdminSession();

    const idem = `test-${crypto.randomUUID()}`;
    const [r1, r2] = await Promise.all([
      adminPostOrder({ cookie, idempotencyKey: idem, qty: 3 }),
      adminPostOrder({ cookie, idempotencyKey: idem, qty: 3 }),
    ]);
    const b1 = (await r1.json()) as { ok: boolean; order_id?: string };
    const b2 = (await r2.json()) as { ok: boolean; order_id?: string };

    // Both get ok response (one INSERTs, the other replays via UNIQUE catch).
    expect(b1.ok && b2.ok).toBe(true);
    expect(b1.order_id).toBe(b2.order_id);

    // Stock decremented exactly once.
    expect(getSkuStock(TEST_SKU)).toBe(7);
  });
});
