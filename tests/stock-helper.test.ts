// Pure unit tests for src/lib/stock.ts low-level helpers.
// No D1 / network / env required — these run anywhere bun is installed.

import { describe, expect, it } from "bun:test";
import { stockDecrementStmts, stockRestoreStmts, type StockItem } from "../src/lib/stock";

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

describe("stockDecrementStmts", () => {
  it("returns one stmt per item with CAS WHERE clause", () => {
    const env = fakeEnv();
    const items: StockItem[] = [
      { sku: "A", qty: 2 },
      { sku: "B", qty: 1 },
    ];
    const stmts = stockDecrementStmts(env as never, items);
    expect(stmts).toHaveLength(2);
    expect(env.captured[0]!.sql).toContain("UPDATE products SET stock = stock - ?1");
    expect(env.captured[0]!.sql).toContain("AND stock >= ?1");
    expect(env.captured[0]!.binds).toEqual([2, "A"]);
    expect(env.captured[1]!.binds).toEqual([1, "B"]);
  });

  it("returns empty array for empty items", () => {
    const env = fakeEnv();
    const stmts = stockDecrementStmts(env as never, []);
    expect(stmts).toHaveLength(0);
    expect(env.captured).toHaveLength(0);
  });
});

describe("stockRestoreStmts", () => {
  it("returns unconditional UPDATE per item — no WHERE on stock", () => {
    const env = fakeEnv();
    const items: StockItem[] = [{ sku: "A", qty: 5 }];
    const stmts = stockRestoreStmts(env as never, items);
    expect(stmts).toHaveLength(1);
    expect(env.captured[0]!.sql).toContain("UPDATE products SET stock = stock + ?1");
    expect(env.captured[0]!.sql).not.toContain("AND stock");
    expect(env.captured[0]!.binds).toEqual([5, "A"]);
  });
});
