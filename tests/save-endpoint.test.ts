// V5.2 /api/admin/orders/:id/save integration tests.
//
// Verifies the gate-first batch pattern: expected_state validation, server-side field diff,
// items diff with group fen CAS, idempotency replay, read-only state guards.
//
// V5.2 changes:
//   - Stock assertions check group stock_fen.
//   - items_hash is checked dual-format on the server (sku-based OR product_id-based).
//   - current_state no longer echoes items_hash (client doesn't need it; uses currently-loaded
//     items + recompute on STALE).
//
// Skipped without MANGO_STAGE_URL + TEST_TOKEN.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  TEST_TOKEN,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  getGroupStockFen,
  seedActiveSeasonScenario,
  seedGroup,
  seedProductInSeason,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SEASON_CODE = "test-save-season";
const TEST_GROUP_SLUG = "test-save-group-a";
const TEST_GROUP_SLUG_B = "test-save-group-b";
const TEST_SKU_A = "TEST-MANGO-SAVE-A";
const TEST_SKU_B = "TEST-MANGO-SAVE-B";
const PACKAGE_FEN = 100;

let testGroupId = 0;
let testGroupIdB = 0;
let seasonId = 0;

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

function seedSingle(initialFen: number) {
  const r = seedActiveSeasonScenario({
    season_code: TEST_SEASON_CODE,
    group_slug: TEST_GROUP_SLUG,
    initial_stock_fen: initialFen,
    skus: [{ sku: TEST_SKU_A, package_fen: PACKAGE_FEN }],
  });
  testGroupId = r.group_id;
  seasonId = r.season_id;
}

function seedTwoGroupsTwoSkus(initialFenA: number, initialFenB: number) {
  // Group A with SKU A
  const r = seedActiveSeasonScenario({
    season_code: TEST_SEASON_CODE,
    group_slug: TEST_GROUP_SLUG,
    initial_stock_fen: initialFenA,
    skus: [{ sku: TEST_SKU_A, package_fen: PACKAGE_FEN }],
  });
  testGroupId = r.group_id;
  seasonId = r.season_id;

  // Group B with SKU B (separate pool)
  testGroupIdB = seedGroup({
    season_id: seasonId,
    slug: TEST_GROUP_SLUG_B,
    stock_fen: initialFenB,
  });
  seedProductInSeason({
    season_id: seasonId,
    group_id: testGroupIdB,
    sku: TEST_SKU_B,
    package_fen: PACKAGE_FEN,
    price: 200,
  });
}

async function placeCustomerOrder(sku: string, qty: number): Promise<string> {
  const res = await fetch(`${STAGE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Mode": "1" },
    body: JSON.stringify({
      idempotency_key: `test-${crypto.randomUUID()}`,
      token: TEST_TOKEN,
      honeypot: "",
      name: "test-buyer",
      phone: "0912345678",
      address: "test address 300",
      items: [{ sku, qty }],
      notes: "",
      pdpa_accepted: true,
    }),
  });
  const body = (await res.json()) as { ok: boolean; order_id?: string };
  if (!body.ok || !body.order_id) {
    throw new Error(`placeCustomerOrder failed: ${JSON.stringify(body)}`);
  }
  return body.order_id;
}

interface SavePayload {
  items?: Array<{ sku: string; qty: number }>;
  address?: string;
  notes?: string;
  expected_state: {
    paid: boolean;
    shipped: boolean;
    cancelled_at: string | null;
    items_hash?: string;
  };
  idempotency_key?: string;
}

async function adminSave(
  cookie: string,
  orderId: string,
  payload: SavePayload,
): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/orders/${orderId}/save`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: STAGE_URL,
      Cookie: cookie,
    },
    body: JSON.stringify(payload),
  });
}

