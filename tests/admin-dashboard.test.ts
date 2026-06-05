// Pure unit test (no stage env). Tests dashboard stock-summary derivation:
// fen -> jin display + low-stock flag.
import { describe, expect, it } from "bun:test";
import {
  LOW_STOCK_THRESHOLD_FEN,
  fenToJinLabel,
  groupStockSummary,
} from "../src/lib/admin-dashboard";

describe("admin-dashboard stock summary", () => {
  it("fenToJinLabel converts fen to 斤 with 2 decimals", () => {
    expect(fenToJinLabel(0)).toBe("0.00");
    expect(fenToJinLabel(100)).toBe("1.00");
    expect(fenToJinLabel(50)).toBe("0.50");
    expect(fenToJinLabel(1234)).toBe("12.34");
  });

  it("low-stock threshold is 5 斤 (500 fen)", () => {
    expect(LOW_STOCK_THRESHOLD_FEN).toBe(500);
  });

  it("flags low when stock_fen is at or below the threshold", () => {
    const rows = [
      { id: 1, name: "金煌芒果乾", stock_fen: 2000 }, // 20 斤 — ok
      { id: 2, name: "愛文芒果乾", stock_fen: 500 }, //  5 斤 — low (boundary, inclusive)
      { id: 3, name: "土芒果乾", stock_fen: 0 }, //      0 斤 — low + sold out
    ];
    const summary = groupStockSummary(rows);
    expect(summary).toEqual([
      { id: 1, name: "金煌芒果乾", stock_fen: 2000, jin: "20.00", low: false, soldOut: false },
      { id: 2, name: "愛文芒果乾", stock_fen: 500, jin: "5.00", low: true, soldOut: false },
      { id: 3, name: "土芒果乾", stock_fen: 0, jin: "0.00", low: true, soldOut: true },
    ]);
  });

  it("treats just-above-threshold as not low", () => {
    const [s] = groupStockSummary([{ id: 9, name: "x", stock_fen: 501 }]);
    expect(s!.low).toBe(false);
  });

  it("returns an empty array for no groups", () => {
    expect(groupStockSummary([])).toEqual([]);
  });
});
