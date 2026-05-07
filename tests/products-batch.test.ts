// V5 /api/admin/products/batch integration tests.
//
// Verifies all-or-nothing batch with per-stmt meta.changes verification, stock
// guard against unshipped_total, server-side field diff (only audits real
// changes).

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  TEST_TOKEN,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  seedSku,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SKU_A = "test-batch-a";
const TEST_SKU_B = "test-batch-b";

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

interface BatchPayload {
  rows: Array<{
    sku: string;
    fields?: {
      name?: string;
      variant?: string;
      price?: number;
      available?: boolean;
      display_order?: number;
    };
    stock?: { new_stock: number; reason: string };
  }>;
  idempotency_key?: string;
}

async function adminBatch(cookie: string, payload: BatchPayload): Promise<Response> {
  return fetch(`${STAGE_URL}/api/admin/products/batch`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: STAGE_URL,
      Cookie: cookie,
    },
    body: JSON.stringify(payload),
  });
}

async function placeCustomerOrder(sku: string, qty: number): Promise<string> {
  const res = await fetch(`${STAGE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  if (!body.ok || !body.order_id) throw new Error(`order failed: ${JSON.stringify(body)}`);
  return body.order_id;
}

describe("V5 /products/batch endpoint", () => {
  it("multi-row field update: all rows applied", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU_A, { stock: 5 });
    seedSku(TEST_SKU_B, { stock: 10 });
    const cookie = createTestAdminSession();

    const res = await adminBatch(cookie, {
      rows: [
        { sku: TEST_SKU_A, fields: { price: 999 } },
        { sku: TEST_SKU_B, fields: { name: "renamed-batch" } },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: number };
    expect(body.ok).toBe(true);
    expect(body.applied).toBeGreaterThanOrEqual(2);

    const a = d1Execute(`SELECT price FROM products WHERE sku = '${TEST_SKU_A}'`) as Array<{
      price: number;
    }>;
    expect(a[0].price).toBe(999);
    const b = d1Execute(`SELECT name FROM products WHERE sku = '${TEST_SKU_B}'`) as Array<{
      name: string;
    }>;
    expect(b[0].name).toBe("renamed-batch");
  });

  it("server-side diff: same value as DB writes nothing", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU_A, { stock: 5, price: 100 });
    const cookie = createTestAdminSession();

    const res = await adminBatch(cookie, {
      rows: [{ sku: TEST_SKU_A, fields: { price: 100 } }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied?: number };
    expect(body.ok).toBe(true);
    // applied 0 because diff was empty
    expect(body.applied ?? 0).toBe(0);
  });

  it("STOCK_BELOW_UNSHIPPED rejects whole batch with offending sku", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU_A, { stock: 5 });
    seedSku(TEST_SKU_B, { stock: 10 });
    const cookie = createTestAdminSession();
    // Create unshipped order using TEST_SKU_A — qty 2 unshipped.
    await placeCustomerOrder(TEST_SKU_A, 2);

    // Try to set TEST_SKU_A stock to 1 (below unshipped 2). Other row should
    // also NOT apply — all-or-nothing.
    const res = await adminBatch(cookie, {
      rows: [
        { sku: TEST_SKU_A, stock: { new_stock: 1, reason: "test conflict" } },
        { sku: TEST_SKU_B, fields: { price: 555 } },
      ],
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error_code: string;
      sku: string;
      unshipped_total: number;
    };
    expect(body.error_code).toBe("STOCK_BELOW_UNSHIPPED");
    expect(body.sku).toBe(TEST_SKU_A);

    // TEST_SKU_B's price update must NOT have applied.
    const b = d1Execute(`SELECT price FROM products WHERE sku = '${TEST_SKU_B}'`) as Array<{
      price: number;
    }>;
    expect(b[0].price).toBe(100); // default seedSku price
  });

  it("stock without reason rejected (400)", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU_A, { stock: 5 });
    const cookie = createTestAdminSession();

    const res = await adminBatch(cookie, {
      rows: [{ sku: TEST_SKU_A, stock: { new_stock: 8, reason: "" } }],
    });
    expect(res.status).toBe(400);
  });

  it("empty row (no fields, no stock) rejected (400)", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU_A, { stock: 5 });
    const cookie = createTestAdminSession();

    const res = await adminBatch(cookie, {
      rows: [{ sku: TEST_SKU_A }],
    });
    expect(res.status).toBe(400);
  });

  it("non-existent sku returns 404", async () => {
    if (SKIP) return;
    const cookie = createTestAdminSession();
    const res = await adminBatch(cookie, {
      rows: [{ sku: "test-doesnt-exist", fields: { price: 1 } }],
    });
    expect(res.status).toBe(404);
  });

  it("CSRF: missing Origin header → rejected", async () => {
    if (SKIP) return;
    seedSku(TEST_SKU_A, { stock: 5 });
    const cookie = createTestAdminSession();

    const res = await fetch(`${STAGE_URL}/api/admin/products/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        // no Origin
      },
      body: JSON.stringify({ rows: [{ sku: TEST_SKU_A, fields: { price: 9 } }] }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
