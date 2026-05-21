// V5.2 group fen pool race scenarios.
//
// Covers the four race matrices the design doc Success Criteria called out:
//   - Same group, two SKUs concurrent: aggregate fen across SKUs in single CAS
//   - Cross-group concurrent: independent CAS per group; partial sold_out compensates
//   - Pool exact zero: 1斤 sold out, 半斤 still has 1 (derived from leftover fen)
//   - Cancel restores group_fen + reconcile audit alignment
//
// Requires MANGO_STAGE_URL + TEST_TOKEN.

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
const SEASON_CODE = "test-group-stock-season";
const GROUP_A = "test-gs-group-a";
const GROUP_B = "test-gs-group-b";
const SKU_A1 = "TEST-GS-A1"; // group A, 1斤 (100 fen)
const SKU_A05 = "TEST-GS-A05"; // group A, 半斤 (50 fen)
const SKU_B1 = "TEST-GS-B1"; // group B, 1斤

let groupAId = 0;
let groupBId = 0;
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

function seedTwoGroupMix(opts: { groupAFen: number; groupBFen: number }) {
  const r = seedActiveSeasonScenario({
    season_code: SEASON_CODE,
    group_slug: GROUP_A,
    initial_stock_fen: opts.groupAFen,
    skus: [
      { sku: SKU_A1, package_fen: 100 },
      { sku: SKU_A05, package_fen: 50 },
    ],
  });
  groupAId = r.group_id;
  seasonId = r.season_id;
  groupBId = seedGroup({
    season_id: seasonId,
    slug: GROUP_B,
    stock_fen: opts.groupBFen,
  });
  seedProductInSeason({
    season_id: seasonId,
    group_id: groupBId,
    sku: SKU_B1,
    package_fen: 100,
  });
}

async function customerOrder(items: Array<{ sku: string; qty: number }>): Promise<Response> {
  return fetch(`${STAGE_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Test-Mode": "1" },
    body: JSON.stringify({
      idempotency_key: `test-${crypto.randomUUID()}`,
      token: TEST_TOKEN,
      honeypot: "",
      name: "test-buyer",
      phone: "0912345678",
      address: "test address group-stock",
      items,
      notes: "",
      pdpa_accepted: true,
    }),
  });
}

describe("V5.2 group fen pool race", () => {
  it("same-group multi-SKU order aggregates fen in single CAS (1斤×1 + 半斤×1 = 150 fen)", async () => {
    if (SKIP) return;
    seedTwoGroupMix({ groupAFen: 200, groupBFen: 0 });

    const res = await customerOrder([
      { sku: SKU_A1, qty: 1 },
      { sku: SKU_A05, qty: 1 },
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    expect(getGroupStockFen(groupAId)).toBe(200 - 100 - 50); // 50 fen left
  });

  it("pool=50 fen: 1斤 SKU sold out, 半斤 SKU still buyable", async () => {
    if (SKIP) return;
    seedTwoGroupMix({ groupAFen: 50, groupBFen: 0 });

    // 1斤 → SOLD_OUT (need 100, only 50 available)
    const r1 = await customerOrder([{ sku: SKU_A1, qty: 1 }]);
    const b1 = (await r1.json()) as { ok: boolean; error_code?: string };
    expect(b1.ok).toBe(false);
    expect(b1.error_code).toBe("SOLD_OUT");

    // 半斤 → still works (need 50, have 50)
    const r2 = await customerOrder([{ sku: SKU_A05, qty: 1 }]);
    const b2 = (await r2.json()) as { ok: boolean };
    expect(b2.ok).toBe(true);

    expect(getGroupStockFen(groupAId)).toBe(0);
  });

  it("cross-group concurrent: independent CAS, both succeed", async () => {
    if (SKIP) return;
    seedTwoGroupMix({ groupAFen: 100, groupBFen: 100 });

    const [r1, r2] = await Promise.all([
      customerOrder([{ sku: SKU_A1, qty: 1 }]),
      customerOrder([{ sku: SKU_B1, qty: 1 }]),
    ]);
    const b1 = (await r1.json()) as { ok: boolean };
    const b2 = (await r2.json()) as { ok: boolean };
    expect(b1.ok && b2.ok).toBe(true);

    expect(getGroupStockFen(groupAId)).toBe(0);
    expect(getGroupStockFen(groupBId)).toBe(0);
  });

  it("cross-group order, second group sold out, first group restored", async () => {
    if (SKIP) return;
    // groupA has plenty, groupB has 0 — order asks for both → should SOLD_OUT on B,
    // and groupA stock_fen must end up unchanged (compensation ran).
    seedTwoGroupMix({ groupAFen: 500, groupBFen: 0 });

    const res = await customerOrder([
      { sku: SKU_A1, qty: 1 }, // 100 fen from group A
      { sku: SKU_B1, qty: 1 }, // 100 fen from group B (will fail)
    ]);
    const body = (await res.json()) as {
      ok: boolean;
      error_code?: string;
      sold_out_group_id?: number;
    };
    expect(body.ok).toBe(false);
    expect(body.error_code).toBe("SOLD_OUT");
    expect(body.sold_out_group_id).toBe(groupBId);

    // Group A pool must be unchanged — compensation restored the 100 fen
    expect(getGroupStockFen(groupAId)).toBe(500);
    expect(getGroupStockFen(groupBId)).toBe(0);
  });

  it("after successful order, audit row exists for the group decrement", async () => {
    if (SKIP) return;
    seedTwoGroupMix({ groupAFen: 200, groupBFen: 0 });

    const res = await customerOrder([{ sku: SKU_A1, qty: 1 }]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; order_id: string };
    expect(body.ok).toBe(true);

    // Verify audit_log row for group_stock_change exists
    const audit = d1Execute(
      `SELECT details FROM audit_log WHERE order_id = '${body.order_id}' AND action = 'group_stock_change'`,
    ) as Array<{ details: string }>;
    expect(audit.length).toBe(1);
    const parsed = JSON.parse(audit[0]!.details) as {
      reason: string;
      group_id: number;
      delta_fen: number;
    };
    expect(parsed.reason).toBe("order_decrement");
    expect(parsed.group_id).toBe(groupAId);
    expect(parsed.delta_fen).toBe(-100);
  });

  it("after cancel, audit row exists for the group restore (reconcile invariant)", async () => {
    if (SKIP) return;
    seedTwoGroupMix({ groupAFen: 200, groupBFen: 0 });
    const cookie = createTestAdminSession();

    const placeRes = await customerOrder([{ sku: SKU_A1, qty: 1 }]);
    const placeBody = (await placeRes.json()) as { order_id: string };
    expect(getGroupStockFen(groupAId)).toBe(100);

    const cancelRes = await fetch(
      `${STAGE_URL}/api/admin/orders/${placeBody.order_id}/cancel`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: STAGE_URL,
          Cookie: cookie,
        },
      },
    );
    expect(cancelRes.status).toBe(200);

    // Stock restored
    expect(getGroupStockFen(groupAId)).toBe(200);

    // Audit reconcile invariant: SUM(delta_fen) per group = stock change net
    const auditRows = d1Execute(
      `SELECT details FROM audit_log WHERE order_id = '${placeBody.order_id}' AND action = 'group_stock_change'`,
    ) as Array<{ details: string }>;
    const sum = auditRows.reduce((s, r) => {
      const parsed = JSON.parse(r.details) as { delta_fen: number };
      return s + parsed.delta_fen;
    }, 0);
    // Decrement -100 + restore +100 = 0 net
    expect(sum).toBe(0);
  });
});
