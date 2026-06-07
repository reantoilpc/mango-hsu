// V5.2 /api/admin/products/batch integration tests.
//
// Verifies all-or-nothing batch with per-stmt meta.changes verification, server-side field
// diff (only audits real changes), CSRF.
//
// V5.2 changes:
//   - The `stock` field is REMOVED from this endpoint. Stock lives on product_groups.stock_fen
//     and is mutated via /api/admin/product-groups/:id/intake (PR2). batch.ts now rejects
//     any row with `stock` set as `DEPRECATED_FIELD`.
//   - Lookup is (active_season_id, sku) → product_id.

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  cleanupTestData,
  cleanupTestAdmin,
  createTestAdminSession,
  d1Execute,
  seedActiveSeasonScenario,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const TEST_SEASON_CODE = "test-batch-season";
const TEST_GROUP_SLUG = "test-batch-group";
const TEST_SKU_A = "TEST-BATCH-A";
const TEST_SKU_B = "TEST-BATCH-B";
const PACKAGE_FEN = 100;

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

function seedTwoSkus(price: number = 100) {
  seedActiveSeasonScenario({
    season_code: TEST_SEASON_CODE,
    group_slug: TEST_GROUP_SLUG,
    initial_stock_fen: 10 * PACKAGE_FEN,
    skus: [
      { sku: TEST_SKU_A, package_fen: PACKAGE_FEN, price },
      { sku: TEST_SKU_B, package_fen: PACKAGE_FEN, price },
    ],
  });
}

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
    // V5.2: stock field deprecated; sending it returns DEPRECATED_FIELD.
    stock?: unknown;
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

describe("V5.2 /products/batch endpoint", () => {
  it("multi-row field update: all rows applied", async () => {
    if (SKIP) return;
    seedTwoSkus();
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

    // Verify within active season
    const a = d1Execute(
      `SELECT p.price FROM products p
         JOIN seasons s ON s.id = p.season_id AND s.status = 'active'
        WHERE p.sku = '${TEST_SKU_A}'`,
    ) as Array<{ price: number }>;
    expect(a[0]!.price).toBe(999);
    const b = d1Execute(
      `SELECT p.name FROM products p
         JOIN seasons s ON s.id = p.season_id AND s.status = 'active'
        WHERE p.sku = '${TEST_SKU_B}'`,
    ) as Array<{ name: string }>;
    expect(b[0]!.name).toBe("renamed-batch");
  });

  it("server-side diff: same value as DB writes nothing", async () => {
    if (SKIP) return;
    seedTwoSkus(100);
    const cookie = createTestAdminSession();

    const res = await adminBatch(cookie, {
      rows: [{ sku: TEST_SKU_A, fields: { price: 100 } }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied?: number };
    expect(body.ok).toBe(true);
    expect(body.applied ?? 0).toBe(0);
  });

  it("V5.2: stock field rejected with DEPRECATED_FIELD (point to intake endpoint)", async () => {
    if (SKIP) return;
    seedTwoSkus();
    const cookie = createTestAdminSession();

    const res = await adminBatch(cookie, {
      rows: [{ sku: TEST_SKU_A, stock: 5 }],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error_code: string; sku?: string };
    expect(body.error_code).toBe("DEPRECATED_FIELD");
    expect(body.sku).toBe(TEST_SKU_A);
  });

  it("empty row (no fields) rejected (400)", async () => {
    if (SKIP) return;
    seedTwoSkus();
    const cookie = createTestAdminSession();

    const res = await adminBatch(cookie, {
      rows: [{ sku: TEST_SKU_A }],
    });
    expect(res.status).toBe(400);
  });

  it("non-existent sku returns 404", async () => {
    if (SKIP) return;
    seedTwoSkus(); // need an active season for the lookup
    const cookie = createTestAdminSession();
    const res = await adminBatch(cookie, {
      rows: [{ sku: "TEST-DOESNT-EXIST", fields: { price: 1 } }],
    });
    expect(res.status).toBe(404);
  });

  it("CSRF: foreign Origin header → rejected", async () => {
    if (SKIP) return;
    seedTwoSkus();
    const cookie = createTestAdminSession();

    const res = await fetch(`${STAGE_URL}/api/admin/products/batch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        // Header-less is now accepted (SameSite=Strict is the CSRF defense);
        // a FOREIGN Origin is what must still be rejected.
        Origin: "https://evil.example.com",
      },
      body: JSON.stringify({ rows: [{ sku: TEST_SKU_A, fields: { price: 9 } }] }),
    });
    expect(res.status).toBe(403);
  });
});
