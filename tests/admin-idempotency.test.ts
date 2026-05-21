// V5.2 admin endpoint idempotency tests against stage worker.
// Tests the cross-channel half: wife relays an aunt order via admin endpoint;
// double-clicks must not consume stock twice.
//
// V5.2 changes: stock assertions now check group_stock_fen instead of per-SKU count.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  getGroupStockFen,
  seedActiveSeasonScenario,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SEASON_CODE = "test-admin-idem-season";
const TEST_GROUP_SLUG = "test-admin-idem-group";
const TEST_SKU = "TEST-MANGO-ADMIN";
const PACKAGE_FEN = 100; // 1 斤

let testGroupId = 0;

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

function seedScenario(initialFen: number) {
  const r = seedActiveSeasonScenario({
    season_code: TEST_SEASON_CODE,
    group_slug: TEST_GROUP_SLUG,
    initial_stock_fen: initialFen,
    skus: [{ sku: TEST_SKU, package_fen: PACKAGE_FEN }],
  });
  testGroupId = r.group_id;
}

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

describe("V5.2 admin orders idempotency", () => {
  it("two sequential POSTs with same key replay (no double group stock decrement)", async () => {
    if (SKIP) return;
    seedScenario(10 * PACKAGE_FEN);
    const cookie = createTestAdminSession();

    const idem = `test-${crypto.randomUUID()}`;
    const r1 = await adminPostOrder({ cookie, idempotencyKey: idem, qty: 2 });
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { ok: boolean; order_id?: string };
    expect(b1.ok).toBe(true);
    expect(getGroupStockFen(testGroupId)).toBe(8 * PACKAGE_FEN);

    // Same idem key — wife double-click after committed first request
    const r2 = await adminPostOrder({ cookie, idempotencyKey: idem, qty: 2 });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as {
      ok: boolean;
      order_id?: string;
      replayed?: boolean;
    };
    expect(b2.ok).toBe(true);
    expect(b2.order_id).toBe(b1.order_id);

    // Group stock unchanged from first request — no double decrement.
    expect(getGroupStockFen(testGroupId)).toBe(8 * PACKAGE_FEN);
  });

  it("concurrent POSTs with same key resolve to single order", async () => {
    if (SKIP) return;
    seedScenario(10 * PACKAGE_FEN);
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

    // Group stock decremented exactly once.
    expect(getGroupStockFen(testGroupId)).toBe(7 * PACKAGE_FEN);
  });
});
