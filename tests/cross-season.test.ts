// V5.2 cross-season SKU disambiguation.
//
// Verifies that the same SKU string can exist across different seasons (e.g. DRY-JH-1 in
// 2026 + DRY-JH-1 in 2027 draft) and:
//   - GET /api/site/status only returns active-season products
//   - POST /api/orders resolves the SKU to the active-season product (correct price + group)
//   - The non-active season's pool is untouched

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  STAGE_URL,
  TEST_TOKEN,
  cleanupTestData,
  cleanupTestAdmin,
  d1Execute,
  getGroupStockFen,
  seedActiveSeasonScenario,
  seedGroup,
  seedProductInSeason,
  seedSeason,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const ACTIVE_CODE = "test-cross-active-2026";
const DRAFT_CODE = "test-cross-draft-2027";
const GROUP_SLUG = "test-cross-group-jh";
const SKU = "TEST-CROSS-JH-1";
const PACKAGE_FEN = 100;

let activeGroupId = 0;
let draftGroupId = 0;
let activeSeasonId = 0;
let draftSeasonId = 0;

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

function seedBothSeasons() {
  // Active 2026 — price 450
  const a = seedActiveSeasonScenario({
    season_code: ACTIVE_CODE,
    group_slug: GROUP_SLUG,
    initial_stock_fen: 5 * PACKAGE_FEN,
    skus: [{ sku: SKU, package_fen: PACKAGE_FEN, price: 450 }],
  });
  activeGroupId = a.group_id;
  activeSeasonId = a.season_id;

  // Draft 2027 — same SKU, different group (independent pool), different price 480
  draftSeasonId = seedSeason({ code: DRAFT_CODE, status: "draft" });
  draftGroupId = seedGroup({
    season_id: draftSeasonId,
    slug: GROUP_SLUG, // same slug — unique scope is (season_id, slug)
    stock_fen: 99 * PACKAGE_FEN, // way more, to detect bleed
  });
  seedProductInSeason({
    season_id: draftSeasonId,
    group_id: draftGroupId,
    sku: SKU,
    package_fen: PACKAGE_FEN,
    price: 480,
  });
}

describe("V5.2 cross-season SKU isolation", () => {
  it("GET /api/site/status returns only active-season products", async () => {
    if (SKIP) return;
    seedBothSeasons();

    const res = await fetch(`${STAGE_URL}/api/site/status`, {
      method: "GET",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      products: Array<{ sku: string; price: number }>;
    };

    const ours = body.products.filter((p) => p.sku === SKU);
    // Should appear exactly once (active season's row only) with the active price.
    // Note: the real prod 2026 season also has products that happen to use other SKUs.
    expect(ours.length).toBe(1);
    expect(ours[0]!.price).toBe(450);
  });

  it("POST /api/orders pulls SKU from active-season pool only", async () => {
    if (SKIP) return;
    seedBothSeasons();

    const res = await fetch(`${STAGE_URL}/api/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Test-Mode": "1" },
      body: JSON.stringify({
        idempotency_key: `test-${crypto.randomUUID()}`,
        token: TEST_TOKEN,
        honeypot: "",
        name: "test-buyer",
        phone: "0912345678",
        address: "test address cross-season",
        items: [{ sku: SKU, qty: 2 }],
        notes: "",
        pdpa_accepted: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; order_id: string };
    expect(body.ok).toBe(true);

    // Active-season pool decremented.
    expect(getGroupStockFen(activeGroupId)).toBe(3 * PACKAGE_FEN);
    // Draft-season pool untouched.
    expect(getGroupStockFen(draftGroupId)).toBe(99 * PACKAGE_FEN);

    // order_items.product_id should point to the ACTIVE-season product, not the draft one.
    const items = d1Execute(
      `SELECT product_id, sku FROM order_items WHERE order_id = '${body.order_id}'`,
    ) as Array<{ product_id: number; sku: string }>;
    expect(items.length).toBe(1);
    expect(items[0]!.sku).toBe(SKU);

    const products = d1Execute(
      `SELECT season_id FROM products WHERE id = ${items[0]!.product_id}`,
    ) as Array<{ season_id: number }>;
    expect(products[0]!.season_id).toBe(activeSeasonId);
  });
});

describe("V5.2 active-season singleton invariant (partial unique index)", () => {
  it("inserting a second active season directly into D1 fails with UNIQUE constraint", async () => {
    if (SKIP) return;
    seedBothSeasons();

    // Try to set the draft season to active — should fail because there's already an active.
    let threw = false;
    try {
      d1Execute(
        `UPDATE seasons SET status = 'active' WHERE code = '${DRAFT_CODE}'`,
      );
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      expect(/UNIQUE|constraint/i.test(msg)).toBe(true);
    }
    expect(threw).toBe(true);
  });
});
