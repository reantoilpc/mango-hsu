// V5 /api/admin/orders/:id/save integration tests.
//
// Verifies the gate-first batch pattern: expected_state validation, server-side
// field diff, items diff with stock CAS, idempotency replay, read-only state
// guards. Mirrors tests/admin-idempotency.test.ts style.
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
  getSkuStock,
  seedSku,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SKU_A = "TEST-MANGO-SAVE-A";
const TEST_SKU_B = "TEST-MANGO-SAVE-B";

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
  expected_state: { paid: boolean; shipped: boolean; cancelled_at: string | null };
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

describe("V5 /save endpoint", () => {
  it("address-only edit: server-side diff audits and returns updated order", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU_A, { stock: 5 });
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
    seedSku(TEST_SKU_A, { stock: 5 });
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 2);

    // Save with the SAME address that's already in DB.
    const res = await adminSave(cookie, orderId, {
      address: "test address 300",
      expected_state: { paid: false, shipped: false, cancelled_at: null },
    });
    expect(res.status).toBe(200);

    // No audit row for this no-op save (only the customer-create audit row exists,
    // if customer-create writes one — depends on existing pattern).
    const auditRows = d1Execute(
      `SELECT action FROM audit_log WHERE order_id = '${orderId}' AND action = 'order_save'`,
    ) as Array<{ action: string }>;
    expect(auditRows.length).toBe(0);
  });

  it("stale expected_state returns 409 STALE_STATE with current_state", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU_A, { stock: 5 });
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 1);

    // Mark paid via existing endpoint (changes state).
    const paidRes = await fetch(`${STAGE_URL}/api/admin/orders/${orderId}/mark-paid`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: STAGE_URL, Cookie: cookie },
    });
    expect(paidRes.status).toBe(200);

    // Save with stale expected_state (paid=false). Server should 409.
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
    seedSku(TEST_SKU_A, { stock: 5 });
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
    seedSku(TEST_SKU_A, { stock: 5 });
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 2);
    expect(getSkuStock(TEST_SKU_A)).toBe(3);

    const idempotencyKey = `test-idempotency-${crypto.randomUUID()}`;
    const payload: SavePayload = {
      items: [{ sku: TEST_SKU_A, qty: 3 }],
      expected_state: { paid: false, shipped: false, cancelled_at: null },
      idempotency_key: idempotencyKey,
    };
    const r1 = await adminSave(cookie, orderId, payload);
    expect(r1.status).toBe(200);
    expect(getSkuStock(TEST_SKU_A)).toBe(2);

    // Replay: same key within 60s window → should NOT decrement again.
    const r2 = await adminSave(cookie, orderId, payload);
    expect(r2.status).toBe(200);
    expect(getSkuStock(TEST_SKU_A)).toBe(2); // still 2, no re-decrement
  });

  it("items diff: qty up decrements stock, qty down restores", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU_A, { stock: 5 });
    const cookie = createTestAdminSession();
    const orderId = await placeCustomerOrder(TEST_SKU_A, 2);
    expect(getSkuStock(TEST_SKU_A)).toBe(3);

    // Bump qty 2 → 4 (decrement 2).
    let res = await adminSave(cookie, orderId, {
      items: [{ sku: TEST_SKU_A, qty: 4 }],
      expected_state: { paid: false, shipped: false, cancelled_at: null },
    });
    expect(res.status).toBe(200);
    expect(getSkuStock(TEST_SKU_A)).toBe(1);

    // Drop qty 4 → 1 (restore 3).
    res = await adminSave(cookie, orderId, {
      items: [{ sku: TEST_SKU_A, qty: 1 }],
      expected_state: { paid: false, shipped: false, cancelled_at: null },
    });
    expect(res.status).toBe(200);
    expect(getSkuStock(TEST_SKU_A)).toBe(4);
  });

  it("combined edit (items + address + notes): one /save call mutates all", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU_A, { stock: 5 });
    seedSku(TEST_SKU_B, { stock: 5, price: 200 });
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
    expect(getSkuStock(TEST_SKU_A)).toBe(3);
    expect(getSkuStock(TEST_SKU_B)).toBe(4);
  });

  it("expected_state shape required (400 if malformed)", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU_A, { stock: 5 });
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
