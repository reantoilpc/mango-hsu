import { describe, expect, it } from "bun:test";
import { formatTwd, shapeSalesSummary, type OrderTotalsRow } from "../src/lib/sales-summary";

describe("formatTwd", () => {
  it("formats TWD with thousands separators", () => {
    expect(formatTwd(0)).toBe("$0");
    expect(formatTwd(880)).toBe("$880");
    expect(formatTwd(38480)).toBe("$38,480");
    expect(formatTwd(71030)).toBe("$71,030");
    expect(formatTwd(1000000)).toBe("$1,000,000");
  });
});

describe("shapeSalesSummary", () => {
  const perFlavour = [
    { id: 5, name: "金煌芒果乾", qty: 122, fen: 8100, amount: 38480 },
    { id: 6, name: "愛文芒果乾", qty: 92, fen: 6150, amount: 31670 },
  ];
  const totals: OrderTotalsRow = {
    orders_n: 15, subtotal: 70150, shipping: 880, total: 71030,
    paid_total: 25310, unpaid_total: 45720,
  };

  it("shapes a normal two-flavour mix", () => {
    const s = shapeSalesSummary(perFlavour, totals);
    expect(s.flavours).toEqual([
      { name: "金煌芒果乾", jin: "81.00", qty: 122, amount: 38480 },
      { name: "愛文芒果乾", jin: "61.50", qty: 92, amount: 31670 },
    ]);
    expect(s.totals).toEqual({ jin: "142.50", qty: 214, subtotal: 70150, shipping: 880, total: 71030 });
    expect(s.collection).toEqual({ paid: 25310, unpaid: 45720, paidPct: 36 }); // 25310/71030 = 35.63% → 36
    expect(s.ordersN).toBe(15);
    expect(s.hasSales).toBe(true);
  });

  it("handles an empty season (no orders)", () => {
    const s = shapeSalesSummary([], {
      orders_n: 0, subtotal: 0, shipping: 0, total: 0, paid_total: 0, unpaid_total: 0,
    });
    expect(s.hasSales).toBe(false);
    expect(s.flavours).toEqual([]);
    expect(s.totals.jin).toBe("0.00");
    expect(s.totals.qty).toBe(0);
    expect(s.collection.paidPct).toBe(0); // guarded: no divide-by-zero
  });

  it("reports 100% when fully paid", () => {
    const s = shapeSalesSummary(perFlavour, { ...totals, paid_total: 71030, unpaid_total: 0 });
    expect(s.collection.paidPct).toBe(100);
  });

  it("reports 0% when fully unpaid", () => {
    const s = shapeSalesSummary(perFlavour, { ...totals, paid_total: 0, unpaid_total: 71030 });
    expect(s.collection.paidPct).toBe(0);
    expect(s.collection.unpaid).toBe(71030);
  });
});
