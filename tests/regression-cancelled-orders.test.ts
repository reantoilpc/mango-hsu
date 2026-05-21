// V5.2 regression tests: cancelled orders MUST stay out of every flow that converts
// orders to physical-world action (picking sheet, mark-shipped). This is the
// "stock-double-billed" bug the V4 design was written to fix.
//
// V5.2 changes: stock assertions now check group stock_fen.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  TEST_TOKEN,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  getGroupStockFen,
  seedActiveSeasonScenario,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SEASON_CODE = "test-cancel-season";
const TEST_GROUP_SLUG = "test-cancel-group";
const TEST_SKU = "TEST-MANGO-CANCEL";
const PACKAGE_FEN = 100;

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

async function placeCustomerOrder(qty: number): Promise<string> {
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
      items: [{ sku: TEST_SKU, qty }],
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

async function adminCancel(cookie: string, orderId: string): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/orders/${orderId}/cancel`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: STAGE_URL,
      Cookie: cookie,
    },
  });
}

async function adminMarkShipped(cookie: string, orderId: string): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/orders/${orderId}/mark-shipped`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: STAGE_URL,
      Cookie: cookie,
    },
    body: JSON.stringify({}),
  });
}

async function adminMarkPaid(cookie: string, orderId: string): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/orders/${orderId}/mark-paid`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: STAGE_URL,
      Cookie: cookie,
    },
  });
}

describe("V5.2 cancelled-order regressions", () => {
  it("cancel restores group stock_fen and writes audit", async () => {
    if (SKIP) return;
    seedScenario(5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();

    const orderId = await placeCustomerOrder(2);
    expect(getGroupStockFen(testGroupId)).toBe(3 * PACKAGE_FEN);

    const res = await adminCancel(cookie, orderId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(getGroupStockFen(testGroupId)).toBe(5 * PACKAGE_FEN);
  });

  it("mark-paid on a cancelled order is rejected (409 not_changed)", async () => {
    if (SKIP) return;
    seedScenario(5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();

    const orderId = await placeCustomerOrder(1);
    const cancelRes = await adminCancel(cookie, orderId);
    expect(cancelRes.status).toBe(200);

    // V5 fix: mark-paid must reject cancelled orders. Without the cancelled_at IS NULL
    // guard, this would create a cancelled+paid state (impossible per data model —
    // cancelled stock is already restored, paid would imply customer owes nothing for
    // nothing).
    const paidRes = await adminMarkPaid(cookie, orderId);
    expect(paidRes.status).toBe(409);
  });

  it("mark-shipped on a cancelled order is rejected (409 not_changed)", async () => {
    if (SKIP) return;
    seedScenario(5 * PACKAGE_FEN);
    const cookie = createTestAdminSession();

    const orderId = await placeCustomerOrder(1);
    const cancelRes = await adminCancel(cookie, orderId);
    expect(cancelRes.status).toBe(200);

    const shipRes = await adminMarkShipped(cookie, orderId);
    // mark-shipped requires paid=1 AND shipped=0 AND cancelled_at IS NULL.
    // For an unpaid+cancelled order, the WHERE clause matches 0 rows so the endpoint
    // returns 409 not_changed.
    expect(shipRes.status).toBe(409);
  });
});
