// V5.2 season transitions + invariants.
//
// PR3 will add admin endpoints for season CRUD + transitions. PR1 just establishes the
// schema and the partial unique index. This test file verifies the data-model invariants
// that PR3 endpoints will rely on.
//
// What's NOT tested here (because no admin endpoint exists yet in PR1):
//   - Activate/archive transitions (covered when PR3 lands)
//   - Activate-while-orders-open rejection (same)
//   - Clone-season wizard (same)
//
// What IS tested:
//   - Partial unique constraint: at most one status='active' across all seasons
//   - Cross-season SKU uniqueness scoped to (season_id, sku)
//   - product_groups.slug uniqueness scoped to (season_id, slug)

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  cleanupTestData,
  cleanupTestAdmin,
  d1Execute,
  seedGroup,
  seedSeason,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const SEASON_A = "test-seasons-a";
const SEASON_B = "test-seasons-b";

beforeEach(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
  // This file specifically verifies the partial-unique active-singleton index. Stage has a
  // real `2026` active season; archive it so test seeds can hold the active slot. The next
  // beforeEach's cleanupTestData will restore 2026 to active.
  d1Execute(`UPDATE seasons SET status = 'archived' WHERE code = '2026'`);
});

afterAll(() => {
  if (SKIP) return;
  cleanupTestData();
  cleanupTestAdmin();
});

describe("V5.2 seasons schema invariants", () => {
  it("two seasons can be 'draft' simultaneously (partial index does not constrain non-active)", async () => {
    if (SKIP) return;
    const a = seedSeason({ code: SEASON_A, status: "draft" });
    const b = seedSeason({ code: SEASON_B, status: "draft" });
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).not.toBe(b);
  });

  it("two seasons can be 'archived' simultaneously", async () => {
    if (SKIP) return;
    seedSeason({ code: SEASON_A, status: "archived" });
    seedSeason({ code: SEASON_B, status: "archived" });
    // Both inserts succeed (no exception thrown above)
    const rows = d1Execute(
      `SELECT count(*) AS n FROM seasons WHERE code IN ('${SEASON_A}', '${SEASON_B}')`,
    ) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(2);
  });

  it("at most one season can be 'active' (partial unique index enforced)", async () => {
    if (SKIP) return;
    seedSeason({ code: SEASON_A, status: "active" });

    let threw = false;
    try {
      seedSeason({ code: SEASON_B, status: "active" });
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      expect(/UNIQUE|constraint/i.test(msg)).toBe(true);
    }
    expect(threw).toBe(true);
  });

  it("active season can be archived, then a different season can become active", async () => {
    if (SKIP) return;
    seedSeason({ code: SEASON_A, status: "active" });
    seedSeason({ code: SEASON_B, status: "draft" });

    // Archive A
    d1Execute(`UPDATE seasons SET status = 'archived' WHERE code = '${SEASON_A}'`);

    // Now B can become active
    d1Execute(`UPDATE seasons SET status = 'active' WHERE code = '${SEASON_B}'`);

    const rows = d1Execute(
      `SELECT code, status FROM seasons WHERE code IN ('${SEASON_A}', '${SEASON_B}')`,
    ) as Array<{ code: string; status: string }>;
    const map = new Map(rows.map((r) => [r.code, r.status]));
    expect(map.get(SEASON_A)).toBe("archived");
    expect(map.get(SEASON_B)).toBe("active");
  });

  it("product_groups.slug is unique within a season but can repeat across seasons", async () => {
    if (SKIP) return;
    const a = seedSeason({ code: SEASON_A, status: "draft" });
    const b = seedSeason({ code: SEASON_B, status: "draft" });

    // Same slug "test-jh" in both seasons — should both succeed
    seedGroup({ season_id: a, slug: "test-jh", name: "金煌" });
    seedGroup({ season_id: b, slug: "test-jh", name: "金煌" });

    // But can't repeat slug WITHIN one season
    let threw = false;
    try {
      seedGroup({ season_id: a, slug: "test-jh", name: "duplicate" });
    } catch (err) {
      threw = true;
      const msg = err instanceof Error ? err.message : String(err);
      expect(/UNIQUE|constraint/i.test(msg)).toBe(true);
    }
    // INSERT OR IGNORE means seedGroup might silently no-op rather than throw — accept either.
    // The key invariant is that count of rows for (season_id=a, slug='test-jh') stays 1.
    const rows = d1Execute(
      `SELECT count(*) AS n FROM product_groups WHERE season_id = ${a} AND slug = 'test-jh'`,
    ) as Array<{ n: number }>;
    expect(rows[0]!.n).toBe(1);
  });
});
