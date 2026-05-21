// V5.2 reconcile-stock.ts script logic tests.
//
// The actual `scripts/reconcile-stock.ts` shells out to wrangler, which is hard to unit-test
// without spinning up the wrangler CLI. Instead, this test file verifies the underlying
// invariant the script relies on: SUM(audit_log.details.delta_fen) GROUP BY group_id ==
// product_groups.stock_fen, by manipulating audit rows directly via D1.
//
// Two scenarios:
//   - clean: no drift, sum matches
//   - drift: stock_fen tampered with → sum no longer matches → reconcile would flag

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  cleanupTestData,
  cleanupTestAdmin,
  d1Execute,
  getGroupStockFen,
  seedActiveSeasonScenario,
  setGroupStockFen,
  skipIfNoIntegration,
} from "./_setup";

const SKIP = skipIfNoIntegration();
const SEASON_CODE = "test-reconcile-season";
const GROUP_SLUG = "test-reconcile-group";
const SKU = "TEST-RECONCILE-1";
const PACKAGE_FEN = 100;

let groupId = 0;

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
    season_code: SEASON_CODE,
    group_slug: GROUP_SLUG,
    initial_stock_fen: initialFen,
    skus: [{ sku: SKU, package_fen: PACKAGE_FEN }],
  });
  groupId = r.group_id;
  // Seed a "migration_init" audit row to match the production migration pattern
  // (Migration File 2 step 6 writes one).
  d1Execute(
    `INSERT INTO audit_log (ts, user_email, action, details) VALUES (
       '2026-05-13T00:00:00.000Z',
       '<system>',
       'group_stock_change',
       '{"reason":"migration_init","group_id":${groupId},"delta_fen":${initialFen},"before_fen":0,"after_fen":${initialFen},"source_id":"test-init"}'
     )`,
  );
}

function reconcileGroup(group_id: number): { audit_sum: number; current: number; diff: number } {
  const auditRows = d1Execute(
    `SELECT details FROM audit_log WHERE action = 'group_stock_change'`,
  ) as Array<{ details: string }>;
  let sum = 0;
  for (const r of auditRows) {
    if (!r.details) continue;
    try {
      const parsed = JSON.parse(r.details) as { group_id?: number; delta_fen?: number };
      if (parsed.group_id === group_id && typeof parsed.delta_fen === "number") {
        sum += parsed.delta_fen;
      }
    } catch {
      /* skip malformed */
    }
  }
  const current = getGroupStockFen(group_id);
  return { audit_sum: sum, current, diff: current - sum };
}

describe("V5.2 reconcile invariant", () => {
  it("clean state: SUM(deltas) equals current stock_fen", async () => {
    if (SKIP) return;
    seedScenario(500);

    const r = reconcileGroup(groupId);
    expect(r.audit_sum).toBe(500); // from migration_init row
    expect(r.current).toBe(500);
    expect(r.diff).toBe(0);
  });

  it("after a manual stock_fen tamper, reconcile detects drift", async () => {
    if (SKIP) return;
    seedScenario(500);

    // Tamper: set stock_fen directly without writing an audit row.
    setGroupStockFen(groupId, 600);

    const r = reconcileGroup(groupId);
    expect(r.audit_sum).toBe(500); // audit unchanged
    expect(r.current).toBe(600); // stock tampered
    expect(r.diff).toBe(100); // 100 fen mystery — reconcile would flag
  });

  it("multiple delta entries sum correctly", async () => {
    if (SKIP) return;
    seedScenario(500);

    // Append two more synthetic deltas (simulating an intake + a decrement)
    d1Execute(
      `INSERT INTO audit_log (ts, user_email, action, details) VALUES
        ('2026-05-13T01:00:00.000Z', '<system>', 'group_stock_change',
         '{"reason":"group_intake","group_id":${groupId},"delta_fen":300,"before_fen":500,"after_fen":800,"source_id":"intake-1"}'),
        ('2026-05-13T02:00:00.000Z', '<system>', 'group_stock_change',
         '{"reason":"order_decrement","group_id":${groupId},"delta_fen":-100,"before_fen":800,"after_fen":700,"source_id":"M-20260513-001"}')`,
    );
    setGroupStockFen(groupId, 700); // reflects the deltas

    const r = reconcileGroup(groupId);
    expect(r.audit_sum).toBe(500 + 300 - 100); // 700
    expect(r.current).toBe(700);
    expect(r.diff).toBe(0);
  });
});
