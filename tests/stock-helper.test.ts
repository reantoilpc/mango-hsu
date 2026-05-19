// Pure unit tests for src/lib/stock.ts low-level stmt builders.
// No D1 / network / env required — these run anywhere bun is installed.
//
// V5.2: per-SKU stockDecrementStmts/stockRestoreStmts were removed when stock moved to the
// group-fen pool model. The pure-stmt-builder equivalents now are:
//   - groupRestoreStmts: builds the UPDATE product_groups stmts a caller splices into a batch
//   - stockAuditStmts: builds the INSERT audit_log stmts that MUST accompany every fen mutation
// Decrement is no longer a pure stmt builder — tryDecrementGroupStock runs CAS UPDATEs inline
// and inspects meta.changes per row, so its coverage lives in tests/group-stock.test.ts (integration).

import { describe, expect, it } from "bun:test";
import { groupRestoreStmts, stockAuditStmts, type StockAuditRow } from "../src/lib/stock";

// Mock env shape — only DB.prepare(...).bind(...) is used.
function fakeEnv() {
  const captured: Array<{ sql: string; binds: unknown[] }> = [];
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...binds: unknown[]) {
            captured.push({ sql, binds });
            return { sql, binds };
          },
        };
      },
    },
    captured,
  } as unknown as { DB: { prepare: (sql: string) => unknown }; captured: Array<{ sql: string; binds: unknown[] }> };
}

describe("groupRestoreStmts", () => {
  it("returns one UPDATE stmt per group_increment", () => {
    const env = fakeEnv();
    const stmts = groupRestoreStmts(env as never, [
      { group_id: 1, fen: 200 },
      { group_id: 2, fen: 50 },
    ]);
    expect(stmts).toHaveLength(2);
    expect(env.captured[0]!.sql).toContain("UPDATE product_groups SET stock_fen = stock_fen + ?");
    expect(env.captured[0]!.sql).toContain("WHERE id = ?");
    expect(env.captured[0]!.binds).toEqual([200, 1]);
    expect(env.captured[1]!.binds).toEqual([50, 2]);
  });

  it("restore is unconditional — no WHERE clause on stock_fen value", () => {
    // V5.2 contract: restore is the undo half of a decrement that already happened, so it
    // must succeed regardless of current pool. CAS only applies to forward decrement
    // (tryDecrementGroupStock) and admin intake (adjustGroupStock).
    const env = fakeEnv();
    groupRestoreStmts(env as never, [{ group_id: 1, fen: 100 }]);
    expect(env.captured[0]!.sql).not.toContain("AND stock_fen");
  });

  it("returns empty array for empty input", () => {
    const env = fakeEnv();
    expect(groupRestoreStmts(env as never, [])).toHaveLength(0);
    expect(env.captured).toHaveLength(0);
  });
});

describe("stockAuditStmts", () => {
  it("emits INSERT audit_log with full V5.2 columns + JSON details", () => {
    const env = fakeEnv();
    const rows: StockAuditRow[] = [
      {
        group_id: 7,
        delta_fen: -100,
        before_fen: 500,
        after_fen: 400,
        reason: "order_decrement",
        source_id: "M-20260518-001",
        season_id: 2,
      },
    ];
    const stmts = stockAuditStmts(env as never, rows);
    expect(stmts).toHaveLength(1);

    const cap = env.captured[0]!;
    expect(cap.sql).toContain("INSERT INTO audit_log");
    expect(cap.sql).toContain("(ts, user_email, action, order_id, season_id, details)");

    // Binds: ts, user_email, action, order_id, season_id, details
    expect(cap.binds[1]).toBe("<system>"); // default user_email
    expect(cap.binds[2]).toBe("group_stock_change");
    expect(cap.binds[3]).toBe("M-20260518-001"); // order_id populated for order_decrement
    expect(cap.binds[4]).toBe(2); // season_id

    const details = JSON.parse(cap.binds[5] as string) as Record<string, unknown>;
    expect(details.reason).toBe("order_decrement");
    expect(details.group_id).toBe(7);
    expect(details.delta_fen).toBe(-100);
    expect(details.before_fen).toBe(500);
    expect(details.after_fen).toBe(400);
    expect(details.source_id).toBe("M-20260518-001");
  });

  it("non-order reasons (migration_init, group_intake) leave order_id NULL", () => {
    const env = fakeEnv();
    stockAuditStmts(env as never, [
      {
        group_id: 1,
        delta_fen: 500,
        before_fen: 0,
        after_fen: 500,
        reason: "group_intake",
        source_id: "intake-batch-42",
      },
    ]);
    // order_id (bind index 3) MUST be null for non-order reasons — that's how the FK
    // (audit_log.order_id → orders.id with ON DELETE CASCADE) avoids tying intake rows
    // to non-existent order ids and being cascade-deleted by the PDPA purge.
    expect(env.captured[0]!.binds[3]).toBe(null);
  });

  it("accepts a custom user_email and ts override", () => {
    const env = fakeEnv();
    stockAuditStmts(env as never, [
      {
        group_id: 1,
        delta_fen: 100,
        before_fen: 400,
        after_fen: 500,
        reason: "group_intake",
        user_email: "admin@example.com",
        ts: "2026-05-18T12:00:00.000Z",
      },
    ]);
    expect(env.captured[0]!.binds[0]).toBe("2026-05-18T12:00:00.000Z");
    expect(env.captured[0]!.binds[1]).toBe("admin@example.com");
  });

  it("returns empty array for empty input", () => {
    const env = fakeEnv();
    expect(stockAuditStmts(env as never, [])).toHaveLength(0);
    expect(env.captured).toHaveLength(0);
  });
});