describe("V5.2 /save endpoint", () => {
  it("address-only edit: server-side diff audits and returns updated order", async () => {
    if (SKIP) return;
    seedSingle(5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 2);

    const res = await adminSave(cookie, orderId, {
      address: "new test address 999",
      expected_state: { paid: false, shipped: false, cancelled_at: null },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; order: { address: string } };
    expect(body.ok).toBe(true);
    expect(body.order.address).toBe("new test address 999");
  });

  it("server-side diff: same value as DB does NOT audit", async () => {
    if (SKIP) return;
    seedSingle(5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 2);

    const res = await adminSave(cookie, orderId, {
      address: "test address 300",
      expected_state: { paid: false, shipped: false, cancelled_at: null },
    });
    expect(res.status).toBe(200);

    const auditRows = d1Execute(
      `SELECT action FROM audit_log WHERE order_id = '${orderId}' AND action = 'order_save'`,
    ) as Array<{ action: string }>;
    expect(auditRows.length).toBe(0);
  });

  it("stale expected_state returns 409 STALE_STATE with current_state", async () => {
    if (SKIP) return;
    seedSingle(5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 1);

    const paidRes = await fetch(`${STAGE_URL}/api/admin/orders/${orderId}/mark-paid`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STAGE_URL, Cookie: cookie },
    });
    expect(paidRes.status).toBe(200);

    const res = await adminSave(cookie, orderId, {
      address: "another address 400",
      expected_state: { paid: false, shipped: false, cancelled_at: null },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error_code: string;
      current_state: { paid: boolean };
    };
    expect(body.error_code).toBe("STALE_STATE");
    expect(body.current_state.paid).toBe(true);
  });

  it("read-only state (paid) rejects items edit", async () => {
    if (SKIP) return;
    seedSingle(5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 1);
    await fetch(`${STAGE_URL}/api/admin/orders/${orderId}/mark-paid`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STAGE_URL, Cookie: cookie },
    });

    const res = await adminSave(cookie, orderId, {
      items: [{ sku: TEST_SKU_A, qty: 3 }],
      expected_state: { paid: true, shipped: false, cancelled_at: null },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error_code: string };
    expect(body.error_code).toBe("EDIT_FORBIDDEN");
  });

  it("idempotency: replay with same key returns cached, no double-mutation", async () => {
    if (SKIP) return;
    seedSingle(5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 2);
    expect(getGroupStockFen(testGroupId)).toBe(3 * PACKAGE_FEN);

    const idempotencyKey = `test-idempotency-${crypto.randomUUID()}`;
    const payload: SavePayload = {
      items: [{ sku: TEST_SKU_A, qty: 3 }],
      expected_state: { paid: false, shipped: false, cancelled_at: null },
      idempotency_key: idempotencyKey,
    };
    const r1 = await adminSave(cookie, orderId, payload);
    expect(r1.status).toBe(200);
    expect(getGroupStockFen(testGroupId)).toBe(2 * PACKAGE_FEN);

    const r2 = await adminSave(cookie, orderId, payload);
    expect(r2.status).toBe(200);
    expect(getGroupStockFen(testGroupId)).toBe(2 * PACKAGE_FEN);
  });

  it("items diff: qty up decrements group stock, qty down restores", async () => {
    if (SKIP) return;
    seedSingle(5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 2);
    expect(getGroupStockFen(testGroupId)).toBe(3 * PACKAGE_FEN);

    let res = await adminSave(cookie, orderId, {
      items: [{ sku: TEST_SKU_A, qty: 4 }],
      expected_state: { paid: false, shipped: false, cancelled_at: null },
    });
    expect(res.status).toBe(200);
    expect(getGroupStockFen(testGroupId)).toBe(1 * PACKAGE_FEN);

    res = await adminSave(cookie, orderId, {
      items: [{ sku: TEST_SKU_A, qty: 1 }],
      expected_state: { paid: false, shipped: false, cancelled_at: null },
    });
    expect(res.status).toBe(200);
    expect(getGroupStockFen(testGroupId)).toBe(4 * PACKAGE_FEN);
  });

  it("combined edit (items across two groups + address + notes): one /save call", async () => {
    if (SKIP) return;
    seedTwoGroupsTwoSkus(5 * PACKAGE_FEN, 5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 1);

    const res = await adminSave(cookie, orderId, {
      items: [
        { sku: TEST_SKU_A, qty: 2 },
        { sku: TEST_SKU_B, qty: 1 },
      ],
      address: "combined-test address 500",
      notes: "combined-test notes",
      expected_state: { paid: false, shipped: false, cancelled_at: null },
    });
    expect(res.status).toBe(200);
    expect(getGroupStockFen(testGroupId)).toBe(3 * PACKAGE_FEN);
    expect(getGroupStockFen(testGroupIdB)).toBe(4 * PACKAGE_FEN);
  });

  it("stale items_hash returns 409 STALE_STATE (concurrent-edit race detection)", async () => {
    if (SKIP) return;
    seedSingle(5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 2);

    // Tab A loads the page, sees items=[{sku:A, qty:2}], computes sku-based hash.
    const staleHash = `${TEST_SKU_A}:2`;

    // Tab B saves first, changing qty 2 → 3 — current items now [{sku:A, qty:3}].
    const r1 = await adminSave(cookie, orderId, {
      items: [{ sku: TEST_SKU_A, qty: 3 }],
      expected_state: { paid: false, shipped: false, cancelled_at: null },
    });
    expect(r1.status).toBe(200);

    // Tab A submits with its stale hash — server rejects (sku-hash format still tried first).
    const r2 = await adminSave(cookie, orderId, {
      items: [{ sku: TEST_SKU_A, qty: 4 }],
      expected_state: {
        paid: false,
        shipped: false,
        cancelled_at: null,
        items_hash: staleHash,
      },
    });
    expect(r2.status).toBe(409);
    const body = (await r2.json()) as {
      error_code: string;
      stale_reason: string;
    };
    expect(body.error_code).toBe("STALE_STATE");
    expect(body.stale_reason).toBe("items");

    // Group stock should have decremented exactly once (5→3 from r1, not again).
    expect(getGroupStockFen(testGroupId)).toBe(2 * PACKAGE_FEN);
  });

  it("expected_state shape required (400 if malformed)", async () => {
    if (SKIP) return;
    seedSingle(5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 1);

    const res = await fetch(`${STAGE_URL}/api/admin/orders/${orderId}/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: STAGE_URL,
        Cookie: cookie,
      },
      body: JSON.stringify({ address: "x", expected_state: null }),
    });
    expect(res.status).toBe(400);
  });
});
